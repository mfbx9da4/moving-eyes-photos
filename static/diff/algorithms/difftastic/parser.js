// Port of difftastic's tree-sitter conversion (src/parse/tree_sitter_parser.rs)
// using web-tree-sitter and the official grammar builds from npm, pinned to
// the versions difftastic 0.71.0 links. Columns are UTF-16 code units.

import { ATOM_CAN_IGNORE, ATOM_COMMENT, ATOM_ERROR, ATOM_KEYWORD, ATOM_NORMAL, ATOM_STRING, ATOM_TEXT, ATOM_TYPE, LinePositions, newAtom, newList } from './syntax.js'

const JS_TRAILING = ['object', 'object_pattern', 'array', 'array_pattern', 'arguments', 'formal_parameters', 'named_imports']

const pkg = (name, version, wasm, queries) => ({
  wasm: `${name}@${version}/${wasm}`,
  queries: queries.map((q) => (q.includes('@') ? q : `${name}@${version}/${q}`)),
})

// difftastic Language name -> config. `linguist` lists the linguist
// languages (as detected for the page) that map onto it.
export const CONFIGS = {
  Bash: {
    linguist: ['Shell'],
    ...pkg('tree-sitter-bash', '0.25.1', 'tree-sitter-bash.wasm', ['queries/highlights.scm']),
    atoms: ['string', 'raw_string', 'heredoc_body', 'simple_expansion'],
    delims: [['(', ')'], ['{', '}'], ['[', ']']],
    trailing: [],
  },
  C: {
    linguist: ['C'],
    ...pkg('tree-sitter-c', '0.24.1', 'tree-sitter-c.wasm', ['queries/highlights.scm']),
    atoms: ['string_literal', 'char_literal'],
    delims: [['(', ')'], ['{', '}'], ['[', ']']],
    trailing: [],
  },
  CPlusPlus: {
    linguist: ['C++'],
    ...pkg('tree-sitter-cpp', '0.23.4', 'tree-sitter-cpp.wasm', ['tree-sitter-c@0.24.1/queries/highlights.scm', 'queries/highlights.scm']),
    atoms: ['string_literal', 'char_literal', 'raw_string_literal'],
    delims: [['(', ')'], ['{', '}'], ['[', ']'], ['<', '>']],
    trailing: [],
  },
  CSharp: {
    linguist: ['C#'],
    ...pkg('tree-sitter-c-sharp', '0.23.1', 'tree-sitter-c_sharp.wasm', ['queries/highlights.scm']),
    atoms: ['string_literal', 'verbatim_string_literal', 'character_literal', 'modifier'],
    delims: [['{', '}'], ['(', ')']],
    trailing: [],
  },
  Css: {
    linguist: ['CSS'],
    ...pkg('tree-sitter-css', '0.25.0', 'tree-sitter-css.wasm', ['queries/highlights.scm']),
    atoms: ['integer_value', 'float_value', 'color_value', 'string_value'],
    delims: [['{', '}'], ['(', ')']],
    trailing: [],
  },
  Go: {
    linguist: ['Go'],
    ...pkg('tree-sitter-go', '0.25.0', 'tree-sitter-go.wasm', ['queries/highlights.scm']),
    atoms: ['interpreted_string_literal', 'raw_string_literal'],
    delims: [['{', '}'], ['[', ']'], ['(', ')']],
    trailing: [
      ['parameter_list', ','],
      ['argument_list', ','],
    ],
  },
  Html: {
    linguist: ['HTML'],
    ...pkg('tree-sitter-html', '0.23.2', 'tree-sitter-html.wasm', ['queries/highlights.scm']),
    atoms: ['doctype', 'quoted_attribute_value', 'raw_text', 'tag_name', 'text'],
    delims: [['<', '>'], ['<!', '>'], ['<!--', '-->']],
    trailing: [],
    sub: [
      ['(style_element (raw_text) @contents)', 'Css'],
      ['(script_element (raw_text) @contents)', 'JavaScript'],
    ],
  },
  Java: {
    linguist: ['Java'],
    ...pkg('tree-sitter-java', '0.23.5', 'tree-sitter-java.wasm', ['queries/highlights.scm']),
    atoms: ['string_literal', 'boolean_type', 'integral_type', 'floating_point_type', 'void_type'],
    delims: [['(', ')'], ['{', '}'], ['[', ']']],
    trailing: [
      ['enum_body', ','],
      ['array_initializer', ','],
    ],
  },
  JavaScript: {
    linguist: ['JavaScript'],
    ...pkg('tree-sitter-javascript', '0.25.0', 'tree-sitter-javascript.wasm', ['queries/highlights.scm']),
    atoms: ['string', 'template_string', 'regex'],
    delims: [['[', ']'], ['(', ')'], ['{', '}'], ['<', '>']],
    trailing: JS_TRAILING.map((k) => [k, ',']),
  },
  Json: {
    linguist: ['JSON', 'JSON with Comments', 'GeoJSON', 'JSON5', 'JSONLD'],
    ...pkg('tree-sitter-json', '0.24.8', 'tree-sitter-json.wasm', ['queries/highlights.scm']),
    atoms: ['string'],
    delims: [['{', '}'], ['[', ']']],
    trailing: [],
  },
  Php: {
    linguist: ['PHP'],
    ...pkg('tree-sitter-php', '0.24.0', 'tree-sitter-php.wasm', ['queries/highlights.scm']),
    atoms: ['string', 'encapsed_string'],
    delims: [['(', ')'], ['[', ']'], ['{', '}']],
    trailing: [],
  },
  Python: {
    linguist: ['Python'],
    ...pkg('tree-sitter-python', '0.25.0', 'tree-sitter-python.wasm', ['queries/highlights.scm']),
    atoms: ['string'],
    delims: [['(', ')'], ['[', ']'], ['{', '}']],
    trailing: ['dictionary', 'list', 'set', 'argument_list', 'parameters'].map((k) => [k, ',']),
  },
  Ruby: {
    linguist: ['Ruby'],
    ...pkg('tree-sitter-ruby', '0.23.1', 'tree-sitter-ruby.wasm', ['queries/highlights.scm']),
    atoms: ['string', 'heredoc_body', 'regex'],
    delims: [
      ['{', '}'],
      ['(', ')'],
      ['[', ']'],
      ['|', '|'],
      ['def', 'end'],
      ['begin', 'end'],
      ['class', 'end'],
    ],
    trailing: [],
  },
  Rust: {
    linguist: ['Rust'],
    ...pkg('tree-sitter-rust', '0.24.0', 'tree-sitter-rust.wasm', ['queries/highlights.scm']),
    atoms: ['char_literal', 'string_literal', 'raw_string_literal'],
    delims: [['{', '}'], ['(', ')'], ['[', ']'], ['|', '|'], ['<', '>']],
    trailing: [
      'arguments',
      'parameters',
      'type_parameters',
      'field_declaration_list',
      'field_initializer_list',
      'array_expression',
      'tuple_expression',
      'use_list',
      'enum_variant_list',
      'token_tree',
    ].map((k) => [k, ',']),
  },
  Toml: {
    linguist: ['TOML'],
    ...pkg('@tree-sitter-grammars/tree-sitter-toml', '0.7.0', 'tree-sitter-toml.wasm', ['queries/highlights.scm']),
    atoms: ['string', 'quoted_key'],
    delims: [['{', '}'], ['[', ']']],
    trailing: [['array', ',']],
  },
  TypeScript: {
    linguist: ['TypeScript'],
    ...pkg('tree-sitter-typescript', '0.23.2', 'tree-sitter-typescript.wasm', ['tree-sitter-javascript@0.25.0/queries/highlights.scm', 'queries/highlights.scm']),
    atoms: ['string', 'template_string', 'regex', 'predefined_type'],
    delims: [['{', '}'], ['(', ')'], ['[', ']'], ['<', '>']],
    trailing: JS_TRAILING.map((k) => [k, ',']),
  },
  TypeScriptTsx: {
    linguist: ['TSX'],
    ...pkg('tree-sitter-typescript', '0.23.2', 'tree-sitter-tsx.wasm', ['tree-sitter-javascript@0.25.0/queries/highlights.scm', 'queries/highlights.scm']),
    atoms: ['string', 'template_string', 'regex', 'predefined_type'],
    delims: [['{', '}'], ['(', ')'], ['[', ']'], ['<', '>']],
    trailing: JS_TRAILING.map((k) => [k, ',']),
  },
  Yaml: {
    linguist: ['YAML'],
    ...pkg('@tree-sitter-grammars/tree-sitter-yaml', '0.7.0', 'tree-sitter-yaml.wasm', ['queries/highlights.scm']),
    atoms: ['string_scalar', 'double_quote_scalar', 'single_quote_scalar', 'block_scalar'],
    delims: [['{', '}'], ['(', ')'], ['[', ']']],
    trailing: [],
  },
}

