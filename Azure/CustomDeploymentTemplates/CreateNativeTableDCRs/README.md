# Azure Data Collection Rules - Unified Solution (DCE or Direct)

This unified PowerShell script automates the deployment of Azure Data Collection Rules (DCRs) for native tables, supporting **both DCE-based and Direct DCRs** through a single script with external ARM templates and operation parameters.

## 🚀 Key Features

- **Unified Solution**: Single script handles both DCE-based and Direct DCRs
- **Template-Only Mode**: Generate ARM templates without deploying resources
- **External Templates**: Modular ARM templates for easy customization
- **Operation Parameter Control**: Switch between modes via configuration
- **Smart Schema Retrieval**: Automatically gets current table schemas from Azure
- **Enhanced DCR Naming**: Intelligent abbreviation for Azure naming limits
- **Template Complexity Analysis**: Recommends deployment approach based on complexity
- **Comprehensive Error Handling**: Detailed guidance for manual deployment scenarios

## 📁 File Structure

```
CreateNativeTableDCRs/
├── Create-NativeTableDCRs.ps1              # Main unified script
├── azure-parameters.json                   # Azure resource configuration
├── operation-parameters.json               # Script behavior & DCR mode control
├── TableList.json                          # List of tables to process
├── dcr-template-with-dce.json             # ARM template for DCE-based DCRs
├── dcr-template-direct.json               # ARM template for Direct DCRs
├── README.md                              # This documentation
├── TLDR_readme.md                         # Quick start guide
└── generated-templates/                   # Generated templates (created during execution)
    ├── SecurityEvent-latest.json
    ├── SecurityEvent-20250906-143022.json
    └── ...
```

## ⚙️ Configuration Files

### 1. operation-parameters.json (DCR Mode Control)
```json
{
  "templateManagement": {
    "cleanupOldTemplates": true,
    "keepTemplateVersions": 1
  },
  "scriptBehavior": {
    "skipKnownIssues": false,
    "validateTablesOnly": false,
    "verboseOutput": true,
    "templateOnly": false
  },
  "deployment": {
    "createDCE": false,
    "skipExistingDCRs": true,
    "skipExistingDCEs": true,
    "deploymentTimeout": 600
  }
}
```

**Key Parameters:**
- **`createDCE`**: `false` = Direct DCRs, `true` = DCE-based DCRs
- **`templateOnly`**: `true` = Generate templates only (no deployment)

### 2. azure-parameters.json (Azure Resources)
```json
{
  "resourceGroupName": "rg-jpederson-eastus",
  "workspaceName": "la-jpederson-00",
  "dceResourceGroupName": "rg-jpederson-eastus",
  "dcePrefix": "dce-jp-",
  "dceSuffix": "",
  "dcrPrefix": "dcr-jp-",
  "dcrSuffix": "",
  "location": "eastus"
}
```

**DCR Naming Limits:**
- **Direct DCRs**: 30 characters max (script auto-abbreviates table names)
- **DCE-based DCRs**: 64 characters max
- **Note**: DCE parameters are only used when `createDCE=true`

### 3. TableList.json (Tables to Process)
```json
[
    "CommonSecurityLog",
    "SecurityEvent",
    "Syslog",
    "WindowsEvent"
]
```

## 🔄 DCR Mode Comparison

| Feature | Direct DCR (`createDCE=false`) | DCE-based DCR (`createDCE=true`) |
|---------|--------------------------------|----------------------------------|
| **Architecture** | Data → Log Analytics | Data → DCE → Log Analytics |
| **Resources Created** | DCR only | DCR + DCE |
| **ARM Template** | `dcr-template-direct.json` | `dcr-template-with-dce.json` |
| **Name Limit** | 30 characters | 64 characters |
| **Cost** | Lower (no DCE costs) | Higher (DCE + DCR costs) |
| **Management** | Simpler (single resource) | More complex (multiple resources) |
| **Use Case** | Simple ingestion scenarios | Advanced scenarios requiring DCE features |

## 🎯 Template-Only Mode

**Perfect for CI/CD pipelines, template review, and staged deployments:**

```powershell
# Generate templates with real Azure schemas (no deployment)
.\Create-NativeTableDCRs.ps1 -TemplateOnly

# Or set in operation-parameters.json
"templateOnly": true
```

**What Template-Only Mode Does:**
- ✅ Connects to Azure and retrieves actual table schemas
- ✅ Generates ARM templates with real column definitions
- ✅ Performs all schema filtering and template validation
- ✅ Saves templates for manual deployment
- ❌ Does NOT create or deploy any Azure resources

## 🚀 Usage Examples

### Basic Usage
```powershell
# Uses createDCE setting from operation-parameters.json
.\Create-NativeTableDCRs.ps1

# Template generation only (no deployment)
.\Create-NativeTableDCRs.ps1 -TemplateOnly

# Force Direct DCRs (override operation parameters)
.\Create-NativeTableDCRs.ps1 -CreateDCE:$false

# Force DCE-based DCRs (override operation parameters)
.\Create-NativeTableDCRs.ps1 -CreateDCE

# Deploy specific table
.\Create-NativeTableDCRs.ps1 -SpecificDCR "SecurityEvent"
```

