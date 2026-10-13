// Port of imara-diff 0.2.0 (https://github.com/pascalkuthe/imara-diff), the
// linear diff difftastic uses: `Diff::compute(Algorithm::Histogram, ..)`
// followed by `postprocess_no_heuristic`. Quirks of the original are kept on
// purpose so results match difftastic.

const MAX_CHAIN_LEN = 63

function isqrt(val) {
  // imara's util::sqrt: 1 << (bit_length(val) / 2)
  let bits = 0
  while (val > 0) {
    bits++
    val = Math.floor(val / 2)
  }
  return 2 ** Math.floor(bits / 2)
}

// ------------------------------------------------------------------ myers

const HEUR_MIN_COST = 256
const MAX_COST_MIN = 256
const SNAKE_CNT = 20
const K_HEUR = 4
const I32_MAX = 2147483647
const I32_MIN = -2147483648

// A view on a preprocessed file: tokens[start, end) with original indices.
class FileSlice {
  constructor(tokens, indices, changed, start, end) {
    this.tokens = tokens
    this.indices = indices
    this.changed = changed
    this.start = start
    this.end = end
  }
  get len() {
    return this.end - this.start
  }
  tok(i) {
    return this.tokens[this.start + i]
  }
  slice(s, e) {
    return new FileSlice(this.tokens, this.indices, this.changed, this.start + s, this.start + (e === undefined ? this.len : e))
  }
  markChanged() {
    for (let i = this.start; i < this.end; i++) this.changed[this.indices[i]] = true
  }
}

function commonPrefixFS(a, as, ae, b, bs, be) {
  let off = 0
  while (as + off < ae && bs + off < be && a.tokens[as + off] === b.tokens[bs + off]) off++
  return off
}

function commonPostfixFS(a, as, ae, b, bs, be) {
  let off = 0
  while (ae - 1 - off >= as && be - 1 - off >= bs && a.tokens[ae - 1 - off] === b.tokens[be - 1 - off]) off++
  return off
}