export function configForLinguist(name) {
  if (!name) return null
  for (const [key, cfg] of Object.entries(CONFIGS)) if (cfg.linguist.includes(name)) return key
  return null
}

// ------------------------------------------------------------- loading

/**
 * Loads web-tree-sitter and grammars. `io` provides fetchBytes(path) and
 * fetchText(path) for "package@version/file" paths plus the web-tree-sitter
 * module; the defaults use the jsDelivr CDN.
 */
export class TreeSitterHost {
  constructor(io) {
    this.io = io
    this.ready = null
    this.languages = new Map()
  }
  async init() {
    this.ready ||= (async () => {
      this.TS = await this.io.loadModule()
      await this.TS.Parser.init(this.io.parserInitOptions)
    })()
    return this.ready
  }
  async config(name) {
    await this.init()
    let entry = this.languages.get(name)
    if (!entry) {
      entry = (async () => {
        const cfg = CONFIGS[name]
        const { Language, Query } = this.TS
        const language = await Language.load(await this.io.fetchBytes(cfg.wasm))
        const queryText = (await Promise.all(cfg.queries.map((q) => this.io.fetchText(q).catch(() => '')))).join('\n')
        let query
        try {
          query = new Query(language, queryText)
        } catch (e) {
          // Queries that do not fit this grammar build: no highlighting.
          query = new Query(language, '')
        }
        const sub = []
        for (const [q, lang] of cfg.sub || []) sub.push({ query: new Query(language, q), lang })
        return { name, ...cfg, language, query, sub, atomSet: new Set(cfg.atoms) }
      })()
      this.languages.set(name, entry)
    }
    return entry
  }
  parse(cfg, src, includedRanges) {
    const parser = new this.TS.Parser()
    parser.setLanguage(cfg.language)
    const tree = parser.parse(src, null, includedRanges ? { includedRanges } : undefined)
    parser.delete()
    return tree
  }
}

