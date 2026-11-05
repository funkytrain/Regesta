/**
 * Open export of the cataloguing work.
 *
 * Reason for existing: if in ten years this application no longer starts, the
 * description made by hand -- the only irreplaceable part, because the
 * documents themselves are still on disk -- must still be readable. That is
 * why it is dumped to CSV and plain text, not to a format of our own.
 *
 * The CSV uses a semicolon separator and a byte order mark, which is what
 * Excel expects in locales where the comma is the decimal separator; with a
 * comma it would open everything in a single column. On an English locale
 * this is the safe choice too, since Excel honours the separator either way.
 */

import type { DB } from './db.js';

/** Escapes a value for CSV: doubled quotes, and quoted when needed. */
function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers.join(';'), ...rows.map((r) => r.map(cell).join(';'))];
  // The byte order mark makes Excel recognise the UTF-8 and not mangle
  // accented letters in names.
  return `﻿${lines.join('\r\n')}\r\n`;
}

/**
 * Documents with their description: the main dump.
 *
 * One row per document, with everything known about it. This is the file
 * someone would open first to understand what the archive holds.
 */
export function documentsCsv(db: DB): string {
  const rows = db
    .prepare(
      `SELECT d.id, d.path, d.name, d.extension, d.bytes, d.hash,
              COALESCE(des.record_type, s.record_type) AS record_type,
              COALESCE(des.people, s.name) AS people,
              COALESCE(des.date, CAST(s.year AS TEXT)) AS date,
              des.place, des.folio, des.abstract, des.transcription, des.notes,
              des.creator, des.reference_code, des.medium, des.condition,
              des.gramps_id,
              pr.name AS provenance,
              pr.source_archive, pr.consulted_on, pr.acquisition, pr.url,
              u.title AS folder,
              des.document_id IS NOT NULL AS described,
              (SELECT GROUP_CONCAT(t.name, ' | ')
                 FROM document_tag dt JOIN tag t ON t.id = dt.tag_id
                WHERE dt.document_id = d.id) AS tags,
              d.present
       FROM document d
       LEFT JOIN description des ON des.document_id = d.id
       LEFT JOIN suggestion s ON s.document_id = d.id
       LEFT JOIN provenance pr ON pr.id = des.provenance_id
       LEFT JOIN unit u ON u.id = d.unit_id
       ORDER BY d.path`,
    )
    .all() as Array<Record<string, unknown>>;

  const columns = [
    'id', 'path', 'name', 'extension', 'bytes', 'hash',
    'record_type', 'people', 'date', 'place', 'folio',
    'abstract', 'transcription', 'notes',
    'creator', 'reference_code', 'medium', 'condition',
    'gramps_id', 'provenance', 'source_archive', 'consulted_on', 'acquisition', 'url',
    'folder', 'described', 'tags', 'present',
  ];

  return toCsv(
    [
      'Id', 'Path', 'File', 'Extension', 'Bytes', 'Fingerprint',
      'Record type', 'People', 'Date', 'Place', 'Folio',
      'Abstract', 'Transcription', 'Notes',
      'Creator', 'Original reference', 'Medium', 'Condition',
      'Gramps id', 'Provenance', 'Source archive', 'Consulted on',
      'Acquisition', 'URL', 'Folder', 'Described', 'Tags', 'Present on disk',
    ],
    rows.map((r) => columns.map((c) => r[c])),
  );
}

/** Entries marked within the folios, with their crop. */
export function entriesCsv(db: DB): string {
  const rows = db
    .prepare(
      `SELECT e.id, d.path, d.name, e.record_type, e.folio, e.date,
              pl.name AS place,
              e.abstract, e.transcription, e.notes,
              e.crop_x, e.crop_y, e.crop_w, e.crop_h, e.crop_page
       FROM entry e
       JOIN document d ON d.id = e.document_id
       LEFT JOIN place pl ON pl.id = e.place_id
       ORDER BY d.path, e.crop_y`,
    )
    .all() as Array<Record<string, unknown>>;

  const columns = [
    'id', 'path', 'name', 'record_type', 'folio', 'date', 'place',
    'abstract', 'transcription', 'notes',
    'crop_x', 'crop_y', 'crop_w', 'crop_h', 'crop_page',
  ];

  return toCsv(
    [
      'Id', 'Document path', 'File', 'Record type', 'Folio', 'Date', 'Place',
      'Abstract', 'Transcription', 'Notes',
      'Crop X', 'Crop Y', 'Crop width', 'Crop height', 'Page',
    ],
    rows.map((r) => columns.map((c) => r[c])),
  );
}

/**
 * Who appears in each entry, in what role and with what certainty.
 *
 * This is the table that makes the archive cross-referenceable: it lets you
 * ask, in any spreadsheet, in how many baptisms the same person stood as
 * godparent.
 */
