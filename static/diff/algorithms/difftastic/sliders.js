// Port of difftastic's src/diff/sliders.rs: prefer contiguous novel nodes.

import { CK_NOVEL, CK_REPLACED_COMMENT, CK_REPLACED_STRING, CK_UNCHANGED, insertDeepNovel, insertDeepUnchanged, setChange } from './syntax.js'

// Languages where nested sliders should keep the outer delimiter.
const PREFER_OUTER = new Set(['EmacsLisp', 'Clojure', 'CommonLisp', 'Janet', 'Racket', 'Scheme', 'Newick', 'Json', 'Toml', 'Hcl', 'Sql'])

export function fixAllSliders(language, nodes) {
  fixAllSlidersOneStep(nodes)
  fixAllSlidersOneStep(nodes)
  const outer = PREFER_OUTER.has(language)
  for (const node of nodes) {
    if (outer) fixNestedSliderPreferOuter(node)
    else fixNestedSliderPreferInner(node)
  }
}

function fixAllSlidersOneStep(nodes) {
  for (const n of nodes) if (n.isList) fixAllSlidersOneStep(n.children)
  fixSliders(nodes)
}

function fixNestedSliderPreferOuter(node) {
  if (!node.isList) return
  if (node.ck === CK_UNCHANGED) {
    const candidates = []
    unchangedDescendantsForOuterSlider(node.children, candidates)
    if (candidates.length === 1) {
      const c = candidates[0]
      if (c.isList && c.ck === CK_NOVEL) pushUnchangedToDescendant(node, c)
    }
  }
  for (const c of node.children) fixNestedSliderPreferOuter(c)
}

function fixNestedSliderPreferInner(node) {
  if (!node.isList) return
  if (node.ck === CK_NOVEL) {
    const found = []
    unchangedDescendants(node.children, found)
    if (found.length === 1 && found[0].isList) pushUnchangedToAncestor(node, found[0])
  }
  for (const c of node.children) fixNestedSliderPreferInner(c)
}

function unchangedDescendants(nodes, found) {
  if (found.length > 1) return
  for (const n of nodes) {
    if (n.ck === CK_UNCHANGED) found.push(n)
    else if (n.ck === CK_NOVEL || n.ck === CK_REPLACED_COMMENT || n.ck === CK_REPLACED_STRING) {
      if (n.isList) unchangedDescendants(n.children, found)
    }
  }
}

function unchangedDescendantsForOuterSlider(nodes, found) {
  if (found.length > 1) return
  for (const n of nodes) {
    const isUnchanged = n.ck === CK_UNCHANGED
    if (!n.isList) {
      if (isUnchanged) {
        found.push(n)
        break
      }
      continue
    }
    if (isUnchanged) {
      found.push(n)
      break
    }
    if (n.children.some((c) => c.ck === CK_UNCHANGED)) found.push(n)
    else unchangedDescendantsForOuterSlider(n.children, found)
  }
}

const sameDelims = (a, b) => a.isList && b.isList && a.openContent === b.openContent && a.closeContent === b.closeContent

function pushUnchangedToDescendant(root, inner) {
  if (!sameDelims(root, inner)) return
  const ck = root.ck
  const opp = root.opp
  setChange(root, CK_NOVEL)
  setChange(inner, ck, opp)
}

function pushUnchangedToAncestor(root, inner) {
  if (!sameDelims(root, inner)) return
  const ck = inner.ck
  const opp = inner.opp
  setChange(root, ck, opp)
  setChange(inner, CK_NOVEL)
}

function fixSliders(nodes) {
  for (const [s, e] of novelRegionsAfterUnchanged(nodes)) slideToPrevNode(nodes, s, e)
  for (const [s, e] of novelRegionsBeforeUnchanged(nodes)) slideToNextNode(nodes, s, e)
}

