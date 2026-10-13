// Virtualized GitHub-style diff table. Only the rows near the viewport exist
// in the DOM, so files with millions of lines scroll smoothly. Rows sit in a
// sticky "layer" covering the scroller's viewport; the scroller itself only
// holds a spacer sized to the content. Row heights live in a Fenwick tree so
// wrapped (variable height) rows work too: they are estimated from line
// length and corrected once rendered.

import { icon } from './icons.js'
import { ROW_ADD, ROW_CHG, ROW_CTX, ROW_DEL, ROW_EXPANDER, ROW_HUNK } from './model.js'

const OVERSCAN = 600
const MAX_SPACER = 15_000_000
const RENDER_CAP = 20_000
const HIGHLIGHT_CAP = 5_000
const ESC = /[&<>"]/g
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }
const esc = (s) => s.replace(ESC, (c) => ESC_MAP[c])


/** Fenwick tree of row heights. */
class Heights {
  constructor(hs) {
    const n = hs.length
    const t = new Float64Array(n + 1)
    let total = 0
    for (let i = 0; i < n; i++) {
      t[i + 1] += hs[i]
      total += hs[i]
      const j = i + 1 + ((i + 1) & -(i + 1))
      if (j <= n) t[j] += t[i + 1]
    }
    this.n = n
    this.h = hs
    this.t = t
    this.total = total
    let m = 1
    while (m * 2 <= n) m *= 2
    this.mask = n ? m : 0
  }
  get(i) {
    return this.h[i]
  }
  set(i, h) {
    const d = h - this.h[i]
    if (!d) return
    this.h[i] = h
    this.total += d
    for (let j = i + 1; j <= this.n; j += j & -j) this.t[j] += d
  }
  /** Sum of heights of rows [0, i). */
  prefix(i) {
    let s = 0
    for (let j = i; j > 0; j -= j & -j) s += this.t[j]
    return s
  }
  /** Index of the row containing offset y. */
  indexAt(y) {
    let pos = 0
    let rem = y
    for (let m = this.mask; m; m >>= 1) {
      const nx = pos + m
      if (nx <= this.n && this.t[nx] <= rem) {
        pos = nx
        rem -= this.t[nx]
      }
    }
    return Math.max(0, Math.min(pos, this.n - 1))
  }
}

export class DiffView {
  constructor(host, callbacks = {}) {
    this.host = host
    this.cb = callbacks
    host.classList.add('diff-view')
    host.innerHTML =
      '<div class="diff-scroller" tabindex="0"><div class="diff-spacer"><div class="diff-layer"><div class="diff-rows"></div></div></div></div>' +
      '<span class="diff-measure" aria-hidden="true">0000000000</span>'
    this.scroller = host.querySelector('.diff-scroller')
    this.spacer = host.querySelector('.diff-spacer')
    this.layer = host.querySelector('.diff-layer')
    this.rowsEl = host.querySelector('.diff-rows')
    this.measureEl = host.querySelector('.diff-measure')

    this.model = null
    this.rows = null
    this.split = false
    this.wrap = true
    this.lh = 24
    this.v = 0
    this.sx = 0
    this.factor = 1
    this.lastSetTop = -1
    this.start = 0
    this.end = 0
    this.els = []
    this.tokens = { old: new Map(), new: new Map() }
    this.inline = { old: new Map(), new: new Map() }
    this.stacks = new Map()
    this.selected = null
    this.maxTextWidth = 0

    this.scroller.addEventListener('scroll', () => this.onScroll(), { passive: true })
    this.scroller.addEventListener('wheel', (e) => this.onWheel(e), { passive: false })
    this.rowsEl.addEventListener('click', (e) => this.onClick(e))
    this.resizeObserver = new ResizeObserver(() => this.onResize())
    this.resizeObserver.observe(this.scroller)
  }

  // ------------------------------------------------------------- inputs

  setModel(model) {
    this.model = model
    this.tokens = { old: new Map(), new: new Map() }
    this.inline = { old: new Map(), new: new Map() }
    this.selected = null
    this.v = 0
    this.maxTextWidth = this.computeMaxTextWidth()
    this.rebuild(null)
    this.scroller.scrollTop = 0
    this.scroller.scrollLeft = 0
    this.lastSetTop = 0
    this.sx = 0
  }

