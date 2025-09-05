# Azure Data Collection Rules for Native Tables (No DCE Required)

This directory contains PowerShell scripts and ARM templates to deploy Data Collection Rules (DCRs) for Azure native tables **without requiring Data Collection Endpoints (DCEs)**. These DCRs are designed for direct data ingestion scenarios.

## Directory Structure

```
CreateNativeTableDCRs-NoDCE/
├── Create-NativeTableDCRs.ps1      # Main deployment script
├── parameters.json                 # Global Azure configuration
├── dcr-templates/                  # Directory containing DCR ARM templates (No DCE)
│   ├── SecurityEvent.json         # DCR for SecurityEvent table (No DCE)
│   ├── AuditLogs.json             # DCR for AuditLogs table (No DCE)
│   ├── Syslog.json                # DCR for Syslog table (No DCE)
│   └── ...                        # Additional DCR templates (No DCE)
└── README.md                      # This documentation
```

## Features

- **Batch Deployment**: Deploy multiple DCRs for native tables in one execution
- **ARM Template Based**: Uses Azure Resource Manager templates for reliable deployment
- **Smart Resource Checking**: Verifies if DCRs already exist before deployment
- **Flexible Execution**: Deploy all DCRs or target specific ones
- **Standardized Naming**: Consistent DCR naming convention across all deployments
- **Comprehensive Logging**: Detailed output and summary reporting

## DCR Template Format

Each DCR template in `dcr-templates/` follows the Azure ARM template format:

```json
{
    "$schema": "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
    "contentVersion": "1.0.0.0",
    "parameters": {
        "dataCollectionRuleName": {
            "type": "string"
        },
        "location": {
            "type": "string"
        },
        "workspaceResourceId": {
            "type": "string"
        }
    },
    "resources": [{
        "type": "Microsoft.Insights/dataCollectionRules",
        "apiVersion": "2023-03-11",
        "name": "[parameters('dataCollectionRuleName')]",
        "location": "[parameters('location')]",
        "kind": "Direct",
        "properties": {
            "streamDeclarations": {
                "Custom-TableName": {
                    "columns": [...]
                }
            },
            "destinations": {
                "logAnalytics": [{
                    "workspaceResourceId": "[parameters('workspaceResourceId')]",
                    "name": "logAnalyticsWorkspace"
                }]
            },
            "dataFlows": [{
                "streams": ["Custom-TableName"],
                "destinations": ["logAnalyticsWorkspace"],
                "transformKql": "source",
                "outputStream": "Microsoft-TableName"
            }]
        }
    }]
}
```

## Global Configuration

Update `parameters.json` with your Azure details:

```json
{
  "resourceGroupName": "your-resource-group",
  "workspaceName": "your-log-analytics-workspace", 
  "dcrPrefix": "dcr-",
  "dcrSuffix": "",
  "location": "eastus"
}
```

### Parameters Explained

- **`resourceGroupName`**: Azure resource group containing the Log Analytics workspace
- **`workspaceName`**: Name of the Log Analytics workspace
- **`dcrPrefix`**: Prefix for DCR names (default: "dcr-")
- **`dcrSuffix`**: Optional suffix for DCR names (useful for environments/versions)
- **`location`**: Azure region (must match workspace region)

## DCR Naming Convention

DCRs are automatically named using this pattern:
`{dcrPrefix}{TableName}-{location}[-{dcrSuffix}]`

### Examples:
- **SecurityEvent.json** → `dcr-SecurityEvent-eastus`
- **AuditLogs.json** → `dcr-AuditLogs-eastus`
- **With suffix "prod"** → `dcr-SecurityEvent-eastus-prod`

## Usage Examples

### Deploy All DCRs
```powershell
.\Create-NativeTableDCRs.ps1
```
Deploys DCRs for all JSON templates in `dcr-templates/` directory.

### Deploy Specific DCR
```powershell
.\Create-NativeTableDCRs.ps1 -SpecificDCR "SecurityEvent"
```
Deploys only the SecurityEvent DCR.

### Use Custom Parameters
```powershell
.\Create-NativeTableDCRs.ps1 -ParametersFile "prod-parameters.json"
```
Uses a different parameters file (useful for different environments).

### Use Custom Templates Directory
```powershell
.\Create-NativeTableDCRs.ps1 -TemplatesDirectory "custom-dcr-templates"
```
Uses a different directory for DCR templates.

## Expected Output

