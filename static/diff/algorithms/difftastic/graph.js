// Port of difftastic's diff graph and shortest path search
// (src/diff/graph.rs, shortest_path.rs, stack.rs) including the radix heap
// (radix-heap 0.4.2) so that ties are broken exactly as difftastic does.

import {
  ATOM_COMMENT,
  CK_NOVEL,
  CK_REPLACED_COMMENT,
  CK_REPLACED_STRING,
  CK_UNCHANGED,
  insertDeepUnchanged,
  isStringKind,
  setChange,
} from './syntax.js'

export class ExceededGraphLimit extends Error {}

// Edge kinds
const E_UNCHANGED_NODE = 0
const E_ENTER_UNCHANGED_DELIM = 1
const E_REPLACED_COMMENT = 2
const E_REPLACED_STRING = 3
const E_NOVEL_ATOM_LHS = 4
const E_NOVEL_ATOM_RHS = 5
const E_ENTER_NOVEL_DELIM_LHS = 6
const E_ENTER_NOVEL_DELIM_RHS = 7

// ------------------------------------------------------------- stacks

// Persistent stacks: null (empty) or { val, next }.
const push = (stack, val) => ({ val, next: stack })

// EnteredDelimiter: { both: false, l: stack, r: stack } (PopEither) or
// { both: true, l: node, r: node } (PopBoth).

function stackEq(a, b, eqVal) {
  for (;;) {
    if (a === b) return true
    if (!a || !b) return false
    if (!eqVal(a.val, b.val)) return false
    a = a.next
    b = b.next
  }
}

const syntaxEq = (x, y) => x.contentId === y.contentId

function delimEq(x, y) {
  if (x.both !== y.both) return false
  if (x.both) return syntaxEq(x.l, y.l) && syntaxEq(x.r, y.r)
  return stackEq(x.l, y.l, syntaxEq) && stackEq(x.r, y.r, syntaxEq)
}

const parentsEq = (a, b) => stackEq(a, b, delimEq)
const canPopEither = (parents) => !!parents && !parents.val.both

function tryPopLhs(parents) {
  if (!parents || parents.val.both || !parents.val.l) return null
  const { l, r } = parents.val
  let rest = parents.next
  const newL = l.next
  if (newL || r) rest = push(rest, { both: false, l: newL, r })
  return [l.val, rest]
}

function tryPopRhs(parents) {
  if (!parents || parents.val.both || !parents.val.r) return null
  const { l, r } = parents.val
  let rest = parents.next
  const newR = r.next
  if (l || newR) rest = push(rest, { both: false, l, r: newR })
  return [r.val, rest]
}

function pushLhsDelimiter(parents, delim) {
  if (parents && !parents.val.both) return push(parents.next, { both: false, l: push(parents.val.l, delim), r: parents.val.r })
  return push(parents, { both: false, l: push(null, delim), r: null })
}

function pushRhsDelimiter(parents, delim) {
  if (parents && !parents.val.both) return push(parents.next, { both: false, l: parents.val.l, r: push(parents.val.r, delim) })
  return push(parents, { both: false, l: null, r: push(null, delim) })
}

// ------------------------------------------------------------- vertices

class Vertex {
  constructor(lhs, rhs, parents, lhsParentId, rhsParentId) {
    this.lhs = lhs
    this.rhs = rhs
    this.parents = parents
    this.lhsParentId = lhsParentId
    this.rhsParentId = rhsParentId
    this.neighbours = null
    this.pred = null
    this.predDist = 0
  }
  isEnd() {
    return !this.lhs && !this.rhs && !this.parents
  }
}

const parentIdOf = (node) => (node.parent ? node.parent.id : 0)

