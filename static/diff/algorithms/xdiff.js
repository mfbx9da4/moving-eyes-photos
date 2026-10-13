// A faithful JavaScript port of git's xdiff line diff (xdiffi.c, xprepare.c,
// xpatience.c, xhistogram.c). GitHub renders diffs produced by git, so this is
// the "GitHub" algorithm: Myers with git's heuristics, followed by change
// compaction with the indent heuristic (on by default since git 2.14).
//
// Lines are represented by integer equivalence-class ids (interned line text).
// Change marks (rchg) are Uint8Arrays with one sentinel slot on each side, so
// rchg[i + 1] is the mark for line i and rchg[0] / rchg[n + 1] are always 0.

const XDL_MAX_COST_MIN = 256
const XDL_HEUR_MIN_COST = 256
const XDL_SNAKE_CNT = 20
const XDL_K_HEUR = 4
const XDL_MAX_EQLIMIT = 1024
const XDL_SIMSCAN_WINDOW = 100
const XDL_KPDIS_RUN = 4
const XDL_LINE_MAX = Number.MAX_SAFE_INTEGER

export function bogosqrt(n) {
  let i = 1
  for (; n > 0; n = Math.floor(n / 4)) i *= 2
  return i
}

// Scratch occurrence counters shared by every classic-diff call. They are
// indexed by class id and always reset to zero before returning.
let cnt1 = new Int32Array(0)
let cnt2 = new Int32Array(0)

function ensureCounters(nclasses) {
  if (cnt1.length >= nclasses) return
  cnt1 = new Int32Array(nclasses)
  cnt2 = new Int32Array(nclasses)
}

function cleanMmatch(dis, i, s, e) {
  if (i - s > XDL_SIMSCAN_WINDOW) s = i - XDL_SIMSCAN_WINDOW
  if (e - i > XDL_SIMSCAN_WINDOW) e = i + XDL_SIMSCAN_WINDOW

  let r, rdis0, rpdis0, rdis1, rpdis1
  for (r = 1, rdis0 = 0, rpdis0 = 1; i - r >= s; r++) {
    const d = dis[i - r]
    if (!d) rdis0++
    else if (d === 2) rpdis0++
    else break
  }
  if (rdis0 === 0) return false
  for (r = 1, rdis1 = 0, rpdis1 = 1; i + r <= e; r++) {
    const d = dis[i + r]
    if (!d) rdis1++
    else if (d === 2) rpdis1++
    else break
  }
  if (rdis1 === 0) return false
  rdis1 += rdis0
  rpdis1 += rpdis0
  return rpdis1 * XDL_KPDIS_RUN < rpdis1 + rdis1
}

