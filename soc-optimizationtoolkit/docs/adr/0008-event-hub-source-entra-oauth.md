# ADR 0008: The Cribl Event Hub source authenticates with Entra ID by default; a Listen-only SAS rule is the fallback

Date: 2026-11-03
Status: Accepted - not built. AZR-59 builds it; nothing below has run against
        a real tenant or worker group yet. "Unverified" lists what must be
        measured in Live Preview before AZR-59 closes.
Invalidates: none
        No living document instructed otherwise. ADR 0007 section 5 (a
        record) is superseded in part and carries a dated banner pointing
        here; the AZR-34 card's rule wording was corrected in the same
        commit; the retired phrase is on check-docs-drift's RETIRED list.

## Context

The ADR 0007 live pass (2026-11-03) armed the AZR-34 create to `listKeys`
the namespace's only rule, `RootManageSharedAccessKey`, and store its key as a
Cribl text secret. The secret HANDLING was sound: fetched only after confirm,
never shown, never put in the app's KV store, named by the input rather than
held by it. The CREDENTIAL was wrong: a Manage-capable SAS key gives anyone who
can read the worker group's secrets control of the whole namespace, where the
source only ever reads one hub.

Two facts shaped the options, both read on 2026-11-03:

- The vendored Cribl OpenAPI `InputEventhub.sasl` supports `mechanism`
  `oauthbearer`, with `oauthEndpoint` (enum: `https://login.microsoftonline.com`,
  `.us`, `.partner.microsoftonline.cn`), `tenantId`, `clientId`, `scope`, and
  `clientSecretAuthType` (`manual`, `secret`, `certificate`) with
  `clientTextSecret` or `certificateName`. **Measured** (schema read).
- The Blob lane already authenticates as a service principal (tenant, client,
  `clientTextSecret`). **Measured** (input-bodies.ts). That principal is
  currently this app's OWN registration (Setup's tenant and client id), so the
  app registration's secret goes into a Cribl secret: a pre-existing defect,
  carded as AZR-66 and not changed by AZR-59. The Blob lane is the precedent
  for the input SHAPE only, not for the identity.

The operator chose "offer both" (backlog.md section 6h-i records the options
and why each single path was rejected).

## Decision

### 1. Three credential modes for an Event Hub lane, in this order

1. **Entra ID (recommended, the default for every Event Hub lane).** The
   input authenticates as a Cribl service principal holding **Azure Event Hubs
   Data Receiver** on the hub it reads. No shared key leaves Azure; access is
   revoked per principal and is visible in the hub's role assignments.
2. **listKeys on a Listen-only rule** (fallback). As ADR 0007, narrowed by
   AZR-58: the rule must Listen and must not Manage.
3. **A pasted connection string for a Listen-only rule** (fallback). As ADR
   0007, narrowed the same way; `RootManageSharedAccessKey` is refused by name
   even when the rules cannot be read.

A Manage-capable key is refused in every mode (AZR-58, `ruleSafeForCriblSource`).

### 2. The identity is a DEDICATED Cribl principal, never the app's own registration

The app's own app registration holds ARM write rights (DCRs, role assignments,
Defender export). Putting ITS secret in a Cribl secret would hand those rights
to anyone who can read the worker group's secrets - the same class of mistake
as the Manage key. The Event Hub lane uses a dedicated Cribl principal: its
tenant id, client id and object id come from the plan values
`criblTenantId`, `criblClientId` and `criblPrincipalObjectId` (editable in the
panel), and its client secret is pasted, held in a ref, and stored only as a
Cribl text secret. A client id equal to this app's own is refused, and so is a
pasted value that is a connection string (`SharedAccessKey=`, `AccountKey=`,
`Endpoint=sb://`): it is never stored.

The Blob lane does NOT do this today: it signs in as this app's own
registration (defect AZR-66). Until AZR-66 lands, the Blob lane carries the
exact exposure this section rejects for Event Hub.

