# UI Design Language (extracted from the legacy reference screenshots)

Derived from `docs/ui-reference/00-setup-wizard/*` and `01-sentinel-integration/*`
(the legacy Electron app, the flow the user preferred). This is the visual bar the
new app's DARK theme must match; light mode stays a clean equivalent. The refinement
restyles tokens + shared `@soc/ui` components against this - logic is never touched.

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

1. **Numbered section badge** - a ~36px filled circle before the section title:
   - current/active = accent (blue) fill, white number
   - complete = ok (green) fill, white number (earlier sections)
   - validated/attention variants seen in refs: green/blue fill with a white CHECK,
     and a blue fill with a white "!" for a warning section (rule coverage)
   - title is bold; a small blue info "i" icon sits after it.
2. **Six-tile stat row** (gap analysis) - each tile = a big monospace number over a small
   muted label with an info "i". SEMANTIC COLORS ARE THE CONTRACT:
   Source Fields = text, Dest Columns = text, Passthrough = ok/green, DCR Handles =
   info-cyan, Cribl Handles = warn/amber, Overflow = error/red. Keep the vocabulary
   verbatim (Source Fields / Dest Columns / Passthrough / DCR Handles / Cribl Handles /
   Overflow) plus the `Cribl handles: N rename(s), M coercion(s)` expandable in amber.
3. **Readiness pills** (deploy) - rounded, green outline, a check glyph + label
   (Solution / Samples / Mappings / Workspace / Worker Groups / Pack Name). A green
   gradient hairline sits at the top of the Deploy card when ready.
4. **Approval bar / Approval Required badge** - amber dot + prompt in an inset panel with
   an "Auto-Approve All" primary (blue) button on the right; per-table "Approval Required"
   is an amber-outline pill.
5. **Severity badges** - small filled pills: Medium = amber, Low = blue, (High = red).
   Coverage % is color-coded: 100% green, partial amber + "N missing" red.
6. **Status bar** - inset panel: colored status dot + text + right-aligned action button
   (Refresh / Clear Token). Green dot = ready, amber = warning, spinner + text = checking.
7. **Missing-field chips** - red-outline monospace chips (rule coverage).
8. **Radio cards** (wizard mode / target) - bordered rounded card; selected = accent
   border + soft glow + filled radio dot; a green "Recommended" badge sits inline with the
   card title; always-visible-disabled cards dim with a reason.
9. **3-segment progress bar** (wizard) - rounded pill segments: green complete, blue
   current, dark empty.
10. **Buttons** - primary = accent (blue) fill; positive/CTA = ok (green) fill with dark
    text (Deploy All / Get Started / Continue / Browse Samples); secondary = ghost (dark
    fill + subtle border). Rounded ~8px.
11. **REPOS / connections status line** - a `REPOS` label + green dots + monospace counts
    (`Sentinel (549 solutions)`), and the wizard's Connections/Repositories footer with
    green dots and inline Refresh.
12. **Inline code chip** - subtle bordered monospace for inline commands/identifiers.

## Keep-list (new-app wins that must NOT regress during the reskin)

Dark-mode token discipline (no hardcoded hex in components), honest step lists,
always-visible-disabled affordances with reasons, secret hygiene (never render a token),
browse-never-commits, one `filterNavItems` pass, the deploy-gate partition
(`canDeploy` vs `canDeployContentPath`), light+dark parity. The reskin changes tokens and
shared component classes ONLY - never a pure decision module, a port, or a usecase.

## Content note (do NOT copy legacy prose verbatim)

Some reference text describes the OLD Electron mechanics we deliberately replaced:
`Connect-AzAccount` / PowerShell session (now SP client-credentials), OS-keychain PAT
(now encrypted KV), and "downloaded N files" (now lazy fetch = reachable+authorized).
Match the LAYOUT and visual treatment, not that copy.