// Middle snake search with git's cost heuristics.
function split(ha1, off1, lim1, ha2, off2, lim2, kvd, kf, kb, needMin, spl, mxcost) {
  const dmin = off1 - lim2
  const dmax = lim1 - off2
  const fmid = off1 - off2
  const bmid = lim1 - lim2
  const odd = (fmid - bmid) & 1
  let fmin = fmid
  let fmax = fmid
  let bmin = bmid
  let bmax = bmid
  let i1, i2, prev1, best, dd, v, k, d

  kvd[kf + fmid] = off1
  kvd[kb + bmid] = lim1

  for (let ec = 1; ; ec++) {
    let gotSnake = false

    if (fmin > dmin) kvd[kf + --fmin - 1] = -1
    else ++fmin
    if (fmax < dmax) kvd[kf + ++fmax + 1] = -1
    else --fmax

    for (d = fmax; d >= fmin; d -= 2) {
      if (kvd[kf + d - 1] >= kvd[kf + d + 1]) i1 = kvd[kf + d - 1] + 1
      else i1 = kvd[kf + d + 1]
      prev1 = i1
      i2 = i1 - d
      while (i1 < lim1 && i2 < lim2 && ha1[i1] === ha2[i2]) {
        i1++
        i2++
      }
      if (i1 - prev1 > XDL_SNAKE_CNT) gotSnake = true
      kvd[kf + d] = i1
      if (odd && bmin <= d && d <= bmax && kvd[kb + d] <= i1) {
        spl.i1 = i1
        spl.i2 = i2
        spl.minLo = spl.minHi = true
        return ec
      }
    }

    if (bmin > dmin) kvd[kb + --bmin - 1] = XDL_LINE_MAX
    else ++bmin
    if (bmax < dmax) kvd[kb + ++bmax + 1] = XDL_LINE_MAX
    else --bmax

    for (d = bmax; d >= bmin; d -= 2) {
      if (kvd[kb + d - 1] < kvd[kb + d + 1]) i1 = kvd[kb + d - 1]
      else i1 = kvd[kb + d + 1] - 1
      prev1 = i1
      i2 = i1 - d
      while (i1 > off1 && i2 > off2 && ha1[i1 - 1] === ha2[i2 - 1]) {
        i1--
        i2--
      }
      if (prev1 - i1 > XDL_SNAKE_CNT) gotSnake = true
      kvd[kb + d] = i1
      if (!odd && fmin <= d && d <= fmax && i1 <= kvd[kf + d]) {
        spl.i1 = i1
        spl.i2 = i2
        spl.minLo = spl.minHi = true
        return ec
      }
    }

    if (needMin) continue

    if (gotSnake && ec > XDL_HEUR_MIN_COST) {
      for (best = 0, d = fmax; d >= fmin; d -= 2) {
        dd = d > fmid ? d - fmid : fmid - d
        i1 = kvd[kf + d]
        i2 = i1 - d
        v = i1 - off1 + (i2 - off2) - dd
        if (
          v > XDL_K_HEUR * ec &&
          v > best &&
          off1 + XDL_SNAKE_CNT <= i1 &&
          i1 < lim1 &&
          off2 + XDL_SNAKE_CNT <= i2 &&
          i2 < lim2
        ) {
          for (k = 1; ha1[i1 - k] === ha2[i2 - k]; k++) {
            if (k === XDL_SNAKE_CNT) {
              best = v
              spl.i1 = i1
              spl.i2 = i2
              break
            }
          }
        }
      }
      if (best > 0) {
        spl.minLo = true
        spl.minHi = false
        return ec
      }

      for (best = 0, d = bmax; d >= bmin; d -= 2) {
        dd = d > bmid ? d - bmid : bmid - d
        i1 = kvd[kb + d]
        i2 = i1 - d
        v = lim1 - i1 + (lim2 - i2) - dd
        if (
          v > XDL_K_HEUR * ec &&
          v > best &&
          off1 < i1 &&
          i1 <= lim1 - XDL_SNAKE_CNT &&
          off2 < i2 &&
          i2 <= lim2 - XDL_SNAKE_CNT
        ) {
          for (k = 0; ha1[i1 + k] === ha2[i2 + k]; k++) {
            if (k === XDL_SNAKE_CNT - 1) {
              best = v
              spl.i1 = i1
              spl.i2 = i2
              break
            }
          }
        }
      }
      if (best > 0) {
        spl.minLo = false
        spl.minHi = true
        return ec
      }
    }

    if (ec >= mxcost) {
      let fbest = -1
      let fbest1 = -1
      for (d = fmax; d >= fmin; d -= 2) {
        i1 = Math.min(kvd[kf + d], lim1)
        i2 = i1 - d
        if (lim2 < i2) {
          i1 = lim2 + d
          i2 = lim2
        }
        if (fbest < i1 + i2) {
          fbest = i1 + i2
          fbest1 = i1
        }
      }
      let bbest = XDL_LINE_MAX
      let bbest1 = XDL_LINE_MAX
      for (d = bmax; d >= bmin; d -= 2) {
        i1 = Math.max(off1, kvd[kb + d])
        i2 = i1 - d
        if (i2 < off2) {
          i1 = off2 + d
          i2 = off2
        }
        if (i1 + i2 < bbest) {
          bbest = i1 + i2
          bbest1 = i1
        }
      }
      if (lim1 + lim2 - bbest < fbest - (off1 + off2)) {
        spl.i1 = fbest1
        spl.i2 = fbest - fbest1
        spl.minLo = true
        spl.minHi = false
      } else {
        spl.i1 = bbest1
        spl.i2 = bbest - bbest1
        spl.minLo = false
        spl.minHi = true
      }
      return ec
    }
  }
}