export function linksCsv(db: DB): string {
  const rows = db
    .prepare(
      `SELECT l.id, p.name AS person, p.gramps_id, l.role, l.certainty, l.notes,
              e.id AS entry_id, e.record_type, e.date, e.folio,
              pl.name AS place, d.path, d.name AS file
       FROM link l
       JOIN person p ON p.id = l.person_id
       JOIN entry e ON e.id = l.entry_id
       JOIN document d ON d.id = e.document_id
       LEFT JOIN place pl ON pl.id = e.place_id
       ORDER BY p.name, e.date`,
    )
    .all() as Array<Record<string, unknown>>;

  const columns = [
    'id', 'person', 'gramps_id', 'role', 'certainty', 'notes',
    'entry_id', 'record_type', 'date', 'folio', 'place', 'path', 'file',
  ];

  return toCsv(
    [
      'Id', 'Person', 'Gramps id', 'Role', 'Certainty', 'Notes',
      'Entry id', 'Record type', 'Date', 'Folio', 'Place',
      'Document path', 'File',
    ],
    rows.map((r) => columns.map((c) => r[c])),
  );
}

/** Normalised places, with their alternative spellings and their use. */
export function placesCsv(db: DB): string {
  const rows = db
    .prepare(
      `SELECT pl.id, pl.name, pl.type, pl.municipality, pl.province, pl.country, pl.notes,
              (SELECT COUNT(*) FROM entry e WHERE e.place_id = pl.id) AS uses,
              (SELECT GROUP_CONCAT(pv.spelling, ' · ') FROM place_variant pv
                WHERE pv.place_id = pl.id) AS variants
       FROM place pl ORDER BY pl.name`,
    )
    .all() as Array<Record<string, unknown>>;

  const columns = [
    'id', 'name', 'type', 'municipality', 'province', 'country', 'uses', 'variants', 'notes',
  ];

  return toCsv(
    [
      'Id', 'Name', 'Type', 'Municipality', 'Province', 'Country',
      'Entries', 'Other spellings', 'Notes',
    ],
    rows.map((r) => columns.map((c) => r[c])),
  );
}

/** Tags and the documents they are applied to. */
export function tagsCsv(db: DB): string {
  const rows = db
    .prepare(
      `SELECT t.name, d.path, d.name AS file, dt.tagged_at
       FROM document_tag dt
       JOIN tag t ON t.id = dt.tag_id
       JOIN document d ON d.id = dt.document_id
       ORDER BY t.name, d.path`,
    )
    .all() as Array<Record<string, unknown>>;

  return toCsv(
    ['Tag', 'Path', 'File', 'Tagged on'],
    rows.map((r) => [r.name, r.path, r.file, r.tagged_at]),
  );
}

/** Recorded provenances. */
export function provenancesCsv(db: DB): string {
  const rows = db
    .prepare(
      `SELECT name, source_archive, original_reference, consulted_on,
              acquisition, url, notes
       FROM provenance ORDER BY name`,
    )
    .all() as Array<Record<string, unknown>>;

  const columns = ['name', 'source_archive', 'original_reference', 'consulted_on', 'acquisition', 'url', 'notes'];

  return toCsv(
    ['Name', 'Source archive', 'Original reference', 'Consulted on', 'Acquisition', 'URL', 'Notes'],
    rows.map((r) => columns.map((c) => r[c])),
  );
}

/** Classification scheme, with the full path of each node. */
export function classificationCsv(db: DB): string {
  const nodes = db
    .prepare(
      `SELECT id, parent_id, level, title, reference_code, start_date, end_date,
              extent, creator, scope_content, notes,
              (SELECT COUNT(*) FROM document d WHERE d.unit_id = unit.id) AS documents
       FROM unit ORDER BY id`,
    )
    .all() as Array<Record<string, unknown> & { id: number; parent_id: number | null; title: string }>;

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const pathOf = (n: (typeof nodes)[number]): string => {
    const parts: string[] = [];
    let current: (typeof nodes)[number] | undefined = n;
    const seen = new Set<number>();
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      parts.unshift(current.title);
      current = current.parent_id ? byId.get(current.parent_id) : undefined;
    }
    return parts.join(' > ');
  };

  return toCsv(
    [
      'Id', 'Level', 'Title', 'Reference code', 'Start date', 'End date',
      'Extent', 'Creator', 'Scope and content', 'Notes',
      'Documents', 'Full path',
    ],
    nodes.map((n) => [
      n.id, n.level, n.title, n.reference_code, n.start_date, n.end_date,
      n.extent, n.creator, n.scope_content, n.notes, n.documents, pathOf(n),
    ]),
  );
}