export function cdnIO(base = 'https://cdn.jsdelivr.net/npm/', webTreeSitter = 'web-tree-sitter@0.26.13') {
  return {
    loadModule: () => import(/* @vite-ignore */ `${base}${webTreeSitter}/web-tree-sitter.js`),
    parserInitOptions: { locateFile: (file) => `${base}${webTreeSitter}/${file}` },
    fetchBytes: async (p) => new Uint8Array(await (await fetch(base + p)).arrayBuffer()),
    fetchText: async (p) => {
      const r = await fetch(base + p)
      if (!r.ok) throw new Error(`${p}: ${r.status}`)
      return r.text()
    },
  }
}

// ------------------------------------------------------------- highlights

function treeHighlights(tree, cfg) {
  const ids = { comment: new Set(), keyword: new Set(), string: new Set(), type: new Set() }
  const classes = cfg.query.captureNames.map((name) => {
    const c = { type: false, keyword: false, string: false, comment: false }
    if (name === 'type' || name.startsWith('type.') || name.startsWith('storage.type.') || name.startsWith('keyword.type.') || name === 'tag' || name === 'constructor')
      c.type = true
    else if (
      name === 'keyword' ||
      name.startsWith('keyword.') ||
      name === 'constant' ||
      name.startsWith('constant.') ||
      name === 'operator' ||
      name === 'repeat' ||
      name === 'conditional' ||
      name === 'boolean' ||
      name === 'exception' ||
      name === 'include'
    )
      c.keyword = true
    if (name === 'string' || name.startsWith('string.') || name === 'character' || name.startsWith('character.')) c.string = true
    if (name === 'label') c.type = true
    if (name === 'comment' || name.startsWith('comment.')) c.comment = true
    return c
  })
  const byName = new Map(cfg.query.captureNames.map((n, i) => [n, classes[i]]))
  for (const m of cfg.query.matches(tree.rootNode)) {
    for (const cap of m.captures) {
      const c = byName.get(cap.name)
      if (!c) continue
      const id = cap.node.id
      if (c.comment) ids.comment.add(id)
      else if (c.keyword) ids.keyword.add(id)
      else if (c.string) ids.string.add(id)
      else if (c.type) ids.type.add(id)
    }
  }
  return ids
}

