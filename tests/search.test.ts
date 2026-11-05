import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The 'all' option of the selector asks for thousands of documents at once.
 * The query has to resolve with aggregations rather than per-row
 * subqueries: a duplicate subquery per document took eleven seconds over the
 * real archive, against a quarter of a second with the aggregation.
 *
 * This test builds a small database of the same shape and checks both the
 * result and that the query plan does not walk the table once per row.
 */

let bd: DatabaseSync;

before(() => {
  bd = new DatabaseSync(':memory:');
  bd.exec(readFileSync(join(process.cwd(), 'src/server/schema.sql'), 'utf8'));

  const doc = bd.prepare(
    'INSERT INTO document (path, name, bytes, hash, present) VALUES (?, ?, ?, ?, 1)',
  );
  // 200 documents, de los cuales tres pares comparten contenido.
  for (let i = 0; i < 200; i++) {
    const hash = i < 6 ? `repetido-${Math.floor(i / 2)}` : `unico-${i}`;
    doc.run(`folder/doc-${i}.jpg`, `doc-${i}.jpg`, 1000 + i, hash);
  }
});

after(() => bd.close());

/** The same copies expression the API uses. */
const QUERY = `
  SELECT d.id, d.name, COALESCE(h.n, 1) - 1 AS copias
  FROM document d
  LEFT JOIN (
    SELECT hash, COUNT(*) AS n FROM document
    WHERE present = 1 GROUP BY hash HAVING COUNT(*) > 1
  ) h ON h.hash = d.hash
  WHERE d.present = 1`;

describe('search - counting copies', () => {
  test('cuenta las copias de cada document', () => {
    const rows = bd.prepare(QUERY).all() as Array<{ copias: number }>;
    assert.equal(rows.length, 200);

    const conCopias = rows.filter((f) => f.copias > 0);
    // Tres pares: seis documents, cada uno con una copia.
    assert.equal(conCopias.length, 6);
    assert.ok(
      conCopias.every((f) => f.copias === 1),
      'each document of a pair has exactly one copy',
    );
  });

  test('a unique document declares no copies', () => {
    const row = bd
      .prepare(`${QUERY} AND d.name = ?`)
      .get('doc-100.jpg') as { copias: number };
    assert.equal(row.copias, 0);
  });

  test('the table is not walked once per row', () => {
    // If someone swaps the aggregation for a correlated subquery, the plan
    // starts to include a CORRELATED SCALAR SUBQUERY and the time explodes
    // over thousands of documents.
    const plan = (bd.prepare(`EXPLAIN QUERY PLAN ${QUERY}`).all() as Array<{ detail: string }>)
      .map((f) => f.detail)
      .join(' | ');
    assert.ok(
      !/CORRELATED/i.test(plan),
      `la query no debe llevar subconsultas correlacionadas. Plan: ${plan}`,
    );
  });
});
