import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { index, indexOne, purgeSkippedFolders } from '../src/indexer/indexer.ts';
import { inSkippedFolder } from '../src/indexer/filename-parser.ts';

/**
 * Synology snapshots are whole copies of the archive inside #snapshot. Folder
 * watching used to index them: each snapshot added thousands of duplicates and
 * suggestions to review that never went away.
 */

const SNAPSHOT = join('#snapshot', 'GMT+02-2026.09.25-05.05.10', 'VARIOS');
const FILE = 'MATRIMONIO JUAN PORTUGUES Y NICOLAUA GARCIA 1614.txt';

let root: string;
let thumbnails: string;
let db: DatabaseSync;

before(() => {
  root = mkdtempSync(join(tmpdir(), 'regesta-snap-'));
  thumbnails = mkdtempSync(join(tmpdir(), 'regesta-snap-thumbs-'));
  mkdirSync(join(root, 'VARIOS'), { recursive: true });
  mkdirSync(join(root, SNAPSHOT), { recursive: true });
  const content = 'Transcription of the marriage, 1614.';
  writeFileSync(join(root, 'VARIOS', FILE), content);
  writeFileSync(join(root, SNAPSHOT, FILE), content);

  db = new DatabaseSync(':memory:');
  db.exec(readFileSync(join(process.cwd(), 'src/server/schema.sql'), 'utf8'));
});

after(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(thumbnails, { recursive: true, force: true });
});

/** Forces a snapshot copy in, the way folder watching used to. */
function sneakCopy(name: string): number {
  const path = join(SNAPSHOT, name);
  const id = Number(
    db
      .prepare(
        `INSERT INTO document (path, name, extension, bytes, hash, present)
         VALUES (?, ?, '.txt', 1, 'same-hash', 1)`,
      )
      .run(path, name).lastInsertRowid,
  );
  db.prepare(
    `INSERT INTO suggestion (document_id, record_type, year, confidence) VALUES (?, 'marriage', 1614, 0.5)`,
  ).run(id);
  db.prepare(`INSERT INTO search (title, text, kind, ref_id) VALUES (?, '', 'document', ?)`).run(name, id);
  return id;
}

describe('Synology snapshots', () => {
  test('a path inside #snapshot is recognised at any depth', () => {
    assert.ok(inSkippedFolder(join(SNAPSHOT, FILE)));
    assert.ok(inSkippedFolder('@eaDir\\x.jpg'));
    assert.ok(!inSkippedFolder(join('VARIOS', FILE)));
    assert.ok(!inSkippedFolder(''));
  });

  test('the sweep does not index the snapshot', async () => {
    await index(db, { root, thumbnailDir: thumbnails });
    const paths = (db.prepare('SELECT path FROM document').all() as Array<{ path: string }>).map(
      (r) => r.path,
    );
    assert.deepEqual(paths, [join('VARIOS', FILE)]);
  });

  test('a stray watcher event does not index it either', async () => {
    assert.equal(await indexOne(db, root, join(root, SNAPSHOT, FILE), thumbnails), null);
  });

  test('the purge removes copies already in, with their suggestions and folders', () => {
    const copy = sneakCopy('UNTOUCHED COPY 1614.txt');
    // Folder watching also created their folders in the arrangement.
    let parent: number | null = null;
    for (const title of SNAPSHOT.split(/[\\/]/)) {
      parent = Number(
        db
          .prepare(`INSERT INTO unit (parent_id, level, title) VALUES (?, 'series', ?)`)
          .run(parent, title).lastInsertRowid,
      );
    }
    db.prepare('UPDATE document SET unit_id = ? WHERE id = ?').run(parent, copy);

    const p = purgeSkippedFolders(db);

    assert.equal(p.deleted, 1);
    assert.equal(p.kept, 0);
    // #snapshot, the dated folder and VARIOS inside it.
    assert.equal(p.units, 3);
    assert.equal(db.prepare('SELECT 1 FROM document WHERE id = ?').get(copy), undefined);
    assert.equal(db.prepare('SELECT 1 FROM suggestion WHERE document_id = ?').get(copy), undefined);
    assert.equal(
      db.prepare(`SELECT 1 FROM search WHERE kind = 'document' AND ref_id = ?`).get(copy),
      undefined,
    );
    // The original and its folder are still there.
    assert.ok(db.prepare('SELECT 1 FROM document WHERE path = ?').get(join('VARIOS', FILE)));
    assert.ok(db.prepare(`SELECT 1 FROM unit WHERE title = 'VARIOS' AND parent_id IS NULL`).get());
  });

  test('a copy carrying the user’s work is kept, flagged as missing', () => {
    const copy = sneakCopy('DESCRIBED COPY 1614.txt');
    db.prepare(`INSERT INTO description (document_id, notes) VALUES (?, 'described by hand')`).run(copy);

    const p = purgeSkippedFolders(db);

    assert.equal(p.deleted, 0);
    assert.equal(p.kept, 1);
    const row = db.prepare('SELECT present FROM document WHERE id = ?').get(copy) as { present: number };
    assert.equal(row.present, 0);
  });
});
