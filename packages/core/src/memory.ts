import { createHash, createHmac, hkdfSync } from 'node:crypto';
import { AthanorError } from './errors.js';

export interface MemoryDocument {
  content: string;
  validFrom?: string;
  validUntil?: string;
  source?: 'owner' | 'agent';
  sourceTaskId?: string;
  previousUpdatedAt?: string;
}

export interface RecallableMemory {
  id: string;
  target: 'workspace' | 'user';
  content: string;
  updatedAt: string;
}

/**
 * Closed-class English function words: articles, pronouns, auxiliaries, and the interrogatives a
 * question is framed with. Fixed once, and deliberately not a tuning surface - every word here is
 * one that cannot distinguish two entries in this store, whatever the store is about.
 *
 * The interrogatives matter more than they look. Admission to the lexical channel is binary: a row
 * sharing one lexeme with the query is a candidate. So "remind me what the neighbour said about her
 * boat" - a question this computer has no answer to at all - pulled in an unrelated episode on the
 * strength of the word "about", and at scale that is how a pack of near misses quietly costs six
 * thousand tokens. Words nothing can be told apart by are dropped from the index and the query
 * alike, so the two surfaces stay symmetric.
 *
 * Words that read as function words but carry meaning on an agent computer are deliberately absent:
 * "down", "up", "out", "over", "no" and "not" all change what a sentence about a service means.
 */
const memoryStopWords = new Set([
  'a',
  'about',
  'am',
  'an',
  'and',
  'any',
  'are',
  'as',
  'at',
  'be',
  'been',
  'but',
  'by',
  'can',
  'could',
  'did',
  'do',
  'does',
  'for',
  'from',
  'had',
  'has',
  'have',
  'he',
  'her',
  'him',
  'his',
  'how',
  'i',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'me',
  'more',
  'most',
  'my',
  'of',
  'on',
  'or',
  'our',
  'she',
  'should',
  'so',
  'some',
  'such',
  'than',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'those',
  'to',
  'us',
  'very',
  'was',
  'we',
  'were',
  'what',
  'when',
  'where',
  'which',
  'who',
  'whom',
  'whose',
  'why',
  'will',
  'with',
  'would',
  'you',
  'your'
]);

const memoryTerms = (value: string): Set<string> =>
  new Set(
    value
      .normalize('NFKC')
      .toLocaleLowerCase('en')
      .match(/[\p{L}\p{N}][\p{L}\p{N}_.-]{1,}/gu)
      ?.filter((term) => !memoryStopWords.has(term)) ?? []
  );

/**
 * Selects compact reviewed context without an embedding model or remote index.
 * User-level preferences receive a small durable boost; lexical relevance and
 * recency decide which workspace facts enter a bounded prompt.
 */
