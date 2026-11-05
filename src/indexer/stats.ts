/**
 * Report on the state of the index.
 *
 *   npx tsx src/indexer/stats.ts [db-path]
 *
 * It exists so the contents of the database can be checked from the terminal
 * without opening the interface.
 */

import { resolve } from 'node:path';
import { openDb } from '../server/db.js';

const db = openDb(resolve(process.argv[2] ?? 'data/regesta.db'));

const n = (sql: string, ...p: unknown[]): number =>
  ((db.prepare(sql).get(...(p as never[])) as { n: number } | undefined)?.n ?? 0);

console.log('DOCUMENTS');
console.log(`  indexed          ${n('SELECT COUNT(*) AS n FROM document')}`);
console.log(`  present          ${n('SELECT COUNT(*) AS n FROM document WHERE present = 1')}`);
console.log(`  with thumbnail   ${n('SELECT COUNT(*) AS n FROM document WHERE thumbnail IS NOT NULL')}`);

console.log('\nBY RECORD TYPE');
const types = db
  .prepare(
    `SELECT COALESCE(record_type,'(unread)') AS t, COUNT(*) AS n
     FROM suggestion GROUP BY t ORDER BY n DESC`,
  )
  .all() as Array<{ t: string; n: number }>;
for (const row of types) console.log(`  ${row.t.padEnd(24)} ${String(row.n).padStart(5)}`);

// The range is computed from plausible years only: a handful of files carry
// bundle reference codes or download identifiers in their names that look
// like dates, and announcing those as the extremes would give a false picture
// of the archive.
const range = db
  .prepare('SELECT MIN(year) AS a, MAX(year) AS b FROM suggestion WHERE year BETWEEN 1400 AND 2026')
  .get() as { a: number; b: number };
const impossible = n(
  'SELECT COUNT(*) AS n FROM suggestion WHERE year IS NOT NULL AND year NOT BETWEEN 1400 AND 2026',
);
console.log(`\nDATE RANGE  ${range.a} – ${range.b}`);
if (impossible > 0) {
  console.log(`  (${impossible} files with a number that is not a date, flagged for review)`);
}

console.log('\nFILE NAME READING');
const high = n('SELECT COUNT(*) AS n FROM suggestion WHERE confidence >= 0.9');
const total = n('SELECT COUNT(*) AS n FROM suggestion');
console.log(`  reliable         ${high} of ${total}  (${((high / total) * 100).toFixed(1)} %)`);
console.log(`  to review        ${total - high}`);

console.log('\nCLASSIFICATION SCHEME (seeded from the folders)');
const scheme = db
  .prepare(
    `SELECT u.title, u.level, u.parent_id,
            (SELECT COUNT(*) FROM document d WHERE d.unit_id = u.id) AS docs
     FROM unit u WHERE u.parent_id IS NULL ORDER BY u.title`,
  )
  .all() as Array<{ title: string; level: string; docs: number }>;
for (const row of scheme) console.log(`  ${row.title.padEnd(42)} ${String(row.docs).padStart(5)} doc.`);

const duplicates = db
  .prepare(
    `SELECT COUNT(*) AS n FROM (
       SELECT hash FROM document WHERE present = 1 GROUP BY hash HAVING COUNT(*) > 1)`,
  )
  .get() as { n: number };
console.log(`\nDUPLICATE GROUPS  ${duplicates.n}`);

db.close();
