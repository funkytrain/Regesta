# Contributing

Regesta was written for one archive and then generalised. That history
shows: the Spanish parish profile is the best tested part, and everything
else has been used less. Reports of what breaks on *your* archive are the
most useful thing you can send.

## The easiest contribution: a profile

A profile for another language or convention needs no code — a JSON file and
knowledge of your own archive. [profiles/README.md](profiles/README.md)
explains the fields, and `npm run detect-profile` gives you a draft to start
from.

Say in the pull request which archive you tested against and roughly how many
files. An untested profile is still worth having as an example; mark it with
a `_note`, as `en-parish` and `pt-parish` do.

## Reporting a problem

The useful details are the ones about your archive:

- A few real file names that were read wrongly, with what you expected.
- Which profile you used.
- The output of `npm run stats`, which says what the index actually holds.

File names often carry family names. Change them if you would rather — as
long as the *shape* survives, the report still works.

## Working on the code

```bash
npm install
npm test          # 168 tests
npm run typecheck
npm run dev       # http://localhost:8080
```

Tests run against real file names, typos included, because that is what the
parser has to survive. If you change parsing behaviour, add the file name
that motivated the change.

The web interface has no tests and no types. Changes there need checking in
a browser — most of the bugs found while translating this codebase were in
that layer, and none of them were visible to the compiler.

### A few conventions

**Comments explain why, not what.** The code says what it does. What it
cannot say is that the year range starts at 1400 because earlier parish
registers barely exist, or that a hash is truncated to 32 characters on
purpose. When you change such a decision, change its comment too — a stale
explanation is worse than none.

**Archive vocabulary belongs in a profile, never in the code.** If you find
yourself adding a Spanish word, a German abbreviation or a spelling rule to a
`.ts` file, it belongs in `profiles/` instead.

**The three rules in the README are not negotiable.** Originals are read-only,
Gramps is never written to, and the cataloguing work must always export to
open formats. A change that breaks one of these will not be merged, however
convenient it is.

## Translating the interface

The interface is English only, and there is no i18n layer. Adding one is a
reasonable proposal — open an issue before writing it, since where the
strings live affects everything else.

The Spanish user manual is kept at [docs/manual.es.md](docs/manual.es.md).
