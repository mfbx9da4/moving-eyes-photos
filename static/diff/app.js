import { history, defaultKeymap, historyKeymap, indentWithTab } from '@codemirror/commands'
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search'
import { Compartment, EditorState } from '@codemirror/state'
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  placeholder,
} from '@codemirror/view'
import { FUNCNAME_DRIVERS } from './hunks.js'
import { icon } from './icons.js'
import { DiffModel } from './model.js'
import { DiffView } from './view.js'

const $ = (sel, root = document) => root.querySelector(sel)
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel))

const ALGORITHM_LABELS = {
  myers: 'git Myers + indent heuristic (GitHub)',
  minimal: 'git --minimal',
  patience: 'git --patience',
  histogram: 'git --histogram',
  jsdiff: 'jsdiff diffLines',
  difftastic: 'difftastic',
}
const SIDES = ['old', 'new']
const PERSIST_LIMIT = 512 * 1024

// ---------------------------------------------------------------- settings

const defaults = {
  algorithm: 'myers',
  view: 'unified',
  whitespace: '',
  wrap: true,
  compact: false,
  language: 'auto',
  tabSize: 4,
  theme: 'auto',
  inputsHidden: false,
  inputsHeight: null,
}

function load(key, fallback) {
  try {
    const v = localStorage.getItem(key)
    return v === null ? fallback : JSON.parse(v)
  } catch {
    return fallback
  }
}

function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {}
}

const settings = { ...defaults, ...load('diff:settings', {}) }
const saveSettings = () => save('diff:settings', settings)

// ---------------------------------------------------------------- example

const EXAMPLE_OLD = `import { readFile } from 'node:fs/promises'

// Count the words in a file.
export async function countWords(path) {
  const text = await readFile(path, 'utf8')
  const words = text.split(' ')
  return words.length
}

export function longest(words) {
  let best = ''
  for (const w of words) {
    if (w.length > best.length) best = w
  }
  return best
}
`

const EXAMPLE_NEW = `import { readFile } from 'node:fs/promises'

// Count the words in a file, ignoring blank runs.
export async function countWords(path, { encoding = 'utf8' } = {}) {
  const text = await readFile(path, encoding)
  const words = text.split(/\\s+/).filter(Boolean)
  return words.length
}

export function longest(words) {
  return words.reduce((best, w) => (w.length > best.length ? w : best), '')
}
`

// ---------------------------------------------------------------- editors

const panes = {}
const tabSizeCompartment = new Compartment()
const themeCompartment = new Compartment()
// CodeMirror's dark base styles (search panel, tooltips) follow the page theme
const editorTheme = () => EditorView.theme({}, { dark: document.documentElement.dataset.theme === 'dark' })

for (const side of SIDES) {
  const el = $(`.pane[data-side="${side}"]`)
  const saved = load(`diff:${side}`, null)
  const initial = saved ? saved.text : side === 'old' ? EXAMPLE_OLD : EXAMPLE_NEW
  const name = saved ? saved.name : 'words.js'
  const view = new EditorView({
    parent: $('.editor', el),
    state: EditorState.create({
      doc: initial,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        drawSelection(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        search({ top: true }),
        keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
        placeholder(side === 'old' ? 'Paste the original text, or drop a file here…' : 'Paste the modified text, or drop a file here…'),
        tabSizeCompartment.of(EditorState.tabSize.of(settings.tabSize)),
        EditorView.contentAttributes.of({ 'aria-label': side === 'old' ? 'Original text' : 'Modified text', spellcheck: 'false' }),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onInput(side)
        }),
        // file drops are handled by the pane, not inserted at the drop point
        EditorView.domEventHandlers({ drop: (e) => !!(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) }),
        themeCompartment.of(editorTheme()),
      ],
    }),
  })
  const nameInput = $('.filename', el)
  nameInput.value = name
  nameInput.addEventListener('input', () => onInput(side))
  panes[side] = {
    el,
    view,
    nameInput,
    badge: $('.lang-badge', el),
    meta: $('.pane-meta', el),
    fileInput: $('input[type=file]', el),
  }
  $('.open', el).innerHTML = icon('upload')
  $('.clear', el).innerHTML = icon('x')
  $('.open', el).addEventListener('click', () => panes[side].fileInput.click())
  $('.clear', el).addEventListener('click', () => {
    setDoc(side, '')
    nameInput.value = ''
    onInput(side)
  })
  panes[side].fileInput.addEventListener('change', (e) => {
    const f = e.target.files[0]
    if (f) loadFile(side, f)
    e.target.value = ''
  })
  el.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    el.classList.add('dragover')
  })
  el.addEventListener('dragleave', () => el.classList.remove('dragover'))
  el.addEventListener('drop', (e) => {
    el.classList.remove('dragover')
    const files = Array.from(e.dataTransfer.files || [])
    if (!files.length) return
    e.preventDefault()
    if (files.length >= 2) {
      loadFile('old', files[0])
      loadFile('new', files[1])
      return
    }
    loadFile(side, files[0])
  })
}

