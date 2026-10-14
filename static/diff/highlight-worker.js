// Syntax highlighting worker: detects each side's language the way
// github-linguist does, then highlights like github.com:
//   * languages GitHub highlights with tree-sitter (JavaScript, TypeScript,
//     TSX, Python, Go, Rust, Ruby, C, CSS) are parsed whole with the same
//     queries (see treelights.js);
//   * everything else (and files over GitHub's size cutoff) is tokenized with
//     Shiki's TextMate grammars, using a theme that maps scopes to GitHub's
//     prettylights classes.
//
// TextMate files can be huge, so they are tokenized lazily in chunks when the
// view asks for them, resuming from grammar-state checkpoints; a jump far
// ahead starts from a fresh state a few chunks earlier and is corrected once
// the exact state catches up.
//
// Request:  { type: 'load', id, gen, language, old: {text, name}, new: {text, name} }
//           { type: 'tokens', id, side, from, to }
// Replies:  { type: 'languages', list }
//           { type: 'lang', id, gen, old: {name, shiki, strategy, engine}, new: {...} }
//           { type: 'tokens', id, gen, side, from, data, offsets, stacks }
//             data holds [length, stack id] pairs; line k is
//             data[offsets[k]..offsets[k+1]); `stacks` lists newly assigned
//             [id, "pl-s>pl-s1"] class stacks (outermost first, ">" nests).

import { lineStarts } from './algorithms/lines.js'
import { detectLanguage, guessFromContent, shikiIdFor } from './language.js'
import { PL_CLASSES, PRETTYLIGHTS_THEME, tokenClass } from './prettylights.js'
import { MAX_BYTES, TREELIGHTS, highlightDocument } from './treelights.js'

const SHIKI = 'https://esm.sh/shiki@4.5.0'
const CHUNK = 64
const CATCHUP_CHUNKS = 40
const WARMUP_CHUNKS = 3
const MAX_LINE = 5000

let shikiPromise = null
function loadShiki() {
  shikiPromise ||= (async () => {
    const [{ createHighlighterCore }, { createOnigurumaEngine }, langs] = await Promise.all([
      import(`${SHIKI}/core`),
      import(`${SHIKI}/engine/oniguruma`),
      import(`${SHIKI}/langs`),
    ])
    const highlighter = await createHighlighterCore({
      themes: [PRETTYLIGHTS_THEME],
      langs: [],
      engine: createOnigurumaEngine(import(`${SHIKI}/wasm`)),
    })
    return { highlighter, langs }
  })()
  return shikiPromise
}

loadShiki()
  .then(({ langs }) => {
    const list = langs.bundledLanguagesInfo.map((l) => ({ id: l.id, name: l.name })).sort((a, b) => a.name.localeCompare(b.name))
    self.postMessage({ type: 'languages', list })
  })
  .catch((e) => console.warn('shiki failed to load', e))

// Class stacks are interned for the worker's lifetime; new ones travel with
// the token messages that first use them. Id 0 means unstyled.
const stackIds = new Map()
let newStacks = []
function stackId(stack) {
  if (!stack) return 0
  let id = stackIds.get(stack)
  if (id === undefined) {
    id = stackIds.size + 1
    stackIds.set(stack, id)
    newStacks.push([id, stack])
  }
  return id
}

const STYLES = ['', 'fs-i', 'fs-b', 'fs-i fs-b', 'fs-u', 'fs-i fs-u', 'fs-b fs-u', 'fs-i fs-b fs-u']
function shikiStack(cls) {
  const name = PL_CLASSES[cls & 0xff]
  const names = [name, STYLES[(cls >> 8) & 7]].filter(Boolean).join(' ')
  // github.com only styles regexp escapes inside a regexp span
  return stackId(name === 'pl-cce' ? `pl-sr>${names}` : names)
}

function utf8Length(s) {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c <= 0xdbff ? (i++, 4) : 3
  }
  return n
}

let current = null // { id, docs: {old, new}, ready: Promise }
const queue = []
let draining = false
let idleTimer = 0

self.onmessage = (e) => {
  const msg = e.data
  if (msg.type === 'load') load(msg)
  else if (msg.type === 'tokens') {
    if (!current || msg.id !== current.id) return
    queue.push(msg)
    drain()
  }
}

