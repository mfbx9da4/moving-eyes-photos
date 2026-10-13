// GitHub's "prettylights" syntax classes. github.com maps TextMate scopes to
// these classes; the rules below are the scope table of GitHub's syntax theme
// (as published in the github-light TextMate theme). Each class gets a
// sentinel colour so a tokenizer using this theme reports the class id in
// place of a colour, and the page styles classes with GitHub's own palette.

export const PL_CLASSES = [
  '',
  'pl-c',
  'pl-c1',
  'pl-e',
  'pl-ent',
  'pl-k',
  'pl-s',
  'pl-v',
  'pl-smi',
  'pl-sr',
  'pl-cce',
  'pl-ii',
  'pl-bu',
  'pl-c2',
  'pl-ml',
  'pl-mh',
  'pl-mi',
  'pl-mb',
  'pl-md',
  'pl-mi1',
  'pl-mc',
  'pl-mi2',
  'pl-mdr',
  'pl-ba',
  'pl-corl',
  'pl-en',
  'pl-pds',
]

const id = (cls) => PL_CLASSES.indexOf(cls)
const color = (cls) => '#0000' + id(cls).toString(16).padStart(2, '0')

const RULES = [
  [['comment', 'punctuation.definition.comment', 'string.comment'], 'pl-c'],
  [['constant', 'entity.name.constant', 'variable.other.constant', 'variable.other.enummember', 'variable.language'], 'pl-c1'],
  [['entity', 'entity.name'], 'pl-e'],
  ['variable.parameter.function', 'pl-smi'],
  ['entity.name.tag', 'pl-ent'],
  ['keyword', 'pl-k'],
  [['storage', 'storage.type'], 'pl-k'],
  [['storage.modifier.package', 'storage.modifier.import', 'storage.type.java'], 'pl-smi'],
  [['string', 'punctuation.definition.string', 'string punctuation.section.embedded source'], 'pl-s'],
  ['support', 'pl-c1'],
  ['meta.property-name', 'pl-c1'],
  ['variable', 'pl-v'],
  ['variable.other', 'pl-smi'],
  [['invalid.broken', 'invalid.deprecated', 'invalid.unimplemented', 'message.error'], 'pl-bu'],
  ['invalid.illegal', 'pl-ii'],
  ['carriage-return', 'pl-c2'],
  ['string variable', 'pl-c1'],
  [['source.regexp', 'string.regexp'], 'pl-sr'],
  [
    [
      'string.regexp.character-class',
      'string.regexp constant.character.escape',
      'string.regexp source.ruby.embedded',
      'string.regexp string.regexp.arbitrary-repitition',
    ],
    'pl-sr',
  ],
  ['string.regexp constant.character.escape', 'pl-cce'],
  [['support.constant', 'support.variable', 'meta.module-reference'], 'pl-c1'],
  ['punctuation.definition.list.begin.markdown', 'pl-ml'],
  [['markup.heading', 'markup.heading entity.name'], 'pl-mh'],
  ['markup.quote', 'pl-ent'],
  ['markup.italic', 'pl-mi'],
  ['markup.bold', 'pl-mb'],
  ['markup.underline', '', 'underline'],
  ['markup.inline.raw', 'pl-c1'],
  [['markup.deleted', 'meta.diff.header.from-file', 'punctuation.definition.deleted'], 'pl-md'],
  [['markup.inserted', 'meta.diff.header.to-file', 'punctuation.definition.inserted'], 'pl-mi1'],
  [['markup.changed', 'punctuation.definition.changed'], 'pl-mc'],
  [['markup.ignored', 'markup.untracked'], 'pl-mi2'],
  ['meta.diff.range', 'pl-mdr'],
  ['meta.diff.header', 'pl-c1'],
  ['meta.separator', 'pl-mh'],
  ['meta.output', 'pl-c1'],
  [
    [
      'brackethighlighter.tag',
      'brackethighlighter.curly',
      'brackethighlighter.round',
      'brackethighlighter.square',
      'brackethighlighter.angle',
      'brackethighlighter.quote',
    ],
    'pl-ba',
  ],
  ['brackethighlighter.unmatched', 'pl-bu'],
  [['constant.other.reference.link', 'string.other.link'], 'pl-corl'],
]

export const PRETTYLIGHTS_THEME = {
  name: 'github-prettylights',
  type: 'light',
  colors: { 'editor.foreground': '#000000', 'editor.background': '#ffffff' },
  tokenColors: RULES.map(([scope, cls, fontStyle]) => ({
    scope,
    settings: { foreground: cls ? color(cls) : '#000000', ...(fontStyle ? { fontStyle } : {}) },
  })),
}

/** Encode a themed token's colour and font style as a class id. */
export function tokenClass(colorHex, fontStyle) {
  const c = colorHex ? parseInt(colorHex.slice(1, 7), 16) & 0xff : 0
  return c | ((fontStyle & 7) << 8)
}
