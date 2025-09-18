# Migrating Custom Tables from Cribl Azure Monitor Destination to Cribl Sentinel Destination

## Executive Summary

Microsoft is retiring the HTTP Data Collector API on **September 14, 2026**. This API is used by Cribl's Azure Monitor destination to send data to custom tables (_CL suffix) in Log Analytics workspaces. This guide provides a streamlined migration path to transition custom tables to the modern Azure Logs Ingestion API via the Sentinel destination.

## Why This Migration is Required

**This migration only affects custom tables** (those ending with _CL) that were created using the deprecated HTTP Data Collector API. The new Logs Ingestion API provides:

- **Enhanced Security**: OAuth-based authentication replaces shared keys
- **Data Transformations**: Filter and modify data before ingestion using KQL
- **Granular RBAC**: Fine-grained access control with Azure AD
- **Schema Control**: Prevents accidental column creation
- **Better Performance**: Optimized data ingestion pipeline

## Prerequisites

Before starting:
1. **Log Analytics workspace** with contributor rights
2. **Azure permissions** to create Data Collection Rules (DCRs)
3. **PowerShell 5.1+** with Azure PowerShell modules
4. **Cribl Stream** with existing Azure Monitor destinations sending to custom tables
5. **Clone the automation repository**:
   ```bash
   git clone https://github.com/criblio/Cribl-Microsoft.git
   cd Cribl-Microsoft/Azure/CustomDeploymentTemplates/DCR-Automation
   ```

## Critical Understanding: MMA Tables vs DCR-Based Tables

### The Two-Step Process

**IMPORTANT:** You cannot create DCRs for MMA-based custom tables directly. The migration requires two steps:

1. **Convert MMA tables to DCR-based tables** (enables dual API support)
2. **Create DCRs for the converted tables** (using the automation)

### Table Types Explained

| Table Type | Description | Accepts Old API | Accepts New API | Can Create DCR |
|------------|-------------|-----------------|-----------------|----------------|
| **MMA-Only** | Original custom tables | ✅ Yes | ❌ No | ❌ No |
| **DCR-Based** | Converted/new tables | ✅ Yes (until 2026) | ✅ Yes | ✅ Yes |

### Migration Options

**Option 1: Convert Existing Tables (In-Place)**
- Convert existing MMA tables to DCR-based
- Keep same table names
- No query/dashboard updates needed
- Both APIs work during transition

**Option 2: Create New Tables (Side-by-Side)**
- Create new DCR-based tables with different names
- Run both old and new tables in parallel
- Requires updating all queries/dashboards
- Cleaner migration but more work

## Step-by-Step Migration Guide

### Step 1: Inventory Your Custom Tables

Identify which custom tables need migration:

1. **Navigate to Azure Portal** → Search for "Log Analytics workspaces"
2. **Select your workspace**
3. **Click on "Tables"** in the left menu
4. **Identify MMA custom tables**:
   - Type = "Custom table (classic)"
   - Names ending with "_CL"
   - Plan = "Basic" or missing (these are MMA-only)

**PowerShell to check table status:**
```powershell
Connect-AzAccount
Set-AzContext -SubscriptionId "your-subscription-id"

# Check which tables are MMA-only
$tables = Get-AzOperationalInsightsTable `
    -ResourceGroupName "your-resource-group" `
    -WorkspaceName "your-workspace"

$customTables = $tables | Where-Object { $_.Name -like "*_CL" }

foreach ($table in $customTables) {
    $status = if ($table.Properties.plan -eq "Analytics") { 
        "DCR-Ready" 
    } else { 
        "MMA-Only (needs conversion)" 
    }
    Write-Host "$($table.Name): $status"
}
```

### Step 2: Create Azure App Registration

Create an app registration for authentication:

1. **Navigate to Azure Active Directory** in Azure Portal
2. **Click "App registrations"** → **"+ New registration"**
3. **Configure:**
   - Name: `cribl-sentinel-connector`
   - Account types: "Single tenant"
4. **Save these values:**
   - Application (client) ID
   - Directory (tenant) ID
5. **Create secret:**
   - Click "Certificates & secrets" → "+ New client secret"
   - **COPY THE SECRET VALUE IMMEDIATELY**

