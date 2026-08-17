---
name: architecture-audit
description: Periodic architecture audit for the SOC Optimization Toolkit - layering and coupling, duplicated decisions, test-pin integrity, dead code and stale docs. Use when the commit-count hook says an audit is due, when the user asks for an architecture audit / review of structural health, or before a release.
---

# Architecture audit

A periodic structural check on `soc-optimizationtoolkit/`. Four checks, each
with a bias toward evidence over impression. Report findings; do not silently
refactor unless the user asks.

Run it against the **branch diff since the last audit** where possible, not the
whole repo — the point is catching drift as it happens.

```bash
# What has changed since the last audit (the hook writes this marker).
marker=$(cat .claude/.last-architecture-audit 2>/dev/null || echo "")
[ -n "$marker" ] && git diff --stat "$marker"..HEAD -- soc-optimizationtoolkit/
```

## 1. Layering and coupling

This repo's layering is enforced by convention, not by tooling, so it can only
drift silently.

- `domain/` must not import from `usecases/`, `ports/` adapters, or React.
  Test files are the one accepted exception.
- `usecases/` may import `domain/` and `ports/`, never a shell.
- `packages/ui` may import `@soc/core`; `@soc/core` must never import `@soc/ui`.
- Shells may import both; neither package may import a shell.

```bash
cd soc-optimizationtoolkit
grep -rn "from \"\.\./\.\./usecases" packages/core/src/domain --include="*.ts" | grep -v ".test.ts"
grep -rn "@soc/ui" packages/core/src || echo "core->ui clean"
grep -rn "from \"react\"" packages/core/src || echo "core is React-free"
```

Also check purity where it is claimed: `@soc/core` must not read a clock
(`Date.now()`, argless `new Date()`), `Math.random`, or `crypto`. Parsing an
INJECTED timestamp is fine and is the established pattern.

```bash
grep -rn "Date.now()\|Math.random()\|new Date()" packages/core/src --include="*.ts" | grep -v ".test.ts"
```

## 2. Duplicated decisions

The failure this codebase most often hits: the same rule implemented twice, in
two places that can disagree. Recent real examples — the capability model exists
because app modes were a second, drifting proxy for permissions; the preflight
panel and the audit both had to project verdicts, so they were forced through
one `capabilitiesFromSides`.

Look for:

- Two functions answering the same question with different words
  (`canDeploy` vs `hasRequiredAccess` is a DELIBERATE distinction — check the
  comments before flagging a pair).
- A constant or table restated in a shell instead of shared
  (`ROUTE_CAPABILITIES` is shared for exactly this reason).
- A predicate reimplemented inline rather than imported.

For each candidate, confirm the two really can disagree before reporting it.
Distinctions that are deliberate are usually documented as such — read the
comment first.

## 3. Test-pin integrity

CLAUDE.md and the capability plan both say it: **the contract tests ARE the
specification**. A pin deleted or weakened to make a suite pass is a silent
spec change.

```bash
cd soc-optimizationtoolkit
marker=$(cat ../.claude/.last-architecture-audit 2>/dev/null || echo "")
# Deleted or shrunken test files since the last audit.
[ -n "$marker" ] && git diff --stat "$marker"..HEAD -- "*.test.ts" "*.test.tsx"
```

Flag: removed `it(...)` blocks, assertions turned into weaker ones, `.skip`,
and any suite whose count fell. Also flag NEW behaviour that arrived with no
pin — the frame's nav rewrite passed 2,754 tests because it had none.

## 4. Dead code and stale docs

- Exports no longer imported anywhere (superseded but still public).
- Comments describing behaviour that has since changed — especially module
  headers, which are load-bearing documentation here.
- Backlog entries describing work that is already done.

```bash
cd soc-optimizationtoolkit
# Example shape: is a superseded export still referenced outside its own tests?
grep -rn "filterNavItems" packages apps --include="*.ts" --include="*.tsx" | grep -v node_modules
```

Standing exemption, added 2026-08-17 (ADR-0002): the setup wizard's **target
chooser and leader-connect step** are unreachable and will stay that way.
`WizardTarget`, `TargetChooser`, `LeaderConnectStep`, `TARGET_TRADEOFFS`,
`deriveLeaderBaseUrl`, and the target-specific step visibility in
`setup-wizard-state` are all live code that no user can reach, because
`cribl-app` passes `initialTarget="cribl-hosted"` with `lockTarget`. Do not
report them as dead code.

They are kept on purpose: they are the only asset that would onboard a
customer-managed leader, and the local shell they were built for is gone. What
retires this exemption - delete the code and this paragraph together when
EITHER happens:

- Cribl Apps become installable on customer-managed leaders and the wizard is
  wired to that path (the exemption's purpose is served; it stops being dead
  code), or
- a decision records that on-prem is permanently out of scope (the purpose is
  void; nothing justifies the code).

If neither has happened but the code has DRIFTED - a new caller, a changed
signature, a test pinning target behaviour that no target exercises - that IS
reportable. An exemption covers code standing still, not code quietly growing.

(`filterNavItems` / `AppMode` used to be listed here as dead-pending-step-5;
step 5 has landed and both are gone, so that exemption was removed on
2026-08-12. If you add one, date it and say what retires it, or it outlives the
thing it was protecting.)

## Reporting

Report as a short list, most structural first. For each: what it is, why it can
bite, and the cheapest correct fix. Distinguish **confirmed** (you read the code
and it really can disagree) from **suspected**.

If nothing is found, say so plainly — a clean audit is a real result, and
inventing findings to look thorough is worse than none.

Finally, record the audit point so the next one diffs from here:

```bash
git rev-parse HEAD > .claude/.last-architecture-audit
```
