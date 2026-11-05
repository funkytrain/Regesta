/**
 * Indexer: walks the user's folders and records what it finds.
 *
 * The rule that governs this module: **it only reads**. It does not move,
 * rename or delete anything, and it writes nothing inside the indexed folder.
 * Thumbnails are generated in the application's data directory, never beside
 * the original.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, stat, mkdir } from 'node:fs/promises';
import { join, relative, extname, basename, sep } from 'node:path';
import sharp from 'sharp';
import type { DB } from '../server/db.js';
import { inTransaction } from '../server/db.js';
import {
  parseName,
  isIgnorable,
  isSkippedFolder,
  inSkippedFolder,
  SKIPPED_FOLDER_NAMES,
  matchKey,
  looksLikeCertificate,
} from './filename-parser.js';

export interface IndexOptions {
  /** Folder to walk. Treated as read-only. */
  root: string;
  /** Where to store generated thumbnails. Always outside `root`. */
  thumbnailDir: string;
  /** Generate thumbnails (slow the first time). */
  thumbnails?: boolean;
  /** Called with progress, so the user can be kept informed. */
  onProgress?: (seen: number, total: number, file: string) => void;
}

export interface IndexSummary {
  added: number;
  updated: number;
  moved: number;
  missing: number;
  errors: number;
  duplicates: number;
  total: number;
  ms: number;
}

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.tif', '.tiff', '.webp', '.gif', '.bmp']);
const DOC_EXT = new Set(['.pdf', '.txt', '.doc', '.docx', '.odt', '.rtf', '.md']);

const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.rtf': 'application/rtf',
};

function isIndexable(ext: string): boolean {
  return IMAGE_EXT.has(ext) || DOC_EXT.has(ext);
}

/**
 * Content fingerprint. Read in chunks so that a 200 MB TIFF does not sit in
 * memory. SHA-256 truncated to 32 characters: enough to tell files apart
 * without storing needlessly long hashes.
 */
async function computeHash(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => h.update(chunk));
    stream.on('end', () => resolve(h.digest('hex').slice(0, 32)));
    stream.on('error', reject);
  });
}

/** Walks recursively and returns the indexable files. */
async function listFiles(root: string): Promise<string[]> {
  const found: string[] = [];

  async function descend(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable folder: skipped rather than aborting the pass
    }

    for (const e of entries) {
      if (isSkippedFolder(e.name)) continue;
      const path = join(dir, e.name);
      if (e.isDirectory()) {
        await descend(path);
      } else if (e.isFile()) {
        if (isIgnorable(e.name)) continue;
        if (isIndexable(extname(e.name).toLowerCase())) found.push(path);
      }
    }
  }

  await descend(root);
  return found;
}

/**
 * Generates the thumbnail of an image. Returns the relative path, or null if
 * the format is not an image or reading fails: a missing thumbnail must never
 * stop a document from being indexed.
 */
async function makeThumbnail(
  source: string,
  hash: string,
  thumbnailDir: string,
): Promise<{ path: string; width: number; height: number } | null> {
  const ext = extname(source).toLowerCase();
  if (!IMAGE_EXT.has(ext)) return null;

  // They are spread across subfolders by the first two characters of the
  // hash: with 20,000 thumbnails in a single directory, the NAS file system
  // becomes slow.
  const sub = hash.slice(0, 2);
  const targetDir = join(thumbnailDir, sub);
  const name = `${hash}.webp`;
  const target = join(targetDir, name);

  try {
    await mkdir(targetDir, { recursive: true });
    const meta = await sharp(source).metadata();
    await sharp(source)
      .rotate() // honours the EXIF orientation of archive photographs
      .resize(400, 400, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 80 })
      .toFile(target);

    return {
      path: `${sub}/${name}`,
      width: meta.width ?? 0,
      height: meta.height ?? 0,
    };
  } catch {
    return null;
  }
}

/**
 * Seeds the classification scheme from the folder structure. It does not
 * invent a canonical archival hierarchy: it mirrors the one the user already
 * has, so they can correct it instead of starting from an empty screen.
 */
function ensureUnitForFolder(db: DB, relativePath: string): number | null {
  const parts = relativePath.split(sep).filter(Boolean);
  parts.pop(); // drop the file name
  if (parts.length === 0) return null;

  let parentId: number | null = null;
  for (let i = 0; i < parts.length; i++) {
    const title = parts[i]!;
    const level = i === 0 ? 'fonds' : i === 1 ? 'section' : 'series';

    const existing = db
      .prepare(
        parentId === null
          ? 'SELECT id FROM unit WHERE title = ? AND parent_id IS NULL'
          : 'SELECT id FROM unit WHERE title = ? AND parent_id = ?',
      )
      .get(...(parentId === null ? [title] : [title, parentId])) as { id: number } | undefined;

    if (existing) {
      parentId = existing.id;
    } else {
      const r: { lastInsertRowid: number | bigint } = db
        .prepare('INSERT INTO unit (parent_id, level, title, position) VALUES (?, ?, ?, ?)')
        .run(parentId, level, title, i);
      parentId = Number(r.lastInsertRowid);
    }
  }

  return parentId;
}

