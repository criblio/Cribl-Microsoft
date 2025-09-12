# Azure Data Collection Rules Automation for Cribl Integration

This PowerShell automation system streamlines the deployment of Azure Data Collection Rules (DCRs) for integrating Cribl Stream with Azure Log Analytics/Microsoft Sentinel. It supports both native and custom tables, with automatic Cribl configuration export.

## 🚀 Key Features

- **Unified Solution**: Single system handles both DCE-based and Direct DCRs
- **Dual Table Support**: Processes both native Azure tables and custom tables (_CL suffix)
- **Automatic Cribl Export**: By default, exports configuration for Cribl Stream integration
- **Template-Only Mode**: Generate ARM templates without deploying resources
- **Smart Schema Management**: Automatically retrieves schemas from Azure or uses local definitions
- **Intelligent Naming**: Auto-abbreviates names for Azure's 30-character limit on Direct DCRs
- **Cribl Destination Generation**: Creates ready-to-import Cribl Stream destination configs

## 📁 File Structure

```
DCR-Automation/
├── Run-DCRAutomation.ps1              # Main entry point with simplified commands
├── Create-TableDCRs.ps1               # Core engine for DCR creation
├── Generate-CriblDestinations.ps1     # Generates Cribl destination configs
├── azure-parameters.json              # Azure resources & authentication (CONFIGURE THIS)
├── cribl-parameters.json              # Cribl naming conventions
├── operation-parameters.json          # Script behavior settings
├── NativeTableList.json               # Native tables to process
├── CustomTableList.json               # Custom tables to process
├── dcr-template-direct.json           # ARM template for Direct DCRs
├── dcr-template-with-dce.json         # ARM template for DCE-based DCRs
├── dst-cribl-template.json            # Template for Cribl destinations
├── custom-table-schemas/              # Schema definitions for custom tables
│   ├── CloudFlare_CL.json
│   ├── MyCustomApp_CL.json
│   └── README.md
├── generated-templates/               # Generated ARM templates (auto-created)
├── cribl-dcr-configs/                 # Cribl configurations (auto-created)
│   ├── cribl-dcr-config.json         # Main DCR configuration
│   └── destinations/                  # Individual destination configs
├── README.md                          # This documentation
├── QUICK_START.md                     # Quick setup guide
└── CRIBL_DESTINATIONS_README.md      # Cribl destination details
```

## ⚙️ Configuration Files

### 1. azure-parameters.json (MUST CONFIGURE)
```json
{
  "resourceGroupName": "your-rg-name",
  "workspaceName": "your-la-workspace",
  "location": "eastus",
  "dcrPrefix": "dcr-",
  "dcrSuffix": "",
  "dceResourceGroupName": "your-rg-name",
  "dcePrefix": "dce-",
  "dceSuffix": "",
  "tenantId": "your-tenant-id",
  "clientId": "your-app-client-id",
  "clientSecret": "your-app-secret"
}
```

**Important:**
- `tenantId`, `clientId`, `clientSecret` are for Azure AD authentication in Cribl
- DCE parameters only used when `createDCE=true`
- Direct DCRs have 30-character name limit (auto-abbreviated)

### 2. operation-parameters.json
```json
{
  "deployment": {
    "createDCE": false              // false = Direct DCRs, true = DCE-based
  },
  "scriptBehavior": {
    "templateOnly": false           // true = generate templates only
  },
  "customTableSettings": {
    "enabled": false                // true = process custom tables
  }
}
```

### 3. Table Lists
- **NativeTableList.json**: Native Azure tables (SecurityEvent, Syslog, etc.)
- **CustomTableList.json**: Custom tables with _CL suffix

## 🔄 DCR Modes

| Feature | Direct DCR | DCE-based DCR |
|---------|------------|---------------|
| **Architecture** | Data → Log Analytics | Data → DCE → Log Analytics |
| **Resources** | DCR only | DCR + DCE |
| **Name Limit** | 30 characters | 64 characters |
| **Cost** | Lower | Higher (DCE costs) |
| **Complexity** | Simple | Advanced routing |
| **Use Case** | Most scenarios | Private endpoints, advanced routing |

## 🎯 Quick Start

