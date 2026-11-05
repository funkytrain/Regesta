import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MatchIndex, suggestedRole } from '../src/server/matching.ts';
import type { GrampsReader } from '../src/server/gramps.ts';

/**
 * Matching against the tree has exactly one hard problem: namesakes. Within
 * a lineage the grandfather's name recurs every second generation, and the
 * only thing separating one from another is the date of their facts.
 *
 * These tests pin that rule down, including the case that must NOT be
 * resolved: when two namesakes have an event equally close, the tool does
 * not choose, because choosing would be inventing.
 */

type Event = ReturnType<GrampsReader['eventsWithPerson']>[number];

/** Fake tree: all it needs to do is enumerate events. */
function tree(events: Array<Partial<Event>>): GrampsReader {
  const complete = events.map((e) => ({
    event_id: 'E0',
    type: 'Bautismo',
    type_code: 15,
    date: null,
    year: null,
    place: null,
    person_id: 'I0',
    person: 'Sin name',
    citations: 0,
    ...e,
  })) as Event[];
  return { eventsWithPerson: () => complete } as unknown as GrampsReader;
}

describe('matching - a single candidate', () => {
  const index = new MatchIndex(
    tree([
      { person_id: 'I1', person: 'Abelardo Senen Martinez Molto', year: 1681, event_id: 'E1' },
    ]),
  );

  test('unique name and exact year: certain', () => {
    const [c] = index.for('ABELARDO SENEN MARTINEZ MOLTO', 1681, 'baptism');
    assert.equal(c?.gramps_id, 'I1');
    assert.equal(c?.certainty, 'certain');
  });

  test('within tolerance but not exact: probable, not certain', () => {
    const [c] = index.for('ABELARDO SENEN MARTINEZ MOLTO', 1683, 'baptism');
    assert.equal(c?.certainty, 'probable');
    assert.equal(c?.offset, 2);
  });

  test('outside tolerance: nothing is proposed', () => {
    assert.deepEqual(index.for('ABELARDO SENEN MARTINEZ MOLTO', 1690, 'baptism'), []);
  });

  test('a name absent from the tree invents no candidates', () => {
    assert.deepEqual(index.for('NADIE DE ESTE MUNDO', 1681, 'baptism'), []);
  });

  test('historical spellings still match', () => {
    const i = new MatchIndex(
      tree([{ person_id: 'I9', person: 'Isabel Gonzalez', year: 1600, event_id: 'E9' }]),
    );
    const [c] = i.for('YSABEL GONZALEZ', 1600, 'baptism');
    assert.equal(c?.gramps_id, 'I9', 'Ysabel and Isabel are the same person');
  });
});

describe('matching - namesakes', () => {
  // A case modelled on a real archive: two Juan Pasquals, born a year apart and
  // indistinguishable by name.
  const dosJuanes = tree([
    { person_id: 'I0101', person: 'Juan Pasqual Albiol Perez', year: 1625, event_id: 'E1', type_code: 12 },
    { person_id: 'I0102', person: 'Juan Pasqual Albiol Perez', year: 1626, event_id: 'E2', type_code: 12 },
  ]);

  test('the year decides when only one is in range', () => {
    const i = new MatchIndex(
      tree([
        { person_id: 'I1', person: 'Juan Perez', year: 1700, event_id: 'E1' },
        { person_id: 'I2', person: 'Juan Perez', year: 1750, event_id: 'E2' },
      ]),
    );
    const cs = i.for('JUAN PEREZ', 1700, 'baptism');
    assert.equal(cs.length, 1, 'the distant namesake must not be offered');
    assert.equal(cs[0]?.gramps_id, 'I1');
    assert.equal(cs[0]?.certainty, 'certain');
    assert.match(cs[0]!.reason, /namesakes/);
  });

  test('with two namesakes in range it does not choose for the user', () => {
    const cs = new MatchIndex(dosJuanes).for('JUAN PASQUAL ALBIOL PEREZ', 1625, 'baptism');
    assert.equal(cs.length, 2);
    assert.ok(cs.every((c) => c.certainty === 'uncertain'), 'none can be taken as certain');
    assert.equal(cs[0]?.gramps_id, 'I0101', 'closest to the target year comes first');
  });

  test('a person with several events counts as one candidate', () => {
    const i = new MatchIndex(
      tree([
        { person_id: 'I1', person: 'Maria Lopez', year: 1700, event_id: 'E1', type_code: 12 },
        { person_id: 'I1', person: 'Maria Lopez', year: 1701, event_id: 'E2', type_code: 15 },
      ]),
    );
    const cs = i.for('MARIA LOPEZ', 1700, 'baptism');
    assert.equal(cs.length, 1);
    assert.equal(cs[0]?.certainty, 'certain');
    assert.equal(cs[0]?.event, 'E1', 'the event closest to the date is kept');
  });
});