async function load(msg) {
  const { id, gen, language } = msg
  queue.length = 0
  clearTimeout(idleTimer)
  const sharedName = msg.old.name || msg.new.name
  const docs = {}
  const me = (current = { id, gen, docs })
  const { highlighter, langs } = await loadShiki()
  if (current !== me) return
  const info = langs.bundledLanguagesInfo
  const result = {}
  for (const side of ['old', 'new']) {
    const { text } = msg[side]
    const name = msg[side].name || sharedName
    let lang = null
    if (language === 'none') lang = { name: '', shiki: null, strategy: 'manual' }
    else if (language && language !== 'auto') {
      const l = info.find((x) => x.id === language)
      lang = { name: l ? l.name : language, shiki: language, strategy: 'manual' }
    } else {
      const det = detectLanguage(name, text)
      if (det) lang = { name: det.lang.name, shiki: shikiIdFor(det.lang, info), strategy: det.strategy }
      else if (!name) {
        const g = guessFromContent(text)
        if (g) lang = { name: g.name, shiki: shikiIdFor(g, info), strategy: 'guessed from content' }
      }
    }
    lang ||= { name: '', shiki: null, strategy: 'none' }
    if (lang.shiki && !langs.bundledLanguages[lang.shiki]) lang.shiki = null
    const starts = lineStarts(text)
    const doc = { text, starts, lang: lang.shiki, chunks: [], states: [undefined], frontier: 0, approx: new Set() }
    // auto-detected tree-sitter languages are highlighted the way github.com does
    const tl = lang.strategy !== 'manual' && TREELIGHTS[lang.name] && utf8Length(text) <= MAX_BYTES
    lang.engine = tl ? 'tree-sitter' : lang.shiki ? 'TextMate' : ''
    if (tl) {
      doc.engine = 'treelights'
      doc.tl = highlightDocument(lang.name, text, starts, stackId).catch((e) => {
        console.warn('tree-sitter highlighting failed, using TextMate', e)
        doc.engine = null
        return null
      })
    }
    docs[side] = doc
    result[side] = lang
  }
  self.postMessage({ type: 'lang', id, gen, old: result.old, new: result.new })
  const needed = [...new Set([docs.old.lang, docs.new.lang].filter(Boolean))]
  me.highlighter = highlighter
  me.ready = Promise.all([
    ...needed.map((l) => highlighter.loadLanguage(langs.bundledLanguages[l])),
    ...['old', 'new'].map(async (side) => {
      const doc = docs[side]
      if (doc.tl) doc.tlLines = await doc.tl
    }),
  ]).catch((e) => console.warn('failed to load grammar', e))
  await me.ready
  if (current === me) drain()
}

async function drain() {
  if (draining) return
  draining = true
  try {
    while (queue.length) {
      const cur = current
      if (!cur || !cur.ready) break
      await cur.ready
      // newest request first: it is what is on screen now
      const req = queue.pop()
      if (!req || !current || req.id !== current.id) continue
      try {
        serve(req)
      } catch (e) {
        console.warn('tokenizing failed', e)
      }
      await new Promise((r) => setTimeout(r, 0))
    }
  } finally {
    draining = false
  }
  scheduleIdle()
}

function serve({ id, side, from, to }) {
  const doc = current.docs[side]
  if (!doc) return
  const n = doc.starts.length - 1
  to = Math.min(to, n)
  if (from >= to) return
  if (doc.engine === 'treelights' && doc.tlLines) return post(id, side, doc, from, to)
  if (!doc.lang) return
  for (let c = Math.floor(from / CHUNK); c <= Math.floor((to - 1) / CHUNK); c++) ensureChunk(doc, c)
  post(id, side, doc, from, to)
}

function lineTokens(doc, l) {
  if (doc.engine === 'treelights' && doc.tlLines) return doc.tlLines[l]
  const chunk = doc.chunks[Math.floor(l / CHUNK)]
  return chunk ? chunk[l % CHUNK] : null
}

function post(id, side, doc, from, to) {
  const lines = []
  let size = 0
  for (let l = from; l < to; l++) {
    const t = lineTokens(doc, l)
    lines.push(t)
    size += t ? t.length : 0
  }
  const data = new Int32Array(size)
  const offsets = new Int32Array(lines.length + 1)
  let o = 0
  lines.forEach((t, k) => {
    offsets[k] = o
    if (t) {
      data.set(t, o)
      o += t.length
    }
  })
  offsets[lines.length] = o
  const stacks = newStacks
  newStacks = []
  self.postMessage({ type: 'tokens', id, gen: current.gen, side, from, data, offsets, stacks }, [data.buffer, offsets.buffer])
}

