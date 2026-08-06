# Release notes

Newest first. One accumulating file rather than the per-version directory used
by the deprecated PowerShell toolkit: this app releases often, and a single file
is harder to forget to update than a directory that has to be remembered.

---

## 1.4.0

**Operating modes are gone. What this app can do is now MEASURED, not chosen.**

### Read this first: every existing install sees the setup wizard once

Upgrading from 1.3.x or earlier lands you in the first-run wizard on the next
load. This is expected and it is not a reset of your configuration.

The old app persisted an operating mode, and a missing mode was also how the app
knew setup had never been completed - one value doing two jobs. Removing modes
meant giving "setup is finished" its own record, and existing installs do not
have one yet. Nothing else is touched: **connections, the GitHub token, the
committed Azure target and the stored client secret all survive.** Click through
the wizard once and the next load goes straight to the app.

Verified on a live workspace before release, not just in tests.

### What changed

**Modes are replaced by a permission audit.** Full / Azure Only / Cribl Only /
Air-Gapped are removed. The app now audits what the connected identity can
actually do - effective Azure RBAC actions plus live Cribl capability probes -
and adapts to the answer.

**The menu tells you what you cannot do; it no longer hides it.** Previously a
mode removed screens from the sidebar. Now every screen is listed, and anything
unavailable carries a short flag and a reason:

| Flag | Meaning |
| --- | --- |
| `no access` | Measured: the identity cannot do this |
| `unchecked` | Not measured yet - run the permission check |
| `not connected` | No Azure/Cribl connection at all |

`unchecked` is deliberately quiet: not having measured is not the same as having
been refused, and the app never renders the first as the second.

**Nothing is disabled.** A screen flagged `no access` still opens, and the action
still runs. The audit informs and offers; Azure's own 403 is the real gate. A
stale or wrong audit costs you an annotation, never the ability to work.

**The permission check moved to the end of the setup wizard** - verify what the
identity can do, then Get Started - and finishing no longer requires choosing a
mode.

**Settings:** the "Operating mode" section is now "Setup". Reconfigure still
works; it reopens the first-run wizard instead of the mode chooser.

### Known gaps

- **Blocked actions do not yet offer their downloadable artifact.** The model
  decides correctly that a blocked action should hand you an ARM template, a
  change request or a `.crbl` to pass to someone with access, but no screen
  renders that offer yet. It is annotation only for now.
- **The audit's age is not shown**, and there is no manual re-check button. The
  audit refreshes on connection switch, scope commit and secret entry.
- **Event Hub Discovery is never flagged.** It reads through Azure Resource
  Graph, which the capability taxonomy does not cover. Rather than mis-report it
  as a workspace or DCR read, it is left unannotated and the screen reports its
  own errors.

### Upgrade notes

Nothing to do beyond clicking through the wizard once. No configuration
migration, no re-entering credentials.

---

## 1.3.0 and earlier

Not documented here; this file starts at 1.4.0.
