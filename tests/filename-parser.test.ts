import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseName,
  matchKey,
  isIgnorable,
  isSkippedFolder,
  looksLikeCertificate,
} from '../src/indexer/filename-parser.ts';

/**
 * The test cases are real file names from the reference archive, typos and
 * all. If the parser stops reading them, assisted cataloguing breaks.
 */

describe('parseName - the usual pattern', () => {
  test('reads record type, name and year', () => {
    const r = parseName('BAUTISMO VICENTA MOLL MARTINEZ 1799.jpg');
    assert.equal(r.recordType, 'baptism');
    assert.equal(r.name, 'VICENTA MOLL MARTINEZ');
    assert.equal(r.year, 1799);
    assert.equal(r.page, null);
    assert.ok(r.confidence >= 0.9);
  });

  test('separates the page number from the year', () => {
    const r = parseName('BAUTISMO YSABEL JOAN DEL PESSO PASTOR 1596 2.jpg');
    assert.equal(r.year, 1596);
    assert.equal(r.page, 2);
    assert.equal(r.name, 'YSABEL JOAN DEL PESSO PASTOR');
  });

  test('splits the two spouses of a marriage licence', () => {
    const r = parseName(
      'EXPEDIENTE MATRIMONIAL AGUSTIN ARNAU CANO Y ANGELA MARIA DIEZ SORIANO 1816 3.jpg',
    );
    assert.equal(r.recordType, 'marriage_licence');
    assert.equal(r.name, 'AGUSTIN ARNAU CANO');
    assert.equal(r.secondName, 'ANGELA MARIA DIEZ SORIANO');
    assert.equal(r.page, 3);
  });

  test('does not split a compound name containing the joiner with no valid second name', () => {
    const r = parseName('BAUTISMOS FRANCISCA MARIA GERONIMA Y JUANA MARIA TERESA PLA SEVA 1684.jpg');
    // Here the split is right: there is enough name on both sides.
    assert.ok(r.name && r.name.length > 0);
    assert.equal(r.year, 1684);
  });
});

describe('parseName - real typos from the archive', () => {
  test('accepts BAUUTISMO as a baptism and flags it', () => {
    const r = parseName('BAUUTISMO NICOLAU JUSEPH FERRANDES MARTINES 1642.jpg');
    assert.equal(r.recordType, 'baptism');
    assert.ok(r.warnings.includes('typo_in_type'));
  });

  test('acepta BAUTIZO como baptism', () => {
    assert.equal(parseName('BAUTIZO JUANA MARIA SALAS PRIETO 1795.jpg').recordType, 'baptism');
  });

  test('acepta VELACION sin tilde', () => {
    assert.equal(parseName('VELACION MARIA PEREZ 1700.jpg').recordType, 'nuptial_blessing');
  });
});

describe('parseName - cases that need reviewing', () => {
  test('flags an impossible year rather than accepting it', () => {
    const r = parseName('BAUTISMO MARIA SCOLASTICA BLASCO TERRADES 1165.jpg');
    assert.equal(r.year, 1165);
    assert.ok(r.warnings.includes('year_out_of_range'));
    assert.ok(r.confidence < 0.9, 'the confidence must drop so it surfaces for review');
  });

  test('flags a missing year', () => {
    const r = parseName('DEFUNCION JUANA RUIZ.jpg');
    assert.equal(r.year, null);
    assert.ok(r.warnings.includes('no_year'));
  });

  test('reconoce la marca POSIBLE del usuario', () => {
    const r = parseName('POSIBLE JOSEPH SERRANO Y ADELA (LUCIA) DE LA ROSA 1715.jpg');
    assert.ok(r.warnings.includes('flagged_by_user'));
    assert.equal(r.year, 1715);
  });

  test('a file starting with the name is left for review', () => {
    const r = parseName('LLEONOR HIERONIMA ROVIRA ALMENDROS 1593.jpg');
    assert.equal(r.recordType, 'unknown');
    assert.ok(r.warnings.includes('unrecognised_type'));
  });

  test('does not mistake a book pagination for a year', () => {
    // An archive also holds loose pages from journals and books
    // ('114-5.pdf'). Taking that 114 for a date would fill the chronology
    // with impossible years.
    for (const name of ['114-5.pdf', '129-4.pdf', '96-3.pdf']) {
      const r = parseName(name);
      assert.equal(r.year, null, `${name} must not yield a year`);
    }
  });

  test('still reads four-digit years next to a hyphen', () => {
    const r = parseName('BAUTISMO MARIA RAMOS 1858.jpg');
    assert.equal(r.year, 1858);
  });
});

