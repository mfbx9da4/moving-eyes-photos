// Port of difftastic's syntax tree model (src/parse/syntax.rs, words.rs,
// lines.rs and the line-numbers crate). Columns are UTF-16 code units here
// (difftastic uses UTF-8 bytes); everything stays internally consistent.

import { lcsSlice } from './imara.js'

export const ATOM_NORMAL = 0
export const ATOM_STRING = 1 // AtomKind::String(StringKind::StringLiteral)
export const ATOM_TEXT = 2 // AtomKind::String(StringKind::Text)
export const ATOM_TYPE = 3
export const ATOM_KEYWORD = 4
export const ATOM_COMMENT = 5
export const ATOM_ERROR = 6
export const ATOM_CAN_IGNORE = 7

export const isStringKind = (k) => k === ATOM_STRING || k === ATOM_TEXT

// ChangeKind
export const CK_UNCHANGED = 1
export const CK_IGNORED = 2
export const CK_REPLACED_COMMENT = 3
export const CK_REPLACED_STRING = 4
export const CK_NOVEL = 5

// MatchKind
export const MK_UNCHANGED = 0
export const MK_NOVEL = 1
export const MK_UNCHANGED_PART = 2
export const MK_NOVEL_WORD = 3
export const MK_IGNORED = 4
export const isNovelMatch = (k) => k === MK_NOVEL || k === MK_UNCHANGED_PART || k === MK_NOVEL_WORD

function baseInfo() {
  return {
    prevSibling: null,
    nextSibling: null,
    prev: null,
    parent: null,
    numAncestors: 0,
    id: 0,
    contentId: 0,
    uniqueToSide: false,
    ck: 0,
    opp: null,
  }
}

export function newList(openContent, openPosition, children, closeContent, closePosition) {
  children = children.filter((n) => n.isList || n.content !== '')
  if (children.length === 1 && openContent === '' && closeContent === '') return children[0]
  let numDescendants = 0
  for (const c of children) numDescendants += c.isList ? c.numDescendants + 1 : 1
  return {
    isList: true,
    openContent,
    openPosition,
    children,
    closeContent,
    closePosition,
    numDescendants,
    ...baseInfo(),
  }
}

export function newAtom(position, content, kind) {
  if (content.endsWith('\r')) content = content.slice(0, -1)
  if (content.endsWith('\n')) {
    position = position.slice(0, -1)
    content = content.slice(0, -1)
  }
  return { isList: false, position, content, kind, ...baseInfo() }
}

// ------------------------------------------------------------- init info

export function initAllInfo(lhs, rhs) {
  const next = { id: 1 }
  initInfoOnSide(lhs, next)
  initInfoOnSide(rhs, next)
  const existing = new Map()
  setContentId(lhs, existing)
  setContentId(rhs, existing)
  setContentIsUnique(lhs)
  setContentIsUnique(rhs)
  initNextPrev(lhs)
  initNextPrev(rhs)
}

function initInfoOnSide(roots, next) {
  const walk = (nodes, parent, depth) => {
    for (const n of nodes) {
      n.parent = parent
      n.numAncestors = depth
      n.id = next.id++
      if (n.isList) walk(n.children, n, depth + 1)
    }
  }
  walk(roots, null, 0)
}

function splitOnNewlines(s) {
  return s.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l))
}

function setContentId(nodes, existing) {
  for (const node of nodes) {
    let key
    if (node.isList) {
      setContentId(node.children, existing)
      const ids = []
      for (const c of node.children) if (c.isList || c.kind !== ATOM_CAN_IGNORE) ids.push(c.contentId)
      key = `L\u0000${node.openContent}\u0000${node.closeContent}\u0000${ids.join(',')}`
    } else {
      const isComment = node.kind === ATOM_COMMENT
      let clean = node.content
      if (isComment) {
        const lines = splitOnNewlines(node.content)
        if (lines.length > 1) clean = lines.map((l) => l.replace(/^\s+/, '')).join('\n')
      }
      key = `A${isComment ? 1 : 0}\u0000${clean}`
    }
    let id = existing.get(key)
    if (id === undefined) {
      id = existing.size + 1
      existing.set(key, id)
    }
    node.contentId = id
  }
}

