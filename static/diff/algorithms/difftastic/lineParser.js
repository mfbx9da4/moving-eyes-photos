// Port of difftastic's text fallback (src/line_parser.rs): a histogram line
// diff, then a word diff inside each changed block.

import { lcsSlice } from './imara.js'
import { LinePositions, MK_NOVEL_WORD, MK_UNCHANGED, MK_UNCHANGED_PART, splitWordsUpTo } from './syntax.js'

const MAX_WORDS_IN_LINE = 1000

function splitLinesKeepNewline(s) {
  const lines = []
  let offset = 0
  for (let i = s.indexOf('\n'); i !== -1; i = s.indexOf('\n', i + 1)) {
    lines.push(s.slice(offset, i + 1))
    offset = i + 1
  }
  if (offset < s.length) lines.push(s.slice(offset))
  return lines
}

// changed_parts + merge_novel: [novel?, lhsLines[], rhsLines[]]
function changedParts(src, opp) {
  const a = splitLinesKeepNewline(src)
  const b = splitLinesKeepNewline(opp)
  const res = []
  let ln = []
  let rn = []
  const flush = () => {
    if (ln.length || rn.length) res.push([true, ln, rn])
    ln = []
    rn = []
  }
  for (const [t, i, j] of lcsSlice(a, b)) {
    if (t === 1) ln.push(a[i])
    else if (t === 2) rn.push(b[j])
    else {
      flush()
      res.push([false, [a[i]], [b[j]]])
    }
  }
  flush()
  return res
}

const lineLen = (line) => (line.endsWith('\n') ? line.length - 1 : line.length)

export function textChangePositions(lhsSrc, rhsSrc) {
  const llp = new LinePositions(lhsSrc)
  const rlp = new LinePositions(rhsSrc)
  let lo = 0
  let ro = 0
  let lline = 0
  let rline = 0
  const lhs = []
  const rhs = []
  let seenUnchanged = false
  for (const [novel, ls, rs] of changedParts(lhsSrc, rhsSrc)) {
    if (!novel) {
      seenUnchanged = true
      for (let k = 0; k < ls.length; k++) {
        const lp = [{ line: lline, start: 0, end: lineLen(ls[k]) }]
        const rp = [{ line: rline, start: 0, end: lineLen(rs[k]) }]
        lhs.push({ kind: MK_UNCHANGED, pos: lp[0], selfPos: lp, oppPos: rp })
        rhs.push({ kind: MK_UNCHANGED, pos: rp[0], selfPos: rp, oppPos: lp })
        lo += ls[k].length
        ro += rs[k].length
        lline++
        rline++
      }
      continue
    }
    const lpart = ls.join('')
    const rpart = rs.join('')
    const lw = splitWordsUpTo(lpart, MAX_WORDS_IN_LINE)
    const rw = lw ? splitWordsUpTo(rpart, MAX_WORDS_IN_LINE) : null
    if (!lw || !rw) {
      for (const p of llp.fromRegion(lo, lo + lpart.length)) if (p.start !== p.end) lhs.push({ kind: MK_NOVEL_WORD, pos: p })
      for (const p of rlp.fromRegion(ro, ro + rpart.length)) if (p.start !== p.end) rhs.push({ kind: MK_NOVEL_WORD, pos: p })
      lo += lpart.length
      ro += rpart.length
      lline += ls.length
      rline += rs.length
      continue
    }
    for (const [t, i, j] of lcsSlice(lw, rw)) {
      if (t === 1) {
        const w = lw[i]
        lhs.push({ kind: MK_NOVEL_WORD, pos: llp.fromRegion(lo, lo + w.length)[0] })
        lo += w.length
      } else if (t === 0) {
        const w = lw[i]
        const ow = rw[j]
        if (w !== '\n') {
          const lp = llp.fromRegion(lo, lo + w.length)
          const rp = rlp.fromRegion(ro, ro + ow.length)
          lhs.push({ kind: MK_UNCHANGED_PART, pos: lp[0], selfPos: lp[0], oppPos: rp })
          rhs.push({ kind: MK_UNCHANGED_PART, pos: rp[0], selfPos: rp[0], oppPos: lp })
        }
        lo += w.length
        ro += ow.length
      } else {
        const w = rw[j]
        rhs.push({ kind: MK_NOVEL_WORD, pos: rlp.fromRegion(ro, ro + w.length)[0] })
        ro += w.length
      }
    }
    lline += ls.length
    rline += rs.length
  }
  if (!seenUnchanged) {
    const p = { line: 0, start: 0, end: 0 }
    lhs.unshift({ kind: MK_UNCHANGED, pos: p, selfPos: [p], oppPos: [p] })
    rhs.unshift({ kind: MK_UNCHANGED, pos: p, selfPos: [p], oppPos: [p] })
  }
  return [lhs, rhs]
}
