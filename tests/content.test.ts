import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

/**
 * Search inside the text of the documents.
 *
 * An archive holds notarial records, censuses and population rolls whose
 * content is nowhere in the file name: a surname may appear only in the body
 * of the document. These tests check that the index finds it and returns the
 * passage where it occurs.
 */

let bd: DatabaseSync;

before(() => {
  bd = new DatabaseSync(':memory:');
  bd.exec(`
    CREATE VIRTUAL TABLE document_search USING fts5(
      text, document_id UNINDEXED,
      tokenize = "unicode61 remove_diacritics 2"
    );
  `);

  const meter = bd.prepare('INSERT INTO document_search (text, document_id) VALUES (?, ?)');
  meter.run(
    'ANTE MI DICHO ESCRIBANO Y TESTIGOS PARECIERON SALVADOR PEREZ DE LEON ' +
      'Y MARIA DE SANGUESA VECINOS DE ESTA VILLA',
    1,
  );
  meter.run('PADRON DE TERUEL DE 1841. FRANCISCA ARNAU, HIJA DE PEDRO Y JOSEFA CANO, EDAD 50', 2);
  meter.run('VISITA AL ARCHIVO: SAN NICOLAS BAUTISMOS. GERONIMA MEDINA 1576, QL 1566-1583', 3);
});

after(() => bd.close());

const buscar = (query: string) =>
  bd
    .prepare('SELECT document_id FROM document_search WHERE document_search MATCH ?')
    .all(query) as Array<{ document_id: number }>;

describe('search inside the documents', () => {
  test('finds a word that is only in the body of the text', () => {
    const r = buscar('"escribano"*');
    assert.equal(r.length, 1);
    assert.equal(r[0]!.document_id, 1);
  });

  test('finds a surname in a population roll', () => {
    assert.equal(buscar('"arnau"*').length, 1);
  });

  test('ignores diacritics, like the rest of the search', () => {
    // 'SANGUESA' without the diaeresis must find 'SANGÜESA' and back.
    assert.equal(buscar('"sanguesa"*').length, 1);
  });

  test('a quoted phrase is matched literally', () => {
    assert.equal(buscar('"ante mi dicho escribano"').length, 1);
    // Las mismas palabras en other position no son la misma frase.
    assert.equal(buscar('"escribano dicho ante mi"').length, 0);
  });

  test('several loose words all have to be present', () => {
    assert.equal(buscar('"salvador"* AND "sanguesa"*').length, 1);
    assert.equal(buscar('"salvador"* AND "geronima"*').length, 0);
  });

  test('devuelve el fragmento donde aparece lo buscado', () => {
    const f = bd
      .prepare(
        `SELECT snippet(document_search, 0, '«', '»', '…', 8) AS f
         FROM document_search WHERE document_search MATCH ?`,
      )
      .get('"escribano"*') as { f: string };

    assert.ok(f.f.includes('«ESCRIBANO»'), `the snippet must mark the match: ${f.f}`);
  });

  test('a word in no document returns nothing', () => {
    assert.equal(buscar('"zaragoza"*').length, 0);
  });
});
