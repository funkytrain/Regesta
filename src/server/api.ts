/**
 * Query API.
 *
 * Serves records, searches, thumbnails and the documents themselves to the
 * browser. Everything that touches the user's disk does so read-only.
 */

import { createReadStream } from 'node:fs';
import { stat, readFile, mkdir, readdir, writeFile } from 'node:fs/promises';
import { join, resolve, normalize, sep, dirname } from 'node:path';
import {
  documentsCsv,
  entriesCsv,
  tagsCsv,
  provenancesCsv,
  classificationCsv,
  linksCsv,
  placesCsv,
  documentText,
  describedIds,
  safeFileName,
} from './export.js';
import sharp from 'sharp';
import type { FastifyInstance } from 'fastify';
import type { DB } from './db.js';
import { readSetting, writeSetting, inTransaction } from './db.js';
import { matchKey, roles } from '../indexer/filename-parser.js';
import { MatchIndex, suggestedRole } from './matching.js';
import type { Candidate } from './matching.js';

export interface ApiContext {
  db: DB;
  thumbnailDir: string;
  watcher?: {
    state: {
      active: boolean;
      pending: number;
      processed: number;
      lastChange: string | null;
      lastSweep: string | null;
      sweeping: boolean;
    };
    sweep: () => Promise<void>;
    changeRoot?: (next: string) => Promise<void>;
  } | null;
  /** Reader for the Gramps tree. Read-only, and over a copy. */
  gramps?: import('./gramps.js').GrampsReader | null;
}

/**
 * Checks that a path requested by the browser falls inside the permitted
 * folder. Without this, a request containing '..' could read any file on the
 * server: the application is for personal use, but it is exposed on the local
 * network.
 */
function insideOf(base: string, candidate: string): string | null {
  const rootAbs = resolve(base);
  const target = resolve(rootAbs, normalize(candidate));
  if (target !== rootAbs && !target.startsWith(rootAbs + sep)) return null;
  return target;
}