/** Stores in the search index what has been deduced about a document. */
function indexForSearch(db: DB, docId: number, name: string, extra: string): void {
  db.prepare('DELETE FROM search WHERE kind = ? AND ref_id = ?').run('document', docId);
  db.prepare('INSERT INTO search (title, text, kind, ref_id) VALUES (?, ?, ?, ?)').run(
    name,
    extra,
    'document',
    docId,
  );
}

/**
 * Walks the root and brings the database up to date.
 *
 * A file that is no longer on disk is not deleted: it is flagged
 * `present = 0`. A disconnected drive or a dropped network share must not
 * destroy years of description.
 */
export async function index(db: DB, op: IndexOptions): Promise<IndexSummary> {
  const t0 = Date.now();
  const summary: IndexSummary = {
    added: 0,
    updated: 0,
    moved: 0,
    missing: 0,
    errors: 0,
    duplicates: 0,
    total: 0,
    ms: 0,
  };

  const run = db
    .prepare('INSERT INTO index_run (root) VALUES (?)')
    .run(op.root);
  const runId = Number(run.lastInsertRowid);

  const files = await listFiles(op.root);
  summary.total = files.length;

  const seen = new Set<string>();

  for (let i = 0; i < files.length; i++) {
    const absolute = files[i]!;
    const rel = relative(op.root, absolute);
    op.onProgress?.(i + 1, files.length, rel);

    try {
      const info = await stat(absolute);
      const name = basename(absolute);
      const ext = extname(name).toLowerCase();

      const existing = db
        .prepare('SELECT id, hash, bytes, mtime, present FROM document WHERE path = ?')
        .get(rel) as
        | { id: number; hash: string; bytes: number; mtime: string; present: number }
        | undefined;

      const mtime = info.mtime.toISOString();

      // If size and timestamp match, the content has not changed: this avoids
      // re-reading the whole file, which is the expensive part of a pass. Nothing
      // is written either: one UPDATE per file, each in its own transaction and
      // with its own fsync, multiplied the writes of a sweep that found no
      // changes by thousands.
      if (existing && existing.bytes === info.size && existing.mtime === mtime) {
        if (!existing.present) {
          db.prepare('UPDATE document SET present = 1 WHERE id = ?').run(existing.id);
        }
        seen.add(rel);
        continue;
      }

      const hash = await computeHash(absolute);
      seen.add(rel);

      // Is this a file the user has moved? Same content, different path, and
      // the old path no longer exists.
      const byHash = db
        .prepare('SELECT id, path FROM document WHERE hash = ? AND path != ?')
        .all(hash, rel) as Array<{ id: number; path: string }>;

      let thumbnail: string | null = null;
      let width: number | null = null;
      let height: number | null = null;

      if (op.thumbnails !== false) {
        const m = await makeThumbnail(absolute, hash, op.thumbnailDir);
        if (m) {
          thumbnail = m.path;
          width = m.width;
          height = m.height;
        }
      }

      inTransaction(db, () => {
        const unitId = ensureUnitForFolder(db, rel);

        if (existing) {
          db.prepare(
            `UPDATE document
             SET hash = ?, bytes = ?, mtime = ?, mime = ?, thumbnail = COALESCE(?, thumbnail),
                 width = COALESCE(?, width), height = COALESCE(?, height),
                 present = 1, seen_at = datetime('now')
             WHERE id = ?`,
          ).run(hash, info.size, mtime, MIME[ext] ?? null, thumbnail, width, height, existing.id);
          summary.updated++;
          indexForSearch(db, existing.id, name, rel);
          return;
        }

        const r = db
          .prepare(
            `INSERT INTO document
               (path, name, extension, mime, bytes, hash, width, height, thumbnail, mtime, unit_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(rel, name, ext, MIME[ext] ?? null, info.size, hash, width, height, thumbnail, mtime, unitId);
        const docId = Number(r.lastInsertRowid);

        if (byHash.length > 0) summary.duplicates++;

        // Reading of the name: the suggested record the user will validate.
        // It is only attempted on what looks like a certificate; a screenshot
        // or a journal offprint would produce an invented record.
        let key = '';
        if (looksLikeCertificate(name)) {
          const parsed = parseName(name);
          db.prepare(
            `INSERT INTO suggestion
               (document_id, record_type, name, name_2, year, page, confidence, warnings)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            docId,
            parsed.recordType,
            parsed.name,
            parsed.secondName,
            parsed.year,
            parsed.page,
            parsed.confidence,
            JSON.stringify(parsed.warnings),
          );

          // Both spouses are indexed: searching for the wife must find her
          // marriage.
          key = [parsed.name, parsed.secondName]
            .filter((n): n is string => Boolean(n))
            .map(matchKey)
            .join(' ');
        }

        // Searchable text: the file name, its path and the match keys, so
        // that 'Isabel' also finds the 'Ysabel' spellings. Every document is
        // searchable, whether it has a record or not.
        indexForSearch(db, docId, name, `${rel} ${key}`);

        summary.added++;
      });
    } catch {
      summary.errors++;
    }
  }

  // Whatever was registered and no longer appears on disk is flagged missing.
  inTransaction(db, () => {
    const registered = db.prepare('SELECT id, path FROM document WHERE present = 1').all() as Array<{
      id: number;
      path: string;
    }>;
    for (const d of registered) {
      if (!seen.has(d.path)) {
        db.prepare('UPDATE document SET present = 0 WHERE id = ?').run(d.id);
        summary.missing++;
      }
    }
  });

  summary.ms = Date.now() - t0;

  db.prepare(
    `UPDATE index_run
     SET finished_at = datetime('now'), added = ?, updated = ?,
         moved = ?, missing = ?, errors = ?, detail = ?
     WHERE id = ?`,
  ).run(
    summary.added,
    summary.updated,
    summary.moved,
    summary.missing,
    summary.errors,
    JSON.stringify(summary),
    runId,
  );

  return summary;
}

