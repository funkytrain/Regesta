/**
 * File name reader.
 *
 * Many genealogical archives follow a naming convention that already encodes
 * a catalogue record. The reference corpus this parser was built against uses
 *
 *     RECORD TYPE + FULL NAME + YEAR [+ page number]
 *     'BAUTISMO YSABEL JOAN DEL PESSO PASTOR 1596 2.jpg'
 *
 * That name is a catalogue record in itself: type, person and date. This
 * module extracts it so the user is offered a pre-filled record, turning
 * cataloguing into reviewing rather than typing.
 *
 * The goal is NOT to rename anything. The existing names preserve the
 * spelling under which the name appears in the document ('YSABEL', not
 * 'Isabel'), which is historical evidence, not noise.
 *
 * The vocabulary -- which words name a baptism, which typos to tolerate,
 * which spellings are the same letter -- does not live here: it comes from
 * the archive profile, so another language or another convention needs a
 * JSON file and not a change to this code. What lives here is the machinery:
 * splitting the name into fields, finding the year, telling a page number
 * from a date, and weighing how reliable the reading is.
 */

import { compiled, profile, type RecordType } from './profile.js';

export type { RecordType };

export interface ParsedName {
  recordType: RecordType;
  /** Name as it appears in the file, with its spelling left untouched. */
  name: string | null;
  /** Second person, in records joining two (marriages, licences). */
  secondName: string | null;
  year: number | null;
  /** Trailing numeric suffix: the page within a single document. */
  page: number | null;
  /** 0..1 — how reliable the reading is. */
  confidence: number;
  /** Reasons why the user should take a look at this record. */
  warnings: Warning[];
}

export type Warning =
  | 'no_year'
  | 'year_out_of_range'
  | 'unrecognised_type'
  | 'no_name'
  | 'typo_in_type'
  | 'flagged_by_user';

/**
 * Files that are not documents and should be ignored without fuss. These are
 * artefacts of the file system itself, not of any particular archive, so
 * they stay in the code.
 */
const IGNORE = /^(desktop\.ini|thumbs\.db|\.ds_store|.*\.csv)$/i;

export function isIgnorable(fileName: string): boolean {
  return IGNORE.test(fileName.trim());
}

/**
 * Folders that hold no describable documents. The Synology ones matter: every
 * snapshot under #snapshot is a full copy of the archive.
 *
 * The indexer, the watcher and the profile detector all read this one list.
 * When the watcher kept a copy of its own, it fell out of step, walked every
 * snapshot and ran the system out of file watchers.
 */
const SKIPPED_FOLDERS = new Set(['.git', 'node_modules', '@eaDir', '#recycle', '#snapshot']);

/** Whether a folder should be left out of indexing and watching. */
export function isSkippedFolder(name: string): boolean {
  return (name.startsWith('.') && name !== '.' && name !== '..') || SKIPPED_FOLDERS.has(name);
}

/**
 * Whether a path relative to the root falls inside a skipped folder. It takes
 * the relative path, not the absolute one: the root itself may live anywhere.
 */
export function inSkippedFolder(relativePath: string): boolean {
  return relativePath.split(/[\\/]/).some(isSkippedFolder);
}

/** Skipped folder names, for queries that need them. */
export const SKIPPED_FOLDER_NAMES: readonly string[] = [...SKIPPED_FOLDERS];

/**
 * Whether the name looks like a certificate at all.
 *
 * Screenshots, camera files and offprints would otherwise fill the archive
 * with impossible years. When in doubt it is better not to read the name:
 * an empty record beats a false one. The patterns come from the profile.
 */
export function looksLikeCertificate(fileName: string): boolean {
  return !compiled().notRecords.some((p) => p.test(fileName));
}

/**
 * Reads a file name and returns whatever can be deduced from it.
 * Never throws: an unreadable name comes back with confidence 0 and its
 * warnings.
 */
