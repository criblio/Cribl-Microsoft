# 10. Build in vertical slices: walking skeleton first, GUI last

Date: 2026-06-22

## Status

Accepted

## Context

With a hexagonal core/adapters/frontends design ([ADR 0003](0003-hexagonal-ports-and-adapters.md)),
there is a real sequencing question: build the core first, or the UI first? Two failure modes bracket
the answer:

- **UI first** founds the product on its most volatile, least valuable layer. Best practice treats the
  UI as a detail (the outermost ring of the Dependency Rule) — it depends on the core, not the
  reverse. Building polished UI before the core works invites rework. For this project the point is
  moot anyway: a mature 34k-line React GUI already exists and keeps running as the fallback, so there
  is nothing to learn from building new UI early, and the real risk is untested logic tangled inside
  that UI — which is a core-extraction problem.
- **Whole core first, in isolation** (horizontal layering: all of `packages/core`, then all adapters,
  then the UI) produces no working software for a long time, gives no feedback, and — worst — lets
  ports be designed against imagination rather than a real consumer, so they are discovered to be
  wrong late.

The established synthesis is _neither_: build **vertical slices** (Cockburn's Walking Skeleton, the
Pragmatic Programmers' tracer bullets, outside-in TDD from _Growing Object-Oriented Software_). A thin
thread through every layer for one capability, working and tested end-to-end, then thickened.

## Decision

Build the product as vertical slices, core-first within each slice. **"GUI last" means the _complete,
polished_ GUI is finished last — not that there is no GUI until the end.** A thin GUI shell grows in
tandem with the CLI from the walking skeleton on, so the product is manually testable through a GUI
from slice one.

- **Phase 1 is a walking skeleton:** one onboarding thread end-to-end — a thin `OnboardSource` plus the
  minimal _real_ adapters it needs (`adapters-cribl` creating one destination, `ArmDcrAdapter`
  deploying one Direct DCR), surfaced through **both** a minimal `dcr deploy` CLI command **and one
  thin GUI screen** — green against a throwaway Sentinel workspace. Real ammunition, one shot: it
  validates the ports, the orchestration, and the test harness against real callers before any layer
  is thickened.
- **Within a slice, build inside-out:** pure domain/usecase test-first (fastest feedback), then the
  adapter, then the thin frontends. Drive the slice outside-in from an acceptance criterion (the
  user-visible behavior) so only what is needed gets built.
- **Two thin consumers, different jobs.** The **CLI** is the automation/CI backbone — deterministic,
  headless, the cheapest end-to-end check. The **GUI** is the manual/exploratory surface (and stakeholder
  demos). Both are composition roots over the _same_ usecases. Building the GUI in tandem also exercises
  the `ProgressSink` port and the `window.api` IPC contract early — interfaces the CLI tests only weakly
  via stdout — surfacing their design problems while they are cheap to change.
- **The GUI must stay a thin shell.** Render + call `window.api` -> usecase, **zero business logic**,
  enforced by the same ESLint boundary rule that keeps `core` free of infrastructure. A thin GUI is
  cheap and safe; a GUI that accretes logic recreates the exact tangle (`SentinelIntegration.tsx` at
  ~3,500 lines) this whole effort exists to undo.
- **Later phases thicken, they do not re-introduce.** Phases 2-5 harden the layers the skeleton
  stubbed (the Cribl client, the Azure auth path, the DCR engine mode-by-mode, the full CLI). Each new
  capability lands as a vertical slice — working end-to-end through the CLI _and_ a thin GUI screen —
  not as a horizontal layer. The GUI grows one thin screen per slice.
- **The polished GUI is completed last (Phase 6).** By then most screens already exist as thin shells;
  Phase 6 is polish and porting the remaining real pages onto a fully proven core, not building the GUI
  from zero. The existing Electron app remains the user-facing product throughout, so there is no
  pressure to make the new GUI feature-complete early.
- **A from-source launcher ships from Phase 0.** `SOC-OptimizationToolkit/Start-App-Windows.bat` (and
  `Start-App-macOS.sh`) launch the desktop GUI from source — deliberately not a packaged `.exe`, to
  avoid the EDR false positives packaged executables trigger on corporate machines — so the tandem GUI
  has a front door from the first slice.

## Consequences

- A working, demoable, shippable thread exists at the end of Phase 1, and the highest-risk pieces (the
  net-new Azure adapter, the self-owned Cribl client) are pierced earliest.
- Ports are validated against a real consumer from day one, so interface mistakes surface while they
  are cheap to fix.
- It takes discipline to keep the skeleton THIN — the temptation is to fully build a layer before the
  thread works. The phase exit criteria enforce "end-to-end first".
- Building a GUI in tandem costs a little more frontend wiring per slice; that is the deliberate
  tradeoff for manual/exploratory testing and demos from slice one. The cost stays small only if the
  GUI stays a thin shell — hence the boundary-rule enforcement above.
- The _polished_ GUI is still deferred to Phase 6, but the product is GUI-testable throughout; the old
  GUI covers users until promotion ([ADR 0006](0006-strangler-fig-with-old-app-as-fallback.md)).
- "UI first" (founding the product on a thick UI) is rejected; "a thin GUI in tandem with the CLI" is
  adopted. Both are recorded here.
