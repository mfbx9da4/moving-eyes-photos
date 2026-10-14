// difftastic (https://github.com/Wilfred/difftastic) ported to the browser:
// tree-sitter parse -> syntax trees -> unchanged preprocessing -> Dijkstra
// over the diff graph -> slider fixes -> matched positions -> line alignment.
// The result is converted to the page's line-based model: aligned line pairs
// without novel tokens are unchanged, everything else forms change blocks,
// and novel tokens become word highlights.

import { detectLanguage, guessFromContent } from '../../language.js'
import { allMatchedLinesFilled } from './context.js'
import { ExceededGraphLimit, markSyntax } from './graph.js'
import { textChangePositions } from './lineParser.js'
import { TreeSitterHost, cdnIO, configForLinguist, toSyntax } from './parser.js'
import { fixAllSliders } from './sliders.js'
import { MK_NOVEL, MK_NOVEL_WORD, MK_UNCHANGED, MK_UNCHANGED_PART, changePositions, initAllInfo, initNextPrev, isNovelMatch } from './syntax.js'
import { markUnchanged } from './unchanged.js'

// difftastic's defaults, except the graph limit: 3,000,000 vertices is more
// memory than a browser worker should take.
export const BYTE_LIMIT = 1_000_000
export const GRAPH_LIMIT = 1_000_000
export const PARSE_ERROR_LIMIT = 0

let host = null
export function setTreeSitterHost(h) {
  host = h
}
function getHost() {
  host ||= new TreeSitterHost(cdnIO())
  return host
}

function utf8Length(s) {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4
      i++
    } else n += 3
  }
  return n
}

function formatSize(bytes) {
  // humansize BINARY with one decimal place, as difftastic prints it
  const units = ['B', 'KiB', 'MiB', 'GiB']
  let v = bytes
  let u = 0
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024
    u++
  }
  return u === 0 ? `${v} B` : `${v.toFixed(1)} ${units[u]}`
}

/**
 * Run difftastic on two sources and return its matched positions.
 * @returns {Promise<{lhs, rhs, lhsSrc, rhsSrc, language, note, identical}>}
 */
export async function difftasticPositions(lhsSrc, rhsSrc, linguistName, { graphLimit = GRAPH_LIMIT, byteLimit = BYTE_LIMIT } = {}) {
  // difftastic ensures both sides end in a newline
  if (lhsSrc && !lhsSrc.endsWith('\n')) lhsSrc += '\n'
  if (rhsSrc && !rhsSrc.endsWith('\n')) rhsSrc += '\n'
  const base = { lhsSrc, rhsSrc, language: linguistName || null }
  if (lhsSrc === rhsSrc) return { ...base, identical: true, lhs: [], rhs: [], note: '' }

  const text = (note) => {
    const [lhs, rhs] = textChangePositions(lhsSrc, rhsSrc)
    return { ...base, lhs, rhs, note, text: true }
  }

  const cfgName = configForLinguist(linguistName)
  if (!cfgName) return text(linguistName ? `difftastic has no ${linguistName} parser here, showing its text diff` : 'no language detected, showing difftastic’s text diff')

  const size = Math.max(utf8Length(lhsSrc), utf8Length(rhsSrc))
  if (size > byteLimit) return text(`${formatSize(size)} exceeded DFT_BYTE_LIMIT, showing difftastic’s text diff`)

  const h = getHost()
  const l = await toSyntax(h, cfgName, lhsSrc)
  const r = await toSyntax(h, cfgName, rhsSrc)
  initAllInfo(l.nodes, r.nodes)
  const errors = l.errors + r.errors
  if (errors > PARSE_ERROR_LIMIT) {
    const first = r.firstError ? [...r.firstError, ''] : l.firstError ? [...l.firstError, ' in initial file'] : null
    const where = first ? `, first at ${first[0] + 1}:${first[1]}${first[2]}` : ''
    return text(`${errors} ${linguistName} parse error${errors === 1 ? '' : 's'}, exceeded DFT_PARSE_ERROR_LIMIT${where}`)
  }

  const sections = markUnchanged(l.nodes, r.nodes)
  try {
    for (const [ls, rs] of sections) {
      initNextPrev(ls)
      initNextPrev(rs)
      markSyntax(ls[0] || null, rs[0] || null, graphLimit)
    }
  } catch (e) {
    if (e instanceof ExceededGraphLimit) return text('exceeded DFT_GRAPH_LIMIT, showing difftastic’s text diff')
    throw e
  }
  fixAllSliders(cfgName, l.nodes)
  fixAllSliders(cfgName, r.nodes)
  return { ...base, lhs: changePositions(l.nodes), rhs: changePositions(r.nodes), note: '' }
}