  setOptions({ split, wrap, lineHeight, tabSize }) {
    const anchor = this.captureAnchor()
    if (split !== undefined) this.split = split
    if (wrap !== undefined) this.wrap = wrap
    if (lineHeight !== undefined) this.lh = lineHeight
    if (tabSize !== undefined) this.host.style.setProperty('--tab-size', tabSize)
    this.host.classList.toggle('split', this.split)
    this.host.classList.toggle('unified', !this.split)
    this.host.classList.toggle('nowrap', !this.wrap)
    this.host.style.setProperty('--lh', `${this.lh}px`)
    if (this.model) {
      this.maxTextWidth = this.computeMaxTextWidth()
      this.rebuild(anchor)
    }
  }

  addTokens(side, lines) {
    const map = this.tokens[side]
    for (const [line, toks] of lines) map.set(line, toks)
    this.invalidateSoon()
  }

  /** Class stacks from the highlighter: [id, "pl-s>pl-s1"] (outermost first). */
  addStacks(entries) {
    for (const [id, str] of entries) {
      const levels = str.split('>')
      const inner = levels.pop()
      this.stacks.set(id, {
        open: levels.map((c) => `<span class="${c}">`).join(''),
        close: '</span>'.repeat(levels.length),
        inner,
      })
    }
  }

  hasTokens(side, line) {
    return this.tokens[side].has(line)
  }

  /** Flat [line, count, s, e, ...] word highlight ranges from the worker. */
  addInline(side, flat) {
    const map = this.inline[side]
    for (let i = 0; i < flat.length; ) {
      const line = flat[i]
      const count = flat[i + 1]
      map.set(line, flat.subarray(i + 2, i + 2 + count * 2))
      i += 2 + count * 2
    }
    this.invalidateSoon()
  }

  invalidateSoon() {
    if (this.invalidatePending) return
    this.invalidatePending = true
    requestAnimationFrame(() => {
      this.invalidatePending = false
      this.rerenderWindow()
    })
  }

  expandAll() {
    if (!this.model) return
    const anchor = this.captureAnchor()
    this.model.expandAll()
    this.rebuild(anchor)
  }

  scrollToRow(i) {
    if (!this.heights) return
    this.setVirtual(this.heights.prefix(i))
  }

  // ------------------------------------------------------------- layout

  get charWidth() {
    if (!this._chW) this._chW = this.measureEl.getBoundingClientRect().width / 10 || 7.2
    return this._chW
  }

  computeMaxTextWidth() {
    if (!this.model) return 0
    let max = 0
    for (const starts of [this.model.oldStarts, this.model.newStarts]) {
      for (let i = 1; i < starts.length; i++) {
        const len = starts[i] - starts[i - 1]
        if (len > max) max = len
      }
    }
    return Math.min(max, RENDER_CAP + 40) * this.charWidth
  }

  lineNumberWidth() {
    const digits = String(Math.max(this.model ? this.model.n1 : 1, this.model ? this.model.n2 : 1, 1)).length
    return Math.max(44, Math.ceil(digits * this.charWidth + 16))
  }

  // Width available to the text of one code cell (excluding padding).
  textWidth() {
    const w = this.scroller.clientWidth
    const ln = this.lnW
    const code = this.split ? (w - 2 * ln) / 2 : w - 2 * ln
    return Math.max(40, code - 48)
  }

  lineLength(starts, line) {
    return starts[line + 1] - starts[line]
  }

  estimateHeight(i, cols) {
    const { kind, a, b } = this.rows
    const k = kind[i]
    const lh = this.lh
    if (k === ROW_HUNK || k === ROW_EXPANDER) return this.hunkRowHeight(i)
    if (!this.wrap) return lh
    const m = this.model
    let len = 0
    if (k === ROW_CTX && !this.split) len = this.lineLength(m.newStarts, b[i])
    else {
      if (a[i] >= 0 && k !== ROW_ADD) len = this.lineLength(m.oldStarts, a[i])
      if (b[i] >= 0 && k !== ROW_DEL) len = Math.max(len, this.lineLength(m.newStarts, b[i]))
    }
    len = Math.min(len, RENDER_CAP + 40)
    return lh * Math.max(1, Math.ceil(len / cols))
  }

