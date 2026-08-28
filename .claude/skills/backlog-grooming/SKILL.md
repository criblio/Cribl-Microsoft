---
name: backlog-grooming
description: Groom docs/board.json - work out what should be done next and in what order, argue with priorities that no longer match the dependency graph, and surface the decisions and bottlenecks holding everything else up. Use when planning what to pick up, when the board feels stale, or when someone asks "what is next".
---

# Backlog grooming

The board says what state each card is in. It does not say what to do next,
because that answer is a function of three things it stores separately:
priority, the dependency graph, and whether an unanswered decision is sitting in
front of the work.

`npm run groom` does the arithmetic. **This skill is the judgement**, and the
judgement is the part that matters: the script can say a card gates ten others,
and still cannot say whether that matters this week.

## Run it first

```bash
cd soc-optimizationtoolkit && npm run groom
```

It reads `docs/board.json` and prints four finding sections followed by the
goals, priority band by band, each with the prerequisites it waits on listed in
the order they have to happen.

Read the whole report before changing anything. Grooming that reacts to the
first finding produces a board optimised for the first finding.

## What each section is claiming, and how to judge it

### DECISIONS IN THE WAY

An unanswered `decision` card with work behind it. **Usually the highest-value
thing on the page**: answering one is minutes and it releases a chain, where the
work itself is days.

Judge: is the decision genuinely answerable, or is it waiting on a measurement?
Some cards are deliberately not clickable - D-5 and AZR-S1 carry a
"NOT SEEDABLE AS A CLICK" note explaining that they need a fact, not a
preference. **Do not pressure those into an answer.** Getting a decision
answered by guessing is worse than leaving it open, because a recorded decision
stops being questioned.

If a decision is answerable, the move is to ask the operator, not to answer it.
Options are on the card; the live board (`npm run board:serve`) makes them
clickable. Remember that answering only records `chosen` - the reasoning still
has to reach `backlog.md` before the card is settled.

### PRIORITY DISAGREES WITH READINESS

Two shapes, and they mean opposite things.

- **`now` but blocked.** Either the card is not really now, or its blockers are.
  Usually the blockers should be promoted rather than the card demoted - the
  intent behind `now` was real.
- **`later` but ready and gating others.** The board is holding back something
  that everything else waits on. This is the most common real finding, and the
  usual fix is to promote it.

Judge before you move anything: priority encodes intent that the graph cannot
see - a card may be `later` because it needs someone unavailable, or because it
depends on a customer conversation the board does not model. The script cannot
know that. **Ask rather than reshuffle** when the reason is not written down.

### LEVERAGE

How many cards each open story transitively unblocks. This is the number
priority cannot express: a `later` card gating ten others is the real critical
path regardless of its label.

Judge: leverage is not value. A card can gate ten cards that nobody wants this
quarter. Cross-check against what the epics are actually for before promoting on
this number alone.

### HYGIENE

- **Done stories still on the board** - the board says prune when the list
  grows. Pruning is not deletion of history: `backlog.md` and the release notes
  keep it.
- **A stalled epic** - open cards, not one of them ready. The whole epic waits on
  something outside it, which is worth knowing before planning inside it.
- **Long chains** - a card five deep is further away than its priority suggests.
  Consider whether the chain is real or whether some edges are stale.

## Changing the board

Grooming edits `docs/board.json`, never `board.md` - that file is generated, and
`check-board` fails if it is edited by hand.

After any change:

```bash
npm run board && npm run check-board
```

Move priorities and dependencies. Do NOT invent cards, options or `verified`
values while grooming - a card manufactured to fill a gap is one nobody thought
through, and `verified` is a claim about evidence that grooming does not have.

## Reporting

Say what changed and why, most consequential first. Name the cards.

If nothing needed changing, say that plainly. A board that grooms clean is a
real result, and inventing a reshuffle to look busy makes the next groom harder
to trust.

Two things worth stating explicitly when they are true, because they are the
findings people act on:

- the single highest-leverage move (usually an answerable decision)
- anything the report flagged that you judged should NOT change, and why -
  otherwise the next groom re-raises it and someone eventually acts on it
  without the context.
