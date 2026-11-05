/**
 * Archive profile: the vocabulary of one particular archive.
 *
 * The parser knows how to split a file name into fields, find the year, tell
 * a page number from a date and weigh how reliable the reading is. What it
 * cannot know is the vocabulary: that a baptism is written BAUTISMO, that
 * BAUUTISMO is a typo for it, or that in 17th-century Spanish registers PH
 * and F are the same letter.
 *
 * That vocabulary lives here, in a JSON file, so that an archive in another
 * language or with another naming convention is supported by writing a
 * profile rather than by changing this code.
 *
 * The profile shipped as the default, `es-parish`, describes Spanish parish
 * registers and is the best tested of them: it has been in daily use against
 * an archive of some 6,500 documents. It doubles as the worked example for
 * anyone writing their own.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Canonical record types. A profile maps its own spellings onto these. */
export const RECORD_TYPES = [
  'baptism',
  'birth',
  'marriage',
  'marriage_licence',
  'burial',
  'confirmation',
  'nuptial_blessing',
  'census',
  'index',
  'record',
  'unknown',
] as const;

export type RecordType = (typeof RECORD_TYPES)[number];

/** One spelling rule of the match key, with the reason it exists. */
export interface SpellingRule {
  /** Pattern, as a JavaScript regular expression source. */
  from: string;
  /** What it is replaced with. */
  to: string;
  /**
   * Why the rule exists, with an example. Not decorative: it is what lets
   * someone in another country write their own profile by analogy rather
   * than blindly.
   */
  why?: string;
  /** Applied to the whole key rather than word by word. Default: true. */
  global?: boolean;
}

export interface ArchiveProfile {
  id: string;
  name: string;
  /** Language of the vocabulary, as an ISO 639-1 code. Informative. */
  language?: string;
  /**
   * Shape of the file name, for documentation. The parser does not read this
   * literally: it looks for the record type at the start, the year as the
   * last group of four digits, and the page as a trailing short number.
   */
  filenamePattern?: string;
  yearRange: { min: number; max: number | 'current' };
  /**
   * Spellings of each record type. `match` holds the correct ones and
   * `typos` the misspellings seen in practice, which are accepted but
   * flagged, because correcting thousands of files to please a parser would
   * be working for the machine.
   */
  recordTypes: Partial<Record<RecordType, { match: string[]; typos?: string[] }>>;
  /** Words joining the two people of a marriage ('Y', 'AND', 'E'). */
  joiners: string[];
  /** Prefixes the user adds to flag a file for review. */
  userMarks: string[];
  /** Patterns of names that are not records at all. */
  notRecords: string[];
  /** Roles a person can hold in an entry, most frequent first. */
  roles: string[];
  /** Spelling equivalences folded into the match key. */
  matchKeyRules: SpellingRule[];
}

/** Profile currently loaded. */
let current: ArchiveProfile | null = null;

/**
 * Validates a profile read from disk.
 *
 * It fails at load time and says what is wrong, rather than failing on file
 * 900 of an indexing run: a bad profile must be a clear error, not silently
 * degraded behaviour.
 */
export function validateProfile(raw: unknown, source: string): ArchiveProfile {
  const fail = (what: string): never => {
    throw new Error(`Invalid archive profile (${source}): ${what}`);
  };

  if (typeof raw !== 'object' || raw === null) fail('it is not an object');
  const p = raw as Record<string, unknown>;

  if (typeof p.id !== 'string' || !p.id.trim()) fail('missing "id"');
  if (typeof p.name !== 'string' || !p.name.trim()) fail('missing "name"');

  const range = p.yearRange as { min?: unknown; max?: unknown } | undefined;
  if (!range || typeof range.min !== 'number') fail('"yearRange.min" must be a number');
  if (range!.max !== 'current' && typeof range!.max !== 'number') {
    fail('"yearRange.max" must be a number or "current"');
  }

  if (typeof p.recordTypes !== 'object' || p.recordTypes === null) {
    fail('missing "recordTypes"');
  }
  for (const [key, value] of Object.entries(p.recordTypes as object)) {
    // A detected profile names its types `unknown_*` until a person maps
    // them: the machine can see that a word repeats, not what it means.
    // Those are accepted so the draft can be tried out, and they simply
    // read as `unknown` until renamed.
    if (!(RECORD_TYPES as readonly string[]).includes(key) && !key.startsWith('unknown_')) {
      fail(`unknown record type "${key}". Valid ones: ${RECORD_TYPES.join(', ')}`);
    }
    const v = value as { match?: unknown };
    if (!Array.isArray(v?.match) || v.match.length === 0) {
      fail(`record type "${key}" has no "match" spellings`);
    }
  }

  for (const field of ['joiners', 'userMarks', 'notRecords', 'roles'] as const) {
    if (!Array.isArray(p[field])) fail(`"${field}" must be a list`);
  }

  if (!Array.isArray(p.matchKeyRules)) fail('"matchKeyRules" must be a list');
  for (const [i, rule] of (p.matchKeyRules as SpellingRule[]).entries()) {
    if (typeof rule?.from !== 'string' || typeof rule?.to !== 'string') {
      fail(`rule ${i + 1} of "matchKeyRules" needs "from" and "to"`);
    }
    try {
      new RegExp(rule.from);
    } catch {
      fail(`rule ${i + 1} of "matchKeyRules": "${rule.from}" is not a valid expression`);
    }
  }

  // Every pattern is compiled up front, so a malformed one is reported here
  // and not halfway through an indexing run.
  for (const [i, pattern] of (p.notRecords as string[]).entries()) {
    try {
      new RegExp(pattern, 'i');
    } catch {
      fail(`entry ${i + 1} of "notRecords": "${pattern}" is not a valid expression`);
    }
  }

  return raw as ArchiveProfile;
}