// Equivalent of xdl_do_diff() for the classic algorithm on the sub-files
// a[s1, e1) and b[s2, e2): xdl_prepare_env (trim ends, discard unmatched and
// "multimatch" records) followed by xdl_recs_cmp.
export function classicDiff(a, s1, e1, b, s2, e2, rchg1, rchg2, needMin, nclasses) {
  const nrec1 = e1 - s1
  const nrec2 = e2 - s2

  // xdl_trim_ends
  let i = 0
  let lim = Math.min(nrec1, nrec2)
  while (i < lim && a[s1 + i] === b[s2 + i]) i++
  const dstart = i
  lim -= i
  i = 0
  while (i < lim && a[e1 - 1 - i] === b[e2 - 1 - i]) i++
  const dend1 = nrec1 - i - 1
  const dend2 = nrec2 - i - 1

  // xdl_cleanup_records
  ensureCounters(nclasses)
  for (let j = s1; j < e1; j++) cnt1[a[j]]++
  for (let j = s2; j < e2; j++) cnt2[b[j]]++

  const dis1 = new Uint8Array(nrec1 + 1)
  const dis2 = new Uint8Array(nrec2 + 1)
  let mlim = Math.min(bogosqrt(nrec1), XDL_MAX_EQLIMIT)
  for (let j = dstart; j <= dend1; j++) {
    const nm = cnt2[a[s1 + j]]
    dis1[j] = nm === 0 ? 0 : nm >= mlim && !needMin ? 2 : 1
  }
  mlim = Math.min(bogosqrt(nrec2), XDL_MAX_EQLIMIT)
  for (let j = dstart; j <= dend2; j++) {
    const nm = cnt1[b[s2 + j]]
    dis2[j] = nm === 0 ? 0 : nm >= mlim && !needMin ? 2 : 1
  }
  for (let j = s1; j < e1; j++) cnt1[a[j]] = 0
  for (let j = s2; j < e2; j++) cnt2[b[j]] = 0

  const n1 = Math.max(0, dend1 - dstart + 1)
  const n2 = Math.max(0, dend2 - dstart + 1)
  const rindex1 = new Int32Array(n1)
  const ha1 = new Int32Array(n1)
  const rindex2 = new Int32Array(n2)
  const ha2 = new Int32Array(n2)
  let nreff1 = 0
  for (let j = dstart; j <= dend1; j++) {
    if (dis1[j] === 1 || (dis1[j] === 2 && !cleanMmatch(dis1, j, dstart, dend1))) {
      rindex1[nreff1] = s1 + j
      ha1[nreff1] = a[s1 + j]
      nreff1++
    } else {
      rchg1[s1 + j + 1] = 1
    }
  }
  let nreff2 = 0
  for (let j = dstart; j <= dend2; j++) {
    if (dis2[j] === 1 || (dis2[j] === 2 && !cleanMmatch(dis2, j, dstart, dend2))) {
      rindex2[nreff2] = s2 + j
      ha2[nreff2] = b[s2 + j]
      nreff2++
    } else {
      rchg2[s2 + j + 1] = 1
    }
  }

  // xdl_do_diff -> xdl_recs_cmp
  const ndiags = nreff1 + nreff2 + 3
  const kvd = new Float64Array(2 * ndiags + 2)
  const kf = nreff2 + 1
  const kb = ndiags + nreff2 + 1
  const mxcost = Math.max(bogosqrt(ndiags), XDL_MAX_COST_MIN)
  const spl = { i1: 0, i2: 0, minLo: false, minHi: false }

  // Explicit stack instead of recursion: [off1, lim1, off2, lim2, needMin]
  const stack = [0, nreff1, 0, nreff2, needMin ? 1 : 0]
  while (stack.length) {
    const nm = stack.pop() === 1
    let lim2 = stack.pop()
    let off2 = stack.pop()
    let lim1 = stack.pop()
    let off1 = stack.pop()

    while (off1 < lim1 && off2 < lim2 && ha1[off1] === ha2[off2]) {
      off1++
      off2++
    }
    while (off1 < lim1 && off2 < lim2 && ha1[lim1 - 1] === ha2[lim2 - 1]) {
      lim1--
      lim2--
    }

    if (off1 === lim1) {
      for (; off2 < lim2; off2++) rchg2[rindex2[off2] + 1] = 1
    } else if (off2 === lim2) {
      for (; off1 < lim1; off1++) rchg1[rindex1[off1] + 1] = 1
    } else {
      spl.i1 = spl.i2 = 0
      split(ha1, off1, lim1, ha2, off2, lim2, kvd, kf, kb, nm, spl, mxcost)
      const { i1, i2, minLo, minHi } = spl
      stack.push(i1, lim1, i2, lim2, minHi ? 1 : 0)
      stack.push(off1, i1, off2, i2, minLo ? 1 : 0)
    }
  }
}

