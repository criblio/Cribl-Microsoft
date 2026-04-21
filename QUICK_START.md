# Quick Start Guide

## Prerequisites

1. **Windows 11** (tested platform)
2. **Node.js 18+** -- [Download](https://nodejs.org/)
3. **Azure PowerShell** -- Open PowerShell and run:
   ```powershell
   Install-Module -Name Az -Scope CurrentUser -Force
   ```
4. **GitHub Personal Access Token** -- [Create one](https://github.com/settings/tokens) with "Public Repositories (read-only)" access
5. **Cribl Stream 4.14+** with an OAuth client (for Cloud) or admin credentials (for self-managed)

## Launch the App

```batch
# Windows
Start-App-Windows.bat
```

On first run, the app will install Node.js dependencies automatically.

## Step 1: Content Repositories

The app starts on the Repositories page.

1. **Paste your GitHub PAT** in the token field and click **Save Token**
2. Click **Fetch** on the Azure-Sentinel Content section -- this downloads ~2500 text files from the Sentinel Solutions repo (~30-50MB)
3. Optionally click **Fetch** on Elastic Integrations -- this caches vendor sample data from 434+ integrations
4. Click **Continue** (requires Sentinel repo to be fetched)

## Step 2: Cribl Stream Connection

1. Select **Cribl Cloud** or **On-Prem / Self-Managed**
2. For Cloud: enter your **Organization ID** and **OAuth Client ID/Secret**
3. For Self-Managed: enter the **Leader Address**, **Port**, **Username/Password**
4. Click **Reconnect** (if saved credentials exist) or **Test Connection**
5. Click **Continue** or **Skip Cribl** for offline mode

## Step 3: Azure Connection

The app uses your existing Azure PowerShell session. Before this step:

```powershell
# In a separate PowerShell terminal:
Connect-AzAccount
```

Then in the app, click **Detect Existing Session**.

## Step 4: Mode Selection

Choose your integration mode:
- **Full** -- Cribl + Azure (recommended)
- **Azure Only** -- DCR deployment without Cribl
- **Cribl Only** -- Pack building without Azure deployment
- **Air-Gapped** -- Offline artifact generation

Click **Complete Setup** to enter the main app.

---

## Using the Sentinel Integration Page

This is the main workflow page. It has 6 sections:

### Section 1: Select a Sentinel Solution

1. Type a vendor name in the **Search** box (e.g., "zscaler", "fortinet", "palo")
2. Select the solution from the dropdown
3. The pack name auto-generates (editable)

### Section 2: Sample Data

Samples inform the pipeline field mapping. Three ways to get samples:

- **Browse Samples** -- Opens a modal showing available Elastic integration samples for the selected solution. Select the log types you want and click **Load Selected**
- **Upload Files** -- Upload your own vendor log files (.json, .log, .csv, .txt)
- **Paste** -- Paste raw log events in the text area, enter a log type name, click **Add Sample**

After loading samples:
- Each log type appears as a tag (e.g., "firewall", "dns", "tunnel")
- Click **rename** on any tag to change the log type name (this affects pipeline and route naming)
- Click the tag to expand and see parsed fields
- Click **x** to remove a sample

For **headerless CSV files** (e.g., Zscaler NSS output feeds): the app detects missing headers and shows a dialog where you can upload a header file or paste a vendor feed configuration to map column names.

### Section 3: Azure Resources

1. Select your **Subscription** from the dropdown
2. Select a **Log Analytics Workspace** -- the resource group and location auto-populate
3. Optionally create a **new resource group** for DCR deployment
4. Check options: DCE, metrics, RBAC assignment

If the subscription dropdown is empty, run `Connect-AzAccount` in PowerShell and restart the app.

### Section 4: Cribl Configuration

1. Select the **Worker Group(s)** to deploy the pack to
2. The pack name is shown (auto-generated from the solution name)

### Section 5: Deploy

Click **Deploy** to:
1. Create the resource group (if new)
2. Check for existing DCRs and deploy new ones
3. Build the Cribl pack with:
   - Per-log-type transformation pipelines
   - Field mapping lookup tables
   - Reduction pipelines (for volume optimization)
   - Sample data files
   - Route configuration
4. Package as `.crbl` and upload to Cribl Stream
5. Commit and deploy the configuration

The deploy log shows real-time progress.

### Section 6: Source Wiring

After deployment:
1. Select a **Cribl source** from the dropdown (e.g., a syslog or HTTP input)
2. Click **Wire** to create routes from the source through the pack to the Sentinel destination
3. Optionally enable **Cribl Lake federation** for a full-fidelity copy

---

## Using the SIEM Migration Page

For migrating from Splunk or QRadar:

1. Select **Splunk (JSON)** or **QRadar (CSV)**
2. Upload the detection rule export file
3. Review the data source mapping -- each source is mapped to a Sentinel solution with a confidence indicator
4. Click **Configure** on any solution to jump to the Sentinel Integration page with that solution pre-selected
5. Click **Download Migration Report** for a Markdown summary

---

## Using the Lab Environments Page

Deploy pre-configured Azure lab environments:

1. Click a **lab card** to select it (9 types available)
2. **Sentinel Quick Start** creates a resource group, workspace, and enables Sentinel in ~2 minutes
3. Other labs use PowerShell scripts with configurable parameters
4. Fill in the wizard steps and click **Deploy**

---

## Troubleshooting

### Subscription dropdown is empty
Run `Connect-AzAccount` in a PowerShell terminal, then restart the app or click "Detect Existing Session" on the wizard's Azure step.

### Resource group dropdown is empty
Select a subscription first. If still empty, the workspace selection should auto-populate the resource group. Select a workspace to populate it.

### "Sentinel repo not cloned" warning
Go to the **Repositories** sidebar item and click **Fetch** on the Sentinel content section.

### Pack deployment fails
Check the deploy log for specific errors. Common issues:
- Missing Azure permissions (need Contributor or Owner on the resource group)
- Cribl connection timeout (check the Cribl leader URL and credentials)
- DCR naming conflicts (delete existing DCRs in Azure portal if needed)

### Browse Samples returns no results
- The Elastic integrations repo must be fetched (Repositories page)
- Not all solutions have Elastic sample data
- Only samples with self-describing fields (JSON, KV, CEF) are shown -- headerless CSV is filtered out unless PAN-OS format is detected

### App is slow to start
The app checks both Cribl and Azure connections on startup. If the Cribl leader is unreachable, the connection test can take up to 60 seconds. Skip Cribl in the wizard to avoid this.

---

## Key Directories

| Directory | Contents |
|-----------|----------|
| `%APPDATA%/.cribl-microsoft/packs/` | Built Cribl packs and .crbl files |
| `%APPDATA%/.cribl-microsoft/sentinel-repo/` | Local Sentinel Solutions repo cache |
| `%APPDATA%/.cribl-microsoft/elastic-samples/` | Cached Elastic integration samples |
| `%APPDATA%/.cribl-microsoft/auth/` | Encrypted credentials (OS keychain) |
| `%APPDATA%/.cribl-microsoft/config/` | App configuration files |