/**
 * Indexes a single file, without walking the whole tree.
 *
 * The watcher uses it when something appears or changes in the folders:
 * going over thousands of files every time one is copied would be absurd.
 *
 * Returns the document identifier, or null if the file is not indexable or is
 * already gone.
 */
export async function indexOne(
  db: DB,
  root: string,
  absolutePath: string,
  thumbnailDir: string,
): Promise<number | null> {
  const name = basename(absolutePath);
  const ext = extname(name).toLowerCase();
  if (isIgnorable(name) || !isIndexable(ext)) return null;
  // The sweep never goes into these folders, but a stray watcher event could
  // reach this far: that is how thousands of #snapshot copies got in.
  if (inSkippedFolder(relative(root, absolutePath))) return null;

  let info;
  try {
    info = await stat(absolutePath);
  } catch {
    return null; // it vanished between the notification and the read
  }
  if (!info.isFile()) return null;

  const rel = relative(root, absolutePath);
  const mtime = info.mtime.toISOString();

  const existing = db
    .prepare('SELECT id, hash, bytes, mtime, present FROM document WHERE path = ?')
    .get(rel) as
    | { id: number; hash: string; bytes: number; mtime: string; present: number }
    | undefined;

  if (existing && existing.bytes === info.size && existing.mtime === mtime) {
    if (!existing.present) {
      db.prepare('UPDATE document SET present = 1 WHERE id = ?').run(existing.id);
    }
    return existing.id;
  }

  const hash = await computeHash(absolutePath);

  let thumbnail: string | null = null;
  let width: number | null = null;
  let height: number | null = null;
  const m = await makeThumbnail(absolutePath, hash, thumbnailDir);
  if (m) {
    thumbnail = m.path;
    width = m.width;
    height = m.height;
  }

  return inTransaction(db, () => {
    const unitId = ensureUnitForFolder(db, rel);

    if (existing) {
      db.prepare(
        `UPDATE document
         SET hash = ?, bytes = ?, mtime = ?, mime = ?, thumbnail = COALESCE(?, thumbnail),
             width = COALESCE(?, width), height = COALESCE(?, height),
             present = 1, seen_at = datetime('now')
         WHERE id = ?`,
      ).run(hash, info.size, mtime, MIME[ext] ?? null, thumbnail, width, height, existing.id);
      indexForSearch(db, existing.id, name, rel);
      return existing.id;
    }

    const r = db
      .prepare(
        `INSERT INTO document
           (path, name, extension, mime, bytes, hash, width, height, thumbnail, mtime, unit_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(rel, name, ext, MIME[ext] ?? null, info.size, hash, width, height, thumbnail, mtime, unitId);
    const docId = Number(r.lastInsertRowid);

    let key = '';
    if (looksLikeCertificate(name)) {
      const parsed = parseName(name);
      db.prepare(
        `INSERT INTO suggestion
           (document_id, record_type, name, name_2, year, page, confidence, warnings)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        docId,
        parsed.recordType,
        parsed.name,
        parsed.secondName,
        parsed.year,
        parsed.page,
        parsed.confidence,
        JSON.stringify(parsed.warnings),
      );
      key = [parsed.name, parsed.secondName]
        .filter((n): n is string => Boolean(n))
        .map(matchKey)
        .join(' ');
    }

    indexForSearch(db, docId, name, `${rel} ${key}`);
    return docId;
  });
}

