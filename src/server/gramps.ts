/**
 * Reader for the Gramps tree.
 *
 * The rule that governs this module: **it only reads, and never the original
 * file**. Regesta copies the Gramps `sqlite.db` into its own folder and
 * queries the copy, so Gramps can be open at the same time and it is
 * impossible for this application to corrupt the family tree.
 *
 * Gramps is the authority on people; Regesta is the authority on
 * documents. Data is pulled in here only to be shown beside the document:
 * identifiers, notes, the participants of an event and the citations already
 * recorded.
 *
 * Format: Gramps stores each object serialised in `json_data` (JSON in recent
 * versions, Python pickle in older ones) and repeats some fields in columns
 * of their own so they can be indexed. The columns are preferred where they
 * exist, and the blob is only consulted for what is not broken out.
 */

import { DatabaseSync } from 'node:sqlite';
import { copyFile, mkdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface GrampsPerson {
  handle: string;
  gramps_id: string;
  name: string;
  surname: string;
  gender: number | null;
  /** '1871-1952' or 'b. 1871': tells apart namesakes from different eras. */
  dates?: string | null;
}

export interface GrampsEvent {
  handle: string;
  gramps_id: string;
  type: string;
  date: string | null;
  place: string | null;
  description: string | null;
  participants: Array<{ gramps_id: string; name: string; role: string }>;
  notes: string[];
  citations: Array<{ source: string; page: string | null }>;
}

/**
 * Gramps event types, by their numeric code.
 *
 * The values are those of `gramps.gen.lib.eventtype`. They were verified
 * against a real tree: 12 is Birth and 15 is Baptism, not what the alphabetic
 * order of the interface would suggest.
 */
const EVENT_TYPES: Record<number, string> = {
  '-1': 'Custom', 0: 'Unknown',
  1: 'Marriage', 2: 'Marriage Banns', 3: 'Marriage Contract',
  4: 'Marriage License', 5: 'Marriage Settlement', 6: 'Civil Union',
  7: 'Religious Marriage', 8: 'Divorce', 9: 'Divorce Filing',
  10: 'Annulment', 11: 'Alternate Marriage',
  12: 'Birth', 13: 'Death', 14: 'Adopted',
  15: 'Baptism', 16: 'Adult Christening', 17: 'Bar Mitzvah',
  18: 'Bas Mitzvah', 19: 'Burial', 20: 'Cause Of Death',
  21: 'Census', 22: 'Christening', 23: 'Confirmation',
  24: 'Adult Christening', 25: 'Cremation', 26: 'Degree',
  27: 'Education', 28: 'Elected', 29: 'Emigration',
  30: 'First Communion', 31: 'Immigration', 32: 'Graduation',
  33: 'Retirement', 34: 'Naturalization', 35: 'Nobility Title',
  36: 'Number of Marriages', 37: 'Occupation', 38: 'Ordination',
  39: 'Probate', 40: 'Property', 41: 'Religion',
  42: 'Residence', 43: 'Will', 44: 'Blessing',
  45: 'Burial', 46: 'Physical Description', 47: 'Military Service',
  48: 'Inheritance',
};

/** Roles of a participant in an event. */
const ROLES: Record<number, string> = {
  1: 'Primary', 2: 'Bride/Groom', 3: 'Witness', 4: 'Family',
  5: 'Groom', 6: 'Bride', 7: 'Godfather', 8: 'Godmother',
  9: 'Celebrant', 10: 'Informant', 11: 'Clerk',
};

/**
 * Strips diacritics and lowercases, so names can be compared.
 *
 * Needed because the SQLite LIKE operator is only case-insensitive over
 * ASCII: without this, searching for 'fernandez' would not find 'Fernandez'
 * spelled with an accent.
 */
function stripDiacritics(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

/** Gender in Gramps: 0 female, 1 male, 2 unknown. */
export const GENDERS: Record<number, string> = { 0: 'Female', 1: 'Male', 2: 'Unknown' };

/**
 * Decodes the Gramps `json_data`.
 *
 * Recent versions store JSON; older ones store a Python pickle, which is not
 * interpreted. Returns null instead of throwing, because an unreadable blob
 * must not stop the column data from being displayed.
 */
function readBlob(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  try {
    const text =
      typeof value === 'string'
        ? value
        : new TextDecoder('utf-8', { fatal: false }).decode(value as Uint8Array);
    const trimmed = text.trim();
    if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) return null;
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

export class GrampsReader {
  private db: DatabaseSync | null = null;
  /** Columns present in each table, so the reader adapts to the version. */
  private columnsByTable = new Map<string, Set<string>>();
  /**
   * Events already resolved. Walking the whole tree takes several seconds and
   * its content only changes when the copy is refreshed, so it is cached.
   */
  private eventCache: ReturnType<GrampsReader['computeEventsWithPerson']> | null = null;

  constructor(private readonly copyPath: string) {}

  /**
   * Copies the Gramps sqlite.db and opens the copy.
   *
   * It is copied rather than opened in place because Gramps may have it open,
   * and because that way no failure of this application can reach it.
   */
  async refresh(sourcePath: string): Promise<{ copied_at: string; bytes: number }> {
    const info = await stat(sourcePath);
    await mkdir(dirname(this.copyPath), { recursive: true });
    this.close();
    await copyFile(sourcePath, this.copyPath);
    return { copied_at: new Date().toISOString(), bytes: info.size };
  }

  open(): boolean {
    if (this.db) return true;
    try {
      this.db = new DatabaseSync(this.copyPath, { readOnly: true });
      this.columnsByTable.clear();
      // The copy may be a different one: anything computed over the
      // previous copy no longer holds.
      this.eventCache = null;
      return true;
    } catch {
      this.db = null;
      return false;
    }
  }

  close(): void {
    try {
      this.db?.close();
    } catch {
      /* it was already closed */
    }
    this.db = null;
  }

  /** Columns of a table; empty set if the table does not exist. */
  private cols(table: string): Set<string> {
    if (this.columnsByTable.has(table)) return this.columnsByTable.get(table)!;
    let set = new Set<string>();
    try {
      const rows = this.db!.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      set = new Set(rows.map((f) => f.name));
    } catch {
      /* table absent in this version */
    }
    this.columnsByTable.set(table, set);
    return set;
  }

  private hasTable(table: string): boolean {
    return this.cols(table).size > 0;
  }

  /** Summary of the tree, to tell whether the copy is usable. */
  summary(): { people: number; families: number; events: number; citations: number } | null {
    if (!this.open()) return null;
    const count = (t: string): number => {
      if (!this.hasTable(t)) return 0;
      try {
        return (this.db!.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
      } catch {
        return 0;
      }
    };
    return {
      people: count('person'),
      families: count('family'),
      events: count('event'),
      citations: count('citation'),
    };
  }

  /**
   * Searches people by name. Used to link a document to the Gramps person it
   * refers to.
   */
  searchPeople(query: string, limit = 20): GrampsPerson[] {
    if (!this.open() || !this.hasTable('person')) return [];

    const cols = this.cols('person');
    // Gramps has stored the name in separate columns since 5.x; in earlier
    // versions it has to be pulled out of the blob.
    const hasNameColumns = cols.has('given_name') && cols.has('surname');

    try {
      if (hasNameColumns) {
        // The SQLite LIKE operator is only case-insensitive over ASCII, and
        // these names carry accents and other non-ASCII letters. Filtering
        // happens in memory with the same normalisation the rest of the
        // search uses, so that an unaccented query still finds the accented
        // spelling.
        const rows = this.db!.prepare(
          `SELECT handle, gramps_id, given_name, surname${cols.has('gender') ? ', gender' : ''}
           FROM person ORDER BY surname, given_name`,
        ).all() as Array<{
          handle: string;
          gramps_id: string;
          given_name: string;
          surname: string;
          gender?: number;
        }>;

        const needle = stripDiacritics(query);
        const out: GrampsPerson[] = [];
        for (const f of rows) {
          const full = stripDiacritics(`${f.given_name ?? ''} ${f.surname ?? ''}`);
          if (!full.includes(needle)) continue;
          out.push({
            handle: f.handle,
            gramps_id: f.gramps_id,
            name: f.given_name ?? '',
            surname: f.surname ?? '',
            gender: f.gender ?? null,
            // The years tell namesakes apart, which within one family are
            // the rule rather than the exception.
            dates: this.datesOf(f.handle),
          });
          if (out.length >= limit) break;
        }
        return out;
      }

      // Blob walk: slower, but only needed on old trees.
      const rows = this.db!.prepare('SELECT handle, gramps_id, json_data FROM person LIMIT 5000')
        .all() as Array<{ handle: string; gramps_id: string; json_data: unknown }>;

      const needle = query.toLowerCase();
      const out: GrampsPerson[] = [];
      for (const f of rows) {
        const o = readBlob(f.json_data) as { primary_name?: { first_name?: string } } | null;
        const givenName = o?.primary_name?.first_name ?? '';
        if (givenName.toLowerCase().includes(needle)) {
          out.push({ handle: f.handle, gramps_id: f.gramps_id, name: givenName, surname: '', gender: null });
          if (out.length >= limit) break;
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  /**
   * Birth and death years of a person, in short form.
   *
   * This is what tells namesakes apart: within one family the same names
   * recur for generations, and without the years there is no way to know
   * which one a document refers to.
   */
  private datesOf(handle: string): string | null {
    if (!this.hasTable('event')) return null;

    try {
      const p = this.db!.prepare('SELECT json_data FROM person WHERE handle = ?').get(handle) as
        | { json_data: unknown }
        | undefined;
      const o = readBlob(p?.json_data) as
        | {
            event_ref_list?: Array<{ ref?: string }>;
            birth_ref_index?: number;
            death_ref_index?: number;
          }
        | null;

      const refs = o?.event_ref_list ?? [];
      // Gramps stores the position of birth and death within the event
      // list, so there is no need to walk all of them.
      const yearOf = (idx: number | undefined): string | null => {
        if (idx === undefined || idx < 0 || !refs[idx]?.ref) return null;
        const e = this.db!.prepare('SELECT json_data FROM event WHERE handle = ?').get(
          refs[idx]!.ref,
        ) as { json_data: unknown } | undefined;
        const fecha = dateText((readBlob(e?.json_data) as { date?: unknown } | null)?.date);
        return fecha ? fecha.slice(0, 4) : null;
      };

      const born = yearOf(o?.birth_ref_index);
      const died = yearOf(o?.death_ref_index);

      if (born && died) return `${born}–${died}`;
      if (born) return `b. ${born}`;
      if (died) return `†${died}`;
      return null;
    } catch {
      return null;
    }
  }

  /** A person by their Gramps identifier (I0042). */
  person(grampsId: string): GrampsPerson | null {
    if (!this.open() || !this.hasTable('person')) return null;
    const cols = this.cols('person');

    try {
      const f = this.db!.prepare(
        `SELECT handle, gramps_id${cols.has('given_name') ? ', given_name, surname' : ''}${
          cols.has('gender') ? ', gender' : ''
        } FROM person WHERE gramps_id = ?`,
      ).get(grampsId) as
        | { handle: string; gramps_id: string; given_name?: string; surname?: string; gender?: number }
        | undefined;
      if (!f) return null;

      return {
        handle: f.handle,
        gramps_id: f.gramps_id,
        name: f.given_name ?? '',
        surname: f.surname ?? '',
        gender: f.gender ?? null,
        dates: this.datesOf(f.handle),
      };
    } catch {
      return null;
    }
  }

  /**
   * Events of a person, with their participants, notes and citations.
   *
   * This is what is shown beside the document: if this record is a given
   * person's baptism, see what Gramps says about that baptism and who else
   * appears in it.
   */
  eventsOfPerson(handle: string): GrampsEvent[] {
    if (!this.open() || !this.hasTable('event')) return [];

    try {
      // The person-event relation lives in the person blob.
      const p = this.db!.prepare('SELECT json_data FROM person WHERE handle = ?').get(handle) as
        | { json_data: unknown }
        | undefined;
      const obj = readBlob(p?.json_data) as { event_ref_list?: Array<{ ref?: string; role?: unknown }> } | null;
      const refs = obj?.event_ref_list ?? [];

      const events: GrampsEvent[] = [];
      for (const ref of refs.slice(0, 40)) {
        if (!ref?.ref) continue;
        const e = this.event(ref.ref);
        if (e) events.push(e);
      }
      return events;
    } catch {
      return [];
    }
  }

  /** An event with all its context. */
  event(handle: string): GrampsEvent | null {
    if (!this.open() || !this.hasTable('event')) return null;

    try {
      const cols = this.cols('event');
      const f = this.db!.prepare(
        `SELECT handle, gramps_id, json_data${cols.has('place') ? ', place' : ''} FROM event WHERE handle = ?`,
      ).get(handle) as
        | { handle: string; gramps_id: string; json_data: unknown; place?: string }
        | undefined;
      if (!f) return null;

      const o = readBlob(f.json_data) as Record<string, unknown> | null;

      return {
        handle: f.handle,
        gramps_id: f.gramps_id,
        type: typeName(o?.type),
        date: dateText(o?.date),
        // The `place` column is more direct than digging through the blob.
        place: this.placeName((f.place ?? o?.place) as string | undefined),
        description: (o?.description as string) || null,
        participants: this.participants(handle),
        notes: this.notesOf(o?.note_list as string[] | undefined),
        citations: this.citationsOf(o?.citation_list as string[] | undefined),
      };
    } catch {
      return null;
    }
  }

  /** Who appears in an event and in what role. */
  private participants(eventHandle: string): Array<{ gramps_id: string; name: string; role: string }> {
    if (!this.hasTable('person')) return [];

    try {
      // There is no join table: one has to look at which people reference
      // the event. The walk is capped so large trees are not penalised.
      const rows = this.db!.prepare(
        `SELECT p.gramps_id, p.json_data${this.cols('person').has('given_name') ? ', p.given_name, p.surname' : ''}
         FROM person p WHERE p.json_data LIKE ? LIMIT 25`,
      ).all(`%${eventHandle}%`) as Array<{
        gramps_id: string;
        json_data: unknown;
        given_name?: string;
        surname?: string;
      }>;

      const out: Array<{ gramps_id: string; name: string; role: string }> = [];
      for (const f of rows) {
        const o = readBlob(f.json_data) as { event_ref_list?: Array<{ ref?: string; role?: unknown }> } | null;
        const ref = o?.event_ref_list?.find((r) => r?.ref === eventHandle);
        if (!ref) continue;

        out.push({
          gramps_id: f.gramps_id,
          name: [f.given_name, f.surname].filter(Boolean).join(' ') || f.gramps_id,
          role: roleName(ref.role),
        });
      }
      return out;
    } catch {
      return [];
    }
  }

  private placeName(handle: string | undefined): string | null {
    if (!handle || !this.hasTable('place')) return null;
    try {
      const cols = this.cols('place');
      if (cols.has('title')) {
        const f = this.db!.prepare('SELECT title FROM place WHERE handle = ?').get(handle) as
          | { title: string }
          | undefined;
        if (f?.title) return f.title;
      }
      const f = this.db!.prepare('SELECT json_data FROM place WHERE handle = ?').get(handle) as
        | { json_data: unknown }
        | undefined;
      const o = readBlob(f?.json_data) as { title?: string; name?: { value?: string } } | null;
      return o?.title || o?.name?.value || null;
    } catch {
      return null;
    }
  }

  private notesOf(handles: string[] | undefined): string[] {
    if (!handles?.length || !this.hasTable('note')) return [];
    const out: string[] = [];
    for (const h of handles.slice(0, 8)) {
      try {
        const f = this.db!.prepare('SELECT json_data FROM note WHERE handle = ?').get(h) as
          | { json_data: unknown }
          | undefined;
        const o = readBlob(f?.json_data) as { text?: { string?: string } | string } | null;
        const text = typeof o?.text === 'string' ? o.text : o?.text?.string;
        if (text) out.push(text.slice(0, 1200));
      } catch {
        /* unreadable note: skipped */
      }
    }
    return out;
  }

  private citationsOf(handles: string[] | undefined): Array<{ source: string; page: string | null }> {
    if (!handles?.length || !this.hasTable('citation')) return [];
    const out: Array<{ source: string; page: string | null }> = [];

    for (const h of handles.slice(0, 10)) {
      try {
        const c = this.db!.prepare('SELECT json_data FROM citation WHERE handle = ?').get(h) as
          | { json_data: unknown }
          | undefined;
        const o = readBlob(c?.json_data) as { page?: string; source_handle?: string } | null;

        let source = '(untitled source)';
        if (o?.source_handle && this.hasTable('source')) {
          const cols = this.cols('source');
          if (cols.has('title')) {
            const s = this.db!.prepare('SELECT title FROM source WHERE handle = ?').get(
              o.source_handle,
            ) as { title: string } | undefined;
            if (s?.title) source = s.title;
          }
        }
        out.push({ source, page: o?.page || null });
      } catch {
        /* unreadable citation: skipped */
      }
    }
    return out;
  }

  /**
   * Every event in the tree, with the person it belongs to.
   *
   * This is the basis of the gaps panel: crossing it with the linked
   * documents reveals which facts in the tree have no record backing them up,
   * which is precisely what is left to look for in the archives.
   *
   * The relation runs from person to event, not the other way round, so the
   * people are walked and their references resolved.
   */
  eventsWithPerson(): ReturnType<GrampsReader['computeEventsWithPerson']> {
    this.eventCache ??= this.computeEventsWithPerson();
    return this.eventCache;
  }

  private computeEventsWithPerson(): Array<{
    event_id: string;
    type: string;
    type_code: number;
    date: string | null;
    year: number | null;
    place: string | null;
    person_id: string;
    person: string;
    citations: number;
  }> {
    if (!this.open() || !this.hasTable('event') || !this.hasTable('person')) return [];

    try {
      // Events are loaded into memory in one go: twelve thousand rows are
      // few, and querying them one by one would be far slower.
      const events = new Map<
        string,
        { gramps_id: string; type: string; code: number; date: string | null; place: string | null; citations: number }
      >();

      const eventCols = this.cols('event');
      for (const f of this.db!.prepare(
        `SELECT handle, gramps_id, json_data${eventCols.has('place') ? ', place' : ''} FROM event`,
      ).all() as Array<{ handle: string; gramps_id: string; json_data: unknown; place?: string }>) {
        const o = readBlob(f.json_data) as Record<string, unknown> | null;
        const rawType = o?.type as { value?: number } | undefined;

        events.set(f.handle, {
          gramps_id: f.gramps_id,
          type: typeName(o?.type),
          code: rawType?.value ?? -1,
          date: dateText(o?.date),
          place: this.placeName((f.place ?? o?.place) as string | undefined),
          citations: (o?.citation_list as string[] | undefined)?.length ?? 0,
        });
      }

      const personCols = this.cols('person');
      const out: Array<{
        event_id: string;
        type: string;
        type_code: number;
        date: string | null;
        year: number | null;
        place: string | null;
        person_id: string;
        person: string;
        citations: number;
      }> = [];

      // Keyed by handle so the spouses of each family can be resolved
      // later; Gramps references them by handle and not by gramps_id.
      const people = new Map<string, { gramps_id: string; name: string }>();

      for (const f of this.db!.prepare(
        `SELECT handle, gramps_id, json_data${personCols.has('given_name') ? ', given_name, surname' : ''} FROM person`,
      ).all() as Array<{
        handle: string;
        gramps_id: string;
        json_data: unknown;
        given_name?: string;
        surname?: string;
      }>) {
        const o = readBlob(f.json_data) as { event_ref_list?: Array<{ ref?: string }> } | null;
        const fullName = [f.given_name, f.surname].filter(Boolean).join(' ') || f.gramps_id;
        people.set(f.handle, { gramps_id: f.gramps_id, name: fullName });

        for (const ref of o?.event_ref_list ?? []) {
          const e = ref?.ref ? events.get(ref.ref) : undefined;
          if (!e) continue;

          out.push({
            event_id: e.gramps_id,
            type: e.type,
            type_code: e.code,
            date: e.date,
            year: e.date ? Number(e.date.slice(0, 4)) || null : null,
            place: e.place,
            person_id: f.gramps_id,
            person: fullName,
            citations: e.citations,
          });
        }
      }

      // Marriages hang off the family, not the person: without this pass not
      // a single one would show up, because nothing references them from
      // `person`. Each event is attributed to both spouses.
      if (this.hasTable('family')) {
        for (const f of this.db!.prepare('SELECT json_data FROM family').all() as Array<{
          json_data: unknown;
        }>) {
          const o = readBlob(f.json_data) as {
            event_ref_list?: Array<{ ref?: string }>;
            father_handle?: string | null;
            mother_handle?: string | null;
          } | null;
          if (!o?.event_ref_list?.length) continue;

          const spouses = [o.father_handle, o.mother_handle]
            .map((h) => (h ? people.get(h) : undefined))
            .filter((p): p is { gramps_id: string; name: string } => p !== undefined);
          if (spouses.length === 0) continue;

          for (const ref of o.event_ref_list) {
            const e = ref?.ref ? events.get(ref.ref) : undefined;
            if (!e) continue;

            for (const c of spouses) {
              out.push({
                event_id: e.gramps_id,
                type: e.type,
                type_code: e.code,
                date: e.date,
                year: e.date ? Number(e.date.slice(0, 4)) || null : null,
                place: e.place,
                person_id: c.gramps_id,
                person: c.name,
                citations: e.citations,
              });
            }
          }
        }
      }

      return out;
    } catch {
      return [];
    }
  }
}

/* ---------- Formatting helpers ---------- */

function typeName(tipo: unknown): string {
  if (Array.isArray(tipo)) {
    const [code, text] = tipo as [number, string];
    return EVENT_TYPES[code] ?? text ?? 'Event';
  }
  if (typeof tipo === 'object' && tipo !== null) {
    const o = tipo as { value?: number; string?: string };
    return EVENT_TYPES[o.value ?? -1] ?? o.string ?? 'Event';
  }
  return 'Event';
}

function roleName(role: unknown): string {
  if (Array.isArray(role)) {
    const [code, text] = role as [number, string];
    return ROLES[code] ?? text ?? 'Participant';
  }
  if (typeof role === 'object' && role !== null) {
    const o = role as { value?: number; string?: string };
    return ROLES[o.value ?? -1] ?? o.string ?? 'Participant';
  }
  return 'Participant';
}

/**
 * Gramps date to text.
 *
 * Its structure stores day, month and year separately, with a zero where the
 * value is not recorded: in old registers it is common to know only the year.
 */
function dateText(fecha: unknown): string | null {
  if (!fecha) return null;

  // Gramps structure: { dateval: [day, month, year, modifier], text: '...' }.
  // A zero means 'not recorded', which is frequent in old registers: many
  // entries give only the year.
  const o = fecha as { dateval?: unknown; text?: string };
  const val = Array.isArray(fecha) ? (fecha as unknown[])[3] : o.dateval;

  if (Array.isArray(val) && val.length >= 3) {
    const day = Number(val[0]) || 0;
    const month = Number(val[1]) || 0;
    const year = Number(val[2]) || 0;

    if (!year) return o.text?.trim() || null;

    const parts = [String(year).padStart(4, '0')];
    if (month) {
      parts.push(String(month).padStart(2, '0'));
      if (day) parts.push(String(day).padStart(2, '0'));
    }
    return parts.join('-');
  }

  return o.text?.trim() || null;
}

/** Paths where Gramps usually keeps its trees, by platform. */
export function commonPaths(): string[] {
  const home = process.env.APPDATA ?? process.env.HOME ?? '';
  return [
    join(home, 'gramps', 'grampsdb'),
    join(process.env.HOME ?? '', '.gramps', 'grampsdb'),
    '/datos/gramps',
  ];
}