export function registerApi(app: FastifyInstance, ctx: ApiContext): void {
  const { db } = ctx;

  /** Summary for the home screen. */
  app.get('/api/summary', async () => {
    const docs = db.prepare('SELECT COUNT(*) AS n FROM document WHERE present = 1').get() as { n: number };
    const byType = db
      .prepare(
        `SELECT p.record_type AS type, COUNT(*) AS n
         FROM suggestion p JOIN document d ON d.id = p.document_id
         WHERE d.present = 1 GROUP BY p.record_type ORDER BY n DESC`,
      )
      .all();
    const review = db
      .prepare(
        // Present documents only, like the review queue itself: without this,
        // suggestions for files that are gone kept adding up for ever.
        `SELECT COUNT(*) AS n FROM suggestion p JOIN document d ON d.id = p.document_id
         WHERE p.status = 'pending' AND p.confidence < 0.9 AND d.present = 1`,
      )
      .get() as { n: number };
    // Plausible years only: some names carry bundle reference codes or
    // download identifiers that look like dates.
    const range = db
      .prepare(
        `SELECT MIN(p.year) AS first_year, MAX(p.year) AS last_year
         FROM suggestion p JOIN document d ON d.id = p.document_id
         WHERE p.year BETWEEN 1400 AND 2026 AND d.present = 1`,
      )
      .get();
    const duplicates = db
      .prepare(
        `SELECT COUNT(*) AS n FROM (
           SELECT hash FROM document WHERE present = 1 GROUP BY hash HAVING COUNT(*) > 1
         )`,
      )
      .get() as { n: number };

    // Breakdown by format family, for the interface filter.
    const byFormat = db
      .prepare(
        `SELECT CASE
                  WHEN extension IN ('.jpg','.jpeg','.png','.gif','.bmp','.tif','.tiff','.webp') THEN 'image'
                  WHEN extension = '.pdf' THEN 'pdf'
                  WHEN extension IN ('.txt','.md') THEN 'text'
                  WHEN extension IN ('.doc','.docx','.odt','.rtf') THEN 'document'
                  ELSE 'otro'
                END AS format,
                COUNT(*) AS n
         FROM document WHERE present = 1
         GROUP BY format ORDER BY n DESC`,
      )
      .all();
    const ultima = db
      .prepare('SELECT * FROM index_run ORDER BY id DESC LIMIT 1')
      .get();

    return {
      documents: docs.n,
      byType,
      byFormat,
      toReview: review.n,
      range,
      duplicates: duplicates.n,
      ultimaPasada: ultima,
    };
  });

  /**
   * The indexed folder and what the mount contains.
   *
   * The container only sees what has been mounted into it, so the available
   * folders are listed: that is how the user can tell what they may choose
   * without having to guess paths.
   */
  app.get('/api/folder', async () => {
    const root = readSetting(db, 'document_root');
    const docs = (
      db.prepare('SELECT COUNT(*) AS n FROM document WHERE present = 1').get() as { n: number }
    ).n;

    // Candidates: whatever hangs off the usual mount points.
    const candidates: Array<{ path: string; entries: number }> = [];
    for (const base of ['/documents', '/data/documents', process.cwd()]) {
      try {
        const hijas = await readdir(base, { withFileTypes: true });
        const folders = hijas.filter((h) => h.isDirectory() && !h.name.startsWith('.'));
        candidates.push({ path: base, entries: folders.length });
        for (const c of folders.slice(0, 40)) {
          candidates.push({ path: join(base, c.name), entries: -1 });
        }
        break; // the first one that exists is enough
      } catch {
        /* that mount point does not exist */
      }
    }

    return { root, documents: docs, candidates };
  });

  /**
   * Changes the indexed folder.
   *
   * Documents from the previous folder are flagged missing rather than
   * deleted: if the user switches back, the description is still there.
   */
  app.post<{ Body: { path?: string; forget?: boolean } }>(
    '/api/folder',
    async (request, reply) => {
      const path = (request.body?.path ?? '').trim();
      if (!path) return reply.code(400).send({ error: 'Missing path' });

      try {
        const info = await stat(path);
        if (!info.isDirectory()) {
          return reply.code(400).send({ error: 'That path is not a folder' });
        }
      } catch {
        return reply.code(404).send({
          error:
            'The container cannot see that folder. Check docker-compose.yml: only what is mounted exists.',
        });
      }

      const anterior = readSetting(db, 'document_root');
      if (anterior === path) return { ok: true, sinCambios: true };

      inTransaction(db, () => {
        // What was in the previous folder stops being present, but its
        // record is kept: changing folder must not destroy years of
        // description.
        db.prepare('UPDATE document SET present = 0').run();
        writeSetting(db, 'document_root', path);
      });

      if (request.body?.forget) {
        // Only on explicit request: deletes the missing documents and
        // everything that hung off them.
        db.prepare('DELETE FROM document WHERE present = 0').run();
      }

      // Watching follows the new folder and sweeps it. The sweep is not
      // awaited: over thousands of files it takes minutes, and the interface
      // queries the state in the meantime.
      void ctx.watcher?.changeRoot?.(path);

      return { ok: true, path, anterior, indexando: true };
    },
  );

  /** State of the folder watching. */
  app.get('/api/watch', async () => {
    if (!ctx.watcher) return { active: false, available: false };
    return { ...ctx.watcher.state, available: true };
  });

  /** Launches a full sweep at the user's request. */
  app.post('/api/watch/sweep', async (_request, reply) => {
    if (!ctx.watcher) {
      return reply.code(503).send({ error: 'Watching is not active' });
    }
    if (ctx.watcher.state.sweeping) return { alreadyRunning: true };

    // It is not awaited: a sweep over thousands of files takes a while, and
    // the interface queries the state in the meantime.
    void ctx.watcher.sweep();
    return { started: true };
  });

  /** Search with filters. */
  app.get<{
    Querystring: {
      q?: string;
      type?: string;
      from?: string;
      to?: string;
      unit?: string;
      format?: string;
      tag?: string;
      century?: string;
      review?: string;
      page?: string;
      perPage?: string;
      sort?: string;
    };
  }>('/api/search', async (request) => {
    const { q, type, from, to, unit, format, tag, century, review, sort } =
      request.query;
    const page = Math.max(1, Number.parseInt(request.query.page ?? '1', 10) || 1);
    // The high cap allows the 'all' option in the selector. The query is
    // instant at any size; what costs is the browser painting those
    // thumbnails, and lazy image loading absorbs that.
    const perPage = Math.min(
      50000,
      Math.max(1, Number.parseInt(request.query.perPage ?? '60', 10) || 60),
    );

    const condiciones: string[] = ['d.present = 1'];
    const values: Array<string | number> = [];

    if (q?.trim()) {
      // The search covers both the term and its match key, so that typing
      // 'Isabel' finds the documents that say 'Ysabel'.
      const term = q.trim();
      const key = matchKey(term);
      const query = [term, key]
        .filter((t, i, a) => t && a.indexOf(t) === i)
        .map((t) => `"${t.replace(/"/g, '')}"*`)
        .join(' OR ');

      // Two places are searched: the file name and the text inside the
      // document. A surname may appear only in the body of a notarial
      // record, never in the name.
      //
      // A quoted phrase is searched literally and only in the contents,
      // which is what one expects from using quotes.
      const isPhrase = /^".+"$/.test(term);
      if (isPhrase) {
        const literal = term.slice(1, -1).replace(/"/g, '');
        condiciones.push(
          `d.id IN (SELECT document_id FROM document_search WHERE document_search MATCH ?)`,
        );
        values.push(`"${literal}"`);
      } else {
        condiciones.push(
          `(d.id IN (SELECT ref_id FROM search WHERE kind = 'document' AND search MATCH ?)
            OR d.id IN (SELECT document_id FROM document_search WHERE document_search MATCH ?))`,
        );
        values.push(query, query);
      }
    }
    if (type) {
      condiciones.push('p.record_type = ?');
      values.push(type);
    }
    if (from) {
      condiciones.push('p.year >= ?');
      values.push(Number.parseInt(from, 10));
    }
    if (to) {
      condiciones.push('p.year <= ?');
      values.push(Number.parseInt(to, 10));
    }
    if (unit) {
      // What hangs off the subfolders is included: clicking a branch of the
      // tree is expected to show everything below it, not just that level.
      condiciones.push(`d.unit_id IN (
        WITH RECURSIVE rama(id) AS (
          SELECT ? UNION ALL
          SELECT u.id FROM unit u JOIN rama r ON u.parent_id = r.id
        ) SELECT id FROM rama)`);
      values.push(Number.parseInt(unit, 10));
    }
    if (tag) {
      condiciones.push(
        'd.id IN (SELECT document_id FROM document_tag WHERE tag_id = ?)',
      );
      values.push(Number.parseInt(tag, 10));
    }
    if (century) {
      const start = Number.parseInt(century, 10);
      condiciones.push('p.year >= ? AND p.year < ?');
      values.push(start, start + 100);
    }
    if (review === '1') {
      condiciones.push("p.status = 'pending' AND p.confidence < 0.9");
    }
    if (format) {
      // Filtering is by format family, not by individual extension: someone
      // looking for images wants them all, be they .jpg, .jpeg or .png.
      const familias: Record<string, string[]> = {
        image: ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.tif', '.tiff', '.webp'],
        pdf: ['.pdf'],
        text: ['.txt', '.md'],
        document: ['.doc', '.docx', '.odt', '.rtf'],
      };
      const exts = familias[format];
      if (exts) {
        condiciones.push(`d.extension IN (${exts.map(() => '?').join(',')})`);
        values.push(...exts);
      }
    }

    const donde = condiciones.join(' AND ');

    const total = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM document d
           LEFT JOIN suggestion p ON p.document_id = d.id
           WHERE ${donde}`,
        )
        .get(...values) as { n: number }
    ).n;

    // 'best' puts well-read records with an image first: that is what the
    // home screen shows, where ordering by year would surface the handful of
    // documents whose year was misread.
    const ordenSql =
      sort === 'best'
        ? `p.confidence DESC, d.thumbnail IS NULL, p.year DESC`
        : `p.year IS NULL, p.year, d.name`;

    // If something was searched for, the snippet of the document where it
    // appears is fetched too: without seeing it, a content hit does not say
    // why it is there.
    const fragmentos = new Map<number, string>();
    if (q?.trim()) {
      const term = q.trim();
      const isPhrase = /^".+"$/.test(term);
      const ftsQuery = isPhrase
        ? `"${term.slice(1, -1).replace(/"/g, '')}"`
        : [term, matchKey(term)]
            .filter((t, i, a) => t && a.indexOf(t) === i)
            .map((t) => `"${t.replace(/"/g, '')}"*`)
            .join(' OR ');

      try {
        const found = db
          .prepare(
            `SELECT document_id, snippet(document_search, 0, '[', ']', '...', 18) AS snippet
             FROM document_search WHERE document_search MATCH ? LIMIT 400`,
          )
          .all(ftsQuery) as Array<{ document_id: number; snippet: string }>;
        for (const f of found) fragmentos.set(f.document_id, f.snippet);
      } catch {
        // A query FTS5 cannot parse must not bring the search down.
      }
    }

    const rows = db
      .prepare(
        `SELECT d.id, d.path, d.name, d.mime, d.bytes, d.thumbnail, d.width, d.height,
                d.unit_id, d.extension,
                -- Lo descrito a mano manda sobre lo deducido del name.
                COALESCE(des.record_type, p.record_type) AS record_type,
                COALESCE(des.people, p.name) AS person,
                CASE WHEN des.people IS NULL THEN p.name_2 END AS person_2,
                COALESCE(CAST(substr(des.date, 1, 4) AS INTEGER), p.year) AS year,
                p.page, p.confidence, p.warnings,
                des.document_id IS NOT NULL AS described,
                p.status AS suggestion_status,
                u.title AS unit_title,
                -- Copies of the same content in other folders: flagged in
                -- the preview so the same document is not opened twice.
                -- Resolved with an up-front aggregation rather than a
                -- per-row subquery, which took seconds across thousands of
                -- results.
                COALESCE(h.n, 1) - 1 AS copies
         FROM document d
         LEFT JOIN suggestion p ON p.document_id = d.id
         LEFT JOIN description des ON des.document_id = d.id
         LEFT JOIN unit u ON u.id = d.unit_id
         LEFT JOIN (
           SELECT hash, COUNT(*) AS n FROM document
           WHERE present = 1 GROUP BY hash HAVING COUNT(*) > 1
         ) h ON h.hash = d.hash
         WHERE ${donde}
         ORDER BY ${ordenSql}
         LIMIT ? OFFSET ?`,
      )
      .all(...values, perPage, (page - 1) * perPage);

    // Tags of the returned documents, in a single query.
    const ids = (rows as Array<{ id: number }>).map((f) => f.id);
    const etiquetasPorDoc = new Map<number, Array<{ id: number; name: string; color: string | null }>>();
    if (ids.length > 0) {
      const marcas = db
        .prepare(
          `SELECT de.document_id, e.id, e.name, e.color
           FROM document_tag de JOIN tag e ON e.id = de.tag_id
           WHERE de.document_id IN (${ids.map(() => '?').join(',')})
           ORDER BY e.position, e.name`,
        )
        .all(...ids) as Array<{ document_id: number; id: number; name: string; color: string | null }>;

      for (const m of marcas) {
        if (!etiquetasPorDoc.has(m.document_id)) etiquetasPorDoc.set(m.document_id, []);
        etiquetasPorDoc.get(m.document_id)!.push({ id: m.id, name: m.name, color: m.color });
      }
    }

    // Each result gets the snippet where what was searched for appears.
    const results = (rows as Array<{ id: number }>).map((f) => ({
      ...f,
      snippet: fragmentos.get(f.id) ?? null,
      tags: etiquetasPorDoc.get(f.id) ?? [],
    }));

    return { total, page, perPage, results };
  });

  /** Full record of a document. */
  app.get<{ Params: { id: string } }>('/api/document/:id', async (request, reply) => {
    const id = Number.parseInt(request.params.id, 10);
    const doc = db
      .prepare(
        `SELECT d.*, p.record_type, p.name AS person, p.name_2 AS person_2,
                p.year, p.page, p.confidence, p.warnings, p.status AS suggestion_status
         FROM document d LEFT JOIN suggestion p ON p.document_id = d.id
         WHERE d.id = ?`,
      )
      .get(id);

    if (!doc) return reply.code(404).send({ error: 'No such document' });

    const unit = (doc as { unit_id: number | null }).unit_id;
    const path_to_root = unit ? unitPath(db, unit) : [];
    const twins = db
      .prepare('SELECT id, path FROM document WHERE hash = ? AND id != ? AND present = 1')
      .all((doc as { hash: string }).hash, id);

    const tags = db
      .prepare(
        `SELECT e.id, e.name, e.color FROM document_tag de
         JOIN tag e ON e.id = de.tag_id
         WHERE de.document_id = ? ORDER BY e.position, e.name`,
      )
      .all(id);

    const description = db
      .prepare(
        `SELECT d.*, pr.name AS provenance_name
         FROM description d
         LEFT JOIN provenance pr ON pr.id = d.provenance_id
         WHERE d.document_id = ?`,
      )
      .get(id);

    return { ...doc, path_to_root, duplicates: twins, tags, description: description ?? null };
  });

  /**
   * Folder tree for the side panel, with what hangs off each one.
   *
   * The count is cumulative: a folder also shows what is in its subfolders,
   * which is what one expects when looking at a tree.
   */
  app.get('/api/tree/folders', async () => {
    const nodes = db
      .prepare(
        `SELECT u.id, u.parent_id, u.level, u.title,
                (SELECT COUNT(*) FROM document d
                  WHERE d.unit_id = u.id AND d.present = 1) AS own
         FROM unit u ORDER BY u.position, u.title`,
      )
      .all() as Array<{ id: number; parent_id: number | null; title: string; own: number }>;

    // Cumulative count, from the leaves towards the root.
    const hijos = new Map<number | null, number[]>();
    for (const n of nodes) {
      const k = n.parent_id;
      if (!hijos.has(k)) hijos.set(k, []);
      hijos.get(k)!.push(n.id);
    }
    const porId = new Map(nodes.map((n) => [n.id, n]));
    const total = new Map<number, number>();

    const sumar = (id: number): number => {
      if (total.has(id)) return total.get(id)!;
      const n = porId.get(id)!;
      let t = n.own;
      for (const h of hijos.get(id) ?? []) t += sumar(h);
      total.set(id, t);
      return t;
    };
    for (const n of nodes) sumar(n.id);

    return nodes.map((n) => ({ ...n, documents: total.get(n.id) ?? 0 }));
  });

  /** Tree by record type and century, to walk the archive chronologically. */
  app.get('/api/tree/record-types', async () => {
    const rows = db
      .prepare(
        `SELECT p.record_type AS type,
                CASE WHEN p.year BETWEEN 1400 AND 2026
                     THEN (p.year / 100) * 100 END AS century,
                COUNT(*) AS n
         FROM suggestion p JOIN document d ON d.id = p.document_id
         WHERE d.present = 1 AND p.record_type IS NOT NULL
         GROUP BY type, century
         ORDER BY type, century`,
      )
      .all() as Array<{ type: string; century: number | null; n: number }>;

    const byType = new Map<string, { type: string; total: number; centuries: Array<{ century: number | null; n: number }> }>();
    for (const f of rows) {
      if (!byType.has(f.type)) byType.set(f.type, { type: f.type, total: 0, centuries: [] });
      const t = byType.get(f.type)!;
      t.total += f.n;
      t.centuries.push({ century: f.century, n: f.n });
    }
    return [...byType.values()].sort((a, b) => b.total - a.total);
  });

  /**
   * Saves the description of a document.
   *
   * Only the fields that arrive are touched, so the interface can save a
   * single field as it is typed without dragging the rest along.
   */
  app.put<{ Params: { id: string }; Body: Record<string, string | null> }>(
    '/api/description/:id',
    async (request, reply) => {
      const id = Number.parseInt(request.params.id, 10);
      const exists = db.prepare('SELECT 1 FROM document WHERE id = ?').get(id);
      if (!exists) return reply.code(404).send({ error: 'No such document' });

      const FIELDS = [
        'title', 'record_type', 'date', 'end_date', 'folio',
        'people', 'place', 'abstract', 'transcription', 'notes',
        'creator', 'medium', 'condition', 'reference_code',
      ] as const;

      const changes = Object.entries(request.body ?? {}).filter(([k]) =>
        (FIELDS as readonly string[]).includes(k),
      );
      if (changes.length === 0) return reply.code(400).send({ error: 'Nothing to save' });

      inTransaction(db, () => {
        db.prepare('INSERT OR IGNORE INTO description (document_id) VALUES (?)').run(id);

        const set = changes.map(([k]) => `${k} = ?`).join(', ');
        db.prepare(`UPDATE description SET ${set}, updated_at = datetime('now') WHERE document_id = ?`)
          .run(...changes.map(([, v]) => (v === '' ? null : v)), id);

        // Text described by hand enters the search: an abstract or a
        // transcription is exactly what one wants to be able to find.
        const d = db.prepare('SELECT * FROM description WHERE document_id = ?').get(id) as
          | Record<string, string | null>
          | undefined;
        const doc = db.prepare('SELECT name, path FROM document WHERE id = ?').get(id) as {
          name: string;
          path: string;
        };

        const texto = [
          d?.people, d?.place, d?.abstract, d?.transcription,
          d?.notes, d?.creator, d?.reference_code, d?.folio,
        ]
          .filter(Boolean)
          .join(' ');

        db.prepare("DELETE FROM search WHERE kind = 'document' AND ref_id = ?").run(id);
        db.prepare('INSERT INTO search (title, text, kind, ref_id) VALUES (?, ?, ?, ?)').run(
          d?.title || doc.name,
          `${doc.path} ${texto} ${texto ? matchKey(texto) : ''}`,
          'document',
          id,
        );

        // Describing by hand any of the fields the review decides on
        // settles that review: what the user writes overrides what was read
        // from the name. Without this the suggestion would stay pending
        // forever and the document would reappear in the queue after being
        // corrected.
        if (changes.some(([k]) => k === 'record_type' || k === 'people' || k === 'date')) {
          db.prepare(
            "UPDATE suggestion SET status = 'accepted', decided_at = strftime('%Y-%m-%d %H:%M:%f', 'now') WHERE document_id = ? AND status = 'pending'",
          ).run(id);
        }
      });

      return db.prepare('SELECT * FROM description WHERE document_id = ?').get(id);
    },
  );

  /**
   * Accepts the record read from the file name as a good description.
   *
   * This is the fast path of the review: most suggestions are correct and
   * only need confirming.
   */
  app.post<{ Body: { documents?: number[]; batch?: string } }>(
    '/api/review/accept',
    async (request, reply) => {
      const ids = request.body?.documents ?? [];
      if (!Array.isArray(ids) || ids.length === 0) {
        return reply.code(400).send({ error: 'Missing documents' });
      }
      const batch = typeof request.body?.batch === 'string' ? request.body.batch.slice(0, 40) : null;

      let hechos = 0;
      inTransaction(db, () => {
        for (const id of ids) {
          const p = db
            .prepare('SELECT record_type, name, name_2, year, page FROM suggestion WHERE document_id = ?')
            .get(id) as
            | { record_type: string | null; name: string | null; name_2: string | null; year: number | null; page: number | null }
            | undefined;
          if (!p) continue;

          const people = [p.name, p.name_2].filter(Boolean).join(' / ');
          const incoming = {
            record_type: p.record_type,
            people: people || null,
            date: p.year ? String(p.year) : null,
          };

          db.prepare('INSERT OR IGNORE INTO description (document_id) VALUES (?)').run(id);

          // Only what the acceptance really writes (the fields that were
          // empty) is recorded, so that undoing never erases anything the
          // user wrote.
          const before = db
            .prepare('SELECT record_type, people, date FROM description WHERE document_id = ?')
            .get(id) as { record_type: string | null; people: string | null; date: string | null };
          const copied: Record<string, string> = {};
          for (const [k, v] of Object.entries(incoming)) {
            if (v !== null && (before as Record<string, string | null>)[k] == null) copied[k] = v;
          }

          db.prepare(
            `UPDATE description
             SET record_type = COALESCE(record_type, ?),
                 people  = COALESCE(people, ?),
                 date     = COALESCE(date, ?),
                 updated_at = datetime('now')
             WHERE document_id = ?`,
          ).run(incoming.record_type, incoming.people, incoming.date, id);

          db.prepare(
            `UPDATE suggestion SET status = 'accepted', batch = ?, copied = ?,
                    decided_at = strftime('%Y-%m-%d %H:%M:%f', 'now')
             WHERE document_id = ?`,
          ).run(batch, JSON.stringify(copied), id);
          hechos++;
        }
      });

      return { accepted: hechos };
    },
  );

  /**
   * Undoes review decisions: the card goes back to the queue and whatever the
   * acceptance had copied is removed from the description (unless the user
   * changed it afterwards).
   */
  app.post<{ Body: { documents?: number[]; batch?: string } }>(
    '/api/review/undo',
    async (request, reply) => {
      const batch = request.body?.batch;
      let ids = request.body?.documents ?? [];
      if (typeof batch === 'string' && batch) {
        ids = (
          db.prepare('SELECT document_id AS id FROM suggestion WHERE batch = ?').all(batch) as {
            id: number;
          }[]
        ).map((f) => f.id);
      }
      if (!Array.isArray(ids) || ids.length === 0) {
        return reply.code(400).send({ error: 'Missing documents' });
      }

      let undone = 0;
      inTransaction(db, () => {
        for (const id of ids) {
          const p = db
            .prepare(
              'SELECT status, copied FROM suggestion WHERE document_id = ? AND decided_at IS NOT NULL',
            )
            .get(id) as { status: string; copied: string | null } | undefined;
          if (!p) continue;

          if (p.status === 'accepted' && p.copied) {
            const copied = JSON.parse(p.copied) as Record<string, string>;
            for (const field of ['record_type', 'people', 'date']) {
              if (copied[field] === undefined) continue;
              db.prepare(
                `UPDATE description SET ${field} = NULL, updated_at = datetime('now')
                 WHERE document_id = ? AND ${field} = ?`,
              ).run(id, copied[field]);
            }
          }

          db.prepare(
            "UPDATE suggestion SET status = 'pending', batch = NULL, copied = NULL, decided_at = NULL WHERE document_id = ?",
          ).run(id);
          undone++;
        }
      });

      return { undone };
    },
  );

  /** What was decided recently in the review, so it can be gone back over. */
  app.get('/api/review/recent', async () => {
    const individual = db
      .prepare(
        `SELECT d.id, d.name, d.thumbnail, p.status, p.decided_at,
                COALESCE(de.record_type, p.record_type) AS record_type,
                COALESCE(de.people, p.name) AS person,
                COALESCE(CAST(substr(de.date, 1, 4) AS INTEGER), p.year) AS year
         FROM suggestion p
         JOIN document d ON d.id = p.document_id
         LEFT JOIN description de ON de.document_id = d.id
         WHERE p.decided_at IS NOT NULL AND p.batch IS NULL
         ORDER BY p.decided_at DESC LIMIT 40`,
      )
      .all();

    const batches = db
      .prepare(
        `SELECT batch, COUNT(*) AS n, MAX(decided_at) AS decided_at
         FROM suggestion WHERE batch IS NOT NULL
         GROUP BY batch ORDER BY MAX(decided_at) DESC LIMIT 10`,
      )
      .all();

    return { individual, batches };
  });

  /** Dismisses a suggestion: the document is not a documentary record. */
  app.post<{ Body: { documents?: number[] } }>(
    '/api/review/dismiss',
    async (request, reply) => {
      const ids = request.body?.documents ?? [];
      if (!Array.isArray(ids) || ids.length === 0) {
        return reply.code(400).send({ error: 'Missing documents' });
      }

      inTransaction(db, () => {
        const stmt = db.prepare(
          `UPDATE suggestion SET status = 'rejected', batch = NULL, copied = NULL,
                  decided_at = strftime('%Y-%m-%d %H:%M:%f', 'now')
           WHERE document_id = ?`,
        );
        for (const id of ids) stmt.run(id);
      });

      return { dismissed: ids.length };
    },
  );

  /**
   * Next batch of documents to review, with everything needed to decide
   * without asking for anything else.
   */
  app.get<{ Querystring: { from?: string; limit?: string } }>(
    '/api/review/queue',
    async (request) => {
      const limit = Math.min(50, Math.max(1, Number.parseInt(request.query.limit ?? '20', 10)));
      const from = Number.parseInt(request.query.from ?? '0', 10);

      // A document already described by hand has been reviewed, even if it
      // was described before the application recorded that. These are closed
      // here so they do not stay pending forever.
      db.prepare(
        `UPDATE suggestion SET status = 'accepted'
         WHERE status = 'pending' AND document_id IN (
           SELECT document_id FROM description
           WHERE record_type IS NOT NULL OR people IS NOT NULL OR date IS NOT NULL
         )`,
      ).run();

      const total = (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM suggestion p JOIN document d ON d.id = p.document_id
             WHERE p.status = 'pending' AND d.present = 1`,
          )
          .get() as { n: number }
      ).n;

      const rows = db
        .prepare(
          `-- What was described by hand overrides what was read from the
           -- file name: if the user
           -- already corrected something, the record must show their
           -- version, not the old one.
           SELECT d.id, d.name, d.path, d.extension, d.mime, d.thumbnail, d.bytes,
                  COALESCE(de.record_type, p.record_type) AS record_type,
                  COALESCE(de.people, p.name)     AS person,
                  CASE WHEN de.people IS NULL THEN p.name_2 END AS person_2,
                  COALESCE(CAST(substr(de.date, 1, 4) AS INTEGER), p.year) AS year,
                  p.page, p.confidence, p.warnings,
                  u.title AS unit_title
           FROM suggestion p
           JOIN document d ON d.id = p.document_id
           LEFT JOIN description de ON de.document_id = d.id
           LEFT JOIN unit u ON u.id = d.unit_id
           WHERE p.status = 'pending' AND d.present = 1
           -- From most reliable to most doubtful: that way many good
           -- records are confirmed in a row before reaching the ones that
           -- require thought.
           ORDER BY p.confidence DESC, p.year, d.id
           LIMIT ? OFFSET ?`,
        )
        .all(limit, from);

      return { total, from, results: rows };
    },
  );

  /** Registered provenances, to choose from when describing. */
  app.get('/api/provenances', async () => {
    return db
      .prepare(
        `SELECT p.*, (SELECT COUNT(*) FROM description d WHERE d.provenance_id = p.id) AS documents
         FROM provenance p ORDER BY p.name`,
      )
      .all();
  });

  app.post<{ Body: Record<string, string> }>('/api/provenances', async (request, reply) => {
    const name = (request.body?.name ?? '').trim();
    if (!name) return reply.code(400).send({ error: 'A name is required' });

    const r = db
      .prepare(
        `INSERT INTO provenance (name, source_archive, original_reference, consulted_on, acquisition, url, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        name,
        request.body.source_archive ?? null,
        request.body.original_reference ?? null,
        request.body.consulted_on ?? null,
        request.body.acquisition ?? null,
        request.body.url ?? null,
        request.body.notes ?? null,
      );
    return { id: Number(r.lastInsertRowid), name };
  });

  /** Assigns a provenance to several documents at once. */
  app.post<{ Body: { documents?: number[]; provenance?: number | null } }>(
    '/api/provenances/assign',
    async (request, reply) => {
      const ids = request.body?.documents ?? [];
      if (!Array.isArray(ids) || ids.length === 0) {
        return reply.code(400).send({ error: 'Missing documents' });
      }

      inTransaction(db, () => {
        const create = db.prepare('INSERT OR IGNORE INTO description (document_id) VALUES (?)');
        const apply = db.prepare(
          "UPDATE description SET provenance_id = ?, updated_at = datetime('now') WHERE document_id = ?",
        );
        for (const id of ids) {
          create.run(id);
          apply.run(request.body.provenance ?? null, id);
        }
      });

      return { affected: ids.length };
    },
  );

  /* ---------- Gramps: read-only, over a copy ---------- */

  /**
   * Index of tree names for matching, built on demand.
   *
   * Walking the thirteen thousand events takes a few seconds, so it is cached
   * and discarded when the copy is refreshed: a new tree means new names.
   */
  let indice: MatchIndex | null = null;
  const indiceSugerencias = (): MatchIndex | null => {
    if (!ctx.gramps?.open()) return null;
    return (indice ??= new MatchIndex(ctx.gramps));
  };
  const olvidarIndice = (): void => {
    indice = null;
  };

  /** State of the connection to the Gramps tree. */
  app.get('/api/gramps/status', async () => {
    const path = readSetting(db, 'gramps_path');
    const copied_at = readSetting(db, 'gramps_copied_at');
    if (!path) return { configured: false };

    const summary = ctx.gramps?.summary() ?? null;
    return { configured: true, path, copied_at, summary, available: summary !== null };
  });

  /**
   * Points at where the Gramps sqlite.db lives and brings in a copy.
   *
   * The original file is never opened: Gramps may have it open, and working
   * over a copy makes it impossible for this application to corrupt it.
   */
  app.post<{ Body: { path?: string } }>('/api/gramps/connect', async (request, reply) => {
    const path = (request.body?.path ?? '').trim();
    if (!path) return reply.code(400).send({ error: 'Missing path to the tree' });
    if (!ctx.gramps) return reply.code(503).send({ error: 'Gramps reader not available' });

    try {
      const r = await ctx.gramps.refresh(path);
      writeSetting(db, 'gramps_path', path);
      writeSetting(db, 'gramps_copied_at', r.copied_at);
      olvidarIndice();

      const resumen = ctx.gramps.summary();
      if (!resumen || resumen.people === 0) {
        return reply.code(422).send({
          error:
            'The copy does not contain a readable tree. Check that the path points to the Gramps sqlite.db.',
        });
      }
      return { ok: true, copied_at: r.copied_at, summary: resumen };
    } catch (e) {
      return reply.code(400).send({ error: `Could not read: ${String(e).slice(0, 160)}` });
    }
  });

  /** Refreshes the copy with the current state of the tree. */
  app.post('/api/gramps/refresh', async (_request, reply) => {
    const path = readSetting(db, 'gramps_path');
    if (!path || !ctx.gramps) {
      return reply.code(400).send({ error: 'No tree has been configured' });
    }
    try {
      const r = await ctx.gramps.refresh(path);
      writeSetting(db, 'gramps_copied_at', r.copied_at);
      olvidarIndice();
      return { ok: true, copied_at: r.copied_at, summary: ctx.gramps.summary() };
    } catch (e) {
      return reply.code(400).send({ error: String(e).slice(0, 160) });
    }
  });

  /** Searches people in the tree, to link them to a document. */
  app.get<{ Querystring: { q?: string } }>('/api/gramps/people', async (request) => {
    const q = (request.query.q ?? '').trim();
    if (!q || !ctx.gramps) return [];
    return ctx.gramps.searchPeople(q, 20);
  });

  /** Context of a person: their events with participants, notes and citations. */
  app.get<{ Params: { id: string } }>('/api/gramps/person/:id', async (request, reply) => {
    if (!ctx.gramps) return reply.code(503).send({ error: 'Reader not available' });

    const p = ctx.gramps.person(request.params.id);
    if (!p) return reply.code(404).send({ error: 'Not in the tree' });

    return { ...p, events: ctx.gramps.eventsOfPerson(p.handle) };
  });

  /**
   * Links a document to a person in the tree.
   *
   * The link is stored in Regesta, never in Gramps.
   */
  app.post<{ Body: { document?: number; gramps_id?: string | null } }>(
    '/api/gramps/link',
    async (request, reply) => {
      const docId = request.body?.document;
      if (!docId) return reply.code(400).send({ error: 'Missing document' });

      const grampsId = request.body?.gramps_id ?? null;

      inTransaction(db, () => {
        if (grampsId) {
          // The person is recorded here only as a pointer: their genealogy
          // lives in Gramps and is not copied.
          const p = ctx.gramps?.person(grampsId);
          const name = p ? [p.name, p.surname].filter(Boolean).join(' ') : grampsId;

          db.prepare(
            `INSERT INTO person (gramps_id, name, match_key) VALUES (?, ?, ?)
             ON CONFLICT(gramps_id) DO UPDATE SET name = excluded.name`,
          ).run(grampsId, name, matchKey(name));
        }

        db.prepare('INSERT OR IGNORE INTO description (document_id) VALUES (?)').run(docId);
        db.prepare(
          "UPDATE description SET gramps_id = ?, updated_at = datetime('now') WHERE document_id = ?",
        ).run(grampsId, docId);
      });

      return { ok: true, gramps_id: grampsId };
    },
  );

  /**
   * Documents linked to a person in the tree.
   *
   * This is that person's documentary trail: everything held about them,
   * gathered in one place, without having to search by their name.
   */
  app.get<{ Params: { id: string } }>('/api/gramps/documents/:id', async (request) => {
    return db
      .prepare(
        `SELECT d.id, d.name, d.thumbnail, d.extension,
                COALESCE(des.record_type, p.record_type) AS record_type,
                COALESCE(CAST(substr(des.date, 1, 4) AS INTEGER), p.year) AS year,
                COALESCE(des.people, p.name) AS person
         FROM description des
         JOIN document d ON d.id = des.document_id
         LEFT JOIN suggestion p ON p.document_id = d.id
         WHERE des.gramps_id = ? AND d.present = 1
         ORDER BY year, d.name`,
      )
      .all(request.params.id);
  });

  /**
   * Documentary gaps: facts in the tree with no document backing them up.
   *
   * This is the one part of the application that looks not at what is held
   * but at what is missing: it turns the archive into a work plan for the
   * next archive visit.
   *
   * An event counts as covered when there is a document linked to that
   * person whose record type and year fit the event.
   */
  app.get<{ Querystring: { type?: string; from?: string; to?: string } }>(
    '/api/gaps',
    async (request, reply) => {
      if (!ctx.gramps) return reply.code(503).send({ error: 'Gramps is not connected' });

      const eventos = ctx.gramps.eventsWithPerson();
      if (eventos.length === 0) {
        return { total: 0, covered: 0, gaps: [], byType: [] };
      }

      // Documents already linked, grouped by person.
      const linked = db
        .prepare(
          `SELECT des.gramps_id AS person,
                  COALESCE(des.record_type, p.record_type) AS record,
                  COALESCE(CAST(substr(des.date, 1, 4) AS INTEGER), p.year) AS year
           FROM description des
           JOIN document d ON d.id = des.document_id AND d.present = 1
           LEFT JOIN suggestion p ON p.document_id = d.id
           WHERE des.gramps_id IS NOT NULL`,
        )
        .all() as Array<{ person: string; record: string | null; year: number | null }>;

      const porPersona = new Map<string, Array<{ record: string | null; year: number | null }>>();
      const note = (person: string, record: string | null, year: number | null): void => {
        if (!porPersona.has(person)) porPersona.set(person, []);
        porPersona.get(person)!.push({ record, year });
      };
      for (const e of linked) note(e.person, e.record, e.year);

      // Today's link: whoever appears as the subject of a record. A godparent
      // or a witness does not cover their own event, only someone else's.
      const links = db
        .prepare(
          `SELECT pe.gramps_id AS person,
                  COALESCE(a.record_type, p.record_type, des.record_type) AS record,
                  COALESCE(CAST(substr(a.date, 1, 4) AS INTEGER),
                           CAST(substr(des.date, 1, 4) AS INTEGER), p.year) AS year
           FROM link v
           JOIN person pe ON pe.id = v.person_id AND pe.gramps_id IS NOT NULL
           JOIN entry a ON a.id = v.entry_id
           JOIN document d ON d.id = a.document_id AND d.present = 1
           LEFT JOIN suggestion p ON p.document_id = d.id
           LEFT JOIN description des ON des.document_id = d.id
           WHERE v.role IN ('subject', 'deceased', 'spouse', 'other')`,
        )
        .all() as Array<{ person: string; record: string | null; year: number | null }>;
      for (const v of links) note(v.person, v.record, v.year);

      // What is not yet linked but identified beyond doubt by name and date
      // is also paper that is held: there is no point sending anyone to look
      // elsewhere for what is already in the archive waiting for the link to
      // be confirmed.
      const idx = indiceSugerencias();
      if (idx) {
        for (const s of matchPending(db, idx)) {
          if (!isFullyCertain(s)) continue;
          for (const p of s.people) {
            const c = p.candidates[0];
            if (c) note(c.gramps_id, s.record_type, s.year);
          }
        }
      }

      // Which Regesta record type corresponds to each Gramps event type.
      const EQUIVALENT: Record<number, string> = {
        12: 'baptism', // a birth is documented by the baptism entry
        13: 'burial',
        15: 'baptism',
        1: 'marriage',
        7: 'marriage',
        23: 'confirmation',
        19: 'burial',
      };

      const { type, from, to } = request.query;
      const anyoDesde = from ? Number.parseInt(from, 10) : null;
      const anyoHasta = to ? Number.parseInt(to, 10) : null;

      const gaps = [];
      const yaVistos = new Set<string>();
      let covered = 0;

      // Recent records cannot be consulted: parish and civil archives apply
      // closure periods, and asking for an entry from ten years ago leads
      // nowhere. What cannot be looked for is left out.
      const LIMITE_CONSULTABLE = new Date().getFullYear() - 25;

      for (const ev of eventos) {
        const esperado = EQUIVALENT[ev.type_code];
        // Only facts documented by a record are counted: a residence or an
        // occupation has no entry to look for.
        if (!esperado) continue;
        if (ev.year !== null && ev.year > LIMITE_CONSULTABLE) continue;

        const suyos = porPersona.get(ev.person_id) ?? [];
        // One year of tolerance is allowed: a baptism is usually days after
        // the birth, and register dates do not always agree with the tree.
        const cubierto = suyos.some(
          (d) =>
            (d.record === esperado || (esperado === 'baptism' && d.record === 'birth')) &&
            (ev.year === null || d.year === null || Math.abs(d.year - ev.year) <= 1),
        );

        if (cubierto) {
          covered++;
          continue;
        }

        if (type && esperado !== type) continue;
        if (anyoDesde !== null && (ev.year ?? 0) < anyoDesde) continue;
        if (anyoHasta !== null && (ev.year ?? 9999) > anyoHasta) continue;

        // The same fact can arrive by several routes -- spouses sharing a
        // marriage, or two references to the same death -- and repeating it
        // in the list gives a false impression of how much is missing.
        const clave = `${ev.person_id}|${esperado}|${ev.year ?? ''}`;
        if (yaVistos.has(clave)) continue;
        yaVistos.add(clave);

        gaps.push({ ...ev, expected_record: esperado });
      }

      // Most recent first: what is closer in time is usually the most
      // accessible in the archives and the first worth closing.
      gaps.sort((a, b) => (b.year ?? 0) - (a.year ?? 0));

      const byType = new Map<string, number>();
      for (const l of gaps) byType.set(l.expected_record, (byType.get(l.expected_record) ?? 0) + 1);

      return {
        total: covered + gaps.length,
        covered,
        gaps: gaps.slice(0, 500),
        truncated: gaps.length > 500,
        byType: [...byType.entries()].map(([t, n]) => ({ type: t, n })).sort((a, b) => b.n - a.n),
      };
    },
  );

  /* ---------- Crops: the specific entry within the folio ---------- */

  /** Entries marked within a document, with who appears in each one. */
  app.get<{ Params: { id: string } }>('/api/entries/:id', async (request) => {
    const entries = db
      .prepare(
        `SELECT a.*, l.name AS place_name
         FROM entry a LEFT JOIN place l ON l.id = a.place_id
         WHERE a.document_id = ? ORDER BY a.crop_y, a.id`,
      )
      .all(Number.parseInt(request.params.id, 10)) as Array<{ id: number }>;

    const sql = db.prepare(
      `SELECT v.id, v.person_id, v.role, v.certainty, v.notes,
              p.name, p.gramps_id
       FROM link v JOIN person p ON p.id = v.person_id
       WHERE v.entry_id = ? ORDER BY v.id`,
    );

    return entries.map((a) => ({ ...a, people: sql.all(a.id) }));
  });

  /**
   * Saves a crop: the region of the folio where one particular entry sits.
   *
   * A folio holds five or six entries; marking the one of interest saves
   * having to find it again every time the document is opened. The
   * coordinates are proportions (0..1) so they stay valid even if the image
   * resolution changes.
   */
  app.post<{
    Params: { id: string };
    Body: {
      record_type?: string;
      folio?: string;
      date?: string;
      abstract?: string;
      transcription?: string;
      crop?: { x: number; y: number; w: number; h: number; page?: number };
    };
  }>('/api/entries/:id', async (request, reply) => {
    const docId = Number.parseInt(request.params.id, 10);
    if (!db.prepare('SELECT 1 FROM document WHERE id = ?').get(docId)) {
      return reply.code(404).send({ error: 'No such document' });
    }

    const r = request.body?.crop;
    if (r && [r.x, r.y, r.w, r.h].some((v) => typeof v !== 'number' || v < 0 || v > 1)) {
      return reply.code(400).send({ error: 'The crop must be given as proportions from 0 to 1' });
    }

    const res = db
      .prepare(
        `INSERT INTO entry
           (document_id, record_type, folio, date, abstract, transcription,
            crop_x, crop_y, crop_w, crop_h, crop_page)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        docId,
        request.body?.record_type ?? null,
        request.body?.folio ?? null,
        request.body?.date ?? null,
        request.body?.abstract ?? null,
        request.body?.transcription ?? null,
        r?.x ?? null,
        r?.y ?? null,
        r?.w ?? null,
        r?.h ?? null,
        r?.page ?? null,
      );

    return db.prepare('SELECT * FROM entry WHERE id = ?').get(Number(res.lastInsertRowid));
  });

  /** Changes the data of an entry already marked. */
  app.put<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/entry/:id',
    async (request, reply) => {
      const id = Number.parseInt(request.params.id, 10);
      const FIELDS = ['record_type', 'folio', 'date', 'abstract', 'transcription', 'notes'] as const;
      const body = { ...(request.body ?? {}) };

      // The place arrives as text and is normalised against the `place`
      // table: that way one place name written across twenty records is a
      // single entry and not twenty.
      if ('place' in body) {
        const name = String(body.place ?? '').trim();
        body.place_id = name ? ensurePlace(db, name) : null;
        delete body.place;
      }

      const changes = Object.entries(body).filter(
        ([k]) => (FIELDS as readonly string[]).includes(k) || k === 'place_id',
      );
      if (changes.length === 0) return reply.code(400).send({ error: 'Nothing to save' });

      const set = changes.map(([k]) => `${k} = ?`).join(', ');
      db.prepare(`UPDATE entry SET ${set}, updated_at = datetime('now') WHERE id = ?`).run(
        ...changes.map(([, v]) => (v === '' ? null : (v as string | number | null))),
        id,
      );

      return db
        .prepare(
          `SELECT a.*, l.name AS place_name FROM entry a
           LEFT JOIN place l ON l.id = a.place_id WHERE a.id = ?`,
        )
        .get(id);
    },
  );

  app.delete<{ Params: { id: string } }>('/api/entry/:id', async (request) => {
    db.prepare('DELETE FROM entry WHERE id = ?').run(Number.parseInt(request.params.id, 10));
    return { deleted: true };
  });

  /* ---------- Who appears in each entry, in what role, how certain ---------- */

  // The roles come from the archive profile: a civil registry has no
  // godparents, and a notarial archive has grantors instead of spouses.
  const ROLES = roles();
  const CERTAINTIES = ['certain', 'probable', 'uncertain'];

  /** The roles that can be assigned, so the interface does not repeat them. */
  app.get('/api/roles', async () => ({ roles: ROLES, certezas: CERTAINTIES }));

  /**
   * Links a person to an entry, stating what part they played.
   *
   * The person comes from the Gramps tree when they are in it; when they are
   * not -- a godparent who will never enter the tree -- they are stored here
   * by name. The `certainty` field exists because in genealogy many
   * attributions are probable, and without recording that, a hypothesis ends
   * up passing for a fact.
   */
  app.post<{
    Params: { id: string };
    Body: { gramps_id?: string | null; name?: string; role?: string; certainty?: string; notes?: string };
  }>('/api/entry/:id/people', async (request, reply) => {
    const entryId = Number.parseInt(request.params.id, 10);
    if (!db.prepare('SELECT 1 FROM entry WHERE id = ?').get(entryId)) {
      return reply.code(404).send({ error: 'No such entry' });
    }

    const role = (request.body?.role ?? '').trim();
    if (!role) return reply.code(400).send({ error: 'Missing the role of the person' });

    const certainty = request.body?.certainty ?? 'certain';
    if (!CERTAINTIES.includes(certainty)) {
      return reply.code(400).send({ error: 'Unknown certainty' });
    }

    const grampsId = request.body?.gramps_id?.trim() || null;
    let name = (request.body?.name ?? '').trim();

    if (grampsId) {
      const p = ctx.gramps?.person(grampsId);
      if (p) name = [p.name, p.surname].filter(Boolean).join(' ').trim();
    }
    if (!name) return reply.code(400).send({ error: 'Missing the name of the person' });

    try {
      const link = inTransaction(db, () => {
        const personId = ensurePerson(db, name, grampsId);

        // Matching may have recognised someone already recorded under a
        // different spelling ('Isabel Jimenez' is the 'Ysabel Ximenez' of
        // another entry). This is said out loud, because otherwise the user
        // sees a name on screen they did not type and cannot tell where it
        // came from.
        const registered = db.prepare('SELECT name FROM person WHERE id = ?').get(personId) as {
          name: string;
        };
        const cotejada = registered.name !== name ? name : null;

        const res = db
          .prepare(
            `INSERT INTO link (person_id, entry_id, role, certainty, notes)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(person_id, entry_id, role)
             DO UPDATE SET certainty = excluded.certainty, notes = excluded.notes`,
          )
          .run(personId, entryId, role, certainty, request.body?.notes || null);

        // With ON CONFLICT the returned identifier is useless if there was
        // a clash: the link is looked up by its real key.
        void res;
        const fila = db
          .prepare(
            `SELECT v.id, v.person_id, v.role, v.certainty, v.notes, p.name, p.gramps_id
             FROM link v JOIN person p ON p.id = v.person_id
             WHERE v.entry_id = ? AND v.person_id = ? AND v.role = ?`,
          )
          .get(entryId, personId, role) as Record<string, unknown>;

        return { ...fila, matched_from: cotejada };
      });

      return link;
    } catch (err) {
      app.log.error({ err }, 'could not save the person link');
      return reply.code(500).send({ error: 'Could not save the link' });
    }
  });

  /** Changes the role, the certainty or the notes of a link. */
  app.put<{ Params: { id: string }; Body: { role?: string; certainty?: string; notes?: string } }>(
    '/api/link/:id',
    async (request, reply) => {
      const id = Number.parseInt(request.params.id, 10);
      if (!db.prepare('SELECT 1 FROM link WHERE id = ?').get(id)) {
        return reply.code(404).send({ error: 'No such link' });
      }

      const body = request.body ?? {};
      if (body.certainty && !CERTAINTIES.includes(body.certainty)) {
        return reply.code(400).send({ error: 'Unknown certainty' });
      }
      if ('role' in body && !String(body.role ?? '').trim()) {
        return reply.code(400).send({ error: 'Missing the role of the person' });
      }

      const changes = Object.entries(body).filter(([k]) =>
        ['role', 'certainty', 'notes'].includes(k),
      );
      if (changes.length === 0) return reply.code(400).send({ error: 'Nothing to save' });

      const set = changes.map(([k]) => `${k} = ?`).join(', ');
      db.prepare(`UPDATE link SET ${set} WHERE id = ?`).run(
        ...changes.map(([, v]) => (v === '' ? null : (v as string))),
        id,
      );

      return db
        .prepare(
          `SELECT v.id, v.person_id, v.role, v.certainty, v.notes, p.name, p.gramps_id
           FROM link v JOIN person p ON p.id = v.person_id WHERE v.id = ?`,
        )
        .get(id);
    },
  );

  app.delete<{ Params: { id: string } }>('/api/link/:id', async (request) => {
    db.prepare('DELETE FROM link WHERE id = ?').run(Number.parseInt(request.params.id, 10));
    return { deleted: true };
  });

  /**
   * People already used in links, to suggest them while typing.
   *
   * This complements the Gramps search: the witnesses and godparents that
   * exist only in the archive show up here too.
   */
  app.get<{ Querystring: { q?: string } }>('/api/people', async (request) => {
    const q = (request.query.q ?? '').trim();
    if (!q) return [];
    return db
      .prepare(
        `SELECT p.id, p.name, p.gramps_id,
                (SELECT COUNT(*) FROM link v WHERE v.person_id = p.id) AS uses
         FROM person p
         WHERE p.match_key LIKE ? OR p.name LIKE ?
         ORDER BY uses DESC, p.name LIMIT 15`,
      )
      .all(`%${matchKey(q)}%`, `%${q}%`);
  });

  /** All that is known of a person in the archive: where they appear and in what role. */
  app.get<{ Params: { id: string } }>('/api/person/:id', async (request, reply) => {
    const id = Number.parseInt(request.params.id, 10);
    const p = db.prepare('SELECT * FROM person WHERE id = ?').get(id);
    if (!p) return reply.code(404).send({ error: 'No such person' });

    const apariciones = db
      .prepare(
        `SELECT v.role, v.certainty, a.id AS entry_id, a.record_type, a.date, a.folio,
                d.id AS document_id, d.name AS file, d.thumbnail,
                l.name AS place_name
         FROM link v
         JOIN entry a ON a.id = v.entry_id
         JOIN document d ON d.id = a.document_id
         LEFT JOIN place l ON l.id = a.place_id
         WHERE v.person_id = ?
         ORDER BY a.date, d.name`,
      )
      .all(id);

    return { ...p, apariciones };
  });

  /* ---------- Matching against the tree: person candidates ---------- */

  /**
   * Queue of documents whose person can be identified in the tree.
   *
   * Only those with a reviewed record get in: matching against an unconfirmed
   * reading of the file name would be building on sand.
   */
  app.get<{ Querystring: { limit?: string; from?: string; certainty?: string } }>(
    '/api/matches/queue',
    async (request, reply) => {
      const idx = indiceSugerencias();
      if (!idx) return reply.code(503).send({ error: 'No tree is connected' });

      const limit = Math.min(50, Math.max(1, Number.parseInt(request.query.limit ?? '20', 10)));
      const soloSeguras = request.query.certainty === 'certain';

      const all = matchPending(db, idx);
      const filtered = soloSeguras ? all.filter(isFullyCertain) : all;

      // Only reviewed records are matched. An empty queue means something
      // different when nothing has been reviewed yet, and the screen has to
      // be able to say which.
      const reviewed = (
        db
          .prepare(
            `SELECT COUNT(DISTINCT p.document_id) AS n FROM suggestion p
             JOIN document d ON d.id = p.document_id
             WHERE p.status = 'accepted' AND d.present = 1`,
          )
          .get() as { n: number }
      ).n;

      return {
        results: filtered.slice(0, limit),
        total: filtered.length,
        certain_count: all.filter(isFullyCertain).length,
        reviewed,
      };
    },
  );

  /**
   * Links in one go everything whose identification admits no doubt.
   *
   * It is kept apart from the queue because it spans the whole archive, not
   * the batch currently on screen: pressing it twenty times to work through
   * the batches would be exactly the labour this screen exists to avoid.
   */
  app.post('/api/matches/accept-certain', async (_request, reply) => {
    const idx = indiceSugerencias();
    if (!idx) return reply.code(503).send({ error: 'No tree is connected' });

    const certain_count = matchPending(db, idx).filter(isFullyCertain);
    let saved = 0;

    inTransaction(db, () => {
      for (const s of certain_count) {
        for (const p of s.people) {
          const c = p.candidates[0];
          if (c?.certainty !== 'certain') continue;
          linkPerson(db, s.document, c.gramps_id, c.name, s.role, 'certain');
          saved++;
        }
      }
    });

    return { saved, documents: certain_count.length };
  });

  /**
   * Confirms suggested links.
   *
   * Each one creates, if needed, the entry representing the record within the
   * document: until now that only existed once marked by hand over the image,
   * and here the whole document is taken to be that entry.
   */
  app.post<{
    Body: {
      links?: Array<{
        document: number;
        gramps_id: string;
        name: string;
        role?: string;
        certainty?: string;
      }>;
    };
  }>('/api/matches/accept', async (request, reply) => {
    const list = request.body?.links ?? [];
    if (!Array.isArray(list) || list.length === 0) {
      return reply.code(400).send({ error: 'No links to save' });
    }
    for (const v of list) {
      if (v.certainty && !CERTAINTIES.includes(v.certainty)) {
        return reply.code(400).send({ error: `Unknown certainty: ${v.certainty}` });
      }
      if (v.role && !ROLES.includes(v.role)) {
        return reply.code(400).send({ error: `Unknown role: ${v.role}` });
      }
    }

    let saved = 0;

    inTransaction(db, () => {
      for (const v of list) {
        if (linkPerson(db, v.document, v.gramps_id, v.name, v.role, v.certainty)) saved++;
      }
    });

    return { saved };
  });

  /* ---------- Lugares normalizados ---------- */

  /**
   * Places already recorded, to suggest them while typing.
   *
   * Without `q` it returns them all with their usage, which is what the
   * management screen needs; with `q` it filters by match key, so that 'Utiel'
   * also finds 'Utiel (Valencia)'.
   */
  app.get<{ Querystring: { q?: string } }>('/api/places', async (request) => {
    const q = (request.query.q ?? '').trim();
    const uses = `(SELECT COUNT(*) FROM entry a WHERE a.place_id = l.id) AS uses`;

    if (!q) {
      return db.prepare(`SELECT l.*, ${uses} FROM place l ORDER BY uses DESC, l.name`).all();
    }
    return db
      .prepare(
        `SELECT l.*, ${uses} FROM place l
         WHERE l.match_key LIKE ? OR l.name LIKE ?
            OR EXISTS (SELECT 1 FROM place_variant vl
                        WHERE vl.place_id = l.id AND vl.spelling LIKE ?)
         ORDER BY uses DESC, l.name LIMIT 15`,
      )
      .all(`%${matchKey(q)}%`, `%${q}%`, `%${q}%`);
  });

  /** Creates or updates a place with its administrative data. */
  app.post<{ Body: Record<string, string> }>('/api/places', async (request, reply) => {
    const name = (request.body?.name ?? '').trim();
    if (!name) return reply.code(400).send({ error: 'The place needs a name' });

    const id = ensurePlace(db, name);
    const FIELDS = ['type', 'municipality', 'province', 'country', 'notes'];
    const changes = Object.entries(request.body ?? {}).filter(([k]) => FIELDS.includes(k));

    if (changes.length > 0) {
      const set = changes.map(([k]) => `${k} = ?`).join(', ');
      db.prepare(`UPDATE place SET ${set} WHERE id = ?`).run(
        ...changes.map(([, v]) => (v === '' ? null : v)),
        id,
      );
    }

    return db.prepare('SELECT * FROM place WHERE id = ?').get(id);
  });

  app.put<{ Params: { id: string }; Body: Record<string, string> }>(
    '/api/place/:id',
    async (request, reply) => {
      const id = Number.parseInt(request.params.id, 10);
      if (!db.prepare('SELECT 1 FROM place WHERE id = ?').get(id)) {
        return reply.code(404).send({ error: 'No such place' });
      }

      const body = request.body ?? {};
      if ('name' in body && !String(body.name ?? '').trim()) {
        return reply.code(400).send({ error: 'The place needs a name' });
      }

      const FIELDS = ['name', 'type', 'municipality', 'province', 'country', 'notes'];
      const changes = Object.entries(body).filter(([k]) => FIELDS.includes(k));
      if (changes.length === 0) return reply.code(400).send({ error: 'Nothing to save' });

      inTransaction(db, () => {
        const set = changes.map(([k]) => `${k} = ?`).join(', ');
        db.prepare(`UPDATE place SET ${set} WHERE id = ?`).run(
          ...changes.map(([, v]) => (v === '' ? null : v)),
          id,
        );
        if ('name' in body) {
          db.prepare('UPDATE place SET match_key = ? WHERE id = ?').run(
            matchKey(String(body.name)),
            id,
          );
        }
      });

      return db.prepare('SELECT * FROM place WHERE id = ?').get(id);
    },
  );

  /**
   * Merges two places into one.
   *
   * 'Ayora' and 'Villa de Ayora' are the same place written by two different
   * clerks. On merging, the absorbed spelling is kept as a variant: how the
   * document named it is not lost.
   */
  app.post<{ Body: { from?: number; into?: number } }>(
    '/api/places/merge',
    async (request, reply) => {
      const from = request.body?.from;
      const into = request.body?.into;
      if (!from || !into || from === into) {
        return reply.code(400).send({ error: 'Two different places are required' });
      }

      const a = db.prepare('SELECT * FROM place WHERE id = ?').get(from) as
        | { id: number; name: string }
        | undefined;
      const b = db.prepare('SELECT 1 FROM place WHERE id = ?').get(into);
      if (!a || !b) return reply.code(404).send({ error: 'One of the places does not exist' });

      const moved = inTransaction(db, () => {
        const n = db.prepare('UPDATE entry SET place_id = ? WHERE place_id = ?').run(into, from)
          .changes;
        db.prepare('INSERT OR IGNORE INTO place_variant (place_id, spelling) VALUES (?, ?)').run(
          into,
          a.name,
        );
        db.prepare(
          `INSERT OR IGNORE INTO place_variant (place_id, spelling)
           SELECT ?, spelling FROM place_variant WHERE place_id = ?`,
        ).run(into, from);
        db.prepare('DELETE FROM place WHERE id = ?').run(from);
        return n;
      });

      return { fundido: true, entries_moved: moved };
    },
  );

  app.delete<{ Params: { id: string } }>('/api/place/:id', async (request, reply) => {
    const id = Number.parseInt(request.params.id, 10);
    const uses = db.prepare('SELECT COUNT(*) AS n FROM entry WHERE place_id = ?').get(id) as {
      n: number;
    };
    if (uses.n > 0) {
      return reply
        .code(409)
        .send({ error: `That place is used by ${uses.n} entr(y/ies). Merge it into another instead of deleting it.` });
    }
    db.prepare('DELETE FROM place WHERE id = ?').run(id);
    return { deleted: true };
  });

  /* ---------- Open export ---------- */

  /** What there is to export, so it can be shown before launching it. */
  app.get('/api/export/summary', async () => {
    const n = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
    return {
      documents: n('SELECT COUNT(*) AS n FROM document'),
      described: n('SELECT COUNT(*) AS n FROM description'),
      entries: n('SELECT COUNT(*) AS n FROM entry'),
      tags: n('SELECT COUNT(*) AS n FROM tag'),
      provenances: n('SELECT COUNT(*) AS n FROM provenance'),
      units: n('SELECT COUNT(*) AS n FROM unit'),
      links: n('SELECT COUNT(*) AS n FROM link'),
      people: n('SELECT COUNT(*) AS n FROM person'),
      places: n('SELECT COUNT(*) AS n FROM place'),
      last: readSetting(db, 'last_export'),
    };
  });

  /** A single CSV, to download from the browser. */
  app.get<{ Params: { which: string } }>('/api/export/csv/:which', async (request, reply) => {
    const generadores: Record<string, () => string> = {
      documents: () => documentsCsv(db),
      entries: () => entriesCsv(db),
      tags: () => tagsCsv(db),
      provenances: () => provenancesCsv(db),
      classification: () => classificationCsv(db),
      links: () => linksCsv(db),
      places: () => placesCsv(db),
    };

    const generar = generadores[request.params.which];
    if (!generar) return reply.code(404).send({ error: 'No such export' });

    const date = new Date().toISOString().slice(0, 10);
    return reply
      .type('text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="regesta-${request.params.which}-${date}.csv"`)
      .send(generar());
  });

  /**
   * Dumps everything to the data folder.
   *
   * This is what really protects the work: the files end up beside the
   * database, on the server, where the backup already reaches. A download to
   * the browser only saves what is on whichever machine happens to be
   * looking.
   */
  app.post('/api/export', async (_request, reply) => {
    const target = join(dirname(readSetting(db, 'db_path') ?? '/data/regesta.db'), 'exportacion');

    try {
      await mkdir(join(target, 'documents'), { recursive: true });

      const files: Array<[string, string]> = [
        ['documents.csv', documentsCsv(db)],
        ['entries.csv', entriesCsv(db)],
        ['tags.csv', tagsCsv(db)],
        ['provenances.csv', provenancesCsv(db)],
        ['classification-scheme.csv', classificationCsv(db)],
        ['people-in-entries.csv', linksCsv(db)],
        ['places.csv', placesCsv(db)],
      ];

      for (const [name, contents] of files) {
        await writeFile(join(target, name), contents, 'utf8');
      }

      // One text file per described document: a long transcription fits
      // badly in a CSV cell, and this way it can be read with anything.
      const ids = describedIds(db);
      let written = 0;
      for (const id of ids) {
        const text = documentText(db, id);
        if (!text) continue;
        const path = (db.prepare('SELECT path FROM document WHERE id = ?').get(id) as { path: string }).path;
        await writeFile(join(target, 'documents', `${safeFileName(path)}.txt`), text, 'utf8');
        written++;
      }

      await writeFile(
        join(target, 'README.txt'),
        [
          'REGESTA EXPORT',
          '==================',
          '',
          `Generated on ${new Date().toISOString().slice(0, 19).replace('T', ' ')}.`,
          '',
          'These files hold the cataloguing work in formats that can be read',
          'without Regesta: the CSVs with any spreadsheet, the .txt files',
          'with any editor.',
          '',
          '  documents.csv              One document per row, with its description',
          '  entries.csv                Entries marked within the folios',
          '  tags.csv                   Which tag each document carries',
          '  provenances.csv            Where each document came from',
          '  classification-scheme.csv  The hierarchy of fonds, sections and series',
          '  people-in-entries.csv      Who appears in each entry, in what role',
          '  places.csv                 Normalised places and their other spellings',
          '  documents/                 One .txt per described document',
          '',
          'The CSVs use a semicolon as separator, which is what spreadsheets',
          'expect in locales where the comma is the decimal separator. The',
          '"Path" column says where the original file sits inside the archive',
          'folder.',
          '',
          'The original documents are NOT here: they are where they always',
          'were, in your own folder. This is only the description.',
          '',
        ].join('\n'),
        'utf8',
      );

      const when = new Date().toISOString();
      writeSetting(db, 'last_export', when);

      return { ok: true, target, files: files.length + 1, texts: written, when };
    } catch (e) {
      return reply.code(500).send({ error: `Could not export: ${String(e).slice(0, 160)}` });
    }
  });

  /** Tags with the number of documents carrying each one. */
  app.get('/api/tags', async () => {
    return db
      .prepare(
        `SELECT e.id, e.name, e.color, e.notes,
                (SELECT COUNT(*) FROM document_tag de
                  JOIN document d ON d.id = de.document_id
                  WHERE de.tag_id = e.id AND d.present = 1) AS documents
         FROM tag e ORDER BY e.position, e.name`,
      )
      .all();
  });

  app.post<{ Body: { name?: string; color?: string } }>(
    '/api/tags',
    async (request, reply) => {
      const name = (request.body?.name ?? '').trim();
      if (!name) return reply.code(400).send({ error: 'A name is required' });
      if (name.length > 60) return reply.code(400).send({ error: 'The name is too long' });

      try {
        const r = db
          .prepare('INSERT INTO tag (name, color) VALUES (?, ?)')
          .run(name, request.body?.color ?? null);
        return { id: Number(r.lastInsertRowid), name };
      } catch {
        return reply.code(409).send({ error: 'A tag with that name already exists' });
      }
    },
  );

  app.delete<{ Params: { id: string } }>('/api/tags/:id', async (request) => {
    // Only the tag is deleted: the documents are left alone.
    db.prepare('DELETE FROM tag WHERE id = ?').run(Number.parseInt(request.params.id, 10));
    return { borrada: true };
  });

  /** Adds or removes a tag on one or several documents. */
  app.post<{ Body: { documents?: number[]; tag?: number; apply?: boolean } }>(
    '/api/tag',
    async (request, reply) => {
      const ids = request.body?.documents ?? [];
      const tag = request.body?.tag;
      if (!Array.isArray(ids) || ids.length === 0 || !tag) {
        return reply.code(400).send({ error: 'Missing documents or tag' });
      }

      const apply = request.body?.apply !== false;
      inTransaction(db, () => {
        const sql = apply
          ? 'INSERT OR IGNORE INTO document_tag (document_id, tag_id) VALUES (?, ?)'
          : 'DELETE FROM document_tag WHERE document_id = ? AND tag_id = ?';
        const stmt = db.prepare(sql);
        for (const id of ids) stmt.run(id, tag);
      });

      return { affected: ids.length, puesta: apply };
    },
  );

  /* ---------- Classification scheme ---------- */

  /** The complete classification scheme. */
  app.get('/api/classification', async () => {
    return db
      .prepare(
        `SELECT u.id, u.parent_id, u.level, u.title, u.reference_code, u.position,
                u.start_date, u.end_date, u.extent, u.creator, u.scope_content,
                (SELECT COUNT(*) FROM document d WHERE d.unit_id = u.id AND d.present = 1) AS documents
         FROM unit u ORDER BY u.parent_id IS NOT NULL, u.position, u.title`,
      )
      .all();
  });

  /** Full ISAD(G) record of a unit, with its path to the root. */
  app.get<{ Params: { id: string } }>('/api/unit/:id', async (request, reply) => {
    const id = Number.parseInt(request.params.id, 10);
    const u = db.prepare('SELECT * FROM unit WHERE id = ?').get(id);
    if (!u) return reply.code(404).send({ error: 'No such unit' });

    const documents = db
      .prepare(
        `SELECT COUNT(*) AS n FROM document WHERE unit_id = ? AND present = 1`,
      )
      .get(id) as { n: number };

    return { ...u, path_to_root: unitPath(db, id), documents: documents.n };
  });

  const LEVELS = [
    'fonds', 'section', 'subsection', 'series', 'subseries',
    'item', 'grouping',
  ];

  const UNIT_FIELDS = [
    'title', 'level', 'reference_code', 'start_date', 'end_date', 'extent',
    'creator', 'admin_history', 'scope_content', 'access', 'medium', 'condition',
    'notes',
  ] as const;

  /**
   * Creates a node of the scheme.
   *
   * The scheme is seeded from the folders on disk, but that structure is a
   * starting point, not an archival classification. This is where the fonds
   * and series the archive really has get created.
   */
  app.post<{ Body: Record<string, unknown> }>('/api/unit', async (request, reply) => {
    const body = request.body ?? {};
    const title = String(body.title ?? '').trim();
    if (!title) return reply.code(400).send({ error: 'The unit needs a title' });

    const level = String(body.level ?? 'series');
    if (!LEVELS.includes(level)) return reply.code(400).send({ error: 'Unknown level' });

    const padreId = body.parent_id == null ? null : Number(body.parent_id);
    if (padreId !== null && !db.prepare('SELECT 1 FROM unit WHERE id = ?').get(padreId)) {
      return reply.code(400).send({ error: 'The parent unit does not exist' });
    }

    // Placed after its siblings, which is where something newly created is
    // expected to appear.
    const ultimo = db
      .prepare(
        padreId === null
          ? 'SELECT MAX(position) AS o FROM unit WHERE parent_id IS NULL'
          : 'SELECT MAX(position) AS o FROM unit WHERE parent_id = ?',
      )
      .get(...(padreId === null ? [] : [padreId])) as { o: number | null };

    const res = db
      .prepare('INSERT INTO unit (parent_id, level, title, reference_code, position) VALUES (?, ?, ?, ?, ?)')
      .run(padreId, level, title, (body.reference_code as string) || null, (ultimo.o ?? -1) + 1);

    return db.prepare('SELECT * FROM unit WHERE id = ?').get(Number(res.lastInsertRowid));
  });

  /** Changes the data of a unit, or moves it within the scheme. */
  app.put<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/api/unit/:id',
    async (request, reply) => {
      const id = Number.parseInt(request.params.id, 10);
      if (!db.prepare('SELECT 1 FROM unit WHERE id = ?').get(id)) {
        return reply.code(404).send({ error: 'No such unit' });
      }

      const body = request.body ?? {};
      if ('level' in body && !LEVELS.includes(String(body.level))) {
        return reply.code(400).send({ error: 'Unknown level' });
      }
      if ('title' in body && !String(body.title ?? '').trim()) {
        return reply.code(400).send({ error: 'The unit needs a title' });
      }

      // Moving: a unit must be prevented from ending up hanging off itself,
      // which would leave an orphan branch invisible in the scheme.
      if ('parent_id' in body) {
        const nuevoPadre = body.parent_id == null ? null : Number(body.parent_id);
        if (nuevoPadre !== null) {
          if (nuevoPadre === id) {
            return reply.code(400).send({ error: 'A unit cannot hang from itself' });
          }
          if (!db.prepare('SELECT 1 FROM unit WHERE id = ?').get(nuevoPadre)) {
            return reply.code(400).send({ error: 'The parent unit does not exist' });
          }
          if (unitPath(db, nuevoPadre).some((c) => c.id === id)) {
            return reply.code(400).send({ error: 'A unit cannot be moved inside itself' });
          }
        }
        db.prepare('UPDATE unit SET parent_id = ? WHERE id = ?').run(nuevoPadre, id);
      }

      const changes = Object.entries(body).filter(([k]) =>
        (UNIT_FIELDS as readonly string[]).includes(k),
      );
      if (changes.length > 0) {
        const set = changes.map(([k]) => `${k} = ?`).join(', ');
        db.prepare(`UPDATE unit SET ${set}, updated_at = datetime('now') WHERE id = ?`).run(
          ...changes.map(([, v]) => (v === '' || v == null ? null : String(v))),
          id,
        );
      }

      if (typeof body.position === 'number') {
        db.prepare('UPDATE unit SET position = ? WHERE id = ?').run(body.position, id);
      }

      return db.prepare('SELECT * FROM unit WHERE id = ?').get(id);
    },
  );

  /**
   * Deletes a unit from the scheme.
   *
   * It never takes documents with it: they end up unclassified, but they are
   * still there. Deleting a whole branch by accident would cost the work of
   * describing it.
   */
  app.delete<{ Params: { id: string }; Querystring: { reassign?: string } }>(
    '/api/unit/:id',
    async (request, reply) => {
      const id = Number.parseInt(request.params.id, 10);
      const u = db.prepare('SELECT parent_id FROM unit WHERE id = ?').get(id) as
        | { parent_id: number | null }
        | undefined;
      if (!u) return reply.code(404).send({ error: 'No such unit' });

      const hijos = db.prepare('SELECT COUNT(*) AS n FROM unit WHERE parent_id = ?').get(id) as {
        n: number;
      };
      const docs = db.prepare('SELECT COUNT(*) AS n FROM document WHERE unit_id = ?').get(id) as {
        n: number;
      };

      inTransaction(db, () => {
        // Las units hijas suben un level en place de desaparecer.
        db.prepare('UPDATE unit SET parent_id = ? WHERE parent_id = ?').run(u.parent_id, id);
        db.prepare('UPDATE document SET unit_id = ? WHERE unit_id = ?').run(u.parent_id, id);
        db.prepare('DELETE FROM unit WHERE id = ?').run(id);
      });

      return { deleted: true, children_relocated: hijos.n, documents_relocated: docs.n };
    },
  );

  /** Classifies documents: hangs them from a unit of the scheme. */
  app.post<{ Body: { documents?: number[]; unit?: number | null } }>(
    '/api/classification/assign',
    async (request, reply) => {
      const ids = (request.body?.documents ?? []).filter((n) => Number.isInteger(n));
      if (ids.length === 0) return reply.code(400).send({ error: 'No documents given' });

      const unit = request.body?.unit ?? null;
      if (unit !== null && !db.prepare('SELECT 1 FROM unit WHERE id = ?').get(unit)) {
        return reply.code(400).send({ error: 'No such unit' });
      }

      const sql = db.prepare('UPDATE document SET unit_id = ? WHERE id = ?');
      inTransaction(db, () => {
        for (const id of ids) sql.run(unit, id);
      });

      return { classified: ids.length, unit };
    },
  );

  /** Documents hanging from a unit, to see them on opening it. */
  app.get<{ Params: { id: string } }>('/api/unit/:id/documents', async (request) => {
    return db
      .prepare(
        `SELECT d.id, d.name, d.path, d.thumbnail, d.extension,
                COALESCE(des.record_type, p.record_type) AS record_type,
                COALESCE(CAST(substr(des.date, 1, 4) AS INTEGER), p.year) AS year
         FROM document d
         LEFT JOIN description des ON des.document_id = d.id
         LEFT JOIN suggestion p ON p.document_id = d.id
         WHERE d.unit_id = ? AND d.present = 1
         ORDER BY year, d.name
         LIMIT 500`,
      )
      .all(Number.parseInt(request.params.id, 10));
  });

  /** Groups of identical files. */
  app.get('/api/duplicates', async () => {
    const grupos = db
      .prepare(
        `SELECT hash, COUNT(*) AS copies FROM document
         WHERE present = 1 GROUP BY hash HAVING COUNT(*) > 1
         ORDER BY COUNT(*) DESC LIMIT 200`,
      )
      .all() as Array<{ hash: string; copies: number }>;

    return grupos.map((g) => ({
      ...g,
      files: db
        .prepare('SELECT id, path, name, bytes, thumbnail FROM document WHERE hash = ? AND present = 1')
        .all(g.hash),
    }));
  });

  /** Records read from file names that are worth reviewing. */
  app.get('/api/review', async () => {
    return db
      .prepare(
        `SELECT p.*, d.path, d.name AS file, d.thumbnail
         FROM suggestion p JOIN document d ON d.id = p.document_id
         WHERE p.status = 'pending' AND p.confidence < 0.9 AND d.present = 1
         ORDER BY p.confidence ASC LIMIT 300`,
      )
      .all();
  });

  /** Thumbnail of a document. */
  app.get<{ Params: { '*': string } }>('/thumb/*', async (request, reply) => {
    const target = insideOf(ctx.thumbnailDir, request.params['*']);
    if (!target) return reply.code(400).send({ error: 'Path not allowed' });

    try {
      await stat(target);
    } catch {
      return reply.code(404).send({ error: 'Thumbnail not available' });
    }

    return reply.type('image/webp').header('cache-control', 'public, max-age=604800').send(createReadStream(target));
  });

  /**
   * Contents of a text document, to show in the viewer.
   *
   * Decoding happens on the server because archive transcriptions are old
   * files saved on Windows, many of them in Latin-1: served as plain UTF-8,
   * their accented characters would come out broken.
   */
  app.get<{ Params: { id: string } }>('/api/text/:id', async (request, reply) => {
    const id = Number.parseInt(request.params.id, 10);
    const doc = db.prepare('SELECT path, extension, bytes FROM document WHERE id = ?').get(id) as
      | { path: string; extension: string | null; bytes: number }
      | undefined;
    if (!doc) return reply.code(404).send({ error: 'No such document' });

    const root = readSetting(db, 'document_root');
    if (!root) return reply.code(500).send({ error: 'No indexed folder configured' });

    const target = insideOf(root, doc.path);
    if (!target) return reply.code(400).send({ error: 'Path not allowed' });

    // A huge text file is not sent to the browser in full.
    const TOPE = 2 * 1024 * 1024;
    try {
      const crudo = await readFile(target);
      const truncated = crudo.length > TOPE;
      const trozo = truncated ? crudo.subarray(0, TOPE) : crudo;

      return {
        text: decode(trozo),
        truncated,
        bytes: doc.bytes,
      };
    } catch {
      return reply.code(404).send({ error: 'The file is no longer on disk' });
    }
  });

  /**
   * Stores the thumbnail of a PDF generated by the browser.
   *
   * Rendering a PDF on the server would require a native module with its
   * system dependencies, complicating the container. Since the viewer
   * already ships PDF.js, the first page is rendered in the browser the first
   * time it is needed and sent here so the work is not repeated.
   */
  app.post<{ Params: { id: string }; Body: { image?: string } }>(
    '/api/pdf-thumbnail/:id',
    async (request, reply) => {
      const id = Number.parseInt(request.params.id, 10);
      const doc = db.prepare('SELECT hash, extension, thumbnail FROM document WHERE id = ?').get(id) as
        | { hash: string; extension: string | null; thumbnail: string | null }
        | undefined;
      if (!doc) return reply.code(404).send({ error: 'No such document' });
      if ((doc.extension ?? '').toLowerCase() !== '.pdf') {
        return reply.code(415).send({ error: 'Only PDF thumbnails are accepted' });
      }
      if (doc.thumbnail) return { path: doc.thumbnail, alreadyThere: true };

      const data = request.body?.image ?? '';
      const m = /^data:image\/(png|webp|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(data);
      if (!m) return reply.code(400).send({ error: 'Invalid image' });

      const binario = Buffer.from(m[2]!, 'base64');
      // Half a dozen kilobytes is enough for a thumbnail; more is a sign
      // that something does not add up.
      if (binario.length > 512 * 1024) {
        return reply.code(413).send({ error: 'The thumbnail is too large' });
      }

      try {
        // It is re-encoded with sharp instead of storing what arrived as-is:
        // that way the file that lands on disk was written by the
        // application, at the usual size and format.
        const sub = doc.hash.slice(0, 2);
        const name = `${doc.hash}.webp`;
        await mkdir(join(ctx.thumbnailDir, sub), { recursive: true });
        await sharp(binario)
          .resize(400, 400, { fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 80 })
          .toFile(join(ctx.thumbnailDir, sub, name));

        const path = `${sub}/${name}`;
        db.prepare('UPDATE document SET thumbnail = ? WHERE id = ?').run(path, id);
        return { path };
      } catch {
        return reply.code(422).send({ error: 'Could not save the thumbnail' });
      }
    },
  );

  /**
   * First lines of a text or Word document, for the grid preview.
   *
   * For these formats a taste of the content says far more than a thumbnail
   * image: what one wants to know before opening a visit plan or a
   * transcription is what it is about.
   */
  app.get<{ Params: { id: string } }>('/api/preview/:id', async (request, reply) => {
    const id = Number.parseInt(request.params.id, 10);
    const doc = db.prepare('SELECT path, extension FROM document WHERE id = ?').get(id) as
      | { path: string; extension: string | null }
      | undefined;
    if (!doc) return reply.code(404).send({ error: 'No such document' });

    const root = readSetting(db, 'document_root');
    if (!root) return reply.code(500).send({ error: 'No indexed folder configured' });
    const target = insideOf(root, doc.path);
    if (!target) return reply.code(400).send({ error: 'Path not allowed' });

    const ext = (doc.extension ?? '').toLowerCase();
    // Half an hour of cache: the content of an archive file does not change.
    reply.header('cache-control', 'private, max-age=1800');

    try {
      if (ext === '.txt' || ext === '.md') {
        const crudo = await readFile(target);
        return { text: truncate(decode(crudo.subarray(0, 8192))) };
      }

      if (ext === '.docx') {
        const mammoth = await import('mammoth');
        const r = await mammoth.extractRawText({ path: target });
        return { text: truncate(r.value) };
      }

      return reply.code(415).send({ error: 'That format has no text preview' });
    } catch {
      return reply.code(404).send({ error: 'Could not read the file' });
    }
  });

  /**
   * Contents of a .docx converted to HTML.
   *
   * A .docx is a ZIP with XML inside. One could extract the text alone, but
   * the Word documents in an archive tend to be visit plans with lists and
   * tables: losing that structure would make them unreadable. Mammoth
   * translates the XML to HTML, keeping paragraphs, lists, tables and bold.
   *
   * The conversion happens on the server and the result is sanitised before
   * being sent: a .docx can carry arbitrary embedded HTML.
   */
  app.get<{ Params: { id: string } }>('/api/docx/:id', async (request, reply) => {
    const id = Number.parseInt(request.params.id, 10);
    const doc = db.prepare('SELECT path, extension FROM document WHERE id = ?').get(id) as
      | { path: string; extension: string | null }
      | undefined;
    if (!doc) return reply.code(404).send({ error: 'No such document' });
    if ((doc.extension ?? '').toLowerCase() !== '.docx') {
      return reply.code(415).send({ error: 'Only .docx files can be converted' });
    }

    const root = readSetting(db, 'document_root');
    if (!root) return reply.code(500).send({ error: 'No indexed folder configured' });

    const target = insideOf(root, doc.path);
    if (!target) return reply.code(400).send({ error: 'Path not allowed' });

    try {
      const mammoth = await import('mammoth');
      const r = await mammoth.convertToHtml(
        { path: target },
        {
          // Embedded images are converted to inline data: that way nothing
          // has to be written to disk and no temporary files are served.
          convertImage: mammoth.images.imgElement(async (image) => {
            const buffer = await image.read('base64');
            return { src: `data:${image.contentType};base64,${buffer}` };
          }),
        },
      );

      return {
        html: sanitizeHtml(r.value),
        warnings: r.messages.filter((m) => m.type === 'warning').map((m) => m.message),
      };
    } catch {
      return reply.code(422).send({ error: 'Could not read the document' });
    }
  });

  /**
   * The original document. Served from the user's folder, always read-only
   * and always checking that the path does not escape the indexed root.
   */
  app.get<{ Params: { id: string } }>('/file/:id', async (request, reply) => {
    const id = Number.parseInt(request.params.id, 10);
    const doc = db.prepare('SELECT path, mime, name FROM document WHERE id = ?').get(id) as
      | { path: string; mime: string | null; name: string }
      | undefined;
    if (!doc) return reply.code(404).send({ error: 'No such document' });

    const root = readSetting(db, 'document_root');
    if (!root) return reply.code(500).send({ error: 'No indexed folder configured' });

    const target = insideOf(root, doc.path);
    if (!target) return reply.code(400).send({ error: 'Path not allowed' });

    let info;
    try {
      info = await stat(target);
    } catch {
      return reply.code(404).send({ error: 'The file is no longer on disk' });
    }

    return reply
      .type(doc.mime ?? 'application/octet-stream')
      .header('content-length', String(info.size))
      .header('cache-control', 'private, max-age=3600')
      .send(createReadStream(target));
  });
}