describe('matching - the record type narrows it', () => {
  const i = new MatchIndex(
    tree([
      { person_id: 'I1', person: 'Pedro Gil', year: 1800, event_id: 'E-nac', type_code: 12, type: 'Nacimiento' },
      { person_id: 'I2', person: 'Pedro Gil', year: 1800, event_id: 'E-def', type_code: 13, type: 'Defunción' },
    ]),
  );

  test('a baptism is not paired with a namesake burial', () => {
    const cs = i.for('PEDRO GIL', 1800, 'baptism');
    assert.equal(cs.length, 1);
    assert.equal(cs[0]?.gramps_id, 'I1');
  });

  test('a burial goes to its own event', () => {
    const cs = i.for('PEDRO GIL', 1800, 'burial');
    assert.equal(cs.length, 1);
    assert.equal(cs[0]?.gramps_id, 'I2');
  });

  test('with no record type both are offered, undecided', () => {
    assert.equal(i.for('PEDRO GIL', 1800, null).length, 2);
  });
});

describe('matching - marriages by couple', () => {
  const boda = tree([
    { person_id: 'I1', person: 'Jose Campos Alvarez', year: 1894, event_id: 'E666', type_code: 1, type: 'Matrimonio' },
    { person_id: 'I2', person: 'Bernardina Rodriguez Piñol', year: 1894, event_id: 'E666', type_code: 1, type: 'Matrimonio' },
    { person_id: 'I3', person: 'Otra Persona Cualquiera', year: 1894, event_id: 'E777', type_code: 1, type: 'Matrimonio' },
  ]);

  test('both spouses in the same event: certain for both', () => {
    const r = new MatchIndex(boda).forCouple(
      'JOSE CAMPOS ALVAREZ',
      'BERNARDINA RODRIGUEZ PIÑOL',
      1894,
      'marriage',
    );
    assert.equal(r.event, 'E666');
    assert.equal(r.first[0]?.certainty, 'certain');
    assert.equal(r.second[0]?.certainty, 'certain');
    assert.match(r.first[0]!.reason, /both spouses/);
  });

  test('if the spouse is not in the tree, the other still counts', () => {
    const r = new MatchIndex(boda).forCouple(
      'JOSE CAMPOS ALVAREZ',
      'NOMBRE QUE NO EXISTE',
      1894,
      'marriage',
    );
    assert.equal(r.event, null, 'with no confirmed couple there is no shared event');
    assert.equal(r.first.length, 1);
    assert.equal(r.second.length, 0);
  });

  test('two tree people who did not marry each other are not a couple', () => {
    const r = new MatchIndex(boda).forCouple(
      'JOSE CAMPOS ALVAREZ',
      'OTRA PERSONA CUALQUIERA',
      1894,
      'marriage',
    );
    assert.equal(r.event, null);
    assert.notEqual(r.first[0]?.certainty, 'certain');
  });
});

