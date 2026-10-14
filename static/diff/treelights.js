// github.com highlights some languages with tree-sitter ("TreeLights") rather
// than TextMate grammars. This reproduces it: whole files are parsed with the
// grammars' own queries, tree-sitter-highlight's event loop picks captures
// (the last pattern for a node wins, local variables inherit the highlight of
// their definition) and capture names map to GitHub's prettylights classes.
// Spans nest like the captured nodes, e.g. a template substitution is
// pl-s > pl-s1, which matters for rules such as `.pl-s .pl-s1`.
// Measured against github.com commit pages: 99.7% of characters match.

const CDN = 'https://cdn.jsdelivr.net/npm/'
const WTS = 'web-tree-sitter@0.26.13'

// GitHub leaves larger files unhighlighted; we fall back to TextMate there.
export const MAX_BYTES = 512 * 1024

const JS = 'tree-sitter-javascript@0.25.0'
const TS = 'tree-sitter-typescript@0.23.2'

// Query files in GitHub's order: later files override earlier ones.
export const TREELIGHTS = {
  JavaScript: { wasm: `${JS}/tree-sitter-javascript.wasm`, hl: [`${JS}/queries/highlights-jsx.scm`, `${JS}/queries/highlights.scm`], locals: [`${JS}/queries/locals.scm`], jsdoc: true },
  TypeScript: { wasm: `${TS}/tree-sitter-typescript.wasm`, hl: [`${TS}/queries/highlights.scm`, `${JS}/queries/highlights.scm`], locals: [`${TS}/queries/locals.scm`, `${JS}/queries/locals.scm`], jsdoc: true },
  TSX: {
    wasm: `${TS}/tree-sitter-tsx.wasm`,
    hl: [`${TS}/queries/highlights.scm`, `${JS}/queries/highlights-jsx.scm`, `${JS}/queries/highlights.scm`],
    locals: [`${TS}/queries/locals.scm`, `${JS}/queries/locals.scm`],
    jsdoc: true,
  },
  Python: { wasm: 'tree-sitter-python@0.25.0/tree-sitter-python.wasm', hl: ['tree-sitter-python@0.25.0/queries/highlights.scm'], locals: [] },
  Go: { wasm: 'tree-sitter-go@0.25.0/tree-sitter-go.wasm', hl: ['tree-sitter-go@0.25.0/queries/highlights.scm'], locals: [] },
  Rust: { wasm: 'tree-sitter-rust@0.24.0/tree-sitter-rust.wasm', hl: ['tree-sitter-rust@0.24.0/queries/highlights.scm'], locals: [] },
  Ruby: { wasm: 'tree-sitter-ruby@0.23.1/tree-sitter-ruby.wasm', hl: ['tree-sitter-ruby@0.23.1/queries/highlights.scm'], locals: ['tree-sitter-ruby@0.23.1/queries/locals.scm'] },
  C: { wasm: 'tree-sitter-c@0.24.1/tree-sitter-c.wasm', hl: ['tree-sitter-c@0.24.1/queries/highlights.scm'], locals: [] },
  CSS: { wasm: 'tree-sitter-css@0.25.0/tree-sitter-css.wasm', hl: ['inline:css'], locals: [] },
}

// github.com still uses an older tree-sitter-css punctuation set.
const CSS_QUERY = `(comment) @comment
(tag_name) @tag
(nesting_selector) @tag
(universal_selector) @tag
"~" @operator
">" @operator
"+" @operator
"-" @operator
"*" @operator
"/" @operator
"=" @operator
"^=" @operator
"|=" @operator
"~=" @operator
"$=" @operator
"*=" @operator
"and" @operator
"or" @operator
"not" @operator
"only" @operator
(attribute_selector (plain_value) @string)
((property_name) @variable (#match? @variable "^--"))
((plain_value) @variable (#match? @variable "^--"))
(class_name) @property
(id_name) @property
(namespace_name) @property
(property_name) @property
(feature_name) @property
(pseudo_element_selector (tag_name) @attribute)
(pseudo_class_selector (class_name) @attribute)
(attribute_name) @attribute
(function_name) @function
"@media" @keyword
"@import" @keyword
"@charset" @keyword
"@namespace" @keyword
"@supports" @keyword
"@keyframes" @keyword
(at_keyword) @keyword
(to) @keyword
(from) @keyword
(important) @keyword
(string_value) @string
(color_value) @string.special
(integer_value) @number
(float_value) @number
(unit) @type
"#" @punctuation.delimiter
"," @punctuation.delimiter
":" @punctuation.delimiter
`