/**
 * Reduces a text to a short taste: strips surplus whitespace and cuts to a
 * few lines, which is what fits in a preview.
 */
function truncate(text: string, max = 320): string {
  const clean = text
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return clean.length > max ? `${clean.slice(0, max).trimEnd()}…` : clean;
}

/**
 * Keeps only the structural tags of interest from the converted HTML.
 *
 * The result is inserted into the page, and a .docx is a file that may come
 * from anywhere: although Mammoth does not emit scripts, it is unwise to rely
 * on that. A short list of tags is allowed and no attributes at all, except
 * the source of embedded images.
 */
function sanitizeHtml(html: string): string {
  const ALLOWED = new Set([
    'p', 'br', 'strong', 'b', 'em', 'i', 'u', 'sub', 'sup',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'ul', 'ol', 'li',
    'table', 'thead', 'tbody', 'tr', 'td', 'th',
    'blockquote', 'hr', 'img',
  ]);

  return (
    html
      // Out with any executable or style block, along with its contents.
      .replace(/<(script|style|iframe|object|embed)\b[\s\S]*?<\/\1>/gi, '')
      // And any tag not on the list.
      .replace(/<\/?([a-zA-Z0-9]+)((?:\s[^>]*)?)\/?>/g, (tag, name: string, atributos: string) => {
        const n = name.toLowerCase();
        if (!ALLOWED.has(n)) return '';
        if (tag.startsWith('</')) return `</${n}>`;

        // Only images keep an attribute, and only if it is inline data:
        // never an external address, which would leak the request.
        if (n === 'img') {
          const src = /\ssrc\s*=\s*"(data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]+)"/i.exec(atributos);
          return src ? `<img src="${src[1]}" alt="">` : '';
        }
        return `<${n}>`;
      })
  );
}

