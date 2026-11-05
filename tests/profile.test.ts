import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  loadProfileFrom,
  setProfile,
  validateProfile,
  compiled,
  type ArchiveProfile,
} from '../src/indexer/profile.ts';
import { parseName, matchKey, looksLikeCertificate } from '../src/indexer/filename-parser.ts';
import { detect, toProfile } from '../src/indexer/detect-profile.ts';

const bundled = (id: string): ArchiveProfile =>
  loadProfileFrom(join(process.cwd(), 'profiles', `${id}.json`));

// Every test leaves the default profile in place: they share one module.
afterEach(() => setProfile(null));

describe('profile · the bundled ones load and work', () => {
  test('es-parish reads the reference corpus', () => {
    setProfile(bundled('es-parish'));

    const r = parseName('BAUTISMO YSABEL JOAN DEL PESSO PASTOR 1596 2.jpg');
    assert.equal(r.recordType, 'baptism');
    assert.equal(r.name, 'YSABEL JOAN DEL PESSO PASTOR');
    assert.equal(r.year, 1596);
    assert.equal(r.page, 2);
  });

  test('the typos of the corpus stay recognised, and flagged', () => {
    setProfile(bundled('es-parish'));

    const r = parseName('BAUUTISMO PEDRO GARCIA 1701.jpg');
    assert.equal(r.recordType, 'baptism');
    assert.ok(r.warnings.includes('typo_in_type'));
  });

  test('the Spanish spelling rules still fold the historical variants', () => {
    setProfile(bundled('es-parish'));

    assert.equal(matchKey('YSABEL'), 'ISABEL');
    assert.equal(matchKey('JUSEPHA'), 'JOSEFA');
    assert.equal(matchKey('XIMENEZ'), 'JIMENES');
  });

  test('en-parish reads English names with English rules', () => {
    setProfile(bundled('en-parish'));

    const r = parseName('MARRIAGE JOHN CLARKE AND JANE WRIGHT 1801.jpg');
    assert.equal(r.recordType, 'marriage');
    assert.equal(r.name, 'JOHN CLARKE');
    assert.equal(r.secondName, 'JANE WRIGHT');

    // The silent initials of English surnames, which Spanish does not have.
    assert.equal(matchKey('KNIGHT'), 'NIGHT');
    assert.equal(matchKey('WRIGHT'), 'RIGHT');
  });

  test('pt-parish reads Portuguese record types', () => {
    setProfile(bundled('pt-parish'));

    assert.equal(parseName('OBITO JOSE CARVALHO 1799.jpg').recordType, 'burial');
    assert.equal(parseName('CASAMENTO JOAO E ANA 1801.jpg').recordType, 'marriage');
  });

  test('the same file name reads differently under two profiles', () => {
    // This is the whole point of the profile: the machinery is shared, the
    // vocabulary is not.
    setProfile(bundled('es-parish'));
    assert.equal(parseName('MATRIMONIO A B Y C D 1800.jpg').recordType, 'marriage');

    setProfile(bundled('en-parish'));
    assert.equal(parseName('MATRIMONIO A B Y C D 1800.jpg').recordType, 'unknown');
    assert.equal(parseName('MARRIAGE A B AND C D 1800.jpg').recordType, 'marriage');
  });

  test('the longest spelling wins over a prefix of it', () => {
    setProfile(bundled('es-parish'));
    // 'EXPEDIENTE MATRIMONIAL' must not be swallowed by 'MATRIMONIO'.
    const r = parseName('EXPEDIENTE MATRIMONIAL JUAN CON MARIA 1802.pdf');
    assert.equal(r.recordType, 'marriage_licence');
    assert.equal(r.name, 'JUAN');
    assert.equal(r.secondName, 'MARIA');
  });

  test('what is not a certificate comes from the profile', () => {
    setProfile(bundled('es-parish'));
    assert.equal(looksLikeCertificate('IMG_20240101.jpg'), false);
    assert.equal(looksLikeCertificate('BAUTISMO JUAN PEREZ 1700.jpg'), true);
  });
});