export const recallMemories = (
  entries: readonly RecallableMemory[],
  query: string,
  options: { maxItems?: number; maxCharacters?: number; now?: Date } = {}
): RecallableMemory[] => {
  const queryNormalized = query.normalize('NFKC').trim().toLocaleLowerCase('en');
  const queryTerms = memoryTerms(queryNormalized);
  const now = (options.now ?? new Date()).getTime();
  const ranked = entries
    .map((entry) => {
      const contentNormalized = entry.content.normalize('NFKC').toLocaleLowerCase('en');
      const contentTerms = memoryTerms(contentNormalized);
      const overlap = [...queryTerms].filter((term) => contentTerms.has(term)).length;
      const coverage = queryTerms.size ? overlap / queryTerms.size : 0;
      const ageDays = Math.max(0, now - new Date(entry.updatedAt).getTime()) / 86_400_000;
      const recency = Number.isFinite(ageDays) ? 1 / (1 + ageDays / 90) : 0;
      const exact = queryNormalized.length >= 4 && contentNormalized.includes(queryNormalized);
      return {
        entry,
        score:
          (exact ? 12 : 0) +
          overlap * 2.5 +
          coverage * 4 +
          recency +
          (entry.target === 'user' ? 1.5 : 0)
      };
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        new Date(right.entry.updatedAt).getTime() - new Date(left.entry.updatedAt).getTime() ||
        left.entry.id.localeCompare(right.entry.id)
    );
  const selected: RecallableMemory[] = [];
  let characters = 0;
  for (const candidate of ranked) {
    if (selected.length >= (options.maxItems ?? 32)) break;
    if (characters + candidate.entry.content.length > (options.maxCharacters ?? 16_000)) continue;
    selected.push(candidate.entry);
    characters += candidate.entry.content.length;
  }
  return selected;
};

const instant = (value: string | undefined): number | undefined => {
  if (!value) return undefined;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : undefined;
};

export type MemoryTemporalStatus = 'active' | 'upcoming' | 'expired';

export const memoryTemporalStatus = (
  document: MemoryDocument,
  now = new Date()
): MemoryTemporalStatus => {
  const cursor = now.getTime();
  const validFrom = instant(document.validFrom);
  const validUntil = instant(document.validUntil);
  if (validFrom !== undefined && validFrom > cursor) return 'upcoming';
  if (validUntil !== undefined && validUntil <= cursor) return 'expired';
  return 'active';
};

export const assertMemoryValidity = (document: MemoryDocument): void => {
  const validFrom = instant(document.validFrom);
  const validUntil = instant(document.validUntil);
  if (document.validFrom && validFrom === undefined)
    throw new AthanorError('memory_validity_invalid', 'Memory start time is invalid');
  if (document.validUntil && validUntil === undefined)
    throw new AthanorError('memory_validity_invalid', 'Memory expiry time is invalid');
  if (validFrom !== undefined && validUntil !== undefined && validUntil <= validFrom)
    throw new AthanorError(
      'memory_validity_invalid',
      'Memory expiry must be later than its start time'
    );
};

/* ------------------------------------------------------------------------ *
 * Tiered memory: kinds, trust tiers and lifecycle
 * ------------------------------------------------------------------------ */

/** Verbatim `source` rows are never replaced by the curated overlay, only cited by it. */
export type MemoryKind = 'source' | 'episode' | 'fact' | 'procedure';

/**
 * Provenance tier. `stated` is something the owner said or a tool verified; `derived` was inferred
 * mechanically from repeated independent observation.
 *
 * There is no tier for the agent's own conclusions, and that is the invariant rather than an
 * omission: every writer on this computer is mechanical, and the `memory` tool refuses uncertain
 * inference outright. A third tier was declared here for a while and offered to the model as a
 * recall filter it could switch on; nothing ever wrote a row into it, so the parameter described a
 * capability the model did not have and could never have used.
 */
export type MemoryTrust = 'stated' | 'derived';

export type MemoryStatus = 'active' | 'superseded' | 'disputed' | 'archived' | 'retracted';

export const MEMORY_KINDS: readonly MemoryKind[] = ['source', 'episode', 'fact', 'procedure'];

/**
 * Vetted in-repo predicate registry. `cardinality: 'one'` is the whole deterministic contradiction
 * engine: a second current value for a functional predicate retires the first one without a model
 * call. It is deliberately not extensible at runtime.
 */
export interface MemoryPredicateDefinition {
  readonly name: string;
  readonly cardinality: 'one' | 'many';
  readonly isTemporal: boolean;
  readonly description: string;
}

export const MEMORY_PREDICATES: readonly MemoryPredicateDefinition[] = [
  {
    name: 'default_shell',
    cardinality: 'one',
    isTemporal: true,
    description: 'The interactive shell the owner uses on this computer.'
  },
  {
    name: 'lives_in',
    cardinality: 'one',
    isTemporal: true,
    description: 'Where the subject is currently located.'
  },
  {
    name: 'current_employer',
    cardinality: 'one',
    isTemporal: true,
    description: 'Who the subject currently works for.'
  },
  {
    name: 'project_status',
    cardinality: 'one',
    isTemporal: true,
    description: 'The current state of a project the owner is running.'
  },
  {
    name: 'runs_on',
    cardinality: 'one',
    isTemporal: true,
    description: 'The host, port or environment a service currently runs on.'
  },
  {
    name: 'uses_tool',
    cardinality: 'one',
    isTemporal: true,
    description: 'The tool currently chosen for a named job.'
  },
  {
    name: 'prefers',
    cardinality: 'many',
    isTemporal: true,
    description: 'A stated preference of the owner.'
  },
  {
    name: 'knows_language',
    cardinality: 'many',
    isTemporal: false,
    description: 'A language the subject can work in.'
  },
  {
    name: 'located_at',
    cardinality: 'many',
    isTemporal: true,
    description: 'A path or URL where something the owner cares about lives.'
  },
  {
    name: 'related_to',
    cardinality: 'many',
    isTemporal: false,
    description: 'An untyped association between two entities.'
  }
];

const predicateIndex = new Map(MEMORY_PREDICATES.map((entry) => [entry.name, entry]));

export const memoryPredicate = (name: string): MemoryPredicateDefinition | undefined =>
  predicateIndex.get(name);

export const isFunctionalMemoryPredicate = (name: string): boolean =>
  predicateIndex.get(name)?.cardinality === 'one';

/* ------------------------------------------------------------------------ *
 * Keyed blind index
 *
 * Memory bodies are stored encrypted, exactly like task titles and prompts, so PostgreSQL cannot
 * run `to_tsvector` over the plaintext. Instead the tokenizer runs here and every lexeme is
 * replaced by a keyed HMAC token before it reaches the database. The resulting tsvector keeps
 * positions and field weights, so `@@`, `ts_rank_cd` and the BM25 function all behave normally
 * over a token space the database can match but not read back.
 * ------------------------------------------------------------------------ */

const TOKEN_ALPHABET = 'abcdefghijklmnop';
const LEXEME_TOKEN_CHARS = 16;
const TRIGRAM_TOKEN_CHARS = 12;
const KEY_TOKEN_CHARS = 32;

/** Positions above 16383 are dropped by tsvector, so indexing beyond this buys nothing. */
const MAX_INDEXED_TOKENS = 4_000;
/** Rows larger than this are stored but never indexed; see `poisonsLexicalIndex`. */
const MAX_INDEXED_BYTES = 64_000;
const MIN_PRINTABLE_WORD_RATIO = 0.5;
/** Longer than any real path, flag or hostname: a run this long is a payload, not a word. */
const MAX_WORD_CHARS = 48;
/** Below this the ratio is noise - a one-line note is not a blob however it is punctuated. */
const MIN_RATIO_SAMPLE_CHARS = 256;
/** The alias surface is a naming surface, not a document; a row needing more than this is a blob. */
const MAX_ALIAS_TOKENS = 256;

const encodeToken = (digest: Buffer, chars: number): string => {
  let out = '';
  for (let index = 0; index < chars; index += 1) {
    const byte = digest[index >> 1] ?? 0;
    out += TOKEN_ALPHABET[index % 2 === 0 ? byte >> 4 : byte & 0x0f];
  }
  return out;
};

/**
 * Derives the index key from the workspace data key. Separating them means a leaked index key
 * cannot decrypt anything, and rotating the search surface never touches stored ciphertext.
 */
export const memoryIndexKey = (dataKey: Uint8Array): Buffer =>
  Buffer.from(hkdfSync('sha256', dataKey, new Uint8Array(0), 'athanor-memory-index-v1', 32));

const keyedToken = (domain: string, value: string, key: Uint8Array, chars: number): string =>
  encodeToken(createHmac('sha256', key).update(`${domain} ${value}`).digest(), chars);

/**
 * Every index token is drawn from a 16-letter alphabet with no digits and no punctuation. That is
 * what lets the recall query assemble a tsquery out of a bound text[] without a lexeme ever being
 * read as an `&`, `|` or `!` operator, and it is why `to_tsvector('simple', ...)` returns the
 * tokens unchanged instead of splitting or stemming them.
 */
export const isMemoryToken = (value: string): boolean => /^[a-p]+$/.test(value);

/* --- tokenizer ---------------------------------------------------------- */

// Paths, flags, hostnames, versions and SHAs are the substance of an agent computer's memory, so
// the tokenizer keeps them whole instead of letting a stemmer shred them.
const LEXEME_PATTERN =
  /--?[\p{L}\p{N}][\p{L}\p{N}_-]*|\/[\p{L}\p{N}][\p{L}\p{N}_./-]*|[\p{L}\p{N}][\p{L}\p{N}_.:@/+-]*/gu;
const PLAIN_WORD = /^[\p{L}]+$/u;
const TRAILING_PUNCTUATION = /[._:@/+-]+$/;

/** Identifiers keep their exact form; only ordinary prose words are suffix-normalized. */
const stemPlainWord = (word: string): string => {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && word.endsWith('sses')) return word.slice(0, -2);
  if (
    word.length > 3 &&
    word.endsWith('s') &&
    !word.endsWith('ss') &&
    !word.endsWith('us') &&
    !word.endsWith('is')
  )
    return word.slice(0, -1);
  const undouble = (value: string): string =>
    value.length > 3 && value.at(-1) === value.at(-2) && !'aeiou'.includes(value.at(-1) ?? '')
      ? value.slice(0, -1)
      : value;
  if (word.endsWith('ing') && word.length - 3 >= 4) return undouble(word.slice(0, -3));
  if (word.endsWith('ed') && word.length - 2 >= 4) return undouble(word.slice(0, -2));
  return word;
};