### 1. Configure Azure Settings
```powershell
# Edit azure-parameters.json with your values
```

### 2. Connect to Azure
```powershell
Connect-AzAccount
```

### 3. View Available Commands
```powershell
.\Run-DCRAutomation.ps1
```

### 4. Deploy DCRs
```powershell
# Test with templates first
.\Run-DCRAutomation.ps1 -Mode TemplateOnly -DCRMode Direct

# Deploy Direct DCRs (recommended)
.\Run-DCRAutomation.ps1 -Mode DirectBoth

# Or deploy DCE-based DCRs
.\Run-DCRAutomation.ps1 -Mode DCEBoth
```

## 🚀 Usage Examples

### Basic Commands
```powershell
# View status and available commands
.\Run-DCRAutomation.ps1

# Deploy native tables with Direct DCRs
.\Run-DCRAutomation.ps1 -Mode DirectNative

# Deploy custom tables with Direct DCRs
.\Run-DCRAutomation.ps1 -Mode DirectCustom

# Deploy all tables
.\Run-DCRAutomation.ps1 -Mode DirectBoth

# Generate templates only (no deployment)
.\Run-DCRAutomation.ps1 -Mode TemplateOnly
```

### Advanced Usage
```powershell
# Deploy specific table
.\Create-TableDCRs.ps1 -SpecificDCR "SecurityEvent"

# Custom table with schema
.\Create-TableDCRs.ps1 -CustomTableMode -SpecificDCR "MyApp_CL"

# Template generation for CI/CD
.\Create-TableDCRs.ps1 -TemplateOnly

# With Cribl config display
.\Run-DCRAutomation.ps1 -Mode DirectBoth -ShowCriblConfig
```

### Cribl Configuration
```powershell
# Collect configuration from existing DCRs
.\Run-DCRAutomation.ps1 -Mode CollectCribl

# Validate Cribl configuration
.\Run-DCRAutomation.ps1 -Mode ValidateCribl

# Generate individual destination configs
.\Generate-CriblDestinations.ps1
```

## 📋 Script Parameters

### Run-DCRAutomation.ps1
| Parameter | Options | Description |
|-----------|---------|-------------|
| Mode | Status, Native, Custom, Both, TemplateOnly, DirectNative, DirectCustom, DirectBoth, DCENative, DCECustom, DCEBoth, CollectCribl, ValidateCribl | Operation mode |
| DCRMode | Direct, DCE, Current | Override DCR type |
| ShowCriblConfig | Switch | Display Cribl config during deployment |
| SkipCriblExport | Switch | Skip automatic config export |

### Create-TableDCRs.ps1
| Parameter | Type | Description |
|-----------|------|-------------|
| CreateDCE | Switch | Create DCE-based DCRs |
| TemplateOnly | Switch | Generate templates without deployment |
| CustomTableMode | Switch | Process custom tables |
| SpecificDCR | String | Process only specified table |
| ShowCriblConfig | Switch | Display Cribl configuration |
| ExportCriblConfig | Switch | Export to JSON (default: true) |

## 🔗 Cribl Integration

### Automatic Configuration Export
By default, the system exports Cribl configuration to `cribl-dcr-configs\cribl-dcr-config.json` containing:
- DCR Immutable IDs
- Ingestion Endpoints
- Stream Names
- Table Names

### Generate Destination Configs
```powershell
# Creates individual Cribl destination files
.\Generate-CriblDestinations.ps1
```

Output in `cribl-dcr-configs\destinations\`:
- Individual JSON configs for each DCR
- Ready to import into Cribl Stream
- Includes authentication from azure-parameters.json

### Required Azure AD Permissions
Grant **Monitoring Metrics Publisher** role to your Azure AD app on each DCR:
```powershell
$dcrResourceId = "/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.Insights/dataCollectionRules/{dcr}"
New-AzRoleAssignment -ObjectId "app-object-id" -RoleDefinitionName "Monitoring Metrics Publisher" -Scope $dcrResourceId
```

## 📊 Custom Tables

### Creating Custom Table Schemas
Place schema files in `custom-table-schemas\`:

```json
{
  "description": "My custom application logs",
  "retentionInDays": 30,
  "totalRetentionInDays": 90,
  "columns": [
    {
      "name": "TimeGenerated",
      "type": "datetime",
      "description": "Timestamp"
    },
    {
      "name": "Message",
      "type": "string",
      "description": "Log message"
    }
  ]
}
```

### Supported Column Types
- `string`, `int`, `long`, `real`, `boolean`, `datetime`, `dynamic`

### Processing Custom Tables
```powershell
# Enable in operation-parameters.json
"customTableSettings": { "enabled": true }

