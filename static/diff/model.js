// Turns a line-level edit script into the rows GitHub shows: hunks with three
// lines of context, hunk headers, collapsed gaps that can be expanded 20 lines
// at a time, and either unified or split (side-by-side) rows.

import { findFuncName, groupHunks, hunkHeader } from './hunks.js'

export const CONTEXT = 3
// GitHub merges hunks separated by a single unchanged line (git diff --inter-hunk-context=1).
export const INTER_HUNK = 1
export const EXPAND_STEP = 20

export const ROW_CTX = 0
export const ROW_DEL = 1
export const ROW_ADD = 2
export const ROW_HUNK = 3
export const ROW_CHG = 4
export const ROW_EXPANDER = 5

export class DiffModel {
  /**
   * @param {object} d
   * @param {Int32Array} d.changes flat [i1, n1, i2, n2, ...]
   * @param {string} d.oldText
   * @param {Int32Array} d.oldStarts
   * @param {string} d.newText
   * @param {Int32Array} d.newStarts
   * @param {RegExp} [d.funcDriver] git userdiff funcname pattern (python/ruby)
   */
  constructor(d) {
    Object.assign(this, d)
    this.n1 = d.oldStarts.length - 1
    this.n2 = d.newStarts.length - 1
    this.hunks = groupHunks(d.changes, this.n1, this.n2, CONTEXT, INTER_HUNK)
    this.funcCache = new Map()
    // gaps[h] is the unchanged region before hunk h; gaps[H] trails the last.
    this.gaps = []
    let o1 = 0
    let o2 = 0
    for (const h of this.hunks) {
      this.gaps.push({ o1, o2, len: h.s1 - o1, top: 0, bottom: 0 })
      o1 = h.e1
      o2 = h.e2
    }
    this.gaps.push({ o1, o2, len: this.n1 - o1, top: 0, bottom: 0 })
    let adds = 0
    let dels = 0
    for (let i = 0; i < d.changes.length; i += 4) {
      dels += d.changes[i + 1]
      adds += d.changes[i + 3]
    }
    this.additions = adds
    this.deletions = dels
  }

  get identical() {
    return this.changes.length === 0
  }

  hidden(g) {
    return Math.max(0, g.len - g.top - g.bottom)
  }

  /** Which expand buttons a gap shows: 'up', 'down', 'both' (two buttons) or 'all'. */
  expandKind(gi) {
    const g = this.gaps[gi]
    const hidden = this.hidden(g)
    if (hidden === 0) return null
    const trailing = gi === this.gaps.length - 1
    if (trailing) return 'down'
    if (gi === 0) return 'up'
    return hidden <= EXPAND_STEP ? 'all' : 'both'
  }

  expand(gi, dir) {
    const g = this.gaps[gi]
    const hidden = this.hidden(g)
    if (!hidden) return
    const trailing = gi === this.gaps.length - 1
    // the trailing gap only grows downwards, the first one only upwards
    if (trailing) dir = dir === 'all' ? 'all' : 'down'
    else if (gi === 0) dir = dir === 'all' ? 'all' : 'up'
    const step = dir === 'all' || (!trailing && gi > 0 && hidden <= EXPAND_STEP) ? hidden : Math.min(EXPAND_STEP, hidden)
    if (dir === 'up') g.bottom += step
    else g.top += step
  }

  expandAll() {
    // gap 0 always keeps its header above it, so it grows upwards
    this.gaps.forEach((g, i) => {
      if (i === 0) g.bottom = g.len - g.top
      else g.top = g.len - g.bottom
    })
  }

  get fullyExpanded() {
    return this.gaps.every((g) => this.hidden(g) === 0)
  }