function popAllParents(lhs, rhs, lhsParentId, rhsParentId, parents) {
  for (;;) {
    if (!lhs) {
      const p = tryPopLhs(parents)
      if (p) {
        lhs = p[0].nextSibling
        lhsParentId = parentIdOf(p[0])
        parents = p[1]
        continue
      }
    }
    if (!rhs) {
      const p = tryPopRhs(parents)
      if (p) {
        rhs = p[0].nextSibling
        rhsParentId = parentIdOf(p[0])
        parents = p[1]
        continue
      }
    }
    if (!lhs && !rhs && parents && parents.val.both) {
      const { l, r } = parents.val
      lhs = l.nextSibling
      rhs = r.nextSibling
      lhsParentId = parentIdOf(l)
      rhsParentId = parentIdOf(r)
      parents = parents.next
      continue
    }
    break
  }
  return [lhs, rhs, lhsParentId, rhsParentId, parents]
}

// Normalized Levenshtein similarity over Unicode scalar values (strsim).
function normalizedLevenshtein(a, b) {
  const x = Array.from(a)
  const y = Array.from(b)
  if (!x.length && !y.length) return 1
  const n = y.length
  let prev = new Uint32Array(n + 1)
  let cur = new Uint32Array(n + 1)
  for (let j = 0; j <= n; j++) prev[j] = j
  for (let i = 1; i <= x.length; i++) {
    cur[0] = i
    const xi = x[i - 1]
    for (let j = 1; j <= n; j++) {
      const cost = xi === y[j - 1] ? 0 : 1
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
    }
    ;[prev, cur] = [cur, prev]
  }
  return 1 - prev[n] / Math.max(x.length, y.length)
}

function edgeCost(kind, arg) {
  switch (kind) {
    case E_UNCHANGED_NODE:
      // arg: depth difference, with +1000 when probably punctuation
      return 1 + Math.min(40, arg % 1000) + (arg >= 1000 ? 200 : 0)
    case E_ENTER_UNCHANGED_DELIM:
      return 10 + Math.min(40, arg)
    case E_REPLACED_COMMENT:
    case E_REPLACED_STRING:
      return 500 + (100 - arg)
    default:
      return 300
  }
}

const looksLikePunctuation = (n) => !n.isList && (n.content === ',' || n.content === ';' || n.content === '.')

/**
 * Run the graph search for one section, filling in change kinds.
 * @throws {ExceededGraphLimit}
 */