  hunkRowHeight(i) {
    const kind = this.model.expandKind(this.rows.a[i])
    return kind === 'both' ? this.lh * 2 : this.lh
  }

  rebuild(anchor) {
    const m = this.model
    this.rows = m.buildRows(this.split)
    this.lnW = this.lineNumberWidth()
    this.host.style.setProperty('--ln-w', `${this.lnW}px`)
    this.layoutWidth = this.scroller.clientWidth
    const cols = Math.max(1, Math.floor(this.textWidth() / this.charWidth))
    const n = this.rows.count
    const hs = new Float64Array(n)
    for (let i = 0; i < n; i++) hs[i] = this.estimateHeight(i, cols)
    this.heights = new Heights(hs)
    this.measured = new Uint8Array(n)
    this.rowsEl.textContent = ''
    this.els = []
    this.start = this.end = 0
    this.updateSpacer()
    if (anchor) this.restoreAnchor(anchor)
    else this.setVirtual(Math.min(this.v, this.maxVirtual()))
    this.render()
  }

  updateSpacer() {
    const total = this.heights ? this.heights.total : 0
    const vh = this.scroller.clientHeight
    const spacerH = Math.min(total, MAX_SPACER)
    this.factor = total > MAX_SPACER && spacerH > vh ? (total - vh) / (spacerH - vh) : 1
    this.spacer.style.height = `${spacerH}px`
    const overflow = this.wrap ? 0 : Math.max(0, this.maxTextWidth + 8 - this.textWidth())
    this.spacer.style.width = `${this.scroller.clientWidth + overflow}px`
    this.layer.style.width = `${this.scroller.clientWidth}px`
    this.layer.style.height = `${Math.min(vh, spacerH)}px`
  }

  maxVirtual() {
    return Math.max(0, (this.heights ? this.heights.total : 0) - this.scroller.clientHeight)
  }

  setVirtual(v) {
    this.v = Math.max(0, Math.min(v, this.maxVirtual()))
    const top = Math.round(this.v / this.factor)
    this.lastSetTop = top
    if (Math.abs(this.scroller.scrollTop - top) >= 1) this.scroller.scrollTop = top
  }

  // Remember the first visible line so layout changes keep it in place.
  captureAnchor() {
    if (!this.rows || !this.heights || !this.rows.count) return null
    let i = this.heights.indexAt(this.v)
    // headers may disappear when gaps expand: anchor on a line row instead
    const isHeader = (j) => this.rows.kind[j] === ROW_HUNK || this.rows.kind[j] === ROW_EXPANDER
    let j = i
    while (j < this.rows.count && isHeader(j)) j++
    if (j >= this.rows.count) for (j = i; j >= 0 && isHeader(j); j--);
    if (j >= 0 && j < this.rows.count) i = j
    return {
      kind: this.rows.kind[i],
      a: this.rows.a[i],
      b: this.rows.b[i],
      offset: this.v - this.heights.prefix(i),
    }
  }

  findRow(anchor) {
    const { kind, a, b, count } = this.rows
    if (anchor.kind === ROW_HUNK || anchor.kind === ROW_EXPANDER) {
      for (let i = 0; i < count; i++) if ((kind[i] === ROW_HUNK || kind[i] === ROW_EXPANDER) && a[i] === anchor.a) return i
    }
    // rows are ordered by line number on each side
    const side = anchor.a >= 0 ? a : b
    const target = anchor.a >= 0 ? anchor.a : anchor.b
    let best = -1
    for (let i = 0; i < count; i++) {
      if (kind[i] === ROW_HUNK || kind[i] === ROW_EXPANDER) continue
      if (side[i] >= 0 && side[i] <= target) best = i
      if (side[i] > target) break
    }
    return best
  }

  restoreAnchor(anchor) {
    const i = this.findRow(anchor)
    if (i < 0) return this.setVirtual(0)
    this.setVirtual(this.heights.prefix(i) + anchor.offset)
  }

  // ------------------------------------------------------------- events

