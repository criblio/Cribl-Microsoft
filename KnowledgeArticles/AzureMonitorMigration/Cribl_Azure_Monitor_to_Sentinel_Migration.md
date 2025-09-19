# Migrating Cribl from Azure Monitor to Sentinel Destination

## Executive Summary

Microsoft is retiring the HTTP Data Collector API on **September 14, 2026**. This affects custom tables (_CL suffix) using the Cribl Azure Monitor destination. This guide provides a step-by-step guide with **DCR Automation solution** as the primary migration path to the modern Sentinel destination using Azure Logs Ingestion API.

## 🚀 Quick Migration Path

 Use the **DCR Automation Tool**

```bash
# 1. Get the automation tool
git clone https://github.com/criblio/Cribl-Microsoft.git
cd Cribl-Microsoft/Azure/CustomDeploymentTemplates/DCR-Automation

# 2. Important: Read the QUICK_START.md file first and Configure files
Cribl-Microsoft/Azure/CustomDeploymentTemplates/DCR-Automation/QUICK_START.md
#Update/Review
azure-parameters.json
NativeTableList.json
CustomTableList.json

# 3. Run
.\Run-DCRAutomation.ps1
# Select [4] for Custom Tables with Direct DCRs

# 4. Review and copy Cribl configs from cribl-dcr-configs/destinations/
```

## Why This Migration is Required

**Custom Type**: `Custom table (Classic)` need migration prior to the retirement of the HTTP Log Ingestion API. The new Logs Ingestion API provides:
- **Enhanced Security**: OAuth-based authentication vs shared keys
- **Data Transformations**: KQL-based filtering and modification
- **Granular RBAC**: Fine-grained access control
- **Schema Control**: Prevents uncontrolled column creation
- **Better Performance**: Optimized ingestion pipeline

## Prerequisites

1. **Azure Environment**:
   - Log Analytics workspace with contributor rights
   - Permissions to create Data Collection Rules (DCRs)
   - PowerShell 5.1+ with Az PowerShell modules
   - Ability to execute Powershell (Exceution Policy Override) to interact with Azure objects

2. **Cribl Environment**:
   - Cribl Stream with existing Azure Monitor destinations
   - Custom tables using Azure Monitor Tile

3. **DCR Automation Tool**:
   ```bash
   git clone https://github.com/criblio/Cribl-Microsoft.git
   cd Cribl-Microsoft/Azure/CustomDeploymentTemplates/DCR-Automation
   ```

## How DCR Automation Handles Table Migration

**✅ AUTOMATED**: The DCR Automation tool now automatically handles table migration!

### What the Automation Does
1. **Detects table types** automatically (Classic vs Modern)
2. **Migrates Classic tables to DCR-based** when needed
3. **Creates DCRs** for all compatible tables
4. **Exports Cribl configurations** ready for import

### Table Types (Handled Automatically)
| Type | Old API | New API | Automation Action |
|------|---------|---------|-------------------|
| **Custom Table (Classic)** | ✅ | ❌ | ✅ Auto-migrates to DCR-based |
| **Custom Table** | ✅ (until 2026) | ✅ | ✅ Creates DCRs directly |

## Step-by-Step Migration

### Step 1: Inventory Custom Tables

In Azure Portal → Log Analytics → Tables:
- Filter by `_CL` or Custom type
- Note table names for configuration
- **Type** column reference:
  - **"Custom Table"** = ✅ Ready for DCR creation
  - **"Custom Table (Classic)"** = ✅ Will be auto-migrated by automation

### Step 2: Create Azure App Registration

1. **Azure Active Directory** → **App registrations** → **New registration**
2. Configure:
   - Name: `cribl-sentinel-connector`
   - Single tenant
3. Save: Application ID, Directory ID
4. Create client secret and **copy immediately**

### Step 3: Configure DCR Automation

Edit `azure-parameters.json`:
```json
{
  "resourceGroupName": "your-rg-name",
  "workspaceName": "your-workspace",
  "location": "eastus",
  "dcrPrefix": "dcr-cribl-",
  "tenantId": "your-tenant-id",
  "clientId": "your-app-client-id",
  "clientSecret": "your-app-secret"
}
```

Edit `CustomTableList.json` with **your custom tables** (automation handles migration):
```json
[
    "FirewallLogs_CL",
    "ApplicationLogs_CL",
    "CloudFlare_CL"
]
```