/**
 * Splits text into ordered lexemes. Order matters: positions in the stored tsvector are what makes
 * `ts_rank_cd` cover-density reranking possible, so this must never be turned into a set.
 */
export const memoryLexemes = (value: string): string[] => {
  const matches = value.normalize('NFKC').toLocaleLowerCase('en').match(LEXEME_PATTERN) ?? [];
  const lexemes: string[] = [];
  for (const raw of matches) {
    const token = raw.replace(TRAILING_PUNCTUATION, '');
    if (!token) continue;
    if (PLAIN_WORD.test(token)) {
      if (token.length < 2 || memoryStopWords.has(token)) continue;
      lexemes.push(stemPlainWord(token));
      continue;
    }
    lexemes.push(token);
  }
  return lexemes;
};

/**
 * Ordered lexemes with the offset each one was found at.
 *
 * `memoryLexemes` throws positions away because the index only needs the sequence. An excerpt needs
 * to point at a place in the original text, and it has to do it through the same stemmer the index
 * used - otherwise a hit found by "restarted" is highlighted nowhere, because the body says
 * "restart".
 */
const locatedLexemes = (value: string): { readonly lexeme: string; readonly at: number }[] => {
  const located: { lexeme: string; at: number }[] = [];
  for (const match of value.matchAll(LEXEME_PATTERN)) {
    const raw = match[0].toLocaleLowerCase('en').replace(TRAILING_PUNCTUATION, '');
    if (!raw) continue;
    if (PLAIN_WORD.test(raw)) {
      if (raw.length < 2 || memoryStopWords.has(raw)) continue;
      located.push({ lexeme: stemPlainWord(raw), at: match.index });
      continue;
    }
    located.push({ lexeme: raw, at: match.index });
  }
  return located;
};

/** Identifier-shaped terms are what the fuzzy channel exists for; prose words only add noise. */
export const memoryIdentifiers = (value: string): string[] => {
  const seen = new Set<string>();
  for (const raw of value.normalize('NFKC').toLocaleLowerCase('en').match(LEXEME_PATTERN) ?? []) {
    const token = raw.replace(TRAILING_PUNCTUATION, '');
    if (token.length < 3 || PLAIN_WORD.test(token)) continue;
    seen.add(token);
  }
  return [...seen].sort();
};

/** A part shorter than this is a fragment, not a word someone would search by. */
const MIN_ALIAS_CHARS = 3;
const ALIAS_BOUNDARY = /[^\p{L}\p{N}]+/gu;
const CAMEL_BOUNDARY = /([\p{Ll}\p{N}])(\p{Lu})/gu;
const HAS_LETTER = /\p{L}/u;

/**
 * The component words of a compound term.
 *
 * The tokenizer deliberately keeps `athanor-relay`, `imap_idle_notify_interval` and
 * `/srv/athanor/var/log` whole, because that is what makes them findable by their exact name. The
 * cost is that they share no lexeme with the words a person actually asks by - nobody types
 * `athanor-relay`, they ask what port the relay listens on. This splits a compound into its parts
 * so both surfaces exist: the exact name in the body field, the parts in a lower-weighted alias
 * field beside it. Parts that the tokenizer already produced from the same text are dropped, so
 * ordinary prose contributes nothing here and pays nothing for it.
 */
