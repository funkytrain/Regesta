# Archive profiles

A profile is the vocabulary of one archive: which words name a baptism, which
misspellings to tolerate, which letters count as the same when matching
names. It is a JSON file. Writing one needs no code and no TypeScript — it
needs knowledge of your own archive, which you have and the program does not.

The parser itself is shared and knows nothing about any language. It splits a
file name into fields, finds the year, tells a page number from a date and
weighs how reliable the reading is. Everything language-specific is here.

## The short way

```bash
npm run detect-profile -- --root "/path/to/your/archive"
```

It reads your file names, works out the convention and writes a draft to
`profiles/my-archive.json`. Run against a real archive of 1,824 files it
found the separator, that the year sits at the end, the range 1552–1991, and
the record types with their frequencies — including three genuine typos that
it spotted by how close they were to a frequent word.

It will not guess your spelling rules. Those need knowledge of the language
and the period, and a wrong rule silently merges two people who are not the
same. It leaves them empty, which is safe: names are then matched literally.

The draft names its record types `unknown_bautismo` and so on, because the
machine can see that a word repeats but not what it means. Renaming those is
the one thing you have to do by hand.

## The fields

### `recordTypes`

Maps the words your files actually use onto the canonical types Regesta
understands: `baptism`, `birth`, `marriage`, `marriage_licence`, `burial`,
`confirmation`, `nuptial_blessing`, `census`, `index`, `record`.

```jsonc
"baptism": {
  "match": ["BAUTISMO", "BAUTISMOS"],   // correct spellings
  "typos": ["BAUTIZO", "BAUUTISMO"]     // real misspellings in your files
}
```

Typos are accepted and flagged for review, rather than rejected. Correcting
a thousand files to please a parser would be working for the machine.

Longer spellings are tried first, so `EXPEDIENTE MATRIMONIAL` is never
swallowed by `MATRIMONIO`. Matching ignores case and tolerates extra spaces.

**`burial`, not `death`.** What a parish register holds is the burial entry;
the date of death is a different fact. Gramps draws the same distinction.

### `matchKeyRules`

The heart of it, and the part worth thinking about.

In a corpus spanning four centuries the same person is written `YSABEL`,
`ISABEL` and `ELISABET` depending on who held the pen. These rules fold those
spellings into one key, used only for matching — what is displayed always
keeps the document's own spelling, because that is historical evidence.

```jsonc
{ "from": "PH", "to": "F", "why": "Josepha -> Josefa" }
```

Order matters, and it is the order in the file. Consonant clusters before
vowels, so that `JUSEPHA` reaches `JOSEFA` instead of stopping halfway.

`from` is a JavaScript regular expression, applied to the name already
uppercased and stripped of diacritics. `\b` anchors it to the start of a
word: `\bY(?=[AEIOU])` catches the initial Y of `YSABEL` without touching the
Y inside `REYES`.

Always fill in `why`, with an example. It is not decoration: it is what lets
somebody else write their profile by analogy instead of blindly, and what
tells you in two years why you added a rule.

**Be conservative.** A rule that is too broad merges two different families
in silence, and that is worse than not matching at all. Add one, index, look
at what it matched, then add the next.

### `joiners`

The words separating the two people of a marriage: `Y`, `AND`, `E`, `CON`.
The parser only splits when both sides have enough text left, so a name
beginning with the joiner does not break the reading.

Do not put nobiliary particles here (`DE`, `VAN`, `DELLA`). They sit between
two names just as often and would cut a single person in half.

### `userMarks`

Prefixes you put on a file to flag it yourself: `POSSIBLE`, `CHECK`. They are
stripped from the name, and the record is flagged for review.

### `notRecords`

Patterns of names that are not documents at all — screenshots, camera files,
offprints. Without these, `IMG_20240101.jpg` becomes a certificate from the
year 2024.

### `yearRange`

Lowest and highest plausible year. `"max": "current"` means the present year.
A value outside the range is kept but flagged: a baptism in 1165 is almost
always a mistyped digit, and discarding it silently would lose the file.

### `roles`

The parts a person can play in an entry, most frequent first — that is the
order they appear in the interface. A civil registry has no godparents; a
notarial archive has grantors rather than spouses. Trim the list to yours.

## Checking it works

```bash
REGESTA_PROFILE=my-archive npm run index -- --root "/path/to/archive" --db test.db
REGESTA_PROFILE=my-archive npm run stats test.db
```

Look at the record type breakdown and the date range. If the counts are
plausible and the years fall where you expect, the profile is reading your
files. Then open the application and check the review queue: the readings it
proposes tell you the rest.

Indexing into a separate `--db` means you can throw the result away and try
again without losing anything.

## Contributing a profile

Profiles for other languages and conventions are welcome, and they are the
easiest way to contribute: a JSON file, no code.

Say in the pull request which archive you tested it against and roughly how
many files, so others know how much to trust it. An untested profile is still
useful as an example — mark it as such in a `_note` field, as `en-parish` and
`pt-parish` do.
