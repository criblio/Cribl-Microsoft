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

The shared helper is `packages/ui/src/capabilities/empty-inventory.ts`. Use it
rather than phrasing this per screen: the failure is a confident wrong answer,
and those are exactly what drifts when eight screens each word it themselves.

## A verdict is evidence ONLY about the scope it was measured at

Learned applying this to the second and third listers, and it is the rule most
likely to be missed, because the fix LOOKS right without it.

`runAzurePreflight` builds ONE ARM scope from the COMMITTED target and evaluates
everything there. So `workspace.read: granted` means "this identity can read
workspaces in the committed subscription". It says nothing about a subscription
the operator is merely browsing - and browsing is not an edge case here: Azure
targeting exists to look at other subscriptions, and the DCR inventory says in
its own hint that it browses other resource groups.

Carrying the committed scope's verdict across reproduces the original bug one
scope over, now with a permission check as cover, which is worse than having no
check at all. Hence `emptyInventoryMessage` REQUIRES a scope argument. Off-scope
is unmeasured - and that applies to a DENIAL too: being refused in the committed
subscription is no evidence about this one, so an accusation there would be as
unfounded as a zero.

## When NO capability covers the list

The settled taxonomy has nothing for listing subscriptions, resource groups,
Resource Graph results, or Cribl worker groups. The standing rule from the
capability model holds: **do not quietly reuse a neighbouring capability** -
mapping a subscription list onto `workspace.read` would misreport what was
actually checked.

The answer is `unmeasuredInventoryMessage`, which hedges WITHOUT pointing at the
permission check. Sending an operator to run a check that does not measure this
list sends them to do work that cannot settle the question, and they will read
its result as confirmation.

That is a holding position, not a resolution. Two honest ways out, both bigger
decisions than a message:

- **Add the capability and a probe for it** (`subscription.read`,
  `resourcegroup.read`, `resourcegraph.read`). Widens a taxonomy the capability
  plan deliberately closed at 11.
- **Accept that these lists stay unmeasured** and keep saying so.

Unresolved as of 2026-08-10; the same open question the backlog already records
for Resource Graph.

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

- **Workspaces (the reported bug, 2026-08-10). DONE.** `azure-targeting-screen`
  rendered "No workspaces found - create one below" for an empty
  `listWorkspaces`. With insufficient RBAC that message is wrong AND actively
  harmful: it invites the operator to create a workspace that may already exist
  and that they simply cannot see. Now routed through `workspace.read`, and
  scoped: browsing a subscription other than the committed one drops to the
  hedge.
- **Subscriptions and resource groups (same screen). DONE 2026-08-10.** Both
  said the harmful thing: the resource-group line invited creating one, and the
  subscription line ("grant Reader, then Refresh") asserted a permission problem
  that an identity with genuinely zero subscriptions does not have. No
  capability covers either, so both take the unmeasured hedge above.
- **DCR inventory. DONE 2026-08-10.** "No Data Collection Rules in this resource
  group." stated an unverified emptiness as fact. Now `dcr.read`, and scoped -
  the panel browses resource groups other than the audited one by design.
- **Workspace tables. PINNED, screen pending.** `listWorkspaceTables` throws on
  non-2xx, which covers the explicit-denial case, but an RBAC-filtered `200 []`
  would still read as an empty workspace. `emptyTableListMessage` in
  `table-picker-state` decides it; the picker screen (backlog item 2) must use
  it rather than `tableCountLabel`, which only reports a PRE-LOAD state.
- Audit the remaining listers against this rule when touching them: Event Hub
  discovery (the Resource Graph taxonomy gap), worker groups, pack inventory.
  The `unreachable` wording already names the right connection for a Cribl
  capability, so the Cribl-side listers can adopt the helper as they are
  touched.

## Promote this

This is a general engineering rule, not a Cribl or Azure one - any paginated,
permission-filtered API has the same shape (Google Cloud, AWS, GitHub org
listings). It belongs in `claude-kit/standards/` once it has been applied here
at least twice.