// ---------------------------------------------------------------- patience

function patienceDiff(a, b, rchg1, rchg2, nclasses) {
  // Work items: [line1, count1, line2, count2] using git's 1-based lines.
  const work = [[1, a.length, 1, b.length]]
  const map = new Map()

  while (work.length) {
    const [line1, count1, line2, count2] = work.pop()
    if (!count1) {
      for (let j = 0; j < count2; j++) rchg2[line2 + j] = 1
      continue
    }
    if (!count2) {
      for (let j = 0; j < count1; j++) rchg1[line1 + j] = 1
      continue
    }

    // fill_hashmap: entries in file-1 order; line2 = 0 (unmatched),
    // -1 (NON_UNIQUE) or the unique matching line in file 2.
    map.clear()
    const order = []
    for (let l = line1; l < line1 + count1; l++) {
      const h = a[l - 1]
      const e = map.get(h)
      if (e) {
        e.line2 = -1
        continue
      }
      const ne = { line1: l, line2: 0, next: null, previous: null }
      map.set(h, ne)
      order.push(ne)
    }
    let hasMatches = false
    for (let l = line2; l < line2 + count2; l++) {
      const e = map.get(b[l - 1])
      if (!e) continue
      hasMatches = true
      e.line2 = e.line2 ? -1 : l
    }

    if (!hasMatches) {
      for (let j = 0; j < count1; j++) rchg1[line1 + j] = 1
      for (let j = 0; j < count2; j++) rchg2[line2 + j] = 1
      continue
    }

    // find_longest_common_sequence
    const sequence = []
    let longest = 0
    for (const entry of order) {
      if (entry.line2 <= 0) continue
      let left = -1
      let right = longest
      while (left + 1 < right) {
        const middle = left + ((right - left) >> 1)
        if (sequence[middle].line2 > entry.line2) right = middle
        else left = middle
      }
      entry.previous = left < 0 ? null : sequence[left]
      const i = left + 1
      sequence[i] = entry
      if (i === longest) longest++
    }

    if (!longest) {
      classicDiff(a, line1 - 1, line1 - 1 + count1, b, line2 - 1, line2 - 1 + count2, rchg1, rchg2, false, nclasses)
      continue
    }

    let entry = sequence[longest - 1]
    entry.next = null
    while (entry.previous) {
      entry.previous.next = entry
      entry = entry.previous
    }

    // walk_common_sequence; recursions are pushed in reverse so that they are
    // processed in order (only matters for readability, not results).
    const sub = []
    let first = entry
    let l1 = line1
    let l2 = line2
    const end1 = line1 + count1
    const end2 = line2 + count2
    for (;;) {
      let next1, next2
      if (first) {
        next1 = first.line1
        next2 = first.line2
        while (next1 > l1 && next2 > l2 && a[next1 - 2] === b[next2 - 2]) {
          next1--
          next2--
        }
      } else {
        next1 = end1
        next2 = end2
      }
      while (l1 < next1 && l2 < next2 && a[l1 - 1] === b[l2 - 1]) {
        l1++
        l2++
      }
      if (next1 > l1 || next2 > l2) sub.push([l1, next1 - l1, l2, next2 - l2])
      if (!first) break
      while (first.next && first.next.line1 === first.line1 + 1 && first.next.line2 === first.line2 + 1) {
        first = first.next
      }
      l1 = first.line1 + 1
      l2 = first.line2 + 1
      first = first.next
    }
    for (let j = sub.length - 1; j >= 0; j--) work.push(sub[j])
  }
}

