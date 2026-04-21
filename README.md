# Cribl SOC Optimization Toolkit for Microsoft Sentinel

A desktop application for building Cribl Stream integration packs that transform vendor log data for ingestion into Microsoft Sentinel via Azure Data Collection Rules (DCRs).

## Quick Start

```batch
# Windows
Start-App-Windows.bat

# macOS / Linux
./Start-App-macOS.sh
```

On first run the app will prompt to install Node.js dependencies. See the **[Quick Start Guide](QUICK_START.md)** for step-by-step usage instructions.

## What the App Does

The Integration Solution is a desktop application (Electron + React) that guides you through the full workflow for onboarding vendor data to Microsoft Sentinel via Cribl Stream:

1. **SIEM Migration Analysis** -- Upload Splunk or QRadar detection rule exports to identify data sources and map them to Sentinel solutions
2. **Sentinel Integration** -- For each vendor data source:
   - Browse and select sample data from Elastic integrations (434+ vendors) or the Azure-Sentinel repo
   - Run DCR gap analysis comparing source fields against the destination schema
   - Review field mappings (passthrough, DCR-handled, Cribl-handled, overflow)
   - Build a Cribl pack with transformation pipelines, lookup tables, and sample data
   - Deploy DCRs to Azure and upload the pack to Cribl Stream
   - Wire Cribl sources to the pack via routes
3. **Lab Environments** -- Deploy pre-configured Azure lab environments for testing (9 lab types from Sentinel Quick Start to full infrastructure)
4. **DCR Automation** -- PowerShell-based DCR creation for bulk table deployments

## App Features

- **Sample Browser**: Fetches vendor sample data from Elastic integrations with log-type detection, format filtering, and event unwrapping (Zscaler, CrowdStrike, Fortinet, PAN-OS, etc.)
- **Multi-Format Support**: JSON, KV, CEF, LEEF, syslog, CSV (with header mapping for headerless CSV via feed config parsing)
- **DCR Schema Resolution**: Finds destination schemas from DCR templates, Sentinel repo CustomTables, or native table definitions
- **Pack Builder**: Generates Cribl packs with succinct naming, per-log-type pipelines, field mapping lookups, reduction pipelines, and sample data
- **EDR Resilience**: Two-layer blocklist system prevents CrowdStrike/EDR from killing the app during Sentinel repo fetch
- **Four Modes**: Full (Cribl + Azure), Azure Only, Cribl Only, Air-Gapped (offline artifact generation)

## Platform Support

This application has been developed and tested on **Windows 11** only. Other operating systems (macOS, Linux) may work but have not been validated and may have issues with PowerShell-based features (DCR deployment, lab automation, Azure authentication).

## Prerequisites

- **Windows 11** (tested platform)
- **Node.js 18+** ([nodejs.org](https://nodejs.org/))
- **Azure subscription** with Log Analytics workspace
- **Cribl Stream** 4.14+ (for Direct DCR support)
- **PowerShell 5.1+** with Azure modules (for DCR deployment and lab automation)
- **GitHub Personal Access Token** (for fetching Sentinel Solutions and Elastic sample data)

## Repository Structure

```
Cribl-Microsoft_IntegrationSolution/     <-- Desktop app (start here)
  src/
    main/                                <-- Electron main process (IPC handlers)
    renderer/                            <-- React UI (pages, components)
  Start-App-Windows.bat                  <-- Windows launcher
  Start-App-macOS.sh                     <-- macOS/Linux launcher

Azure/                                  <-- Legacy PowerShell automation
  Labs/
    UnifiedLab/                          <-- Lab automation (9 lab types)
  CustomDeploymentTemplates/
    DCR-Automation/                      <-- PowerShell DCR creation
    DCR-Templates/                       <-- Pre-built ARM templates (100+)

KnowledgeArticles/                       <-- Reference documentation
Lookups/                                 <-- Cribl lookup tables and enrichment data
```

## Legacy Tools

The following PowerShell tools are the original automation scripts that preceded the desktop app. They are still functional but the desktop app provides a more integrated experience.

### [DCR-Automation](Azure/CustomDeploymentTemplates/DCR-Automation/)
PowerShell automation for bulk DCR creation. Supports 50+ native Azure tables and custom tables. The desktop app uses these scripts internally for DCR deployment.

```powershell
cd Azure/CustomDeploymentTemplates/DCR-Automation
.\Run-DCRAutomation.ps1
```

### [DCR-Templates](Azure/CustomDeploymentTemplates/DCR-Templates/)
100+ pre-built ARM templates for Sentinel native tables. Used by both the desktop app and the PowerShell scripts for DCR schema resolution.

### [Lab Automation](Azure/Labs/UnifiedLab/)
PowerShell-based lab deployment with 8 lab types (Complete, Sentinel, ADX, Flow Log, Event Hub, Blob Queue, Blob Collector, Basic Infrastructure). The desktop app provides a GUI wizard for these same labs plus a Sentinel Quick Start option.

```powershell
cd Azure/Labs/UnifiedLab
.\Run-AzureUnifiedLab.ps1
```

### [Lookups](Lookups/)
Static and dynamic lookup tables for Cribl Stream, including Active Directory integration via Python LDAP.

## Documentation

- [Integration Solution README](Cribl-Microsoft_IntegrationSolution/README.md) -- Desktop app setup and usage
- [DCR-Automation README](Azure/CustomDeploymentTemplates/DCR-Automation/README.md) -- PowerShell DCR automation
- [CLAUDE.md](CLAUDE.md) -- Project architecture and development guide

### Knowledge Articles
- [Azure Monitor Migration](KnowledgeArticles/AzureMonitorMigration/Cribl_Azure_Monitor_to_Sentinel_Migration.md)
- [Private Link Configuration](KnowledgeArticles/PrivateLinkConfiguration/Private-Link-Configuration-for-Cribl.md)
- [O365 App Registration](KnowledgeArticles/O365AppRegistrationForCribl/O365-AppRegistration_for_Cribl.md)

## Security

- Credentials encrypted at rest using OS keychain (Windows DPAPI / macOS Keychain)
- GitHub PATs stored via Electron safeStorage, never written to disk in plaintext
- Azure AD app registrations for Cribl authentication
- Never commit real credentials to version control

## Git Workflow

The `main` branch is protected -- all changes must come through pull requests.

- `feature/` -- New features
- `fix/` -- Bug fixes
- `docs/` -- Documentation updates

## License

MIT License -- see [LICENSE](LICENSE) file.

## Trademarks

Microsoft, Azure, Microsoft Sentinel, and Microsoft Defender are trademarks of Microsoft Corporation. Cribl and Cribl Stream are trademarks of Cribl, Inc. This project is not endorsed by or affiliated with Microsoft Corporation.
