/**
 * Gramps candidates for what the indexer read from the file name.
 *
 * The file name gives a person and a year; the tree gives people with dated
 * events. Crossing the two by match key yields a handful of candidates, and
 * it is the year that decides between them: within one lineage the same names
 * recur for generations, and without the date there is no way to tell which
 * namesake a baptism of 1625 refers to.
 *
 * None of this decides for the user: it produces proposals with their degree
 * of certainty, to be confirmed or dismissed in the review queue.
 */

import type { GrampsReader } from './gramps.js';
import { matchKey } from '../indexer/filename-parser.js';

/** Years of tolerance between the document date and the tree event date. */
export const YEAR_TOLERANCE = 2;

/**
 * Gramps event types admissible for each record type.
 *
 * This narrows the matching: a baptism of 1780 must not be paired with the
 * death of a namesake in the same year. Types not listed narrow nothing,
 * because offering a reviewable candidate beats offering none.
 */
const EVENTS_BY_RECORD_TYPE: Record<string, number[]> = {
  baptism: [15, 16, 12, 22, 24, 30],
  birth: [12, 15],
  burial: [13, 19, 45, 25, 20],
  marriage: [1, 6, 7, 3, 5, 2, 4],
  marriage_licence: [1, 6, 7, 3, 4, 5, 2],
  nuptial_blessing: [1, 6, 7],
  confirmation: [23, 30],
};

/** Role proposed for the subject, according to the record type. */
const ROLE_BY_RECORD_TYPE: Record<string, string> = {
  baptism: 'subject',
  birth: 'subject',
  burial: 'deceased',
  marriage: 'spouse',
  marriage_licence: 'spouse',
  nuptial_blessing: 'spouse',
  confirmation: 'other',
};

export type Certainty = 'certain' | 'probable' | 'uncertain';

export interface Candidate {
  gramps_id: string;
  name: string;
  event: string;
  event_type: string;
  year: number;
  /** Difference in years from the document date. */
  offset: number;
  certainty: Certainty;
  /** Why it is proposed: shown to the user so they can judge it. */
  reason: string;
}

interface Event {
  gramps_id: string;
  person: string;
  type: string;
  type_code: number;
  event_id: string;
  year: number;
}

/**
 * Index from name to events, built once per copy of the tree.
 *
 * Walking thirteen thousand events on every query would be absurd: they are
 * grouped by match key, which is exactly how they will be looked up.
 */
export class MatchIndex {
  private byKey = new Map<string, Event[]>();
  /** Who has each word in their name, for subset matching. */
  private byWord = new Map<string, Set<string>>();
  /** Words in the name of each person in the tree. */
  private wordsOf = new Map<string, Set<string>>();
  private eventsOfPerson = new Map<string, Event[]>();

  constructor(gramps: GrampsReader) {
    for (const e of gramps.eventsWithPerson()) {
      if (!e.year) continue; // with no date it disambiguates nothing
      const key = matchKey(e.person);
      if (!key) continue;

      const event: Event = {
        gramps_id: e.person_id,
        person: e.person,
        type: e.type,
        type_code: e.type_code,
        event_id: e.event_id,
        year: e.year,
      };

      let list = this.byKey.get(key);
      if (!list) this.byKey.set(key, (list = []));
      list.push(event);

      let theirs = this.eventsOfPerson.get(e.person_id);
      if (!theirs) this.eventsOfPerson.set(e.person_id, (theirs = []));
      theirs.push(event);

      if (!this.wordsOf.has(e.person_id)) {
        const words = new Set(key.split(/\s+/).filter(Boolean));
        this.wordsOf.set(e.person_id, words);
        for (const w of words) {
          let who = this.byWord.get(w);
          if (!who) this.byWord.set(w, (who = new Set()));
          who.add(e.person_id);
        }
      }
    }
  }

  get names(): number {
    return this.byKey.size;
  }

  /** Events of those bearing this name, unfiltered by date or record type. */
  private eventsFor(name: string): Event[] {
    return this.byKey.get(matchKey(name)) ?? [];
  }

  /**
   * Events of those whose name contains every word searched for.
   *
   * Documents abbreviate and the tree does not: 'Margarita Vidal' in a
   * register is 'Margarita Vidal Terrades' in Gramps, and 'Antonio Almenar
   * Belda' is 'Antonio Joseph Almenar Belda'. Requiring *all* the words
   * from the document avoids the easy, wrong match: 'Josefa Diez Perez' does
   * not reach 'Josepha Perez Arrieta', because 'Diez' does not appear.
   */
  private bySubset(name: string): Event[] {
    const words = matchKey(name).split(/\s+/).filter(Boolean);
    if (words.length === 0) return [];

    // Start from the least common word: this narrows the walk to a handful of
    // candidates instead of the whole tree.
    let rarest = words[0]!;
    for (const w of words) {
      if ((this.byWord.get(w)?.size ?? Infinity) < (this.byWord.get(rarest)?.size ?? Infinity)) {
        rarest = w;
      }
    }

    const out: Event[] = [];
    for (const id of this.byWord.get(rarest) ?? []) {
      const theirs = this.wordsOf.get(id);
      if (!theirs || !words.every((w) => theirs.has(w))) continue;
      out.push(...(this.eventsOfPerson.get(id) ?? []));
    }
    return out;
  }

  /** Events of a person in the tree, by their identifier. */
  eventsByGrampsId(grampsId: string): Event[] {
    return this.eventsOfPerson.get(grampsId) ?? [];
  }