// --------------------------------------------------------------- histogram

const MAX_CHAIN_LENGTH = 64

function findLcs(a, b, lcs, line1, count1, line2, count2) {
  // scanA: for each distinct line in A's range, a record with the first
  // occurrence (ptr) and number of occurrences (cnt); nextPtr chains equal lines.
  const records = new Map()
  const lineMap = new Array(count1)
  const nextPtrs = new Int32Array(count1)
  const end1 = line1 + count1 - 1
  const end2 = line2 + count2 - 1
  for (let ptr = end1; line1 <= ptr; ptr--) {
    const h = a[ptr - 1]
    let rec = records.get(h)
    if (rec) {
      nextPtrs[ptr - line1] = rec.ptr
      rec.ptr = ptr
      rec.cnt++
    } else {
      rec = { ptr, cnt: 1 }
      records.set(h, rec)
    }
    lineMap[ptr - line1] = rec
  }

  let indexCnt = MAX_CHAIN_LENGTH + 1
  let hasCommon = false

  for (let bPtr = line2; bPtr <= end2; ) {
    let bNext = bPtr + 1
    const rec = records.get(b[bPtr - 1])
    if (rec) {
      if (rec.cnt > indexCnt) {
        hasCommon = true
      } else {
        hasCommon = true
        let as = rec.ptr
        for (;;) {
          let np = nextPtrs[as - line1]
          let bs = bPtr
          let ae = as
          let be = bs
          let rc = rec.cnt
          while (line1 < as && line2 < bs && a[as - 2] === b[bs - 2]) {
            as--
            bs--
            if (1 < rc) rc = Math.min(rc, lineMap[as - line1].cnt)
          }
          while (ae < end1 && be < end2 && a[ae] === b[be]) {
            ae++
            be++
            if (1 < rc) rc = Math.min(rc, lineMap[ae - line1].cnt)
          }
          if (bNext <= be) bNext = be + 1
          if (lcs.end1 - lcs.begin1 < ae - as || rc < indexCnt) {
            lcs.begin1 = as
            lcs.begin2 = bs
            lcs.end1 = ae
            lcs.end2 = be
            indexCnt = rc
          }
          if (np === 0) break
          let stop = false
          while (np <= ae) {
            np = nextPtrs[np - line1]
            if (np === 0) {
              stop = true
              break
            }
          }
          if (stop) break
          as = np
        }
      }
    }
    bPtr = bNext
  }

  return hasCommon && MAX_CHAIN_LENGTH < indexCnt
}