function setDoc(side, text) {
  const v = panes[side].view
  v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text }, scrollIntoView: false })
}

let loadNotes = []
async function loadFile(side, file) {
  setStatus(`Reading ${file.name}…`, { busy: true })
  let text
  try {
    text = await file.text()
  } catch (err) {
    setStatus(`Could not read ${file.name}: ${err.message || err}`, { error: true })
    return
  }
  if (text.slice(0, 8000).includes('\0')) loadNotes.push(`${file.name} looks like a binary file; diffed as text`)
  panes[side].nameInput.value = file.name
  setDoc(side, text)
  onInput(side, true)
}

$('#swap').innerHTML = icon('arrow-switch')
$('#swap').addEventListener('click', () => {
  const o = panes.old.view.state.doc.toString()
  const n = panes.new.view.state.doc.toString()
  const on = panes.old.nameInput.value
  panes.old.nameInput.value = panes.new.nameInput.value
  panes.new.nameInput.value = on
  setDoc('old', n)
  setDoc('new', o)
  scheduleDiff(0)
})

// ---------------------------------------------------------------- toolbar

$('#logo').innerHTML = icon('diff')
const algorithmSel = $('#algorithm')
const whitespaceSel = $('#whitespace')
const languageSel = $('#language')
const tabSizeSel = $('#tabsize')
const themeSel = $('#theme')
const wrapBox = $('#wrap')
const compactBox = $('#compact')

algorithmSel.value = settings.algorithm
whitespaceSel.value = settings.whitespace
tabSizeSel.value = String(settings.tabSize)
themeSel.value = settings.theme
wrapBox.checked = settings.wrap
compactBox.checked = settings.compact

algorithmSel.addEventListener('change', () => {
  settings.algorithm = algorithmSel.value
  saveSettings()
  scheduleDiff(0)
})
whitespaceSel.addEventListener('change', () => {
  settings.whitespace = whitespaceSel.value
  saveSettings()
  scheduleDiff(0)
})
for (const b of $$('.seg button')) {
  b.addEventListener('click', () => {
    settings.view = b.dataset.view
    saveSettings()
    applyViewOptions()
  })
}
wrapBox.addEventListener('change', () => {
  settings.wrap = wrapBox.checked
  saveSettings()
  applyViewOptions()
})
compactBox.addEventListener('change', () => {
  settings.compact = compactBox.checked
  saveSettings()
  applyViewOptions()
})
tabSizeSel.addEventListener('change', () => {
  settings.tabSize = Number(tabSizeSel.value)
  saveSettings()
  for (const side of SIDES)
    panes[side].view.dispatch({ effects: tabSizeCompartment.reconfigure(EditorState.tabSize.of(settings.tabSize)) })
  applyViewOptions()
})
themeSel.addEventListener('change', () => {
  settings.theme = themeSel.value
  saveSettings()
  window.setThemePreference(settings.theme)
})
new MutationObserver(() => {
  for (const side of SIDES) panes[side].view.dispatch({ effects: themeCompartment.reconfigure(editorTheme()) })
}).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
languageSel.addEventListener('change', () => {
  settings.language = languageSel.value
  saveSettings()
  startHighlight()
})

const inputsEl = $('#inputs')
const toggleInputs = $('#toggle-inputs')
function applyInputsVisibility() {
  inputsEl.classList.toggle('collapsed', settings.inputsHidden)
  $('#resizer').hidden = settings.inputsHidden
  toggleInputs.textContent = settings.inputsHidden ? 'Show inputs' : 'Hide inputs'
  toggleInputs.setAttribute('aria-expanded', String(!settings.inputsHidden))
}
toggleInputs.addEventListener('click', () => {
  settings.inputsHidden = !settings.inputsHidden
  saveSettings()
  applyInputsVisibility()
})
if (settings.inputsHeight) inputsEl.style.setProperty('--inputs-h', `${settings.inputsHeight}px`)
applyInputsVisibility()