// Novel token ranges for word highlights, per line. Lines whose content is
// novel throughout get no word highlights (like fully added lines on GitHub).
function inlineFromPositions(mps, text, starts, nLines) {
  const byLine = new Map()
  const hasUnchanged = new Set()
  for (const mp of mps) {
    if (mp.pos.line >= nLines) continue
    if (mp.kind === MK_UNCHANGED || mp.kind === MK_UNCHANGED_PART) {
      if (mp.pos.end > mp.pos.start) hasUnchanged.add(mp.pos.line)
      continue
    }
    if (mp.kind !== MK_NOVEL && mp.kind !== MK_NOVEL_WORD) continue
    if (mp.pos.end <= mp.pos.start) continue
    let list = byLine.get(mp.pos.line)
    if (!list) byLine.set(mp.pos.line, (list = []))
    list.push(mp.pos.start, mp.pos.end)
  }
  const out = []
  for (const [line, flat] of byLine) {
    if (!hasUnchanged.has(line)) continue
    const lineText = text.slice(starts[line], starts[line + 1])
    const pairs = []
    for (let i = 0; i < flat.length; i += 2) pairs.push([flat[i], flat[i + 1]])
    pairs.sort((a, b) => a[0] - b[0] || a[1] - b[1])
    const merged = []
    for (const [s, e] of pairs) {
      const last = merged[merged.length - 1]
      if (last && (s <= last[1] || /^[ \t]*$/.test(lineText.slice(last[1], s)))) last[1] = Math.max(last[1], e)
      else merged.push([s, e])
    }
    out.push(line, merged.length)
    for (const [s, e] of merged) out.push(s, e)
  }
  return Int32Array.from(out)
}

/**
 * Worker entry point: returns change groups plus word highlights.
 */
export async function difftastic(oldText, oldStarts, newText, newStarts, msg) {
  const name = msg.newName || msg.oldName || ''
  const det = detectLanguage(name, newText) || (name ? null : (() => {
    const g = guessFromContent(newText)
    return g ? { lang: g, strategy: 'guess' } : null
  })())
  const res = await difftasticPositions(oldText, newText, det ? det.lang.name : null)
  const n1 = oldStarts.length - 1
  const n2 = newStarts.length - 1
  if (res.identical) {
    const changes = n1 === n2 ? new Int32Array(0) : Int32Array.of(0, n1, 0, n2)
    return { changes, inline: { old: new Int32Array(0), new: new Int32Array(0) }, note: 'difftastic found no changes' }
  }

  const lhsLines = res.lhsSrc.split('\n')
  const rhsLines = res.rhsSrc.split('\n')
  const aligned = allMatchedLinesFilled(res.lhs, res.rhs, lhsLines, rhsLines)
  const novelL = new Set()
  const novelR = new Set()
  for (const mp of res.lhs) if (isNovelMatch(mp.kind)) novelL.add(mp.pos.line)
  for (const mp of res.rhs) if (isNovelMatch(mp.kind)) novelR.add(mp.pos.line)

  // aligned rows -> change groups
  const out = []
  let o = 0
  let n = 0
  let g = null
  for (let [l, r] of aligned) {
    if (l >= n1) l = -1
    if (r >= n2) r = -1
    if (l < 0 && r < 0) continue
    if ((l >= 0 && l !== o) || (r >= 0 && r !== n)) throw new Error('difftastic alignment is not monotone')
    const equal = l >= 0 && r >= 0 && !novelL.has(l) && !novelR.has(r)
    if (equal) {
      if (g) out.push(...g)
      g = null
      o++
      n++
      continue
    }
    g ||= [o, 0, n, 0]
    if (l >= 0) {
      g[1]++
      o++
    }
    if (r >= 0) {
      g[3]++
      n++
    }
  }
  if (g) out.push(...g)
  if (o !== n1 || n !== n2) throw new Error('difftastic alignment does not cover every line')

  const lang = det ? `${det.lang.name}${det.strategy === 'guess' ? ' (guessed)' : ''}` : ''
  let note = res.note || (res.text ? '' : `structural diff of ${lang}`)
  if (!res.text && !novelL.size && !novelR.size) note = `no syntactic changes in ${lang}, only formatting`
  return {
    changes: Int32Array.from(out),
    inline: { old: inlineFromPositions(res.lhs, oldText, oldStarts, n1), new: inlineFromPositions(res.rhs, newText, newStarts, n2) },
    note: `difftastic: ${note}`,
  }
}
