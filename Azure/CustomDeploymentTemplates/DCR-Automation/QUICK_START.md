# 🚀 DCR Automation Quick Start Guide - Cribl Integration

This guide will walk you through setting up and using the DCR Automation scripts to create Azure Data Collection Rules (DCRs) for Cribl Stream integration with Azure Log Analytics.

## 📋 Prerequisites

### Required Azure Resources
- **Azure Subscription** with appropriate permissions
- **Log Analytics Workspace** already created
- **Resource Group** for DCRs (and optionally for DCEs)
- **Azure PowerShell Modules** (script will auto-install if missing)

### Required Permissions
- `Microsoft.OperationalInsights/workspaces/read`
- `Microsoft.Insights/dataCollectionRules/*`
- `Microsoft.Insights/dataCollectionEndpoints/*` (if using DCE mode)
- `Microsoft.Resources/deployments/*`

## 🛠️ Initial Setup

### Step 1: Clone or Download the Scripts
Place all files in a local directory, maintaining this structure:
```
DCR-Automation/
├── Run-DCRAutomation.ps1           # Helper script (main entry point)
├── Create-TableDCRs.ps1            # Core automation script
├── azure-parameters.json           # Azure resource configuration
├── operation-parameters.json       # Script behavior settings
├── NativeTableList.json           # List of native tables
├── CustomTableList.json           # List of custom tables
├── dcr-template-direct.json       # ARM template for Direct DCRs
├── dcr-template-with-dce.json     # ARM template for DCE-based DCRs
├── custom-table-schemas/          # Directory for custom table schemas
│   └── MyCustomApp_CL.json       # Example schema file
└── generated-templates/           # Generated templates (created automatically)
```

### Step 2: Configure Azure Parameters
Edit `azure-parameters.json` with your Azure resource details:

```json
{
  "resourceGroupName": "your-rg-name",
  "workspaceName": "your-workspace-name",
  "location": "eastus",
  "dcrPrefix": "dcr-",
  "dcrSuffix": "",
  "dceResourceGroupName": "your-rg-name",
  "dcePrefix": "dce-",
  "dceSuffix": ""
}
```

**Important Notes:**
- `location` must match your Log Analytics workspace location
- `dcrPrefix` + table name + location must be ≤30 chars for Direct DCRs
- DCE parameters only used when creating DCE-based DCRs

### Step 3: Configure Operation Parameters
Edit `operation-parameters.json` to set default behavior:

```json
{
  "deployment": {
    "createDCE": false    // false = Direct DCRs, true = DCE-based DCRs
  },
  "scriptBehavior": {
    "templateOnly": false // true = generate templates without deploying
  },
  "customTableSettings": {
    "enabled": false      // true = process custom tables
  }
}
```

### Step 4: Define Table Lists

#### Native Tables (`NativeTableList.json`)
```json
[
    "CommonSecurityLog",
    "SecurityEvent",
    "Syslog",
    "WindowsEvent"
]
```

#### Custom Tables (`CustomTableList.json`)
```json
[
    "CloudFlare_CL",
    "MyCustomApp_CL",
    "AnotherApp_CL"
]
```

**Note:** Custom table names should include the `_CL` suffix.

### Step 5: Prepare Custom Table Schemas (if needed)
For custom tables that don't exist in Azure yet, create schema files in `custom-table-schemas/`:

Example: `custom-table-schemas/MyCustomApp_CL.json`
```json
{
  "description": "Custom application logs",
  "retentionInDays": 30,
  "totalRetentionInDays": 90,
  "columns": [
    {
      "name": "TimeGenerated",
      "type": "datetime",
      "description": "Timestamp"
    },
    {
      "name": "Computer",
      "type": "string",
      "description": "Computer name"
    },
    {
      "name": "Message",
      "type": "string",
      "description": "Log message"
    },
    {
      "name": "Severity",
      "type": "string",
      "description": "Severity level"
    }
  ]
}
```

## 🏃 Quick Start Commands

### 1️⃣ First Time Setup - Check Configuration
```powershell
# Navigate to script directory
cd "C:\Path\To\DCR-Automation"

# Check current configuration and status
.\Run-DCRAutomation.ps1
```

This shows:
- Current DCR mode (Direct or DCE-based)
- Configured table lists
- Azure resources
- Available commands