function chunkCode(doc, c) {
  const n = doc.starts.length - 1
  const from = c * CHUNK
  const to = Math.min(n, from + CHUNK)
  let code = doc.text.slice(doc.starts[from], doc.starts[to])
  if (code.endsWith('\n')) code = code.slice(0, -1)
  return { code, count: to - from }
}

const OPTS = { tokenizeMaxLineLength: MAX_LINE, tokenizeTimeLimit: 200 }

function encodeLine(tokens) {
  const out = []
  for (const t of tokens) {
    const cls = shikiStack(tokenClass(t.color, t.fontStyle))
    const len = t.content.length
    if (out.length && out[out.length - 1] === cls) out[out.length - 2] += len
    else out.push(len, cls)
  }
  return Int32Array.from(out)
}

// Tokenize chunk c from `state`; returns { lines, end }.
function tokenizeChunk(doc, c, state) {
  const hl = current.highlighter
  const { code, count } = chunkCode(doc, c)
  const opts = { lang: doc.lang, theme: PRETTYLIGHTS_THEME.name, grammarState: state, ...OPTS }
  let res = hl.codeToTokensBase(code, opts)
  let end = hl.getLastGrammarState(res)
  if (res.length !== count) {
    // stray carriage returns split lines differently: go line by line
    res = []
    let st = state
    const from = c * CHUNK
    for (let l = from; l < from + count; l++) {
      let s = doc.text.slice(doc.starts[l], doc.starts[l + 1])
      s = s.replace(/\r?\n$/, '')
      const r = hl.codeToTokensBase(s.replace(/\r/g, ' '), { ...opts, grammarState: st })
      res.push(r.flat())
      st = hl.getLastGrammarState(r)
    }
    end = st
  }
  return { lines: res.map(encodeLine), end }
}

function advanceFrontier(doc, keepTokens) {
  const c = doc.frontier
  const { lines, end } = tokenizeChunk(doc, c, doc.states[c])
  doc.states[c + 1] = end
  doc.frontier = c + 1
  if (keepTokens || doc.chunks[c]) {
    const wasApprox = doc.approx.has(c)
    doc.chunks[c] = lines
    doc.approx.delete(c)
    return wasApprox
  }
  return false
}

function ensureChunk(doc, c) {
  if (doc.chunks[c] && !doc.approx.has(c)) return
  if (c < doc.frontier) {
    const { lines } = tokenizeChunk(doc, c, doc.states[c])
    doc.chunks[c] = lines
    doc.approx.delete(c)
    return
  }
  if (c - doc.frontier <= CATCHUP_CHUNKS) {
    while (doc.frontier <= c) advanceFrontier(doc, doc.frontier === c)
    return
  }
  if (doc.chunks[c]) return // approximate tokens already exist
  // Far ahead of the exact frontier: warm up from a fresh state.
  let state
  for (let w = Math.max(0, c - WARMUP_CHUNKS); w < c; w++) state = tokenizeChunk(doc, w, state).end
  doc.chunks[c] = tokenizeChunk(doc, c, state).lines
  doc.approx.add(c)
}

// While idle, move the exact frontier towards approximately tokenized chunks
// and resend them once their exact tokens are known.
function scheduleIdle() {
  clearTimeout(idleTimer)
  if (!current) return
  const work = ['old', 'new'].some((s) => current.docs[s] && current.docs[s].engine !== 'treelights' && current.docs[s].approx.size)
  if (!work) return
  idleTimer = setTimeout(() => {
    if (!current || queue.length) return
    const id = current.id
    const deadline = performance.now() + 15
    for (const side of ['old', 'new']) {
      const doc = current.docs[side]
      if (!doc || !doc.approx.size) continue
      while (performance.now() < deadline && doc.approx.size) {
        const c = doc.frontier
        if (advanceFrontier(doc, false)) {
          const n = doc.starts.length - 1
          post(id, side, doc, c * CHUNK, Math.min(n, (c + 1) * CHUNK))
        }
      }
    }
    scheduleIdle()
  }, 0)
}
