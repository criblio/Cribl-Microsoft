# Setup pages: say what is needed, hide the rest

Status: Proposed - design agreed with the operator 2026-11-02 (brainstorm); not
yet built.
Last-confirmed: 2026-11-02

## Why

The operator finds the setup pages too wordy, and the pages do not say what is
needed. Measured against the code on 2026-11-02:

- Finishing setup requires nothing: accept the agreement, then Next, Next,
  Get Started (`setup-wizard-state.ts` `isFinal`; every view is skippable).
- On Cribl.Cloud the only truly required input is the **GitHub token**
  (`pat-policy.ts` `patPolicyFor('cloud').required = true`). Cribl is granted by
  the platform. Azure is needed only for deploys and discovery.
- The wizard's Connect Azure step renders about 45 sentences by default. No
  setup section uses `InfoTip` or a closed `<details>`; only Settings does.
- The labels disagree with the code. The GitHub step says "This step is
  optional." (`setup-wizard.tsx` footer), but the token is required. The wizard
  says to skip Azure, but `nextAction` (`journey-state.ts`) asks for an Azure
  identity before every later stage, so an operator who will never connect
  Azure is nagged forever.

The same direction the operator gave Sentinel Integration (DBT-232/DBT-237:
show the essentials, fold the rest) applies here.

## Goals

1. Every setup control says whether it is **required**, **needed for some
   features** (named), or **optional**, and that label matches the code.
2. On screen by default: the choice or input, a one-line label, and the
   button. Explanations, rationale and storage details move behind (i) icons
   (`InfoTip`).
3. Azure starts with one choice (below), and the app remembers it.
4. The Setup page's next action follows that choice.

## Non-goals

- No change to what the app can attempt. The capability model's rules stand
  (`capability-model-plan.md`, 2026-08-05): the nav annotates rather than hides,
  and the audit informs and offers but never forbids. The connectivity choice
  shapes the setup page, the change request and the next action only. It is
  not a mode and gates no route or action.
- No new Azure permissions, roles or probes.
- No change to the deprecated PowerShell toolkit.

## Anti-goals (a failure even if it works)

- Bringing back modes under another name: anything that disables or hides a
  route because of the choice.
- A change request that asks for a role the operator did not tick.
- Hiding a gate reason or a warning behind an (i) icon. An (i) holds the WHY;
  a reason something cannot run stays on screen.

## The Azure step

The step opens with one question: **How will this app work with Azure?**
There are three answers, shown as a segmented control.

- **Fully Connected.** Shows the app-registration inputs (tenant id, client id,
  secret), the resource pickers and Generate Change Request. The request asks
  for every permission in `appPermissionPlan(setupPath)`, as it does today.
- **Partially Connected.** Shows the same inputs plus an action checklist laid
  out as **Option A** from the brainstorm mockup:
  - A featured block at the top holds **Read-only access**, checked by
    default, with a "Recommended" badge and one line: "Fills the workspace,
    table and DCR pickers and the inventory views." It maps to the `Reader`
    entry of the role plan ("Discovery and gap analysis").
  - Under "Also allow the app to", plain opt-in checkboxes, one per remaining
    `AppPermission` entry, labelled by its `feature`: Deploy Data Collection
    Rules, Create custom tables, Install Sentinel content, Grant Cribl access to
    each DCR, and Pick the Cribl identity by name.
  - Each row has an (i) that shows the entry's role or Graph permission name,
    `justification` and `withoutIt`. That text already exists in
    `app-permissions.ts` and `role-plan.ts`, so it is not rewritten.
  - Generate Change Request asks for exactly the ticked entries. A short count
    beside the button reads, for example, "2 roles - Reader, Monitoring
    Contributor".
- **Disconnected.** No app-registration inputs. One line says the app will
  produce ARM templates and deployment guides to hand to someone who can run
  them. This is the existing fallback path (`fallback-routing`), named rather
  than rebuilt.

The setup-path choice (existing resources, lab with a new resource group, lab
with your own resource group) stays. It decides which roles exist in the plan.
It appears under Fully Connected only, as a compact control with an (i).
**The lab paths are Fully Connected only** (operator decision 2026-11-02): a
lab means the app creates the resources, so a checklist does not fit.
Partially Connected therefore always uses the existing-resources path, and its
checklist is the `appPermissionPlan("existing")` entries. Choosing Partially
Connected while a lab path is saved switches the path to existing resources
and says so in one line.

### Persisting the choice

- Saved per connection with the non-secret Azure configuration (`AzureConfig`,
  beside `setupPath`): `connectivity: "full" | "partial" | "disconnected"` and,
  for partial, the ticked entries.