function novelRegionsAfterUnchanged(nodes) {
  const regions = []
  let region = null
  nodes.forEach((n, i) => {
    const ck = n.ck
    if (ck === CK_UNCHANGED) {
      if (region) regions.push(region)
      region = []
    } else if (ck === CK_NOVEL) {
      if (region) region.push(i)
    } else if (ck === CK_REPLACED_COMMENT || ck === CK_REPLACED_STRING) {
      if (region) regions.push(region)
      region = null
    }
  })
  if (region) regions.push(region)
  return regions.filter((r) => r.length).map((r) => [r[0], r[r.length - 1]])
}

function novelRegionsBeforeUnchanged(nodes) {
  const regions = []
  let region = null
  nodes.forEach((n, i) => {
    const ck = n.ck
    if (ck === CK_UNCHANGED) {
      if (region) regions.push(region)
      region = null
    } else if (ck === CK_NOVEL) {
      region ||= []
      region.push(i)
    } else if (ck === CK_REPLACED_COMMENT || ck === CK_REPLACED_STRING) {
      region = null
    }
  })
  if (region) regions.push(region)
  return regions.filter((r) => r.length).map((r) => [r[0], r[r.length - 1]])
}

function isNovelDeep(node) {
  if (node.ck !== CK_NOVEL) return false
  if (node.isList) for (const c of node.children) if (!isNovelDeep(c)) return false
  return true
}

function slideToPrevNode(nodes, startIdx, endIdx) {
  if (startIdx === 0 || startIdx === endIdx) return
  const startNode = nodes[startIdx]
  const lastNode = nodes[endIdx]
  const beforeStart = nodes[startIdx - 1]
  const beforeLast = nodes[endIdx - 1]
  if (beforeStart.contentId !== lastNode.contentId) return
  if (cmpDistance(distanceBetween(beforeStart, startNode), distanceBetween(beforeLast, lastNode)) <= 0) {
    if (beforeStart.ck !== CK_UNCHANGED) return
    const opposite = beforeStart.opp
    if (beforeStart.contentId !== opposite.contentId) return
    for (let i = startIdx; i <= endIdx; i++) if (!isNovelDeep(nodes[i])) return
    insertDeepNovel(beforeStart)
    insertDeepUnchanged(lastNode, opposite)
    insertDeepUnchanged(opposite, lastNode)
  }
}

function slideToNextNode(nodes, startIdx, endIdx) {
  if (endIdx === nodes.length - 1 || startIdx === endIdx) return
  const startNode = nodes[startIdx]
  const lastNode = nodes[endIdx]
  const afterStart = nodes[startIdx + 1]
  const afterLast = nodes[endIdx + 1]
  if (afterLast.contentId !== startNode.contentId) return
  if (cmpDistance(distanceBetween(lastNode, afterLast), distanceBetween(startNode, afterStart)) < 0) {
    if (afterLast.ck !== CK_UNCHANGED) return
    const opposite = afterLast.opp
    if (afterLast.contentId !== opposite.contentId) return
    for (let i = startIdx; i <= endIdx; i++) if (!isNovelDeep(nodes[i])) return
    insertDeepUnchanged(startNode, opposite)
    insertDeepUnchanged(opposite, startNode)
    insertDeepNovel(afterLast)
  }
}

const cmpDistance = (a, b) => (a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1])

// (lines, columns) between two nodes; u32 arithmetic as in Rust.
function distanceBetween(prev, next) {
  const p = lastLineSpan(prev)
  const n = firstLineSpan(next)
  if (p && n) {
    if (p.line !== n.line) return [(n.line - p.line) >>> 0, 0]
    return [0, (n.start - p.end) >>> 0]
  }
  return [0, 0]
}

function firstLineSpan(node) {
  if (!node.isList) return node.position[0] || null
  if (node.openPosition.length) return node.openPosition[0]
  for (const c of node.children) {
    const s = firstLineSpan(c)
    if (s) return s
  }
  return node.closePosition[0] || null
}

function lastLineSpan(node) {
  if (!node.isList) return node.position[node.position.length - 1] || null
  if (node.closePosition.length) return node.closePosition[node.closePosition.length - 1]
  for (let i = node.children.length - 1; i >= 0; i--) {
    const s = lastLineSpan(node.children[i])
    if (s) return s
  }
  return node.openPosition[node.openPosition.length - 1] || null
}