/**
 * Turns the contents of a file into text, guessing its encoding.
 *
 * Archive transcriptions tend to be written on Windows over many years: some
 * in UTF-8 and others in Latin-1 (windows-1252). Decoding everything as UTF-8
 * makes the Latin-1 ones show the replacement character exactly where the
 * accented letters were, which is to say inside the proper names.
 */
function decode(data: Buffer): string {
  // Byte-order mark: leaves no room for doubt.
  if (data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(data.subarray(3));
  }

  // Strict UTF-8 is attempted first; if the byte sequence is invalid, the
  // file is not UTF-8 and is almost certainly windows-1252.
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    return new TextDecoder('windows-1252').decode(data);
  }
}

/** Path from the root of the scheme to a unit, for the breadcrumbs. */
/**
 * Returns the place corresponding to a name, creating it if needed.
 *
 * Matching is by normalised key, not literal text: that way 'Ayora' and 'AYORA'
 * are the same place from the outset, without forcing a merge later. A new
 * spelling of an already known place is stored as a variant.
 */
function ensurePlace(db: DB, name: string): number {
  const limpio = name.trim();
  const clave = matchKey(limpio);

  const existente = db
    .prepare(
      `SELECT id, name FROM place WHERE match_key = ?
       UNION SELECT l.id, l.name FROM place l
         JOIN place_variant vl ON vl.place_id = l.id WHERE vl.spelling = ?
       LIMIT 1`,
    )
    .get(clave, limpio) as { id: number; name: string } | undefined;

  if (existente) {
    if (existente.name !== limpio) {
      db.prepare('INSERT OR IGNORE INTO place_variant (place_id, spelling) VALUES (?, ?)').run(
        existente.id,
        limpio,
      );
    }
    return existente.id;
  }

  const res = db
    .prepare('INSERT INTO place (name, match_key) VALUES (?, ?)')
    .run(limpio, clave);
  return Number(res.lastInsertRowid);
}