- An install without the field reads as `full`. That matches today's
  behaviour, so nothing changes for existing operators until they choose.
- The change-request generators read the saved choice, so the ticket generated
  from Setup and the one generated from the wizard cannot disagree.

### The next action follows it

`JourneyFacts` gains the saved connectivity, and `nextAction` uses it:

- **Disconnected:** never asks for an Azure identity, a secret or an Azure
  scope. After acceptance and the GitHub token, the next action is choosing
  content, with the exports as the way to deploy.
- **Partially Connected:** asks for the identity and secret, because the
  operator chose to connect. It asks for an Azure scope only when a ticked
  action needs one; Read-only needs a subscription.
- **Fully Connected:** as today.

## The other setup pages

These follow from the same review; the line references are in the review
notes that went into the cards.

- **Wizard steps:** Agreement, then GitHub token, then Azure. The separate
  Check permissions step goes: it says it gates nothing, and the permissions
  chip and the Permission Verification page already cover it. The GitHub step
  is labelled required on the cloud shell, and "This step is optional." only
  appears where that is true.
- **Setup page (`home`):** keeps the next action and the journey, and reuses
  the wizard's sections without repeating them. One app-registration change
  request per screen, not two. The storage, "write-only secret" and
  "discovery runs automatically" explanations each appear once, behind an (i).
- **Settings:** the Reconfigure note that repeats its own InfoTip goes.
- **GitHub token:** one statement of the scope needed (today it says both
  "only public_repo" and "no scopes are required").

## Defects found by the review (card each before fixing)

These are in committed code, so under the board rules each becomes a card
first:

1. The GitHub step says "This step is optional." while the cloud token is
   required.
2. `nextAction` asks a no-Azure operator for an Azure identity (fixed by the
   saved choice above).
3. The two descriptions of the same app-registration ticket disagree: one
   says client and IDs only, the other says "EVERYTHING".
4. The resource-picker intro says the pickers depend on the setup path; both
   always render.
5. Guidance points to "the App registration and connect section on Setup"
   from inside the wizard, where that section sits just below.
6. The storage note says "The connection bar above shows..." where the wizard
   has no connection bar.
7. `nextAction` and the scope chip hint name Azure Targeting and "Use this
   target", a route that has been removed.
8. The GitHub scope contradiction above.

## Left to the builder

- Exact one-line labels and the wording inside each (i), within the rule that
  the existing `justification` and `withoutIt` text is reused rather than
  rewritten.
- Component structure, and whether the checklist is its own component.
- Order of work, provided each defect card exists before its fix lands.
- Test shape, following the repo's rules: pin the rule that maps choices to the
  request and to the next action, mutation-check it, and confirm in Live
  Preview (`/apps/a/__local__`).

## Builder's calls (made in this document, not by the operator)

- Read-only maps to `Reader` at the subscription.
- An unset connectivity reads as `full`.
- Settings keeps its sections; only the duplicate note goes.
- **The journey rail for Disconnected.** The connect and target stages get a
  new status, `not-needed`, and render like Sentinel Integration's "Not needed"
  sections. `deriveJourney`'s rule that the current stage matches `nextAction`
  still holds, because a `not-needed` stage is passed over just as a complete
  one is. The identity, secret and scope chips read "not used" instead of
  "missing". Deploy's blocked reason stays on screen (anti-goal 3) but names the
  export path ("Disconnected: export the ARM templates instead"), not the
  tenant and client ids.
- **The GitHub token becomes a journey fact for every choice.** `JourneyFacts`
  gains `tokenPresent`, and the first-run arc gains a GitHub stage. Whether it
  is required follows `patPolicyFor(shell).required`, so it is required on the
  cloud shell and the local shell keeps its own rule. Fully Connected on cloud
  therefore also asks for the token. That is a correction, not a new demand:
  the token is already required there and the page has been hiding it.
- **What Partially Connected asks for in scope** is read from each ticked
  entry's `scopeLevel`. `JourneyFacts` gains `subscriptionChosen`. The target
  stage completes with a subscription alone when every ticked entry is
  subscription- or tenant-scoped. It needs the full scope (subscription,
  resource group and workspace, as `scopeCommitted` does now) once any
  resource-group entry is ticked. Those entries are the ones that write DCRs,
  tables or Sentinel content into the workspace.
- **Disconnected is copy and journey only.** It does not feed
  `CapabilityContext`, `routeCapability` or `mustProduceArtifacts`. Without an
  identity the fallback already forces exports, so nothing needs to change
  there. Because Disconnected hides the identity inputs, the only way to be
  Disconnected with credentials is an identity stored earlier. In that case
  the step says so in one line and offers to clear it or switch to Partially
  Connected.
