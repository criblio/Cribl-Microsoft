# core assets (pure data shipped with the core)

Language-agnostic data reused unchanged from the original trees. Populate with:

```bash
pnpm import:assets
```

That script (`scripts/import-assets.mjs`) copies:

- `arm-templates/` — the ~100 Sentinel-native-table ARM templates from
  `Azure/CustomDeploymentTemplates/DCR-Templates/SentinelNativeTables/` (DCE + NoDCE variants).
- `cribl-packs/` — the prebuilt `.crbl` packs from `packs/` and `Azure/dev/Azure_vNet_FlowLogs/`.

These are treated as immutable assets: the DCR engine submits the ARM templates unchanged
(Phase 4) and the Cribl client installs the prebuilt packs (Phase 10). Do not hand-edit them here;
re-run the import to refresh from the source of truth.
