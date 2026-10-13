// Port of difftastic's src/diff/unchanged.rs: mark obviously unchanged
// nodes and split the rest into sections for the graph search.

import { lcsSlice } from './imara.js'
import { CK_UNCHANGED, insertDeepUnchanged, setChange } from './syntax.js'

const TINY_TREE_THRESHOLD = 10
const MOSTLY_UNCHANGED_MIN_COMMON_CHILDREN = 4

const US_UNCHANGED_DELIMITER = 0
const US_UNCHANGED_NODE = 1
const US_POSSIBLY_CHANGED = 2

export function markUnchanged(lhsNodes, rhsNodes) {
  const [, l, r] = shrinkUnchangedAtEnds(lhsNodes, rhsNodes)
  const out = []
  for (const [ls, rs] of splitMostlyUnchangedToplevel(l, r)) {
    const [, l2, r2] = shrinkUnchangedAtEnds(ls, rs)
    for (const s of splitUnchanged(l2, r2)) out.push(s)
  }
  return out
}

function splitUnchanged(lhsNodes, rhsNodes) {
  const res = []
  for (const [cs, ls, rs] of splitUnchangedToplevel(lhsNodes, rhsNodes, TINY_TREE_THRESHOLD)) {
    if (cs === US_UNCHANGED_DELIMITER) {
      for (let i = 0; i < ls.length; i++) {
        setChange(ls[i], CK_UNCHANGED, rs[i])
        setChange(rs[i], CK_UNCHANGED, ls[i])
      }
    } else if (cs === US_UNCHANGED_NODE) {
      for (let i = 0; i < ls.length; i++) {
        insertDeepUnchanged(ls[i], rs[i])
        insertDeepUnchanged(rs[i], ls[i])
      }
    } else res.push([ls, rs])
  }
  return res
}

function asSingletonListChildren(ls, rs) {
  if (ls.length === 1 && rs.length === 1 && ls[0].isList && rs[0].isList) {
    if (ls[0].openContent === rs[0].openContent && ls[0].closeContent === rs[0].closeContent) return [ls[0].children, rs[0].children]
  }
  return null
}

function splitChangedSingletonList(ls, rs, threshold) {
  const children = asSingletonListChildren(ls, rs)
  if (children) {
    const split = splitUnchangedToplevel(children[0], children[1], threshold)
    if (split.length > 1) return [[US_UNCHANGED_DELIMITER, ls.slice(), rs.slice()], ...split]
    return [[US_POSSIBLY_CHANGED, ls.slice(), rs.slice()]]
  }
  return [[US_POSSIBLY_CHANGED, ls.slice(), rs.slice()]]
}

function findUniqueContentIds(node, set) {
  if (node.uniqueToSide) set.add(node.contentId)
  if (node.isList) for (const c of node.children) findUniqueContentIds(c, set)
}

function countUniqueSubtrees(node, opposite) {
  if (node.uniqueToSide && opposite.has(node.contentId)) return 1
  if (node.isList) {
    let s = 0
    for (const c of node.children) s += countUniqueSubtrees(c, opposite)
    return s
  }
  return 0
}

function isMostlyUnchangedList(lhs, rhs) {
  if (!lhs.isList || !rhs.isList) return false
  const ids = new Set()
  findUniqueContentIds(rhs, ids)
  return countUniqueSubtrees(lhs, ids) >= MOSTLY_UNCHANGED_MIN_COMMON_CHILDREN
}

function splitMostlyUnchangedToplevel(lhsNodes, rhsNodes) {
  let l0 = 0
  let l1 = lhsNodes.length
  let r0 = 0
  let r1 = rhsNodes.length
  const leading = []
  while (l0 < l1 && r0 < r1 && isMostlyUnchangedList(lhsNodes[l0], rhsNodes[r0])) {
    leading.push([[lhsNodes[l0]], [rhsNodes[r0]]])
    l0++
    r0++
  }
  const trailing = []
  while (l0 < l1 && r0 < r1 && isMostlyUnchangedList(lhsNodes[l1 - 1], rhsNodes[r1 - 1])) {
    trailing.push([[lhsNodes[l1 - 1]], [rhsNodes[r1 - 1]]])
    l1--
    r1--
  }
  const res = leading
  if (l0 < l1 || r0 < r1) res.push([lhsNodes.slice(l0, l1), rhsNodes.slice(r0, r1)])
  for (let i = trailing.length - 1; i >= 0; i--) res.push(trailing[i])
  return res
}

function splitUnchangedToplevel(lhsNodes, rhsNodes, threshold) {
  const res = []
  let lc = []
  let rc = []
  const flush = () => {
    if (lc.length || rc.length) {
      for (const s of splitChangedSingletonList(lc, rc, threshold)) res.push(s)
      lc = []
      rc = []
    }
  }
  for (const [t, i, j] of lcsSlice(lhsNodes, rhsNodes, (n) => n.contentId)) {
    if (t === 0) {
      const ln = lhsNodes[i]
      const rn = rhsNodes[j]
      const tiny = ln.isList ? ln.numDescendants < threshold : true
      if (tiny) {
        lc.push(ln)
        rc.push(rn)
      } else {
        flush()
        res.push([US_UNCHANGED_NODE, [ln], [rn]])
      }
    } else if (t === 1) lc.push(lhsNodes[i])
    else rc.push(rhsNodes[j])
  }
  flush()
  return res
}

function shrinkUnchangedDelimiters(ls, rs) {
  if (ls.length === 1 && rs.length === 1 && ls[0].isList && rs[0].isList) {
    if (ls[0].openContent === rs[0].openContent && ls[0].closeContent === rs[0].closeContent) {
      const [changedLater, l, r] = shrinkUnchangedAtEnds(ls[0].children, rs[0].children)
      if (changedLater) {
        setChange(ls[0], CK_UNCHANGED, rs[0])
        setChange(rs[0], CK_UNCHANGED, ls[0])
        return [true, l, r]
      }
    }
  }
  return [false, ls.slice(), rs.slice()]
}

function shrinkUnchangedAtEnds(lhsNodes, rhsNodes) {
  let l0 = 0
  let l1 = lhsNodes.length
  let r0 = 0
  let r1 = rhsNodes.length
  let changed = false
  while (l0 < l1 && r0 < r1 && lhsNodes[l0].contentId === rhsNodes[r0].contentId) {
    insertDeepUnchanged(lhsNodes[l0], rhsNodes[r0])
    insertDeepUnchanged(rhsNodes[r0], lhsNodes[l0])
    changed = true
    l0++
    r0++
  }
  while (l0 < l1 && r0 < r1 && lhsNodes[l1 - 1].contentId === rhsNodes[r1 - 1].contentId) {
    insertDeepUnchanged(lhsNodes[l1 - 1], rhsNodes[r1 - 1])
    insertDeepUnchanged(rhsNodes[r1 - 1], lhsNodes[l1 - 1])
    changed = true
    l1--
    r1--
  }
  const ls = lhsNodes.slice(l0, l1)
  const rs = rhsNodes.slice(r0, r1)
  if (ls.length === 1 && rs.length === 1) {
    const [changedLater, l, r] = shrinkUnchangedDelimiters(ls, rs)
    return [changed || changedLater, l, r]
  }
  return [changed, ls, rs]
}