  onScroll() {
    if (!this.heights) return
    const st = this.scroller.scrollTop
    if (this.factor === 1) this.v = st
    else if (Math.abs(st - Math.round(this.v / this.factor)) > 1) this.v = Math.min(st * this.factor, this.maxVirtual())
    this.sx = this.scroller.scrollLeft
    this.layer.style.setProperty('--sx', this.sx)
    this.render()
  }

  // In scaled mode (content taller than browsers allow) translate wheel
  // deltas 1:1 instead of letting a pixel of scrollbar mean many pixels.
  onWheel(e) {
    if (this.factor === 1 || e.ctrlKey) return
    if (Math.abs(e.deltaY) < Math.abs(e.deltaX)) return
    e.preventDefault()
    const dy = e.deltaMode === 1 ? e.deltaY * this.lh : e.deltaMode === 2 ? e.deltaY * this.scroller.clientHeight : e.deltaY
    this.setVirtual(this.v + dy)
    this.render()
  }

  onResize() {
    if (!this.model) return
    this.updateSpacer()
    this.render()
    // Wrapped row heights depend on the width: re-estimate once resizing settles.
    if (this.wrap && this.layoutWidth !== this.scroller.clientWidth) {
      clearTimeout(this.resizeTimer)
      this.resizeTimer = setTimeout(() => this.rebuild(this.captureAnchor()), 120)
    }
  }

  onClick(e) {
    const btn = e.target.closest('.xp')
    if (btn) {
      const gap = Number(btn.dataset.gap)
      const dir = btn.dataset.dir
      const rowEl = btn.closest('.r')
      const rowIndex = Number(rowEl.dataset.i)
      // keep the line next to the button where it is on screen
      const neighbour = dir === 'up' ? rowIndex + 1 : rowIndex - 1
      const ni = Math.max(0, Math.min(this.rows.count - 1, neighbour))
      const anchor = {
        kind: this.rows.kind[ni],
        a: this.rows.a[ni],
        b: this.rows.b[ni],
        offset: this.v - this.heights.prefix(ni),
      }
      const hadFocus = document.activeElement === btn
      this.model.expand(gap, dir)
      this.rebuild(anchor)
      if (hadFocus) {
        const again = this.rowsEl.querySelector(`.xp[data-gap="${gap}"][data-dir="${dir}"]`) || this.rowsEl.querySelector(`.xp[data-gap="${gap}"]`)
        ;(again || this.scroller).focus({ preventScroll: true })
      }
      if (this.cb.onExpand) this.cb.onExpand()
      return
    }
    const ln = e.target.closest('.ln')
    if (ln && ln.textContent && ln.dataset.side) {
      const line = Number(ln.textContent) - 1
      const same = this.selected && this.selected.side === ln.dataset.side && this.selected.line === line
      this.selected = same ? null : { side: ln.dataset.side, line }
      this.rerenderWindow()
    }
  }

  // ------------------------------------------------------------- render

  render() {
    if (!this.rows || !this.rows.count) {
      this.rowsEl.textContent = ''
      this.els = []
      this.start = this.end = 0
      return
    }
    const vh = this.scroller.clientHeight
    const first = this.heights.indexAt(Math.max(0, this.v - OVERSCAN))
    const last = this.heights.indexAt(this.v + vh + OVERSCAN)
    this.setWindow(first, Math.min(this.rows.count, last + 1))
    this.position()
    if (this.wrap) this.measure()
    if (this.cb.onVisibleLines) this.cb.onVisibleLines(this.visibleLines())
  }

  position() {
    const y = this.heights.prefix(this.start) - this.v
    this.rowsEl.style.transform = `translate3d(0,${y}px,0)`
  }

  setWindow(start, end) {
    if (start === this.start && end === this.end && this.els.length) return
    const tpl = document.createElement('template')
    const created = []
    const make = (s, e) => {
      if (s >= e) return []
      const htmls = []
      for (let i = s; i < e; i++) htmls.push(this.rowHtml(i))
      tpl.innerHTML = htmls.join('')
      const els = Array.from(tpl.content.children)
      els.forEach((el, k) => {
        el._html = htmls[k]
        created.push(el)
      })
      return els
    }
    if (!this.els.length || end <= this.start || start >= this.end) {
      const els = make(start, end)
      this.rowsEl.replaceChildren(...els)
      this.els = els
    } else {
      // drop rows that left the window, add the ones that entered it
      while (this.start < start) {
        this.els.shift().remove()
        this.start++
      }
      while (this.end > end) {
        this.els.pop().remove()
        this.end--
      }
      if (start < this.start) {
        const els = make(start, this.start)
        this.rowsEl.prepend(...els)
        this.els = els.concat(this.els)
      }
      if (end > this.end) {
        const els = make(this.end, end)
        this.rowsEl.append(...els)
        this.els = this.els.concat(els)
      }
    }
    this.start = start
    this.end = end
    if (!this.wrap && created.length) this.measureWidths(created)
  }