class MiddleSnakeSearch {
  constructor(back, kvec, base, file1, file2) {
    this.back = back
    this.kvec = kvec
    this.base = base
    this.dmin = -file2.len
    this.dmax = file1.len
    const kmid = back ? this.dmin + this.dmax : 0
    this.kmin = kmid
    this.kmax = kmid
    this.write(kmid, back ? file1.len : 0)
  }
  contains(k) {
    return k >= this.kmin && k <= this.kmax
  }
  write(k, x) {
    this.kvec[this.base + k] = x
  }
  x(k) {
    return this.kvec[this.base + k]
  }
  nextD() {
    const init = this.back ? I32_MAX : I32_MIN
    if (this.kmin > this.dmin) {
      this.kmin -= 1
      this.write(this.kmin - 1, init)
    } else this.kmin += 1
    if (this.kmax < this.dmax) {
      this.kmax += 1
      this.write(this.kmax + 1, init)
    } else this.kmax -= 1
  }
  // returns null, 'snake', or {i1, i2}
  run(file1, file2, f) {
    let res = null
    for (let k = this.kmax; k >= this.kmin; k -= 2) {
      let i1
      if (this.back) i1 = this.x(k - 1) < this.x(k + 1) ? this.x(k - 1) : this.x(k + 1) - 1
      else i1 = this.x(k - 1) >= this.x(k + 1) ? this.x(k - 1) + 1 : this.x(k + 1)
      let i2 = i1 - k
      let off = 0
      if (this.back) {
        if (i1 > 0 && i2 > 0) off = commonPostfixFS(file1, file1.start, file1.start + i1, file2, file2.start, file2.start + i2)
      } else if (i1 < file1.len && i2 < file2.len) {
        off = commonPrefixFS(file1, file1.start + i1, file1.end, file2, file2.start + i2, file2.end)
      }
      if (off > SNAKE_CNT) res = 'snake'
      if (this.back) {
        i1 -= off
        i2 -= off
      } else {
        i1 += off
        i2 += off
      }
      this.write(k, i1)
      if (f(k, i1)) return { i1, i2 }
    }
    return res
  }
  bestPosition(file1, file2) {
    let bestDistance = this.back ? Infinity : -1
    let bestI1 = this.back ? I32_MAX : -1
    for (let k = this.kmax; k >= this.kmin; k -= 2) {
      let i1 = this.x(k)
      if (this.back) i1 = Math.max(i1, 0)
      else i1 = Math.min(i1, file1.len)
      let i2 = i1 - k
      if (this.back) {
        if (i2 < 0) {
          i1 = k
          i2 = 0
        }
      } else if (i2 > file2.len) {
        i1 = file2.len + k
        i2 = file2.len
      }
      const distance = i1 + i2
      if ((this.back && distance < bestDistance) || (!this.back && distance > bestDistance)) {
        bestDistance = distance
        bestI1 = i1
      }
    }
    return [bestDistance, bestI1]
  }
  foundSnake(ec, file1, file2) {
    let bestScore = 0
    let b1 = 0
    let b2 = 0
    for (let k = this.kmax; k >= this.kmin; k -= 2) {
      const i1 = this.x(k)
      const i2 = i1 - k
      if (this.back) {
        if (!(i1 >= 0 && i1 < file1.len - SNAKE_CNT)) continue
        if (!(i2 >= 0 && i2 < file2.len - SNAKE_CNT)) continue
      } else {
        if (!(i1 >= SNAKE_CNT && i1 < file1.len)) continue
        if (!(i2 >= SNAKE_CNT && i2 < file2.len)) continue
      }
      const mainDiagonalDistance = Math.abs(k)
      const distance = this.back ? file1.len - i1 + (file2.len - i2) : i1 + i2
      const score = distance + mainDiagonalDistance
      if (score > K_HEUR * ec && score > bestScore) {
        let isSnake = true
        // Rust's `a[..i1].zip(b[..i2]).rev()` pairs equal indices, counting
        // down from min(i1, i2) (not the ends of both prefixes).
        const m = Math.min(i1, i2)
        for (let t = 0; t < SNAKE_CNT; t++) {
          const a = this.back ? file1.tok(i1 + t) : file1.tok(m - 1 - t)
          const b = this.back ? file2.tok(i2 + t) : file2.tok(m - 1 - t)
          if (a !== b) {
            isSnake = false
            break
          }
        }
        if (isSnake) {
          b1 = i1
          b2 = i2
          bestScore = score
        }
      }
    }
    return bestScore > 0 ? [b1, b2] : null
  }
}

function myersSplit(st, file1, file2, needMin) {
  const fwd = new MiddleSnakeSearch(false, st.kvec, st.kforward, file1, file2)
  const bwd = new MiddleSnakeSearch(true, st.kvec, st.kbackward, file1, file2)
  // imara-diff computes this as (file2.len - file2.len) & 1, i.e. always false
  const isOdd = false
  let ec = 0
  while (ec <= st.maxCost) {
    let foundSnake = false
    fwd.nextD()
    if (isOdd) {
      const res = fwd.run(file1, file2, (k, i1) => bwd.contains(k) && bwd.x(k) <= i1)
      if (res === 'snake') foundSnake = true
      else if (res) return { i1: res.i1, i2: res.i2, lo: true, hi: true }
    } else {
      foundSnake = fwd.run(file1, file2, () => false) !== null || foundSnake
    }
    bwd.nextD()
    if (!isOdd) {
      const res = bwd.run(file1, file2, (k, i1) => fwd.contains(k) && i1 <= fwd.x(k))
      if (res === 'snake') foundSnake = true
      else if (res) return { i1: res.i1, i2: res.i2, lo: true, hi: true }
    } else {
      foundSnake = bwd.run(file1, file2, () => false) !== null || foundSnake
    }
    if (needMin) continue
    if (foundSnake && ec > HEUR_MIN_COST) {
      let r = fwd.foundSnake(ec, file1, file2)
      if (r) return { i1: r[0], i2: r[1], lo: true, hi: false }
      r = bwd.foundSnake(ec, file1, file2)
      if (r) return { i1: r[0], i2: r[1], lo: false, hi: true }
    }
    ec++
  }
  const [df, f1] = fwd.bestPosition(file1, file2)
  const [db, b1] = bwd.bestPosition(file1, file2)
  if (df > file1.len + file2.len - db) return { i1: f1, i2: df - f1, lo: true, hi: false }
  return { i1: b1, i2: db - b1, lo: false, hi: true }
}

