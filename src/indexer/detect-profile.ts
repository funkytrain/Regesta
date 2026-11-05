/**
 * Proposes an archive profile from the file names of a folder.
 *
 *   npm run detect-profile -- --root "/path/to/archive"
 *
 * Someone who has reached a few thousand certificates almost always has a
 * naming convention: nobody gets that far dropping files into a folder under
 * whatever name the scanner gave them, because they would never find
 * anything. What differs between people is the order of the fields, the
 * language of the words and the separator -- variations on one scheme, not
 * different schemes.
 *
 * So rather than asking the user to describe their convention from scratch,
 * this reads it off their files and hands them a profile to correct. It does
 * not guess the spelling rules: those need linguistic knowledge of the
 * period and the language, and a wrong rule silently merges two people who
 * are not the same. It leaves them empty, documented, and points at
 * es-parish as the worked example.
 */

import { readdir } from 'node:fs/promises';
import { join, extname, basename } from 'node:path';
import { isIgnorable, isSkippedFolder } from './filename-parser.js';
import { RECORD_TYPES } from './profile.js';

const INDEXABLE = new Set([
  '.jpg', '.jpeg', '.png', '.tif', '.tiff', '.webp', '.gif', '.bmp',
  '.pdf', '.txt', '.doc', '.docx', '.odt', '.rtf', '.md',
]);

export interface Detection {
  /** How many file names were examined. */
  examined: number;
  /** Candidate record types, most frequent first. */
  candidates: Array<{ word: string; count: number; typos: Array<{ word: string; count: number }> }>;
  /** Dominant separator between fields. */
  separator: string;
  /** Where the four-digit year tends to sit. */
  yearPosition: 'end' | 'start' | 'middle' | 'unknown';
  /** Range of plausible years found. */
  yearRange: { min: number; max: number } | null;
  /** Proportion of names carrying a plausible year, 0..1. */
  withYear: number;
  /** Names that look like camera files or screenshots. */
  notRecords: string[];
  /** Words that appear to join two people, with how often. */
  joiners: Array<{ word: string; count: number }>;
}

/** Walks the folder and collects the indexable file names. */
export async function collectNames(root: string, cap = 5000): Promise<string[]> {
  const names: string[] = [];

  async function descend(dir: string): Promise<void> {
    if (names.length >= cap) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (names.length >= cap) return;
      if (isSkippedFolder(e.name)) continue;
      if (e.isDirectory()) await descend(join(dir, e.name));
      else if (e.isFile() && !isIgnorable(e.name) && INDEXABLE.has(extname(e.name).toLowerCase())) {
        names.push(e.name);
      }
    }
  }

  await descend(root);
  return names;
}

/** Edit distance, capped: beyond `max` the exact figure does not matter. */
function editDistance(a: string, b: string, max = 2): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + cost);
      best = Math.min(best, row[j]!);
    }
    if (best > max) return max + 1;
    prev = row;
  }
  return prev[b.length]!;
}

const NOT_RECORD_HINTS = [
  /^FireShot\s+Capture/i,
  /^Screenshot/i,
  /^Screen\s+Shot/i,
  /^Captura\s+de\s+pantalla/i,
  /^(IMG|DSC|DSCN|P)[-_]?\d+/i,
  /^WhatsApp\s+Image/i,
  /^\d{1,4}\.(jpe?g|png|tiff?)$/i,
  /^Scan\s*\d+$/i,
];

/**
 * Examines the names and works out what the convention looks like.
 *
 * The heuristic rests on one observation: in an archive with a convention,
 * the first word of the name is the record type and repeats across hundreds
 * of files, while the person's name is nearly unique. So the frequency of
 * the opening word separates one from the other on its own.
 */
