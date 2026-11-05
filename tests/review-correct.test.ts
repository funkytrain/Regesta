import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Fastify from 'fastify';
import { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { registerApi } from '../src/server/api.ts';

/**
 * Correcting a record by hand settles it: what the user writes overrides
 * what the indexer deduced from the file name. Without this the suggestion
 * stayed 'pending' and the document kept reappearing in the queue, under the
 * old name, however many times it had been corrected.
 */

let app: FastifyInstance;
let bd: DatabaseSync;
let doc: number;

const statusOf = (id: number) =>
  (bd.prepare('SELECT status FROM suggestion WHERE document_id = ?').get(id) as { status: string })
    .status;

before(async () => {
  bd = new DatabaseSync(':memory:');
  bd.exec(readFileSync(join(process.cwd(), 'src/server/schema.sql'), 'utf8'));

  app = Fastify({ logger: false });
  registerApi(app, { db: bd, thumbnailDir: '/tmp/no-usado', gramps: null });
  await app.ready();
});

after(async () => {
  await app.close();
  bd.close();
});

/** Documento nuevo con su suggestion pending, como lo deja el indexador. */
function withSuggestion(name: string, person: string): number {
  const id = Number(
    bd
      .prepare('INSERT INTO document (path, name, bytes, hash, present) VALUES (?, ?, ?, ?, 1)')
      .run(`folder/${name}`, name, 100, `h-${name}`).lastInsertRowid,
  );
  bd.prepare(
    "INSERT INTO suggestion (document_id, record_type, name, year, confidence, status) VALUES (?, 'marriage', ?, 1802, 0.8, 'pending')",
  ).run(id, person);
  return id;
}

const save = (id: number, body: unknown) =>
  app.inject({ method: 'PUT', url: `/api/description/${id}`, payload: body as any });

describe('correcting a record takes it out of the review', () => {
  test('describir las people resuelve la suggestion', async () => {
    doc = withSuggestion('boda.jpg', 'DUDA CASTILLO NUÑEZ');
    assert.equal(statusOf(doc), 'pending');

    const r = await save(doc, { people: 'CASTILLO NUÑEZ' });
    assert.equal(r.statusCode, 200);
    assert.equal(statusOf(doc), 'accepted');
  });

  test('the corrected record no longer appears in the queue', async () => {
    const id = withSuggestion('otra-boda.jpg', 'DUDA PEREZ');
    const enCola = async () => {
      const r = await app.inject({ method: 'GET', url: '/api/review/queue?limit=50' });
      return (JSON.parse(r.body).results as Array<{ id: number }>).some((d) => d.id === id);
    };

    assert.equal(await enCola(), true);
    await save(id, { people: 'PEREZ' });
    assert.equal(await enCola(), false);
  });

  test('describing the record type or the date settles it too', async () => {
    const porActo = withSuggestion('record.jpg', 'ALGUIEN');
    await save(porActo, { record_type: 'baptism' });
    assert.equal(statusOf(porActo), 'accepted');

    const porFecha = withSuggestion('date.jpg', 'ALGUIEN');
    await save(porFecha, { date: '1802-05-14' });
    assert.equal(statusOf(porFecha), 'accepted');
  });

  test('writing only in fields the review does not decide leaves it pending', async () => {
    const id = withSuggestion('notes.jpg', 'ALGUIEN');
    await save(id, { notes: 'tinta desvaída', folio: '45v' });
    assert.equal(
      statusOf(id),
      'pending',
      'noting the folio is not reviewing: the record is still undecided',
    );
  });

  test('a record described earlier is closed when the queue opens', async () => {
    // The real case: it was corrected before the application recorded the
    // change, and the suggestion stayed pending for ever.
    const id = withSuggestion('vieja.jpg', 'DUDA CASTILLO NUÑEZ');
    bd.prepare(
      "INSERT INTO description (document_id, people) VALUES (?, 'CASTILLO NUÑEZ')",
    ).run(id);
    assert.equal(statusOf(id), 'pending');

    await app.inject({ method: 'GET', url: '/api/review/queue?limit=50' });
    assert.equal(statusOf(id), 'accepted');
  });

  test('a partial description does not settle the record, but does show in the queue', async () => {
    // Noting the folio is not reviewing: the record stays pending. What must
    // not happen is that it shows the old name once something was
    // corrected.
    const id = withSuggestion('parcial.jpg', 'DUDA GARCIA LOPEZ');
    await save(id, { folio: '45v' });
    assert.equal(statusOf(id), 'pending');

    const r = await app.inject({ method: 'GET', url: '/api/review/queue?limit=50' });
    const row = (JSON.parse(r.body).results as any[]).find((d) => d.id === id);
    assert.ok(row, 'the record must still be in the queue');
    assert.equal(row.person, 'DUDA GARCIA LOPEZ', 'with people uncorrected, what was read is shown');
  });

  test('it does not revive an already dismissed suggestion', async () => {
    const id = withSuggestion('no-es-record.jpg', 'ALGUIEN');
    await app.inject({
      method: 'POST',
      url: '/api/review/dismiss',
      payload: { documents: [id] },
    });
    assert.equal(statusOf(id), 'rejected');

    await save(id, { people: 'OTRO NOMBRE' });
    assert.equal(statusOf(id), 'rejected', 'describir no debe deshacer un descarte');
  });
});
