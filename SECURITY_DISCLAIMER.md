# Security Disclaimer

## Cribl SOC Optimization Toolkit for Microsoft Sentinel

**Last Updated:** April 2026

---

## Overview

This toolkit helps security engineers build Cribl Stream integration packs for Microsoft Sentinel. It runs locally on your workstation and operates within the permissions you grant it. The app supports multiple modes -- from fully connected (Azure + Cribl) to completely air-gapped (offline artifact generation only).

---

## Operating Modes

| Mode | Azure | Cribl | What it does |
|------|-------|-------|-------------|
| **Full** | Connected | Connected | Creates DCRs, deploys packs, wires routes |
| **Azure Only** | Connected | Disconnected | Creates DCRs, exports pack files for manual import |
| **Cribl Only** | Disconnected | Connected | Deploys packs and routes, exports ARM templates |
| **Air-Gapped** | Disconnected | Disconnected | Generates all artifacts locally for manual deployment |

In **Air-Gapped mode**, the app makes no external connections and does not modify any Azure or Cribl resources. All output is written to local files for review before manual deployment.

---

## What the App Can Do (When Granted Permissions)

### Azure Operations
When connected to Azure via your PowerShell session (`Connect-AzAccount`), the app can:
- Create resource groups and Log Analytics workspaces
- Deploy Data Collection Rules (DCRs) via ARM templates
- Enable Microsoft Sentinel on workspaces
- Query existing resources and permissions
- Assign RBAC roles (Monitoring Metrics Publisher)

These operations execute under **your Azure identity** with **your permissions**. The app cannot exceed the access your Azure account has been granted. Resources created may incur costs on your Azure subscription.

### Cribl Stream Operations
When connected to Cribl Stream via OAuth or admin credentials, the app can:
- Upload Cribl packs (.crbl files)
- Create and modify routes on worker groups
- Commit and deploy configurations
- List sources, destinations, and worker groups
- Capture sample events from sources

These operations execute within **the permissions of the Cribl account** you provide.

### GitHub Operations (Read-Only)
The app fetches data from public GitHub repositories:
- Azure-Sentinel Solutions (analytic rules, data connectors, sample data)
- Elastic Integrations (vendor log samples for 434+ integrations)

A GitHub Personal Access Token is used for rate limiting purposes. Only read operations are performed -- the app never writes to GitHub.

---

## Credential Storage

| Credential | Storage | Location |
|------------|---------|----------|
| Cribl API credentials | Encrypted (Windows DPAPI) | `%APPDATA%/.cribl-microsoft/auth/*.enc` |
| GitHub PAT | Encrypted (Windows DPAPI) | `%APPDATA%/.cribl-microsoft/auth/github-auth.enc` |
| Azure credentials | Not stored by this app | Managed by Az PowerShell module |

Credentials are encrypted using Electron's `safeStorage` which leverages Windows DPAPI (Data Protection API). The encryption keys are tied to your Windows user account.

---

## Network Communications

| Endpoint | Purpose | Protocol |
|----------|---------|----------|
| `api.github.com` | Sentinel Solutions and Elastic samples | HTTPS (TLS) |
| `raw.githubusercontent.com` | Raw sample data files | HTTPS (TLS) |
| `login.cribl.cloud` | Cribl Cloud OAuth tokens | HTTPS (TLS) |
| `main-{org}.cribl.cloud` | Cribl Cloud API | HTTPS (TLS) |
| User-configured Cribl leader | Self-managed Cribl API | HTTPS or HTTP (user choice) |

All communications use TLS certificate validation. No telemetry, analytics, or usage data is collected or transmitted by this application.

---

## Local Data

### What is stored on disk
- Sentinel Solutions cache (~30-50MB of YAML/JSON text files)
- Elastic integration samples (~5MB of vendor log samples)
- Built Cribl packs (.crbl archives)
- Application configuration (mode, field history, accepted terms)

### What is NOT stored
- Azure credentials (managed by Az PowerShell module)
- Production log data (unless explicitly uploaded by the user)

---

## EDR Compatibility

The Azure-Sentinel repository contains detection content that references offensive security tools (BloodHound, Mimikatz, Cobalt Strike, etc.). Some EDR products may flag or terminate the application when fetching these solutions.

The app includes:
- A **built-in blocklist** of known problematic solutions (skipped during fetch)
- **Crash recovery** that auto-detects when EDR kills the process and blocks that solution on next launch
- A **file extension filter** that only downloads text content (YAML, JSON, CSV, TXT, MD) -- executables, scripts, and archives are never fetched

---

## PowerShell Execution

The app executes Azure PowerShell commands using `powershell.exe -NoProfile`. This is used for:
- Checking Azure session status (`Get-AzContext`)
- Listing subscriptions, workspaces, and resource groups
- Creating resources and deploying ARM templates
- Running lab automation scripts

PowerShell scripts from the repository run with `-ExecutionPolicy Bypass` to avoid script signing requirements.

---

## Known Limitations

- **Platform:** Tested on Windows 11 only. Other operating systems may have issues with PowerShell-based features.
- **Self-managed Cribl:** HTTP (non-TLS) connections are supported for on-premises Cribl leaders on private networks.
- **MFA/Conditional Access:** Azure tenants with MFA policies may require running `Connect-AzAccount` in a separate terminal before using the app.

---

## Recommendations

1. Use a **dedicated Azure subscription** or resource group for lab and testing
2. Use **least-privilege credentials** -- Contributor on the target resource group is sufficient
3. Use **fine-grained GitHub PATs** with read-only public repository access
4. Use **scoped Cribl OAuth clients** rather than admin credentials
5. Use **Air-Gapped mode** when you want to review all changes before applying them
6. **Review generated packs** before deploying to production Cribl environments
7. **Delete lab resources** when no longer needed to avoid Azure charges

---

## Disclaimer

This software is provided as-is. You are responsible for reviewing and approving any resources created or configurations deployed by this toolkit. The authors are not responsible for costs incurred, data loss, or unauthorized modifications resulting from use of this application.

This application is not endorsed by or affiliated with Microsoft Corporation or Cribl, Inc.