function setContentIsUnique(nodes) {
  const counts = new Map()
  const count = (ns) => {
    for (const n of ns) {
      counts.set(n.contentId, (counts.get(n.contentId) || 0) + 1)
      if (n.isList) count(n.children)
    }
  }
  count(nodes)
  const set = (ns) => {
    for (const n of ns) {
      n.uniqueToSide = counts.get(n.contentId) === 1
      if (n.isList) set(n.children)
    }
  }
  set(nodes)
}

export function initNextPrev(roots) {
  const siblings = (nodes) => {
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]
      n.prevSibling = i > 0 ? nodes[i - 1] : null
      n.nextSibling = i + 1 < nodes.length ? nodes[i + 1] : null
      if (n.isList) siblings(n.children)
    }
  }
  siblings(roots)
  const prevs = (nodes, parent) => {
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]
      n.prev = i === 0 ? parent : nodes[i - 1]
      if (n.isList) prevs(n.children, n)
    }
  }
  prevs(roots, null)
}

// ------------------------------------------------------------- words

const isWordChar = (c) => /[\p{Alphabetic}\p{Nd}\p{Nl}\p{No}_]/u.test(c)
const isAsciiDigit = (c) => c >= '0' && c <= '9'

/** words.rs split_words_and_numbers ("foo..bar23" -> foo . . bar 23). */
export function splitWordsAndNumbers(s) {
  const words = []
  let start = -1
  let startDigit = false
  let i = 0
  for (const c of s) {
    const len = c.length
    if (start >= 0) {
      if (isWordChar(c)) {
        if (isAsciiDigit(c) !== startDigit) {
          words.push(s.slice(start, i))
          start = i
          startDigit = isAsciiDigit(c)
        }
      } else {
        words.push(s.slice(start, i))
        words.push(c)
        start = -1
      }
    } else if (isWordChar(c)) {
      start = i
      startDigit = isAsciiDigit(c)
    } else {
      words.push(c)
    }
    i += len
  }
  if (start >= 0) words.push(s.slice(start))
  return words
}

/** words.rs split_words_up_to; null when there are more than `limit` items. */
export function splitWordsUpTo(s, limit) {
  const words = []
  let start = -1
  let i = 0
  for (const c of s) {
    const len = c.length
    if (start >= 0) {
      if (!isWordChar(c)) {
        words.push(s.slice(start, i))
        words.push(c)
        start = -1
      }
    } else if (isWordChar(c)) start = i
    else words.push(c)
    if (words.length > limit) return null
    i += len
  }
  if (start >= 0) words.push(s.slice(start))
  if (words.length > limit) return null
  return words
}

export const isAllWhitespace = (s) => /^\s*$/u.test(s)

// ------------------------------------------------------------- positions

/** The line-numbers crate's LinePositions. */
export class LinePositions {
  constructor(s) {
    const starts = [0]
    for (let i = s.indexOf('\n'); i !== -1; i = s.indexOf('\n', i + 1)) starts.push(i + 1)
    this.starts = starts
    this.len = s.length
  }
  lineStart(i) {
    return this.starts[i]
  }
  // index of the newline ending line i (or the string end)
  lineEnd(i) {
    return i + 1 < this.starts.length ? this.starts[i + 1] - 1 : this.len
  }
  fromOffset(offset) {
    let lo = 0
    let hi = this.starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (this.starts[mid] <= offset) lo = mid
      else hi = mid - 1
    }
    return lo
  }
  fromRegion(start, end) {
    const first = this.fromOffset(start)
    const last = this.fromOffset(end)
    const res = []
    for (let idx = first; idx <= last; idx++) {
      const ls = this.lineStart(idx)
      const le = this.lineEnd(idx)
      res.push({ line: idx, start: Math.max(0, start - ls), end: (end < le ? end : le) - ls })
    }
    return res
  }
  fromRegionRelativeTo(base, start, end) {
    return this.fromRegion(start, end).map((p) =>
      p.line === 0
        ? { line: p.line + base.line, start: p.start + base.start, end: p.end + base.start }
        : { line: p.line + base.line, start: p.start, end: p.end },
    )
  }
}

// MatchedPos: { kind, pos, selfPos, oppPos }

function hasCommonWords(ops, parts) {
  let novel = 0
  let unchanged = 0
  for (const [t, i] of ops) {
    if (t === 0) {
      if (parts[i] !== ' ') unchanged++
    } else novel++
  }
  return unchanged > 2 && unchanged * 2 >= novel
}