// ------------------------------------------------------------- conversion

/**
 * Convert `src` to difftastic Syntax nodes.
 * @returns {{nodes: object[], errors: number, firstError: [number, number] | null}}
 */
export async function toSyntax(host, cfgName, src) {
  if (src.trim() === '') return { nodes: [], errors: 0, firstError: null }
  const cfg = await host.config(cfgName)
  const tree = host.parse(cfg, src)
  const nlPos = new LinePositions(src)
  const state = { errors: 0, firstError: null }
  const record = (node) => {
    state.errors++
    if (!state.firstError) state.firstError = [node.startPosition.row, node.startPosition.column]
  }

  // sub-languages (e.g. <script> and <style> in HTML)
  const subtrees = new Map()
  for (const sub of cfg.sub) {
    const subCfg = await host.config(sub.lang)
    for (const m of sub.query.matches(tree.rootNode)) {
      const node = m.captures[0].node
      if (node.startIndex === node.endIndex) continue
      const range = { startIndex: node.startIndex, endIndex: node.endIndex, startPosition: node.startPosition, endPosition: node.endPosition }
      const subtree = host.parse(subCfg, src, [range])
      subtrees.set(node.id, { tree: subtree, cfg: subCfg, highlights: treeHighlights(subtree, subCfg) })
    }
  }

  const ctx = { src, nlPos, record, subtrees }
  const highlights = treeHighlights(tree, cfg)
  const cursor = tree.walk()
  if (cursor.currentNode.isError) record(cursor.currentNode)
  // The tree has a single root; we want a node per top level item.
  cursor.gotoFirstChild()
  const nodes = allSyntaxesFromCursor(ctx, cursor, cfg, highlights, true)
  cursor.delete()
  tree.delete()
  for (const s of subtrees.values()) s.tree.delete()
  return { nodes, errors: state.errors, firstError: state.firstError }
}

function allSyntaxesFromCursor(ctx, cursor, cfg, hl, useSubtrees) {
  const nodes = []
  for (;;) {
    const n = syntaxFromCursor(ctx, cursor, cfg, hl, useSubtrees)
    if (n) nodes.push(n)
    if (!cursor.gotoNextSibling()) break
  }
  return nodes
}

function syntaxFromCursor(ctx, cursor, cfg, hl, useSubtrees) {
  const node = cursor.currentNode
  if (useSubtrees) {
    const sub = ctx.subtrees.get(node.id)
    if (sub) {
      const subCursor = sub.tree.walk()
      const res = syntaxFromCursor(ctx, subCursor, sub.cfg, sub.highlights, false)
      subCursor.delete()
      return res
    }
  }
  if (node.isError) ctx.record(node)
  const childCount = node.childCount
  if (cfg.atomSet.has(node.type) || hl.comment.has(node.id)) return atomFromCursor(ctx, node, hl)
  if (hl.keyword.has(node.id) && childCount === 1) return atomFromCursor(ctx, node, hl)
  if (childCount > 0) return listFromCursor(ctx, cursor, cfg, hl, useSubtrees)
  return atomFromCursor(ctx, node, hl)
}