// drag (or arrow keys) to resize the input panes
function setInputsHeight(h) {
  h = Math.max(80, Math.min(window.innerHeight - 200, h))
  inputsEl.style.setProperty('--inputs-h', `${h}px`)
  settings.inputsHeight = h
}
$('#resizer').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
  e.preventDefault()
  setInputsHeight(inputsEl.getBoundingClientRect().height + (e.key === 'ArrowDown' ? 24 : -24))
  saveSettings()
})
$('#resizer').addEventListener('pointerdown', (e) => {
  const startY = e.clientY
  const startH = inputsEl.getBoundingClientRect().height
  const move = (ev) => setInputsHeight(startH + ev.clientY - startY)
  const up = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    saveSettings()
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
})

// ---------------------------------------------------------------- status

const statusEl = $('#status')
let busyTimer = 0
function startBusyStatus(text) {
  const t0 = performance.now()
  setStatus(text, { busy: true })
  busyTimer = setInterval(() => {
    const s = Math.round((performance.now() - t0) / 1000)
    if (s < 2) return
    let tick = statusEl.querySelector('.tick')
    if (!tick) {
      tick = Object.assign(document.createElement('span'), { className: 'tick' })
      tick.setAttribute('aria-hidden', 'true')
      statusEl.append(tick)
    }
    tick.textContent = `${s}s`
  }, 1000)
}
function setStatus(text, { busy = false, note = false, error = false } = {}) {
  clearInterval(busyTimer)
  statusEl.innerHTML = ''
  if (busy) statusEl.append(Object.assign(document.createElement('span'), { className: 'spinner' }))
  const span = document.createElement('span')
  span.textContent = text
  if (note) span.className = 'note'
  if (error) span.className = 'error'
  statusEl.append(span)
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function updateMeta(side) {
  const doc = panes[side].view.state.doc
  panes[side].meta.textContent = `${doc.lines.toLocaleString()} lines · ${formatBytes(doc.length)}`
}

// ---------------------------------------------------------------- view

const diffView = new DiffView($('#diff'), {
  onVisibleLines: (r) => requestTokens(r),
  onExpand: () => updateExpandButton(),
})

function applyViewOptions() {
  for (const b of $$('.seg button')) b.setAttribute('aria-pressed', String(b.dataset.view === settings.view))
  diffView.setOptions({
    split: settings.view === 'split',
    wrap: settings.wrap,
    lineHeight: settings.compact ? 20 : 24,
    tabSize: settings.tabSize,
  })
}
applyViewOptions()

const fileEl = $('#file')
$('#collapse').innerHTML = icon('chevron-down')
$('#collapse').addEventListener('click', () => {
  const collapsed = fileEl.classList.toggle('collapsed')
  $('#collapse').innerHTML = icon(collapsed ? 'chevron-right' : 'chevron-down')
  $('#collapse').setAttribute('aria-expanded', String(!collapsed))
})
$('#copy-name').innerHTML = icon('copy')
$('#copy-name').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('#file-name').textContent)
    $('#copy-name').innerHTML = icon('check')
    setTimeout(() => ($('#copy-name').innerHTML = icon('copy')), 1200)
  } catch {}
})
$('#expand-all').addEventListener('click', () => {
  diffView.expandAll()
  updateExpandButton()
})

function updateExpandButton() {
  const m = diffView.model
  const btn = $('#expand-all')
  btn.hidden = !m || m.identical || m.fullyExpanded
  btn.innerHTML = icon('unfold')
}

function renderHeader(model) {
  const on = panes.old.nameInput.value.trim()
  const nn = panes.new.nameInput.value.trim()
  const nameEl = $('#file-name')
  if (on && nn && on !== nn) nameEl.textContent = `${on} → ${nn}`
  else nameEl.textContent = nn || on || 'Untitled'
  nameEl.title = nameEl.textContent

  const stat = $('#diffstat')
  if (!model) {
    stat.innerHTML = ''
    return
  }
  const adds = model.additions
  const dels = model.deletions
  const total = adds + dels
  const blocks = Math.min(total, 5)
  const a = total ? Math.floor((adds / total) * blocks) : 0
  const d = total ? Math.floor((dels / total) * blocks) : 0
  let sq = ''
  for (let i = 0; i < a; i++) sq += '<span class="sq a"></span>'
  for (let i = 0; i < d; i++) sq += '<span class="sq d"></span>'
  for (let i = a + d; i < 5; i++) sq += '<span class="sq n"></span>'
  stat.innerHTML = `<span class="add">+${adds.toLocaleString()}</span><span class="del">-${dels.toLocaleString()}</span><span class="squares" aria-hidden="true">${sq}</span>`
  stat.title = `${adds.toLocaleString()} additions & ${dels.toLocaleString()} deletions`
}

