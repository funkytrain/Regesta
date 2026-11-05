import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Fastify from 'fastify';
import { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { registerApi } from '../src/server/api.ts';
import type { GrampsReader } from '../src/server/gramps.ts';

/**
 * The match queue and accepting from it.
 *
 * What needs protecting here is not the matching itself -- that lives in
 * matching.ts and has its own tests -- but the rules of the API: that
 * accepting creates the entry that was missing, that what is already linked
 * is not offered again, and that an unreviewed record never enters the
 * queue.
 */

let app: FastifyInstance;
let bd: DatabaseSync;

/** Fake tree with two baptised people and one marriage. */
const gramps = {
  open: () => true,
  eventsWithPerson: () => [
    { event_id: 'E1', type: 'Bautismo', type_code: 15, date: '1681', year: 1681, place: null, person_id: 'I1', person: 'Abelardo Martinez Molto', citations: 0 },
    { event_id: 'E2', type: 'Bautismo', type_code: 15, date: '1750', year: 1750, place: null, person_id: 'I2', person: 'Adela Serrano Sanchez', citations: 0 },
    { event_id: 'E3', type: 'Matrimonio', type_code: 1, date: '1894', year: 1894, place: null, person_id: 'I3', person: 'Jose Campos Alvarez', citations: 0 },
    { event_id: 'E3', type: 'Matrimonio', type_code: 1, date: '1894', year: 1894, place: null, person_id: 'I4', person: 'Bernardina Rodriguez Piñol', citations: 0 },
  ],
} as unknown as GrampsReader;

before(async () => {
  bd = new DatabaseSync(':memory:');
  bd.exec(readFileSync(join(process.cwd(), 'src/server/schema.sql'), 'utf8'));
  app = Fastify({ logger: false });
  registerApi(app, { db: bd, thumbnailDir: '/tmp/no-usado', gramps });
  await app.ready();
});

after(async () => {
  await app.close();
  bd.close();
});

/** Documento con su ficha ya revisada, que es lo que entra en la queue. */
function document(
  name: string,
  person: string,
  year: number,
  recordType: string,
  opciones: { person2?: string; status?: string } = {},
): number {
  const id = Number(
    bd
      .prepare('INSERT INTO document (path, name, bytes, hash, present) VALUES (?, ?, ?, ?, 1)')
      .run(`c/${name}`, name, 1, `h-${name}`).lastInsertRowid,
  );
  bd.prepare(
    'INSERT INTO suggestion (document_id, record_type, name, name_2, year, confidence, status) VALUES (?, ?, ?, ?, ?, 0.9, ?)',
  ).run(id, recordType, person, opciones.person2 ?? null, year, opciones.status ?? 'accepted');
  return id;
}

const queue = async (query = '') => {
  const r = await app.inject({ method: 'GET', url: `/api/matches/queue${query}` });
  return { code: r.statusCode, data: JSON.parse(r.body) };
};

const aceptar = (links: unknown) =>
  app.inject({ method: 'POST', url: '/api/matches/accept', payload: { links } as any });

const aceptarSeguras = () =>
  app.inject({ method: 'POST', url: '/api/matches/accept-certain' });

describe('queue de matches', () => {
  test('proposes the tree person when the name and the year fit', async () => {
    const id = document('baptism-abelardo.jpg', 'ABELARDO MARTINEZ MOLTO', 1681, 'baptism');
    const { code, data } = await queue();

    assert.equal(code, 200);
    const row = data.results.find((r: any) => r.document === id);
    assert.ok(row, 'the document must be in the queue');
    assert.equal(row.role, 'subject', 'el role se deduce del record');
    assert.equal(row.people[0].candidates[0].gramps_id, 'I1');
    assert.equal(row.people[0].candidates[0].certainty, 'certain');
  });

  test('an unreviewed record does not enter the queue', async () => {
    const id = document('sin-revisar.jpg', 'ADELA SERRANO SANCHEZ', 1750, 'baptism', {
      status: 'pending',
    });
    const { data } = await queue();
    assert.equal(
      data.results.some((r: any) => r.document === id),
      false,
      'matching against an unconfirmed reading would be building on sand',
    );
  });

  test('a name absent from the tree produces no row', async () => {
    const id = document('unknown.jpg', 'NADIE DE ESTE MUNDO', 1700, 'baptism');
    const { data } = await queue();
    assert.equal(data.results.some((r: any) => r.document === id), false);
  });

  test('both spouses are proposed together', async () => {
    const id = document('boda.jpg', 'JOSE CAMPOS ALVAREZ', 1894, 'marriage', {
      person2: 'BERNARDINA RODRIGUEZ PIÑOL',
    });
    const { data } = await queue();
    const row = data.results.find((r: any) => r.document === id);

    assert.equal(row.couple, true, 'ambos llevan al mismo marriage');
    assert.equal(row.people.length, 2);
    assert.equal(row.role, 'spouse');
    assert.ok(row.people.every((p: any) => p.candidates[0].certainty === 'certain'));
  });

  test('the certain-only filter leaves out the doubtful', async () => {
    document('cercano.jpg', 'ADELA SERRANO SANCHEZ', 1752, 'baptism');
    const { data } = await queue('?certainty=certain');
    assert.ok(
      data.results.every((r: any) =>
        r.people.some((p: any) => p.candidates.some((c: any) => c.certainty === 'certain')),
      ),
    );
  });
});

describe('aceptar matches', () => {
  test('creates the missing entry and leaves the link', async () => {
    const id = document('aceptar-1.jpg', 'ABELARDO MARTINEZ MOLTO', 1681, 'baptism');

    const r = await aceptar([
      { document: id, gramps_id: 'I1', name: 'Abelardo Martinez Molto', role: 'subject', certainty: 'certain' },
    ]);
    assert.equal(r.statusCode, 200);
    assert.equal(JSON.parse(r.body).saved, 1);

    const v = bd
      .prepare(
        `SELECT v.role, v.certainty, p.gramps_id, a.document_id, a.record_type
         FROM link v JOIN person p ON p.id = v.person_id
         JOIN entry a ON a.id = v.entry_id
         WHERE a.document_id = ?`,
      )
      .get(id) as any;

    assert.equal(v.gramps_id, 'I1');
    assert.equal(v.role, 'subject');
    assert.equal(v.certainty, 'certain');
    assert.equal(v.record_type, 'baptism', 'la record hereda el record del document');
  });

  test('what is already linked leaves the queue', async () => {
    const id = document('aceptar-2.jpg', 'ABELARDO MARTINEZ MOLTO', 1681, 'baptism');
    assert.ok((await queue()).data.results.some((r: any) => r.document === id));

    await aceptar([{ document: id, gramps_id: 'I1', name: 'Abelardo Martinez Molto', role: 'subject' }]);
    assert.equal(
      (await queue()).data.results.some((r: any) => r.document === id),
      false,
      'already settled: it must not be offered again',
    );
  });

  test('accepting twice does not duplicate the link', async () => {
    const id = document('aceptar-3.jpg', 'ABELARDO MARTINEZ MOLTO', 1681, 'baptism');
    const v = { document: id, gramps_id: 'I1', name: 'Abelardo Martinez Molto', role: 'subject' };

    await aceptar([v]);
    await aceptar([{ ...v, certainty: 'probable' }]);

    const n = bd
      .prepare(
        `SELECT COUNT(*) AS n FROM link v JOIN entry a ON a.id = v.entry_id
         WHERE a.document_id = ?`,
      )
      .get(id) as { n: number };
    assert.equal(n.n, 1);
  });

  test('reuses the entry if the document already had one marked', async () => {
    const id = document('con-record.jpg', 'ABELARDO MARTINEZ MOLTO', 1681, 'baptism');
    const entry = Number(
      bd.prepare("INSERT INTO entry (document_id, record_type) VALUES (?, 'baptism')").run(id)
        .lastInsertRowid,
    );

    await aceptar([{ document: id, gramps_id: 'I1', name: 'Abelardo Martinez Molto', role: 'subject' }]);

    const rows = bd.prepare('SELECT id FROM entry WHERE document_id = ?').all(id);
    assert.equal(rows.length, 1, 'it must not create a parallel entry');
    assert.equal((rows[0] as { id: number }).id, entry);
  });

  test('rechaza un role o una certainty que no existen', async () => {
    const id = document('malo.jpg', 'ABELARDO MARTINEZ MOLTO', 1681, 'baptism');
    const base = { document: id, gramps_id: 'I1', name: 'Abelardo Martinez Molto' };

    assert.equal((await aceptar([{ ...base, role: 'inventado' }])).statusCode, 400);
    assert.equal((await aceptar([{ ...base, certainty: 'certísima' }])).statusCode, 400);
  });

  test('with no links it does nothing', async () => {
    assert.equal((await aceptar([])).statusCode, 400);
  });
});

describe('vincular all las seguras de golpe', () => {
  test('it reaches beyond the batch on screen', async () => {
    // The real bug: the button only acted on the 25 loaded, so it had to be
    // pressed once per batch until the archive ran out.
    const ids = [];
    for (let i = 0; i < 30; i++) {
      ids.push(document(`lote-${i}.jpg`, 'ABELARDO MARTINEZ MOLTO', 1681, 'baptism'));
    }

    const { data } = await queue('?limit=25');
    assert.equal(data.results.length, 25, 'the batch stops at 25');
    assert.ok(data.certain_count >= 30, 'pero el recuento de seguras abarca el archivo entero');

    const r = await aceptarSeguras();
    assert.equal(r.statusCode, 200);
    assert.ok(JSON.parse(r.body).saved >= 30);

    const sinVincular = ids.filter(
      (id) =>
        !bd
          .prepare(
            `SELECT 1 FROM link v JOIN entry a ON a.id = v.entry_id
             WHERE a.document_id = ?`,
          )
          .get(id),
    );
    assert.deepEqual(sinVincular, [], 'none must be left unlinked');
  });

  test('it does not touch anything that admits doubt', async () => {
    const dudoso = document('dudoso.jpg', 'ADELA SERRANO SANCHEZ', 1752, 'baptism');
    await aceptarSeguras();

    const v = bd
      .prepare(
        `SELECT 1 FROM link v JOIN entry a ON a.id = v.entry_id WHERE a.document_id = ?`,
      )
      .get(dudoso);
    assert.equal(v, undefined, 'a probable identification is for the user to decide');
  });
});
