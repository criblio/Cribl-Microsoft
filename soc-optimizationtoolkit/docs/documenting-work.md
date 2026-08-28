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

**THE BOARD IS DATA, since 2026-08-27.** `docs/board.json` is the source of
truth for what is in the backlog, what is in progress and what is done;
`docs/board.md` is GENERATED from it by `npm run board` and must never be
edited by hand. CI fails if the two disagree.

Why it changed: prose read well and groomed badly. There was no reliable way to
ask what is blocked on what, and the structural check could only see what a
regex could find - not even that, in the end. Two cards written
`**AZR-S1 (spike)**` put the type inside the bold, so the id pattern never
matched and BOTH spikes were invisible to every tool that read the board,
including the duplicate-id check itself. Moving to data is what surfaced them.

Each story carries an `id`, `epic`, `title`, `type`, `status`
(backlog / in-progress / done), a `priority` while it is in the backlog
(now / next / later), `settled` (settled / undecided / unconfirmed),
`verified` (pins / live / both / none), a `dependsOn` list, and `detail`.
`npm run check-board` validates all of it, and the dependency rules are the
ones prose could not enforce: no cycles, no dependency on a story that does not
exist, nothing in progress whose blocker is still in the backlog, and nothing
done that depends on something open.

**Cite backlog sections, not line numbers.** A card points into its reasoning
as `backlog.md#6g` - the numbered section - and `check-board` verifies that
section exists. Line numbers were tried and they rot: `backlog.md` grows by
insertion, so every number below the insertion moves. A count on 2026-08-28
found 7 of 39 line citations landing on blank lines and several pointing at the
wrong topic entirely, including one about dataflow diagrams that had drifted
into the agent-based section. A pointer that is silently wrong is worse than no
pointer, because it sends a reader to confidently read the wrong thing.

**Two checks, doing different jobs.** `check-board` proves `board.md` matches
`board.json` and that the data is coherent. It does NOT say the board still
describes the repo - only that it is internally consistent. That second question
is `check-board-freshness`, which runs on pull requests and says so when watched
source moved and `board.json` did not. It is a warning, not a gate: a rename or
a typo fix legitimately touches source without moving a card, and a check that
blocks on judgement gets routed around. What it must not be is silent, which is
what it was when the rule lived only in a local hook.

`settled` and `verified` are different axes and are easy to conflate. `settled`
is decision-confidence - whether anything is still undecided. `verified` is
evidence - how a finished story was confirmed. A story can be perfectly settled
and never verified. `verified` is REQUIRED once a story is done, optional
before it, and `none` is a legitimate answer for docs and process work: the
rule forces the question to be answered, not a particular answer to be given.

Be honest about its limits. A validator can check that the field is PRESENT; it
cannot check that it is TRUE, so this is a claim, and claims in this repo rot.
It earns its place because the failure it prevents kept recurring - GEN-1
closed on a live run against the deployed pack, GEN-2 on pins plus a five-pack
measurement, and the board rendered them identically. The evidence itself still
belongs in `backlog.md` and in the pins; the field only says which of those to
go and read.

JSON rather than YAML because every YAML parser is a dependency, `@soc/core`
carries zero runtime deps, and a docs tool is a poor reason to be the first to
add one. The cost lands on multi-line prose, which the renderer wraps.

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