export const memoryAliasLexemes = (value: string): string[] => {
  const direct = new Set(memoryLexemes(value));
  const aliases = new Set<string>();
  for (const chunk of value.normalize('NFKC').split(ALIAS_BOUNDARY)) {
    if (!chunk) continue;
    for (const part of chunk.replace(CAMEL_BOUNDARY, '$1 $2').split(' ')) {
      const word = part.toLocaleLowerCase('en');
      if (word.length < MIN_ALIAS_CHARS || !HAS_LETTER.test(word)) continue;
      if (memoryStopWords.has(word)) continue;
      const stemmed = PLAIN_WORD.test(word) ? stemPlainWord(word) : word;
      if (!direct.has(stemmed)) aliases.add(stemmed);
    }
  }
  return [...aliases].sort();
};

/**
 * pg_trgm-shaped trigrams: lowercase, split on non-alphanumerics, pad each word with two leading
 * and one trailing space. Jaccard over these sets is what `similarity()` computes, so hashing each
 * trigram preserves the score exactly while keeping the plaintext out of the database.
 */
export const memoryTrigrams = (value: string): string[] => {
  const words = value
    .normalize('NFKC')
    .toLocaleLowerCase('en')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  const grams = new Set<string>();
  for (const word of words) {
    const padded = `  ${word} `;
    for (let index = 0; index + 3 <= padded.length; index += 1)
      grams.add(padded.slice(index, index + 3));
  }
  return [...grams].sort();
};

/**
 * Blobs flatten IDF for everything else: a base64 payload or a minified bundle contributes
 * thousands of lexemes that occur exactly once. They are stored, and stay reachable by id or
 * origin, but never enter the lexical index. The signal is the share of characters that sit in
 * word-shaped runs - a blob is one enormous run, prose and command output are many short ones.
 */
const poisonsLexicalIndex = (body: string, lexemes: readonly string[]): boolean => {
  if (Buffer.byteLength(body, 'utf8') > MAX_INDEXED_BYTES) return true;
  const dense = body.replace(/\s+/gu, '').length;
  if (dense < MIN_RATIO_SAMPLE_CHARS) return false;
  const printable = lexemes.reduce(
    (total, lexeme) => total + (lexeme.length <= MAX_WORD_CHARS ? lexeme.length : 0),
    0
  );
  return printable / dense < MIN_PRINTABLE_WORD_RATIO;
};

/** Cheap deterministic estimate; the real budget is enforced against this, never against an API. */
export const estimateMemoryTokens = (value: string): number => Math.ceil(value.length / 4);

const keyedLexemeLine = (value: string, key: Uint8Array): string =>
  memoryLexemes(value)
    .slice(0, MAX_INDEXED_TOKENS)
    .map((lexeme) => keyedToken('lex', lexeme, key, LEXEME_TOKEN_CHARS))
    .join(' ');

const keyedTrigramSet = (value: string, key: Uint8Array): string[] =>
  memoryTrigrams(value).map((gram) => keyedToken('trg', gram, key, TRIGRAM_TOKEN_CHARS));

/** The alias surface is a set, not a sentence: it is deduped and bounded rather than positional. */
const keyedAliasLine = (value: string, key: Uint8Array): string =>
  memoryAliasLexemes(value)
    .slice(0, MAX_ALIAS_TOKENS)
    .map((lexeme) => keyedToken('lex', lexeme, key, LEXEME_TOKEN_CHARS))
    .join(' ');

/** Entity and object names are matched by equality, so they are normalized but never stemmed. */
export const normalizeMemoryTerm = (value: string): string =>
  value.normalize('NFKC').toLocaleLowerCase('en').replace(/\s+/gu, ' ').trim();

export const memorySubjectKey = (subject: string, key: Uint8Array): string =>
  keyedToken('subject', normalizeMemoryTerm(subject), key, KEY_TOKEN_CHARS);

export const memoryObjectKey = (object: string, key: Uint8Array): string =>
  keyedToken('object', normalizeMemoryTerm(object), key, KEY_TOKEN_CHARS);

/**
 * Keyed handle for where a verbatim row came from - a path, URL or command. Compacted sources
 * leave the lexical index, so this is what still finds "everything I ever ran in /srv/athanor".
 */
export const memoryOriginKey = (locator: string, key: Uint8Array): string =>
  keyedToken('origin', normalizeMemoryTerm(locator), key, KEY_TOKEN_CHARS);

export interface MemoryItemContent {
  readonly title?: string | null;
  readonly tags?: readonly string[];
  readonly body: string;
  readonly subject?: string | null;
  readonly object?: string | null;
}

export interface MemoryItemIndex {
  readonly titleTokens: string;
  readonly tagTokens: string;
  /**
   * Keyed component words of the entry's compound terms - its subject, object, title and the
   * identifiers in its body. Indexed at a weight below the title, so `relay` reaches a fact whose
   * subject is `athanor-relay` without outranking an entry that is actually titled "relay".
   */
  readonly aliasTokens: string;
  readonly bodyTokens: string;
  readonly tagsHashed: string[];
  readonly trigrams: string[];
  readonly subjectKey: string | null;
  readonly objectKey: string | null;
  /** Keyed hash of the normalized item body; exact-duplicate suppression in the pack uses it. */
  readonly dedupeKey: string;
  readonly tokensEst: number;
  readonly indexed: boolean;
}

