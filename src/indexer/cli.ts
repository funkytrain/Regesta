/**
 * Command-line launcher for the indexer.
 *
 *   npm run index -- --root "/path/to/archive" [--no-thumbnails]
 */

import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { openDb, writeSetting } from '../server/db.js';
import { index, findDuplicates } from './indexer.js';

const { values } = parseArgs({
  options: {
    root: { type: 'string' },
    db: { type: 'string', default: 'data/regesta.db' },
    thumbnails: { type: 'string', default: 'data/thumbnails' },
    'no-thumbnails': { type: 'boolean', default: false },
  },
});

if (!values.root) {
  console.error('Missing --root: the folder to index.');
  console.error('Example: npm run index -- --root "/path/to/archive"');
  process.exit(1);
}

const root = resolve(values.root);
const db = openDb(resolve(values.db));
writeSetting(db, 'document_root', root);

console.log(`Indexing ${root}`);
console.log('Files are only read: nothing is moved, renamed or deleted.\n');

let lastPercent = -1;

const summary = await index(db, {
  root,
  thumbnailDir: resolve(values.thumbnails),
  thumbnails: !values['no-thumbnails'],
  onProgress: (seen, total) => {
    const pct = Math.floor((seen / total) * 100);
    if (pct !== lastPercent && pct % 5 === 0) {
      lastPercent = pct;
      process.stdout.write(`\r  ${pct}%  ${seen}/${total}`);
    }
  },
});

const seconds = (summary.ms / 1000).toFixed(1);
console.log(`\n\nFinished in ${seconds} s`);
console.log(`  documents found     : ${summary.total}`);
console.log(`  added               : ${summary.added}`);
console.log(`  updated             : ${summary.updated}`);
console.log(`  missing (gone)      : ${summary.missing}`);
console.log(`  errors              : ${summary.errors}`);

const duplicates = findDuplicates(db);
if (duplicates.length > 0) {
  console.log(`\n${duplicates.length} groups of files with identical content:`);
  for (const g of duplicates.slice(0, 5)) {
    console.log(`  · ${g.paths.length} copies`);
    for (const p of g.paths) console.log(`      ${p}`);
  }
  if (duplicates.length > 5) console.log(`  … and ${duplicates.length - 5} more groups`);
}

const toReview = db
  .prepare("SELECT COUNT(*) AS n FROM suggestion WHERE confidence < 0.9 AND status = 'pending'")
  .get() as { n: number };
console.log(`\nRecords read from file names: ${summary.added}`);
console.log(`  of those, to review: ${toReview.n}`);

db.close();
