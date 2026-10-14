// Hunk construction mirroring git's xdl_emit_diff(): changes separated by at
// most 2 * context + inter-hunk context lines share a hunk, and the hunk header
// carries the nearest preceding "function" line of the old file. GitHub runs
// the equivalent of `git diff -U3 --inter-hunk-context=1` and uses git's
// python/ruby funcname drivers for those languages.

/**
 * @param {Int32Array} changes flat [i1, n1, i2, n2, ...] in file order
 * @returns {{c0: number, c1: number, s1: number, e1: number, s2: number, e2: number}[]}
 *   c0..c1 is the range of change groups (indices into changes / 4)
 */
export function groupHunks(changes, n1, n2, ctx, interHunk = 0) {
  const hunks = []
  const nchg = changes.length / 4
  const maxCommon = 2 * ctx + interHunk
  let k = 0
  while (k < nchg) {
    const first = k
    while (k + 1 < nchg) {
      const prevEnd = changes[k * 4] + changes[k * 4 + 1]
      if (changes[(k + 1) * 4] - prevEnd > maxCommon) break
      k++
    }
    const i1 = changes[first * 4]
    const i2 = changes[first * 4 + 2]
    const last1 = changes[k * 4] + changes[k * 4 + 1]
    const last2 = changes[k * 4 + 2] + changes[k * 4 + 3]
    const lctx = Math.min(ctx, n1 - last1, n2 - last2)
    hunks.push({
      c0: first,
      c1: k + 1,
      s1: Math.max(i1 - ctx, 0),
      s2: Math.max(i2 - ctx, 0),
      e1: last1 + lctx,
      e2: last2 + lctx,
    })
    k++
  }
  return hunks
}

// git's builtin userdiff funcname patterns (userdiff.c) for the drivers
// GitHub applies; group 1 is the text shown.
export const FUNCNAME_DRIVERS = {
  python: /^[ \t]*((class|(async[ \t]+)?def)[ \t][^]*)$/,
  ruby: /^[ \t]*((class|module|def)[ \t][^]*)$/,
}

// Cut to at most 80 bytes of UTF-8 (git's func_line buffer), then drop
// trailing whitespace.
function clip(text, start, end) {
  let bytes = 0
  let i = start
  for (; i < end; i++) {
    const code = text.codePointAt(i)
    const size = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
    if (bytes + size > 80) break
    bytes += size
    if (code > 0xffff) i++
  }
  let j = i
  while (j > start && /\s/.test(text[j - 1])) j--
  return text.slice(start, j)
}

// git's def_ff(): a line starting with a letter, "_" or "$". With a driver,
// git's ff_regexp() on the line without its terminator.
export function funcLine(text, start, end, driver) {
  if (end <= start) return null
  if (driver) {
    let e = end
    if (text.charCodeAt(e - 1) === 10) e--
    if (e > start && text.charCodeAt(e - 1) === 13) e--
    const m = driver.exec(text.slice(start, e))
    if (!m) return null
    const s = start + m.index + (m[1] !== undefined ? m[0].indexOf(m[1]) : 0)
    return clip(text, s, s + (m[1] !== undefined ? m[1] : m[0]).length)
  }
  const c = text.charCodeAt(start)
  const isAlpha = (c >= 65 && c <= 90) || (c >= 97 && c <= 122)
  if (!isAlpha && c !== 95 && c !== 36) return null
  return clip(text, start, end)
}

// Nearest function line strictly before old line `s1` (searching back from
// s1 - 1). `cache` maps a line to the nearest function line at or before it.
export function findFuncName(text, starts, s1, cache, driver) {
  let found = ''
  for (let l = s1 - 1; l >= 0; l--) {
    if (cache && cache.has(l)) {
      found = cache.get(l)
      break
    }
    const f = funcLine(text, starts[l], starts[l + 1], driver)
    if (f !== null) {
      found = f
      break
    }
  }
  if (cache && s1 > 0) cache.set(s1 - 1, found)
  return found
}

export function formatRange(s, c) {
  const start = c ? s + 1 : s
  return c === 1 ? `${start}` : `${start},${c}`
}

export function hunkHeader(s1, c1, s2, c2, func) {
  return `@@ -${formatRange(s1, c1)} +${formatRange(s2, c2)} @@${func ? ' ' + func : ''}`
}
