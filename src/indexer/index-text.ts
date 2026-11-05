/**
 * Extracts the text of the documents and indexes their content.
 *
 *   npm run index-text
 *
 * This is a separate pass from file indexing because it is far slower:
 * opening every PDF and reading all its pages takes time. It can be repeated
 * as often as needed, because it only processes what has changed.
 */

import { parseArgs } from 'node:util';
import { resolve, join } from 'node:path';
import { openDb, readSetting, inTransaction } from '../server/db.js';
import { extractText } from './extract-text.js';

const { values } = parseArgs({
  options: {
    db: { type: 'string', default: 'data/regesta.db' },
    redo: { type: 'boolean', default: false },
    limit: { type: 'string' },
  },
});

const db = openDb(resolve(values.db));
const root = readSetting(db, 'document_root');
if (!root) {
  console.error('No folder has been indexed yet. Run "npm run index" first.');
  process.exit(1);
}

const EXTRACTABLE = ['.pdf', '.docx', '.txt', '.md'];

// Documents with no text, or whose file has changed since the last
// extraction; with --redo, all of them.
const pending = db
  .prepare(
    `SELECT d.id, d.path, d.extension, d.hash, d.bytes
     FROM document d
     LEFT JOIN document_text t ON t.document_id = d.id
     WHERE d.present = 1
       AND d.extension IN (${EXTRACTABLE.map(() => '?').join(',')})
       ${values.redo ? '' : 'AND (t.document_id IS NULL OR t.hash != d.hash)'}
     ORDER BY d.bytes ASC`,
  )
  .all(...EXTRACTABLE) as Array<{
  id: number;
  path: string;
  extension: string;
  hash: string;
  bytes: number;
}>;

const list = values.limit ? pending.slice(0, Number(values.limit)) : pending;

console.log(`${list.length} documents to process`);
if (list.length === 0) {
  db.close();
  process.exit(0);
}

const t0 = Date.now();
let done = 0;
let noLayer = 0;
let failures = 0;
let characters = 0;

for (const [i, d] of list.entries()) {
  const pct = Math.floor(((i + 1) / list.length) * 100);
  process.stdout.write(`\r  ${pct}%  ${i + 1}/${list.length}  ${d.extension.padEnd(5)}`);

  try {
    const r = await extractText(join(root, d.path), d.extension);
    if (!r) continue;

    inTransaction(db, () => {
      db.prepare('DELETE FROM document_text WHERE document_id = ?').run(d.id);
      db.prepare(
        `INSERT INTO document_text (document_id, text, characters, pages, no_text_layer, hash)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(d.id, r.text, r.text.length, r.pages, r.noTextLayer ? 1 : 0, d.hash);

      db.prepare('DELETE FROM document_search WHERE document_id = ?').run(d.id);
      if (!r.noTextLayer) {
        db.prepare('INSERT INTO document_search (text, document_id) VALUES (?, ?)').run(
          r.text,
          d.id,
        );
      }
    });

    done++;
    characters += r.text.length;
    if (r.noTextLayer) noLayer++;
  } catch {
    failures++;
  }
}

const seconds = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n\nFinished in ${seconds} s`);
console.log(`  processed          : ${done}`);
console.log(`  without text layer : ${noLayer}  (scans: these would need OCR)`);
console.log(`  failures           : ${failures}`);
console.log(`  text indexed       : ${(characters / 1_000_000).toFixed(1)} million characters`);

db.close();
