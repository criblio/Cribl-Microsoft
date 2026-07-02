# Spike Harness Test Plan (Live Preview + Installed)

Manual validation of the Phase 1 platform assumptions against a real Cribl.Cloud org and Azure tenant. Run the numbered tests in order; record the result of each. The goal is not to test the app - it is to confirm the platform behaves the way the code assumes, so the real feature UI can be built on it.

The tests that most matter (they de-risk load-bearing assumptions) are flagged CRITICAL.

## Prerequisites

- Cribl.Cloud org with Workspace Administrator access; the app open in the Create App wizard with Live Preview.
- `npm run dev` running from `soc-optimizationtoolkit/`; browser is Chrome, Edge, or Firefox (not Safari).
- An Entra app registration (client ID + secret), its tenant ID, and a subscription. For the permission tests, the service principal should have the roles from Panel 3's script assigned (Reader on the subscription; Monitoring Contributor + Log Analytics Contributor on a workspace resource group if you have one).

Record for each test: PASS / FAIL / result text. Anything unexpected is a finding worth more than a pass.

## 1. Platform globals (Panel 1)

1. Open the app in Live Preview; Panel 1 runs on load.
2. Expected: `CRIBL_API_URL` and `CRIBL_BASE_PATH` are populated; `CRIBL_APP_ID` shows a `__dev__`-prefixed id in Live Preview; `getCriblUser()` returns your identity (id, username, maybe email/name).
- Record the app id (you will compare it against installed mode later).

## 2. KV store semantics - CRITICAL

This validates the single most load-bearing assumption: encrypted KV entries are write-only from the client.

1. Run Panel 2's KV sequence.
2. Expected: PUT/GET of the plain key returns `hello`; the encrypted key GET returns a REDACTED placeholder, NOT `topsecret`; the check line reads "redacted placeholder returned, plaintext not readable (expected)"; the key list includes both keys; deletes succeed.
- CRITICAL FAIL if the encrypted GET returns `topsecret` - that would break the entire secret-handling model. Record the exact redacted value returned.

## 3. Create a connection profile (Connection bar)

1. In the connection bar, click New connection; Rename it (e.g. "Test tenant").
2. Expected: the profile appears in the switcher and is active; the secret badge reads "not entered".

## 4. App registration setup and script generation (Panel 3)

1. Choose the setup path that matches your environment (existing workspace / lab create-new-RG / lab bring-your-own-RG).
2. Fill client ID and subscription ID; for the existing/byo paths, note whether the resource-group field appears per path (it should be absent on create-new-RG).
3. Watch the live `az` script update as you type. Click Copy, then Download assign-roles.sh.
4. Expected: the script reflects your inputs with no `<placeholder>` left when fields are filled; the download produces `assign-roles.sh`.
- Record whether the download worked here (this is a preview of Test 10).

## 5. Save the client secret (Panel 4)

1. Enter tenant ID and client secret; click Save client secret.
2. Expected: save succeeds; the secret field clears; the connection-bar badge flips to "stored (this session)"; Panel 4's stored report shows `client secret: stored (encrypted, not shown)`.

## 6. Token acquisition - CRITICAL (Panel 5)

This validates the Origin-header fix (the proxy forwards Origin; Azure AD rejects cross-origin confidential-client token requests without the header allowlist).

1. Run Panel 5 (Acquire token).
2. Expected: `token_type: Bearer`, `expires_in: 3599` (approx), a token prefix, and the KV store PUT succeeds.
- CRITICAL FAIL if you see `AADSTS9002326` (cross-origin) - that means the proxies.yml header allowlist is not taking effect (in installed mode, repackage/redeploy; in Live Preview, confirm the dev server reloaded proxies.yml). Record any AADSTS error code verbatim.

## 7. ARM call with injected Bearer - CRITICAL (Panel 6)

1. Run Panel 6 (List subscriptions).
2. Expected: HTTP 200 and your subscription(s) listed by name and id, with an elapsed time.
- If `subscriptions: 0` with HTTP 200: not an auth failure - the service principal has no role assignments yet (or they have not propagated). Run the Panel 3 script, wait a couple of minutes, retry.
- CRITICAL FAIL if 401: the Bearer injection from KV is not working. Record status + body.

## 8. Resource discovery dropdowns - CRITICAL (Panel 4)

This validates ARM discovery and the workspace-to-resource-group derivation.

1. In Panel 4, click Discover Azure resources.
2. Expected: a Subscription dropdown populates. Select your subscription.
3. For the existing path: a Workspace dropdown populates; select a workspace.
   - CRITICAL: confirm the resource group is set automatically and MATCHES the workspace's actual RG in the Azure portal (this is the derived-RG parser working on a real ARM id).
4. For the bring-your-own-RG path: a Resource group dropdown populates; select one.
- Record: did the subscription list match your Azure portal? Did the derived RG match the workspace's real RG exactly (including casing)?

## 9. Permission preflight - CRITICAL (Panel 4)

This validates that effective-permission evaluation matches reality.

1. Click Re-check and validate permissions.
2. Expected: each required action for your setup path shows `[ok]` or `[missing]`, matching what you actually granted. If you assigned the Panel 3 roles, the core actions should be `[ok]`.
3. Negative check (optional but valuable): temporarily test with a service principal missing a role (e.g. no Monitoring Contributor) and confirm the corresponding action shows `[missing]` - proving it tests real actions, not role names.
- Record any action whose ok/missing verdict disagrees with what you know you granted (that would be an evaluator bug worth reporting).

## 10. Artifact download in BOTH modes - CRITICAL (Panel 7)

This settles the open air-gap-export spike: does the sandboxed iframe allow Blob downloads?

1. Live Preview: run Panel 7 (Download artifact); check your browser's downloads for `spike-artifact.json`.
2. Deploy the app (Deploy in the Live Preview corner), stop the dev server, open the installed app under Apps > Installed, and run Panel 7 again.
- Record for EACH mode: did the file actually download? Live Preview and installed can differ; the installed result is the one that matters for the product. If either blocks the download, that is the finding that decides the air-gap export mechanism.

## 11. Profile persistence and switching - CRITICAL

Validates named-profile persistence and the switch invalidation.

1. Reload the page (or reopen the app). Expected: your "Test tenant" profile is still there with its client/tenant/subscription/workspace remembered; the secret badge reads "not entered" (session-only), while Panel 4's stored report still shows the secret physically present.
2. Create a SECOND profile with a DIFFERENT tenant or client id. Switch back to the first via the connection-bar dropdown.
   - Expected on switch to a different identity: a notice to enter the client secret for this connection; the token is cleared; discovery lists and permission output reset.
3. Switch between the two a few times.
- Record: did non-secret config persist across reload? Did switching identity re-prompt for the secret (rather than silently reusing the wrong one)? Did the wrong tenant's data ever appear under the other profile?

## 12. Config change autosave (light check)

1. Edit a non-secret field (e.g. change the subscription in Panel 3), wait ~1 second, reload.
2. Expected: the edited value persisted (debounced autosave wrote it).

## What to report back

For each CRITICAL test: PASS/FAIL and the recorded result. Especially:
- Test 2: exact redacted value for the encrypted key.
- Test 6: any AADSTS code.
- Test 8: whether the derived RG matched the real workspace RG.
- Test 9: any permission verdict that disagreed with reality.
- Test 10: download behavior in Live Preview vs installed - this decides the air-gap approach.
- Test 11: whether switching identity correctly re-prompted for the secret.

Any FAIL or surprise is more useful than a wall of passes - it tells us which platform assumption to revisit before building the real feature UI on top.
