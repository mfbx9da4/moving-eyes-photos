// Generate static/diff/linguist-data.js from github-linguist's YAML files.
//
//   git clone --depth 1 https://github.com/github-linguist/linguist /tmp/linguist
//   npm install --no-save yaml
//   node scripts/gen-linguist-data.mjs /tmp/linguist/lib/linguist static/diff/linguist-data.js
import { readFileSync, writeFileSync } from 'node:fs'
import YAML from 'yaml'

const [srcDir, outFile] = process.argv.slice(2)
const languages = YAML.parse(readFileSync(`${srcDir}/languages.yml`, 'utf8'))
const heur = YAML.parse(readFileSync(`${srcDir}/heuristics.yml`, 'utf8'))
const generic = YAML.parse(readFileSync(`${srcDir}/generic.yml`, 'utf8')).extensions
const popular = YAML.parse(readFileSync(`${srcDir}/popular.yml`, 'utf8'))

// Ruby regex -> [source, flags] usable by JS. Ruby ^/$ are always line
// anchors, so every pattern gets the "m" flag; Ruby's (?m) is dotAll.
function convert(src) {
  let flags = 'm'
  let s = src
  const lead = s.match(/^\(\?([imx]+)\)/)
  if (lead) {
    s = s.slice(lead[0].length)
    if (lead[1].includes('i')) flags += 'i'
    if (lead[1].includes('m')) flags += 's'
    if (lead[1].includes('x')) s = s.replace(/\\#/g, '\u0000').replace(/#.*$/gm, '').replace(/\s+/g, '').replace(/\u0000/g, '\\#')
  }
  s = s
    .replace(/\\A/g, '(?<![\\s\\S])')
    .replace(/\\z/g, '(?![\\s\\S])')
    .replace(/\\Z/g, '(?=\\n?(?![\\s\\S]))')
    .replace(/\\h/g, '[0-9a-fA-F]')
    .replace(/\\H/g, '[^0-9a-fA-F]')
    .replace(/\(\?>/g, '(?:')
    .replace(/([*+?}])\+/g, '$1')
    .replace(/\[:alpha:\]/g, 'a-zA-Z')
    .replace(/\[:digit:\]/g, '0-9')
    .replace(/\[:alnum:\]/g, 'a-zA-Z0-9')
    .replace(/\[:space:\]/g, '\\s')
    .replace(/\[:upper:\]/g, 'A-Z')
    .replace(/\[:lower:\]/g, 'a-z')
    .replace(/\[:word:\]/g, '\\w')
    .replace(/\[:punct:\]/g, '!-\\/:-@\\[-`{-~')
    .replace(/\(\?-m\)/g, '')
  // a mid-pattern (?i) applies to the rest of the (top-level) pattern
  const mid = s.indexOf('(?i)')
  if (mid > 0) s = s.slice(0, mid) + '(?i:' + s.slice(mid + 4) + ')'
  // inline (?im:...) -> JS modifiers only support i, m, s
  s = s.replace(/\(\?([imx]+)(-[imx]+)?:/g, (_, on, off) => {
    let o = ''
    if (on.includes('i')) o += 'i'
    if (on.includes('m')) o += 's'
    let f = ''
    if (off && off.includes('i')) f += 'i'
    if (off && off.includes('m')) f += 's'
    if (!o && !f) return '(?:'
    return `(?${o}${f ? '-' + f : ''}:`
  })
  let ok = true
  try {
    new RegExp(s, flags)
  } catch {
    try {
      new RegExp(s, flags + 'u')
      flags += 'u'
    } catch (e) {
      ok = false
      console.warn('cannot convert', JSON.stringify(src), e.message)
    }
  }
  return ok ? [s, flags] : null
}

const named = {}
for (const [k, v] of Object.entries(heur.named_patterns || {})) named[k] = v

function pats(rule) {
  const out = []
  const add = (p, neg) => {
    const list = (Array.isArray(p) ? p : [p]).map(convert).filter(Boolean)
    out.push({ any: list, neg: !!neg })
  }
  if (rule.pattern) add(rule.pattern)
  if (rule.named_pattern) add(named[rule.named_pattern])
  if (rule.negative_pattern) add(rule.negative_pattern, true)
  if (rule.and) for (const r of rule.and) out.push(...pats(r))
  return out
}

const heuristics = heur.disambiguations.map((d) => ({
  exts: d.extensions,
  rules: d.rules.map((r) => ({ lang: r.language, all: pats(r) })),
}))

const langs = []
for (const [name, l] of Object.entries(languages)) {
  const e = { name, type: l.type }
  if (l.extensions) e.ext = l.extensions
  if (l.filenames) e.files = l.filenames
  if (l.interpreters) e.interp = l.interpreters
  if (l.aliases) e.alias = l.aliases
  if (l.tm_scope && l.tm_scope !== 'none') e.scope = l.tm_scope
  if (l.group) e.group = l.group
  langs.push(e)
}

const out = `// Generated from github-linguist (languages.yml, heuristics.yml, generic.yml,
// popular.yml) by a one-off script. Regexes are converted from Ruby syntax.
// https://github.com/github-linguist/linguist
export const languages = ${JSON.stringify(langs)}
export const heuristics = ${JSON.stringify(heuristics)}
export const genericExtensions = ${JSON.stringify(generic)}
export const popular = ${JSON.stringify(popular)}
`
writeFileSync(outFile, out)
console.log('languages', langs.length, 'heuristics', heuristics.length, 'bytes', out.length)