### Step 4: Run DCR Automation (Handles Migration + DCR Creation)

```powershell
# Connect to Azure
Connect-AzAccount

# Option 1: Interactive Menu (Recommended)
.\Run-DCRAutomation.ps1
# Select [4] "Deploy DCR (Custom Direct)"

# Option 2: Command Line
.\Run-DCRAutomation.ps1 -Mode DirectCustom
```

**What this does automatically**:
- ✅ Detects table types (Classic vs Modern)
- ✅ Migrates Classic tables to DCR-based format
- ✅ Captures schemas from Azure
- ✅ Creates DCRs for each table
- ✅ Exports Cribl configurations to `cribl-dcr-configs/`
- ✅ Generates individual destination files

### Step 5: Assign DCR Permissions

Grant app registration access to each DCR from the portal or through your standard change process.

### Step 6: Configure Cribl Stream

1. **Import Destination Configs**:
   - Navigate to **Manage** → **Data** → **Destinations**
   - Add **Microsoft Sentinel** destination for each table
   - Use configs from `cribl-dcr-configs/destinations/`
   - Update secret in Authorization section with your App registration secret

2. **Update Pipelines**: 
**Critical Step**: The output from Cribl must match the DCR schema for data to be accepted
   - Review Cribl Packs Dispensary for Examples to get started
   - Ensure pipeline output matches DCR schema
   - Review Cribl Packs Dispensary for Sentinel content

### Step 7: Test and Validate

```kusto
// Check data flow
YourTable_CL
| where TimeGenerated > ago(1h)
| summarize Count = count(),
            LastRecord = max(TimeGenerated)
| extend Status = iff(Count > 0, "✅ Data flowing", "❌ No data")
```

### Step 8: Gradual Cutover

- **Week 1**: Test with 10% traffic
- **Week 2**: Increase to 50%
- **Week 3**: Full cutover to Sentinel destinations
- **Week 4**: Remove old Azure Monitor destinations

## DCR Automation Menu Options

When running `.\Run-DCRAutomation.ps1`:

```
📋 DEPLOYMENT OPTIONS:
  [1] ⚡ Quick Deploy (both Native + Custom)
  [2] Deploy DCR (Native Direct)
  [3] Deploy DCR (Native w/DCE)
  [4] Deploy DCR (Custom Direct)     ← For custom table migration
  [5] Deploy DCR (Custom w/DCE)      
```

**For most migrations**: Choose **[4] Custom Direct** - simplest architecture

## Troubleshooting

| Issue | Solution |
|-------|----------|
| **"Cannot create DCR"** | Check table exists and automation has proper permissions |
| **"Table migration failed"** | Automation will retry; ensure workspace contributor access |
| **"No data via new API"** | Check IAM roles on DCR and app registration |
| **"Schema mismatch"** | Update pipeline to match DCR schema |
| **"Classic table detected"** | ✅ Normal - automation will migrate automatically |


## Timeline for Migration

- **Week 1**: 
  -  Inventory tables and create app registration
  - Run DCR automation (handles table migration + DCR creation)
  -  Configure Cribl and test with limited traffic
     -  Note: Pipelines will need to transform Cribl output to match table schema
- **Week 2-3**: Gradual cutover to new destinations
- **Before Sept 2026**: Complete migration before API retirement

## Key Benefits of DCR Automation

✅ **Fully Automated Migration**: Automatically migrates Classic tables to DCR-based
✅ **Single Solution**: Handles table migration, DCR creation, and Cribl config export
✅ **Automatic Schema Detection**: No manual schema definition needed
✅ **Cribl Integration**: Exports ready-to-use destination configurations
✅ **Interactive Menu**: Guided deployment with confirmation prompts
✅ **Template Generation**: Creates ARM templates for CI/CD scenarios
✅ **Error Handling**: Comprehensive validation and user guidance
✅ **Smart Detection**: Identifies table types and applies appropriate migration strategy

## Support
- **Pipeline Transformation Support**: Reach out to your account team
- **Tool Issues**: James Pederson jpederson@cribl.io
- **Community**: [Cribl Slack](https://cribl.io/community)

---

**🎯 Summary**: The DCR Automation tool is your complete migration solution. It handles the complexity of Azure API interactions and provides ready-to-use Cribl configurations, making the migration from Azure Monitor to Sentinel destinations straightforward and reliable.
