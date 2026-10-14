// Language detection following github-linguist's strategy pipeline
// (lib/linguist.rb): modeline, filename, shebang, extension, XML, manpage,
// heuristics, classifier. Each strategy narrows the candidate list; the first
// to return a single language wins, otherwise the first remaining candidate.
//
// GitHub never guesses from content alone (its classifier only ranks
// candidates found from the file name), so pasted text without a name stays
// plain text there. As a convenience for pasted snippets, guessFromContent()
// offers a fallback that the caller labels as a guess.

import { genericExtensions, heuristics, languages, popular } from './linguist-data.js'

const byName = new Map()
const byAlias = new Map()
const byExt = new Map()
const byFilename = new Map()
const byInterpreter = new Map()

const add = (map, key, lang) => {
  const list = map.get(key)
  if (list) {
    if (!list.includes(lang)) list.push(lang)
  } else map.set(key, [lang])
}

for (const lang of languages) {
  byName.set(lang.name, lang)
  byAlias.set(lang.name.toLowerCase().replace(/\s/g, '-'), lang)
  for (const a of lang.alias || []) byAlias.set(a.toLowerCase(), lang)
  for (const e of lang.ext || []) add(byExt, e.toLowerCase(), lang)
  for (const f of lang.files || []) add(byFilename, f, lang)
  for (const i of lang.interp || []) add(byInterpreter, i, lang)
}

const popularRank = new Map(popular.map((n, i) => [n, i]))

export function languageByName(name) {
  return byName.get(name) || null
}

// ------------------------------------------------------------- strategies

const EMACS_MODELINE =
  /-\*-(?:[ \t]*(?=[^:;\s]+[ \t]*-\*-)|(?:.*?[ \t;]|(?<=-\*-))[ \t]*mode[ \t]*:[ \t]*)([^:;\s]+)(?=[ \t;]|(?<![-*])-\*-).*?-\*-/i
const VIM_MODELINE =
  /(?:(?:^|[ \t])(?:vi|Vi(?=m))(?:m[<=>]?[0-9]+|m)?|[ \t]ex)(?=:(?=[ \t]*set?[ \t][^\r\n:]+:)|:(?![ \t]*set?[ \t]))(?:(?:[ \t]*:[ \t]*|[ \t])\w*(?:[ \t]*=(?:[^\\\s]|\\.)*)?)*[ \t:](?:filetype|ft|syntax)[ \t]*=(\w+)(?=$|\s|:)/m

function modeline(data, lines) {
  const header = lines.slice(0, 5).join('\n')
  if (header.includes('UseVimball')) return []
  const footer = lines.slice(-5).join('\n')
  const text = header + footer
  const m = text.match(EMACS_MODELINE) || text.match(VIM_MODELINE)
  if (!m) return []
  const name = m[1].toLowerCase()
  const lang = byAlias.get(name) || byAlias.get(name.split(',')[0])
  return lang ? [lang] : []
}

