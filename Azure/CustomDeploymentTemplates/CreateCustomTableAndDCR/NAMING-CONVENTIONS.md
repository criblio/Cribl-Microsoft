# Azure Naming Conventions and Limits

This document provides detailed naming conventions and limits for Azure resources used in this project.

## Parameter File Configuration Guide

### Resource Group Name
- **Parameter**: `resourceGroupName`
- **Length**: 1-90 characters
- **Valid Characters**: Letters, digits, underscores, hyphens, periods, parentheses
- **Rules**: Cannot end with period
- **Example**: `rg-jpederson-eastus`

### Log Analytics Workspace Name
- **Parameter**: `workspaceName`
- **Length**: 4-63 characters
- **Valid Characters**: Alphanumerics and hyphens
- **Rules**: Must start and end with alphanumeric character
- **Example**: `la-jpederson-00`

### Custom Table Name
- **Parameter**: `tableName`
- **Automatic Suffix**: `_CL` (added automatically by script)
- **Final Name Format**: `{tableName}_CL`
- **Valid Characters**: Alphanumerics and hyphens
- **Rules**: Must start and end with alphanumeric character
- **Limits**: Maximum 500 columns per table
- **Notes**: 
  - Table names are case-sensitive
  - Used for billing purposes (avoid sensitive information)
- **Example**: `TestTable` → becomes `TestTable_CL`

### Data Retention
- **Parameter**: `retentionDays`
- **Range**: 4-730 days for custom tables
- **Cost Impact**: Longer retention = higher cost
- **Example**: `30`

### Data Collection Rule (DCR) Naming
- **Parameter**: `dcrPrefix`
- **Parameter**: `dcrSuffix` (optional)
- **Final Name Format**: `{dcrPrefix}{tableName}-{location}[-{dcrSuffix}]`
- **Length Recommendation**: Keep total name under 64 characters
- **Valid Characters**: Alphanumerics, hyphens, and underscores
- **Examples**: 
  - Without suffix: `dcr-` → becomes `dcr-TestTable-eastus`
  - With suffix: `dcr-` + suffix `v2` → becomes `dcr-TestTable-eastus-v2`

### Azure Region
- **Parameter**: `location`
- **Format**: Standard Azure region names (lowercase, no spaces)
- **Rules**: Must match Log Analytics workspace region for DCR
- **Examples**: `eastus`, `westus2`, `westeurope`, `southeastasia`

## Azure Naming Best Practices

### General Guidelines
1. **Use lowercase letters and numbers** for maximum compatibility
2. **Use hyphens to separate words** (kebab-case)
3. **Avoid underscores** except in table names (Azure requirement)
4. **Keep names descriptive but concise**
5. **Include environment/purpose indicators** (dev, prod, test)
6. **Avoid special characters**: `<>*%&:\\?/+|` and control characters
7. **Don't end names with periods or spaces**
8. **Consider name uniqueness requirements** (global vs regional vs resource group)

### Character Restrictions by Resource Type

| Resource Type | Length | Valid Characters | Scope | Special Rules |
|---------------|--------|------------------|-------|---------------|
| Resource Group | 1-90 | Letters, digits, underscores, hyphens, periods, parentheses | Subscription | Cannot end with period |
| Log Analytics Workspace | 4-63 | Alphanumerics and hyphens | Resource Group | Start/end with alphanumeric |
| Custom Table | Variable | Alphanumerics and hyphens | Workspace | Must end with `_CL` |
| Data Collection Rule | <64 (recommended) | Alphanumerics, hyphens, underscores | Resource Group | Must match workspace region |

## Example Naming Patterns

### Development Environment
```json
{
  "resourceGroupName": "rg-myapp-dev-eastus",
  "workspaceName": "law-myapp-dev-001",
  "tableName": "AppLogs",
  "dcrPrefix": "dcr-",
  "dcrSuffix": "",
  "location": "eastus"
}
```
**Results in:**
- Table: `AppLogs_CL`
- DCR: `dcr-AppLogs-eastus`

### Production Environment with Version Suffix
```json
{
  "resourceGroupName": "rg-myapp-prod-eastus",
  "workspaceName": "law-myapp-prod-001", 
  "tableName": "SecurityEvents",
  "dcrPrefix": "dcr-",
  "dcrSuffix": "v2",
  "location": "eastus"
}
```
**Results in:**
- Table: `SecurityEvents_CL`
- DCR: `dcr-SecurityEvents-eastus-v2`

### Multi-Environment with Team Suffix
```json
{
  "resourceGroupName": "rg-myapp-prod-westus2",
  "workspaceName": "law-myapp-prod-002",
  "tableName": "ApplicationTrace",
  "dcrPrefix": "dcr-",
  "dcrSuffix": "team-alpha",
  "location": "westus2"
}
```
**Results in:**
- Table: `ApplicationTrace_CL`
- DCR: `dcr-ApplicationTrace-westus2-team-alpha`

## Azure Resource Limits

### Log Analytics Tables
- Maximum columns per table: 500
- Data retention range: 4-730 days
- Table name character limit: No specific limit, but should be reasonable
- Case sensitivity: Table names are case-sensitive

### Data Collection Rules
- Maximum DCRs per VM: 30
- Supported destinations: Log Analytics workspaces in same region
- Transformation support: KQL transformations available

## Common Naming Mistakes to Avoid

❌ **Don't Do This**:
- `My Table Name` (spaces not allowed)
- `table_name` (underscores discouraged except for `_CL` suffix)
- `TestTable` without considering `_CL` suffix length
- Using production resource names in development
- Inconsistent casing across resources

✅ **Do This Instead**:
- `MyTableName` → becomes `MyTableName_CL`
- `app-security-logs` → becomes `app-security-logs_CL`
- `dcr-app-security-logs-eastus`
- Consistent environment prefixes/suffixes
- Lowercase for maximum compatibility

## References

- [Azure Resource Naming Rules](https://learn.microsoft.com/en-us/azure/azure-resource-manager/management/resource-name-rules)
- [Azure Naming Conventions Guide](https://learn.microsoft.com/en-us/azure/cloud-adoption-framework/ready/azure-best-practices/resource-naming)
- [Log Analytics Table Management](https://learn.microsoft.com/en-us/azure/azure-monitor/logs/manage-logs-tables)
- [Data Collection Rules Overview](https://learn.microsoft.com/en-us/azure/azure-monitor/data-collection/data-collection-rule-overview)