### 2️⃣ Connect to Azure
```powershell
# Login to Azure (if not already connected)
Connect-AzAccount

# Select subscription (if you have multiple)
Set-AzContext -Subscription "Your-Subscription-Name"
```

### 3️⃣ Test with Templates First (Recommended)
```powershell
# Generate templates without deploying (for review)
.\Run-DCRAutomation.ps1 -Mode TemplateOnly -DCRMode Direct

# Check generated templates
Get-ChildItem .\generated-templates\
```

### 4️⃣ Deploy DCRs

#### Option A: Direct DCRs (Simpler, Cost-Effective)
```powershell
# Deploy Direct DCRs for native tables
.\Run-DCRAutomation.ps1 -Mode DirectNative

# Deploy Direct DCRs for custom tables
.\Run-DCRAutomation.ps1 -Mode DirectCustom

# Or deploy both at once
.\Run-DCRAutomation.ps1 -Mode DirectBoth
```

#### Option B: DCE-based DCRs (Advanced Features)
```powershell
# Deploy DCE-based DCRs for native tables
.\Run-DCRAutomation.ps1 -Mode DCENative

# Deploy DCE-based DCRs for custom tables
.\Run-DCRAutomation.ps1 -Mode DCECustom

# Or deploy both at once
.\Run-DCRAutomation.ps1 -Mode DCEBoth
```

## 📊 Common Workflows

### Workflow 1: New Environment Setup
```powershell
# 1. Check configuration
.\Run-DCRAutomation.ps1

# 2. Test with one table first
.\Create-TableDCRs.ps1 -SpecificDCR "SecurityEvent" -CreateDCE:$false

# 3. If successful, deploy all native tables
.\Run-DCRAutomation.ps1 -Mode DirectNative

# 4. Then deploy custom tables
.\Run-DCRAutomation.ps1 -Mode DirectCustom
```

### Workflow 2: Adding New Custom Table
```powershell
# 1. Add table name to CustomTableList.json
# 2. Create schema file in custom-table-schemas/ (if table doesn't exist)
# 3. Test deployment
.\Create-TableDCRs.ps1 -SpecificDCR "NewTable_CL" -CustomTableMode

# 4. Deploy if successful
.\Run-DCRAutomation.ps1 -Mode DirectCustom
```

### Workflow 3: Switching from Direct to DCE-based
```powershell
# 1. Generate DCE templates for review
.\Run-DCRAutomation.ps1 -Mode TemplateOnly -DCRMode DCE

# 2. Deploy DCE-based DCRs
.\Run-DCRAutomation.ps1 -Mode DCEBoth

# 3. Clean up old Direct DCRs manually in Azure Portal
```

## 🎯 Mode Selection Guide

### When to Use Direct DCRs
✅ Simple data ingestion scenarios  
✅ Cost optimization is important  
✅ No need for DCE-specific features  
✅ Proof of concept or testing  

### When to Use DCE-based DCRs
✅ Need advanced routing capabilities  
✅ Multiple data sources to same DCR  
✅ Complex transformation requirements  
✅ Enterprise production environments  

## 🔍 Verifying Deployment

### Check in Azure Portal
1. Navigate to your Resource Group
2. Filter by type: "Data collection rule"
3. Verify DCRs are created with correct names
4. Click on each DCR to verify:
   - Data sources configured
   - Destinations point to correct workspace
   - Stream declarations are correct

### Check via PowerShell
```powershell
# List all DCRs in resource group
Get-AzDataCollectionRule -ResourceGroupName "your-rg-name" | 
    Select-Object Name, Location, ProvisioningState | 
    Format-Table

# Get details of specific DCR
Get-AzDataCollectionRule -ResourceGroupName "your-rg-name" -Name "dcr-name"
```

## 🚨 Troubleshooting

### Common Issues and Solutions

#### 1. "Table not found in Azure"
**Solution:** 
- Verify table name in list files
- For custom tables, ensure schema file exists
- Check if table exists: 
```powershell
# Check if table exists in workspace
$workspace = Get-AzOperationalInsightsWorkspace -ResourceGroupName "rg-name" -Name "workspace-name"
Invoke-AzRestMethod -Path "$($workspace.ResourceId)/tables?api-version=2022-10-01" -Method GET
```

#### 2. "DCR name too long"
**Solution:** 
- Direct DCRs have 30-character limit
- Script auto-abbreviates but check output
- Consider shorter prefixes in azure-parameters.json