# Or via command
.\Run-DCRAutomation.ps1 -Mode DirectCustom
```

## 🎯 Template-Only Mode

Perfect for CI/CD pipelines and review:
```powershell
# Generate templates with real schemas from Azure
.\Run-DCRAutomation.ps1 -Mode TemplateOnly

# Templates saved to generated-templates/
# - {TableName}-latest.json (current version)
# - {TableName}-{timestamp}.json (versioned)
```

## 📈 Best Practices

1. **Start with Direct DCRs** - Simpler and more cost-effective
2. **Test with templates first** - Use `-Mode TemplateOnly`
3. **Deploy single table first** - Use `-SpecificDCR "TableName"`
4. **Review Cribl configs** - Check `cribl-dcr-configs\` before importing
5. **Protect credentials** - Never commit azure-parameters.json with real values
6. **Monitor costs** - DCEs incur additional charges

## 🚨 Troubleshooting

### Common Issues

| Issue | Solution |
|-------|----------|
| "Table not found" | Check spelling in TableList.json files |
| "DCR name too long" | Script auto-abbreviates, check output |
| "Authentication error" | Run `Connect-AzAccount` |
| "Template too large" | Use manual deployment via Azure Portal |
| "Custom table missing" | Create schema in `custom-table-schemas\` |

### Validation Commands
```powershell
# Check current configuration
.\Run-DCRAutomation.ps1 -Mode Status

# Validate tables exist
.\Create-TableDCRs.ps1 -ValidateTablesOnly

# Test single table
.\Create-TableDCRs.ps1 -SpecificDCR "SecurityEvent" -TemplateOnly
```

## 🔐 Security Recommendations

1. **Protect sensitive files**:
```bash
# Add to .gitignore
azure-parameters.json
cribl-dcr-configs/
*.backup.json
```

2. **Use environment variables** for secrets:
```powershell
$env:AZURE_CLIENT_SECRET = "your-secret"
```

3. **Minimum Azure AD permissions**:
- `Microsoft.Insights/dataCollectionRules/*`
- `Microsoft.OperationalInsights/workspaces/read`
- `Microsoft.Insights/dataCollectionEndpoints/*` (if using DCEs)

## 📊 Expected Output

### Successful Deployment
```
🚀 Processing NATIVE Tables with DIRECT DCRs...
==================================================

--- Processing: SecurityEvent ---
  DCR Name: dcr-SecEvt-eastus
  ✅ Table found: Microsoft-SecurityEvent
  Schema Analysis:
    Total columns: 45
    Columns in DCR: 37
  ✅ Direct DCR deployed successfully!
  
🔗 CRIBL INTEGRATION CONFIGURATION
═══════════════════════════════════
  DCR Immutable ID: abc123-def456-...
  Ingestion Endpoint: https://eastus.ingest.monitor.azure.com
  Stream Name: Custom-SecurityEvent
  Target Table: SecurityEvent
═══════════════════════════════════

📦 Cribl configuration exported to: cribl-dcr-configs\cribl-dcr-config.json
```

## 🎉 Summary

This automation system provides:
- ✅ **Unified approach** for both DCE and Direct DCRs
- ✅ **Automatic Cribl integration** with configuration export
- ✅ **Custom table support** with schema management
- ✅ **Template generation** for CI/CD pipelines
- ✅ **Intelligent handling** of Azure naming limits
- ✅ **Comprehensive error handling** and user guidance

---

**Getting Started:** Run `.\Run-DCRAutomation.ps1` to see all options and begin deployment.

For quick setup, see `QUICK_START.md`. For Cribl destination details, see `CRIBL_DESTINATIONS_README.md`.
