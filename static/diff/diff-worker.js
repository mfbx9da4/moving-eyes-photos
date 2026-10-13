// Diff worker: every diff algorithm runs here, off the main thread.
//
// Request:  { type: 'diff', id, oldText, newText, algorithm, whitespace }
// Replies:  { type: 'result', id, oldStarts, newStarts, changes, ms, note }
//           { type: 'inline', id, old: Int32Array, new: Int32Array, done }
//           { type: 'error', id, message }
// Inline payloads are flat [line, rangeCount, start, end, ...] per side.

import { intralineForGroup } from './algorithms/intraline.js'
import { internLines, lineStarts } from './algorithms/lines.js'
import { measureIndent, xdiff } from './algorithms/xdiff.js'

const JSDIFF_URL = 'https://esm.sh/diff@9.0.0'
const XDIFF_ALGORITHMS = new Set(['myers', 'minimal', 'patience', 'histogram'])

let latest = 0

self.onmessage = (e) => {
  const msg = e.data
  if (msg.type !== 'diff') return
  latest = msg.id
  run(msg).catch((err) => {
    console.error(err)
    self.postMessage({ type: 'error', id: msg.id, message: String((err && err.message) || err) })
  })
}

const lineGetter = (text, starts) => (i) => {
  let end = starts[i + 1]
  if (end > starts[i] && text.charCodeAt(end - 1) === 10) end--
  if (end > starts[i] && text.charCodeAt(end - 1) === 13) end--
  return text.slice(starts[i], end)
}

async function run(msg) {
  const { id, oldText, newText, algorithm, whitespace } = msg
  const t0 = performance.now()
  const oldStarts = lineStarts(oldText)
  const newStarts = lineStarts(newText)
  let changes
  let inline = null
  let note = ''

  if (XDIFF_ALGORITHMS.has(algorithm)) {
    const { a, b, nclasses } = internLines(oldText, oldStarts, newText, newStarts, whitespace || null)
    changes = xdiff(a, b, {
      algorithm,
      nclasses,
      indent1: (i) => measureIndent(oldText, oldStarts[i], oldStarts[i + 1]),
      indent2: (i) => measureIndent(newText, newStarts[i], newStarts[i + 1]),
    })
  } else if (algorithm === 'jsdiff') {
    ;({ changes, note } = await jsdiffLines(oldText, newText, whitespace))
  } else if (algorithm === 'difftastic') {
    try {
      const { difftastic } = await import('./algorithms/difftastic/index.js')
      ;({ changes, inline, note } = await difftastic(oldText, oldStarts, newText, newStarts, msg))
    } catch (err) {
      console.error(err)
      const { a, b, nclasses } = internLines(oldText, oldStarts, newText, newStarts, null)
      changes = xdiff(a, b, { algorithm: 'myers', nclasses })
      inline = null
      note = `difftastic failed (${(err && err.message) || err}), showing git’s diff instead`
    }
  } else {
    throw new Error(`Unknown algorithm ${algorithm}`)
  }

  const ms = performance.now() - t0
  const oldCopy = oldStarts.slice()
  const newCopy = newStarts.slice()
  const changesCopy = changes.slice()
  self.postMessage({ type: 'result', id, oldStarts: oldCopy, newStarts: newCopy, changes: changesCopy, ms, note }, [
    oldCopy.buffer,
    newCopy.buffer,
    changesCopy.buffer,
  ])

  if (inline) {
    self.postMessage({ type: 'inline', id, old: inline.old, new: inline.new, done: true }, [
      inline.old.buffer,
      inline.new.buffer,
    ])
    return
  }
  await streamIntraline(id, algorithm, oldText, oldStarts, newText, newStarts, changes, whitespace)
}

// Compute word highlights group by group, posting batches so the first
// screen fills quickly, and stop as soon as a newer request arrives.
async function streamIntraline(id, algorithm, oldText, oldStarts, newText, newStarts, changes, whitespace) {
  const getOld = lineGetter(oldText, oldStarts)
  const getNew = lineGetter(newText, newStarts)
  const pairFn = algorithm === 'jsdiff' ? await jsdiffPairFn() : intralineForGroup
  let oldOut = []
  let newOut = []
  let last = performance.now()
  const flush = (done) => {
    const o = Int32Array.from(oldOut)
    const n = Int32Array.from(newOut)
    oldOut = []
    newOut = []
    self.postMessage({ type: 'inline', id, old: o, new: n, done }, [o.buffer, n.buffer])
  }
  for (let c = 0; c < changes.length; c += 4) {
    const n1 = changes[c + 1]
    const n2 = changes[c + 3]
    if (!n1 || !n2) continue
    const pairs = pairFn(getOld, getNew, changes[c], n1, changes[c + 2], n2, whitespace)
    for (const [ol, or, nl, nr] of pairs) {
      if (or.length) oldOut.push(ol, or.length / 2, ...or)
      if (nr.length) newOut.push(nl, nr.length / 2, ...nr)
    }
    if (performance.now() - last > 30) {
      flush(false)
      await new Promise((r) => setTimeout(r, 0))
      if (latest !== id) return
      last = performance.now()
    }
  }
  flush(true)
}

let jsdiffModule
async function loadJsdiff() {
  jsdiffModule ||= await import(JSDIFF_URL)
  return jsdiffModule
}

// jsdiff's diffLines, converted to change groups.
async function jsdiffLines(oldText, newText, whitespace) {
  const { diffLines } = await loadJsdiff()
  const parts = diffLines(oldText, newText, { ignoreWhitespace: !!whitespace, timeout: 20000 })
  if (!parts) {
    // jsdiff gave up (timeout): everything changed
    const n1 = lineStarts(oldText).length - 1
    const n2 = lineStarts(newText).length - 1
    return { changes: Int32Array.of(0, n1, 0, n2), note: 'jsdiff timed out after 20s, showing a full replacement' }
  }
  const out = []
  let o = 0
  let n = 0
  let g = null
  for (const p of parts) {
    if (p.added || p.removed) {
      g ||= [o, 0, n, 0]
      if (p.removed) {
        g[1] += p.count
        o += p.count
      } else {
        g[3] += p.count
        n += p.count
      }
      continue
    }
    if (g) out.push(...g)
    g = null
    o += p.count
    n += p.count
  }
  if (g) out.push(...g)
  return { changes: Int32Array.from(out), note: '' }
}

// jsdiff's diffWordsWithSpace for the paired lines of a change group.
async function jsdiffPairFn() {
  const { diffWordsWithSpace } = await loadJsdiff()
  return (getOld, getNew, i1, n1, i2, n2) => {
    const out = []
    for (let k = 0; k < Math.min(n1, n2); k++) {
      const os = getOld(i1 + k)
      const ns = getNew(i2 + k)
      if (os.length > 10000 || ns.length > 10000) continue
      const parts = diffWordsWithSpace(os, ns)
      const oldR = []
      const newR = []
      let o = 0
      let n = 0
      let common = 0
      for (const p of parts) {
        const len = p.value.length
        if (p.removed) {
          oldR.push(o, o + len)
          o += len
        } else if (p.added) {
          newR.push(n, n + len)
          n += len
        } else {
          if (p.value.trim()) common++
          o += len
          n += len
        }
      }
      if (common) out.push([i1 + k, oldR, i2 + k, newR])
    }
    return out
  }
}