export function parseName(fileName: string): ParsedName {
  const p = compiled();
  const warnings: Warning[] = [];

  // 1. Strip the extension.
  let rest = fileName.replace(/\.[A-Za-z0-9]{1,5}$/, '').trim();

  // 2. Set aside the user's own marks ('POSIBLE ...', 'ETIQUETAR ...').
  const mark = rest.match(p.userMarks);
  if (mark) {
    warnings.push('flagged_by_user');
    rest = rest.slice(mark[0].length).trim();
  }

  // 3. Identify the record type from the start of the name.
  let recordType: RecordType = 'unknown';
  for (const [pattern, type, isTypo] of p.types) {
    const m = rest.match(pattern);
    if (m) {
      recordType = type;
      if (isTypo) warnings.push('typo_in_type');
      rest = rest.slice(m[0].length).trim();
      break;
    }
  }
  if (recordType === 'unknown') warnings.push('unrecognised_type');

  // 4. Split off the page suffix: ' 1596 2' → year 1596, page 2.
  //    The page is looked for first because it sits at the end and is the
  //    shorter of the two; searching for the year first could misread
  //    '1596 2'.
  let page: number | null = null;
  const mPage = rest.match(/\s(\d{1,2})$/);
  if (mPage?.[1]) {
    const candidate = Number.parseInt(mPage[1], 10);
    // It is only a page if what precedes it looks like a year; otherwise that
    // stray number is probably part of the name.
    if (/\b\d{4}\s*$/.test(rest.slice(0, mPage.index))) {
      page = candidate;
      rest = rest.slice(0, mPage.index).trim();
    }
  }

  // 5. The year: the last group of exactly 4 digits.
  //    Four and not three, because archives also hold paginated material
  //    ('114-5.pdf', pages from journals and books) whose numbers are not
  //    dates.
  let year: number | null = null;
  const years = [...rest.matchAll(/\b(\d{4})\b/g)];
  const last = years.at(-1);
  if (last?.[1] !== undefined && last.index !== undefined) {
    year = Number.parseInt(last[1], 10);
    rest = (rest.slice(0, last.index) + ' ' + rest.slice(last.index + last[1].length)).trim();
    if (year < p.yearMin || year > p.yearMax) {
      // A baptism in 1165 does not exist in a parish register: it is nearly
      // always a mistyped digit. The value is kept and flagged, rather than
      // silently discarded.
      warnings.push('year_out_of_range');
    }
  } else {
    warnings.push('no_year');
  }

  // 6. What is left is the name (or the two names).
  const clean = rest.replace(/\s{2,}/g, ' ').trim();
  let name: string | null = clean || null;
  let secondName: string | null = null;

  if (clean) {
    const split = clean.match(p.joiners);
    // It is only split when the joiner leaves enough text on both sides; that
    // way 'FRANCISCA MARIA GERONIMA Y JUANA MARIA TERESA' is split, but a
    // name beginning with the joiner does not break the reading.
    if (split?.index !== undefined) {
      const left = clean.slice(0, split.index).trim();
      const right = clean.slice(split.index + split[0].length).trim();
      if (left.length >= 3 && right.length >= 3) {
        name = left;
        secondName = right;
      }
    }
  } else {
    warnings.push('no_name');
  }

  return {
    recordType,
    name,
    secondName,
    year,
    page,
    confidence: computeConfidence(recordType, name, year, warnings),
    warnings,
  };
}

/**
 * Confidence of the reading. It is what orders the review queue: the user
 * validates the high-confidence ones in bulk and spends their attention on
 * the rest.
 */
function computeConfidence(
  type: RecordType,
  name: string | null,
  year: number | null,
  warnings: readonly Warning[],
): number {
  let c = 0;
  if (type !== 'unknown') c += 0.45;
  if (name && name.length >= 5) c += 0.35;
  if (year !== null) c += 0.2;

  if (warnings.includes('year_out_of_range')) c -= 0.25;
  if (warnings.includes('typo_in_type')) c -= 0.05;
  if (warnings.includes('flagged_by_user')) c -= 0.15;

  return Math.max(0, Math.min(1, Number(c.toFixed(2))));
}

/**
 * Match key for a name: without diacritics, without punctuation and with
 * the historical spelling variants of the profile folded into a common form,
 * so that 'YSABEL' can be matched with 'ISABEL' or 'JUSEPA' with 'JOSEFA'.
 *
 * It does not alter the name that is displayed: it only produces the key used
 * for lookups.
 */
export function matchKey(name: string): string {
  let s = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z\s]/g, ' ');

  // The order of the rules matters and belongs to the profile: consonant
  // clusters before vowels, so that 'JUSEPHA' reaches 'JOSEFA' instead of
  // stopping halfway.
  for (const [from, to] of compiled().rules) s = s.replace(from, to);

  return s.replace(/\s{2,}/g, ' ').trim();
}

/** Roles a person can hold in an entry, as declared by the profile. */
export function roles(): string[] {
  return profile().roles;
}