  /**
   * Candidates for a person named in a document of a given year.
   *
   * Returns the list ordered from best to worst. Where there are namesakes,
   * the year is the only thing separating them, so anyone without a nearby
   * event is left out: proposing nothing beats proposing the wrong sibling.
   */
  for(name: string, year: number, recordType?: string | null): Candidate[] {
    // The full name takes precedence. Only when nobody is named exactly that
    // are longer names searched within: otherwise someone with an extra
    // middle name would compete with someone who matches to the letter.
    let all = this.eventsFor(name);
    let byParts = false;
    if (all.length === 0) {
      all = this.bySubset(name);
      byParts = true;
    }
    if (all.length === 0) return [];

    const codes = recordType ? EVENTS_BY_RECORD_TYPE[recordType] : undefined;
    const ofType = codes ? all.filter((e) => codes.includes(e.type_code)) : [];
    // If the record type narrows nothing, or nobody fits the type, all events
    // are matched: a date that fits still counts even when the type is not
    // recorded.
    const base = ofType.length > 0 ? ofType : all;

    const inRange = base.filter((e) => Math.abs(e.year - year) <= YEAR_TOLERANCE);
    if (inRange.length === 0) return [];

    // A candidate is a person, not an event: if someone has a birth and a
    // baptism in the same year, the one closest to the target date wins.
    const bestPerPerson = new Map<string, Event>();
    for (const e of inRange) {
      const previous = bestPerPerson.get(e.gramps_id);
      if (!previous || Math.abs(e.year - year) < Math.abs(previous.year - year)) {
        bestPerPerson.set(e.gramps_id, e);
      }
    }

    const namesakes = new Set(base.map((e) => e.gramps_id)).size;
    const sole = bestPerPerson.size === 1;

    const candidates: Candidate[] = [];
    for (const e of bestPerPerson.values()) {
      const offset = Math.abs(e.year - year);
      const exact = offset === 0;

      let certainty: Certainty;
      let reason: string;
      if (byParts) {
        // The tree calls them something else -- a middle name, a surname the
        // document omits -- so however well the date fits, this is for a
        // person to confirm, not the machine.
        certainty = sole ? 'probable' : 'uncertain';
        reason = sole
          ? `the tree has them as "${e.person}", and their ${e.type.toLowerCase()} is dated ${e.year}`
          : `${bestPerPerson.size} people in the tree contain that name`;
      } else if (sole && exact) {
        certainty = 'certain';
        reason =
          namesakes > 1
            ? `of ${namesakes} namesakes, only this one has an event in ${year}`
            : `the only one in the tree with that name, and their ${e.type.toLowerCase()} is dated ${year}`;
      } else if (sole) {
        certainty = 'probable';
        reason = `the only one with that name, but their ${e.type.toLowerCase()} is dated ${e.year}`;
      } else {
        certainty = 'uncertain';
        reason = `${bestPerPerson.size} namesakes with a nearby date`;
      }

      candidates.push({
        gramps_id: e.gramps_id,
        name: e.person,
        event: e.event_id,
        event_type: e.type,
        year: e.year,
        offset,
        certainty,
        reason,
      });
    }

    return candidates.sort((a, b) => a.offset - b.offset || a.name.localeCompare(b.name));
  }

  /**
   * Candidates for a marriage, matching both spouses.
   *
   * Both names leading to the same event is the firmest signal in the whole
   * matching process: two namesakes married in the same year is vanishingly
   * rare. It holds even when the spouse was found by parts, because appearing
   * in that same wedding confirms they are who the document says, even if the
   * tree gives them an extra surname.
   */
  forCouple(
    name: string,
    name2: string | null,
    year: number,
    recordType?: string | null,
  ): { first: Candidate[]; second: Candidate[]; event: string | null } {
    const first = this.for(name, year, recordType);
    if (!name2) return { first, second: [], event: null };

    const second = this.for(name2, year, recordType);

    const firstEvents = new Set(first.map((c) => c.event));
    const shared = second.find((c) => firstEvents.has(c.event));

    if (!shared) {
      // Both are in the tree but in different weddings: the document and the
      // tree contradict each other. Lowering the certainty is the honest
      // thing; calling it certain would assert a marriage the tree denies.
      const contradictory = first.length > 0 && second.length > 0;
      const lower = (list: Candidate[]): Candidate[] =>
        list.map((c) =>
          c.certainty === 'certain'
            ? {
                ...c,
                certainty: 'probable' as const,
                reason: `${c.reason}, but the tree does not have them married to who the document says`,
              }
            : c,
        );
      return contradictory
        ? { first: lower(first), second: lower(second), event: null }
        : { first, second, event: null };
    }

    // The whole couple fits: both rise to certain, above what either name
    // would say on its own.
    const raise = (list: Candidate[]): Candidate[] =>
      list.map((c) =>
        c.event === shared.event
          ? {
              ...c,
              certainty: 'certain' as const,
              reason: `both spouses in the same ${c.event_type.toLowerCase()} of ${c.year}`,
            }
          : c,
      );

    return { first: raise(first), second: raise(second), event: shared.event };
  }
}

/** Role proposed for whoever gives the document its name. */
export function suggestedRole(recordType: string | null | undefined): string {
  return (recordType && ROLE_BY_RECORD_TYPE[recordType]) || 'other';
}