// Highlight names GitHub recognizes and their classes.
const RECOGNIZED = {
  attribute: 'pl-c1',
  comment: 'pl-c',
  constant: 'pl-c1',
  'constant.builtin': 'pl-c1',
  constructor: 'pl-v',
  embedded: 'pl-s1',
  escape: 'pl-cce',
  function: 'pl-en',
  'function.builtin': 'pl-en',
  keyword: 'pl-k',
  label: 'pl-ent',
  number: 'pl-c1',
  operator: 'pl-c1',
  property: 'pl-c1',
  punctuation: 'pl-kos',
  string: 'pl-s',
  'string.special': 'pl-pds',
  'string.special.regex': 'pl-sr',
  tag: 'pl-ent',
  type: 'pl-smi',
  'type.builtin': 'pl-smi',
  variable: 'pl-s1',
  'variable.builtin': 'pl-smi',
  'variable.parameter': 'pl-s1',
}

// tree-sitter-highlight's configure(): a capture matches a recognized name
// when all of its dot-parts occur in the capture name; the most specific wins.
const resolved = new Map()
function classFor(capture) {
  if (resolved.has(capture)) return resolved.get(capture)
  const parts = capture.split('.')
  let best = null
  let bestLen = 0
  for (const name of Object.keys(RECOGNIZED)) {
    const rp = name.split('.')
    if (rp.length > bestLen && rp.every((p) => parts.includes(p))) {
      best = name
      bestLen = rp.length
    }
  }
  const cls = best === null ? null : RECOGNIZED[best]
  resolved.set(capture, cls)
  return cls
}

// ------------------------------------------------------------- loading

let modulePromise = null
const languages = new Map()

// Network access, replaceable for tests: "package@version/file" paths.
let io = {
  loadModule: async () => {
    const mod = await import(`${CDN}${WTS}/web-tree-sitter.js`)
    await mod.Parser.init({ locateFile: (f) => `${CDN}${WTS}/${f}` })
    return mod
  },
  fetchBytes: async (path) => new Uint8Array(await (await fetch(CDN + path)).arrayBuffer()),
  fetchText: async (path) => {
    const r = await fetch(CDN + path)
    if (!r.ok) throw new Error(`${path}: ${r.status}`)
    return r.text()
  },
}
export function setTreeLightsIO(custom) {
  io = { ...io, ...custom }
}

async function loadModule() {
  modulePromise ||= io.loadModule()
  return modulePromise
}

const fetchText = (path) => (path === 'inline:css' ? CSS_QUERY : io.fetchText(path))

async function loadLanguage(name) {
  let entry = languages.get(name)
  if (!entry) {
    entry = (async () => {
      const cfg = TREELIGHTS[name]
      const { Parser, Language, Query } = await loadModule()
      const language = await Language.load(await io.fetchBytes(cfg.wasm))
      const [locals, hl] = await Promise.all([Promise.all(cfg.locals.map(fetchText)), Promise.all(cfg.hl.map(fetchText))])
      const localsSrc = locals.join('\n')
      const localsCount = localsSrc.trim() ? new Query(language, localsSrc).patternCount() : 0
      const query = new Query(language, `${localsSrc}\n${hl.join('\n')}`)
      const parser = new Parser()
      parser.setLanguage(language)
      return { name, cfg, parser, query, localsCount }
    })()
    languages.set(name, entry)
  }
  return entry
}

// ------------------------------------------------------------- highlighting

// Port of tree-sitter-highlight's event loop (locals + last pattern wins).
function highlightEvents(L, text, tree) {
  const q = L.query
  const caps = q.captures(tree.rootNode)
  const events = []
  const endStack = []
  const scopes = [{ e: Infinity, inherits: false, defs: [] }]
  const nonLocal = (pi) => !!(q.refutedProperties[pi] && 'local' in q.refutedProperties[pi])
  const sameNode = (a, b) => a.node.id === b.node.id && a.node.startIndex === b.node.startIndex && a.node.endIndex === b.node.endIndex
  let i = 0
  while (i < caps.length) {
    let cap = caps[i]
    const rs = cap.node.startIndex
    const re = cap.node.endIndex
    if (endStack.length && endStack[endStack.length - 1] <= rs) {
      events.push({ pos: endStack.pop(), type: 'end' })
      continue
    }
    i++
    while (rs > scopes[scopes.length - 1].e) scopes.pop()
    let refHl
    let defEntry = null
    let localDone = false
    while (cap.patternIndex < L.localsCount) {
      const name = cap.name
      if (name === 'local.scope') {
        defEntry = null
        const sp = q.setProperties[cap.patternIndex] || {}
        const inherits = 'local.scope-inherits' in sp ? sp['local.scope-inherits'] === 'true' || sp['local.scope-inherits'] == null : true
        scopes.push({ e: re, inherits, defs: [] })
      } else if (name === 'local.definition') {
        refHl = undefined
        defEntry = { name: text.slice(rs, re), valueEnd: 0, hl: undefined }
        scopes[scopes.length - 1].defs.push(defEntry)
      } else if (name === 'local.reference' && !defEntry) {
        const ident = text.slice(rs, re)
        for (let k = scopes.length - 1; k >= 0; k--) {
          const sc = scopes[k]
          let found
          for (let j = sc.defs.length - 1; j >= 0; j--) {
            if (sc.defs[j].name === ident && rs >= sc.defs[j].valueEnd) {
              found = sc.defs[j]
              break
            }
          }
          if (found) {
            refHl = found.hl
            break
          }
          if (!sc.inherits) break
        }
      }
      const nx = caps[i]
      if (nx && sameNode(nx, cap)) {
        cap = nx
        i++
        continue
      }
      localDone = true
      break
    }
    if (localDone) continue
    while (i < caps.length && sameNode(caps[i], cap)) {
      const nx = caps[i++]
      if ((defEntry || refHl !== undefined) && nonLocal(nx.patternIndex)) continue
      cap = nx
    }
    const own = classFor(cap.name) !== null ? cap.name : null
    if (defEntry) defEntry.hl = own ?? undefined
    const hl = refHl !== undefined ? refHl : own
    if (hl != null) {
      endStack.push(re)
      events.push({ pos: rs, type: 'start', cls: classFor(hl), comment: hl === 'comment', node: cap.node })
    }
  }
  while (endStack.length) events.push({ pos: endStack.pop(), type: 'end' })
  return events
}