#### 3. "Authentication failed"
**Solution:**
```powershell
# Clear and reconnect
Disconnect-AzAccount
Connect-AzAccount
Set-AzContext -Subscription "subscription-name"
```

#### 4. "Deployment failed"
**Solution:**
- Check generated template in `generated-templates/`
- Try manual deployment via Azure Portal
- Review error details:
```powershell
Get-AzResourceGroupDeployment -ResourceGroupName "rg-name" | 
    Where-Object {$_.ProvisioningState -eq "Failed"} | 
    Select-Object -First 1 -ExpandProperty DeploymentDebugLogLevel
```

#### 5. "Custom table creation failed"
**Solution:**
- Verify schema file JSON is valid
- Ensure column types are supported
- Check retention settings (1-730 days)
- Verify table name has `_CL` suffix

## 📝 Configuration Reference

### Supported Column Types for Custom Tables
- `string` - Text data
- `int` - 32-bit integer
- `long` - 64-bit integer
- `real` - Floating point number
- `boolean` - True/false
- `datetime` - Timestamp
- `dynamic` - JSON/complex objects

**Note:** GUID types are automatically converted to string.

### DCR Naming Patterns
```
# Direct DCRs (30 char limit)
Pattern: {prefix}{table-abbrev}-{location}{suffix}
Example: dcr-CSL-eastus → CommonSecurityLog

# DCE-based DCRs (64 char limit)
Pattern: {prefix}{table-name}-{location}{suffix}
Example: dcr-CommonSecurityLog-eastus

# DCEs
Pattern: {prefix}{table-name}-{location}{suffix}
Example: dce-CommonSecurityLog-eastus
```

## 📊 Expected Output Examples

### Successful Direct DCR Deployment
```
🚀 Processing NATIVE Tables with DIRECT DCRs...
==================================================
Tables: CommonSecurityLog, SecurityEvent, Syslog, WindowsEvent
DCR Mode: Direct (no DCE required)

--- Processing: SecurityEvent ---
  DCR Name: dcr-SecEvt-eastus
  DCR Mode: Direct
  ✅ Table found: Microsoft-SecurityEvent
  Schema Analysis:
    Total columns from Azure: 45
    Columns to include in DCR: 37
  ✅ Template validation passed
  ✅ Direct DCR deployed successfully!
```

### Successful Custom Table Creation
```
🚀 Processing CUSTOM Tables with DIRECT DCRs...
==================================================
Tables to process: MyCustomApp_CL
DCR Mode: Direct (no DCE required)

--- Processing: MyCustomApp_CL ---
  Processing custom table: MyCustomApp_CL
  Custom table not found in Azure. Looking for schema definition...
  Creating custom table from schema file...
  ✅ Custom table created successfully: MyCustomApp_CL
  DCR Name: dcr-MyCustomApp-eastus
  ✅ Direct DCR deployed successfully!
```

## 🔗 Cribl Integration Configuration

After successful DCR deployment, configure Cribl Stream:

### 1. DCR Configuration is Automatically Exported!
✅ **By default, the script automatically exports Cribl configuration to `cribl-dcr-config.json`**

```powershell
# Just run any deployment command - config is auto-exported
.\Run-DCRAutomation.ps1 -Mode DirectNative    # Auto-exports to cribl-dcr-config.json

# To also display config during deployment
.\Run-DCRAutomation.ps1 -Mode DirectNative -ShowCriblConfig

# To skip automatic export (not recommended)
.\Run-DCRAutomation.ps1 -Mode DirectNative -SkipCriblExport

# For existing DCRs, retrieve configuration
.\Get-CriblDCRInfo.ps1 -ListAll -ExportToJson
```

### 2. Required Information for Cribl
For each DCR, you'll need:
- **DCR Immutable ID**: Unique identifier for the DCR
- **Ingestion Endpoint**: URL for data ingestion
- **Stream Name**: The data stream to use (e.g., `Custom-SecurityEvent`)
- **Table Name**: Target table in Log Analytics

### 3. Azure AD App Registration
Cribl needs an Azure AD App for authentication:
1. Create App Registration in Azure Portal
2. Generate Client Secret
3. Note down:
   - Tenant ID
   - Client ID (Application ID)
   - Client Secret