### Step 3: Convert MMA Tables to DCR-Based Tables

**⚠️ CRITICAL STEP: This must be done BEFORE creating DCRs**

Create and run this PowerShell script to convert your MMA tables:

```powershell
function Convert-MMATableToDCRBased {
    param(
        [Parameter(Mandatory=$true)]
        [ValidatePattern(".*_CL$")]
        [string]$TableName,
        
        [Parameter(Mandatory=$true)]
        [string]$WorkspaceName,
        
        [Parameter(Mandatory=$true)]
        [string]$ResourceGroupName
    )
    
    Write-Host "Converting $TableName to DCR-based..." -ForegroundColor Yellow
    
    try {
        # Get workspace
        $workspace = Get-AzOperationalInsightsWorkspace `
            -ResourceGroupName $ResourceGroupName `
            -Name $WorkspaceName
        
        # Get existing table
        $table = Get-AzOperationalInsightsTable `
            -ResourceGroupName $ResourceGroupName `
            -WorkspaceName $WorkspaceName `
            -TableName $TableName
        
        if ($table.Properties.plan -eq "Analytics") {
            Write-Host "✅ $TableName is already DCR-based" -ForegroundColor Green
            return
        }
        
        # Query schema
        $schemaQuery = "$TableName | getschema | project ColumnName, DataType"
        $schema = Invoke-AzOperationalInsightsQuery `
            -WorkspaceId $workspace.CustomerId `
            -Query $schemaQuery
        
        # Build columns
        $columns = @()
        foreach ($col in $schema.Results) {
            $type = switch ($col.DataType) {
                'System.String' { 'string' }
                'System.Int32' { 'int' }
                'System.Int64' { 'long' }
                'System.Double' { 'real' }
                'System.Boolean' { 'boolean' }
                'System.DateTime' { 'datetime' }
                default { 'string' }
            }
            $columns += @{
                name = $col.ColumnName
                type = $type
            }
        }
        
        # Update table to DCR-based
        $tableUpdate = @{
            properties = @{
                schema = @{
                    name = $TableName
                    columns = $columns
                }
                retentionInDays = $table.Properties.retentionInDays
                plan = "Analytics"  # This makes it DCR-based
            }
        }
        
        # Apply update via REST API
        $subscriptionId = (Get-AzContext).Subscription.Id
        $resourceId = "/subscriptions/$subscriptionId/resourceGroups/$ResourceGroupName/providers/Microsoft.OperationalInsights/workspaces/$WorkspaceName/tables/$TableName"
        
        $token = (Get-AzAccessToken -ResourceUrl "https://management.azure.com/").Token
        $headers = @{
            'Authorization' = "Bearer $token"
            'Content-Type' = 'application/json'
        }
        
        $uri = "https://management.azure.com$resourceId`?api-version=2022-10-01"
        $body = $tableUpdate | ConvertTo-Json -Depth 10
        
        Invoke-RestMethod -Uri $uri -Method PUT -Headers $headers -Body $body
        
        Write-Host "✅ $TableName converted to DCR-based successfully!" -ForegroundColor Green
        Write-Host "   - Can now accept both old and new API" -ForegroundColor Gray
        Write-Host "   - Schema is now fixed" -ForegroundColor Gray
        
    } catch {
        Write-Error "Failed to convert $TableName : $_"
    }
}

# Convert your tables
$tablesToConvert = @(
    "FirewallLogs_CL",
    "ApplicationMetrics_CL",
    "CloudFlare_CL"
)