export const buildMemoryItemIndex = (
  content: MemoryItemContent,
  key: Uint8Array
): MemoryItemIndex => {
  const tags = content.tags ?? [];
  const bodyLexemes = memoryLexemes(content.body);
  const indexed = !poisonsLexicalIndex(content.body, bodyLexemes);
  const fuzzySurface = [
    content.title ?? '',
    content.subject ?? '',
    content.object ?? '',
    ...memoryIdentifiers(content.body)
  ]
    .filter(Boolean)
    .join(' ');
  // Everything an entry could be asked by rather than everything it contains: the names it is
  // about, and the identifiers its body names. The body's prose is deliberately absent - it is
  // already indexed at D weight and would only re-weight itself.
  const aliasSurface = [
    content.title ?? '',
    content.subject ?? '',
    content.object ?? '',
    tags.join(' '),
    memoryIdentifiers(content.body).join(' ')
  ]
    .filter(Boolean)
    .join(' ');
  return {
    titleTokens: indexed ? keyedLexemeLine(content.title ?? '', key) : '',
    tagTokens: indexed ? keyedLexemeLine(tags.join(' '), key) : '',
    aliasTokens: indexed ? keyedAliasLine(aliasSurface, key) : '',
    bodyTokens: indexed
      ? bodyLexemes
          .slice(0, MAX_INDEXED_TOKENS)
          .map((lexeme) => keyedToken('lex', lexeme, key, LEXEME_TOKEN_CHARS))
          .join(' ')
      : '',
    tagsHashed: [
      ...new Set(
        tags.flatMap((tag) =>
          memoryLexemes(tag).map((lexeme) => keyedToken('lex', lexeme, key, LEXEME_TOKEN_CHARS))
        )
      )
    ].sort(),
    trigrams: indexed ? keyedTrigramSet(fuzzySurface, key) : [],
    subjectKey: content.subject ? memorySubjectKey(content.subject, key) : null,
    objectKey: content.object ? memoryObjectKey(content.object, key) : null,
    dedupeKey: keyedToken(
      'dedupe',
      normalizeMemoryTerm(`${content.title ?? ''} ${content.body}`),
      key,
      KEY_TOKEN_CHARS
    ),
    tokensEst: estimateMemoryTokens(
      [content.title ?? '', tags.join(' '), content.body].join('\n').trim()
    ),
    indexed
  };
};

export interface MemorySourceIndex {
  readonly bodyTokens: string;
  readonly tokensEst: number;
  readonly indexed: boolean;
}

export const buildMemorySourceIndex = (body: string, key: Uint8Array): MemorySourceIndex => {
  const lexemes = memoryLexemes(body);
  const indexed = !poisonsLexicalIndex(body, lexemes);
  if (!indexed) return { bodyTokens: '', tokensEst: estimateMemoryTokens(body), indexed };
  // A verbatim row has one field, so its aliases ride at the end of the same D-weight surface.
  // Positions past the body are meaningless for cover density, which only ranks item titles.
  const aliases = memoryAliasLexemes(memoryIdentifiers(body).join(' ')).slice(0, MAX_ALIAS_TOKENS);
  return {
    bodyTokens: [...lexemes.slice(0, MAX_INDEXED_TOKENS), ...aliases]
      .map((lexeme) => keyedToken('lex', lexeme, key, LEXEME_TOKEN_CHARS))
      .join(' '),
    tokensEst: estimateMemoryTokens(body),
    indexed
  };
};

/**
 * How much of a conversation's opening request is indexed beside its name.
 *
 * The name has no bound worth applying - it is a line. The request has none at all: a conversation
 * can open with a pasted document, and a tsvector of every lexeme of one, on every conversation
 * ever started, is a second copy of the corpus attached to a table that is read on every page load.
 *
 * This is the only surface the whole request would have bought, and it is a narrow one. From the
 * moment the first answer lands the request is in the verbatim corpus in full, chunked and indexed,
 * and reachable there at any age. What this covers is the gap before that - a conversation the
 * owner started, went to make coffee, and came back to search for. Two thousand characters is more
 * than anyone types into that gap, and for a pasted document it is the opening they would search by
 * rather than page eleven of it.
 */
export const MAX_INDEXED_OPENING_CHARS = 2_000;

/**
 * The two keyed surfaces a conversation is findable by before anything it said was captured: what
 * it is called, and what it was asked to do.
 *
 * Both go through `buildMemorySourceIndex`, which is the same tokenizer, the same stemmer, the same
 * alias expansion and the same keyed token space the verbatim corpus uses - so a query planned by
 * `planMemoryQuery` matches a conversation's name exactly as it matches its transcript, and there
 * is no second indexer to drift away from the first. Running it twice rather than over one joined
 * string is what keeps a pasted-blob request from taking the name down with it: the blob guard
 * fires on the request alone and the name is still indexed.
 */
export interface ConversationNameIndex {
  /** Keyed lexemes of the conversation's own name; indexed above the request. */
  readonly nameTokens: string;
  /** Keyed lexemes of the opening of the request, bounded by `MAX_INDEXED_OPENING_CHARS`. */
  readonly openingTokens: string;
}

export const buildConversationNameIndex = (
  name: string,
  opening: string,
  key: Uint8Array
): ConversationNameIndex => ({
  nameTokens: buildMemorySourceIndex(name, key).bodyTokens,
  openingTokens: buildMemorySourceIndex(opening.slice(0, MAX_INDEXED_OPENING_CHARS), key).bodyTokens
});

/* ------------------------------------------------------------------------ *
 * Excerpting
 * ------------------------------------------------------------------------ */