/** A document pending matching, with the candidates for each person. */
interface MatchRow {
  document: number;
  file: string;
  thumbnail: string | null;
  extension: string | null;
  unit_title: string | null;
  record_type: string | null;
  year: number;
  role: string;
  couple: boolean;
  people: Array<{ name: string; candidates: Candidate[] }>;
}

/**
 * An identification beyond possible doubt: every person named in the document
 * has a certain candidate. This is the only thing that can be linked in bulk
 * without anyone looking at it.
 */
function isFullyCertain(s: MatchRow): boolean {
  return s.people.every((p) => p.candidates[0]?.certainty === 'certain');
}

/**
 * Matches against the tree everything that is described and not yet linked.
 *
 * It walks the whole archive, not one batch: both the queue and the bulk
 * acceptance need the same list, and splitting it would mean the 'accept the
 * certain ones' button acted only on what fitted on screen.
 */
function matchPending(db: DB, idx: MatchIndex): MatchRow[] {
  const rows = db
    .prepare(
      `SELECT d.id, d.name AS file, d.thumbnail, d.extension,
              COALESCE(de.record_type, p.record_type) AS record_type,
              p.name AS name_1, p.name_2,
              COALESCE(CAST(substr(de.date, 1, 4) AS INTEGER), p.year) AS year,
              u.title AS unit_title
       FROM document d
       JOIN suggestion p ON p.document_id = d.id
       LEFT JOIN description de ON de.document_id = d.id
       LEFT JOIN unit u ON u.id = d.unit_id
       WHERE d.present = 1
         AND p.status = 'accepted'
         AND NOT EXISTS (
           SELECT 1 FROM entry a JOIN link v ON v.entry_id = a.id
           WHERE a.document_id = d.id
         )
       ORDER BY p.year, d.id`,
    )
    .all() as Array<{
    id: number;
    file: string;
    thumbnail: string | null;
    extension: string | null;
    record_type: string | null;
    name_1: string | null;
    name_2: string | null;
    year: number | null;
    unit_title: string | null;
  }>;

  const out: MatchRow[] = [];

  for (const f of rows) {
    if (!f.year || !f.name_1) continue;

    const { first, second, event } = idx.forCouple(f.name_1, f.name_2, f.year, f.record_type);
    if (first.length === 0 && second.length === 0) continue;

    out.push({
      document: f.id,
      file: f.file,
      thumbnail: f.thumbnail,
      extension: f.extension,
      unit_title: f.unit_title,
      record_type: f.record_type,
      year: f.year,
      role: suggestedRole(f.record_type),
      couple: event !== null,
      people: [
        { name: f.name_1, candidates: first },
        ...(f.name_2 ? [{ name: f.name_2, candidates: second }] : []),
      ],
    });
  }

  return out;
}