export function markSyntax(lhsStart, rhsStart, graphLimit) {
  // seen: key -> [vertex, vertex?] (at most two parent-stack variants)
  const seen = new Map()
  // Key components: an absent side is identified by its parent id.
  const keyOf = (lhs, rhs, lhsParentId, rhsParentId, parents) => {
    const l = lhs ? lhs.id : -1 - lhsParentId
    const r = rhs ? rhs.id : -1 - rhsParentId
    return `${l},${r},${canPopEither(parents) ? 1 : 0}`
  }
  let seenCount = 0
  const allocate = (lhs, rhs, parents, lhsParentId, rhsParentId) => {
    const key = keyOf(lhs, rhs, lhsParentId, rhsParentId, parents)
    const existing = seen.get(key)
    if (existing) {
      if (existing.length >= 2) return existing[existing.length - 1]
      for (const v of existing) if (parentsEq(v.parents, parents)) return v
      const v = new Vertex(lhs, rhs, parents, lhsParentId, rhsParentId)
      existing.push(v)
      return v
    }
    const v = new Vertex(lhs, rhs, parents, lhsParentId, rhsParentId)
    seen.set(key, [v])
    seenCount++
    return v
  }

  const neighbours = (v) => {
    const out = []
    const add = (kind, arg, next) => out.push(kind, arg, next)
    const L = v.lhs
    const R = v.rhs
    if (L && R) {
      if (L.contentId === R.contentId) {
        const depth = Math.abs(L.numAncestors - R.numAncestors)
        const punct = looksLikePunctuation(L)
        const [l, r, lp, rp, ps] = popAllParents(L.nextSibling, R.nextSibling, v.lhsParentId, v.rhsParentId, v.parents)
        add(E_UNCHANGED_NODE, depth + (punct ? 1000 : 0), allocate(l, r, ps, lp, rp))
      }
      if (L.isList && R.isList && L.openContent === R.openContent && L.closeContent === R.closeContent) {
        const parentsNext = push(v.parents, { both: true, l: L, r: R })
        const depth = Math.abs(L.numAncestors - R.numAncestors)
        const [l, r, lp, rp, ps] = popAllParents(L.children[0] || null, R.children[0] || null, L.id, R.id, parentsNext)
        add(E_ENTER_UNCHANGED_DELIM, depth, allocate(l, r, ps, lp, rp))
      }
      if (!L.isList && !R.isList) {
        const lk = L.kind
        const rk = R.kind
        const okL = lk === ATOM_COMMENT || isStringKind(lk)
        const okR = rk === ATOM_COMMENT || isStringKind(rk)
        if (okL && okR && lk === rk && L.content !== R.content) {
          const pct = Math.round(normalizedLevenshtein(L.content, R.content) * 100)
          const kind = lk === ATOM_COMMENT ? E_REPLACED_COMMENT : E_REPLACED_STRING
          const [l, r, lp, rp, ps] = popAllParents(L.nextSibling, R.nextSibling, v.lhsParentId, v.rhsParentId, v.parents)
          add(kind, pct, allocate(l, r, ps, lp, rp))
        }
      }
    }
    if (L) {
      if (!L.isList) {
        const [l, r, lp, rp, ps] = popAllParents(L.nextSibling, R, v.lhsParentId, v.rhsParentId, v.parents)
        add(E_NOVEL_ATOM_LHS, 0, allocate(l, r, ps, lp, rp))
      } else {
        const parentsNext = pushLhsDelimiter(v.parents, L)
        const [l, r, lp, rp, ps] = popAllParents(L.children[0] || null, R, L.id, v.rhsParentId, parentsNext)
        add(E_ENTER_NOVEL_DELIM_LHS, 0, allocate(l, r, ps, lp, rp))
      }
    }
    if (R) {
      if (!R.isList) {
        const [l, r, lp, rp, ps] = popAllParents(L, R.nextSibling, v.lhsParentId, v.rhsParentId, v.parents)
        add(E_NOVEL_ATOM_RHS, 0, allocate(l, r, ps, lp, rp))
      } else {
        const parentsNext = pushRhsDelimiter(v.parents, R)
        const [l, r, lp, rp, ps] = popAllParents(L, R.children[0] || null, v.lhsParentId, R.id, parentsNext)
        add(E_ENTER_NOVEL_DELIM_RHS, 0, allocate(l, r, ps, lp, rp))
      }
    }
    if (!out.length) throw new Error('Must always find some next steps if node is not the end')
    return out
  }

  // Dijkstra with a radix heap keyed on distance.
  const heap = new RadixHeap()
  const start = new Vertex(lhsStart, rhsStart, null, 0, 0)
  heap.push(0, start)
  let end = null
  for (;;) {
    if (!heap.pop()) throw new Error('Ran out of graph nodes before reaching end')
    const distance = heap.lastKey
    const current = heap.lastValue
    if (current.isEnd()) {
      end = current
      break
    }
    if (!current.neighbours) current.neighbours = neighbours(current)
    const nb = current.neighbours
    for (let i = 0; i < nb.length; i += 3) {
      const next = nb[i + 2]
      const d = distance + edgeCost(nb[i], nb[i + 1])
      if (!next.pred || d < next.predDist) {
        next.pred = current
        next.predDist = d
        heap.push(d, next)
      }
    }
    if (seenCount > graphLimit) throw new ExceededGraphLimit()
  }

  // route of vertices from start to end
  const route = []
  for (let v = end; v; v = v.pred === v ? null : v.pred) {
    route.push(v)
    if (v === start) break
  }
  route.reverse()

  // edges between consecutive vertices: the cheapest edge leading there
  const vertexEq = (a, b) => {
    const b0 = a.lhs && b.lhs ? a.lhs.id === b.lhs.id : !a.lhs && !b.lhs ? a.lhsParentId === b.lhsParentId : false
    const b1 = a.rhs && b.rhs ? a.rhs.id === b.rhs.id : !a.rhs && !b.rhs ? a.rhsParentId === b.rhsParentId : false
    return b0 && b1 && canPopEither(a.parents) === canPopEither(b.parents)
  }
  for (let k = 0; k + 1 < route.length; k++) {
    const from = route[k]
    const to = route[k + 1]
    let best = -1
    let bestCost = Infinity
    const nb = from.neighbours
    for (let i = 0; i < nb.length; i += 3) {
      if (!vertexEq(nb[i + 2], to)) continue
      const c = edgeCost(nb[i], nb[i + 1])
      if (best < 0 || c < bestCost) {
        best = i
        bestCost = c
      }
    }
    if (best < 0) throw new Error('Expected a route between two vertices')
    populate(nb[best], nb[best + 1], from)
  }
}