function histogramDiff(a, b, rchg1, rchg2, nclasses) {
  const work = [[1, a.length, 1, b.length]]
  while (work.length) {
    let [line1, count1, line2, count2] = work.pop()
    for (;;) {
      if (count1 <= 0 && count2 <= 0) break
      if (!count1) {
        for (let j = 0; j < count2; j++) rchg2[line2 + j] = 1
        break
      }
      if (!count2) {
        for (let j = 0; j < count1; j++) rchg1[line1 + j] = 1
        break
      }
      const lcs = { begin1: 0, begin2: 0, end1: 0, end2: 0 }
      const fallback = findLcs(a, b, lcs, line1, count1, line2, count2)
      if (fallback) {
        classicDiff(a, line1 - 1, line1 - 1 + count1, b, line2 - 1, line2 - 1 + count2, rchg1, rchg2, false, nclasses)
        break
      }
      if (lcs.begin1 === 0 && lcs.begin2 === 0) {
        for (let j = 0; j < count1; j++) rchg1[line1 + j] = 1
        for (let j = 0; j < count2; j++) rchg2[line2 + j] = 1
        break
      }
      work.push([line1, lcs.begin1 - line1, line2, lcs.begin2 - line2])
      const end1 = line1 + count1 - 1
      const end2 = line2 + count2 - 1
      count1 = end1 - lcs.end1
      line1 = lcs.end1 + 1
      count2 = end2 - lcs.end2
      line2 = lcs.end2 + 1
    }
  }
}

// ------------------------------------------------------------- compaction

const MAX_INDENT = 200
const MAX_BLANKS = 20
const START_OF_FILE_PENALTY = 1
const END_OF_FILE_PENALTY = 21
const TOTAL_BLANK_WEIGHT = -30
const POST_BLANK_WEIGHT = 6
const RELATIVE_INDENT_PENALTY = -4
const RELATIVE_INDENT_WITH_BLANK_PENALTY = 10
const RELATIVE_OUTDENT_PENALTY = 24
const RELATIVE_OUTDENT_WITH_BLANK_PENALTY = 17
const RELATIVE_DEDENT_PENALTY = 23
const RELATIVE_DEDENT_WITH_BLANK_PENALTY = 17
const INDENT_WEIGHT = 60
const INDENT_HEURISTIC_MAX_SLIDING = 100

// git's get_indent(): tabs advance to the next multiple of 8, other
// whitespace is ignored, -1 means the line is blank.
export function measureIndent(text, start, end) {
  let ret = 0
  for (let i = start; i < end; i++) {
    const c = text.charCodeAt(i)
    if (c === 32) ret += 1
    else if (c === 9) ret += 8 - (ret % 8)
    else if (c !== 10 && c !== 13 && c !== 11 && c !== 12) return ret
    if (ret >= MAX_INDENT) return MAX_INDENT
  }
  return -1
}

function measureSplit(nrec, indent, split, m) {
  if (split >= nrec) {
    m.endOfFile = true
    m.indent = -1
  } else {
    m.endOfFile = false
    m.indent = indent(split)
  }
  m.preBlank = 0
  m.preIndent = -1
  for (let i = split - 1; i >= 0; i--) {
    m.preIndent = indent(i)
    if (m.preIndent !== -1) break
    m.preBlank += 1
    if (m.preBlank === MAX_BLANKS) {
      m.preIndent = 0
      break
    }
  }
  m.postBlank = 0
  m.postIndent = -1
  for (let i = split + 1; i < nrec; i++) {
    m.postIndent = indent(i)
    if (m.postIndent !== -1) break
    m.postBlank += 1
    if (m.postBlank === MAX_BLANKS) {
      m.postIndent = 0
      break
    }
  }
}

function scoreAddSplit(m, s) {
  if (m.preIndent === -1 && m.preBlank === 0) s.penalty += START_OF_FILE_PENALTY
  if (m.endOfFile) s.penalty += END_OF_FILE_PENALTY
  const postBlank = m.indent === -1 ? 1 + m.postBlank : 0
  const totalBlank = m.preBlank + postBlank
  s.penalty += TOTAL_BLANK_WEIGHT * totalBlank
  s.penalty += POST_BLANK_WEIGHT * postBlank
  const indent = m.indent !== -1 ? m.indent : m.postIndent
  const anyBlanks = totalBlank !== 0
  s.effectiveIndent += indent
  if (indent === -1 || m.preIndent === -1) return
  if (indent > m.preIndent) {
    s.penalty += anyBlanks ? RELATIVE_INDENT_WITH_BLANK_PENALTY : RELATIVE_INDENT_PENALTY
    return
  }
  if (indent === m.preIndent) return
  if (m.postIndent !== -1 && m.postIndent > indent) {
    s.penalty += anyBlanks ? RELATIVE_OUTDENT_WITH_BLANK_PENALTY : RELATIVE_OUTDENT_PENALTY
    return
  }
  s.penalty += anyBlanks ? RELATIVE_DEDENT_WITH_BLANK_PENALTY : RELATIVE_DEDENT_PENALTY
}

