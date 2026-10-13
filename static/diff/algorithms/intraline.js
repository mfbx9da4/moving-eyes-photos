// Word-level ("subline") highlighting as rendered by github.com. Verified
// against GitHub's server-rendered diffs:
//   * only change blocks with as many deleted as added lines are paired,
//     line i with line i, and no similarity threshold is applied;
//   * pairs where either line is 1000+ characters are not highlighted;
//   * tokens are runs of letters/digits/underscore, any other character is a
//     token of its own (each space too);
//   * common leading/trailing tokens are stripped, the rest is diffed with
//     greedy Myers (deletions first on ties);
//   * unchanged runs of <= 2 characters between two changes count as changed.

const TOKEN_RE = /[\p{L}\p{N}_]+|[^]/gu
export const MAX_LINE = 1000
const SMALL_EQUALITY = 2

export function tokenize(s) {
  return s.match(TOKEN_RE) || []
}

// Myers O(ND) diff over integer arrays. Returns ops [type, ai, bi] with
// type 0 equal, 1 delete (ai), 2 insert (bi), in order.
export function myersOps(a, b) {
  const n = a.length
  const m = b.length
  const max = n + m
  const offset = max + 1
  const v = new Int32Array(2 * max + 3)
  const trace = []
  let found = 0
  outer: for (let d = 0; d <= max; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2))
    for (let k = -d; k <= d; k += 2) {
      let x
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) x = v[offset + k + 1]
      else x = v[offset + k - 1] + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[offset + k] = x
      if (x >= n && y >= m) {
        found = d
        break outer
      }
    }
  }
  const ops = []
  let x = n
  let y = m
  for (let d = found; d > 0; d--) {
    const vd = trace[d]
    const get = (k) => vd[k + d + 1]
    const k = x - y
    const prevK = k === -d || (k !== d && get(k - 1) < get(k + 1)) ? k + 1 : k - 1
    const prevX = get(prevK)
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) ops.push([0, --x, --y])
    if (x === prevX) ops.push([2, x, --y])
    else ops.push([1, --x, y])
  }
  while (x > 0 && y > 0) ops.push([0, --x, --y])
  ops.reverse()
  return ops
}

function rangesFromMarks(marks) {
  const out = []
  let i = 0
  while (i < marks.length) {
    if (!marks[i]) {
      i++
      continue
    }
    const s = i
    while (i < marks.length && marks[i]) i++
    out.push(s, i)
  }
  return out
}

/**
 * GitHub's highlighted ranges for one old/new line pair.
 * @returns {{oldR: number[], newR: number[]}} flat [start, end, ...] lists
 */
export function githubWordDiff(oldS, newS) {
  const ta = tokenize(oldS)
  const tb = tokenize(newS)
  const ids = new Map()
  const id = (t) => {
    let v = ids.get(t)
    if (v === undefined) ids.set(t, (v = ids.size))
    return v
  }
  const a = ta.map(id)
  const b = tb.map(id)
  let p = 0
  while (p < a.length && p < b.length && a[p] === b[p]) p++
  let s = 0
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++
  const ops = myersOps(a.slice(p, a.length - s), b.slice(p, b.length - s))

  // runs: [changed, aTokens[], bTokens[]]
  const runs = []
  for (const [type, ai, bi] of ops) {
    const changed = type !== 0
    let run = runs[runs.length - 1]
    if (!run || run[0] !== changed) runs.push((run = [changed, [], []]))
    if (type !== 2) run[1].push(ai + p)
    if (type !== 1) run[2].push(bi + p)
  }
  for (let r = 1; r < runs.length - 1; r++) {
    if (runs[r][0]) continue
    let chars = 0
    for (const i of runs[r][1]) chars += ta[i].length
    if (chars <= SMALL_EQUALITY) runs[r][0] = true
  }

  const offA = [0]
  for (const t of ta) offA.push(offA[offA.length - 1] + t.length)
  const offB = [0]
  for (const t of tb) offB.push(offB[offB.length - 1] + t.length)
  const ma = new Uint8Array(oldS.length)
  const mb = new Uint8Array(newS.length)
  for (const [changed, ia, ib] of runs) {
    if (!changed) continue
    for (const i of ia) ma.fill(1, offA[i], offA[i + 1])
    for (const j of ib) mb.fill(1, offB[j], offB[j + 1])
  }
  return { oldR: rangesFromMarks(ma), newR: rangesFromMarks(mb) }
}

/**
 * GitHub-style highlights for one change group.
 * @returns {Array<[oldLine, number[], newLine, number[]]>}
 */
export function intralineForGroup(getOld, getNew, i1, n1, i2, n2) {
  const out = []
  if (n1 !== n2) return out
  for (let k = 0; k < n1; k++) {
    const os = getOld(i1 + k)
    const ns = getNew(i2 + k)
    if (os.length >= MAX_LINE || ns.length >= MAX_LINE) continue
    const { oldR, newR } = githubWordDiff(os, ns)
    out.push([i1 + k, oldR, i2 + k, newR])
  }
  return out
}