function populate(kind, arg, v) {
  const lhs = v.lhs
  const rhs = v.rhs
  switch (kind) {
    case E_UNCHANGED_NODE:
      insertDeepUnchanged(lhs, rhs)
      insertDeepUnchanged(rhs, lhs)
      break
    case E_ENTER_UNCHANGED_DELIM:
      setChange(lhs, CK_UNCHANGED, rhs)
      setChange(rhs, CK_UNCHANGED, lhs)
      break
    case E_REPLACED_COMMENT:
    case E_REPLACED_STRING: {
      const ck = kind === E_REPLACED_COMMENT ? CK_REPLACED_COMMENT : CK_REPLACED_STRING
      if (arg > 20) {
        setChange(lhs, ck, rhs)
        setChange(rhs, ck, lhs)
      } else {
        setChange(lhs, CK_NOVEL)
        setChange(rhs, CK_NOVEL)
      }
      break
    }
    case E_NOVEL_ATOM_LHS:
    case E_ENTER_NOVEL_DELIM_LHS:
      setChange(lhs, CK_NOVEL)
      break
    default:
      setChange(rhs, CK_NOVEL)
  }
}

// ------------------------------------------------------------- radix heap

// radix-heap 0.4.2 with Reverse<u32> keys: pops the smallest distance;
// equal keys pop LIFO from bucket 0, buckets are refilled in insertion order.
class RadixHeap {
  constructor() {
    this.top = -1
    this.keys = Array.from({ length: 33 }, () => [])
    this.vals = Array.from({ length: 33 }, () => [])
    this.initKeys = []
    this.initVals = []
    this.lastKey = 0
    this.lastValue = null
  }
  push(key, value) {
    if (this.top < 0) {
      this.initKeys.push(key)
      this.initVals.push(value)
      return
    }
    const b = key === this.top ? 0 : 32 - Math.clz32(key ^ this.top)
    this.keys[b].push(key)
    this.vals[b].push(value)
  }
  constrain() {
    let srcK
    let srcV
    if (this.top >= 0) {
      let index = -1
      for (let i = 0; i <= 32; i++) {
        if (this.keys[i].length) {
          index = i
          break
        }
      }
      if (index <= 0) return
      srcK = this.keys[index]
      srcV = this.vals[index]
      this.keys[index] = []
      this.vals[index] = []
    } else if (this.initKeys.length) {
      srcK = this.initKeys
      srcV = this.initVals
      this.initKeys = []
      this.initVals = []
    } else return
    let top = srcK[0]
    for (const k of srcK) if (k < top) top = k
    this.top = top
    for (let i = 0; i < srcK.length; i++) {
      const k = srcK[i]
      const b = k === top ? 0 : 32 - Math.clz32(k ^ top)
      this.keys[b].push(k)
      this.vals[b].push(srcV[i])
    }
  }
  pop() {
    let constrained = false
    for (;;) {
      if (this.keys[0].length) {
        this.lastKey = this.keys[0].pop()
        this.lastValue = this.vals[0].pop()
        return true
      }
      if (constrained) return false
      constrained = true
      this.constrain()
    }
  }
}
