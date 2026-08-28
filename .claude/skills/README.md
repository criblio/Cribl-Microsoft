# Claude Code skills

Status: Living - what a clone of this repo actually gets, and what it does not.

Claude Code discovers each `<name>/SKILL.md` one level deep, so every skill
lives directly under `.claude/skills/`. Invoke one as `/<name>`.

## What travels with a clone

Two, and only two. They encode working agreements specific to this repo and
would be meaningless anywhere else, so `.gitignore` lets them through
explicitly:

- **[architecture-audit](./architecture-audit/SKILL.md)** - the periodic
  structural check on `soc-optimizationtoolkit/`: layering and coupling,
  duplicated decisions, test-pin integrity, dead code and stale docs. Diffs
  from the last audit marker rather than re-reading the whole repo. A
  commit-count hook says when one is due.
- **[backlog-grooming](./backlog-grooming/SKILL.md)** - groom `docs/board.json`:
  what to pick up next and in what order, priorities that no longer match the
  dependency graph, and the decisions and bottlenecks gating everything else.

## What does not

Everything else under this directory comes from
[claude-kit](https://github.com/jamespederson1/claude-kit) and is re-pulled
rather than maintained here, so it is gitignored and travels with nobody. A
clone will see this file and the two skills above; the rest of what sits in
this directory on any one machine is local to that machine and will differ.

That is deliberate - see the comment above `.claude/skills/*` in `.gitignore`
for why, including the `/*` detail that makes the negations reachable at all.

This file is tracked too, but not by a negation up there: the blanket
`!README.md` further down `.gitignore` re-includes every README in an ignored
directory, and being later in the file it wins.

**So do not treat this file as an inventory of what is installed.** It cannot
be one: it is committed, and most of what it would list is not. The previous
version of this README tried to be that inventory and, by 2026-08-28, listed
two skills that did not exist, omitted two that did, and described a different
repo entirely.

To see what is actually available in a session, ask Claude Code - the loaded
skills are listed in its own context - or `ls .claude/skills/`.

## Adding one

A skill belongs here, tracked, when it encodes something about THIS repo that a
new clone needs in order to work on it correctly. Add a `!` negation for it in
`.gitignore` at the same moment you create it, or it will be silently ignored -
the pattern above it is `.claude/skills/*`, and `git add` exits 0 on a file it
skipped.

A skill that is about how you work in general belongs in `claude-kit`, promoted
per the note in the global `CLAUDE.md`, not here.
