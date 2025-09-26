# Custom Table Schemas

This directory contains JSON schema definitions for custom Log Analytics tables. Each schema file defines the structure of a custom table that will be created in Azure Log Analytics.

## File Naming Convention

Schema files should be named using one of these patterns:
- `TableName_CL.json` - Preferred format with the _CL suffix
- `TableName.json` - The script will automatically add the _CL suffix

## Schema File Structure

Each schema file must be a valid JSON file with the following structure:

```json
{
  "description": "Description of the custom table",
  "retentionInDays": 30,
  "totalRetentionInDays": 90,
  "columns": [
    {
      "name": "ColumnName",
      "type": "datatype",
      "description": "Column description"
    }
  ]
}
```

### Required Fields

- **columns**: Array of column definitions (required)
  - **name**: Column name (required)
  - **type**: Data type (required)
  - **description**: Column description (optional but recommended)

### Optional Fields

- **description**: Table description
- **retentionInDays**: Active retention period (default: 30)
- **totalRetentionInDays**: Total retention including archive (default: 90)

## Supported Data Types

The following data types are supported for columns:

- **string**: Text data
- **int**: 32-bit integer
- **long**: 64-bit integer
- **real**: Floating-point number
- **boolean**: True/false values
- **datetime**: Date and time values
- **dynamic**: JSON/complex objects

## Special Columns

### TimeGenerated
Every custom table should include a `TimeGenerated` column of type `datetime`. If not specified, the script will automatically add it.

```json
{
  "name": "TimeGenerated",
  "type": "datetime",
  "description": "Timestamp when the record was generated"
}
```

## Example Files

This directory includes example schema files:

- **MyCustomApp_CL.json**: Example application logging table
- **SecurityAudit_CL.json**: Example security audit table with extended properties

## Usage

1. Create a JSON schema file for your custom table
2. Place it in this directory
3. Add the table name to your table list file (with or without _CL suffix)
4. Run the script with custom table mode enabled:

```powershell
# Enable in operation-parameters.json
"customTableSettings": {
  "enabled": true
}

# Or use command line
.\Create-NativeTableDCRs.ps1 -CustomTableMode
```

## Best Practices

1. **Always include TimeGenerated**: This is the primary timestamp column
2. **Use meaningful column names**: Avoid special characters except underscore
3. **Add descriptions**: Document what each column contains
4. **Consider retention**: Balance cost vs data availability needs
5. **Use appropriate data types**: Choose the most specific type for your data
6. **Dynamic columns sparingly**: Use for variable/complex data structures

## Retention Settings

- **retentionInDays**: How long data is readily queryable (affects cost)
- **totalRetentionInDays**: Total retention including archive (lower cost storage)

Example:
- 30 days active retention: Full query capabilities, higher cost
- 90 days total retention: 30 days active + 60 days archive (cheaper, limited query)

## Notes

- Custom tables always get the `_CL` suffix in Azure
- The script will create tables automatically if they don't exist
- Existing tables will use their current schema from Azure
- Column types are automatically mapped to DCR-compatible types
- System columns are automatically filtered when creating DCRs