/**
 * One document as plain text, readable with nothing at all.
 *
 * It complements the CSV: a long transcription fits badly in a cell, and this
 * format can be read with anything, today and in twenty years.
 */
export function documentText(db: DB, id: number): string | null {
  const d = db
    .prepare(
      `SELECT d.path, d.name, d.extension, d.bytes,
              des.*, pr.name AS provenance, u.title AS folder,
              COALESCE(des.record_type, s.record_type) AS record,
              COALESCE(des.people, s.name) AS who
       FROM document d
       LEFT JOIN description des ON des.document_id = d.id
       LEFT JOIN suggestion s ON s.document_id = d.id
       LEFT JOIN provenance pr ON pr.id = des.provenance_id
       LEFT JOIN unit u ON u.id = d.unit_id
       WHERE d.id = ?`,
    )
    .get(id) as Record<string, unknown> | undefined;
  if (!d) return null;

  const tags = (
    db
      .prepare(
        `SELECT t.name FROM document_tag dt
         JOIN tag t ON t.id = dt.tag_id WHERE dt.document_id = ?`,
      )
      .all(id) as Array<{ name: string }>
  ).map((t) => t.name);

  const entries = db
    .prepare(
      `SELECT e.id, e.record_type, e.folio, e.date, e.abstract, e.transcription, e.notes,
              pl.name AS place
       FROM entry e LEFT JOIN place pl ON pl.id = e.place_id
       WHERE e.document_id = ?`,
    )
    .all(id) as Array<Record<string, unknown>>;

  const peopleOfEntry = db.prepare(
    `SELECT p.name, p.gramps_id, l.role, l.certainty
     FROM link l JOIN person p ON p.id = l.person_id
     WHERE l.entry_id = ? ORDER BY l.id`,
  );

  const line = (label: string, value: unknown): string =>
    value ? `${label.padEnd(22)}${value}\n` : '';

  let t = '';
  t += `${d.name}\n${'='.repeat(String(d.name).length)}\n\n`;
  t += line('Path:', d.path);
  t += line('Folder:', d.folder);
  t += '\n';
  t += line('Record type:', d.record);
  t += line('People:', d.who);
  t += line('Date:', d.date);
  t += line('Place:', d.place);
  t += line('Folio:', d.folio);
  t += '\n';
  t += line('Creator:', d.creator);
  t += line('Original reference:', d.reference_code);
  t += line('Medium:', d.medium);
  t += line('Condition:', d.condition);
  t += line('Provenance:', d.provenance);
  t += line('Gramps id:', d.gramps_id);
  if (tags.length) t += line('Tags:', tags.join(', '));

  if (d.abstract) t += `\nABSTRACT\n${'-'.repeat(8)}\n${d.abstract}\n`;
  if (d.transcription) t += `\nTRANSCRIPTION\n${'-'.repeat(13)}\n${d.transcription}\n`;
  if (d.notes) t += `\nNOTES\n${'-'.repeat(5)}\n${d.notes}\n`;

  for (const [i, e] of entries.entries()) {
    t += `\nENTRY ${i + 1}\n${'-'.repeat(7)}\n`;
    t += line('Record:', e.record_type);
    t += line('Folio:', e.folio);
    t += line('Date:', e.date);
    t += line('Place:', e.place);

    const who = peopleOfEntry.all(Number(e.id)) as Array<Record<string, unknown>>;
    for (const w of who) {
      // The certainty is stated only when it is not certain: writing it on
      // every line would make it invisible exactly where it matters.
      const nuance = w.certainty === 'certain' ? '' : ` (${w.certainty})`;
      const ref = w.gramps_id ? ` [${w.gramps_id}]` : '';
      t += line(`${String(w.role)}:`, `${w.name}${ref}${nuance}`);
    }

    if (e.abstract) t += `${e.abstract}\n`;
    if (e.transcription) t += `\n${e.transcription}\n`;
    if (e.notes) t += `\n${e.notes}\n`;
  }

  return t;
}

/** Documents with something described by hand, for the plain-text dump. */
export function describedIds(db: DB): number[] {
  return (
    db
      .prepare(
        `SELECT DISTINCT d.id FROM document d
         LEFT JOIN description des ON des.document_id = d.id
         LEFT JOIN entry e ON e.document_id = d.id
         LEFT JOIN document_tag dt ON dt.document_id = d.id
         WHERE des.document_id IS NOT NULL OR e.id IS NOT NULL OR dt.document_id IS NOT NULL
         ORDER BY d.path`,
      )
      .all() as Array<{ id: number }>
  ).map((r) => r.id);
}

/** Safe file name derived from a path inside the archive. */
export function safeFileName(path: string): string {
  return path
    .replace(/[\\/]/g, '__')
    .replace(/[<>:"|?* -]/g, '_')
    .slice(0, 180);
}