// ---------------------------------------------------------------- workers

const workerUrl = (name) => new URL(name, import.meta.url)
let diffWorker = null
let diffBusy = false
let hlWorker = null

function spawnDiffWorker() {
  diffWorker = new Worker(workerUrl('./diff-worker.js'), { type: 'module' })
  diffWorker.onmessage = onDiffMessage
  diffWorker.onerror = (e) => {
    diffBusy = false
    setStatus(`Diff worker failed: ${e.message || 'unknown error'}`, { error: true })
  }
}

function spawnHighlightWorker() {
  hlWorker = new Worker(workerUrl('./highlight-worker.js'), { type: 'module' })
  hlWorker.onmessage = onHighlightMessage
  hlWorker.onerror = (e) => console.warn('highlight worker error', e.message)
}

spawnDiffWorker()
spawnHighlightWorker()

let reqId = 0
let current = null // snapshot the current diff belongs to
let pendingTimer = 0

function onInput(side, immediate = false) {
  updateMeta(side)
  persist(side)
  const size = panes.old.view.state.doc.length + panes.new.view.state.doc.length
  scheduleDiff(immediate ? 0 : Math.min(1000, Math.max(150, size / 20000)))
}

const persistTimers = {}
function persist(side) {
  clearTimeout(persistTimers[side])
  persistTimers[side] = setTimeout(() => {
    const doc = panes[side].view.state.doc
    if (doc.length > PERSIST_LIMIT) {
      try {
        localStorage.removeItem(`diff:${side}`)
      } catch {}
      return
    }
    save(`diff:${side}`, { text: doc.toString(), name: panes[side].nameInput.value })
  }, 500)
}

function scheduleDiff(delay) {
  clearTimeout(pendingTimer)
  pendingTimer = setTimeout(requestDiff, delay)
}

function requestDiff() {
  const id = ++reqId
  const oldText = panes.old.view.state.doc.toString()
  const newText = panes.new.view.state.doc.toString()
  current = {
    id,
    oldText,
    newText,
    oldName: panes.old.nameInput.value.trim(),
    newName: panes.new.nameInput.value.trim(),
    algorithm: settings.algorithm,
    languages: null,
  }
  if (diffBusy) {
    // the worker is stuck in a long diff: start over with a fresh one
    diffWorker.terminate()
    spawnDiffWorker()
  }
  diffBusy = true
  startBusyStatus(`Diffing with ${ALGORITHM_LABELS[settings.algorithm]}…`)
  diffWorker.postMessage({
    type: 'diff',
    id,
    oldText,
    newText,
    algorithm: settings.algorithm,
    whitespace: settings.whitespace,
    oldName: current.oldName,
    newName: current.newName,
  })
  startHighlight()
}

function onDiffMessage(e) {
  const msg = e.data
  if (!current || msg.id !== current.id) return
  if (msg.type === 'error') {
    diffBusy = false
    setStatus(`Diff failed: ${msg.message}`, { error: true })
    return
  }
  if (msg.type === 'result') {
    diffBusy = false
    const model = new DiffModel({
      changes: msg.changes,
      oldText: current.oldText,
      newText: current.newText,
      oldStarts: msg.oldStarts,
      newStarts: msg.newStarts,
      funcDriver: funcDriverFor(current.languages && current.languages.old),
    })
    current.model = model
    diffView.setModel(model)
    // tokens that arrived before the model
    for (const side of SIDES) if (current.pendingTokens) diffView.addTokens(side, current.pendingTokens[side] || [])
    resetTokenRequests(model)
    renderHeader(model)
    updateExpandButton()
    const empty = $('#empty')
    empty.hidden = model.n1 + model.n2 > 0
    empty.textContent = 'Paste text or drop files into the boxes above to compare them.'
    const hunks = model.hunks.length
    const time = msg.ms < 1 ? '<1 ms' : msg.ms < 1000 ? `${Math.round(msg.ms)} ms` : `${(msg.ms / 1000).toFixed(2)} s`
    const summary = model.identical
      ? `No differences (${ALGORITHM_LABELS[current.algorithm]}, ${time})`
      : `${hunks.toLocaleString()} hunk${hunks === 1 ? '' : 's'} · ${ALGORITHM_LABELS[current.algorithm]} · ${time}`
    setStatus(summary)
    for (const note of [msg.note, ...loadNotes]) {
      if (!note) continue
      const n = document.createElement('span')
      n.className = 'note'
      n.textContent = `· ${note}`
      statusEl.append(n)
    }
    loadNotes = []
    return
  }
  if (msg.type === 'inline') {
    if (msg.old.length) diffView.addInline('old', msg.old)
    if (msg.new.length) diffView.addInline('new', msg.new)
  }
}

