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

**The hierarchy is SAFe (Essential level), since 2026-08-28.** Epic > Feature >
Story, with Tasks under a story. `epics[]` carries a `kind`: a **business** epic
delivers value, an **enabler** epic exists to unblock other epics - CAP is the
textbook case, described on its own card as "the single upstream blocker for
three other epics". `features[]` sit under one epic and hold the work; most were
derived from the numbered sections of `backlog.md`, which had been acting as
features already, and carry that `anchor`.

Types are SAFe's, not the old `chore` vocabulary: `story` changes what an
operator sees, `enabler` is infrastructure/tooling/docs/release mechanics,
`spike` is SAFe's exploration enabler (answered by investigation, never by
preference), `bug` is a defect, and `decision` is a LOCAL extension for a
question a person answers, attached to the feature it blocks. There is no
separate decisions epic: a decision belongs to the feature it is holding up.

**Features are groupings, not a queue - they carry no score.** SAFe sequences
features with WSJF, `(business value + time criticality + risk reduction) / job
size` on a modified Fibonacci scale. It was built here on 2026-08-28 and removed
the same day, and the reason is recorded so it does not get re-added as a
missing piece of SAFe: WSJF is an economic answer to CONTENTION - many features
competing for one team's finite capacity, where choosing wrong costs the delay
on everything else waiting. There is one author here, moving between features
rather than draining them in order, so there is no queue to sequence and the
score would have been four invented numbers per feature, re-invented whenever
anything moved.

What sequences work instead is what the data can actually support: `priority`
(now / next / later) on the stories, plus what `npm run groom` derives -
readiness, and how many cards each one transitively unblocks. If a second
developer ever works here, contention becomes real and WSJF is worth revisiting.

**Every feature names a MENU ITEM, since 2026-08-28.** `menu` says which part
of the product a card is about, using the app's own route ids copied from the
nav registration in `App.tsx` - so the vocabulary cannot describe a screen the
app does not have. The tag exists because the question most often asked of this
board is "what is left before Sentinel Integration works end to end", and
before this the only way to ask it was to read every card.

It lives on the FEATURE and stories inherit, for the same reason `epic` does:
26 features are maintainable by hand and 81 stories are not, and a feature
spanning two menus usually wants splitting. A story may override when it
genuinely differs - a fallback offer landing on the Integrate deploy while its
feature is about the capability audit - and `check-board` rejects an override
that merely restates its feature's menu, because a second copy of a fact is a
second thing to keep in step.

Two values name screens nobody can open yet, `azure-onboarding` and
`windows-events`, and they render as PLANNED so a rollup cannot imply a route
exists. `none` is for work no operator sees on any screen - release mechanics,
docs, the board's own tooling - and it is not a synonym for "unsure": if a card
changes what an operator sees anywhere, it has a menu.

`npm run groom -- integrate` narrows grooming to one menu. It pulls in blockers
from OTHER menus and names them, because a card outside the menu that gates one
inside it is exactly what an end-to-end push needs to know; dropping it would
report a goal as ready when it is not.

Each story carries an `id`, `epic`, `feature`, `title`, `type`, `status`
(backlog / in-progress / done), a `priority` while it is in the backlog
(now / next / later), `settled` (settled / undecided / unconfirmed),
`verified` (pins / live / both / none), a `dependsOn` list, and `detail`.
`npm run check-board` validates all of it, and the dependency rules are the
ones prose could not enforce: no cycles, no dependency on a story that does not
exist, nothing in progress whose blocker is still in the backlog, and nothing
done that depends on something open.

**A defect found in COMMITTED code becomes a card before it is fixed** - even
when the fix takes five minutes, and even when you are going to do it right now.
File it, move it to `in-progress`, fix it, move it to `done` with a `verified`
value. A card opened and closed inside one session is not churn; it is the only
way the work is visible to anyone who was not watching.

The line is *committed*. A defect you introduce and fix while drafting, before
committing, is editing and needs no card - otherwise ordinary work becomes board
noise and people learn to skip the rule entirely. Anything found by a test, a
review, an architecture audit, or a live walkthrough of code that is already in
is over the line, including defects in the board's own tooling and in
`board.json` itself.

Measured on 2026-08-28: six defects were found and fixed that day with no card
at all - two duplicated vocabularies, a disagreement about what "blocked" means,
a report that cried wolf, a gitignore hiding this repo's own skills, and two
cards asserting things the code disproved. All six lived only in commit
messages. They are now DBT-16 to DBT-21, filed as done and dated, because a Done
column that shows two defects when the day produced eight is not a record of the
day.

**Move the card to `in-progress` BEFORE starting, not after finishing.** This is
the first step of executing a card, ahead of touching any code. Then do the
work, then move it to `done` with its `verified` value.

It is easy to skip because it feels like ceremony when you already know what you
are doing, and skipping it is how the board stops describing reality. Measured
on 2026-08-28: the In progress column had read `0` for an entire working session
across every card executed in it, because each one went straight from backlog to
done. A board that only ever shows finished work cannot answer "what is being
worked on right now", which is most of what a board is for - and if two people
ever work here, it is the whole of what it is for.

Nothing enforces this. A diff cannot show that a card passed through
`in-progress`, so no check can catch a card that skipped it - which is exactly
why it is written down here instead.

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

A new item needs an ID, a type (`story` / `enabler` / `spike` / `bug` /
`decision` - the SAFe vocabulary described above, and the only five
`check-board` accepts), one line of evidence pointing at where the detail lives,
and one distinction that matters more than any of the others:

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
