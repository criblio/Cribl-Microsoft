# Inventory standard: never report "none" unless you verified you could see

**Status: BINDING** (user directive 2026-08-10). Applies to EVERY inventory
scenario in this app - subscriptions, workspaces, resource groups, tables, DCRs,
Event Hubs, worker groups, packs, anything that lists.

## The rule

> An empty result may only be reported as "there are none" when the caller has
> VERIFIED it had permission to see them. Otherwise it must be reported as
> "could not verify", naming the missing permission.

An unverified empty list is an **unknown**, not a zero. Rendering it as a zero is
a confident wrong answer, and the operator has no way to tell.

## Why this is not just error handling

The obvious assumption is that a permissions failure throws, so catching errors
is enough. **It is not**, and this is the trap:

**Azure ARM list operations return `200 OK` with an empty `value` array when RBAC
filters the caller out.** RBAC scopes what a list RETURNS rather than denying the
call. There is no error, no non-2xx, nothing to catch. A caller with no access
and a caller looking at a genuinely empty subscription receive byte-identical
responses.

This is why `listAllPages` throwing on non-2xx - which it does, correctly - does
not solve the problem, and why the fix cannot live in the HTTP layer. The
distinction is not available in the response at all. It has to come from
somewhere else: a permission check.

## How to apply it

The capability audit already measures the relevant reads (`workspace.read`,
`table.read`, `dcr.read`). Use them:

```
empty result + capability granted   -> "No X found"          (a real zero)
empty result + capability denied    -> "Cannot list X - the connected identity
                                        lacks <permission>"  (not a zero)
empty result + capability unknown   -> "Cannot confirm there are no X - the
                                        permission check has not run"
non-empty result                    -> render it; permission is self-evident
```

Note the third row. "Not measured" is its own answer and must NOT collapse into
either of the others - the same discipline `CapabilityVerdict` already enforces
(see docs/capability-model-plan.md). An unaudited connection has not earned the
right to say "none".

## What this does NOT license

- **Do not hide the surface.** The capability model's rule 3 still holds: a
  denied verdict annotates and never blocks. The list stays loadable and the
  operator may still try; Azure's own answer is the real gate.
- **Do not invent a fallback artifact.** Reads have none by design. The honest
  annotation IS the whole answer.
- **Do not gate the load behind the audit.** If the audit has not run, load
  anyway and caveat the empty result. Refusing to look would be worse than
  looking and being honest about what the silence means.

## Known instances

- **Workspaces (the reported bug, 2026-08-10).** `azure-targeting-screen`
  renders "No workspaces found - create one below" for an empty
  `listWorkspaces`. With insufficient RBAC that message is wrong AND actively
  harmful: it invites the operator to create a workspace that may already exist
  and that they simply cannot see.
- **Workspace tables.** `listWorkspaceTables` throws on non-2xx, which covers
  the explicit-denial case, but an RBAC-filtered `200 []` would still read as an
  empty workspace. Same fix needed.
- Audit the remaining listers against this rule when touching them:
  subscriptions, resource groups, DCR inventory, Event Hub discovery, worker
  groups, pack inventory.

## Promote this

This is a general engineering rule, not a Cribl or Azure one - any paginated,
permission-filtered API has the same shape (Google Cloud, AWS, GitHub org
listings). It belongs in `claude-kit/standards/` once it has been applied here
at least twice.