```
Starting Azure Data Collection Rules deployment process...
Script directory: C:\...\CreateNativeTableDCRs
Templates directory: C:\...\CreateNativeTableDCRs\dcr-templates
Loading parameters from: C:\...\parameters.json
Parameters loaded successfully
Found 3 DCR template files

Global Configuration:
  Resource Group: rg-jpederson-eastus
  Workspace: la-jpederson-00
  DCR Prefix: dcr-
  Location: eastus

================================================================================
PROCESSING DCR TEMPLATES
================================================================================

--- Processing: SecurityEvent.json ---
  Template: SecurityEvent.json
  DCR Name: dcr-SecurityEvent-eastus
  Target Table: Microsoft-SecurityEvent
  Deploying DCR...
  ✅ DCR deployed successfully!
  DCR Resource ID: /subscriptions/.../dataCollectionRules/dcr-SecurityEvent-eastus
  ✅ Completed: SecurityEvent.json

--- Processing: AuditLogs.json ---
  Template: AuditLogs.json
  DCR Name: dcr-AuditLogs-eastus
  Target Table: Microsoft-AuditLogs
  ✓ DCR already exists - skipping creation
  ✅ Completed: AuditLogs.json

================================================================================
EXECUTION SUMMARY
================================================================================
Data Collection Rules:
  Processed: 3
  Created: 1
  Already Existed: 2
Errors: None

Script completed! 🎉
```

## Adding New DCR Templates

1. **Create ARM template**: Add a new JSON file in `dcr-templates/` directory
2. **Follow naming**: Use the target table name as filename (e.g., `WindowsEvent.json`)
3. **Define schema**: Include all required columns for the target native table
4. **Set output stream**: Use `Microsoft-{TableName}` format for native tables
5. **Run script**: Execute deployment script to create the DCR

### Example New DCR Template

Create `dcr-templates/WindowsEvent.json`:
```json
{
    "$schema": "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
    "contentVersion": "1.0.0.0",
    "parameters": {
        "dataCollectionRuleName": {
            "type": "string"
        },
        "location": {
            "type": "string" 
        },
        "workspaceResourceId": {
            "type": "string"
        }
    },
    "resources": [{
        "type": "Microsoft.Insights/dataCollectionRules",
        "apiVersion": "2023-03-11",
        "name": "[parameters('dataCollectionRuleName')]",
        "location": "[parameters('location')]",
        "kind": "Direct",
        "properties": {
            "streamDeclarations": {
                "Custom-WindowsEvent": {
                    "columns": [
                        {
                            "name": "Channel",
                            "type": "string"
                        },
                        {
                            "name": "Computer",
                            "type": "string"
                        },
                        {
                            "name": "Data",
                            "type": "string"
                        },
                        {
                            "name": "EventID",
                            "type": "int"
                        },
                        {
                            "name": "EventLevel",
                            "type": "int"
                        },
                        {
                            "name": "EventLevelName",
                            "type": "string"
                        },
                        {
                            "name": "TimeGenerated",
                            "type": "datetime"
                        }
                    ]
                }
            },
            "destinations": {
                "logAnalytics": [{
                    "workspaceResourceId": "[parameters('workspaceResourceId')]",
                    "name": "logAnalyticsWorkspace"
                }]
            },
            "dataFlows": [{
                "streams": ["Custom-WindowsEvent"],
                "destinations": ["logAnalyticsWorkspace"],
                "transformKql": "source",
                "outputStream": "Microsoft-WindowsEvent"
            }]
        }
    }]
}
```

## Key Differences from Custom Tables

### Native Tables vs Custom Tables
- **Native Tables**: Use `Microsoft-{TableName}` output streams (e.g., `Microsoft-SecurityEvent`)
- **Custom Tables**: Use `Custom-{TableName}_CL` output streams (e.g., `Custom-MyTable_CL`)

### Stream Declarations
- **Native**: `Custom-SecurityEvent` → `Microsoft-SecurityEvent`
- **Custom**: `Custom-MyTable_CL` → `Custom-MyTable_CL`

### Table Requirements
- **Native**: Must match existing Azure table schemas exactly
- **Custom**: Can define any schema with `_CL` suffix

## Benefits

- **Standardization**: Consistent DCR deployment across environments
- **Efficiency**: Batch processing reduces manual configuration
- **Reliability**: ARM templates ensure reproducible deployments  
- **Scalability**: Easy to add new native table DCRs
- **Maintenance**: Individual templates make updates manageable
- **Compliance**: Standardized approach for audit and governance

## Troubleshooting

### Common Issues

**"Template file not found"**
- Verify files exist in `dcr-templates/` directory
- Ensure files have `.json` extension and valid ARM template format

**"DCR deployment failed"**
- Check Azure permissions (Contributor on resource group)
- Verify workspace exists and is accessible
- Review template syntax and parameter values

**"Invalid column schema"**
- Ensure columns match the target native table schema exactly
- Check Azure documentation for required columns per table type

**"Location mismatch"**
- DCR location must match Log Analytics workspace region
- Update `location` parameter to match workspace

## Prerequisites

- PowerShell 5.1 or later
- Azure PowerShell modules (installed automatically)
- Azure subscription with Log Analytics workspace
- Contributor permissions on resource group
- Understanding of target native table schemas

## Source Templates

To get more DCR templates, you can copy them from:
`DataCollectionRules\SentinelNativeTables\DataCollectionRules(NoDCE)\`

Each template there can be copied and simplified for use in this structure.