function splitAtomWords(content, pos, oppContent, oppPos) {
  const parts = splitWordsAndNumbers(content)
  const other = splitWordsAndNumbers(oppContent)
  const ops = lcsSlice(parts, other)
  if (!hasCommonWords(ops, parts)) return pos.map((p) => ({ kind: MK_NOVEL, pos: p }))
  const lp = new LinePositions(content)
  const olp = new LinePositions(oppContent)
  let offset = 0
  let oppOffset = 0
  const mps = []
  for (const [t, i, j] of ops) {
    if (t === 1) {
      const word = parts[i]
      if (!isAllWhitespace(word)) mps.push({ kind: MK_NOVEL_WORD, pos: lp.fromRegionRelativeTo(pos[0], offset, offset + word.length)[0] })
      offset += word.length
    } else if (t === 0) {
      const word = parts[i]
      const oword = other[j]
      const wordPos = lp.fromRegionRelativeTo(pos[0], offset, offset + word.length)[0]
      const oppWordPos = olp.fromRegionRelativeTo(oppPos[0], oppOffset, oppOffset + oword.length)
      mps.push({ kind: MK_UNCHANGED_PART, pos: wordPos, selfPos: wordPos, oppPos: oppWordPos })
      offset += word.length
      oppOffset += oword.length
    } else {
      oppOffset += other[j].length
    }
  }
  return mps
}

function filterEmptyEnds(spans) {
  const out = []
  for (let i = 0; i < spans.length; i++) {
    const s = spans[i]
    if ((i === 0 || i === spans.length - 1) && s.start === s.end) continue
    out.push(s)
  }
  return out
}

function matchedPositions(node, pos, isClose) {
  pos = filterEmptyEnds(pos)
  const ck = node.ck
  if (ck === CK_REPLACED_COMMENT || ck === CK_REPLACED_STRING) {
    return splitAtomWords(node.content, pos, node.opp.content, node.opp.position)
  }
  if (ck === CK_UNCHANGED) {
    const opp = node.opp
    const oppPos = opp.isList ? (isClose ? opp.closePosition : opp.openPosition) : opp.position
    const mps = []
    for (const p of pos) {
      mps.push({ kind: MK_UNCHANGED, pos: p, selfPos: pos, oppPos })
      if (mps.length === oppPos.length) break
    }
    return mps
  }
  if (ck === CK_NOVEL) {
    const mps = []
    for (const p of pos) {
      if (pos.length === 1 && p.start === p.end) continue
      mps.push({ kind: MK_NOVEL, pos: p })
    }
    return mps
  }
  return []
}

/** syntax.rs change_positions: every changed/unchanged token position. */
export function changePositions(nodes) {
  const out = []
  let seenUnchanged = false
  const walk = (ns) => {
    for (const n of ns) {
      if (!n.ck) throw new Error('Should have changes set in all nodes')
      if (n.ck === CK_UNCHANGED) seenUnchanged = true
      if (n.isList) {
        for (const m of matchedPositions(n, n.openPosition, false)) out.push(m)
        walk(n.children)
        for (const m of matchedPositions(n, n.closePosition, true)) out.push(m)
      } else {
        for (const m of matchedPositions(n, n.position, false)) out.push(m)
      }
    }
  }
  walk(nodes)
  if (!seenUnchanged) {
    const p = { line: 0, start: 0, end: 0 }
    out.unshift({ kind: MK_UNCHANGED, pos: p, selfPos: [p], oppPos: [p] })
  }
  return out
}

// ------------------------------------------------------------- change map

export function insertDeepUnchanged(node, opp) {
  node.ck = CK_UNCHANGED
  node.opp = opp
  if (node.isList && opp.isList) {
    const a = node.children
    const b = opp.children
    const n = Math.min(a.length, b.length)
    for (let i = 0; i < n; i++) insertDeepUnchanged(a[i], b[i])
    if (a.length > b.length && a.length) {
      a[a.length - 1].ck = CK_IGNORED
      a[a.length - 1].opp = null
    }
    if (b.length > a.length && b.length) {
      b[b.length - 1].ck = CK_IGNORED
      b[b.length - 1].opp = null
    }
  }
}

export function insertDeepNovel(node) {
  node.ck = CK_NOVEL
  node.opp = null
  if (node.isList) for (const c of node.children) insertDeepNovel(c)
}

export function setChange(node, ck, opp = null) {
  node.ck = ck
  node.opp = opp
}