describe('profile · a bad profile fails at load, not mid-run', () => {
  const base = {
    id: 'x',
    name: 'X',
    yearRange: { min: 1400, max: 'current' },
    recordTypes: { baptism: { match: ['B'] } },
    joiners: [],
    userMarks: [],
    notRecords: [],
    roles: [],
    matchKeyRules: [],
  };

  test('an unknown record type is rejected by name', () => {
    assert.throws(
      () => validateProfile({ ...base, recordTypes: { bautizo: { match: ['B'] } } }, 'test'),
      /unknown record type "bautizo"/,
    );
  });

  test('a record type with no spellings is rejected', () => {
    assert.throws(
      () => validateProfile({ ...base, recordTypes: { baptism: { match: [] } } }, 'test'),
      /has no "match" spellings/,
    );
  });

  test('a malformed regular expression is reported with its position', () => {
    assert.throws(
      () => validateProfile({ ...base, notRecords: ['^ok', '^(unclosed'] }, 'test'),
      /entry 2 of "notRecords"/,
    );
  });

  test('a rule without "to" is rejected', () => {
    assert.throws(
      () => validateProfile({ ...base, matchKeyRules: [{ from: 'PH' }] }, 'test'),
      /needs "from" and "to"/,
    );
  });

  test('the draft of a detected profile is accepted, unknown_* and all', () => {
    // Otherwise the detector could not hand the user something to try.
    const draft = validateProfile(
      { ...base, recordTypes: { unknown_bautismo: { match: ['BAUTISMO'] } } },
      'test',
    );
    assert.ok(draft);
  });
});

describe('profile · detection from file names', () => {
  // A small archive in a made-up convention: record type first, name, year.
  const names = [
    ...Array.from({ length: 30 }, (_, i) => `DOOP JAN VAN DIJK ${1700 + i}.jpg`),
    ...Array.from({ length: 12 }, (_, i) => `HUWELIJK PIET DE VRIES EN ANNA BAKKER ${1720 + i}.jpg`),
    ...Array.from({ length: 8 }, (_, i) => `BEGRAFENIS KLAAS JANSEN ${1740 + i}.jpg`),
    'DOPP HENDRIK SMIT 1755.jpg', // typo of DOOP
    'IMG_20231106_113256.jpg',
  ];

  test('it finds the record types by how often they open a name', () => {
    const d = detect(names);
    assert.equal(d.candidates[0]?.word, 'DOOP');
    assert.equal(d.candidates[0]?.count, 30);
    assert.deepEqual(
      d.candidates.map((c) => c.word).slice(0, 3),
      ['DOOP', 'HUWELIJK', 'BEGRAFENIS'],
    );
  });

  test('it spots a typo by its closeness to a frequent word', () => {
    const d = detect(names);
    const doop = d.candidates.find((c) => c.word === 'DOOP');
    assert.ok(doop?.typos.some((t) => t.word === 'DOPP'));
  });

  test('it works out the separator, the year position and the range', () => {
    const d = detect(names);
    assert.equal(d.separator, ' ');
    assert.equal(d.yearPosition, 'end');
    assert.equal(d.yearRange?.min, 1700);
    assert.ok(d.withYear > 0.9);
  });

  test('it recognises the joiner without mistaking a given name for one', () => {
    const d = detect(names);
    assert.deepEqual(d.joiners.map((j) => j.word), ['EN']);
  });

  test('camera files are set aside', () => {
    const d = detect(names);
    assert.ok(d.notRecords.some((n) => n.startsWith('IMG_')));
  });

  test('the draft it produces is a valid profile that parses those names', () => {
    const d = detect(names);
    const draft = toProfile(d, 'nl-test') as unknown as ArchiveProfile;
    setProfile(validateProfile(draft, 'test'));

    const r = parseName('HUWELIJK PIET DE VRIES EN ANNA BAKKER 1725.jpg');
    // The type is not named yet -- that is the user's job -- but the name,
    // the year and the two people are already read.
    assert.equal(r.year, 1725);
    assert.equal(r.name, 'PIET DE VRIES');
    assert.equal(r.secondName, 'ANNA BAKKER');
  });

  test('with no convention it proposes nothing rather than inventing one', () => {
    const d = detect(['scan001.jpg', 'foto abuela.jpg', 'documento importante.pdf']);
    assert.equal(d.candidates.length, 0);
  });
});

describe('profile · compilation', () => {
  test('spellings are matched case-insensitively and with loose spacing', () => {
    setProfile(bundled('es-parish'));
    assert.equal(parseName('bautismo juan perez 1700.jpg').recordType, 'baptism');
    assert.equal(
      parseName('EXPEDIENTE  MATRIMONIAL JUAN CON MARIA 1802.pdf').recordType,
      'marriage_licence',
    );
  });

  test('the year range comes from the profile', () => {
    setProfile(bundled('es-parish'));
    assert.ok(parseName('BAUTISMO X 1390.jpg').warnings.includes('year_out_of_range'));

    setProfile(bundled('en-parish')); // starts at 1538
    assert.ok(parseName('BAPTISM X 1500.jpg').warnings.includes('year_out_of_range'));
  });

  test('compilation is cached per profile', () => {
    const p = bundled('es-parish');
    assert.equal(compiled(p), compiled(p));
  });
});