/**
 * Removes documents that should never have got in: those inside skipped
 * folders, above all the copies in Synology snapshots.
 *
 * Every snapshot has new paths, so each one added thousands of duplicate
 * documents and suggestions to review that never went away.
 *
 * Only what carries no work of the user's is deleted. If someone described,
 * tagged or reviewed one of those copies, it is kept (as missing) and counted,
 * so nothing is lost silently.
 */
export function purgeSkippedFolders(db: DB): {
  deleted: number;
  kept: number;
  units: number;
} {
  const rows = db.prepare('SELECT id, path FROM document').all() as Array<{
    id: number;
    path: string;
  }>;
  const candidates = rows.filter((r) => inSkippedFolder(r.path)).map((r) => r.id);
  const result = { deleted: 0, kept: 0, units: 0 };
  if (candidates.length === 0) return result;

  const hasWork = db.prepare(
    `SELECT
       EXISTS (SELECT 1 FROM description WHERE document_id = :id)
       OR EXISTS (SELECT 1 FROM entry WHERE document_id = :id)
       OR EXISTS (SELECT 1 FROM document_tag WHERE document_id = :id)
       OR EXISTS (SELECT 1 FROM suggestion WHERE document_id = :id AND status <> 'pending')
       OR EXISTS (SELECT 1 FROM document WHERE id = :id AND provenance_id IS NOT NULL)
       AS work`,
  );

  inTransaction(db, () => {
    db.exec('CREATE TEMP TABLE IF NOT EXISTS purge (id INTEGER PRIMARY KEY)');
    db.exec('DELETE FROM purge');
    const mark = db.prepare('INSERT INTO purge (id) VALUES (?)');
    const keep = db.prepare('UPDATE document SET present = 0 WHERE id = ?');
    for (const id of candidates) {
      if ((hasWork.get({ id }) as { work: number }).work) {
        keep.run(id);
        result.kept++;
      } else {
        mark.run(id);
        result.deleted++;
      }
    }

    // In bulk: the search tables are FTS, with no index on the id, and
    // deleting row by row would scan them whole every time. They have no
    // foreign key either, so nothing cascades into them.
    db.exec(`DELETE FROM search WHERE kind = 'document' AND ref_id IN (SELECT id FROM purge)`);
    db.exec('DELETE FROM document_search WHERE document_id IN (SELECT id FROM purge)');
    // Suggestions and extracted text do cascade.
    db.exec('DELETE FROM document WHERE id IN (SELECT id FROM purge)');
    db.exec('DELETE FROM purge');

    // The snapshot folders also created units in the arrangement. They are
    // removed from the leaves upwards, and only once empty.
    const deleteEmptyLeaves = db.prepare(
      `WITH RECURSIVE branch(id) AS (
         SELECT id FROM unit WHERE title IN (${SKIPPED_FOLDER_NAMES.map(() => '?').join(', ')})
         UNION SELECT u.id FROM unit u JOIN branch b ON u.parent_id = b.id
       )
       DELETE FROM unit
       WHERE id IN branch
         AND NOT EXISTS (SELECT 1 FROM unit c WHERE c.parent_id = unit.id)
         AND NOT EXISTS (SELECT 1 FROM document d WHERE d.unit_id = unit.id)`,
    );
    for (;;) {
      const n = Number(deleteEmptyLeaves.run(...SKIPPED_FOLDER_NAMES).changes);
      if (n === 0) break;
      result.units += n;
    }
  });

  return result;
}

/** Flags a document as missing because its file is no longer on disk. */
export function markMissing(db: DB, root: string, absolutePath: string): void {
  const rel = relative(root, absolutePath);
  // Nothing is deleted: a disconnected drive must not destroy years of
  // description.
  db.prepare('UPDATE document SET present = 0 WHERE path = ?').run(rel);
}

/** Groups of files with identical content. */
export function findDuplicates(db: DB): Array<{ hash: string; paths: string[] }> {
  const rows = db
    .prepare(
      `SELECT hash, GROUP_CONCAT(path, '|') AS paths
       FROM document WHERE present = 1
       GROUP BY hash HAVING COUNT(*) > 1
       ORDER BY COUNT(*) DESC`,
    )
    .all() as Array<{ hash: string; paths: string }>;

  return rows.map((r) => ({ hash: r.hash, paths: r.paths.split('|') }));
}