function myersRun(st, file1, file2, needMin) {
  for (;;) {
    // strip_common
    const pre = commonPrefixFS(file1, file1.start, file1.end, file2, file2.start, file2.end)
    const post = commonPostfixFS(file1, file1.start + pre, file1.end, file2, file2.start + pre, file2.end)
    file1 = file1.slice(pre, file1.len - post)
    file2 = file2.slice(pre, file2.len - post)
    if (file1.len === 0) {
      file2.markChanged()
      return
    }
    if (file2.len === 0) {
      file1.markChanged()
      return
    }
    const split = myersSplit(st, file1, file2, needMin)
    myersRun(st, file1.slice(0, split.i1), file2.slice(0, split.i2), split.lo)
    file1 = file1.slice(split.i1)
    file2 = file2.slice(split.i2)
    needMin = split.hi
  }
}

// myers::preprocess: prune tokens that only occur on one side.
function preprocess(before, after, removed, added) {
  const eq1 = Math.min(isqrt(before.length), 1024)
  const eq2 = Math.min(isqrt(after.length), 1024)
  const occ1 = new Map()
  for (const t of before) occ1.set(t, (occ1.get(t) || 0) + 1)
  const occ2 = new Map()
  const status2 = new Uint8Array(after.length)
  after.forEach((t, i) => {
    occ2.set(t, (occ2.get(t) || 0) + 1)
    status2[i] = occStatus(occ1.get(t) || 0, eq2)
  })
  const status1 = new Uint8Array(before.length)
  before.forEach((t, i) => {
    status1[i] = occStatus(occ2.get(t) || 0, eq1)
  })
  return [prune(before, status1, removed), prune(after, status2, added)]
}

const OCC_NONE = 0
const OCC_SOME = 1
const OCC_COMMON = 2
const occStatus = (n, eqlimit) => (n === 0 ? OCC_NONE : n >= eqlimit ? OCC_COMMON : OCC_SOME)

function prune(file, status, changed) {
  const tokens = []
  const indices = []
  for (let i = 0; i < file.length; i++) {
    const s = status[i]
    const prunes = s === OCC_NONE ? true : s === OCC_SOME ? false : shouldPruneCommon(status, i)
    if (prunes) changed[i] = true
    else {
      tokens.push(file[i])
      indices.push(i)
    }
  }
  return { tokens, indices }
}

function shouldPruneCommon(status, pos) {
  const WINDOW = 100
  let unmatchedBefore = 0
  let commonBefore = 0
  // imara-diff uses `start = WINDOW` (not pos - WINDOW) here
  const start = pos > WINDOW ? WINDOW : 0
  for (let i = pos - 1; i >= start; i--) {
    const s = status[i]
    if (s === OCC_NONE) unmatchedBefore++
    else if (s === OCC_COMMON) commonBefore++
    else break
  }
  if (unmatchedBefore === 0) return false
  const end = Math.min(status.length, pos + WINDOW)
  let unmatchedAfter = 0
  let commonAfter = 0
  for (let i = pos; i < end; i++) {
    const s = status[i]
    if (s === OCC_NONE) unmatchedAfter++
    else if (s === OCC_COMMON) commonAfter++
    else break
  }
  if (unmatchedAfter === 0) return false
  return unmatchedBefore + unmatchedAfter > 3 * (commonBefore + commonAfter)
}

function myersDiff(before, after, removed, added, minimal) {
  const [p1, p2] = preprocess(before, after, removed, added)
  const len1 = p1.tokens.length
  const len2 = p2.tokens.length
  const ndiags = len1 + len2 + 3
  const st = {
    kvec: new Float64Array(2 * ndiags + 2),
    kforward: len2 + 1,
    kbackward: ndiags + len2 + 1,
    maxCost: Math.max(isqrt(ndiags), MAX_COST_MIN),
  }
  myersRun(st, new FileSlice(p1.tokens, p1.indices, removed, 0, len1), new FileSlice(p2.tokens, p2.indices, added, 0, len2), minimal)
}

