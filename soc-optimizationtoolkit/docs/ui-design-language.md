# UI Design Language (extracted from the legacy reference screenshots)

Status: Living - the visual bar the app must meet. Restyles tokens and shared components; logic is never touched.

Derived from `docs/ui-reference/00-setup-wizard/*` and `01-sentinel-integration/*`
(the legacy Electron app, the flow the user preferred). This is the visual bar the
new app's DARK theme must match; light mode stays a clean equivalent. The refinement
restyles tokens + shared `@soc/ui` components against this - logic is never touched.

The screenshots are gitignored (they carry real tenant data) and do not travel
with a clone or the repository move. The palette below is already implemented in
`packages/ui/src/styles.css` (`[data-theme='dark']`), which is now the source of
truth; the shared components named below are the source of truth for their shape.

## The overall aesthetic

A dark, navy, "engineering console" look. NOT the current Ant-Design light-first base.
The reference screenshots are all DARK MODE, so the dark theme is the primary target;
light mode computes to a clean parity. The defining traits:

- Deep navy page background; section cards a shade lighter with soft rounded corners
  (~14px) and a subtle 1px border; inset panels (status bars, summaries) a shade darker.
- **Monospace is load-bearing.** Technical values, the REPOS status line, the three-way
  coverage counts, the deploy summary block, input placeholders, stat numbers, resource
  values (`eastus`, `paloalto-pan-sentinel`), and chips all render in monospace. This is
  what gives the tool its expert, precise feel - apply it deliberately, not everywhere.
- Big bold sans-serif page titles; small, semibold, slightly-muted field labels.
- Generous vertical rhythm; sections breathe.

## Target dark palette (approx, tune against the screenshots)

```
--bg              #0a0e1a   page background (near-black navy)
--surface         #111a2e   section cards
--surface-raised  #0d1526   inset panels (status bars, summary, code blocks)
--border          #1e2a44   card borders
--border-subtle   #17223a   hairline section dividers
--text            #e6ecf5   primary
--text-muted      #8793a8   descriptions, labels
--text-faint      #63708a   hints, provenance, footers
--accent          #3ba7e8   current-step badge, primary buttons, links, info "i"
--ok              #57b374   complete-step badge, success dots, Recommended, readiness
                            pills, positive CTAs (Deploy All / Get Started / Continue)
--warn            #e0a13c   gating text, Approval Required, partial coverage, blocked
--error           #e0665f   overflow, missing-field chips
--info-cyan       #4db8ff   DCR Handles stat
```

Light mode: keep the existing Ant-derived light values as the `[data-theme]`-absent
default; every rule reads a token so both themes track. Audit light parity (>=4.5:1).

## Component vocabulary (build/refine these as shared classes)

1. **Numbered section** (`components/numbered-section.tsx`) - a 30px circle badge
   before the section title:
   - current/available = accent (blue) fill, white number
   - complete = ok (green) fill, white CSS-drawn CHECK (no glyph)
   - informational = muted outlined circle keeping the number, plus an
     "Informational" tag beside the title (a read-only diagnostic never wears
     the completion check)
   - blocked = muted number, plus an amber line naming the single unlock
     condition; the body still renders
   - coming-soon = dashed circle, "Not yet available", and no body
   - warn = warn (amber) fill with a white "!" for a warning section (rule coverage)
   - title is bold; a small blue info "i" icon sits after it.
   Every section except coming-soon collapses: Expand sits in the header,
   Collapse at the foot of the body, and a collapsed body stays mounted. When
   the page passes `onDone`, the foot also shows "Done - next", and a collapsed
   section shows its one-line `summary` beside the title (DBT-127).
2. **Six-tile stat row** (gap analysis) - each tile = a big monospace number over a small
   muted label with an info "i". SEMANTIC COLORS ARE THE CONTRACT:
   Source Fields = text, Dest Columns = text, Passthrough = ok/green, DCR Handles =
   info-cyan, Cribl Handles = warn/amber, Overflow = error/red. Keep the vocabulary
   verbatim (Source Fields / Dest Columns / Passthrough / DCR Handles / Cribl Handles /
   Overflow) plus the `Cribl handles: N rename(s), M coercion(s)` expandable in amber.
3. **Readiness footer** (Integrate, `components/readiness-footer.tsx`) - sticky at
   the page bottom: rounded outline pills Solution / Samples / Mappings / Workspace /
   Worker Groups / Pack Name in three states (ok = green with a check, missing =
   amber, coming-soon = muted, never a false green). When the page passes
   `onPillClick`, each pill is a button that jumps to the section it needs
   (DBT-127). When deploy-ready, an ok-to-accent gradient hairline tops the
   footer; the Deploy button sits on the right with its single disabled reason
   inline.
4. **Approval bar / Approval Required badge** - amber dot + prompt in an inset panel with
   an "Auto-Approve All" primary (blue) button on the right; per-table "Approval Required"
   is an amber-outline pill.
5. **Severity badges** - small filled pills: Medium = amber, Low = blue, (High = red).
   Coverage % is color-coded: 100% green, partial amber + "N missing" red.
6. **Status bar** - inset panel: colored status dot + text + right-aligned action button
   (Refresh / Clear Token). Green dot = ready, amber = warning, spinner + text = checking.
7. **Missing-field chips** - red-outline monospace chips (rule coverage).
8. **Radio cards** (wizard target) - bordered rounded card; selected = accent
   border + soft glow + filled radio dot; always-visible-disabled cards dim with a
   reason. The wizard has no mode step any more (the capability model removed
   modes), and the cribl-app locks the target to `cribl-hosted`, so these cards
   are dormant in the shipped app.
9. **Wizard progress bar** - one segment per phase, and there are two (Target,
   Connect): each segment is a top-border bar with an index circle, green
   complete, blue current (with a soft accent background), dark empty.
10. **Buttons** - primary = accent (blue) fill; positive/CTA = ok (green) fill with dark
    text (Deploy All / Get Started / Continue); secondary = ghost (dark
    fill + subtle border). Rounded ~8px.
11. **REPOS / connections status line** - a `REPOS` label + green dots + monospace counts
    (`Sentinel (549 solutions)`), and the wizard's Connections/Repositories footer with
    green dots and inline Refresh.
12. **Inline code chip** - subtle bordered monospace for inline commands/identifiers.

## Keep-list (new-app wins that must NOT regress during the reskin)

Dark-mode token discipline (no hardcoded hex in components), honest step lists,
always-visible-disabled affordances with reasons, secret hygiene (never render a token),
browse-never-commits, nav annotates and never hides or disables (one
`annotateNavItems` pass over every route), the deploy-gate partition
(`canDeploy` vs `canDeployContentPath`), light+dark parity. The reskin changes tokens and
shared component classes ONLY - never a pure decision module, a port, or a usecase.

## Content note (do NOT copy legacy prose verbatim)

Some reference text describes the OLD Electron mechanics we deliberately replaced:
`Connect-AzAccount` / PowerShell session (now SP client-credentials), OS-keychain PAT
(now encrypted KV), and "downloaded N files" (now lazy fetch = reachable+authorized).
Match the LAYOUT and visual treatment, not that copy.