/** Reads and validates a profile from a path. */
export function loadProfileFrom(path: string): ArchiveProfile {
  if (!existsSync(path)) {
    throw new Error(`Archive profile not found: ${path}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`Archive profile ${path} is not valid JSON: ${String(e)}`);
  }
  return validateProfile(parsed, path);
}

/**
 * Directory holding the bundled profiles. It sits beside the built code, so
 * it works the same from source and from the container.
 */
function profilesDir(): string {
  for (const candidate of [
    join(HERE, '..', '..', 'profiles'),
    join(HERE, '..', 'profiles'),
    join(process.cwd(), 'profiles'),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return join(process.cwd(), 'profiles');
}

/**
 * The active profile.
 *
 * REGESTA_PROFILE takes either the id of a bundled profile
 * ('es-parish') or the path to a file of your own.
 */
export function profile(): ArchiveProfile {
  if (current) return current;

  const wanted = process.env.REGESTA_PROFILE ?? 'es-parish';
  const path = isAbsolute(wanted) || wanted.includes('/') || wanted.includes('\\')
    ? wanted
    : join(profilesDir(), `${wanted}.json`);

  current = loadProfileFrom(path);
  return current;
}

/** Replaces the active profile. Used by the tests and by profile detection. */
export function setProfile(p: ArchiveProfile | null): void {
  current = p;
}

/* ---------- Derived forms, compiled once ---------- */

interface Compiled {
  types: ReadonlyArray<readonly [RegExp, RecordType, boolean]>;
  userMarks: RegExp;
  joiners: RegExp;
  notRecords: RegExp[];
  rules: ReadonlyArray<readonly [RegExp, string]>;
  yearMin: number;
  yearMax: number;
}

const compiledCache = new WeakMap<ArchiveProfile, Compiled>();

/** Escapes a literal so it can go inside a regular expression. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Turns the profile into the patterns the parser uses.
 *
 * Longer spellings are tried first, so that 'MARRIAGE LICENCE' is not
 * swallowed by 'MARRIAGE'.
 */
export function compiled(p: ArchiveProfile = profile()): Compiled {
  const cached = compiledCache.get(p);
  if (cached) return cached;

  const types: Array<readonly [RegExp, RecordType, boolean]> = [];
  const entries: Array<[RecordType, string, boolean]> = [];

  for (const [type, spec] of Object.entries(p.recordTypes)) {
    for (const spelling of spec!.match) entries.push([type as RecordType, spelling, false]);
    for (const spelling of spec!.typos ?? []) entries.push([type as RecordType, spelling, true]);
  }
  entries.sort((a, b) => b[1].length - a[1].length);

  for (const [type, spelling, isTypo] of entries) {
    // Internal whitespace is allowed to vary: 'EXPEDIENTE  MATRIMONIAL' with
    // two spaces is the same spelling.
    const body = escapeRe(spelling).replace(/\\?\s+/g, '\\s+');
    types.push([new RegExp(`^${body}\\b`, 'i'), type, isTypo]);
  }

  const marks = p.userMarks.map(escapeRe).join('|');
  const joiners = p.joiners.map(escapeRe).join('|');

  const result: Compiled = {
    types,
    userMarks: new RegExp(`^(${marks || '(?!)'})\\s+`, 'i'),
    joiners: new RegExp(`\\s+(?:${joiners || '(?!)'})\\s+`, 'i'),
    notRecords: p.notRecords.map((r) => new RegExp(r, 'i')),
    rules: p.matchKeyRules.map(
      (r) => [new RegExp(r.from, r.global === false ? '' : 'g'), r.to] as const,
    ),
    yearMin: p.yearRange.min,
    yearMax: p.yearRange.max === 'current' ? new Date().getFullYear() : p.yearRange.max,
  };

  compiledCache.set(p, result);
  return result;
}