/**
 * Records that a person appears in a document.
 *
 * Creates the entry if the document had none marked: in that case the whole
 * document is understood to be the entry. Returns whether it was saved.
 */
function linkPerson(
  db: DB,
  document: number,
  grampsId: string,
  name: string,
  role?: string,
  certainty?: string,
): boolean {
  const doc = db
    .prepare(
      `SELECT COALESCE(de.record_type, p.record_type) AS record_type,
              COALESCE(de.date, CAST(p.year AS TEXT)) AS date
       FROM document d
       LEFT JOIN suggestion p ON p.document_id = d.id
       LEFT JOIN description de ON de.document_id = d.id
       WHERE d.id = ?`,
    )
    .get(document) as { record_type: string | null; date: string | null } | undefined;
  if (!doc) return false;

  let entry = db
    .prepare('SELECT id FROM entry WHERE document_id = ? ORDER BY id LIMIT 1')
    .get(document) as { id: number } | undefined;
  if (!entry) {
    const res = db
      .prepare('INSERT INTO entry (document_id, record_type, date) VALUES (?, ?, ?)')
      .run(document, doc.record_type, doc.date);
    entry = { id: Number(res.lastInsertRowid) };
  }

  const personId = ensurePerson(db, name, grampsId);
  db.prepare(
    `INSERT INTO link (person_id, entry_id, role, certainty) VALUES (?, ?, ?, ?)
     ON CONFLICT(person_id, entry_id, role) DO UPDATE SET certainty = excluded.certainty`,
  ).run(personId, entry.id, role ?? 'otro', certainty ?? 'probable');
  return true;
}