// --------------------------------------------------------------- histogram

function findLcs(before, after, occ) {
  let lcsBefore = 0
  let lcsAfter = 0
  let lcsLen = 0
  let minOcc = MAX_CHAIN_LEN + 1
  let foundCs = false
  const count = (t) => {
    const l = occ.get(t)
    return l ? l.length : 0
  }
  let pos = 0
  while (pos < after.length) {
    const token = after[pos]
    const n = count(token)
    if (n !== 0) {
      foundCs = true
      if (n <= minOcc) {
        // update_lcs
        let nextIdx2 = pos + 1
        const list = occ.get(token)
        let li = 0
        let idx1 = list[li++]
        for (;;) {
          let occurrences = count(token)
          let s1 = idx1
          let s2 = pos
          while (s1 > 0 && s2 > 0 && before[s1 - 1] === after[s2 - 1]) {
            s1--
            s2--
            occurrences = Math.min(occurrences, count(before[s1]))
          }
          let e1 = idx1 + 1
          let e2 = pos + 1
          while (e1 < before.length && e2 < after.length && before[e1] === after[e2]) {
            occurrences = Math.min(occurrences, count(before[e1]))
            e1++
            e2++
          }
          if (nextIdx2 < e2) nextIdx2 = e2
          const len = e2 - s2
          if (lcsLen < len || minOcc > occurrences) {
            minOcc = occurrences
            lcsBefore = s1
            lcsAfter = s2
            lcsLen = len
          }
          // imara-diff compares the next occurrence (a `before` index) with
          // end2 (an `after` index)
          let next = -1
          while (li < list.length) {
            const cand = list[li++]
            if (cand > e2) {
              next = cand
              break
            }
          }
          if (next < 0) break
          idx1 = next
        }
        pos = nextIdx2
        continue
      }
    }
    pos++
  }
  const success = !foundCs || minOcc <= MAX_CHAIN_LEN
  return success ? { before: lcsBefore, after: lcsAfter, len: lcsLen } : null
}

function histogramDiff(before, after, removed, added) {
  // [bStart, bEnd, aStart, aEnd] ranges into the full arrays
  const stack = [[0, before.length, 0, after.length]]
  while (stack.length) {
    let [b0, b1, a0, a1] = stack.pop()
    for (;;) {
      if (b0 === b1) {
        for (let i = a0; i < a1; i++) added[i] = true
        break
      }
      if (a0 === a1) {
        for (let i = b0; i < b1; i++) removed[i] = true
        break
      }
      const bs = before.slice(b0, b1)
      const as = after.slice(a0, a1)
      const occ = new Map()
      bs.forEach((t, i) => {
        const l = occ.get(t)
        if (l) l.push(i)
        else occ.set(t, [i])
      })
      const lcs = findLcs(bs, as, occ)
      if (lcs && lcs.len === 0) {
        for (let i = a0; i < a1; i++) added[i] = true
        for (let i = b0; i < b1; i++) removed[i] = true
        break
      }
      if (!lcs) {
        const rm = new Array(b1 - b0).fill(false)
        const ad = new Array(a1 - a0).fill(false)
        myersDiff(bs, as, rm, ad, false)
        for (let i = 0; i < rm.length; i++) if (rm[i]) removed[b0 + i] = true
        for (let i = 0; i < ad.length; i++) if (ad[i]) added[a0 + i] = true
        break
      }
      stack.push([b0, b0 + lcs.before, a0, a0 + lcs.after])
      b0 += lcs.before + lcs.len
      a0 += lcs.after + lcs.len
    }
  }
}

// ------------------------------------------------------------- postprocess

function findHunkEnd(changes, pos) {
  while (pos < changes.length && changes[pos]) pos++
  return pos
}

function findHunkStart(changes, pos) {
  while (pos > 0 && changes[pos - 1]) pos--
  return pos
}

function findNextChange(changes, pos) {
  for (let i = pos; i < changes.length; i++) if (changes[i]) return i - pos
  return -1
}