  // Replace only rows whose markup changed (new tokens or word highlights),
  // so focus and unrelated rows survive. Wait while text is being selected.
  rerenderWindow() {
    if (!this.els.length) return
    const sel = document.getSelection()
    if (sel && !sel.isCollapsed && this.rowsEl.contains(sel.anchorNode)) {
      if (!this.deferred) {
        this.deferred = true
        document.addEventListener('selectionchange', this.onSelectionChange)
      }
      return
    }
    const tpl = document.createElement('template')
    let changed = false
    for (let k = 0; k < this.els.length; k++) {
      const i = this.start + k
      const html = this.rowHtml(i)
      if (this.els[k]._html === html) continue
      tpl.innerHTML = html
      const el = tpl.content.firstElementChild
      el._html = html
      this.els[k].replaceWith(el)
      this.els[k] = el
      this.measured[i] = 0
      changed = true
    }
    if (changed && this.wrap) this.measure()
    if (changed && !this.wrap) this.measureWidths(this.els)
  }

  onSelectionChange = () => {
    const sel = document.getSelection()
    if (sel && !sel.isCollapsed && this.rowsEl.contains(sel.anchorNode)) return
    document.removeEventListener('selectionchange', this.onSelectionChange)
    this.deferred = false
    this.rerenderWindow()
  }

  // In no-wrap mode the scroll width starts as an estimate (characters times
  // the glyph width); grow it when tabs or wide characters make lines longer.
  measureWidths(els) {
    let max = 0
    for (const el of els) for (const tx of el.querySelectorAll('.tx')) if (tx.scrollWidth > max) max = tx.scrollWidth
    if (max > this.maxTextWidth) {
      this.maxTextWidth = max
      this.updateSpacer()
    }
  }

  // Correct estimated heights of rendered rows, keeping the first visible
  // row anchored so nothing on screen jumps.
  measure(force) {
    const todo = []
    for (let k = 0; k < this.els.length; k++) {
      const i = this.start + k
      if (force || !this.measured[i]) todo.push(k)
    }
    if (!todo.length) return
    const anchor = this.heights.indexAt(this.v)
    const within = this.v - this.heights.prefix(anchor)
    const hs = todo.map((k) => this.els[k].offsetHeight)
    let changed = false
    todo.forEach((k, j) => {
      const i = this.start + k
      this.measured[i] = 1
      if (hs[j] && hs[j] !== this.heights.get(i)) {
        this.heights.set(i, hs[j])
        changed = true
      }
    })
    if (!changed) return
    this.updateSpacer()
    this.setVirtual(this.heights.prefix(anchor) + within)
    this.position()
    // rows may have shrunk: make sure the viewport is still covered
    const vh = this.scroller.clientHeight
    const last = this.heights.indexAt(this.v + vh + OVERSCAN)
    if (last + 1 > this.end && this.end < this.rows.count) {
      this.setWindow(this.start, Math.min(this.rows.count, last + 1))
      this.measure()
    }
  }

  visibleLines() {
    const { kind, a, b } = this.rows
    let o0 = Infinity
    let o1 = -1
    let n0 = Infinity
    let n1 = -1
    for (let i = this.start; i < this.end; i++) {
      const k = kind[i]
      if (k === ROW_HUNK || k === ROW_EXPANDER) continue
      if (a[i] >= 0 && (k !== ROW_CTX || this.split)) {
        if (a[i] < o0) o0 = a[i]
        if (a[i] > o1) o1 = a[i]
      }
      if (b[i] >= 0) {
        if (b[i] < n0) n0 = b[i]
        if (b[i] > n1) n1 = b[i]
      }
    }
    return { old: o1 >= 0 ? [o0, o1 + 1] : null, new: n1 >= 0 ? [n0, n1 + 1] : null }
  }

