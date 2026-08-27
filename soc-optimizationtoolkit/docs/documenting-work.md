# Documenting work

Status: Living - the rules `check-docs-drift.mjs` enforces. Change them here and there together.

Why this exists: on 2026-08-26 an audit found nine documents asserting things
the repo had already disproved. The pattern was not that docs go stale - every
doc goes stale. It was that **a stale record is harmless and a stale instruction
is dangerous**, and nothing here distinguished them.

The worst case was `features/content-preserving-native-reroute.md`: an unbuilt
plan, zero code, still telling a future reader to build for two shells six weeks
after ADR 0002 deleted the second one. Nobody had followed it yet, so nobody had
discovered it was wrong. A plan nobody has started is the one that gets followed
literally.

## Every document declares a status

The first lines carry `Status: <word>`, and the word decides whether the
document's instructions bind:

| Status | Means | Checked for |
|---|---|---|
| `Living` | Describes how things are now, and is kept true | retired paths, broken path references |
| `Proposed` | A plan not yet built | retired paths, and it EXPIRES |
| `Record` | A dated account of what happened | nothing |
| `Superseded` | Replaced, and says by what | that it names a successor |

**Prose may follow the word, and should.** `Status: Living - BINDING (user
directive 2026-08-10)` is better than `Status: Living`, because the sentence is
what a person actually needs. The word leads so the machine can read it; the
sentence follows so the reader still can.

**`Record` is the pressure valve, and using it is not a defeat.** A repo full of
history does not have to be rewritten, only labelled. Reach for it whenever a
document is an account rather than an instruction - which is most of them.

## Proposed plans expire

A `Proposed` document carries `Last-confirmed: YYYY-MM-DD` and must be re-read
within 60 days. A warning arrives at day 46; the build fails at day 61.

Clearing it is a real re-read, not a date bump. Two honest outcomes:

- Still the plan: correct whatever moved, and move `Last-confirmed` forward.
- Not the plan any more: change `Status` to `Record` and say what overtook it.

This is the rule that would have caught the reroute plan. It had been sitting
for eight weeks with nobody asking whether it still made sense.

## An ADR names what it breaks

Every ADR with `Status: Accepted` carries `Invalidates:` - a comma-separated
list of documents, or `none`. Each named document must mention the ADR.

ADR 0002 was written correctly and still left six documents describing a world
it had just ended, because nothing carried the decision out of the decision log.
Writing the decision is the easy half; reaching the documents it falsifies is
the half that gets skipped, so it is the half that is now enforced.

Deciding what to list: anything that gave an instruction the decision has just
made wrong. Not everything that mentions the subject.

## Live documents may quote history

Mark the line with `<!--drift-ok-->`:

```markdown
The Browse Samples modal is being removed <!--drift-ok--> and replaced by ...
```

`backlog.md` is the reason this exists - it states what is open now, so it is
`Living`, and its resolved sections still have to say what they resolved.

Every marker is counted and the total is printed on every run, clean or not. A
suppression nobody can see is how this check would quietly stop meaning
anything. If that number climbs, the question is whether the document should
have been split, not whether the check is too strict.

## Retiring something

The day you delete a path, add it to `RETIRED` in
`apps/cribl-app/scripts/check-docs-drift.mjs`. That is the only moment anyone
knows the whole list, and it converts "remember to update the docs" - which
nobody ever does - into a build failure naming the file and the line.

## Work items

Work lives in two places and they do not overlap:

- `backlog.md` - the reasoning, the measurements, the rejected alternatives.
- `board.md` - what is a unit of work, what state it is in, what it waits on.

A new item needs an ID, a type (bug / feature / chore / spike), one line of
evidence pointing at where the detail lives, and one distinction that matters
more than any of the others:

**Settled or undecided?** Settled means the call is made and only the work
remains. Undecided means no amount of effort finishes it, because a question is
open. The 2026-08-26 audit found eleven items blocked on a decision rather than
on effort, every one of them buried in prose where it read like work. Say which,
in the item, in as many words.

## Running it

```bash
npm run check-docs          # from soc-optimizationtoolkit/
```

It runs in CI on every pull request that touches the toolkit, and locally on
every documentation edit through `.claude/hooks/docs-drift-check.sh`. The hook
is convenience - `.claude/` is gitignored and travels with nobody. CI is the
gate.

The rules are pinned in `apps/cribl-app/scripts/check-docs-drift.test.mjs`, and
those pins are the 2026-08-26 audit turned into tests: each one is a document
that really existed in that state, so a regression is not hypothetical.