// ---------------------------------------------------------------- highlighting

function funcDriverFor(lang) {
  if (!lang) return undefined
  if (lang.name === 'Python') return FUNCNAME_DRIVERS.python
  if (lang.name === 'Ruby') return FUNCNAME_DRIVERS.ruby
  return undefined
}

let languagesListed = false

function startHighlight() {
  if (!current) return
  current.pendingTokens = { old: [], new: [] }
  // a new generation for every (re)load, so late replies for an earlier
  // language choice are ignored
  current.hlGen = (current.hlGen || 0) + 1
  hlWorker.postMessage({
    type: 'load',
    id: current.id,
    gen: current.hlGen,
    language: settings.language,
    old: { text: current.oldText, name: current.oldName },
    new: { text: current.newText, name: current.newName },
  })
  if (current.model) {
    diffView.tokens = { old: new Map(), new: new Map() }
    resetTokenRequests(current.model)
    diffView.invalidateSoon()
  }
}

// lines already requested from the highlighter, per side
let requested = { old: new Uint8Array(0), new: new Uint8Array(0) }
function resetTokenRequests(model) {
  requested = { old: new Uint8Array(model.n1), new: new Uint8Array(model.n2) }
  if (current && current.languages) requestTokens(diffView.visibleLines())
}

const PREFETCH = 80
function requestTokens(ranges) {
  if (!current || !current.languages || !current.model) return
  for (const side of SIDES) {
    const r = ranges[side]
    const lang = current.languages[side]
    if (!r || !lang || !lang.shiki) continue
    const req = requested[side]
    const from = Math.max(0, r[0] - PREFETCH)
    const to = Math.min(req.length, r[1] + PREFETCH)
    let i = from
    while (i < to) {
      while (i < to && req[i]) i++
      if (i >= to) break
      const s = i
      while (i < to && !req[i]) req[i++] = 1
      hlWorker.postMessage({ type: 'tokens', id: current.id, side, from: s, to: i })
    }
  }
}

function onHighlightMessage(e) {
  const msg = e.data
  if (msg.type === 'languages') {
    if (languagesListed) return
    languagesListed = true
    for (const l of msg.list) {
      const o = document.createElement('option')
      o.value = l.id
      o.textContent = l.name
      languageSel.append(o)
    }
    languageSel.value = settings.language
    if (languageSel.value !== settings.language) languageSel.value = 'auto'
    return
  }
  // class stack definitions are global: keep them even from stale replies
  if (msg.stacks && msg.stacks.length) diffView.addStacks(msg.stacks)
  if (!current || msg.id !== current.id || msg.gen !== current.hlGen) return
  if (msg.type === 'lang') {
    current.languages = { old: msg.old, new: msg.new }
    for (const side of SIDES) {
      const l = msg[side]
      panes[side].badge.textContent = l && l.name ? l.name : ''
      panes[side].badge.title = l && l.name ? `${l.name}: detected by ${l.strategy}${l.engine ? `, highlighted with ${l.engine}` : ''}` : ''
    }
    const l = msg.new && msg.new.name ? msg.new : msg.old
    $('#file-lang').textContent = l && l.name ? l.name : ''
    if (current.model) {
      current.model.funcDriver = funcDriverFor(msg.old)
      current.model.funcCache.clear()
      resetTokenRequests(current.model)
      diffView.invalidateSoon()
    }
    return
  }
  if (msg.type === 'tokens') {
    const lines = []
    const { data, offsets, from } = msg
    for (let k = 0; k + 1 < offsets.length; k++) lines.push([from + k, data.subarray(offsets[k], offsets[k + 1])])
    if (current.model) diffView.addTokens(msg.side, lines)
    else current.pendingTokens[msg.side].push(...lines)
  }
}

// ---------------------------------------------------------------- start

for (const side of SIDES) updateMeta(side)
requestDiff()

// handy for debugging from the console
window.diffApp = { view: diffView, panes, settings, get current() { return current } }
