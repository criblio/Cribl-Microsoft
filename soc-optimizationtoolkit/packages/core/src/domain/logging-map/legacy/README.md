# Frozen legacy copies for the Azure Logging Map

Status: Living - frozen evidence for AZR-19; delete only together with the
provenance pins that read it.

These three PowerShell files are byte-for-byte copies of the deprecated
Azure-LogCollection scripts that wrote Cribl's policy assignments before the
SOC Optimization Toolkit existed:

- `Deploy-BuiltInPolicyInitiatives.ps1`
- `Deploy-CommunityPolicyInitiative.ps1`
- `Deploy-SupplementalPolicies.ps1`

They are the ported-from evidence for `../ownership.ts` (which assignments the
legacy writer created, at which scope, with which definition and identity, and
which roles it granted that identity) and for the destination parameter names
in `../logging-classifier.ts`. Nothing ships them: they are read only by
`../legacy-provenance.test.ts`.

Why copies and not a path into `deprecated/`: the app is moving to its own
repository, which will not carry `deprecated/`. This follows the DBT-132
precedent set by `../../coverage-model/legacy/resource-coverage.json`, which
this folder reuses rather than copying again (the Cribl-ActivityLog built-in
definition id is read from it).

The equality pin - each copy equals its original byte for byte - runs only
where the original still exists beside the app, and shows as skipped once it
does not. Every other provenance pin reads the copies here and fails loudly if
one is missing.

Do not edit these files. If the legacy scripts change, re-copy them and let the
provenance pins say what the port must follow.
