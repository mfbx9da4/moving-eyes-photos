// Line splitting and interning shared by the diff algorithms.

/**
 * Compute line start offsets. Line i spans [starts[i], starts[i + 1]) and
 * includes its trailing "\n" when present (like git's records).
 * @param {string} text
 * @returns {Int32Array} starts, length = lineCount + 1
 */
export function lineStarts(text) {
  const len = text.length
  let count = 0
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) count++
  const lines = len === 0 ? 0 : text.charCodeAt(len - 1) === 10 ? count : count + 1
  const starts = new Int32Array(lines + 1)
  let n = 1
  for (let i = text.indexOf('\n'); i !== -1 && n < lines; i = text.indexOf('\n', i + 1)) starts[n++] = i + 1
  starts[lines] = len
  return starts
}

const WS = /[ \t\f\v\r\n]/

// Normalizers matching git's whitespace options (xdl_hash_record_with_whitespace).
export const whitespaceModes = {
  // --ignore-all-space (-w), what GitHub's "Hide whitespace" uses.
  all: (s) => s.replace(/[ \t\f\v\r]+/g, ''),
  // --ignore-space-change (-b)
  change: (s) => s.replace(/[ \t\f\v\r]+(?=\n|$)/g, '').replace(/[ \t\f\v\r]+/g, ' '),
  // --ignore-space-at-eol
  eol: (s) => s.replace(/[ \t\f\v\r]+(?=\n|$)/g, ''),
}

/**
 * Assign each line an equivalence class id. Both files share one table so
 * that equal ids mean equal lines.
 */
export function internLines(oldText, oldStarts, newText, newStarts, whitespace) {
  const norm = whitespace ? whitespaceModes[whitespace] : null
  const table = new Map()
  const intern = (text, starts) => {
    const n = starts.length - 1
    const ids = new Int32Array(n)
    for (let i = 0; i < n; i++) {
      let key = text.slice(starts[i], starts[i + 1])
      if (norm) key = norm(key)
      let id = table.get(key)
      if (id === undefined) {
        id = table.size
        table.set(key, id)
      }
      ids[i] = id
    }
    return ids
  }
  const a = intern(oldText, oldStarts)
  const b = intern(newText, newStarts)
  return { a, b, nclasses: table.size }
}

export function isBlankLine(text, start, end) {
  for (let i = start; i < end; i++) if (!WS.test(text[i])) return false
  return true
}
