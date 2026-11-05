import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GrampsReader } from '../src/server/gramps.js';

/**
 * Marriages hang off the family, not off the person. A reader walking only
 * `person.event_ref_list` would find none at all, and with them out go the
 * gaps panel and any matching by year.
 */

let dir: string;
let path: string;

/** Minimal tree: two spouses, their marriage and one personal baptism. */
function construir(path: string): void {
  const bd = new DatabaseSync(path);
  bd.exec(`
    CREATE TABLE person (handle TEXT, gramps_id TEXT, given_name TEXT, surname TEXT, json_data TEXT);
    CREATE TABLE family (handle TEXT, gramps_id TEXT, json_data TEXT);
    CREATE TABLE event  (handle TEXT, gramps_id TEXT, json_data TEXT);
  `);

  const event = (type: number, year: number) =>
    JSON.stringify({ type: { value: type }, date: { dateval: [0, 0, year, false] } });

  bd.prepare('INSERT INTO event VALUES (?, ?, ?)').run('h-boda', 'E1', event(1, 1717));
  bd.prepare('INSERT INTO event VALUES (?, ?, ?)').run('h-baut', 'E2', event(15, 1690));

  bd.prepare('INSERT INTO person VALUES (?, ?, ?, ?, ?)').run(
    'h-alonso',
    'I1',
    'Alonso',
    'Lorenzo Royo',
    JSON.stringify({ event_ref_list: [{ ref: 'h-baut' }] }),
  );
  bd.prepare('INSERT INTO person VALUES (?, ?, ?, ?, ?)').run(
    'h-cathalina',
    'I2',
    'Cathalina',
    'de Beltran',
    JSON.stringify({ event_ref_list: [] }),
  );

  bd.prepare('INSERT INTO family VALUES (?, ?, ?)').run(
    'h-fam',
    'F1',
    JSON.stringify({
      father_handle: 'h-alonso',
      mother_handle: 'h-cathalina',
      event_ref_list: [{ ref: 'h-boda' }],
    }),
  );

  bd.close();
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'regesta-gramps-'));
  path = join(dir, 'sqlite.db');
  construir(path);
});

after(() => rmSync(dir, { recursive: true, force: true }));

describe('GrampsReader · events de familia', () => {
  test('the marriage shows up for both spouses', () => {
    const reader = new GrampsReader(path);
    assert.ok(reader.open());

    const bodas = reader.eventsWithPerson().filter((e) => e.event_id === 'E1');
    assert.deepEqual(
      bodas.map((e) => e.person_id).sort(),
      ['I1', 'I2'],
      'el marriage debe atribuirse al padre y a la madre de la familia',
    );
    assert.equal(bodas[0]!.year, 1717);

    reader.close();
  });

  test('personal events still appear exactly once', () => {
    const reader = new GrampsReader(path);
    assert.ok(reader.open());

    const bautismos = reader.eventsWithPerson().filter((e) => e.event_id === 'E2');
    assert.equal(bautismos.length, 1);
    assert.equal(bautismos[0]!.person_id, 'I1');

    reader.close();
  });

  test('a family with no recorded spouses does not break the walk', () => {
    const suelta = join(dir, 'suelta.db');
    construir(suelta);
    const bd = new DatabaseSync(suelta);
    bd.prepare('INSERT INTO family VALUES (?, ?, ?)').run(
      'h-huerfana',
      'F2',
      JSON.stringify({ father_handle: null, mother_handle: null, event_ref_list: [{ ref: 'h-boda' }] }),
    );
    bd.close();

    const reader = new GrampsReader(suelta);
    assert.ok(reader.open());
    assert.equal(reader.eventsWithPerson().filter((e) => e.event_id === 'E1').length, 2);
    reader.close();
  });
});