### 4. Grant Permissions
Assign the **Monitoring Metrics Publisher** role to your App:
```powershell
# For each DCR
$dcrResourceId = "/subscriptions/{sub-id}/resourceGroups/{rg}/providers/Microsoft.Insights/dataCollectionRules/{dcr-name}"
$appObjectId = "your-app-object-id"

New-AzRoleAssignment -ObjectId $appObjectId `
    -RoleDefinitionName "Monitoring Metrics Publisher" `
    -Scope $dcrResourceId
```

### 5. Configure Cribl Azure Logs Destination
In Cribl Stream:
1. Go to Destinations → Azure Logs
2. Configure with:
   - **Authentication**: Use Client Credentials
   - **Tenant ID**: Your Azure tenant ID
   - **Client ID**: App registration client ID
   - **Client Secret**: App registration secret
   - **DCR Immutable ID**: From DCR info
   - **Ingestion Endpoint**: From DCR info
   - **Stream Name**: From DCR info

## 🎉 Next Steps

After Cribl configuration:

1. **Test Data Flow**
   - Send test events from Cribl
   - Verify data arrives in Log Analytics
   - Check correct table and schema

2. **Monitor Ingestion**
   - Monitor Cribl metrics and throughput
   - Check Log Analytics for incoming data
   - Verify costs and performance

3. **Maintain and Update**
   - Add new tables as needed for new data sources
   - Update DCRs for schema changes
   - Clean up unused DCRs/DCEs

## 📚 Additional Resources

- [Azure Monitor Data Collection Rules](https://docs.microsoft.com/azure/azure-monitor/essentials/data-collection-rule)
- [Log Analytics Tables](https://docs.microsoft.com/azure/azure-monitor/logs/tables-feature-overview)
- [Cribl Stream Documentation](https://docs.cribl.io/stream/)
- [Cribl Azure Logs Destination](https://docs.cribl.io/stream/destinations-azure-logs/)
- [ARM Template Reference](https://docs.microsoft.com/azure/templates/microsoft.insights/datacollectionrules)

## 💡 Pro Tips

1. **Always test with templates first** - Use `-Mode TemplateOnly` to review before deploying
2. **Start with one table** - Use `-SpecificDCR` parameter to test single table
3. **Use Direct DCRs when possible** - Simpler and more cost-effective
4. **Keep schemas versioned** - Store schema files in source control
5. **Monitor costs** - DCEs incur additional charges
6. **Clean up old resources** - Remove unused DCRs/DCEs to avoid confusion
7. **Document custom tables** - Maintain README in custom-table-schemas/

---

## 🆘 Getting Help

If you encounter issues:

1. Run status check: `.\Run-DCRAutomation.ps1`
2. Review generated templates in `generated-templates/`
3. Check Azure Activity Log for deployment errors
4. Enable verbose output in operation-parameters.json
5. Test with a single table using `-SpecificDCR` parameter

## 🔧 Cribl-Specific Features

This automation includes Cribl-specific capabilities:

### Show Cribl Configuration During Deployment
```powershell
# Display Cribl config info after each DCR creation
.\Create-TableDCRs.ps1 -ShowCriblConfig
```

### Export Cribl Configuration
```powershell
# Export all DCR configs to JSON for Cribl setup
.\Create-TableDCRs.ps1 -ExportCriblConfig

# Both display and export
.\Create-TableDCRs.ps1 -ShowCriblConfig -ExportCriblConfig
```

### Retrieve Existing DCR Information
```powershell
# Get info for all DCRs in resource group
.\Get-CriblDCRInfo.ps1 -ListAll

# Get specific DCR
.\Get-CriblDCRInfo.ps1 -DCRName "dcr-CSL-eastus" -ResourceGroupName "rg-name"

# Export all DCR info to JSON
.\Get-CriblDCRInfo.ps1 -ListAll -ExportToJson
```

### Sample Cribl Configuration Output
```
🔗 CRIBL INTEGRATION CONFIGURATION
═══════════════════════════════════
  DCR Immutable ID: 1234abcd-5678-90ef-ghij-klmnopqrstuv
  Ingestion Endpoint: https://eastus.ingest.monitor.azure.com
  Stream Name: Custom-SecurityEvent
  Target Table: SecurityEvent
  DCR Type: Direct
═══════════════════════════════════
```

For complex deployments, consider using Azure Portal for manual deployment with generated templates.