  // ------------------------------------------------------------- html

  lineText(side, line) {
    const m = this.model
    const text = side === 'old' ? m.oldText : m.newText
    const starts = side === 'old' ? m.oldStarts : m.newStarts
    let end = starts[line + 1]
    if (end > starts[line] && text.charCodeAt(end - 1) === 10) end--
    if (end > starts[line] && text.charCodeAt(end - 1) === 13) end--
    return text.slice(starts[line], end)
  }

  missingNewline(side, line) {
    const m = this.model
    const text = side === 'old' ? m.oldText : m.newText
    const n = side === 'old' ? m.n1 : m.n2
    return line === n - 1 && text.length > 0 && text.charCodeAt(text.length - 1) !== 10
  }

  lnCell(num, cls, side) {
    return `<div class="ln ln-${cls}"${num >= 0 ? ` data-side="${side}"` : ''}>${num >= 0 ? `<code>${num + 1}</code>` : ''}</div>`
  }

  isSelected(k, a, b) {
    const s = this.selected
    if (!s) return false
    if (s.side === 'old') return a === s.line && k !== ROW_ADD
    return b === s.line && k !== ROW_DEL
  }

  codeCell(side, line, cls, marker, extra = '') {
    return `<div class="cd cd-${cls}${extra}">${marker ? `<span class="mk">${marker}</span>` : ''}<div class="tw"><div class="tx">${this.codeHtml(side, line, cls)}</div></div></div>`
  }

  emptyCells(extra = '') {
    return `<div class="ln ln-empty"></div><div class="cd cd-empty${extra}"></div>`
  }

  rowHtml(i) {
    const { kind, a, b } = this.rows
    const k = kind[i]
    if (k === ROW_HUNK || k === ROW_EXPANDER) return this.hunkHtml(i)
    const sel = this.isSelected(k, a[i], b[i]) ? ' sel' : ''
    if (!this.split) {
      if (k === ROW_CTX)
        return `<div class="r r-ctx${sel}" data-i="${i}">${this.lnCell(a[i], 'ctx', 'old')}${this.lnCell(b[i], 'ctx', 'new')}${this.codeCell('new', b[i], 'ctx', '')}</div>`
      if (k === ROW_DEL)
        return `<div class="r r-del${sel}" data-i="${i}">${this.lnCell(a[i], 'del', 'old')}${this.lnCell(-1, 'del')}${this.codeCell('old', a[i], 'del', '-')}</div>`
      return `<div class="r r-add${sel}" data-i="${i}">${this.lnCell(-1, 'add')}${this.lnCell(b[i], 'add', 'new')}${this.codeCell('new', b[i], 'add', '+')}</div>`
    }
    if (k === ROW_CTX)
      return `<div class="r r-ctx${sel}" data-i="${i}">${this.lnCell(a[i], 'ctx', 'old')}${this.codeCell('old', a[i], 'ctx', '', ' cd-l')}${this.lnCell(b[i], 'ctx', 'new')}${this.codeCell('new', b[i], 'ctx', '')}</div>`
    const left = a[i] >= 0 ? this.lnCell(a[i], 'del', 'old') + this.codeCell('old', a[i], 'del', '-', ' cd-l') : this.emptyCells(' cd-l')
    const right = b[i] >= 0 ? this.lnCell(b[i], 'add', 'new') + this.codeCell('new', b[i], 'add', '+') : this.emptyCells()
    return `<div class="r r-chg${sel}" data-i="${i}">${left}${right}</div>`
  }

