# Azure Log Analytics Multiple Tables and DCRs Creator

This directory contains PowerShell scripts and configuration files to create multiple custom tables in Azure Log Analytics and their corresponding Data Collection Rules (DCRs) in a batch operation.

## Directory Structure

```
CreateTableAndDCR/
├── Create-TableAndDCR.ps1          # Main script (processes all schemas)
├── parameters.json                 # Global Azure configuration
├── table-schemas/                  # Directory containing table schemas
│   ├── TestTable.json             # Example: Test table schema
│   ├── SecurityEvents.json        # Example: Security events schema
│   └── AppPerformance.json        # Example: App performance schema
├── NAMING-CONVENTIONS.md          # Naming guidelines
└── README.md                      # This documentation
```

## Features

- **Batch Processing**: Create multiple tables and DCRs in one execution
- **Individual Schemas**: Each table has its own schema file with specific settings
- **Smart Resource Checking**: Verifies if tables and DCRs already exist before creation
- **Flexible Execution**: Process all schemas or target specific tables
- **Comprehensive Logging**: Detailed output and summary reporting
- **Error Handling**: Continues processing other tables if one fails

## Schema File Format

Each table schema file in `table-schemas/` should follow this format:

```json
{
  "description": "Description of the table purpose",
  "tableName": "YourTableName",
  "retentionDays": 30,
  "columns": [
    {
      "name": "TimeGenerated",
      "type": "datetime",
      "description": "Required timestamp field"
    },
    {
      "name": "YourField",
      "type": "string",
      "description": "Your field description"
    }
  ]
}
```

### Schema Properties

- **`tableName`**: Name of the table (will auto-append `_CL`)
- **`retentionDays`**: Data retention period (overrides global setting)
- **`columns`**: Array of column definitions with name, type, and description

## Global Configuration

Update `parameters.json` with your Azure details:

```json
{
  "resourceGroupName": "your-resource-group",
  "workspaceName": "your-log-analytics-workspace",
  "retentionDays": 30,
  "dcrPrefix": "dcr-",
  "dcrSuffix": "",
  "location": "eastus"
}
```

## Usage Examples

### Process All Tables
```powershell
.\Create-TableAndDCR.ps1
```
Creates tables and DCRs for all JSON files in `table-schemas/` directory.

### Process Specific Table
```powershell
.\Create-TableAndDCR.ps1 -SpecificTable "SecurityEvents"
```
Creates only the SecurityEvents table and DCR.

### Use Custom Parameters
```powershell
.\Create-TableAndDCR.ps1 -ParametersFile "prod-parameters.json"
```
Uses a different parameters file (useful for different environments).

### Custom Schema Directory
```powershell
.\Create-TableAndDCR.ps1 -SchemasDirectory "custom-schemas"
```
Uses a different directory for schema files.

## Expected Output

```
Starting Azure Log Analytics tables and DCRs creation process...
Script directory: C:\...\CreateTableAndDCR
Schemas directory: C:\...\CreateTableAndDCR\table-schemas
Loading parameters from: C:\...\parameters.json
Parameters loaded successfully
Found 3 table schema files

Global Configuration:
  Resource Group: rg-jpederson-eastus
  Workspace: la-jpederson-00
  DCR Prefix: dcr-
  Location: eastus

================================================================================
PROCESSING TABLE SCHEMAS
================================================================================

--- Processing: TestTable.json ---
  Table: TestTable_CL (10 columns, 30 days retention)
  DCR: dcr-TestTable-eastus
  Creating table...
  ✅ Table created successfully!
  Creating DCR...
  ✅ DCR created successfully!
  ✅ Completed: TestTable.json

--- Processing: SecurityEvents.json ---
  Table: SecurityEvents_CL (8 columns, 90 days retention)
  DCR: dcr-SecurityEvents-eastus
  ✓ Table already exists - skipping creation
  ✓ DCR already exists - skipping creation
  ✅ Completed: SecurityEvents.json

================================================================================
EXECUTION SUMMARY
================================================================================
Tables:
  Processed: 3
  Created: 1
  Already Existed: 2
DCRs:
  Created: 1
  Already Existed: 2
Errors: None

Script completed! 🎉
```

## Adding New Tables

1. **Create schema file**: Add a new JSON file in `table-schemas/` directory
2. **Define structure**: Include tableName, retentionDays, and columns
3. **Run script**: Execute `.\Create-TableAndDCR.ps1` to process all schemas

### Example New Schema

Create `table-schemas/AuditLogs.json`:
```json
{
  "description": "Audit logs for compliance tracking",
  "tableName": "AuditLogs",
  "retentionDays": 365,
  "columns": [
    {
      "name": "TimeGenerated",
      "type": "datetime",
      "description": "When the audit event occurred"
    },
    {
      "name": "Action",
      "type": "string",
      "description": "Action that was performed"
    },
    {
      "name": "UserId",
      "type": "string",
      "description": "User who performed the action"
    },
    {
      "name": "ResourceName",
      "type": "string",
      "description": "Resource that was accessed"
    }
  ]
}
```

## Benefits

- **Scalability**: Easily add new tables without modifying the main script
- **Consistency**: All tables follow the same naming and structure conventions
- **Efficiency**: Batch creation reduces manual effort and errors
- **Maintenance**: Individual schema files make updates easier
- **Documentation**: Each schema file serves as documentation for the table

## Troubleshooting

### Common Issues

**"No JSON schema files found"**
- Verify files exist in `table-schemas/` directory
- Ensure files have `.json` extension

**"Schema file not found for table"**
- Check that the filename matches the table name when using `-SpecificTable`
- Verify the file exists and is properly named

**"Table creation failed"**
- Check Azure permissions
- Verify workspace exists and is accessible
- Review column definitions for invalid characters

## Prerequisites

- PowerShell 5.1 or later
- Azure PowerShell modules (installed automatically)
- Azure subscription with Log Analytics workspace
- Contributor permissions on resource group

For detailed naming conventions and limits, see [NAMING-CONVENTIONS.md](NAMING-CONVENTIONS.md).