/** Wide enough to carry a whole exchange, short enough that twelve of them are not a context. */
export const MEMORY_EXCERPT_CHARS = 480;

/**
 * The passage of a stored body that actually answers the query.
 *
 * A verbatim row is up to 6 KB, and returning all of it for every hit is how a search result costs
 * more than the answer is worth. The window is chosen by the same stemmed lexemes the index matched
 * on, so a hit found by "restarted" is shown at the line that says "restart" - a substring search
 * over the raw query cannot find that position at all, and silently excerpts from character zero.
 *
 * Ties break towards the earliest window: when two passages cover the same terms equally well, the
 * first one is the one the reader would have found by scrolling.
 */
export const memoryExcerpt = (
  body: string,
  query: string,
  options: { readonly maxChars?: number } = {}
): string => {
  const maxChars = Math.max(80, Math.trunc(options.maxChars ?? MEMORY_EXCERPT_CHARS));
  // Runs of spaces collapse, single newlines survive: a transcript of command output is unreadable
  // as one line, and a blank-line-separated wall is mostly padding.
  const text = body
    .normalize('NFKC')
    .replace(/\r\n/gu, '\n')
    .replace(/[^\S\n]+/gu, ' ')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
  const clip = (start: number, end: number): string =>
    `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`;
  if (text.length <= maxChars) return text;

  // The query's own words and the parts of its compound terms, symmetrically with the alias surface
  // the index matched on: a row admitted because `athanor-relay` contains `relay` has to be
  // excerpted at that name, not at the first prose word that happened to agree.
  const wanted = new Set([...memoryLexemes(query), ...memoryAliasLexemes(query)]);
  const hits = locatedLexemes(text).filter(
    (entry) =>
      wanted.has(entry.lexeme) ||
      (!PLAIN_WORD.test(entry.lexeme) &&
        memoryAliasLexemes(entry.lexeme).some((part) => wanted.has(part)))
  );
  if (hits.length === 0) return clip(0, maxChars);

  // Best window: most distinct query terms covered inside `maxChars`, then the tightest span that
  // covers them, then earliest. Tightness matters more than hit count - a window that repeats one
  // term ten times covers less of the question than a short one carrying three different terms, and
  // ranking by count alone chose the repetitive one. Every candidate starts at a hit, because a
  // window starting anywhere else covers no more terms than the next hit's window does.
  let best = { start: hits[0]!.at, distinct: 0, span: Number.POSITIVE_INFINITY };
  for (const [index, anchor] of hits.entries()) {
    const seen = new Set<string>();
    let span = 0;
    for (let cursor = index; cursor < hits.length; cursor += 1) {
      const hit = hits[cursor]!;
      const reach = hit.at + hit.lexeme.length - anchor.at;
      if (reach > maxChars) break;
      if (!seen.has(hit.lexeme)) span = reach;
      seen.add(hit.lexeme);
    }
    if (seen.size > best.distinct || (seen.size === best.distinct && span < best.span))
      best = { start: anchor.at, distinct: seen.size, span };
  }

  // Centre the covered span rather than starting on it, so the sentence the match sits in survives.
  const span = Math.min(maxChars, text.length);
  let start = Math.max(0, Math.min(best.start - Math.floor(span / 4), text.length - span));
  // Snap to a word boundary so an excerpt never opens mid-token.
  if (start > 0) {
    const boundary = text.lastIndexOf(' ', start);
    if (boundary > start - 24) start = boundary + 1;
  }
  return clip(start, Math.min(text.length, start + span));
};

/* ------------------------------------------------------------------------ *
 * Query planning
 * ------------------------------------------------------------------------ */

// "What did I use before?" must be able to reach retired facts; a present-tense question must not.
const TEMPORAL_INTENT =
  /\b(used to|use to|previously|formerly|no longer|back then|originally|before (?:i|we|you|it|the)|last (?:year|month|week)|in (?:19|20)\d{2})\b/iu;

/**
 * Sanity bounds, not selection.
 *
 * These used to be 24 apiece, applied as `.sort().slice(24)` over the *keyed* tokens - and an HMAC
 * output sorts as noise, so which two dozen of a request's terms reached the database was
 * pseudorandom with respect to meaning. On a realistic opening request that discarded `dovecot`,
 * `imap_idle_notify_interval`, `connector` and `reboot` while keeping `morn`, `week`, `which` and
 * `if`. Selection belongs to the database: it is the only party that knows document frequency, and
 * `MEMORY_RECALL_SQL`'s `terms` CTE already orders by it. These caps exist only so a pathological
 * request cannot hand PostgreSQL an unbounded array.
 */
const MAX_QUERY_LEXEMES = 512;
const MAX_QUERY_ENTITY_KEYS = 256;
const MAX_QUERY_TRIGRAMS = 240;

export interface MemoryQueryPlan {
  /**
   * Every keyed content lexeme of the request, plus the component words of its compound terms.
   * Deduped and bounded but never selected from here: the database keeps the rarest of them.
   */
  readonly lexemes: string[];
  /** Keyed trigrams of identifier-shaped query terms; drives the fuzzy channel. */
  readonly trigrams: string[];
  /** Keyed subject keys for unigrams and bigrams, so facts about a named thing are pulled exactly. */
  readonly entityKeys: string[];
  /** Keyed lexemes used to match procedure tags. */
  readonly tagTokens: string[];
  readonly temporalIntent: boolean;
}