export function interpreterOf(data) {
  if (!data.startsWith('#!')) return null
  const nl = data.indexOf('\n')
  const shebang = nl < 0 ? data : data.slice(0, nl)
  const m = shebang.match(/^#!\s*(\S+)/)
  if (!m) return null
  let rest = shebang.slice(m[0].length)
  let script = m[1].split('/').pop()
  if (script === 'env') {
    rest = rest.replace(/^\s+/, '')
    for (;;) {
      const opt = rest.match(/^((-[i0uCSv]*|--\S+)\s+)+/) || rest.match(/^(\S+=\S+\s+)+/)
      if (!opt) break
      rest = rest.slice(opt[0].length)
    }
    const s = rest.match(/^\S+/)
    if (!s) return null
    script = s[0]
    rest = rest.slice(s[0].length)
  }
  script = script.replace(/(\.\d+)$/, '').replace(/^#!\s*/, '')
  if (script === 'sh') {
    const first5 = data.split('\n', 5)
    for (const l of first5) {
      const x = l.match(/exec (\w+)[\s"']+\$0[\s"']+\$@/)
      if (x) {
        script = x[1]
        break
      }
    }
  }
  if (script === 'osascript' && /-l\s?/.test(rest)) return null
  return script.split('/').pop()
}

const intersect = (candidates, langs) => (candidates.length ? candidates.filter((c) => langs.includes(c)) : langs)

function extensionsOf(basename) {
  const parts = basename.toLowerCase().split('.')
  parts.shift()
  return parts.map((_, i) => '.' + parts.slice(i).join('.'))
}

function byExtension(name) {
  for (const e of extensionsOf(name)) {
    const list = byExt.get(e)
    if (list && list.length) return list
  }
  return []
}

const MANPAGE_EXTS = /\.(?:[1-9](?![0-9])[a-z_0-9]*|0p|n|man|mdoc)(?:\.in)?$/i

const compiled = new Map()
function regex([src, flags]) {
  const key = flags + '/' + src
  if (compiled.has(key)) return compiled.get(key)
  let re = null
  try {
    re = new RegExp(src, flags)
  } catch {}
  compiled.set(key, re)
  return re
}

function ruleMatches(rule, data) {
  for (const p of rule.all) {
    const any = p.any.some((pat) => {
      const re = regex(pat)
      return re ? re.test(data) : false
    })
    if (p.neg ? any : !any) return false
  }
  return true
}

function heuristicsFor(name, data) {
  const lower = name.toLowerCase()
  for (const h of heuristics) {
    if (!h.exts.some((e) => lower.endsWith(e))) continue
    const sample = data.slice(0, 50 * 1024)
    for (const rule of h.rules) {
      if (!ruleMatches(rule, sample)) continue
      const names = Array.isArray(rule.lang) ? rule.lang : [rule.lang]
      return names.map((n) => byName.get(n)).filter(Boolean)
    }
    return []
  }
  return []
}

// Without linguist's Bayesian classifier, prefer popular languages, then
// programming languages, then alphabetical order.
function rank(candidates) {
  const score = (l) => (popularRank.has(l.name) ? popularRank.get(l.name) : 1000 + (l.type === 'programming' ? 0 : 500))
  return candidates.slice().sort((a, b) => score(a) - score(b) || a.name.localeCompare(b.name))
}

/**
 * @param {string} filename may be empty
 * @param {string} data file contents
 * @returns {{lang: object, strategy: string} | null}
 */
export function detectLanguage(filename, data) {
  if (!data) return null
  const name = (filename || '').split(/[\\/]/).pop()
  const lines = data.slice(0, 64 * 1024).split('\n')
  const lastLines = data.length > 64 * 1024 ? data.slice(-8 * 1024).split('\n') : lines
  let candidates = []
  const strategies = [
    ['modeline', () => modeline(data, lines.slice(0, 5).concat(lastLines.slice(-5)))],
    ['filename', () => (name ? intersect(candidates, byFilename.get(name) || []) : [])],
    [
      'shebang',
      () => {
        const interp = interpreterOf(data)
        return interp ? intersect(candidates, byInterpreter.get(interp) || []) : []
      },
    ],
    [
      'extension',
      () => {
        if (!name) return []
        const lower = name.toLowerCase()
        if (genericExtensions.some((e) => lower.endsWith(e))) return candidates
        return intersect(candidates, byExtension(name))
      },
    ],
    ['xml', () => (candidates.length ? candidates : /<\?xml version=/.test(lines.slice(0, 2).join('\n')) ? [byName.get('XML')] : [])],
    [
      'manpage',
      () => (candidates.length ? candidates : MANPAGE_EXTS.test(name) ? [byName.get('Roff Manpage'), byName.get('Roff')] : []),
    ],
    ['heuristics', () => (name ? heuristicsFor(name, data) : [])],
  ]
  for (const [strategy, run] of strategies) {
    const found = run().filter(Boolean)
    if (found.length === 1) return { lang: found[0], strategy }
    if (found.length > 1) candidates = found
  }
  if (candidates.length) return { lang: rank(candidates)[0], strategy: 'classifier' }
  return null
}

// ------------------------------------------------------------- guessing

const GUESSES = [
  ['JSON', (t) => /^\s*[[{]/.test(t) && /^\s*[[{][\s\S]*[\]}]\s*$/.test(t) && /"\s*:/.test(t), 3],
  ['HTML', (t) => /^\s*(<!doctype html|<html[\s>])/i.test(t), 5],
  ['XML', (t) => /^\s*<\?xml/.test(t), 5],
  ['SVG', (t) => /^\s*<svg[\s>]/.test(t), 4],
  ['Diff', (t) => /^(diff --git |--- \S|\+\+\+ \S)/m.test(t) && /^@@ -\d/m.test(t), 5],
  ['PHP', (t) => /<\?php/.test(t), 5],
  ['Go', (t) => /^package \w+\s*$/m.test(t) && /^func\s/m.test(t), 4],
  ['Rust', (t) => /\bfn\s+\w+\s*[(<]/.test(t) && /\blet\s+(mut\s+)?\w+|->|::|\bimpl\b|\bpub\s/.test(t), 3],
  ['Python', (t) => /^\s*(def\s+\w+\s*\(.*\)\s*(->.*)?:|class\s+\w+(\(.*\))?:|from\s+[\w.]+\s+import\s|import\s+\w+\s*$|if\s+__name__\s*==)/m.test(t), 3],
  ['Java', (t) => /^\s*(public|private|protected)?\s*(final\s+)?(class|interface|enum)\s+\w+/m.test(t) && /\b(public|private|protected)\s+[\w<>[\]]+\s+\w+\s*\(/.test(t) && /;\s*$/m.test(t), 3],
  ['C#', (t) => /^\s*using\s+System/m.test(t) || (/\bnamespace\s+[\w.]+/.test(t) && /\bpublic\s+(class|static|void)\b/.test(t)), 3],
  ['C++', (t) => /^\s*#include\s*[<"]/m.test(t) && /\bstd::|\btemplate\s*<|\bclass\s+\w+|\bnamespace\s+\w+|\bcout\b/.test(t), 4],
  ['C', (t) => /^\s*#include\s*[<"]/m.test(t), 3],
  ['TypeScript', (t) => /\b(interface\s+\w+\s*\{|type\s+\w+\s*=|:\s*(string|number|boolean|void|unknown)\b|\bas\s+const\b|implements\s+\w+|readonly\s+\w+)/.test(t) && /\b(const|let|function|class|export|import)\b/.test(t), 3],
  ['JavaScript', (t) => /\b(function\s*\w*\s*\(|const\s+\w+\s*=|let\s+\w+\s*=|var\s+\w+\s*=|=>|require\(|module\.exports|import\s.+\sfrom\s|export\s+(default|const|function|class))/.test(t), 2],
  ['Ruby', (t) => /^\s*(def\s+\w+|module\s+\w+|require\s+['"]|class\s+\w+\s*(<\s*\w+)?\s*$)/m.test(t) && /^\s*end\s*$/m.test(t), 3],
  ['Shell', (t) => /^\s*(if\s+\[|fi\s*$|then\s*$|echo\s|export\s+\w+=|for\s+\w+\s+in\s|\w+\(\)\s*\{)/m.test(t), 2],
  ['SQL', (t) => /\b(SELECT\s.+\sFROM|INSERT\s+INTO|CREATE\s+(TABLE|INDEX|VIEW)|UPDATE\s+\w+\s+SET|DELETE\s+FROM|ALTER\s+TABLE)\b/i.test(t), 3],
  ['Dockerfile', (t) => /^FROM\s+\S+/m.test(t) && /^(RUN|COPY|CMD|ENTRYPOINT|WORKDIR|ENV)\s/m.test(t), 4],
  ['Makefile', (t) => /^[\w.-]+\s*:[^=]*\n\t\S/m.test(t), 3],
  ['TOML', (t) => /^\[[\w.-]+\]\s*$/m.test(t) && /^[\w.-]+\s*=\s*\S/m.test(t), 2],
  ['CSS', (t) => /^[^{}\n]+\{\s*$/m.test(t) && /^\s*[\w-]+\s*:\s*[^;{}]+;\s*$/m.test(t) && !/\bfunction\b|=>/.test(t), 2],
  ['YAML', (t) => (t.match(/^[ \t]*[\w"'-]+:(\s|$)/gm) || []).length >= 2 && !/[;{}]\s*$/m.test(t), 1],
  ['Markdown', (t) => /^#{1,6}\s+\S/m.test(t) || /^\s*[-*+]\s+\S/m.test(t) || /\[[^\]]+\]\([^)]+\)/.test(t), 1],
]

/** Best-effort guess for unnamed text; returns a linguist language or null. */
export function guessFromContent(data) {
  const t = data.slice(0, 32 * 1024)
  if (!t.trim()) return null
  let best = null
  let bestScore = 0
  for (const [name, test, score] of GUESSES) {
    if (score > bestScore && test(t)) {
      best = name
      bestScore = score
    }
  }
  return best ? byName.get(best) || null : null
}

// ------------------------------------------------------------- shiki ids

const SHIKI_OVERRIDES = {
  'Jupyter Notebook': 'json',
  'Ignore List': 'shellscript',
  'Git Config': 'ini',
  'Git Attributes': 'shellscript',
  'EditorConfig': 'ini',
  'Option List': 'shellscript',
  'JSON5': 'json5',
  'JSONLD': 'json',
  'GeoJSON': 'json',
  'TOML': 'toml',
  'Text': null,
}

/** Map a linguist language to a Shiki bundled language id (or null). */
export function shikiIdFor(lang, shikiInfo) {
  if (!lang) return null
  if (lang.name in SHIKI_OVERRIDES) return SHIKI_OVERRIDES[lang.name]
  const ids = new Map()
  for (const info of shikiInfo) {
    ids.set(info.id, info.id)
    for (const a of info.aliases || []) ids.set(a.toLowerCase(), info.id)
    ids.set(info.name.toLowerCase(), info.id)
  }
  const tries = [lang.name.toLowerCase(), lang.name.toLowerCase().replace(/\s+/g, '-'), lang.name.toLowerCase().replace(/\s+/g, ''), ...(lang.alias || [])]
  if (lang.group) tries.push(lang.group.toLowerCase())
  for (const t of tries) if (ids.has(t)) return ids.get(t)
  return null
}
