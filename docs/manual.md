# Regesta · user manual

Your genealogical archive, searchable and described. It runs on your own
machine and **never touches your original files**: it only reads them.

> Una versión en español de este manual está en
> [manual.es.md](manual.es.md).

---

## Contents

1. [First: the three rules](#first-the-three-rules)
2. [Home screen](#home-screen)
3. [Searching](#searching)
4. [The side browser](#the-side-browser)
5. [The document viewer](#the-document-viewer)
6. [Reading difficult handwriting](#reading-difficult-handwriting)
7. [Marking an entry inside the folio](#marking-an-entry-inside-the-folio)
8. [The classification scheme](#the-classification-scheme)
9. [Describing a document](#describing-a-document)
10. [Tags](#tags)
11. [Reviewing the suggested records](#reviewing-the-suggested-records)
12. [What is left to find](#what-is-left-to-find)
13. [Duplicates](#duplicates)
14. [Gramps](#gramps)
15. [Adding new documents](#adding-new-documents)
16. [Backups](#backups)
17. [Keyboard shortcuts](#keyboard-shortcuts)
18. [If something goes wrong](#if-something-goes-wrong)

---

## First: the three rules

**Your documents are not touched.** The folder is mounted read-only. This is
not a promise from the program: the operating system refuses the write.

**Gramps is read, never modified.** Regesta copies your tree and queries
the copy. Gramps can be open at the same time.

**Your work is exportable.** Everything you describe dumps to CSV and plain
text, readable without this application.

---

## Home screen

What the archive holds: how many documents, the range of years covered, how
many records are waiting to be reviewed, how many duplicate groups there are.
The counters are buttons — clicking one takes you there.

Below, the breakdown by record type and by format, then the latest documents
indexed.

This is also where you set the indexed folder and connect Gramps.

---

## Searching

The search box at the top looks in two places at once: the file names and the
text inside the documents.

### What you can type

- **A name.** `Isabel Perez` finds documents whose name contains it, and also
  the spelling variants your profile knows about — searching `Isabel` finds
  the `Ysabel` ones.
- **A phrase in quotes.** `"escribano de Ayora"` is searched literally, and
  only inside the document text. Useful for notarial records, where the name
  you want may never appear in the file name.
- **A year.** `1750` finds what is dated that year.

### The filters

Under the search box: record type, format, date range, and whether the record
still needs reviewing. They combine, and they survive while you move around,
so you can narrow down step by step.

### The preview

Resting the pointer on a card shows what does not fit on it: the full name,
the second spouse, which series it comes from, and whether there are
identical copies in other folders. If the document turned up because of its
content, the passage where your term appears is shown.

---

## The side browser

Three ways through the same material:

- **Folders** — the real structure on your disk, the one you already know.
- **Record types** — baptisms, marriages, burials, by century.
- **Tags** — your own marks.

Clicking a branch filters the list. The counts are cumulative: a folder also
counts what is in its subfolders.

### Handling it

Drag the divider to widen it — archive folder names tend to be long. The `E`
key collapses and expands it, and it remembers between sessions.

---

## The document viewer

Clicking a document opens it over the page, without losing your search. There
is a viewer for each format: images, PDF, plain text and Word.

### Moving around

`←` and `→` step through the results. `Backspace` goes back to the previous
document you were looking at, which is how you follow a person from one
record to the next.

### Searching inside the document

`F` opens the finder. It highlights every match and `Enter` steps through
them. In a PDF it works across all the pages, not just the one on screen.

If you arrived from a search, the viewer opens at the first match already.

---

## Reading difficult handwriting

The **Adjust** button opens the image tools. They change only what you see —
the file on disk is never modified.

### The shortcut that solves most cases

The **Reading** button (`L`) applies greyscale, high contrast and negative in
one go. Light ink on a dark background reads better than the other way round,
and this is the combination that rescues faded ink most often.

### The controls

| Control | What it is for |
|---|---|
| Contrast | The first thing to try on faded ink |
| Brightness | For photographs taken in poor light |
| Saturation | Lower it to stop the paper colour interfering |
| Sepia | Softens the glare of a white scan |
| Sharpen | Gives definition to a thin stroke. Do not overdo it |
| Threshold | Reduces everything to black and white |

**Threshold** deserves a note. It does not apply one cut to the whole image,
which never works on an archive photograph with half the page in shadow: it
computes a cut for each area from its own lighting (the Sauvola method). Move
the slider and wait a second — it is doing real work over millions of pixels.

Rotation, mirroring and **Reset everything** are at the bottom.

---

## Marking an entry inside the folio

A page of a parish register holds five or six entries. Marking the one you
care about saves finding it again every time you open the document.

Press **Mark entry** (`M`) and draw a box around it. Its panel opens: record
type, folio, date, place, abstract, transcription and notes.

The coordinates are stored as proportions, so the box stays in place whatever
zoom you use.

### Who appears in it

Under the entry, add each person with their **role** — subject, father,
godmother, witness — and a **certainty**:

- **certain** — the document says so plainly.
- **probable** — very likely, but you are inferring.
- **uncertain** — a hypothesis worth recording.

Probable and uncertain are shown differently on screen, so that in two years
you do not read your own guess as a fact.

If the person is in your Gramps tree, pick them from the list and the link is
kept. If they are not — a godparent who will never make it into the tree —
type the name and it is stored here only.

### Places

The place field suggests the ones you have already used and matches by
normalised key, so `Ayora` and `AYORA` are one place from the start. Two places
can be merged later, and the absorbed spelling is kept as a variant: how the
document named it is not lost.

---

## The classification scheme

An archival hierarchy: fonds, sections, series, items. It is seeded from your
folders, but it is yours from there on — create the fonds and series your
archive really has, describe them with the ISAD(G) fields, move them around,
and hang documents off them.

Deleting a unit never deletes documents: whatever hung off it moves up a
level.

---

## Describing a document

The **Describe** tab of the viewer, beside the image, because describing
happens while looking at the document.

If the record was read from the file name, the fields come pre-filled — you
are correcting, not typing. What you write here overrides what the indexer
deduced.

### Provenance

Where the document came from: source archive, its own reference code, the
date you consulted it, and whether it is your own photograph, a download or
an official copy. It can be assigned in bulk to a whole folder, because a
folder usually comes from a single visit.

---

## Tags

Free marks of your own: *reviewed*, *to cross-check*, *maternal line*,
*request a copy at the archive*. They are not an archival classification but
a way of working, which is why they live apart from the scheme. Create them
in the browser or from the viewer.

---

## Reviewing the suggested records

The indexer reads each file name and proposes a record. Most are right, so
reviewing is mostly confirming: the document and its record side by side, and
one key decides.

`Enter` accepts, `C` opens it for correction, `N` says it is not a record at
all, `→` skips it.

**Accept all the reliable ones at once** takes every record read with high
confidence. The doubtful ones still come through one at a time.

---

## What is left to find

The one screen that looks not at what you hold but at what is missing. It
crosses the facts in your Gramps tree with the documents linked to them and
lists the events with no record behind them.

Facts from the last 25 years are left out: archives apply closure periods and
those entries cannot be requested yet.

It is your work plan for the next archive visit.

---

## Duplicates

Groups of files with identical content, found by hash. Typically the same
document downloaded twice into different research folders.

It only finds byte-identical files. Two photographs of the same page taken
with different framing are not detected.

---

## Gramps

Regesta **reads** your tree to show context beside each document: the
person's identifier, their events, who took part, the citations already
recorded. It never writes to it.

### Connecting it

From the home screen, give the path to your Gramps `sqlite.db`. It is usually
at `%APPDATA%\gramps\grampsdb\<tree>\sqlite.db` on Windows, or
`~/.gramps/grampsdb/<tree>/sqlite.db` on Linux.

Regesta copies that file into its own data folder and queries the copy,
so Gramps can be open at the same time and nothing here can reach your tree.
A button refreshes the copy when the tree changes.

### Linking a document to a person

In the document record, search the tree by name and pick the person. The link
is stored in Regesta, never in Gramps.

The **People** screen does this in bulk: it proposes tree candidates for
whoever gives each document its name, using the date to tell namesakes apart.
Where the identification admits no doubt — a unique name and a matching date
— everything can be linked in one go.

---

## Adding new documents

Copy them into the indexed folder and they appear on their own, with their
thumbnail and their suggested record, within seconds.

If they do not, the file system notifications are not reaching the container
across the network. Set `REGESTA_POLLING` to `1` and it will poll the
disk instead.

Text inside new PDFs and Word files is picked up too. To re-extract
everything: `npm run index-text`.

---

## Backups

What is irreplaceable is your cataloguing work — the documents themselves are
still where they always were.

Back up the data folder (`data/` by default). It holds the database and the
thumbnails, and that is everything.

### A readable copy

**Export now** on the home screen dumps everything to CSV and plain text
beside the database: one row per document, the entries, who appears in each,
the places, the tags, the classification scheme, and a `.txt` per described
document for the long transcriptions.

Those files are readable with any spreadsheet or text editor, without
Regesta. That is the point: if in ten years this program no longer
starts, the work survives.

---

## Keyboard shortcuts

### In the viewer

| Key | Action |
|---|---|
| `←` `→` | Previous and next document |
| `+` `−` | Zoom in and out |
| `0` | Fit to the window |
| `F` | Find inside the document |
| `Enter` | Next match (`Shift+Enter`: previous) |
| `L` | Reading mode |
| `I` | Invert |
| `A` | Adjustments panel |
| `M` | Mark an entry |
| `R` | Reset the adjustments |
| `Backspace` | Back to the previous document |
| `Esc` | Close |

### In the review

| Key | Action |
|---|---|
| `Enter` | Accept |
| `C` | Correct |
| `N` | Not a record |
| `→` | Skip |
| `V` | View the document |

### General

| Key | Action |
|---|---|
| `E` | Collapse or expand the browser |

---

## If something goes wrong

**A document I just copied does not appear.** Folder watching may not be
getting notifications across a network share. Set `REGESTA_POLLING` to
`1` and restart, or press **Check for new documents** on the home screen to
force a sweep.

**Duplicates and suggestions to review keep piling up.** Older versions
indexed the copies inside Synology's `#snapshot` folder, one more set with every
snapshot. Rebuild the image: on its first start Regesta removes those copies and
logs how many, keeping any that carry your own work.

**The container shows as "unhealthy" and the log fills with `ENOSPC`.** The
system has run out of file watchers. Regesta skips Synology's `#snapshot`,
`@eaDir` and `#recycle` folders, and when watchers do run out it stops watching
and relies on the periodic sweep. If you still see this, you are running an
older version: rebuild the image (see the README).

**The record types come out as "Unclassified".** The archive profile does not
know your vocabulary. Run `npm run detect-profile -- --root "your/folder"`
and see [profiles/README.md](../profiles/README.md).

**A document shows an impossible year.** The file name holds a number that
looks like a date — a bundle reference code, a download identifier. It is
flagged rather than hidden, so you can correct it by hand.

**Gramps says the copy cannot be read.** Check that the path points at the
`sqlite.db` itself, not at the folder above it, and refresh the copy.

**The container cannot see my folder.** Only what you mount exists inside it.
Check the `volumes` section of `docker-compose.yml` and restart.