### Advanced Usage
```powershell
# Complete override of operation parameters
.\Create-NativeTableDCRs.ps1 -IgnoreOperationParameters -CreateDCE -CleanupOldTemplates -KeepTemplateVersions 3

# Template-only for specific table
.\Create-NativeTableDCRs.ps1 -TemplateOnly -SpecificDCR "CommonSecurityLog"

# Validation only (no deployment)
.\Create-NativeTableDCRs.ps1 -ValidateTablesOnly

# Use different configuration files
.\Create-NativeTableDCRs.ps1 -AzureParametersFile "prod-azure.json" -OperationParametersFile "prod-ops.json"
```

## 📋 Script Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `CreateDCE` | Switch | `$false` | **Override**: Force DCE-based DCRs (ignores operation-parameters.json) |
| `TemplateOnly` | Switch | `$false` | **Override**: Generate templates only (ignores operation-parameters.json) |
| `AzureParametersFile` | String | "azure-parameters.json" | Azure configuration file |
| `OperationParametersFile` | String | "operation-parameters.json" | Operation configuration file |
| `TableListFile` | String | "TableList.json" | Table list file |
| `DCRTemplateWithDCEFile` | String | "dcr-template-with-dce.json" | ARM template for DCE-based DCRs |
| `DCRTemplateDirectFile` | String | "dcr-template-direct.json" | ARM template for Direct DCRs |
| `SpecificDCR` | String | "" | Process only specified table |
| `CleanupOldTemplates` | Switch | `$false` | Remove old template versions |
| `KeepTemplateVersions` | Int | 5 | Number of template versions to keep |
| `IgnoreOperationParameters` | Switch | `$false` | Use only command-line parameters |

## 🎯 Expected Output

### Script Startup
```
Starting Azure Data Collection Rules (Unified - DCE or Direct) deployment process...
Loading operation parameters from: operation-parameters.json
Operation parameters loaded successfully
  Create DCE: False
  Template Only Mode: False
DCR Mode: Direct
Template file: C:\...\dcr-template-direct.json
DCR template loaded successfully (Direct)
```

### Processing Tables (Regular Mode)
```
================================================================================
PROCESSING TABLES (Direct DCRs)
================================================================================

--- Processing: CommonSecurityLog ---
  Warning: DCR name 'dcr-jp-CommonSecurityLog-eastus' (35 chars) exceeds 30 character limit for Direct DCRs
  DCR name shortened to: dcr-jp-CSL-eastus (18 chars)
  DCR Name: dcr-jp-CSL-eastus
  DCR Mode: Direct
  ✅ Table found: Microsoft-CommonSecurityLog
  Schema Analysis:
    Total columns from Azure: 45
    System columns filtered: 8
    GUID columns filtered: 2
    Columns to include in DCR: 35
  Template Analysis:
    Size: 12.3 KB
    Columns: 35
    Complexity: Low
  ✅ Template validation passed
  ✅ Direct DCR deployed successfully!
```

### Processing Tables (Template-Only Mode)
```
================================================================================
GENERATING TEMPLATES (Direct DCRs)
================================================================================

--- Processing: CommonSecurityLog ---
  DCR name shortened to: dcr-jp-CSL-eastus (18 chars)
  DCR Name: dcr-jp-CSL-eastus
  DCR Mode: Direct
  Template-only mode: Skipping Azure resource checks
  Template-only mode: Still retrieving actual schema from Azure
  ✅ Table found: Microsoft-CommonSecurityLog
  Schema Analysis:
    Total columns from Azure: 45
    System columns filtered: 8
    GUID columns filtered: 2
    Columns to include in DCR: 35
  ✅ Template validation passed
  Template saved: CommonSecurityLog-20250906-143022.json
  Latest template: CommonSecurityLog-latest.json
  Stream names hardcoded:
    Input stream: Custom-CommonSecurityLog
    Output stream: Microsoft-CommonSecurityLog
  Template is standalone: columns embedded, resource IDs blank by default
  ✅ Template generated successfully (template-only mode)
  Template location: C:\...\generated-templates\CommonSecurityLog-latest.json
```

## 🏗️ External ARM Templates

### dcr-template-direct.json (Direct DCRs)
- **Features**: `kind = "Direct"`, no DCE reference
- **Parameters**: `dataCollectionRuleName`, `location`, `workspaceResourceId`, `tableName`, `columns`
- **Use Case**: Simple, cost-effective data ingestion
- **Name Limit**: 30 characters (script auto-abbreviates)

### dcr-template-with-dce.json (DCE-based DCRs)
- **Features**: `dataCollectionEndpointId` reference, DCE integration
- **Parameters**: Same as Direct + `endpointResourceId`
- **Use Case**: Advanced scenarios requiring DCE features
- **Name Limit**: 64 characters

