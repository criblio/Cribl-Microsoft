# Azure Log Analytics Custom Table and Data Collection Rule Creator

This directory contains PowerShell scripts and configuration files to create both custom tables in Azure Log Analytics and their corresponding Data Collection Rules (DCRs) in a single operation.

## Files Overview

- **`Create-TableAndDCR.ps1`** - Main PowerShell script that creates both the custom table and DCR
- **`parameters.json`** - Configuration file containing Azure resource details including DCR settings
- **`table-schema.json`** - Table schema definition with column names, types, and reference information
- **`README.md`** - This documentation file

## Features

- **Smart Resource Checking**: Verifies if table and DCR already exist before attempting creation
- **Automatic Schema Mapping**: Uses table schema to define DCR stream declarations
- **Comprehensive Error Handling**: Detailed logging and error reporting
- **Flexible Configuration**: Supports custom parameter and schema files
- **REST API Integration**: Uses Azure REST APIs for reliable resource creation

## Prerequisites

- PowerShell 5.1 or later
- Azure PowerShell modules (Az.OperationalInsights, Az.Monitor - installed automatically)
- Azure subscription with Log Analytics workspace
- Appropriate permissions to create tables and DCRs

## Setup Instructions

### 1. Update Configuration Files

#### Edit `parameters.json`
Update with your actual Azure resource information:

```json
{
  "resourceGroupName": "your-actual-resource-group-name",
  "workspaceName": "your-actual-log-analytics-workspace-name",
  "tableName": "YourCustomTableName",
  "retentionDays": 30,
  "dcrName": "dcr-YourCustomTableName",
  "location": "eastus"
}
```

**Parameter Details:**
- `resourceGroupName` - Azure resource group containing the Log Analytics workspace
- `workspaceName` - Name of the Log Analytics workspace
- `tableName` - Name of the custom table (will auto-append `_CL` if not present)
- `retentionDays` - Data retention period (4-730 days)
- `dcrName` - Name for the Data Collection Rule
- `location` - Azure region for the DCR (must match workspace region)

#### Customize `table-schema.json` (Optional)
Modify the `columns` array to define your specific table structure:

```json
{
  "columns": [
    {
      "name": "TimeGenerated",
      "type": "datetime",
      "description": "Required timestamp field"
    },
    {
      "name": "YourCustomField",
      "type": "string",
      "description": "Your custom field description"
    }
  ]
}
```

### 2. Execute the Script

#### Basic Execution
```powershell
# Navigate to the script directory
cd "C:\\Users\\James Pederson\\Desktop\\git\\Remote\\Cribl-Microsoft\\Azure\\CustomDeploymentTemplates\\CreateTableAndDCR"

# Run the script
.\\Create-TableAndDCR.ps1
```

#### Advanced Execution
```powershell
# Use custom configuration files
.\\Create-TableAndDCR.ps1 -ParametersFile ".\\custom-parameters.json" -SchemaFile ".\\custom-schema.json"
```

## Script Workflow

The script performs the following operations in order:

1. **Load Configuration** - Reads parameters and schema files
2. **Install Dependencies** - Ensures required Azure PowerShell modules are installed
3. **Azure Authentication** - Connects to Azure (interactive login)
4. **Workspace Verification** - Confirms Log Analytics workspace exists
5. **Table Check** - Verifies if custom table already exists
6. **Table Creation** - Creates table if it doesn't exist (using REST API)
7. **DCR Check** - Verifies if Data Collection Rule already exists
8. **DCR Creation** - Creates DCR if it doesn't exist (using ARM template deployment)
9. **Verification** - Confirms successful creation of resources

## Expected Output

```
Starting Azure Log Analytics table and DCR creation process...
Script directory: C:\\...\\CreateTableAndDCR
Loading parameters from: C:\\...\\parameters.json
Parameters loaded successfully
Loading table schema from: C:\\...\\table-schema.json
Table schema loaded successfully - 10 columns defined
Configuration:
  Resource Group: your-rg
  Workspace: your-workspace
  Table Name: YourTable_CL
  Retention: 30 days
  DCR Name: dcr-YourTable
  Location: eastus
  Columns: 10
Checking and installing required PowerShell modules...
Az.OperationalInsights module already installed
Az.Monitor module already installed
Logging into Azure...
Already logged into Azure as: user@domain.com
Verifying Log Analytics workspace...
Workspace found: your-workspace
Checking if table 'YourTable_CL' already exists...
Table 'YourTable_CL' does not exist - will create
Creating custom table: YourTable_CL
Creating table via REST API...
✅ Table created successfully!
Checking if DCR 'dcr-YourTable' already exists...
DCR 'dcr-YourTable' does not exist - will create
Creating Data Collection Rule: dcr-YourTable
Deploying DCR via ARM template...
✅ DCR deployment initiated successfully!
Waiting for DCR deployment to complete...
✅ DCR verified: dcr-YourTable
Script completed successfully! 🎉
Summary:
  Table: YourTable_CL (created)
  DCR: dcr-YourTable (created)
```

## Data Collection Rule Details

The created DCR will have:
- **Stream Name**: `Custom-{TableName}_CL`
- **Destination**: Your specified Log Analytics workspace
- **Transform**: `source` (no transformation)
- **Columns**: Automatically mapped from your table schema

## Troubleshooting

### Common Issues

**"Table already exists"**
- Expected behavior - script skips table creation
- Verify table name matches your requirements

**"DCR already exists"**
- Expected behavior - script skips DCR creation
- Check if existing DCR has correct configuration

**"Workspace not found"**
- Verify resource group and workspace names in `parameters.json`
- Ensure you have access to the workspace

**"Permission denied"**
- Verify you have Contributor permissions on the resource group
- Ensure you have rights to create Monitor resources (for DCR)

**"Location mismatch"**
- DCR location must match the Log Analytics workspace region
- Update the `location` parameter to match your workspace

### Advanced Troubleshooting

**Re-run with existing resources:**
- Script safely handles existing resources
- Will skip creation and show "(existed)" in summary

**Custom schema validation:**
- Ensure `TimeGenerated` column is included (required)
- Verify column names don't contain invalid characters
- Check that data types are supported

## Additional Notes

- Custom tables must have names ending with `_CL`
- DCR creation may take 2-3 minutes to complete
- Resources are created in the order: Table → DCR
- Script uses Azure REST APIs for reliability
- ARM template deployment ensures proper DCR configuration
- Both resources support the same column schema automatically

## Next Steps

After successful creation:
1. Test data ingestion using the DCR endpoint
2. Verify data appears in your Log Analytics workspace
3. Create KQL queries to analyze your custom data
4. Set up alerts or dashboards as needed