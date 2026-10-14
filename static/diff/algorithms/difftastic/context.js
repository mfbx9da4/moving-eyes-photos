// Port of difftastic's line alignment (src/display/context.rs
// all_matched_lines_filled and helpers). Lines are numbers, -1 means absent.

import { MK_UNCHANGED, MK_UNCHANGED_PART } from './syntax.js'

/**
 * @returns {Array<[number, number]>} aligned (lhs, rhs) line pairs, -1 = none
 */
export function allMatchedLinesFilled(lhsMps, rhsMps, lhsLines, rhsLines) {
  const matched = addEnds(allMatchedLines(lhsMps, rhsMps), lhsLines, rhsLines)
  return compactGaps(ensureContiguous(matchPrecedingBlanks(matched, lhsLines, rhsLines)))
}

function addEnds(matched, lhsLines, rhsLines) {
  let lhsMin = -1
  let rhsMin = -1
  for (const [l, r] of matched) {
    if (lhsMin < 0 && l >= 0) lhsMin = l
    if (rhsMin < 0 && r >= 0) rhsMin = r
    if (lhsMin >= 0 && rhsMin >= 0) break
  }
  let lhsMax = -1
  let rhsMax = -1
  for (let i = matched.length - 1; i >= 0; i--) {
    const [l, r] = matched[i]
    if (lhsMax < 0 && l >= 0) lhsMax = l
    if (rhsMax < 0 && r >= 0) rhsMax = r
    if (lhsMax >= 0 && rhsMax >= 0) break
  }
  const res = []
  if (lhsMin >= 0 && rhsMin >= 0) {
    let l = 0
    let r = 0
    while (l < lhsMin && r < rhsMin) res.push([l++, r++])
    while (l < lhsMin) res.push([l++, -1])
    while (r < rhsMin) res.push([-1, r++])
  }
  for (const m of matched) res.push(m)
  if (lhsMax >= 0 && rhsMax >= 0) {
    let l = lhsMax + 1
    let r = rhsMax + 1
    while (l < lhsLines.length && r < rhsLines.length) res.push([l++, r++])
    while (l < lhsLines.length) res.push([l++, -1])
    while (r < rhsLines.length) res.push([-1, r++])
  }
  return res
}

function allMatchedLines(lhsMps, rhsMps) {
  const lhsMatched = matchedLinesFromUnchanged(lhsMps)
  const lines = mergeInOppositeLines(lhsMatched, allLines(rhsMps))
  return flip(mergeInOppositeLines(flip(lines), allLines(lhsMps)))
}

const flip = (pairs) => pairs.map(([a, b]) => [b, a])

function allLines(mps) {
  const set = new Set()
  for (const mp of mps) set.add(mp.pos.line)
  return Array.from(set).sort((a, b) => a - b)
}

function matchedLinesFromUnchanged(mps) {
  let highest = -1
  let highestOpp = -1
  const res = []
  for (const mp of mps) {
    let opp = -1
    if (mp.kind === MK_UNCHANGED || mp.kind === MK_UNCHANGED_PART) {
      const oppPos = mp.oppPos
      if (highestOpp >= 0) {
        for (const p of oppPos) {
          if (p.line > highestOpp) {
            opp = p.line
            break
          }
        }
      } else if (oppPos.length) opp = oppPos[0].line
    }
    const shouldInsert = highest < 0 || mp.pos.line > highest
    if (shouldInsert && opp >= 0) {
      res.push([mp.pos.line, opp])
      highest = mp.pos.line
      highestOpp = opp
    }
  }
  return res
}

function mergeInOppositeLines(matched, novelOpp) {
  const res = []
  let i = 0
  for (const [line, opp] of matched) {
    if (opp >= 0) {
      while (i < novelOpp.length) {
        const n = novelOpp[i]
        if (n < opp) res.push([-1, n])
        else if (n > opp) break
        i++
      }
    }
    res.push([line, opp])
  }
  while (i < novelOpp.length) res.push([-1, novelOpp[i++]])
  return res
}

function matchBlanksBetween(cur, prev, lhsLines, rhsLines) {
  let [l, r] = cur
  if (l === 0 || r === 0) return []
  l--
  r--
  const res = []
  while (l > prev[0] && r > prev[1]) {
    if (lhsLines[l] === '' && rhsLines[r] === '') {
      res.push([l, r])
      l--
      r--
    } else break
  }
  return res.reverse()
}

function matchBlanksBefore(cur, lhsLines, rhsLines) {
  let [l, r] = cur
  if (l === 0 || r === 0) return []
  l--
  r--
  const res = []
  for (;;) {
    if (lhsLines[l] === '' && rhsLines[r] === '') {
      res.push([l, r])
      if (l === 0 || r === 0) break
      l--
      r--
    } else break
  }
  return res.reverse()
}

function matchPrecedingBlanks(lines, lhsLines, rhsLines) {
  let prevL = -1
  let prevR = -1
  const res = []
  for (const [l, r] of lines) {
    if (l >= 0 && r >= 0) {
      if (prevL < 0 && prevR < 0) res.push(...matchBlanksBefore([l, r], lhsLines, rhsLines))
      else if (prevL >= 0 && prevR >= 0) res.push(...matchBlanksBetween([l, r], [prevL, prevR], lhsLines, rhsLines))
    }
    res.push([l, r])
    if (l >= 0) prevL = l
    if (r >= 0) prevR = r
  }
  return res
}

function ensureContiguous(lines) {
  const res = []
  let lMin = -1
  let rMin = -1
  for (const [l, r] of lines) {
    if (l >= 0) {
      if (lMin >= 0 && lMin + 1 !== l) for (let x = lMin + 1; x < l; x++) res.push([x, -1])
      lMin = l
    }
    if (r >= 0) {
      if (rMin >= 0 && rMin + 1 !== r) for (let x = rMin + 1; x < r; x++) res.push([-1, x])
      rMin = r
    }
    res.push([l, r])
  }
  return res
}

function compactGaps(items) {
  const res = []
  let unpaired = []
  for (const [l, r] of items) {
    if (l >= 0 && r < 0) {
      if (unpaired.length && unpaired[0][0] < 0) {
        res.push([l, unpaired[0][1]])
        unpaired.shift()
      } else unpaired.push([l, -1])
    } else if (l < 0 && r >= 0) {
      if (unpaired.length && unpaired[0][1] < 0) {
        res.push([unpaired[0][0], r])
        unpaired.shift()
      } else unpaired.push([-1, r])
    } else {
      res.push(...unpaired)
      unpaired = []
      res.push([l, r])
    }
  }
  res.push(...unpaired)
  return res
}

