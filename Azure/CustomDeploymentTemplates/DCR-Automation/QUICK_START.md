# 🚀 DCR Automation Quick Start

## Prerequisites
- DCR or Kind:Direct require Cribl Stream 4.14+
- PowerShell 5.1+ with Azure PowerShell modules (Az.Accounts, Az.Resources, Az.OperationalInsights)
- Azure subscription with appropriate permissions
- Log Analytics Workspace already created

## 1️⃣ Configure Azure Settings

Edit `prod/azure-parameters.json` with your Azure details:

```json
{
  "resourceGroupName": "your-rg-name",
  "workspaceName": "your-workspace-name",
  "location": "eastus",
  "dcrPrefix": "dcr-",
  "tenantId": "your-tenant-id",
  "clientId": "your-app-client-id",
  "clientSecret": "your-app-secret"
}
```

**Note:** The `tenantId`, `clientId`, and `clientSecret` are required for Cribl Stream integration.

## 2️⃣ Connect to Azure

```powershell
Connect-AzAccount
Set-AzContext -Subscription "Your-Subscription-Name"  # If multiple subscriptions
```

## 3️⃣ Launch the Interactive Menu

```powershell
.\Run-DCRAutomation.ps1
```

You'll see an interactive menu like this:

```
============================================================
         DCR AUTOMATION DEPLOYMENT MENU
============================================================
⚠️  IMPORTANT: Ensure azure-parameters.json is updated!

📍 Current Configuration:
   Workspace: your-workspace-name
   Resource Group: your-rg-name
   DCR Mode: Direct

📋 DEPLOYMENT OPTIONS:

  [1] ⚡ Quick Deploy (Operational Parameters)
      ➤ Deploy both Native + Custom tables using current settings
  --------------------------------------------------------
  [2] Deploy DCR (Native Direct)
  [3] Deploy DCR (Native w/DCE)
  [4] Deploy DCR (Custom Direct)
  [5] Deploy DCR (Custom w/DCE)
  --------------------------------------------------------
  [Q] Quit
============================================================

Select an option:
```

## 4️⃣ Menu Options Explained


### Option 1: Quick Deploy ⚡ 
- Deploys BOTH native and custom tables
- Uses settings from `prod/operation-parameters.json`
- Default: Direct DCRs (simpler, cost-effective)
- **Best for:** Getting started quickly

### Option 2: Native Tables - Direct DCRs
- Deploys tables listed in `prod/NativeTableList.json`
- Creates Direct DCRs (no DCE required)
- **Best for:** Standard Sentinel tables

### Option 3: Native Tables - DCE-based DCRs
- Same tables as Option 2
- Creates DCE + DCRs (for private endpoints)
- **Best for:** Private network scenarios

### Option 4: Custom Tables - Direct DCRs
- Deploys custom tables from `prod/CustomTableList.json`
- Tables must end with `_CL` suffix
- **Best for:** Custom application logs

### Option 5: Custom Tables - DCE-based DCRs
- Same as Option 4 but with a DCE
- **Best for:** Custom tables with private endpoints

## 5️⃣ Deployment Workflow

1. **Select an option** (e.g., press `1` for Quick Deploy)
2. **Review confirmation** showing what will be deployed
3. **Type `Y`** to proceed or `N` to cancel
4. **Watch progress** as DCRs are created
5. **Cribl config automatically exported** to `prod/cribl-dcr-configs\`

## 6️⃣ After Deployment

### View Cribl Configuration
The menu automatically exports configuration. To generate individual Cribl destinations to: `cribl-dcr-configs\destinations`

### Files Created
- `prod/cribl-dcr-configs\cribl-dcr-config.json` - Main configuration
- `prod/cribl-dcr-configs\destinations\*.json` - Individual Cribl destinations
- `prod/generated-templates\*.json` - ARM templates (for reference or manual deployment from the Azure `Deploy a custom template` wizard)

## 📝 Table Configuration

### Native Tables (Update for your use case)
Edit `prod/NativeTableList.json`:
```json
[
    "CommonSecurityLog",
    "SecurityEvent",
    "Syslog",
    "WindowsEvent"
]
```
**Important:** Custom tables must end with `_CL` suffix

### Custom Tables (Update for Custom tables that you need created or already exist)
Edit `prod/CustomTableList.json`:
```json
[
    "CloudFlare_CL",
    "MyCustomApp_CL"
]
```
**Important:** Custom tables must end with `_CL` suffix

### Custom Table Schemas
If a custom table doesn't exist in Azure, create a schema file:
`prod/custom-table-schemas\MyCustomApp_CL.json`

```json
{
  "description": "My application logs",
  "retentionInDays": 30,
  "columns": [
    {"name": "TimeGenerated", "type": "datetime"},
    {"name": "Message", "type": "string"},
    {"name": "Level", "type": "string"}
  ]
}
```

## 🎯 Quick Decision Guide

| Scenario | Choose Option |
|----------|--------------|
| **First time setup** | Option 1 (Quick Deploy) |
| **Just need Sentinel tables** | Option 2 (Native Direct) |
| **Have custom applications** | Option 4 (Custom Direct) |
| **Need private endpoints** | Options 3 or 5 (with DCE) |
| **Want to review first** | Run with `-NonInteractive -Mode TemplateOnly` |

## 🔧 Troubleshooting

| Issue | Solution |
|-------|----------|
| **Menu doesn't appear** | Check PowerShell execution policy: `Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser` |
| **"Table not found"** | Verify table exists in Azure or create schema file |
| **"DCR name too long"** | Script auto-abbreviates names |
| **"Access denied"** | Check Azure permissions and `Connect-AzAccount` |
| **Custom table collision** | Rename custom table to avoid native table names |

## ✅ Success Indicators

After successful deployment, you'll see:
- ✅ **DCRs created** message for each table
- 📦 **Cribl configuration exported** notification
- 🔗 **Integration details** (DCR IDs, endpoints, stream names)

## 📚 Additional Resources

- **Full Documentation:** `README.md`
- **Cribl Setup:** `CRIBL_DESTINATIONS_README.md`
- **Direct Support:** Check script output for specific error messages

---

**🎉 Ready to start?** Run `.\Run-DCRAutomation.ps1` and select Option 1 for Quick Deploy!