  /**
   * Build typed row arrays.
   * kind: ROW_* ; a: old line (or gap index for headers/expanders);
   * b: new line (or header index); for headers `headers[b]` holds the range.
   */
  buildRows(split) {
    const cap = this.n1 + this.n2 + this.gaps.length * 2 + 8
    const kind = new Uint8Array(cap)
    const a = new Int32Array(cap)
    const b = new Int32Array(cap)
    const headers = []
    let n = 0
    const push = (k, x, y) => {
      kind[n] = k
      a[n] = x
      b[n] = y
      n++
    }
    const ctx = (o, nn) => push(ROW_CTX, o, nn)

    const H = this.hunks.length
    for (let h = 0; h <= H; h++) {
      const g = this.gaps[h]
      const delta = g.o2 - g.o1
      const trailing = h === H
      if (H === 0) {
        // identical files: show every line as context
        for (let o = 0; o < g.len; o++) ctx(o, o + delta)
        break
      }
      for (let k = 0; k < g.top && k < g.len; k++) ctx(g.o1 + k, g.o1 + k + delta)
      const hidden = this.hidden(g)
      if (trailing) {
        if (hidden > 0) push(ROW_EXPANDER, h, -1)
        break
      }
      if (hidden > 0 || h === 0) {
        headers.push({ row: n, s1: g.o1 + g.len - g.bottom, s2: g.o2 + g.len - g.bottom, gap: h })
        push(ROW_HUNK, h, headers.length - 1)
      }
      for (let k = g.len - g.bottom; k < g.len; k++) if (k >= g.top) ctx(g.o1 + k, g.o1 + k + delta)

      const hk = this.hunks[h]
      let o = hk.s1
      let nn = hk.s2
      for (let c = hk.c0; c < hk.c1; c++) {
        const i1 = this.changes[c * 4]
        const n1 = this.changes[c * 4 + 1]
        const i2 = this.changes[c * 4 + 2]
        const n2 = this.changes[c * 4 + 3]
        while (o < i1) ctx(o++, nn++)
        if (split) {
          const m = Math.max(n1, n2)
          for (let k = 0; k < m; k++) push(ROW_CHG, k < n1 ? i1 + k : -1, k < n2 ? i2 + k : -1)
        } else {
          for (let k = 0; k < n1; k++) push(ROW_DEL, i1 + k, -1)
          for (let k = 0; k < n2; k++) push(ROW_ADD, -1, i2 + k)
        }
        o = i1 + n1
        nn = i2 + n2
      }
      while (o < hk.e1) ctx(o++, nn++)
    }

    // Header line counts cover everything up to the next header/expander.
    for (let i = 0; i < headers.length; i++) {
      const hd = headers[i]
      const end = i + 1 < headers.length ? headers[i + 1].row : n
      let c1 = 0
      let c2 = 0
      for (let r = hd.row + 1; r < end; r++) {
        const k = kind[r]
        if (k === ROW_EXPANDER) break
        if (a[r] >= 0 && k !== ROW_ADD) c1++
        if (b[r] >= 0 && k !== ROW_DEL) c2++
      }
      hd.c1 = c1
      hd.c2 = c2
    }
    return { kind, a, b, count: n, headers }
  }

  /** The line paired with `line` in its change block (k-th with k-th), or -1. */
  pairedLine(side, line) {
    const c = this.changes
    let lo = 0
    let hi = c.length / 4 - 1
    const off = side === 'old' ? 0 : 2
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const start = c[mid * 4 + off]
      const count = c[mid * 4 + off + 1]
      if (line < start) hi = mid - 1
      else if (line >= start + count) lo = mid + 1
      else {
        const k = line - start
        const other = side === 'old' ? 2 : 0
        return k < c[mid * 4 + other + 1] ? c[mid * 4 + other] + k : -1
      }
    }
    return -1
  }

  headerText(hd) {
    const func = findFuncName(this.oldText, this.oldStarts, hd.s1, this.funcCache, this.funcDriver)
    return hunkHeader(hd.s1, hd.c1, hd.s2, hd.c2, func)
  }
}
