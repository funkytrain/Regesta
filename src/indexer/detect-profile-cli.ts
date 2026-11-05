/**
 * Command-line front end for profile detection.
 *
 *   npm run detect-profile -- --root "/path/to/archive" [--out my-archive.json]
 *
 * It prints what it worked out, shows how twenty real file names would be
 * read under the proposed profile, and only then writes the file. Seeing the
 * readings before trusting them is the point: a profile that looks right in
 * the abstract can still misread every name.
 */

import { parseArgs } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { collectNames, detect, toProfile } from './detect-profile.js';
import { validateProfile, setProfile, type ArchiveProfile } from './profile.js';
import { parseName } from './filename-parser.js';

const { values } = parseArgs({
  options: {
    root: { type: 'string' },
    out: { type: 'string' },
    id: { type: 'string', default: 'my-archive' },
    limit: { type: 'string', default: '5000' },
  },
});

if (!values.root) {
  console.error('Missing --root: the folder whose file names should be examined.');
  console.error('Example: npm run detect-profile -- --root "/path/to/archive"');
  process.exit(1);
}

const root = resolve(values.root);
if (!existsSync(root)) {
  console.error(`That folder does not exist: ${root}`);
  process.exit(1);
}

const names = await collectNames(root, Number.parseInt(values.limit, 10) || 5000);

if (names.length === 0) {
  console.error('No indexable files found in that folder.');
  process.exit(1);
}

const d = detect(names);

console.log(`\nExamined ${d.examined} file names from ${root}\n`);

console.log(`Separator          ${d.separator === ' ' ? '(space)' : d.separator}`);
console.log(`Year position      ${d.yearPosition}`);
console.log(
  `Names with a year  ${Math.round(d.withYear * 100)} %` +
    (d.yearRange ? `   range ${d.yearRange.min}-${d.yearRange.max}` : ''),
);

if (d.candidates.length === 0) {
  console.log(`
No repeated opening word was found, so no naming convention could be
detected. That is not a problem: Regesta works without a profile, you
just catalogue each document by hand instead of reviewing a pre-filled
record.`);
  process.exit(0);
}

console.log('\nCandidate record types (by how often the name starts with them):\n');
for (const c of d.candidates.slice(0, 12)) {
  const typos = c.typos.length
    ? `   possible typos: ${c.typos.map((t) => `${t.word} (${t.count})`).join(', ')}`
    : '';
  console.log(`  ${String(c.count).padStart(6)}  ${c.word}${typos}`);
}

if (d.joiners.length) {
  console.log(
    '\nWords that appear to join two people (marriages):  ' +
      d.joiners.map((j) => `${j.word} (${j.count})`).join(', '),
  );
}

if (d.notRecords.length) {
  console.log('\nNames that do not look like records (they will be skipped):');
  for (const n of d.notRecords) console.log(`  ${n}`);
}

// How the proposal actually reads real names. This is the part worth
// looking at: the numbers above can be right while the readings are wrong.
const draft = toProfile(d, values.id) as unknown as ArchiveProfile;
setProfile(validateProfile(draft, 'detected'));

console.log('\nHow twenty of your file names read under this profile:\n');
const step = Math.max(1, Math.floor(names.length / 20));
for (let i = 0; i < names.length && i < step * 20; i += step) {
  const r = parseName(names[i]!);
  const type = r.recordType.replace(/^unknown_/, '~');
  console.log(
    `  ${names[i]!.slice(0, 52).padEnd(54)}` +
      `${type.padEnd(16)} ${String(r.year ?? '-').padEnd(6)} ${(r.name ?? '-').slice(0, 30)}`,
  );
}

const out = resolve(values.out ?? `profiles/${values.id}.json`);
await writeFile(out, JSON.stringify(draft, null, 2) + '\n', 'utf8');

console.log(`
Written to ${out}

Before using it, open that file and work through its "_todo" list: the
record types come out named "unknown_*" because the machine can tell that a
word repeats but not what it means. Then index with:

  REGESTA_PROFILE=${values.id} npm run index -- --root "${root}"
`);