function scoreCmp(s1, s2) {
  const cmpIndents = (s1.effectiveIndent > s2.effectiveIndent ? 1 : 0) - (s1.effectiveIndent < s2.effectiveIndent ? 1 : 0)
  return INDENT_WEIGHT * cmpIndents + (s1.penalty - s2.penalty)
}

// rchg is offset by one: line i is rchg[i + 1].
function changeCompact(ha, rchg, nrec, hao, rchgo, nreco, indent, indentHeuristic, rediff, nclasses) {
  const g = { start: 0, end: 0 }
  const go = { start: 0, end: 0 }
  const groupInit = (r, grp) => {
    grp.start = grp.end = 0
    while (r[grp.end + 1]) grp.end++
  }
  const groupNext = (r, n, grp) => {
    if (grp.end === n) return false
    grp.start = grp.end + 1
    for (grp.end = grp.start; r[grp.end + 1]; grp.end++);
    return true
  }
  const groupPrevious = (r, grp) => {
    if (grp.start === 0) return false
    grp.end = grp.start - 1
    for (grp.start = grp.end; r[grp.start]; grp.start--);
    return true
  }
  const slideDown = () => {
    if (g.end < nrec && ha[g.start] === ha[g.end]) {
      rchg[g.start++ + 1] = 0
      rchg[g.end++ + 1] = 1
      while (rchg[g.end + 1]) g.end++
      return true
    }
    return false
  }
  const slideUp = () => {
    if (g.start > 0 && ha[g.start - 1] === ha[g.end - 1]) {
      rchg[--g.start + 1] = 1
      rchg[--g.end + 1] = 0
      while (rchg[g.start]) g.start--
      return true
    }
    return false
  }

  groupInit(rchg, g)
  groupInit(rchgo, go)
  const m = { endOfFile: false, indent: 0, preBlank: 0, preIndent: 0, postBlank: 0, postIndent: 0 }

  for (;;) {
    if (g.end !== g.start) {
      const origStart = g.start
      const origEnd = g.end
      let groupsize, earliestEnd, endMatchingOther
      do {
        groupsize = g.end - g.start
        endMatchingOther = -1
        while (slideUp()) {
          if (!groupPrevious(rchgo, go)) throw new Error('group sync broken sliding up')
        }
        earliestEnd = g.end
        if (go.end > go.start) endMatchingOther = g.end
        for (;;) {
          if (!slideDown()) break
          if (!groupNext(rchgo, nreco, go)) throw new Error('group sync broken sliding down')
          if (go.end > go.start) endMatchingOther = g.end
        }
      } while (groupsize !== g.end - g.start)

      if (g.end === earliestEnd) {
        // no shifting was possible
      } else if (endMatchingOther !== -1) {
        while (go.end === go.start) {
          if (!slideUp()) throw new Error('match disappeared')
          if (!groupPrevious(rchgo, go)) throw new Error('group sync broken sliding to match')
        }
      } else if (indentHeuristic) {
        let shift = earliestEnd
        if (g.end - groupsize - 1 > shift) shift = g.end - groupsize - 1
        if (g.end - INDENT_HEURISTIC_MAX_SLIDING > shift) shift = g.end - INDENT_HEURISTIC_MAX_SLIDING
        let bestShift = -1
        const best = { effectiveIndent: 0, penalty: 0 }
        for (; shift <= g.end; shift++) {
          const score = { effectiveIndent: 0, penalty: 0 }
          measureSplit(nrec, indent, shift, m)
          scoreAddSplit(m, score)
          measureSplit(nrec, indent, shift - groupsize, m)
          scoreAddSplit(m, score)
          if (bestShift === -1 || scoreCmp(score, best) <= 0) {
            best.effectiveIndent = score.effectiveIndent
            best.penalty = score.penalty
            bestShift = shift
          }
        }
        while (g.end > bestShift) {
          if (!slideUp()) throw new Error('best shift unreached')
          if (!groupPrevious(rchgo, go)) throw new Error('group sync broken sliding to blank line')
        }
      }

      // git >= 2.50: when sliding merged histogram change groups, the merged
      // group may now contain lines matching the other side, so re-diff it
      // with the classic algorithm (xdl_fall_back_diff overwrites the marks).
      if (rediff && go.end !== go.start && (g.start !== origStart || g.end !== origEnd)) {
        rchg.fill(0, g.start + 1, g.end + 1)
        rchgo.fill(0, go.start + 1, go.end + 1)
        classicDiff(ha, g.start, g.end, hao, go.start, go.end, rchg, rchgo, false, nclasses)
      }
    }
    if (!groupNext(rchg, nrec, g)) break
    if (!groupNext(rchgo, nreco, go)) throw new Error('group sync broken moving to next group')
  }
}