function childTokens(ctx, cursor) {
  const tokens = []
  cursor.gotoFirstChild()
  for (;;) {
    const n = cursor.currentNode
    if (n.childCount > 1 || n.isExtra) tokens.push(null)
    else tokens.push(ctx.src.slice(n.startIndex, n.endIndex))
    if (!cursor.gotoNextSibling()) break
  }
  cursor.gotoParent()
  return tokens
}

function findDelimPositions(ctx, cursor, delims) {
  const tokens = childTokens(ctx, cursor)
  for (let i = 0; i < tokens.length; i++) {
    for (const [open, close] of delims) {
      if (tokens[i] === open) {
        for (let j = i + 1; j < tokens.length; j++) if (tokens[j] === close) return [i, j]
      }
    }
  }
  return null
}

function listFromCursor(ctx, cursor, cfg, hl, useSubtrees) {
  const root = cursor.currentNode
  const outerOpenPosition = ctx.nlPos.fromRegion(root.startIndex, root.startIndex)
  const outerClosePosition = ctx.nlPos.fromRegion(root.endIndex, root.endIndex)
  const found = findDelimPositions(ctx, cursor, cfg.delims)
  const [i, j] = found || [-1, root.childCount]
  let openContent = ''
  let openPosition = outerOpenPosition
  let closeContent = ''
  let closePosition = outerClosePosition
  const before = []
  const between = []
  const after = []
  let k = 0
  cursor.gotoFirstChild()
  for (;;) {
    const node = cursor.currentNode
    if (k < i) {
      const s = syntaxFromCursor(ctx, cursor, cfg, hl, useSubtrees)
      if (s) before.push(s)
    } else if (k === i) {
      openContent = ctx.src.slice(node.startIndex, node.endIndex)
      openPosition = ctx.nlPos.fromRegion(node.startIndex, node.endIndex)
    } else if (k < j) {
      const s = syntaxFromCursor(ctx, cursor, cfg, hl, useSubtrees)
      if (s) between.push(s)
    } else if (k === j) {
      closeContent = ctx.src.slice(node.startIndex, node.endIndex)
      closePosition = ctx.nlPos.fromRegion(node.startIndex, node.endIndex)
    } else {
      const s = syntaxFromCursor(ctx, cursor, cfg, hl, useSubtrees)
      if (s) after.push(s)
    }
    if (!cursor.gotoNextSibling()) break
    k++
  }
  cursor.gotoParent()

  // can_ignore_last_child
  for (const [kind, tok] of cfg.trailing) {
    if (root.type !== kind) continue
    const last = between[between.length - 1]
    if (last && !last.isList && last.content === tok) {
      between.pop()
      between.push(newAtom(last.position.slice(), last.content, ATOM_CAN_IGNORE))
      break
    }
  }

  const inner = newList(openContent, openPosition, between, closeContent, closePosition)
  if (!before.length && !after.length) return inner
  return newList('', outerOpenPosition, [...before, inner, ...after], '', outerClosePosition)
}

function atomFromCursor(ctx, node, hl) {
  if (node.type === '\n') return null
  const position = ctx.nlPos.fromRegion(node.startIndex, node.endIndex)
  let content = ctx.src.slice(node.startIndex, node.endIndex)
  if (node.type === 'jsx_text') content = content.trim()
  const id = node.id
  const highlighted = hl.keyword.has(id) || hl.string.has(id) || hl.type.has(id)
  const extraComment = !highlighted && node.isExtra
  let kind
  if (node.isError) kind = ATOM_ERROR
  else if (node.type === 'comment' || hl.comment.has(id) || extraComment) kind = ATOM_COMMENT
  else if (hl.keyword.has(id)) kind = ATOM_KEYWORD
  else if (hl.string.has(id)) kind = ATOM_STRING
  else if (hl.type.has(id)) kind = ATOM_TYPE
  else if (node.type === 'CharData' || node.type === 'text' || node.type === 'shell_text') kind = ATOM_TEXT
  else kind = ATOM_NORMAL
  return newAtom(position, content, kind)
}