  hunkHtml(i) {
    const { kind, a, b, headers } = this.rows
    const gap = a[i]
    const ek = this.model.expandKind(gap)
    const btn = (dir, name, label) =>
      `<button class="xp" type="button" data-gap="${gap}" data-dir="${dir}" aria-label="${label}" title="${label}">${icon(name)}</button>`
    let buttons = ''
    if (ek === 'up') buttons = btn('up', 'fold-up', 'Expand up')
    else if (ek === 'down') buttons = btn('down', 'fold-down', 'Expand down')
    else if (ek === 'all') buttons = btn('all', 'unfold', 'Expand all')
    else if (ek === 'both') buttons = btn('down', 'fold-down', 'Expand down') + btn('up', 'fold-up', 'Expand up')
    const text = kind[i] === ROW_HUNK ? esc(this.model.headerText(headers[b[i]])) : ''
    return `<div class="r r-hunk${ek === 'both' ? ' r-hunk2' : ''}" data-i="${i}"><div class="hk-gutter${buttons ? ' has-btn' : ''}">${buttons}</div><div class="hk-text">${text}</div></div>`
  }

  // Merge syntax tokens and word-highlight ranges into escaped HTML spans.
  // For a changed line too long to render, start the visible window just
  // before its first difference from the paired line.
  windowStart(side, line, text, cls) {
    if (cls === 'ctx') return 0
    const other = this.model.pairedLine(side, line)
    if (other < 0) return 0
    const ot = this.lineText(side === 'old' ? 'new' : 'old', other)
    const lim = Math.min(text.length, ot.length)
    let p = 0
    while (p < lim && text.charCodeAt(p) === ot.charCodeAt(p)) p++
    return Math.max(0, Math.min(p - 200, text.length - RENDER_CAP))
  }

  codeHtml(side, line, cls) {
    let text = this.lineText(side, line)
    let head = ''
    let tail = ''
    let start = 0
    if (text.length > RENDER_CAP) {
      start = this.windowStart(side, line, text, cls)
      if (start > 0) head = `<span class="trunc">${start.toLocaleString()} characters … </span>`
      const rest = text.length - start - RENDER_CAP
      if (rest > 0) tail = `<span class="trunc"> … ${rest.toLocaleString()} more characters</span>`
      text = text.slice(start, start + RENDER_CAP)
    }
    if (this.missingNewline(side, line))
      tail += `<span class="no-nl-marker" title="No newline at end of file">${icon('no-entry', '', 'No newline at end of file')}</span>`
    const len = text.length
    const toks = len <= HIGHLIGHT_CAP && !start ? this.tokens[side].get(line) : null
    let inl = cls === 'ctx' ? null : this.inline[side].get(line)
    if (inl && start) inl = shiftRanges(inl, start, len)
    if (!toks && !inl) return head + esc(text) + tail

    let html = ''
    let pos = 0
    let ti = 0
    let tokEnd = toks && toks.length ? toks[0] : len
    let tokCls = toks && toks.length ? toks[1] : 0
    let ri = 0
    const nr = inl ? inl.length / 2 : 0
    while (pos < len) {
      while (toks && pos >= tokEnd && ti + 2 < toks.length) {
        ti += 2
        tokEnd += toks[ti]
        tokCls = toks[ti + 1]
      }
      if (toks && pos >= tokEnd) {
        tokEnd = len
        tokCls = 0
      }
      while (ri < nr && inl[ri * 2 + 1] <= pos) ri++
      const rs = ri < nr ? inl[ri * 2] : len
      const re = ri < nr ? inl[ri * 2 + 1] : len
      const inRange = ri < nr && rs <= pos
      let next = Math.min(tokEnd, len)
      if (inRange) next = Math.min(next, re)
      else next = Math.min(next, rs)
      if (next <= pos) next = pos + 1
      // word highlights go on the innermost span, as on github.com
      const stack = tokCls ? this.stacks.get(tokCls) : null
      let cls = stack ? stack.inner : ''
      if (inRange) cls += `${cls ? ' ' : ''}x${pos === rs ? ' x-first' : ''}${next === re ? ' x-last' : ''}`
      const seg = esc(text.slice(pos, next))
      const inner = cls ? `<span class="${cls}">${seg}</span>` : seg
      html += stack ? stack.open + inner + stack.close : inner
      pos = next
    }
    return head + html + tail
  }
}

// Ranges [s, e) moved into a window starting at `start` of length `len`.
function shiftRanges(ranges, start, len) {
  const out = []
  for (let i = 0; i < ranges.length; i += 2) {
    const s = Math.max(0, ranges[i] - start)
    const e = Math.min(len, ranges[i + 1] - start)
    if (e > s) out.push(s, e)
  }
  return out.length ? out : null
}