foreach ($table in $tablesToConvert) {
    Convert-MMATableToDCRBased `
        -TableName $table `
        -WorkspaceName "your-workspace" `
        -ResourceGroupName "your-resource-group"
    
    Start-Sleep -Seconds 2  # Avoid throttling
}
```

**What this conversion does:**
- ✅ Enables the table to accept DCR-based ingestion
- ✅ Maintains compatibility with old HTTP Data Collector API
- ✅ Preserves all existing data
- ✅ Fixes the schema (no more dynamic columns)

### Step 4: Configure Automation Parameters

After converting tables, configure the automation:

```powershell
cd Cribl-Microsoft/Azure/CustomDeploymentTemplates/DCR-Automation
```

Edit `azure-parameters.json`:
```json
{
  "resourceGroupName": "your-rg-name",
  "workspaceName": "your-la-workspace",
  "location": "eastus",
  "dcrPrefix": "dcr-cribl-",
  "tenantId": "your-tenant-id",
  "clientId": "your-app-client-id",
  "clientSecret": "your-app-secret"
}
```

### Step 5: Configure Table Lists

Update `CustomTableList.json` with your **custom DCR based** table names:
```json
[
    "FirewallLogs_CL",
    "ApplicationMetrics_CL",
    "CloudFlare_CL"
]
```

**IMPORTANT:** Only include tables that already are or have been converted to DCR-based in Step 3.

### Step 6: Define Schemas (Only for NEW Tables)

The automation automatically captures schemas for:
-  **Converted DCR-based tables** (from Step 3)
-  **Existing DCR-based tables**

You only need to create schema files for:
-  **Brand new tables** that don't exist yet

If creating new tables, add schema files to `custom-table-schemas/NewTableName_CL.json`

### Step 7: Create DCRs Using Automation

Now that tables are DCR-based, create the DCRs:

```powershell
# Connect to Azure
Connect-AzAccount
Set-AzContext -SubscriptionId "your-subscription-id"

# Run automation to create DCRs
.\Run-DCRAutomation.ps1 -Mode DirectCustom

# This will:
# 1. Detect the DCR-based tables
# 2. Capture their schemas automatically
# 3. Create DCRs for each table
# 4. Automatically export Cribl configurations to cribl-dcr-configs/
# 5. Generate individual destination files in cribl-dcr-configs/destinations/
```

**Verify DCR creation:**
```powershell
# Check created DCRs
Get-AzDataCollectionRule -ResourceGroupName "your-resource-group" | 
    Where-Object { $_.Name -like "dcr-cribl-*" } | 
    Format-Table Name, Location, ProvisioningState
```

### Step 8: Assign Permissions

Grant your app registration permissions on each DCR:

**Via Portal:**
1. Navigate to each DCR in Azure Portal
2. Click "Access control (IAM)"
3. Add role assignment: "Monitoring Metrics Publisher"
4. Assign to your app registration

**Via PowerShell:**
```powershell
$appId = "your-app-client-id"
$sp = Get-AzADServicePrincipal -ApplicationId $appId

$dcrs = Get-AzDataCollectionRule -ResourceGroupName "your-resource-group" | 
        Where-Object { $_.Name -like "dcr-cribl-*" }

foreach ($dcr in $dcrs) {
    New-AzRoleAssignment `
        -ObjectId $sp.Id `
        -RoleDefinitionName "Monitoring Metrics Publisher" `
        -Scope $dcr.Id
}
```

### Step 9: Configure Cribl Stream

The automation has already generated Cribl configurations in `cribl-dcr-configs/` directory.

**Import configurations to Cribl Stream:**

1. Navigate to **Manage** → **Data** → **Destinations**
2. Add **Microsoft Sentinel** destination for each table
3. Use the configuration values from:
   - Individual destinations: `cribl-dcr-configs/destinations`

### Step 10: Update Pipelines

Ensure your Cribl pipelines match the DCR schema. Review the Cribl Packs Dispensary for Sentinel related content or build your own.


### Step 11: Test and Validate

Test both APIs work with your converted tables:

```kusto
// Check data flow
YourTableName_CL
| where TimeGenerated > ago(1h)
| summarize 
    EventCount = count(),
    FirstEvent = min(TimeGenerated),
    LastEvent = max(TimeGenerated)