export const planMemoryQuery = (
  query: string,
  key: Uint8Array,
  options: { readonly entities?: readonly string[] } = {}
): MemoryQueryPlan => {
  // The request's own words and the parts of its compound terms, symmetrically with the alias
  // surface every indexed row carries: `athanor-relay` in the request reaches an entry that only
  // says `relay`, and `relay` reaches one that only says `athanor-relay`.
  const lexemes = [...memoryLexemes(query), ...memoryAliasLexemes(query)];
  const keyedLexemes = [
    ...new Set(lexemes.map((lexeme) => keyedToken('lex', lexeme, key, LEXEME_TOKEN_CHARS)))
  ]
    .sort()
    .slice(0, MAX_QUERY_LEXEMES);

  const rawTerms = (query.normalize('NFKC').toLocaleLowerCase('en').match(LEXEME_PATTERN) ?? [])
    .map((term) => term.replace(TRAILING_PUNCTUATION, ''))
    .filter((term) => term.length >= 2 && !memoryStopWords.has(term));
  const entityCandidates = new Set<string>(options.entities?.map(normalizeMemoryTerm) ?? []);
  for (let index = 0; index < rawTerms.length; index += 1) {
    entityCandidates.add(rawTerms[index]!);
    const next = rawTerms[index + 1];
    if (next) entityCandidates.add(`${rawTerms[index]!} ${next}`);
  }

  const identifiers = memoryIdentifiers(query);
  return {
    lexemes: keyedLexemes,
    trigrams: [...new Set(keyedTrigramSet(identifiers.join(' '), key))]
      .sort()
      .slice(0, MAX_QUERY_TRIGRAMS),
    entityKeys: [...entityCandidates]
      .map((term) => memorySubjectKey(term, key))
      .filter((value, index, all) => all.indexOf(value) === index)
      .sort()
      .slice(0, MAX_QUERY_ENTITY_KEYS),
    tagTokens: keyedLexemes,
    temporalIntent: TEMPORAL_INTENT.test(query)
  };
};

/* ------------------------------------------------------------------------ *
 * Packing quotas
 * ------------------------------------------------------------------------ */

export interface MemoryPackQuota {
  readonly kind: MemoryKind;
  /** Fraction of the token budget this slot may take before other slots get their turn. */
  readonly share: number;
  readonly cap: number;
  /** Per-subject cap; keeps one loud entity from taking the whole fact slot. */
  readonly perSubject: number;
}

/**
 * Top-k by fused score starves whichever channel has a flatter score distribution, so the pack is
 * filled per kind. Shares follow the design's verbatim-vs-artifact split: verbatim source keeps a
 * fifth of the budget because replacing it with extracted facts measurably loses accuracy.
 */
export const MEMORY_PACK_QUOTAS: readonly MemoryPackQuota[] = [
  { kind: 'fact', share: 0.35, cap: 25, perSubject: 4 },
  { kind: 'procedure', share: 0.15, cap: 5, perSubject: 5 },
  { kind: 'episode', share: 0.3, cap: 8, perSubject: 8 },
  { kind: 'source', share: 0.2, cap: 6, perSubject: 6 }
];

/**
 * What a kind with no quota entry gets. The recall query joins the quota table by kind, so an
 * unquota'd kind would be ranked and then silently dropped. A named fallback makes a missing quota
 * a small allowance rather than a hole; `MEMORY_PACK_QUOTAS` covering every kind is asserted in
 * the tests so the two lists cannot drift apart unnoticed.
 */
export const MEMORY_PACK_DEFAULT_QUOTA: Omit<MemoryPackQuota, 'kind'> = {
  share: 0.05,
  cap: 4,
  perSubject: 2
};

/**
 * Mirrors pg_trgm's default `similarity_threshold`. Without it a single shared padding trigram -
 * two unrelated strings both containing a word starting with "t" - is enough to admit a row.
 */
export const MEMORY_FUZZY_SIMILARITY_THRESHOLD = 0.3;

export const MEMORY_PACK_BUDGET_TOKENS = 6_000;

/* ------------------------------------------------------------------------ *
 * Agent-initiated recall
 *
 * The pack is chosen once, from the opening request, and frozen so the prompt cache survives. That
 * is the right trade for what a task opens with and the wrong one for what it turns out to need: an
 * entity, a path or a decision the first sentence never mentioned is unreachable for the rest of the
 * task, however relevant it is. Recall is the same fusion query asked again, mid-task, in the
 * agent's own words - and because its result lands at the end of the message list rather than in the
 * cached prefix, asking costs the query and the answer, and nothing behind it.
 * ------------------------------------------------------------------------ */

/**
 * A quarter of the pack. A recall answers one question the task already knows it has, so it is
 * bought with the tokens of a long tool result rather than the tokens of a second pack.
 */
export const MEMORY_RECALL_BUDGET_TOKENS = 1_500;
export const MEMORY_RECALL_MAX_BUDGET_TOKENS = 4_000;
export const MEMORY_RECALL_MAX_ITEMS = 12;
export const MEMORY_RECALL_ITEM_CEILING = 40;

/**
 * Even shares, unlike the pack's.
 *
 * The pack is answering "what does this task need to know", where verbatim text earns a fifth of the
 * budget because facts alone measurably lose accuracy. A recall is answering one narrow question,
 * and which tier holds its answer is exactly what the asker does not know - so no tier is given a
 * head start, and `kinds` is there for an agent that does know.
 */
export const MEMORY_RECALL_QUOTAS: readonly MemoryPackQuota[] = MEMORY_KINDS.map((kind) => ({
  kind,
  share: 0.5,
  cap: MEMORY_RECALL_ITEM_CEILING,
  perSubject: 4
}));