### Generated Templates Enhancement
**Important**: The script now generates templates with **hardcoded stream names** instead of using ARM template variables. This makes the templates more portable and easier to use:
- **Input Stream**: Hardcoded as `Custom-{TableName}` (e.g., `Custom-SecurityEvent`)
- **Output Stream**: Hardcoded as `Microsoft-{TableName}` (e.g., `Microsoft-SecurityEvent`)
- **Columns**: Embedded directly in the template with filtered schema from Azure
- **Benefits**: Templates are fully standalone and don't require `tableName` or `columns` parameters

## 📊 Intelligent DCR Naming

The script automatically handles Azure naming limits:

### Direct DCRs (30-character limit)
- `CommonSecurityLog` → `CSL`
- `SecurityEvent` → `SecEvt`
- `WindowsEvent` → `WinEvt`
- `DeviceEvents` → `DevEvt`
- Generic tables → First 6 characters

### Example Transformations
```
Original: dcr-jp-CommonSecurityLog-eastus (35 chars - too long)
Abbreviated: dcr-jp-CSL-eastus (18 chars - ✅ fits)

Original: dcr-jp-SecurityEvent-eastus (29 chars - ✅ fits)
No change needed
```

## 📈 Best Practices

### Development Workflow
1. **Template Generation**: Use `-TemplateOnly` to generate templates
2. **Template Review**: Review generated templates in `generated-templates/`
3. **Test Deployment**: Deploy single table with `-SpecificDCR`
4. **Full Deployment**: Deploy all tables after validation

### Template Management
- Use `*-latest.json` files for current deployments
- Keep timestamped versions for rollback capability
- Enable automatic cleanup via operation parameters

### Deployment Strategy
- Start with Direct DCRs for cost optimization
- Use DCE-based DCRs only when advanced features are needed
- Use template-only mode for CI/CD pipelines
- Monitor Azure Portal for deployment progress

### Cost Optimization
- **Direct DCRs**: Lower cost, suitable for most scenarios
- **DCE-based DCRs**: Higher cost, use only when necessary
- Clean up unused DCEs when switching from DCE-based to Direct

## 🚨 Manual Deployment Scenarios

The script automatically detects when manual deployment is recommended:

- **Large schemas** (>300 columns)
- **Complex data types** (many dynamic/object columns)
- **Template size** (>4MB ARM limit)
- **Deployment failures** (timeout, validation errors)

### Manual Deployment Process
1. Script generates templates in `generated-templates/`
2. Use `*-latest.json` files for current deployments
3. Deploy via Azure Portal → "Deploy a custom template"
4. Copy template content from generated files
5. Fill in required parameters (DCR name, location, workspace ID, etc.)

## 🔍 Troubleshooting

### Common Issues
- **"DCR name too long"**: Script auto-abbreviates, check output for shortened name
- **"Table not found"**: Verify table name spelling in TableList.json
- **"Authentication error"**: Run `Connect-AzAccount` first
- **"Template too large"**: Use manual deployment with Azure Portal

### Quick Fixes
- **Switch DCR mode**: Change `createDCE` in operation-parameters.json
- **Template-only mode**: Use `-TemplateOnly` for template generation
- **Manual deployment**: Use generated templates with Azure Portal
- **Name conflicts**: Check shortened DCR names in output

## 🎯 CI/CD Integration

### Pipeline Example
```yaml
# Stage 1: Generate Templates
- task: PowerShell@2
  displayName: 'Generate DCR Templates'
  inputs:
    targetType: 'filePath'
    filePath: 'Create-NativeTableDCRs.ps1'
    arguments: '-TemplateOnly'
    
# Stage 2: Review Templates (manual gate)
# Stage 3: Deploy Templates
- task: AzureResourceManagerTemplateDeployment@3
  displayName: 'Deploy DCRs'
  inputs:
    azureResourceManagerConnection: '$(serviceConnection)'
    subscriptionId: '$(subscriptionId)'
    resourceGroupName: '$(resourceGroupName)'
    location: '$(location)'
    templateLocation: 'Linked artifact'
    csmFile: 'generated-templates/$(tableName)-latest.json'
```

## 🎉 Summary

This unified solution provides:

✅ **Single Script**: Handles both DCE-based and Direct DCRs  
✅ **Template-Only Mode**: Generate templates without deployment  
✅ **External Templates**: Easy customization without script changes  
✅ **Intelligent Naming**: Auto-abbreviation for Azure limits  
✅ **Operation Control**: Switch modes via configuration  
✅ **Cost Flexibility**: Choose between cost-effective Direct or feature-rich DCE-based  
✅ **Template Management**: Automated versioning and cleanup  
✅ **Error Handling**: Comprehensive guidance for complex scenarios  
✅ **CI/CD Ready**: Perfect for automated deployment pipelines  

The unified approach eliminates code duplication while providing maximum flexibility for different deployment scenarios and requirements.