// GitHub injects jsdoc into JS/TS comments: @tags are pl-k, {types} pl-smi.
function jsdocRanges(comment) {
  const out = []
  const lines = comment.split('\n')
  let off = 0
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]
    const lead = li === 0 ? line.match(/^(\/\*\*|\/\*|\/\/+)\s*/) : line.match(/^\s*\**\s*/)
    let p = lead ? lead[0].length : 0
    while (p < line.length) {
      if (line[p] === '{' && line[p + 1] === '@') p++
      const m = /^@[a-zA-Z_]+/.exec(line.slice(p))
      if (!m) break
      out.push({ s: off + p, e: off + p + m[0].length, cls: 'pl-k' })
      p += m[0].length
      while (line[p] === ' ' || line[p] === '\t') p++
      if (line[p] === '{') {
        const close = line.indexOf('}', p + 1)
        if (close > p + 1) {
          out.push({ s: off + p + 1, e: off + close, cls: 'pl-smi' })
          p = close + 1
          while (line[p] === ' ' || line[p] === '\t') p++
        }
      }
    }
    off += line.length + 1
  }
  return out
}

function withJsdoc(text, events) {
  const extra = []
  for (const ev of events) {
    if (ev.type !== 'start' || !ev.comment) continue
    const s = ev.node.startIndex
    for (const r of jsdocRanges(text.slice(s, ev.node.endIndex))) {
      extra.push({ pos: s + r.s, type: 'start', cls: r.cls }, { pos: s + r.e, type: 'end' })
    }
  }
  if (!extra.length) return events
  const out = []
  let i = 0
  let j = 0
  while (i < events.length || j < extra.length) {
    if (j >= extra.length) out.push(events[i++])
    else if (i >= events.length) out.push(extra[j++])
    else if (extra[j].pos < events[i].pos) out.push(extra[j++])
    else if (extra[j].pos > events[i].pos) out.push(events[i++])
    else if (events[i].type === 'start' && events[i].comment) out.push(events[i++])
    else out.push(extra[j++])
  }
  return out
}

/**
 * Highlight a whole document.
 * @param {string} name TREELIGHTS key (a linguist language name)
 * @param {(stack: string) => number} stackId interns a class stack such as
 *   "pl-s>pl-s1" (outermost first) and returns its id
 * @returns {Promise<Int32Array[]>} per line: [length, stackId, ...]
 */
export async function highlightDocument(name, text, starts, stackId) {
  const L = await loadLanguage(name)
  const tree = L.parser.parse(text)
  let events = highlightEvents(L, text, tree)
  tree.delete()
  if (L.cfg.jsdoc) events = withJsdoc(text, events)

  const n = starts.length - 1
  const lines = new Array(n)
  const open = []
  let ev = 0
  let pos = 0
  for (let line = 0; line < n; line++) {
    let end = starts[line + 1]
    if (end > starts[line] && text.charCodeAt(end - 1) === 10) end--
    if (end > starts[line] && text.charCodeAt(end - 1) === 13) end--
    const out = []
    pos = starts[line]
    const emit = (to) => {
      to = Math.min(to, end)
      if (to <= pos) return
      const id = open.length ? stackId(open.filter(Boolean).join('>')) : 0
      if (out.length && out[out.length - 1] === id) out[out.length - 2] += to - pos
      else out.push(to - pos, id)
      pos = to
    }
    while (ev < events.length && events[ev].pos <= end) {
      const e = events[ev++]
      emit(e.pos)
      if (e.type === 'start') open.push(e.cls)
      else open.pop()
    }
    emit(end)
    // events inside the line terminator still change the open stack
    while (ev < events.length && events[ev].pos < starts[line + 1]) {
      const e = events[ev++]
      if (e.type === 'start') open.push(e.cls)
      else open.pop()
    }
    lines[line] = Int32Array.from(out)
  }
  return lines
}