/**
 * Returns the person corresponding to a name, creating them if needed.
 *
 * Where there is a Gramps identifier it takes precedence: it is the same
 * person even if the document calls them something else, and the document's
 * spelling is stored as a variant. Without an identifier, matching is by
 * normalised name, which is all that can be asserted about a godparent who
 * appears only once.
 */
function ensurePerson(db: DB, name: string, grampsId: string | null): number {
  const limpio = name.trim();
  const clave = matchKey(limpio);

  if (grampsId) {
    db.prepare(
      `INSERT INTO person (gramps_id, name, match_key) VALUES (?, ?, ?)
       ON CONFLICT(gramps_id) DO UPDATE SET name = excluded.name`,
    ).run(grampsId, limpio, clave);
    // The rowid of the statement is useless: when the ON CONFLICT updates
    // instead of inserting, it carries over the one from the connection's
    // last insert, which may belong to another table.
    return (db.prepare('SELECT id FROM person WHERE gramps_id = ?').get(grampsId) as { id: number })
      .id;
  }

  // With no Gramps identifier, only someone who also lacks one is reused:
  // treating a name match against someone in the tree as good would assert
  // an identity nobody has verified.
  const existente = db
    .prepare('SELECT id FROM person WHERE match_key = ? AND gramps_id IS NULL LIMIT 1')
    .get(clave) as { id: number } | undefined;
  if (existente) {
    db.prepare('INSERT OR IGNORE INTO name_variant (person_id, spelling) VALUES (?, ?)').run(
      existente.id,
      limpio,
    );
    return existente.id;
  }

  const res = db
    .prepare('INSERT INTO person (name, match_key) VALUES (?, ?)')
    .run(limpio, clave);
  return Number(res.lastInsertRowid);
}

function unitPath(db: DB, id: number): Array<{ id: number; title: string; level: string }> {
  const path_to_root: Array<{ id: number; title: string; level: string }> = [];
  let actual: number | null = id;
  const vistos = new Set<number>();

  while (actual !== null && !vistos.has(actual)) {
    vistos.add(actual);
    const u = db.prepare('SELECT id, parent_id, title, level FROM unit WHERE id = ?').get(actual) as
      | { id: number; parent_id: number | null; title: string; level: string }
      | undefined;
    if (!u) break;
    path_to_root.unshift({ id: u.id, title: u.title, level: u.level });
    actual = u.parent_id;
  }

  return path_to_root;
}
