-- Regesta · database schema
--
-- Guiding principle: this database describes documents, it never contains or
-- modifies them. The user's files live in their own storage and are mounted
-- read-only. If this .db file is lost, no document is lost; if it is kept,
-- all the cataloguing work is kept.
--
-- Genealogy proper (people, families, relationships) lives in Gramps. Only
-- pointers to its identifiers are stored here.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- AXIS 1 · Archival provenance: where the document is
-- ---------------------------------------------------------------------------

-- A node of the classification scheme. It nests into itself, so that fonds,
-- series, subseries and item are the same table at different depths, as in
-- ISAD(G).
CREATE TABLE IF NOT EXISTS unit (
  id             INTEGER PRIMARY KEY,
  parent_id      INTEGER REFERENCES unit(id) ON DELETE RESTRICT,
  level          TEXT NOT NULL CHECK (level IN (
                   'fonds', 'section', 'subsection', 'series', 'subseries',
                   'item', 'grouping'
                 )),
  -- ISAD(G) 3.1 · Identity statement area
  reference_code TEXT,
  title          TEXT NOT NULL,
  start_date     TEXT,             -- partial ISO-8601: '1802', '1802-05', '1802-05-14'
  end_date       TEXT,
  extent         TEXT,             -- extent and medium, e.g. '1 volume, 240 fols.'
  -- ISAD(G) 3.2 · Context area
  creator        TEXT,             -- who generated the records (the parish, the court)
  admin_history  TEXT,             -- administrative history or biography
  -- ISAD(G) 3.3 · Content and structure area
  scope_content  TEXT,             -- scope and content
  -- ISAD(G) 3.4 · Conditions of access and use area
  access         TEXT,
  medium         TEXT,
  condition      TEXT,
  -- ISAD(G) 3.6 · Notes area
  notes          TEXT,
  position       INTEGER NOT NULL DEFAULT 0,   -- to order siblings manually
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_unit_parent ON unit(parent_id, position);
CREATE INDEX IF NOT EXISTS idx_unit_reference_code ON unit(reference_code);

-- Where a document physically came from. Kept separate from `document`
-- because it is normally assigned in bulk: a whole folder comes from the same
-- visit to the same archive, so it is filled in once instead of a thousand
-- times.
CREATE TABLE IF NOT EXISTS provenance (
  id                  INTEGER PRIMARY KEY,
  name                TEXT NOT NULL,       -- 'Diocesan Archive, visit 2024-03'
  source_archive      TEXT,                -- the institution
  original_reference  TEXT,                -- the reference code THAT archive uses
  consulted_on        TEXT,
  acquisition         TEXT CHECK (acquisition IN (
                        'own_photo', 'download', 'donation', 'official_copy',
                        'purchase', 'unknown'
                      )),
  url                 TEXT,
  notes               TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- The actual files
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS document (
  id             INTEGER PRIMARY KEY,
  -- Path relative to the indexed root. Relative and not absolute so that the
  -- same database works on a desktop and on a NAS, where the root is mounted
  -- at a different point.
  path           TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,            -- the file name, verbatim
  extension      TEXT,
  mime           TEXT,
  bytes          INTEGER NOT NULL,
  -- Content fingerprint. It is the key to duplicate detection and to
  -- recognising a file the user has moved to another folder.
  hash           TEXT NOT NULL,
  pages          INTEGER,                  -- for PDFs
  width          INTEGER,                  -- for images
  height         INTEGER,
  thumbnail      TEXT,                     -- path of the generated thumbnail
  mtime          TEXT,                     -- modification time on disk
  unit_id        INTEGER REFERENCES unit(id) ON DELETE SET NULL,
  provenance_id  INTEGER REFERENCES provenance(id) ON DELETE SET NULL,
  -- State with respect to disk: a file that disappears is not deleted from
  -- the database, it is flagged, so that a disconnected drive does not cost
  -- the user their description.
  present        INTEGER NOT NULL DEFAULT 1,
  seen_at        TEXT NOT NULL DEFAULT (datetime('now')),
  indexed_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_document_hash ON document(hash);
CREATE INDEX IF NOT EXISTS idx_document_unit ON document(unit_id);
CREATE INDEX IF NOT EXISTS idx_document_present ON document(present);

-- What the indexer deduced from the file name, pending confirmation by the
-- user. Deliberately kept apart from `entry`: a guess made by the machine
-- must not be mixed with what the user has validated.
CREATE TABLE IF NOT EXISTS suggestion (
  id            INTEGER PRIMARY KEY,
  document_id   INTEGER NOT NULL REFERENCES document(id) ON DELETE CASCADE,
  record_type   TEXT,
  name          TEXT,                      -- full name exactly as it was read
  -- Second person in records that join two (marriages, licences).
  name_2        TEXT,
  year          INTEGER,
  page          INTEGER,                   -- the trailing ' 1', ' 2' of the name
  confidence    REAL NOT NULL DEFAULT 0,   -- 0..1
  warnings      TEXT,                      -- JSON: ['year_out_of_range', ...]
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'accepted', 'rejected')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  -- To undo review decisions (see migrate() in db.ts).
  decided_at    TEXT,
  batch         TEXT,
  copied        TEXT
);

CREATE INDEX IF NOT EXISTS idx_suggestion_doc ON suggestion(document_id);
CREATE INDEX IF NOT EXISTS idx_suggestion_status ON suggestion(status);

-- ---------------------------------------------------------------------------
-- AXIS 2 · Genealogical content: who the document is about
-- ---------------------------------------------------------------------------

-- A single register entry within a document. One folio may hold several.
CREATE TABLE IF NOT EXISTS entry (
  id            INTEGER PRIMARY KEY,
  document_id   INTEGER NOT NULL REFERENCES document(id) ON DELETE CASCADE,
  record_type   TEXT,                      -- baptism, marriage, burial...
  folio         TEXT,
  date          TEXT,                      -- partial ISO-8601
  place_id      INTEGER REFERENCES place(id) ON DELETE SET NULL,
  abstract      TEXT,                      -- short summary
  transcription TEXT,                      -- literal transcription
  notes         TEXT,
  -- Crop: the region of the document where this entry sits, stored as
  -- proportions (0..1) so it stays valid if the image resolution changes.
  crop_x        REAL,
  crop_y        REAL,
  crop_w        REAL,
  crop_h        REAL,
  crop_page     INTEGER,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_entry_doc ON entry(document_id);

-- Pointer to a person who lives in Gramps. Deliberately thin: no
-- relationships and no authoritative dates are stored here, because that data
-- belongs to Gramps and duplicating it would create two truths.
CREATE TABLE IF NOT EXISTS person (
  id            INTEGER PRIMARY KEY,
  gramps_id     TEXT UNIQUE,               -- 'I0042'
  name          TEXT NOT NULL,             -- normalised working form
  -- Match key: the name without diacritics, without spelling variants and
  -- without particles, so that 'YSABEL' can be matched with 'ISABEL'.
  match_key     TEXT,
  notes         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_person_match_key ON person(match_key);
CREATE INDEX IF NOT EXISTS idx_person_gramps ON person(gramps_id);

-- The spellings under which one and the same person appears in the documents.
-- In a corpus spanning 1552 to 1991 this is not a luxury: the same person is
-- 'Ysabel', 'Isabel' and 'Elisabet' depending on who held the pen.
CREATE TABLE IF NOT EXISTS name_variant (
  id         INTEGER PRIMARY KEY,
  person_id  INTEGER NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  spelling   TEXT NOT NULL,
  source     TEXT,                         -- where this spelling was recorded
  UNIQUE (person_id, spelling)
);

CREATE TABLE IF NOT EXISTS place (
  id            INTEGER PRIMARY KEY,
  gramps_id     TEXT,
  name          TEXT NOT NULL,
  match_key     TEXT,
  type          TEXT,                      -- parish, municipality, province...
  municipality  TEXT,
  province      TEXT,
  country       TEXT,
  notes         TEXT
);

CREATE INDEX IF NOT EXISTS idx_place_match_key ON place(match_key);

CREATE TABLE IF NOT EXISTS place_variant (
  id        INTEGER PRIMARY KEY,
  place_id  INTEGER NOT NULL REFERENCES place(id) ON DELETE CASCADE,
  spelling  TEXT NOT NULL,
  UNIQUE (place_id, spelling)
);

-- Joins a person to an entry stating what part they played. The `certainty`
-- field exists because in genealogy many attributions are probable rather
-- than certain, and without recording that, a hypothesis ends up read as a
-- fact.
CREATE TABLE IF NOT EXISTS link (
  id          INTEGER PRIMARY KEY,
  person_id   INTEGER NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  entry_id    INTEGER NOT NULL REFERENCES entry(id) ON DELETE CASCADE,
  role        TEXT NOT NULL,               -- subject, father, mother,
                                           -- godfather, witness, deceased...
  certainty   TEXT NOT NULL DEFAULT 'certain'
              CHECK (certainty IN ('certain', 'probable', 'uncertain')),
  notes       TEXT,
  UNIQUE (person_id, entry_id, role)
);

CREATE INDEX IF NOT EXISTS idx_link_person ON link(person_id);
CREATE INDEX IF NOT EXISTS idx_link_entry ON link(entry_id);

-- ---------------------------------------------------------------------------
-- Text extracted from the documents
-- ---------------------------------------------------------------------------

-- What is written inside a PDF, a .docx or a .txt. Kept apart from `document`
-- because it is bulky and almost never needed when listing.
--
-- It only collects text that is already digital: a scan with no text layer is
-- recorded with `no_text_layer = 1`, so that 'has no text' can be told apart
-- from 'has not been tried yet'.
CREATE TABLE IF NOT EXISTS document_text (
  document_id    INTEGER PRIMARY KEY REFERENCES document(id) ON DELETE CASCADE,
  text           TEXT NOT NULL,
  characters     INTEGER NOT NULL,
  pages          INTEGER,
  no_text_layer  INTEGER NOT NULL DEFAULT 0,
  -- Hash of the file at extraction time: if it changes, extraction must be
  -- redone.
  hash           TEXT NOT NULL,
  extracted_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_document_text_hash ON document_text(hash);

-- ---------------------------------------------------------------------------
-- Full-text search
-- ---------------------------------------------------------------------------

-- Single index over everything searchable. `content=''` makes it external: it
-- stores only the index, not a second copy of the text.
CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(
  title,
  text,
  kind UNINDEXED,          -- 'document' | 'unit' | 'entry' | 'person'
  ref_id UNINDEXED,
  tokenize = "unicode61 remove_diacritics 2"
);

-- A separate index for the contents of the documents. Kept apart from the
-- previous one so the user can be told whether the hit is in the file name or
-- inside the document, and so it can be rebuilt without touching the rest.
--
-- `content=''` makes it external: it stores the index, not a second copy of
-- the text, which already lives in `document_text`.
CREATE VIRTUAL TABLE IF NOT EXISTS document_search USING fts5(
  text,
  document_id UNINDEXED,
  tokenize = "unicode61 remove_diacritics 2"
);

-- ---------------------------------------------------------------------------
-- Document description
-- ---------------------------------------------------------------------------

-- What the user has described and validated about a document, as opposed to
-- what the machine deduced from the file name (`suggestion`). They are stored
-- separately on purpose: a guess and a confirmed fact must not be mixed, and
-- this way the file names can be re-read without overwriting work done by
-- hand.
CREATE TABLE IF NOT EXISTS description (
  document_id    INTEGER PRIMARY KEY REFERENCES document(id) ON DELETE CASCADE,
  -- Identity statement area
  title          TEXT,
  record_type    TEXT,
  date           TEXT,             -- partial ISO-8601: '1802', '1802-05-14'
  end_date       TEXT,             -- for units covering a period
  folio          TEXT,
  -- Content
  people         TEXT,             -- names exactly as they appear in the document
  place          TEXT,
  abstract       TEXT,             -- summary of the contents
  transcription  TEXT,
  notes          TEXT,
  -- Context and conservation (ISAD(G) 3.2 and 3.4)
  creator        TEXT,
  medium         TEXT,
  condition      TEXT,
  -- Provenance: where this particular file came from
  provenance_id  INTEGER REFERENCES provenance(id) ON DELETE SET NULL,
  reference_code TEXT,             -- the one used by the source archive
  -- The person in the Gramps tree the document refers to. The identifier
  -- only: genealogy lives in Gramps and is not copied here.
  gramps_id      TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_description_date ON description(date);
CREATE INDEX IF NOT EXISTS idx_description_record_type ON description(record_type);

-- ---------------------------------------------------------------------------
-- Tags
-- ---------------------------------------------------------------------------

-- Free-form marks made by the user: 'reviewed', 'to be cross-checked',
-- 'maternal line', 'request a copy at the archive'. They are not an archival
-- classification but a way of working, which is why they live apart from the
-- classification scheme.
CREATE TABLE IF NOT EXISTS tag (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  color      TEXT,                    -- one of the palette tones
  notes      TEXT,
  position   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS document_tag (
  document_id INTEGER NOT NULL REFERENCES document(id) ON DELETE CASCADE,
  tag_id      INTEGER NOT NULL REFERENCES tag(id) ON DELETE CASCADE,
  tagged_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (document_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_document_tag ON document_tag(tag_id);

-- ---------------------------------------------------------------------------
-- System state
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS setting (
  key    TEXT PRIMARY KEY,
  value  TEXT
);

-- A record of each indexer pass, so the user can be told what changed and
-- when.
CREATE TABLE IF NOT EXISTS index_run (
  id            INTEGER PRIMARY KEY,
  started_at    TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at   TEXT,
  root          TEXT NOT NULL,
  added         INTEGER NOT NULL DEFAULT 0,
  updated       INTEGER NOT NULL DEFAULT 0,
  moved         INTEGER NOT NULL DEFAULT 0,
  missing       INTEGER NOT NULL DEFAULT 0,
  errors        INTEGER NOT NULL DEFAULT 0,
  detail        TEXT
);