/** A procedure that has not been verified within this window stops being injected. */
export const MEMORY_PROCEDURE_STALE_DAYS = 180;
export const MEMORY_PROCEDURE_MIN_SUCCESS_RATE = 0.5;

/* ------------------------------------------------------------------------ *
 * Contradiction resolution policy
 * ------------------------------------------------------------------------ */

export type MemoryContradictionVerdict = 'agree' | 'contradict' | 'refines' | 'unrelated';

export type MemoryContradictionAction =
  | { readonly action: 'none' }
  | { readonly action: 'supersede'; readonly winnerId: string; readonly loserId: string }
  | { readonly action: 'retract'; readonly winnerId: string; readonly loserId: string }
  | { readonly action: 'dispute'; readonly ids: readonly [string, string] }
  | { readonly action: 'support'; readonly ids: readonly [string, string] };

export interface MemoryContradictionSide {
  readonly id: string;
  readonly trust: MemoryTrust;
  readonly observedAt: string;
}

/**
 * The resolution half of section 4.3: deterministic given a verdict, so the only thing a model is ever
 * asked for is the verdict itself. Two things the owner stated that genuinely conflict are never
 * auto-resolved - single-owner is exactly why asking is affordable.
 */
export const resolveMemoryContradiction = (
  left: MemoryContradictionSide,
  right: MemoryContradictionSide,
  verdict: MemoryContradictionVerdict
): MemoryContradictionAction => {
  if (verdict === 'unrelated' || verdict === 'agree') return { action: 'none' };
  if (verdict === 'refines') return { action: 'support', ids: [left.id, right.id] };
  if (left.trust === 'stated' && right.trust === 'stated')
    return { action: 'dispute', ids: [left.id, right.id] };
  if (left.trust === 'stated') return { action: 'retract', winnerId: left.id, loserId: right.id };
  if (right.trust === 'stated') return { action: 'retract', winnerId: right.id, loserId: left.id };
  const leftNewer = new Date(left.observedAt).getTime() >= new Date(right.observedAt).getTime();
  return leftNewer
    ? { action: 'supersede', winnerId: left.id, loserId: right.id }
    : { action: 'supersede', winnerId: right.id, loserId: left.id };
};

/* ------------------------------------------------------------------------ *
 * Byte-stable pack rendering
 * ------------------------------------------------------------------------ */

export interface MemoryPackEntry {
  readonly id: string;
  readonly kind: MemoryKind;
  readonly trust: MemoryTrust;
  readonly observedAt: string;
  readonly validFrom: string;
  readonly validTo: string | null;
  readonly title: string | null;
  readonly tags: readonly string[];
  readonly body: string;
}

export interface RenderedMemoryPack {
  readonly body: string;
  readonly sha256: string;
  readonly itemIds: string[];
  readonly tokensEst: number;
}

const PACK_SECTIONS: readonly { readonly kind: MemoryKind; readonly heading: string }[] = [
  { kind: 'fact', heading: 'Facts' },
  { kind: 'procedure', heading: 'Procedures' },
  { kind: 'episode', heading: 'Episodes' },
  { kind: 'source', heading: 'Verbatim' }
];

const isoInstant = (value: string): string => {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()))
    throw new AthanorError('memory_pack_timestamp_invalid', 'Memory pack timestamps must be dates');
  return parsed.toISOString();
};

/**
 * The pack sits behind a prompt-cache breakpoint, so the same items must always produce the same
 * bytes: entries are ordered by (kind, id) rather than by score, every timestamp is absolute
 * ISO-8601, and nothing derived from the current time or from a request identifier is rendered.
 */
export const renderMemoryPack = (entries: readonly MemoryPackEntry[]): RenderedMemoryPack => {
  const kindOrder = new Map(PACK_SECTIONS.map((section, index) => [section.kind, index]));
  const unique = new Map<string, MemoryPackEntry>();
  for (const entry of entries) unique.set(entry.id, entry);
  const ordered = [...unique.values()].sort(
    (left, right) =>
      (kindOrder.get(left.kind) ?? PACK_SECTIONS.length) -
        (kindOrder.get(right.kind) ?? PACK_SECTIONS.length) || left.id.localeCompare(right.id)
  );

  const lines: string[] = ['# MEMORY PACK'];
  for (const section of PACK_SECTIONS) {
    const members = ordered.filter((entry) => entry.kind === section.kind);
    if (members.length === 0) continue;
    lines.push('', `## ${section.heading}`);
    for (const entry of members) {
      const validity = entry.validTo
        ? `${isoInstant(entry.validFrom)}/${isoInstant(entry.validTo)}`
        : `${isoInstant(entry.validFrom)}/`;
      const head = [
        `- id=${entry.id}`,
        `trust=${entry.trust}`,
        `observed=${isoInstant(entry.observedAt)}`,
        `valid=${validity}`
      ];
      if (entry.tags.length > 0) head.push(`tags=${[...entry.tags].sort().join(',')}`);
      lines.push(head.join(' '));
      if (entry.title) lines.push(`  ${entry.title}`);
      for (const line of entry.body.replace(/\r\n/gu, '\n').trimEnd().split('\n'))
        lines.push(`  ${line}`);
    }
  }
  const body = `${lines.join('\n')}\n`;
  return {
    body,
    sha256: createHash('sha256').update(body, 'utf8').digest('hex'),
    itemIds: ordered.map((entry) => entry.id),
    tokensEst: estimateMemoryTokens(body)
  };
};