// ------------------------------------------------------------------ public

/**
 * Diff two sequences of line class ids the way `git diff` does.
 * @param {Int32Array} a old lines (class ids)
 * @param {Int32Array} b new lines (class ids)
 * @param {object} opts
 * @param {'myers'|'minimal'|'patience'|'histogram'} opts.algorithm
 * @param {number} opts.nclasses number of distinct class ids
 * @param {boolean} [opts.indentHeuristic=true]
 * @param {(i:number)=>number} [opts.indent1] git get_indent() of old line i
 * @param {(i:number)=>number} [opts.indent2] git get_indent() of new line i
 * @returns {Int32Array} change groups as flat [i1, n1, i2, n2, ...] (0-based)
 */
export function xdiff(a, b, opts) {
  const { algorithm = 'myers', nclasses, indentHeuristic = true } = opts
  const rchg1 = new Uint8Array(a.length + 2)
  const rchg2 = new Uint8Array(b.length + 2)

  if (algorithm === 'patience') patienceDiff(a, b, rchg1, rchg2, nclasses)
  else if (algorithm === 'histogram') histogramDiff(a, b, rchg1, rchg2, nclasses)
  else classicDiff(a, 0, a.length, b, 0, b.length, rchg1, rchg2, algorithm === 'minimal', nclasses)

  const flat = () => -1
  const rediff = algorithm === 'histogram' && opts.histogramRediff !== false
  changeCompact(a, rchg1, a.length, b, rchg2, b.length, opts.indent1 || flat, indentHeuristic && !!opts.indent1, rediff, nclasses)
  changeCompact(b, rchg2, b.length, a, rchg1, a.length, opts.indent2 || flat, indentHeuristic && !!opts.indent2, rediff, nclasses)

  return buildScript(rchg1, a.length, rchg2, b.length)
}

// xdl_build_script(), emitted in forward order.
export function buildScript(rchg1, n1, rchg2, n2) {
  const out = []
  for (let i1 = n1, i2 = n2; i1 >= 0 || i2 >= 0; i1--, i2--) {
    if (rchg1[i1] || rchg2[i2]) {
      const l1 = i1
      const l2 = i2
      while (rchg1[i1]) i1--
      while (rchg2[i2]) i2--
      out.push(i1, l1 - i1, i2, l2 - i2)
    }
  }
  const res = new Int32Array(out.length)
  for (let k = out.length - 4, j = 0; k >= 0; k -= 4, j += 4) {
    res[j] = out[k]
    res[j + 1] = out[k + 1]
    res[j + 2] = out[k + 2]
    res[j + 3] = out[k + 3]
  }
  return res
}