export function detect(names: string[]): Detection {
  const currentYear = new Date().getFullYear();
  const clean = names.map((n) => basename(n, extname(n)).trim()).filter(Boolean);

  const notRecords: string[] = [];
  const candidateNames: string[] = [];
  for (const n of clean) {
    if (NOT_RECORD_HINTS.some((p) => p.test(n))) notRecords.push(n);
    else candidateNames.push(n);
  }

  // Dominant separator: the one appearing in most names.
  const separators: Array<[string, RegExp]> = [
    [' ', /\S[ ]\S/],
    ['_', /\S_\S/],
    ['-', /\S-\S/],
  ];
  let separator = ' ';
  let bestCount = 0;
  for (const [sep, pattern] of separators) {
    const count = candidateNames.filter((n) => pattern.test(n)).length;
    if (count > bestCount) {
      bestCount = count;
      separator = sep;
    }
  }

  const split = (n: string): string[] =>
    n.split(separator === ' ' ? /\s+/ : new RegExp(`[${separator}\\s]+`)).filter(Boolean);

  // Frequency of the opening word.
  const firstWord = new Map<string, number>();
  for (const n of candidateNames) {
    const w = split(n)[0];
    if (!w || /^\d+$/.test(w)) continue;
    const key = w.toUpperCase();
    firstWord.set(key, (firstWord.get(key) ?? 0) + 1);
  }

  // A record type repeats; a person's name barely does. The threshold is
  // deliberately low so a small archive still yields candidates.
  const threshold = Math.max(3, Math.floor(candidateNames.length * 0.01));
  const frequent = [...firstWord.entries()]
    .filter(([, n]) => n >= threshold)
    .sort((a, b) => b[1] - a[1]);

  // Typos: a rare word one or two edits away from a frequent one is almost
  // always a misspelling of it, not a type of its own.
  const rare = [...firstWord.entries()].filter(([, n]) => n < threshold);
  const candidates = frequent.map(([word, count]) => ({
    word,
    count,
    typos: rare
      .filter(([r]) => r !== word && editDistance(r, word) <= 2 && r.length >= 4)
      .map(([w, n]) => ({ word: w, count: n }))
      .sort((a, b) => b.count - a.count),
  }));

  // Position of the year, and its range.
  let atEnd = 0;
  let atStart = 0;
  let withYear = 0;
  let min = Infinity;
  let max = -Infinity;

  for (const n of candidateNames) {
    const parts = split(n);
    const found: Array<[number, number]> = [];
    parts.forEach((w, i) => {
      if (/^\d{4}$/.test(w)) {
        const y = Number.parseInt(w, 10);
        if (y >= 1300 && y <= currentYear) found.push([i, y]);
      }
    });
    if (found.length === 0) continue;

    withYear++;
    const [idx, year] = found[found.length - 1]!;
    if (year < min) min = year;
    if (year > max) max = year;

    // The trailing page number means the year is not always the very last
    // token: one position of slack counts as 'at the end'.
    if (idx >= parts.length - 2) atEnd++;
    else if (idx === 0) atStart++;
  }

  // Joiners: the word separating the two people of a marriage.
  //
  // Frequency alone is not enough. Given names (MARIA, JUAN) and particles
  // (DE, DEL, DA) sit between two capitalised words just as often, and
  // accepting one as a joiner would split compound names down the middle --
  // turning 'JOSE MARIA PEREZ' into two people. Two further signals separate
  // them:
  //
  //   1. A joiner is rare in single-person records. 'Y' appears in almost
  //      every marriage and hardly any baptism; 'MARIA' appears in both.
  //   2. A joiner is short. Real ones are Y, E, AND, CON, COM, MIT.
  //
  // Only the first test is decisive, so it is the one that decides.
  const twoPersonWords = new Map<string, number>();
  const onePersonWords = new Map<string, number>();

  // Names starting with the most frequent word are taken as the single-person
  // baseline: in a parish archive that is the baptisms, which outnumber
  // everything else.
  const commonest = frequent[0]?.[0];

  for (const n of candidateNames) {
    const parts = split(n).filter((w) => !/^\d+$/.test(w));
    const isBaseline = commonest !== undefined && parts[0]?.toUpperCase() === commonest;
    const into = isBaseline ? onePersonWords : twoPersonWords;

    for (let i = 1; i < parts.length - 1; i++) {
      const w = parts[i]!.toUpperCase();
      if (w.length > 4) continue;
      if ((parts[i - 1]?.length ?? 0) < 3 || (parts[i + 1]?.length ?? 0) < 3) continue;
      into.set(w, (into.get(w) ?? 0) + 1);
    }
  }

  const baselineTotal = candidateNames.filter(
    (n) => commonest !== undefined && split(n)[0]?.toUpperCase() === commonest,
  ).length;
  const otherTotal = Math.max(1, candidateNames.length - baselineTotal);

  // Nobiliary particles are the one case the statistics cannot settle: in a
  // small archive 'DE' may happen to appear only in marriages, and taken as
  // a joiner it would split 'PIET DE VRIES' in half. They are excluded by
  // name, because the list is short, closed and the same across the
  // languages this tool is likely to meet.
  const PARTICLES = new Set([
    'DE', 'DEL', 'DA', 'DO', 'DI', 'DU', 'VAN', 'VON', 'LA', 'LE', 'LOS',
    'LAS', 'DOS', 'DAS', 'DELL', 'DELLA', 'DER', 'TEN', 'TER', 'MC', 'MAC',
    'SAN', 'SANTA', 'ST',
  ]);

  const joiners = [...twoPersonWords.entries()]
    .filter(([w, count]) => {
      if (firstWord.has(w) || PARTICLES.has(w)) return false;
      if (count < Math.max(3, otherTotal * 0.15)) return false;
      // Its rate among single-person records must be far lower: a given name
      // shows up at a similar rate in both, a joiner almost only in one.
      const inOne = (onePersonWords.get(w) ?? 0) / Math.max(1, baselineTotal);
      const inTwo = count / otherTotal;
      return inOne < inTwo / 4;
    })
    .map(([word, count]) => ({ word, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 4);

  const yearPosition: Detection['yearPosition'] =
    withYear === 0
      ? 'unknown'
      : atEnd / withYear > 0.6
        ? 'end'
        : atStart / withYear > 0.6
          ? 'start'
          : 'middle';

  return {
    examined: clean.length,
    candidates,
    separator,
    yearPosition,
    yearRange: withYear > 0 ? { min, max } : null,
    withYear: clean.length ? withYear / clean.length : 0,
    notRecords: [...new Set(notRecords.map((n) => n.slice(0, 40)))].slice(0, 10),
    joiners,
  };
}

/**
 * Builds a profile skeleton from the detection.
 *
 * Every record type is left as `unknown` for the user to name: the machine
 * can tell that BAUTISMO repeats 1,286 times, but not that it means a
 * baptism. That mapping is the one thing a person has to supply.
 */
export function toProfile(d: Detection, id = 'my-archive'): Record<string, unknown> {
  const recordTypes: Record<string, { match: string[]; typos?: string[] }> = {};

  for (const c of d.candidates.slice(0, 12)) {
    const key = `unknown_${c.word.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
    recordTypes[key] = {
      match: [c.word],
      ...(c.typos.length ? { typos: c.typos.map((t) => t.word) } : {}),
    };
  }

  return {
    id,
    name: `Profile detected from ${d.examined} file names`,
    _todo: [
      `Rename each "unknown_*" key to one of: ${RECORD_TYPES.join(', ')}.`,
      'Check the "typos" lists: they were guessed by similarity.',
      'Fill in "matchKeyRules" with the spelling equivalences of your language',
      'and period. See profiles/es-parish.json for a worked example -- leaving',
      'it empty is safe, it only means names are matched literally.',
      'Trim "roles" to the ones your records actually use.',
    ],
    filenamePattern:
      d.yearPosition === 'start' ? '{year} {type} {name}' : '{type} {name} {year} [{page}]',
    yearRange: {
      min: d.yearRange ? Math.max(1300, d.yearRange.min - 10) : 1400,
      max: 'current',
    },
    recordTypes,
    joiners: d.joiners.length ? d.joiners.map((j) => j.word) : ['Y', 'AND', 'E'],
    userMarks: [],
    notRecords: [
      '^FireShot\\s+Capture',
      '^Screenshot',
      '^(IMG|DSC|DSCN|P)[-_]?\\d+',
      '^WhatsApp\\s+Image',
      '^\\d{1,4}\\.(jpe?g|png|tiff?)$',
    ],
    roles: [
      'subject', 'father', 'mother', 'godfather', 'godmother',
      'spouse', 'witness', 'deceased', 'celebrant', 'informant', 'other',
    ],
    matchKeyRules: [],
  };
}