| extend Status = iff(EventCount > 0, "✅ Data flowing", "❌ No data")
```

### Step 12: Migration Cutover

Gradually shift traffic from old to new API validating each new data source:

**Week 1:** Test with 5% traffic
**Week 2:** Increase to 50%
**Week 3:** Full cutover to DCR-based ingestion
**Week 4:** Remove old Azure Monitor destinations

## Troubleshooting

### Common Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| **"Cannot create DCR for table"** | Table is still MMA-only | Run conversion script from Step 3 |
| **"Table not found"** | Table doesn't exist or wrong name | Verify table name ends with _CL |
| **"Schema query failed"** | Table is empty | Add sample data before conversion |
| **"No data via new API"** | Permissions missing | Check IAM roles on DCR |
| **"Schema mismatch"** | Pipeline output doesn't match DCR | Review and update pipeline function |

### Validation Checklist

```powershell
# Complete validation script
function Test-MigrationReadiness {
    param(
        [string]$WorkspaceName,
        [string]$ResourceGroupName,
        [string]$TableName
    )
    
    Write-Host "Checking $TableName..." -ForegroundColor Yellow
    
    # 1. Check if table is DCR-based
    $table = Get-AzOperationalInsightsTable `
        -ResourceGroupName $ResourceGroupName `
        -WorkspaceName $WorkspaceName `
        -TableName $TableName
    
    if ($table.Properties.plan -eq "Analytics") {
        Write-Host "✅ Table is DCR-based" -ForegroundColor Green
    } else {
        Write-Host "❌ Table is MMA-only - needs conversion" -ForegroundColor Red
        return $false
    }
    
    # 2. Check if DCR exists
    $dcr = Get-AzDataCollectionRule -ResourceGroupName $ResourceGroupName | 
           Where-Object { $_.Name -like "*$($TableName -replace '_CL','')*" }
    
    if ($dcr) {
        Write-Host "✅ DCR exists: $($dcr.Name)" -ForegroundColor Green
    } else {
        Write-Host "❌ No DCR found - run automation" -ForegroundColor Red
        return $false
    }
    
    # 3. Check recent data
    $query = "$TableName | where TimeGenerated > ago(1h) | count"
    $result = Invoke-AzOperationalInsightsQuery `
        -WorkspaceId (Get-AzOperationalInsightsWorkspace -ResourceGroupName $ResourceGroupName -Name $WorkspaceName).CustomerId `
        -Query $query
    
    if ($result.Results[0].'count_' -gt 0) {
        Write-Host "✅ Recent data found: $($result.Results[0].'count_') events" -ForegroundColor Green
    } else {
        Write-Host "⚠️ No recent data" -ForegroundColor Yellow
    }
    
    return $true
}

# Test your table
Test-MigrationReadiness `
    -WorkspaceName "your-workspace" `
    -ResourceGroupName "your-resource-group" `
    -TableName "FirewallLogs_CL"
```

## Timeline

- **Step 1-3**: Convert MMA tables to DCR-based (Day 1)
- **Step 4-9**: Create DCRs and configure Cribl (Day 2-3)
- **Step 10-11**: Test with small traffic percentage (Week 1)
- **Step 12**: Gradual cutover (Weeks 2-4)
- **Complete by September 2026**: Full migration before API retirement

## Quick Reference

| Step | Action | Required For |
|------|--------|--------------|
| 1 | Inventory tables | All migrations |
| 2 | Create app registration | All migrations |
| **3** | **Convert MMA tables to DCR-based** | **Existing MMA tables only** |
| 4-6 | Configure automation | All migrations |
| 7 | Create DCRs | All migrations |
| 8 | Assign permissions | All migrations |
| 9-12 | Configure Cribl and test | All migrations |

## Critical Points

⚠️ **You CANNOT create DCRs for MMA-only tables - they must be converted first**
⚠️ **Conversion is one-way - tables cannot be reverted to MMA-only**
⚠️ **Schema becomes fixed after conversion - no dynamic columns**
✅ **Both APIs work after conversion until September 2026**
✅ **All existing data is preserved during conversion**

## Additional Resources

- [Cribl-Microsoft GitHub Repository](https://github.com/criblio/Cribl-Microsoft)
- [Microsoft Custom Logs Migration Guide](https://learn.microsoft.com/en-us/azure/azure-monitor/logs/custom-logs-migrate)
- [Cribl Sentinel Destination Documentation](https://docs.cribl.io/stream/destinations-sentinel/)

## Support

For assistance:
- **Knowledge Article Author**: James Pederson jpederson@cribl.io
- **Cribl Community**: [Cribl Slack](https://cribl.io/community)