The role is read for the OBJECT id; the input signs in as the CLIENT id. When
the shell binds the `GraphDirectory` port, the plan lists service principals
and refuses `principal-mismatch` when the client id belongs to another object
id, and `app-principal` when the object id is this app's own service
principal. When the directory read is refused, unavailable, or does not list
the client id, the plan does not guess: the confirm says the role was checked
for object id X, the input signs in as client id Y, and that the two were not
confirmed to be the same principal.

### 3. The input body for Entra ID

```
sasl: {
  disabled: false,
  mechanism: "oauthbearer",
  oauthEndpoint: "https://login.microsoftonline.com",
  tenantId, clientId,
  clientSecretAuthType: "secret",
  clientTextSecret: <secret id>,
  scope: "https://<namespace>.servicebus.windows.net/.default",
}
```

No `username`, `password` or `textSecret`. The identity comparison that
classifies an existing input (`classify-existing.ts`) gains these fields so a
hand-edited OAuth input still refuses by name.

### 4. Validate and How-to cover the role assignment

- **How-to** gains a step: assign Azure Event Hubs Data Receiver to the Cribl
  principal on the hub (narrowest) or the namespace, with the `az role
  assignment create` command.
- **Validate** gains a check that reads the role assignments at the hub and
  namespace scopes for the principal's object id: present with Data Receiver
  is as expected; absent only from a complete listing; a refused read is
  unknown. **Only Data Receiver qualifies.** Azure Event Hubs Data Owner
  carries `Microsoft.EventHub/*`, which includes `listKeys` on every
  authorization rule, so a principal holding it can read
  `RootManageSharedAccessKey`: its covering grant is present-but-different in
  Validate, never as expected, even beside a Data Receiver grant.
- **The plan** refuses an Entra ID create when the role read is refused or
  shows no qualifying assignment, the same way AZR-56 gates on the consumer
  group, and refuses `receiver-role-overprivileged` (least privilege) when
  Data Owner covers any hub it reads.
- A grant counts only at the hub, or at an ARM ancestor of it on a
  path-segment boundary: a grant on hub `h1` never covers `h10`, nor one on
  namespace `ns1` a hub of `ns10`.

## Unverified (must be measured before AZR-59 closes)

- **Inferred:** Cribl accepts the scope as `https://<ns>.servicebus.windows.net/.default`
  (the Azure Event Hubs Kafka OAuth pattern). Measure: a created input reads
  events.
- **Inferred:** the leader's Cribl version reads `oauthbearer` for the
  `eventhub` input (the schema is the leader's, but the schema describing a
  field is not the runtime accepting it).
- **Inferred:** a Data Receiver assignment on the HUB alone is enough for the
  Kafka endpoint (no namespace-level read needed). Measure with a hub-scoped
  assignment only.
- **Inferred:** role-assignment reads at hub scope work with the app's own
  principal's current rights (Microsoft.Authorization/roleAssignments/read is
  in Reader).
- **Inferred:** the app registration has Application.Read.All (or
  Directory.Read.All) consented, so the client-id-to-object-id cross-check
  runs; without it every Entra ID confirm reads "not cross-checked". Measure:
  the confirm in Live Preview says the directory confirms the pair.

## What this breaks or constrains

- Every Event Hub lane's default credential changes from listKeys/paste to
  Entra ID; the AZR-34 confirm text names the principal, not a key name, in
  that mode.
- The How-to step catalog grows by one step per Event Hub source family, and
  its pins that count steps change.
- The Live verification list of ADR 0007 item 5 is superseded for Event Hub
  lanes by the Entra ID checks above; its SAS items still apply to the
  fallback modes.

## What is NOT decided here

- Certificate-based authentication for the Cribl principal (the schema allows
  it; nothing asks for it yet).
- Creating the Cribl principal or its role assignment from the app (a How-to
  step, as creating the Listen rule is today under AZR-36).