// Hunk::next_hunk
function nextHunk(h, removed, added) {
  const off = findNextChange(added, h.aEnd)
  if (off < 0) return false
  let offBefore = 0
  for (;;) {
    let unchanged = findNextChange(removed, h.bEnd)
    if (unchanged < 0) unchanged = removed.length - h.bEnd
    if (offBefore + unchanged > off) {
      h.bStart = h.bEnd + (off - offBefore)
      h.bEnd = h.bStart
      break
    }
    offBefore += unchanged
    h.bStart = h.bEnd + unchanged
    h.bEnd = findHunkEnd(removed, h.bEnd + unchanged)
    if (offBefore === off) break
  }
  h.aStart = h.aEnd + off
  h.aEnd = findHunkEnd(added, h.aStart)
  return true
}

function postprocessSide(added, removed, tokens) {
  const h = { bStart: 0, bEnd: 0, aStart: 0, aEnd: 0 }
  const slideDown = () => {
    if (h.aEnd >= tokens.length) return false
    if (tokens[h.aStart] !== tokens[h.aEnd]) return false
    added[h.aStart] = false
    added[h.aEnd] = true
    h.aStart += 1
    h.aEnd = findHunkEnd(added, h.aEnd)
    h.bStart = h.bEnd + 1
    h.bEnd = findHunkEnd(removed, h.bStart)
    return true
  }
  const slideUp = () => {
    if (h.aStart === 0) return false
    if (tokens[h.aStart - 1] !== tokens[h.aEnd - 1]) return false
    added[h.aStart - 1] = true
    added[h.aEnd - 1] = false
    h.aEnd -= 1
    h.aStart = findHunkStart(added, h.aStart - 1)
    h.bEnd = h.bStart - 1
    h.bStart = findHunkStart(removed, h.bStart - 1)
    return true
  }
  while (nextHunk(h, removed, added)) {
    let earliestEnd
    let isModification
    for (;;) {
      while (slideUp());
      earliestEnd = h.aEnd
      isModification = h.bStart !== h.bEnd
      const size = h.aEnd - h.aStart
      while (slideDown()) isModification ||= h.bStart !== h.bEnd
      if (size === h.aEnd - h.aStart) break
    }
    if (h.aEnd === earliestEnd) continue
    if (isModification) {
      while (h.bStart === h.bEnd) if (!slideUp()) break
    }
    // NoSliderHeuristic keeps pure insertions slid all the way down
  }
}

// ------------------------------------------------------------------- api

/**
 * difftastic's lcs_diff::slice: returns ops [type, i, j] in order where type
 * is 0 (Both, i/j), 1 (Left, i) or 2 (Right, j). Items are compared with
 * `key(item)` (strings or numbers).
 */
export function lcsSlice(lhs, rhs, key = (x) => x) {
  const intern = new Map()
  const tok = (x) => {
    const k = key(x)
    let t = intern.get(k)
    if (t === undefined) intern.set(k, (t = intern.size))
    return t
  }
  const before = lhs.map(tok)
  const after = rhs.map(tok)
  const removed = new Array(before.length).fill(false)
  const added = new Array(after.length).fill(false)

  let pre = 0
  while (pre < before.length && pre < after.length && before[pre] === after[pre]) pre++
  let post = 0
  while (post < before.length - pre && post < after.length - pre && before[before.length - 1 - post] === after[after.length - 1 - post]) post++
  const bMid = before.slice(pre, before.length - post)
  const aMid = after.slice(pre, after.length - post)
  const rmMid = new Array(bMid.length).fill(false)
  const adMid = new Array(aMid.length).fill(false)
  histogramDiff(bMid, aMid, rmMid, adMid)
  for (let i = 0; i < rmMid.length; i++) removed[pre + i] = rmMid[i]
  for (let i = 0; i < adMid.length; i++) added[pre + i] = adMid[i]

  // postprocess_no_heuristic: after side first, then before side
  postprocessSide(added, removed, after)
  postprocessSide(removed, added, before)

  // hunks -> results
  const res = []
  let i = 0
  let j = 0
  while (i < before.length || j < after.length) {
    if ((i < before.length && removed[i]) || (j < after.length && added[j])) {
      while (i < before.length && removed[i]) res.push([1, i++, -1])
      while (j < after.length && added[j]) res.push([2, -1, j++])
      continue
    }
    res.push([0, i++, j++])
  }
  return res
}
