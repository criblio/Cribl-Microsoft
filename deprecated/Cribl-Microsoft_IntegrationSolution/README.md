# Cribl SOC Optimization Toolkit for Microsoft Sentinel

Desktop application for building, deploying, and managing Cribl Stream packs that ingest vendor log data into Microsoft Sentinel. Supports end-to-end workflows from sample data analysis through DCR deployment and data flow validation.

> Microsoft, Azure, Microsoft Sentinel, and Microsoft Defender are trademarks of Microsoft Corporation. Cribl and Cribl Stream are trademarks of Cribl, Inc. This tool is not endorsed by or affiliated with Microsoft Corporation. References to Microsoft, Azure, and Microsoft Sentinel in this project describe points of integration and interoperability only, and do not imply endorsement, sponsorship, or affiliation.

## Quick Start

From the repository root:

```batch
# Windows
Start-App-Windows.bat

# macOS / Linux
./Start-App-macOS.sh
```

On first run, the script will prompt you to install Node.js dependencies via `npm install`. Review `package.json` before confirming if you want to audit the dependency list first.

### Prerequisites

- **Node.js** 18+ ([nodejs.org](https://nodejs.org/))
- **PowerShell** 5.1+ with Azure modules (for Azure deployment features)
- **Cribl Stream** 4.14+ (for Direct DCR support)
- **Azure subscription** with a Log Analytics workspace (for live deployment)

### Integration Modes

The setup wizard on first launch offers four modes:

| Mode | Azure | Cribl | Description |
|------|-------|-------|-------------|
| **Full** | Live | Live | Deploy DCRs + upload packs + wire sources + validate |
| **Azure Only** | Live | -- | Deploy DCRs, export packs as .crbl for manual Cribl import |
| **Cribl Only** | -- | Live | Upload packs to Cribl, export ARM templates for manual Azure deployment |
| **Air-Gapped** | -- | -- | Build packs and ARM templates offline for manual deployment |

## Workflow

1. **Select a Sentinel solution** -- choose from the Microsoft Sentinel content hub (auto-synced)
2. **Load sample data** -- auto-load from the Sentinel repo, upload Cribl captures, or paste raw events
3. **Review schema mapping** -- the field matcher maps source fields to destination schemas. Edit individual mappings before building.
4. **Configure Azure resources** -- select subscription, workspace (live modes) or enter target details (offline modes)
5. **Configure Cribl** -- select worker groups (live) or just name the pack (offline)
6. **Build and deploy** -- deploys DCRs, builds the Cribl pack with pipelines, routes, and destinations
7. **Wire sources and validate** -- connect a Cribl source to the pack and verify data flow end-to-end

## Architecture

```
src/
  main/           Electron main process + IPC handlers
    ipc/           Backend logic (auth, pack-builder, field-matcher, azure-deploy, etc.)
  renderer/        React frontend
    pages/          Page components (SentinelIntegration, Packs, Settings, etc.)
    components/     Shared UI components (Sidebar, AuthBar, Layout, etc.)
  server/          Express server (web mode alternative to Electron)
tests/             UAT test suites
```

### Dual Runtime

- **Electron mode** (`npm run dev`): Desktop app with OS-level credential encryption
- **Web mode** (`npm run dev:web`): Browser-based with Express API server on port 3001

### Key Backend Modules

| Module | Purpose |
|--------|---------|
| `pack-builder.ts` | Pack scaffolding, pipeline YAML generation, .crbl packaging |
| `field-matcher.ts` | 6-phase field matching engine (exact, alias, fuzzy, type-aware, event-classification) |
| `auth.ts` | Cribl OAuth + Azure PowerShell session management |
| `azure-deploy.ts` | DCR deployment, ARM template generation, permission validation |
| `vendor-research.ts` | Auto-detection of vendor log formats and destination table mapping |
| `sample-parser.ts` | Multi-format sample parsing (CEF, CSV, JSON, KV, LEEF, syslog, Cribl captures) |
| `app-paths.ts` | Centralized path management -- all app data stored in `%APPDATA%/.cribl-microsoft/` |

### Data Storage

All runtime data is stored under `%APPDATA%/.cribl-microsoft/`:

```
%APPDATA%/.cribl-microsoft/
  config/          Integration mode, user preferences
  packs/           Built pack directories and .crbl archives
  auth/            Encrypted Cribl credentials (OS keychain)
  sentinel-repo/   Cloned Microsoft Sentinel content hub
  vendor-cache/    Cached vendor research data
  dcr-templates/   DCR template cache
```

No data is stored inside the repository clone directory.

## Pack Output

Each built pack includes:

- **Pipelines** -- per-table transformation + reduction pipelines with field rename, coerce, and overflow handling
- **Routes** -- conditional routing by log type / event classification
- **Destinations** -- Sentinel DCR destination configs with ingestion endpoints
- **Lookups** -- CSV field mapping files showing source-to-destination schema mapping per table
- **Samples** -- vendor sample data for pipeline testing in Cribl
- **Event Breakers** -- format-specific event breaking rules (JSON, CEF, CSV)

## Air-Gapped Export

In offline modes, artifacts are exported to `~/Downloads/{packName}-artifacts/`:

- `{packName}_version.crbl` -- Cribl pack archive
- `arm-templates/` -- ARM template JSON per destination table
- `cribl-destinations/` -- Cribl destination config JSON (filtered to this solution's tables)
- `README-deployment.md` -- step-by-step manual deployment instructions

## Security

- **Cribl credentials**: Encrypted on disk using OS keychain (Windows DPAPI / macOS Keychain). OAuth tokens are short-lived and cached in memory only.
- **Azure credentials**: Not stored by this application. Uses the existing Azure PowerShell session (`Connect-AzAccount`).
- **npm dependencies**: On first run, `Start-App.bat` prompts before running `npm install`. Review `package.json` to audit dependencies before confirming.
- **No telemetry**: The application does not phone home or transmit data to third parties.
- **Sentinel repo**: Cloned from the public Microsoft Sentinel GitHub repository for solution metadata and sample data. The repository contains analytics rules with embedded IOC data (malicious IPs, file hashes, domains) used for threat detection. Antivirus or EDR software may flag these files during the clone -- this is expected behavior, not malware.

## Development

```bash
# Electron mode (desktop app)
npm run dev

# Web mode (browser + Express)
npm run dev:web

# Type check
npx tsc --noEmit

# Run UAT tests
npm run test:uat
```

## License

MIT License - see [LICENSE](../LICENSE).
