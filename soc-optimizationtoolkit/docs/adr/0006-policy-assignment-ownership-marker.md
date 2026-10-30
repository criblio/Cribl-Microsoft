# ADR 0006: Recognise our policy assignments by a reserved metadata key, not by createdBy

Date: 2026-10-26 (proposed); 2026-10-27 (accepted)
Status: Accepted - 2026-10-27. The owner answered the ownership-marker
        decision on AZR-19 with the recommended key, `criblSocToolkit`.
        No toolkit release writes policy yet, so accepting it changes no
        deployed assignment; the How-to steps tell an operator who creates
        an assignment by hand to set it (see Consequences).
Invalidates: backlog.md
        It falsifies the "OURS = metadata.createdBy" default first recorded
        on AZR-19. backlog.md section 6a-i already carries the correction and
        now records the key as decided; the AZR-19 card detail in
        `docs/board.json` must say the same.

## Context

The Azure Logging Map (AZR-19, phase 1, read-only) draws every policy assignment
in the management-group tree and marks the ones that are OURS, meaning written
by this toolkit or by the PowerShell tool it replaced. The card took this
default when the operator said "build it now": ours = `metadata.createdBy` set
by the toolkit, plus the assignment names the legacy `Deploy-*` scripts write.

**The first half of that default cannot work.** Azure itself stamps
`metadata.createdBy`, `createdOn`, `updatedBy` and `updatedOn` on every policy
assignment, whoever created it. The value is the object id of the caller, so it
says which principal made the call, not which tool did. A customer's own
automation running as the same service principal would read as ours, and the
toolkit running under a different principal would not. This is platform
knowledge, not something read in this repository. Live verification item 3c
(AZR-19) confirms it by finding `createdBy` on assignments the toolkit never
wrote.

**The legacy writer left no marker at all.** Its `New-AzPolicyAssignment`
calls pass no `-Metadata`:

- `deprecated/Azure/Azure-LogCollection/core/Deploy-BuiltInPolicyInitiatives.ps1:779-790`
- `deprecated/Azure/Azure-LogCollection/core/Deploy-CommunityPolicyInitiative.ps1:1177-1188`
- `deprecated/Azure/Azure-LogCollection/core/Deploy-SupplementalPolicies.ps1:2092-2104` and `:2176-2186`

So the legacy assignments can only be recognised by their SHAPE: name, scope
and definition.

## Decision

1. **A reserved key for everything the toolkit writes from now on:**
   `metadata.criblSocToolkit = { version }`. The constant is
   `TOOLKIT_MARKER_KEY` in
   `packages/core/src/domain/logging-map/ownership.ts`. Any future writer of
   policy assignments must set it, including AZR-4 and anything else that
   deploys policy. Phase 1 only reads it. An assignment an operator creates
   by hand from the How-to steps carries it with `version: "manual"`, which
   says no toolkit release wrote it.

2. **The legacy writer is recognised by ranked evidence, never a boolean.** The
   evidence is shown to the operator in this order, strongest first:
   - `toolkit-marker`: the reserved key is present.
   - `legacy-strong`: a legacy name pattern, AND that pattern's known
     definition, AND the scope kind the legacy wrote it at. For example
     `Cribl-AL-*` / `Cribl-AU-*` with the AllLogs (`85175a36-...`) or Audit
     (`1020d527-...`) set at management-group scope, or `Cribl-ActivityLog`
     with `/providers/Microsoft.Authorization/policyDefinitions/4dabf6eb-0764-4049-82c1-c6d5d781e739`.
     That id is the policyId the legacy discovered at runtime
     (`Deploy-SupplementalPolicies.ps1:1163-1169`). The toolkit already
     holds it in the frozen
     `packages/core/src/domain/coverage-model/legacy/resource-coverage.json:53`,
     and the provenance pin reads it from there rather than restating it.
   - `legacy-identity`: a user-assigned identity whose resource id ends in
     `/userAssignedIdentities/cribl-diag-policy-identity`.
   - `name-only`: the name starts `Cribl-`. This is the legacy's own rule
     (`deprecated/Azure/Azure-LogCollection/Run-AzureLogCollection.ps1:1963`).
     It is labelled "name match" in the UI, not "ours".

   A legacy name at the wrong scope kind, or one carrying `notScopes` the
   legacy never wrote, records `legacy-shape-mismatch` and is capped at
   `name-only`. The `setbycriblpolicy` default diagnostic-setting
   name (`Deploy-BuiltInPolicyInitiatives.ps1:689`) is a hint and is never
   enough on its own, because the operator could override it. `createdBy` is never evidence of any rank.

3. **The legacy facts are pinned to frozen copies.** The three `.ps1` files
   are copied byte-for-byte into
   `packages/core/src/domain/logging-map/legacy/` and
   `legacy-provenance.test.ts` checks every literal against them. This
   follows the DBT-132 precedent in
   `packages/core/src/domain/coverage-model/coverage-model.test.ts:38-76`:
   the app's own repository will not carry `deprecated/`, so the evidence has
   to travel with the code.

## Limits of the legacy recogniser, stated rather than hidden

- **The 24-character name cap at management-group scope.** The legacy
  truncates the region to fit (`Deploy-BuiltInPolicyInitiatives.ps1:265-301`,
  `Deploy-CommunityPolicyInitiative.ps1:398-415`). The recogniser therefore
  matches a prefix pattern and cannot recover the full region from the name.
- **Region truncation collides.** `Cribl-Diag-EH-` leaves 10 characters, so
  `southafricanorth` and `southafricawest` both become `Cribl-Diag-EH-southafric`.
  `Cribl-AL-` leaves 15, so `australiacentral` and `australiacentral2` both
  become `Cribl-AL-australiacentra`. Two legacy deployments can share a name,
  and the region is never inferred from it. The MultiRegion community
  assignment also never applied the resource selectors it built
  (`Deploy-CommunityPolicyInitiative.ps1:1162-1188`), so its name names a
  region its coverage does not have.
- **A customer's own `Cribl-*` assignment** matches the name pattern. That is
  exactly why `name-only` is a separate, labelled rank and not "ours".
- **A legacy assignment someone re-created by hand** with a different
  definition or scope drops to `name-only` with a recorded mismatch. That is
  correct: it is no longer the shape the tool wrote.

## Consequences

- The marker key was a `decision` block on AZR-19 (`criblSocToolkit`
  recommended, with alternatives). The owner chose `criblSocToolkit` on
  2026-10-27, so the decision is answered and this ADR is Accepted.
- The key binds every writer: AZR-4 when it deploys policy, and the operator
  who follows the How-to steps by hand. The Audit, community and Activity Log
  assignment steps (`packages/core/src/domain/onboarding-howto-steps/policy-steps.ts`
  and `entra-activity-steps.ts`) pass `--metadata @marker-metadata.json` to
  `az policy assignment create`, show the metadata in their values table, and
  tell a portal user to add it with `az policy assignment update` because the
  portal's assignment form has no metadata field. `steps.test.ts` pins that
  every assignment-creating step does so and that its metadata makes the
  recogniser answer `toolkit-marker`.
- Changing the key later is one constant and its pin in `ownership.ts` /
  `ownership.test.ts`, plus this ADR, and it orphans every assignment already
  marked with the old key.
- Rejected: `metadata.createdBy` (see Context); a tag (a policy
  assignment has no tags property); a description or display-name prefix (free
  text that any editor in the portal rewrites).