describe('matching - the tree names them longer than the document does', () => {
  // Registers abbreviate and Gramps does not: the same man is 'Antonio
  // Almenar Belda' in the entry and 'Antonio Joseph Almenar Belda' in the
  // tree.
  const arbolLargo = tree([
    { person_id: 'I1', person: 'Antonio Joseph Almenar Belda', year: 1762, event_id: 'E1' },
    { person_id: 'I2', person: 'Margarita Vidal Terrades', year: 1684, event_id: 'E2' },
    { person_id: 'I3', person: 'Josepha Perez Arrieta', year: 1853, event_id: 'E3' },
  ]);

  test('finds someone the tree gives an extra middle name', () => {
    const [c] = new MatchIndex(arbolLargo).for('ANTONIO ALMENAR BELDA', 1762, 'baptism');
    assert.equal(c?.gramps_id, 'I1');
    assert.match(c!.reason, /the tree has them as/);
  });

  test('finds someone the tree gives an extra surname', () => {
    const [c] = new MatchIndex(arbolLargo).for('MARGARITA VIDAL', 1684, 'baptism');
    assert.equal(c?.gramps_id, 'I2');
  });

  test('a partial match is never taken as certain', () => {
    const [c] = new MatchIndex(arbolLargo).for('ANTONIO ALMENAR BELDA', 1762, 'baptism');
    assert.equal(c?.certainty, 'probable', 'a person confirms this, not the machine');
  });

  test('sharing some of the words is not enough', () => {
    // 'Josefa Diez Perez' shares a given name and a surname with 'Josepha
    // Perez Arrieta', but 'Diez' is nowhere: they are not the same
    // person.
    const cs = new MatchIndex(arbolLargo).for('JOSEFA DIEZ PEREZ', 1853, 'baptism');
    assert.deepEqual(cs, []);
  });

  test('the exact name beats whoever merely contains it', () => {
    const i = new MatchIndex(
      tree([
        { person_id: 'I1', person: 'Ignacia Ximenez Martinez', year: 1622, event_id: 'E1' },
        { person_id: 'I2', person: 'Ignacia Ascension Ximenez Martinez', year: 1622, event_id: 'E2' },
      ]),
    );
    const cs = i.for('IGNACIA XIMENEZ MARTINEZ', 1622, 'baptism');
    assert.equal(cs.length, 1, 'quien coincide al pie de la letra no admite competencia');
    assert.equal(cs[0]?.gramps_id, 'I1');
    assert.equal(cs[0]?.certainty, 'certain');
  });

  test('if several contain the name, none is taken as good', () => {
    const i = new MatchIndex(
      tree([
        { person_id: 'I1', person: 'Jaume Jusep Rodriguez Sanchez', year: 1621, event_id: 'E1' },
        { person_id: 'I2', person: 'Jaume Juan Rodriguez Perez', year: 1621, event_id: 'E2' },
      ]),
    );
    const cs = i.for('JAUME RODRIGUEZ', 1621, 'baptism');
    assert.equal(cs.length, 2);
    assert.ok(cs.every((c) => c.certainty === 'uncertain'));
  });

  test('the same wedding confirms the spouse found by parts', () => {
    // The most frequent case in the archive: she matches exactly, he is in
    // the tree under a longer name, and both appear in the same marriage.
    const i = new MatchIndex(
      tree([
        { person_id: 'I1', person: 'Cathalina de Beltran', year: 1717, event_id: 'E-boda', type_code: 1, type: 'Matrimonio' },
        { person_id: 'I2', person: 'Alonso Alfonso Lorenzo Royo', year: 1717, event_id: 'E-boda', type_code: 1, type: 'Matrimonio' },
      ]),
    );
    const r = i.forCouple('CATHALINA DE BELTRAN', 'ALONSO LORENZO ROYO', 1717, 'marriage');

    assert.equal(r.event, 'E-boda');
    assert.equal(r.second[0]?.gramps_id, 'I2');
    assert.equal(r.second[0]?.certainty, 'certain', 'figurar en esa boda despeja la duda del name');
  });
});

describe('matching - proposed role', () => {
  test('each record type proposes the role of its subject', () => {
    assert.equal(suggestedRole('baptism'), 'subject');
    assert.equal(suggestedRole('burial'), 'deceased');
    assert.equal(suggestedRole('marriage'), 'spouse');
  });

  test('a record with no clear subject does not invent a role', () => {
    assert.equal(suggestedRole('unknown'), 'other');
    assert.equal(suggestedRole(null), 'other');
  });
});