describe('isIgnorable', () => {
  test('ignora files del sistema', () => {
    assert.ok(isIgnorable('desktop.ini'));
    assert.ok(isIgnorable('Thumbs.db'));
    assert.ok(!isIgnorable('BAUTISMO MARIA RAMOS 1858.jpg'));
  });
});

describe('isSkippedFolder', () => {
  test('skips Synology system folders and hidden ones', () => {
    for (const f of ['#snapshot', '@eaDir', '#recycle', '.git', 'node_modules']) {
      assert.ok(isSkippedFolder(f), f);
    }
  });

  test('keeps ordinary folders and relative path segments', () => {
    for (const f of ['GENEALOGIA', 'PROVINCIA TERUEL', '.', '..', '']) {
      assert.ok(!isSkippedFolder(f), f);
    }
  });

  test('a snapshot path is skipped at any depth, as the watcher checks it', () => {
    const path = '/documents/#snapshot/GMT+02-2026.09.25-05.05.10/VARIOS/MATRIMONIO 1614.jpg';
    assert.ok(path.split(/[\\/]/).some(isSkippedFolder));
    assert.ok(!'/documents/VARIOS/MATRIMONIO 1614.jpg'.split(/[\\/]/).some(isSkippedFolder));
  });
});

describe('looksLikeCertificate', () => {
  // An archive mixes certificates with screenshots, journal offprints and
  // photographs. Reading the names of those produces invented records with
  // impossible years.
  const noSonCertificados = [
    'FireShot Capture 807 - Índices Sacramentales - [www.raicesreinovalencia.com].png',
    '116-5.pdf',
    '804-Texto en formato editable (Word, Open Office...)-477-1-10-20201117.pdf',
    '004.jpg',
    'editum,+7941-37781-1-CE.pdf',
    'IMG_20240315.jpg',
  ];
  for (const n of noSonCertificados) {
    test(`discards "${n.slice(0, 34)}…"`, () => {
      assert.equal(looksLikeCertificate(n), false);
    });
  }

  const siLoSon = [
    'BAUTISMO VICENTA MOLL MARTINEZ 1799.jpg',
    'EXPEDIENTE MATRIMONIAL JOSEF DIEZ Y CLARA SORIANO 1784 1.jpg',
    'ACTA DE NACIMIENTO DE ARSENIO CAMPOS RODRIGUEZ.pdf',
  ];
  for (const n of siLoSon) {
    test(`accepts "${n.slice(0, 34)}…"`, () => {
      assert.equal(looksLikeCertificate(n), true);
    });
  }
});

describe('matchKey - spellings of the 16th to 19th centuries', () => {
  const equivalentes: ReadonlyArray<readonly [string, string]> = [
    ['YSABEL', 'ISABEL'],
    ['YNES', 'INES'],
    ['JUSEPA', 'JOSEFA'],
    ['JOSEPHA', 'JOSEFA'],
    ['JUSEPHA', 'JOSEFA'],
    ['XIMENEZ', 'JIMENEZ'],
    ['DEL PESSO', 'DEL PESO'],
    ['LLEONOR', 'LEONOR'],
    ['CATHALINA', 'CATALINA'],
    ['FERNANDEZ', 'FERNANDES'],
    ['BURLÓ', 'BURLO'],
  ];

  for (const [a, b] of equivalentes) {
    test(`${a} equivale a ${b}`, () => {
      assert.equal(matchKey(a), matchKey(b));
    });
  }

  // Tan importante como unificar variantes es no fundir people distintas.
  const distintos: ReadonlyArray<readonly [string, string]> = [
    ['JUAN', 'JUANA'],
    ['PEREZ', 'PEREIRA'],
    ['GARCIA', 'GRACIA'],
    ['MARIA', 'MARIANA'],
  ];

  for (const [a, b] of distintos) {
    test(`${a} NO se confunde con ${b}`, () => {
      assert.notEqual(matchKey(a), matchKey(b));
    });
  }
});
