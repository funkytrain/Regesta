import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Fastify from 'fastify';
import { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { registerApi } from '../src/server/api.ts';

/**
 * The editable classification scheme, and entries with their people and
 * places.
 *
 * Tested against the real API rather than against bare SQL, because what
 * needs protecting are the rules: that deleting a series does not delete
 * documents, that a unit cannot hang off itself, and that two spellings of
 * one name end up as a single record. All of those live in the routes, not
 * in the schema.
 */

let app: FastifyInstance;
let bd: DatabaseSync;

/** Documentos de trabajo, creados a mano para no depender de un archivo real. */
let doc1: number;
let doc2: number;

before(async () => {
  bd = new DatabaseSync(':memory:');
  bd.exec(readFileSync(join(process.cwd(), 'src/server/schema.sql'), 'utf8'));

  const insert = bd.prepare(
    'INSERT INTO document (path, name, bytes, hash, present) VALUES (?, ?, ?, ?, 1)',
  );
  doc1 = Number(insert.run('folder/folio-1.jpg', 'folio-1.jpg', 100, 'h1').lastInsertRowid);
  doc2 = Number(insert.run('folder/folio-2.jpg', 'folio-2.jpg', 200, 'h2').lastInsertRowid);

  app = Fastify({ logger: false });
  registerApi(app, { db: bd, thumbnailDir: '/tmp/no-usado', gramps: null });
  await app.ready();
});

after(async () => {
  await app.close();
  bd.close();
});

/** Shorthand: calls the API and returns the status and the parsed body. */
async function call(
  method: string,
  url: string,
  body?: unknown,
): Promise<{ code: number; data: any }> {
  const r = await app.inject({ method: method as any, url, payload: body as any });
  return { code: r.statusCode, data: r.body ? JSON.parse(r.body) : null };
}

describe('the editable classification scheme', () => {
  let fonds: number;
  let series: number;

  test('a fonds is created, with a series inside it', async () => {
    const a = await call('POST', '/api/unit', { title: 'Archivo Parroquial', level: 'fonds' });
    assert.equal(a.code, 200);
    fonds = a.data.id;

    const b = await call('POST', '/api/unit', {
      title: 'Bautismos',
      level: 'series',
      parent_id: fonds,
    });
    assert.equal(b.code, 200);
    assert.equal(b.data.parent_id, fonds);
    series = b.data.id;
  });

  test('a unit with no title is rejected', async () => {
    const r = await call('POST', '/api/unit', { title: '   ', level: 'series' });
    assert.equal(r.code, 400);
  });

  test('an invented level is rejected', async () => {
    const r = await call('POST', '/api/unit', { title: 'X', level: 'folder' });
    assert.equal(r.code, 400);
  });

  test('the ISAD(G) fields can be edited', async () => {
    const r = await call('PUT', `/api/unit/${series}`, {
      start_date: '1552',
      end_date: '1899',
      creator: 'Parroquia de San Roque',
    });
    assert.equal(r.code, 200);
    assert.equal(r.data.start_date, '1552');
    assert.equal(r.data.creator, 'Parroquia de San Roque');
  });

  test('a unit cannot hang off itself', async () => {
    const r = await call('PUT', `/api/unit/${fonds}`, { parent_id: fonds });
    assert.equal(r.code, 400);
  });

  test('a unit cannot hang off its own descendants', async () => {
    // Without this check the fonds and its series would end up in a loop,
    // invisible in the scheme and unrecoverable from the interface.
    const r = await call('PUT', `/api/unit/${fonds}`, { parent_id: series });
    assert.equal(r.code, 400);

    const cuadro = await call('GET', '/api/classification');
    const f = cuadro.data.find((n: any) => n.id === fonds);
    assert.equal(f.parent_id, null, 'the fonds is still at the root');
  });

  test('documents are filed into a unit', async () => {
    const r = await call('POST', '/api/classification/assign', {
      documents: [doc1, doc2],
      unit: series,
    });
    assert.equal(r.data.classified, 2);

    const docs = await call('GET', `/api/unit/${series}/documents`);
    assert.equal(docs.data.length, 2);
  });

  test('borrar una unit no borra sus documents: suben al padre', async () => {
    const r = await call('DELETE', `/api/unit/${series}`);
    assert.equal(r.code, 200);
    assert.equal(r.data.documents_relocated, 2);

    // What matters is not the message but that the documents are still there.
    const quedan = bd
      .prepare('SELECT COUNT(*) AS n FROM document WHERE present = 1')
      .get() as { n: number };
    assert.equal(quedan.n, 2, 'no document has been lost');

    const docs = await call('GET', `/api/unit/${fonds}/documents`);
    assert.equal(docs.data.length, 2, 'han subido al fonds');
  });
});

describe('people vinculadas a una record', () => {
  let entry: number;

  before(async () => {
    const r = await call('POST', `/api/entries/${doc1}`, {
      record_type: 'baptism',
      crop: { x: 0.1, y: 0.2, w: 0.5, h: 0.3 },
    });
    entry = r.data.id;
  });

  test('someone who is not in Gramps can still be linked', async () => {
    const r = await call('POST', `/api/entry/${entry}/people`, {
      name: 'Ysabel Ximenez',
      role: 'godmother',
      certainty: 'uncertain',
    });
    assert.equal(r.code, 200);
    assert.equal(r.data.name, 'Ysabel Ximenez');
    assert.equal(r.data.certainty, 'uncertain');
    assert.equal(r.data.gramps_id, null);
  });

  test('two spellings of one name are a single person', async () => {
    // 'Isabel Jimenez' and 'Ysabel Ximenez' are the same woman written by two
    // different clerks. If the match key does not join them, the archive ends
    // up with one record per spelling and nobody can follow her.
    const r = await call('POST', `/api/entry/${entry}/people`, {
      name: 'Isabel Jimenez',
      role: 'madre',
    });
    assert.equal(r.code, 200);

    const people = bd.prepare('SELECT COUNT(*) AS n FROM person').get() as { n: number };
    assert.equal(people.n, 1, 'a single person record');

    // And the merge is announced: seeing a name on screen that was never
    // typed, with no explanation, looks like a bug.
    assert.equal(r.data.matched_from, 'Isabel Jimenez');
  });

  test('the spelling used by the document is kept as a variant', async () => {
    const v = bd
      .prepare('SELECT spelling FROM name_variant ORDER BY spelling')
      .all() as Array<{ spelling: string }>;
    assert.deepEqual(v.map((x) => x.spelling), ['Isabel Jimenez']);
  });

  test('the same role twice updates rather than duplicating', async () => {
    const r = await call('POST', `/api/entry/${entry}/people`, {
      name: 'Ysabel Ximenez',
      role: 'godmother',
      certainty: 'probable',
    });
    assert.equal(r.data.certainty, 'probable');

    const n = bd
      .prepare("SELECT COUNT(*) AS n FROM link WHERE role = 'godmother'")
      .get() as { n: number };
    assert.equal(n.n, 1);
  });

  test('a certainty that does not exist is rejected', async () => {
    const r = await call('POST', `/api/entry/${entry}/people`, {
      name: 'X',
      role: 'witness',
      certainty: 'quiza',
    });
    assert.equal(r.code, 400);
  });

  test('nothing is saved without a role', async () => {
    const r = await call('POST', `/api/entry/${entry}/people`, { name: 'X', role: '' });
    assert.equal(r.code, 400);
  });

  test('vincular a una record que no existe da 404', async () => {
    const r = await call('POST', '/api/entry/99999/people', {
      name: 'X',
      role: 'witness',
    });
    assert.equal(r.code, 404);
  });

  test('the entry reads back with the people who appear in it', async () => {
    const r = await call('GET', `/api/entries/${doc1}`);
    const a = r.data.find((x: any) => x.id === entry);
    assert.equal(a.people.length, 2);
    assert.ok(a.people.every((v: any) => v.name === 'Ysabel Ximenez'));
  });

  test('removing a link does not delete the person', async () => {
    const r = await call('GET', `/api/entries/${doc1}`);
    const id = r.data.find((x: any) => x.id === entry).people[0].id;

    await call('DELETE', `/api/link/${id}`);
    const people = bd.prepare('SELECT COUNT(*) AS n FROM person').get() as { n: number };
    assert.equal(people.n, 1, 'the person is still in the archive');
  });
});

describe('places normalizados', () => {
  let entry: number;

  before(async () => {
    const r = await call('POST', `/api/entries/${doc2}`, {
      crop: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
    });
    entry = r.data.id;
  });

  test('a place typed by hand is recorded', async () => {
    const r = await call('PUT', `/api/entry/${entry}`, { place: 'Ayora' });
    assert.equal(r.code, 200);
    assert.equal(r.data.place_name, 'Ayora');
    assert.ok(r.data.place_id);
  });

  test('the same spelling in capitals does not create a new place', async () => {
    const r = await call('PUT', `/api/entry/${entry}`, { place: 'AYORA' });
    assert.equal(r.data.place_name, 'Ayora');

    const n = bd.prepare('SELECT COUNT(*) AS n FROM place').get() as { n: number };
    assert.equal(n.n, 1);
  });

  test('two different places merge and the spelling is kept', async () => {
    const other = await call('POST', `/api/entries/${doc1}`, {
      crop: { x: 0.5, y: 0.5, w: 0.2, h: 0.2 },
    });
    await call('PUT', `/api/entry/${other.data.id}`, { place: 'Villa de Ayora' });

    const places = await call('GET', '/api/places');
    const from = places.data.find((l: any) => l.name === 'Villa de Ayora').id;
    const into = places.data.find((l: any) => l.name === 'Ayora').id;

    const r = await call('POST', '/api/places/merge', { from, into });
    assert.equal(r.data.entries_moved, 1);

    // The absorbed spelling is not lost: it still finds the place.
    const found = await call('GET', '/api/places?q=Villa%20de%20Ayora');
    assert.equal(found.data.length, 1);
    assert.equal(found.data[0].name, 'Ayora');
  });

  test('a place in use cannot simply be deleted', async () => {
    const places = await call('GET', '/api/places');
    const r = await call('DELETE', `/api/place/${places.data[0].id}`);
    assert.equal(r.code, 409);
  });

  test('clearing an entry place leaves it with none', async () => {
    const r = await call('PUT', `/api/entry/${entry}`, { place: '' });
    assert.equal(r.data.place_id, null);
  });
});
