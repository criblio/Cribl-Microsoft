# Create Azure Data Collection Rules for Tables (Native and Custom)

param(
    [Parameter(Mandatory=$false)]
    [string]$AzureParametersFile = "azure-parameters.json",

    [Parameter(Mandatory=$false)]
    [string]$OperationParametersFile = "operation-parameters.json",

    [Parameter(Mandatory=$false)]
    [string]$TableListFile = "NativeTableList.json",

    [Parameter(Mandatory=$false)]
    [string]$DCRTemplateWithDCEFile = "dcr-template-with-dce.json",

    [Parameter(Mandatory=$false)]
    [string]$DCRTemplateDirectFile = "dcr-template-direct.json",

    [Parameter(Mandatory=$false)]
    [string]$SpecificDCR = "",

    [Parameter(Mandatory=$false)]
    [switch]$SkipKnownIssues = $false,

    [Parameter(Mandatory=$false)]
    [switch]$ValidateTablesOnly = $false,

    [Parameter(Mandatory=$false)]
    [switch]$TemplateOnly = $false,

    [Parameter(Mandatory=$false)]
    [switch]$PreserveLargeTemplates = $false,

    [Parameter(Mandatory=$false)]
    [int]$KeepTemplateVersions = 5,

    [Parameter(Mandatory=$false)]
    [switch]$CleanupOldTemplates = $false,

    [Parameter(Mandatory=$false)]
    [switch]$CreateDCE = $false,

    [Parameter(Mandatory=$false)]
    [switch]$IgnoreOperationParameters = $false,

    [Parameter(Mandatory=$false)]
    [switch]$CustomTableMode = $false,

    [Parameter(Mandatory=$false)]
    [string]$CustomTableSchemasDirectory = "custom-table-schemas",

    [Parameter(Mandatory=$false)]
    [string]$CustomTableListFile = "",

    [Parameter(Mandatory=$false)]
    [int]$CustomTableRetentionDays = 30,

    [Parameter(Mandatory=$false)]
    [int]$CustomTableTotalRetentionDays = 90,

    [Parameter(Mandatory=$false)]
    [switch]$MigrateCustomTablesToDCR = $false,

    [Parameter(Mandatory=$false)]
    [switch]$AutoMigrateCustomTables = $false,

    [Parameter(Mandatory=$false)]
    [switch]$ShowCriblConfig = $false,

    [Parameter(Mandatory=$false)]
    [switch]$ExportCriblConfig = $true,

    [Parameter(Mandatory=$false)]
    [switch]$SkipCriblExport = $false
)

# Function to verify Azure connection using existing session only
function Ensure-AzureConnection {
    param(
        [switch]$Silent = $false
    )

    try {
        # Get current context
        $context = Get-AzContext -ErrorAction SilentlyContinue

        if (-not $context) {
            if (-not $Silent) {
                Write-Host "  ❌ No Azure context found. Please run 'Connect-AzAccount' first." -ForegroundColor Red
            }
            return $false
        }

        # Test if the token is still valid by making a simple API call
        # Suppress warnings about token expiration
        try {
            $testResult = Get-AzSubscription -SubscriptionId $context.Subscription.Id -ErrorAction Stop -WarningAction SilentlyContinue 2>$null | Out-Null

            if (-not $Silent) {
                # Only show this on initial check, not during processing
                Write-Host "  Azure connection verified" -ForegroundColor Green -NoNewline
                Write-Host " (Token valid)" -ForegroundColor DarkGray
            }
            return $true
        }
        catch {
            # Token is expired or invalid - try to refresh it
            if (-not $Silent) {
                Write-Host "  Token expired. Attempting automatic refresh..." -ForegroundColor Yellow
            }

            try {
                # Try to refresh using existing context info without interactive prompts
                if ($context -and $context.Account -and $context.Account.Id) {
                    # For user accounts, try silent refresh
                    if ($context.Account.Type -ne 'ServicePrincipal') {
                        try {
                            # Try to get a new access token using the existing context
                            $token = Get-AzAccessToken -ResourceUrl "https://management.azure.com/" -ErrorAction Stop
                            if ($token -and $token.Token) {
                                if (-not $Silent) {
                                    Write-Host "  ✓ Token refreshed successfully" -ForegroundColor Green
                                }
                                return $true
                            }
                        }
                        catch {
                            # Try Connect-AzAccount with account ID (should use cached credentials)
                            try {
                                $connectResult = Connect-AzAccount -AccountId $context.Account.Id -TenantId $context.Tenant.Id -Force -ErrorAction Stop -WarningAction SilentlyContinue
                                if ($connectResult) {
                                    # Ensure we're in the right subscription
                                    if ($context.Subscription.Id) {
                                        Set-AzContext -SubscriptionId $context.Subscription.Id -ErrorAction SilentlyContinue | Out-Null
                                    }
                                    if (-not $Silent) {
                                        Write-Host "  ✓ Azure connection refreshed successfully" -ForegroundColor Green
                                    }
                                    return $true
                                }
                            }
                            catch {
                                if (-not $Silent) {
                                    Write-Host "  ❌ Failed to refresh token automatically" -ForegroundColor Red
                                    Write-Host "     Please run 'Connect-AzAccount' to refresh your session" -ForegroundColor Yellow
                                }
                                return $false
                            }
                        }
                    } else {
                        # Service Principal - cannot refresh automatically
                        if (-not $Silent) {
                            Write-Host "  ❌ Service Principal session expired. Please re-authenticate." -ForegroundColor Red
                        }
                        return $false
                    }
                } else {
                    if (-not $Silent) {
                        Write-Host "  ❌ Cannot refresh - insufficient context information" -ForegroundColor Red
                    }
                    return $false
                }
            }
            catch {
                if (-not $Silent) {
                    Write-Host "  ❌ Token refresh failed: $($_.Exception.Message)" -ForegroundColor Red
                    Write-Host "     Please run 'Connect-AzAccount' to refresh your session" -ForegroundColor Yellow
                }
                return $false
            }
        }

    } catch {
        # General error with Azure connection
        if (-not $Silent) {
            Write-Host "  ❌ Failed to verify Azure connection: $($_.Exception.Message)" -ForegroundColor Red
        }
        return $false
    }
}

# Function to periodically check and refresh token during long operations
function Test-TokenRefresh {
    param(
        [int]$Counter,
        [int]$CheckInterval = 5  # Check every N operations
    )
    
    if ($Counter -gt 0 -and ($Counter % $CheckInterval) -eq 0) {
        # Silently check and refresh if needed
        Ensure-AzureConnection -Silent | Out-Null
    }
} # For Cribl Integration
# Run this script from VSCode terminal or PowerShell
# This script processes tables from NativeTableList.json (native) or CustomTableList.json (custom)
# Supports both DCE-based and Direct DCRs based on operation parameters
# Designed for Cribl Stream integration with Azure Log Analytics
# DEFAULT BEHAVIOR: Automatically exports Cribl configuration to cribl-dcr-config.json
# Outputs DCR immutable IDs and ingestion endpoints for Cribl configuration


# Function to map Azure Log Analytics column types to valid DCR types
function ConvertTo-DCRColumnType {
    param(
        [string]$ColumnType
    )
    
    # Azure DCR supports these types: string, int, long, real, boolean, datetime, dynamic, guid
    # Note: 'guid' is supported in DCR for compatibility with Log Analytics native tables
    switch ($ColumnType.ToLower()) {
        'string' { return 'string' }
        'int' { return 'int' }
        'int32' { return 'int' }
        'integer' { return 'int' }
        'long' { return 'long' }
        'int64' { return 'long' }
        'bigint' { return 'long' }
        'real' { return 'real' }
        'double' { return 'real' }
        'float' { return 'real' }
        'decimal' { return 'real' }
        'bool' { return 'boolean' }
        'boolean' { return 'boolean' }
        'datetime' { return 'datetime' }
        'timestamp' { return 'datetime' }
        'date' { return 'datetime' }
        'time' { return 'datetime' }
        'dynamic' { return 'dynamic' }
        'object' { return 'dynamic' }
        'json' { return 'dynamic' }
        'guid' { return 'string' }  # GUIDs not allowed in DCR - must convert to string
        'uniqueidentifier' { return 'string' }  # SQL Server GUID type - convert to string
        'uuid' { return 'string' }  # PostgreSQL UUID type - convert to string
        default { 
            Write-Warning "Unknown column type '$ColumnType' mapped to 'string'"
            return 'string' 
        }
    }
}

# Function to create a custom table in Log Analytics
function New-LogAnalyticsCustomTable {
    param(
        [string]$WorkspaceResourceId,
        [string]$TableName,
        [array]$Columns,
        [int]$RetentionInDays = 30,
        [int]$TotalRetentionInDays = 90
    )
    
    try {
        # Ensure table name has _CL suffix for custom tables
        if (-not $TableName.EndsWith("_CL")) {
            $TableName = "${TableName}_CL"
        }
        
        Write-Host "  Creating custom table: $TableName" -ForegroundColor Cyan
        
        # Get access token
        $context = Get-AzContext
        $token = [Microsoft.Azure.Commands.Common.Authentication.AzureSession]::Instance.AuthenticationFactory.Authenticate(
            $context.Account, 
            $context.Environment, 
            $context.Tenant.Id, 
            $null, 
            [Microsoft.Azure.Commands.Common.Authentication.ShowDialog]::Never, 
            $null, 
            "https://management.azure.com/"
        ).AccessToken
        
        $headers = @{
            'Authorization' = "Bearer $token"
            'Content-Type' = 'application/json'
        }
        
        # Extract subscription ID and resource group from workspace resource ID
        $resourceIdParts = $WorkspaceResourceId -split '/'
        $subscriptionId = $resourceIdParts[2]
        $resourceGroupName = $resourceIdParts[4]
        $workspaceName = $resourceIdParts[8]
        
        # Build the table schema
        $tableSchema = @{
            properties = @{
                plan = "Analytics"
                retentionInDays = $RetentionInDays
                totalRetentionInDays = $TotalRetentionInDays
                schema = @{
                    name = $TableName
                    columns = $Columns
                }
            }
        }
        
        $uri = "https://management.azure.com/subscriptions/$subscriptionId/resourceGroups/$resourceGroupName/providers/Microsoft.OperationalInsights/workspaces/$workspaceName/tables/$TableName"
        $uri += "?api-version=2022-10-01"
        
        $body = $tableSchema | ConvertTo-Json -Depth 10
        
        Write-Host "  Sending table creation request..." -ForegroundColor Gray
        $response = Invoke-RestMethod -Uri $uri -Method PUT -Headers $headers -Body $body -ErrorAction Stop
        
        Write-Host "  ✅ Custom table created successfully: $TableName" -ForegroundColor Green
        Write-Host "    Retention: $RetentionInDays days (archive: $TotalRetentionInDays days)" -ForegroundColor Gray
        
        return @{
            Success = $true
            TableName = $TableName
            Response = $response
        }
        
    } catch {
        $errorMessage = $_.Exception.Message
        
        # Check if table already exists
        if ($errorMessage -like "*already exists*" -or $errorMessage -like "*Conflict*") {
            Write-Host "  ⚠️ Table already exists: $TableName" -ForegroundColor Yellow
            return @{
                Success = $false
                AlreadyExists = $true
                TableName = $TableName
                Error = $errorMessage
            }
        }
        
        Write-Host "  ❌ Failed to create custom table: $errorMessage" -ForegroundColor Red
        return @{
            Success = $false
            AlreadyExists = $false
            TableName = $TableName
            Error = $errorMessage
        }
    }
}

# Function to migrate custom table from classic to DCR-based ingestion
function Convert-CustomTableToDCRBased {
    param(
        [string]$WorkspaceResourceId,
        [string]$TableName,
        [switch]$Force = $false
    )
    
    try {
        # Ensure table name has _CL suffix
        if (-not $TableName.EndsWith("_CL")) {
            $TableName = "${TableName}_CL"
        }
        
        Write-Host "  🔄 Attempting to migrate custom table to DCR-based ingestion: $TableName" -ForegroundColor Cyan
        
        # Get access token
        $context = Get-AzContext
        $token = [Microsoft.Azure.Commands.Common.Authentication.AzureSession]::Instance.AuthenticationFactory.Authenticate(
            $context.Account, 
            $context.Environment, 
            $context.Tenant.Id, 
            $null, 
            [Microsoft.Azure.Commands.Common.Authentication.ShowDialog]::Never, 
            $null, 
            "https://management.azure.com/"
        ).AccessToken
        
        $headers = @{
            'Authorization' = "Bearer $token"
            'Content-Type' = 'application/json'
        }
        
        # Extract subscription ID and resource group from workspace resource ID
        $resourceIdParts = $WorkspaceResourceId -split '/'
        $subscriptionId = $resourceIdParts[2]
        $resourceGroupName = $resourceIdParts[4]
        $workspaceName = $resourceIdParts[8]
        
        # First, check if table is already DCR-based
        $checkUri = "https://management.azure.com/subscriptions/$subscriptionId/resourceGroups/$resourceGroupName/providers/Microsoft.OperationalInsights/workspaces/$workspaceName/tables/$TableName"
        $checkUri += "?api-version=2022-10-01"
        
        Write-Host "  Checking current ingestion mode..." -ForegroundColor Gray
        $tableInfo = Invoke-RestMethod -Uri $checkUri -Method GET -Headers $headers -ErrorAction Stop
        
        # Check if already DCR-based (plan property indicates ingestion type)
        if ($tableInfo.properties.plan -eq "Analytics") {
            # Check for ingestion type indicators
            if ($tableInfo.properties.ingestionType -eq "DCRBased" -or 
                $tableInfo.properties.schema.tableType -eq "Microsoft" -or
                $tableInfo.properties.provisioningState -match "DCR") {
                Write-Host "  ✅ Table is already configured for DCR-based ingestion" -ForegroundColor Green
                return @{
                    Success = $true
                    AlreadyMigrated = $true
                    TableName = $TableName
                    Message = "Table already uses DCR-based ingestion"
                }
            }
        }
        
        # Build the migration URI
        $migrateUri = "https://management.azure.com/subscriptions/$subscriptionId/resourcegroups/$resourceGroupName/providers/Microsoft.OperationalInsights/workspaces/$workspaceName/tables/$TableName/migrate"
        $migrateUri += "?api-version=2021-12-01-preview"
        
        Write-Host "  Sending migration request..." -ForegroundColor Gray
        Write-Host "    URI: $migrateUri" -ForegroundColor DarkGray
        
        # Send migration request (POST with empty body)
        $response = Invoke-RestMethod -Uri $migrateUri -Method POST -Headers $headers -Body "{}" -ErrorAction Stop
        
        Write-Host "  ✅ Migration initiated successfully for table: $TableName" -ForegroundColor Green
        Write-Host "    Status: Table will now accept data through DCR-based ingestion" -ForegroundColor Gray
        
        # Wait a moment for migration to propagate
        Write-Host "  Waiting for migration to complete..." -ForegroundColor Gray
        Start-Sleep -Seconds 5
        
        return @{
            Success = $true
            AlreadyMigrated = $false
            TableName = $TableName
            Response = $response
            Message = "Successfully migrated to DCR-based ingestion"
        }
        
    } catch {
        $errorMessage = $_.Exception.Message
        $statusCode = $null
        
        # Try to extract status code from error
        if ($_.Exception.Response) {
            $statusCode = [int]$_.Exception.Response.StatusCode
        }
        
        # Handle specific error cases
        if ($statusCode -eq 409 -or $errorMessage -like "*Conflict*" -or $errorMessage -like "*already migrated*") {
            Write-Host "  ℹ️ Table is already migrated or in process: $TableName" -ForegroundColor Yellow
            return @{
                Success = $true
                AlreadyMigrated = $true
                TableName = $TableName
                Message = "Table already migrated or migration in progress"
            }
        } elseif ($statusCode -eq 404) {
            Write-Host "  ❌ Table not found for migration: $TableName" -ForegroundColor Red
            return @{
                Success = $false
                TableName = $TableName
                Error = "Table not found"
            }
        } elseif ($statusCode -eq 400 -or $errorMessage -like "*not eligible*" -or $errorMessage -like "*cannot be migrated*") {
            Write-Host "  ⚠️ Table not eligible for DCR-based migration: $TableName" -ForegroundColor Yellow
            Write-Host "    This table type may not support DCR-based ingestion" -ForegroundColor Gray
            return @{
                Success = $false
                TableName = $TableName
                Error = "Table not eligible for DCR-based ingestion"
                NotEligible = $true
            }
        } else {
            Write-Host "  ❌ Failed to migrate table: $errorMessage" -ForegroundColor Red
            if ($statusCode) {
                Write-Host "    Status Code: $statusCode" -ForegroundColor Gray
            }
            return @{
                Success = $false
                TableName = $TableName
                Error = $errorMessage
            }
        }
    }
}

# Function to load custom table schema from JSON file
function Get-CustomTableSchemaFromFile {
    param(
        [string]$TableName,
        [string]$SchemaDirectory
    )
    
    try {
        # Look for schema file (with or without _CL suffix)
        $schemaFileName = if ($TableName.EndsWith("_CL")) {
            $TableName
        } else {
            "${TableName}_CL"
        }
        
        $schemaFilePath = Join-Path $SchemaDirectory "$schemaFileName.json"
        
        # Also check without _CL suffix in filename
        if (-not (Test-Path $schemaFilePath)) {
            $altSchemaFilePath = Join-Path $SchemaDirectory "$TableName.json"
            if (Test-Path $altSchemaFilePath) {
                $schemaFilePath = $altSchemaFilePath
            }
        }
        
        if (-not (Test-Path $schemaFilePath)) {
            Write-Host "  ⚠️ Schema file not found: $schemaFilePath" -ForegroundColor Yellow
            return $null
        }
        
        Write-Host "  Loading schema from file: $schemaFilePath" -ForegroundColor Cyan
        $schemaContent = Get-Content $schemaFilePath -Raw | ConvertFrom-Json
        
        # Validate schema structure
        if (-not $schemaContent.columns) {
            throw "Schema file must contain 'columns' array"
        }
        
        # Convert column types to Log Analytics compatible types if needed
        $columns = @()
        foreach ($column in $schemaContent.columns) {
            if (-not $column.name -or -not $column.type) {
                throw "Each column must have 'name' and 'type' properties"
            }
            
            $columns += @{
                name = $column.name
                type = ConvertTo-DCRColumnType -ColumnType $column.type
                description = if ($column.description) { $column.description } else { "" }
            }
        }
        
        # Add system columns if not present
        $systemColumns = @("TimeGenerated")
        foreach ($sysCol in $systemColumns) {
            if (-not ($columns | Where-Object { $_.name -eq $sysCol })) {
                $columns += @{
                    name = $sysCol
                    type = "datetime"
                    description = "Timestamp when the record was generated"
                }
            }
        }
        
        Write-Host "  ✅ Schema loaded: $($columns.Count) columns" -ForegroundColor Green
        
        return @{
            columns = $columns
            retentionInDays = if ($schemaContent.retentionInDays) { $schemaContent.retentionInDays } else { 30 }
            totalRetentionInDays = if ($schemaContent.totalRetentionInDays) { $schemaContent.totalRetentionInDays } else { 90 }
            description = if ($schemaContent.description) { $schemaContent.description } else { "" }
        }
        
    } catch {
        Write-Host "  ❌ Failed to load schema from file: $($_.Exception.Message)" -ForegroundColor Red
        return $null
    }
}

# Function to handle custom table processing
function Process-CustomTable {
    param(
        [string]$TableName,
        [string]$WorkspaceResourceId,
        [string]$SchemaDirectory,
        [int]$RetentionDays,
        [int]$TotalRetentionDays,
        [bool]$MigrateExistingToDCR = $false,
        [bool]$AutoMigrate = $false
    )
    
    # Ensure table name has _CL suffix
    $customTableName = if ($TableName.EndsWith("_CL")) {
        $TableName
    } else {
        "${TableName}_CL"
    }
    
    Write-Host "  Processing custom table: $customTableName" -ForegroundColor Cyan
    
    # First, check if table exists in Azure
    Write-Host "  Checking if custom table exists in Azure..." -ForegroundColor Gray
    $existingTable = Get-LogAnalyticsTableSchema -WorkspaceResourceId $WorkspaceResourceId -TableName $customTableName
    
    if ($existingTable.Exists -eq $true) {
        Write-Host "  ✅ Custom table exists in Azure: $($existingTable.TableName)" -ForegroundColor Green
        Write-Host "    Using existing schema from Azure (same as native table processing)" -ForegroundColor Gray
        
        # Detect table type and get column count for informational purposes
        $isMMATable = $false
        if ($existingTable.Schema -and $existingTable.Schema.columns) {
            $columnCount = $existingTable.Schema.columns.Count
            Write-Host "    Azure schema has $columnCount total columns" -ForegroundColor Gray
        } elseif ($existingTable.Schema -and $existingTable.Schema.standardColumns) {
            $columnCount = $existingTable.Schema.standardColumns.Count
            Write-Host "    ⚠️  MMA (legacy) table detected - has $columnCount columns in standardColumns only" -ForegroundColor Yellow
            $isMMATable = $true
        }

        # Auto-enable migration for MMA tables
        $shouldAttemptMigration = $MigrateExistingToDCR -or $AutoMigrate
        if ($isMMATable -and -not $shouldAttemptMigration) {
            Write-Host "  📊 MMA table detected - automatic migration recommended" -ForegroundColor Cyan
            Write-Host "    MMA tables should be migrated to DCR-based format for better performance" -ForegroundColor Gray
            $shouldAttemptMigration = $true
        }

        # Attempt to migrate existing table to DCR-based if requested or if MMA table detected
        # ONLY apply to existing tables, not newly created ones
        if ($shouldAttemptMigration) {
            Write-Host "  📊 DCR-based ingestion migration check for existing table" -ForegroundColor Cyan
            
            $shouldMigrate = $false
            if ($AutoMigrate) {
                # Auto-migrate without prompting
                $shouldMigrate = $true
                Write-Host "    Auto-migration enabled" -ForegroundColor Gray
            } else {
                # Prompt user for confirmation with different messages based on table type
                if ($isMMATable) {
                    Write-Host "  ⚠️  MMA table detected. Migration to DCR-based format is REQUIRED for DCR creation." -ForegroundColor Yellow
                    Write-Host "  Migrate this MMA table to DCR-based ingestion? (Y/N): " -NoNewline -ForegroundColor Yellow
                } else {
                    Write-Host "  Migrate this existing table to DCR-based ingestion? (Y/N): " -NoNewline -ForegroundColor Yellow
                }
                $response = Read-Host
                $shouldMigrate = ($response -eq 'Y' -or $response -eq 'y')

                if (-not $shouldMigrate -and $isMMATable) {
                    Write-Host "  ❌ Cannot create DCR for MMA table without migration. Skipping table." -ForegroundColor Red
                }
            }
            
            if ($shouldMigrate) {
                $migrationResult = Convert-CustomTableToDCRBased `
                    -WorkspaceResourceId $WorkspaceResourceId `
                    -TableName $existingTable.TableName
                    
                if ($migrationResult.Success) {
                    if ($migrationResult.AlreadyMigrated) {
                        Write-Host "  ℹ️ Table already uses DCR-based ingestion" -ForegroundColor Cyan
                    } else {
                        Write-Host "  ✅ Successfully migrated existing table to DCR-based ingestion" -ForegroundColor Green
                        # Update summary if tracking migrations
                        if ($summary.CustomTablesMigrated) {
                            $summary.CustomTablesMigrated++
                        }
                    }
                } elseif ($migrationResult.NotEligible) {
                    Write-Host "  ℹ️ Continuing with classic ingestion mode" -ForegroundColor Yellow
                }
            } else {
                Write-Host "  Skipping migration - table will use classic ingestion" -ForegroundColor Yellow

                # If this is an MMA table and migration was declined, mark as not processable for DCR
                if ($isMMATable) {
                    return @{
                        Success = $false
                        TableExists = $true
                        TableName = $existingTable.TableName
                        Schema = $existingTable.Schema
                        Source = "Azure"
                        Error = "MMA table requires migration to DCR-based format before DCR creation"
                        SkipReason = "MMA migration declined"
                    }
                }
            }
        }

        return @{
            Success = $true
            TableExists = $true
            TableName = $existingTable.TableName
            Schema = $existingTable.Schema
            Source = "Azure"
        }
    }
    
    # Table doesn't exist in Azure - look for schema file to create it
    Write-Host "  Custom table not found in Azure. Looking for schema definition..." -ForegroundColor Yellow
    
    $schemaFromFile = Get-CustomTableSchemaFromFile -TableName $TableName -SchemaDirectory $SchemaDirectory
    
    if (-not $schemaFromFile) {
        # Neither table nor schema exists - prompt user for action
        $schemaFilePath = Join-Path $SchemaDirectory "$customTableName.json"
        Write-Host "" -ForegroundColor Yellow
        Write-Host "  ⚠️ CUSTOM TABLE SETUP REQUIRED" -ForegroundColor Yellow
        Write-Host "  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Yellow
        Write-Host "  Table: $customTableName" -ForegroundColor White
        Write-Host "  Status: Not found in Azure" -ForegroundColor Red
        Write-Host "  Schema: Not found locally" -ForegroundColor Red
        Write-Host "" -ForegroundColor Yellow
        Write-Host "  To proceed, you need to either:" -ForegroundColor Cyan
        Write-Host "  1. Create the table manually in Azure Portal, then re-run this script" -ForegroundColor Gray
        Write-Host "  2. Create a schema file at: $schemaFilePath" -ForegroundColor Gray
        Write-Host "     (See custom-table-schemas/MyCustomApp_CL.json for an example)" -ForegroundColor Gray
        Write-Host "" -ForegroundColor Yellow
        
        # Ask user if they want to continue without this table
        Write-Host "  Do you want to skip this table and continue? (Y/N): " -NoNewline -ForegroundColor Yellow
        $response = Read-Host
        
        if ($response -eq 'Y' -or $response -eq 'y') {
            Write-Host "  Skipping table: $customTableName" -ForegroundColor Yellow
            return @{
                Success = $false
                TableExists = $false
                TableName = $customTableName
                Error = "Skipped by user - no schema found"
                Skipped = $true
            }
        } else {
            Write-Host "  Stopping script. Please create the schema file and re-run." -ForegroundColor Red
            Write-Host "  Example command to create a basic schema file:" -ForegroundColor Cyan
            Write-Host @"
  
`$schema = @{
    description = "Description for $customTableName"
    retentionInDays = 30
    totalRetentionInDays = 90
    columns = @(
        @{name="TimeGenerated"; type="datetime"; description="Timestamp"},
        @{name="Computer"; type="string"; description="Computer name"},
        @{name="Message"; type="string"; description="Log message"}
    )
}
`$schema | ConvertTo-Json -Depth 10 | Set-Content "$schemaFilePath"
"@ -ForegroundColor Gray
            throw "User chose to stop script to create schema file"
        }
    }
    
    # Create the custom table
    Write-Host "  Creating custom table from schema file..." -ForegroundColor Cyan
    
    $createResult = New-LogAnalyticsCustomTable `
        -WorkspaceResourceId $WorkspaceResourceId `
        -TableName $customTableName `
        -Columns $schemaFromFile.columns `
        -RetentionInDays ($schemaFromFile.retentionInDays ?? $RetentionDays) `
        -TotalRetentionInDays ($schemaFromFile.totalRetentionInDays ?? $TotalRetentionDays)
    
    if ($createResult.Success) {
        # Wait a moment for table to be available
        Write-Host "  Waiting for table to be available..." -ForegroundColor Gray
        Start-Sleep -Seconds 10
        
        # Retrieve the created table schema
        $newTable = Get-LogAnalyticsTableSchema -WorkspaceResourceId $WorkspaceResourceId -TableName $customTableName
        
        if ($newTable.Exists -eq $true) {
            return @{
                Success = $true
                TableExists = $true
                TableName = $newTable.TableName
                Schema = $newTable.Schema
                Source = "Created"
            }
        }
    } elseif ($createResult.AlreadyExists) {
        # Table was created between our check and create attempt
        $existingTable = Get-LogAnalyticsTableSchema -WorkspaceResourceId $WorkspaceResourceId -TableName $customTableName
        if ($existingTable.Exists -eq $true) {
            return @{
                Success = $true
                TableExists = $true
                TableName = $existingTable.TableName
                Schema = $existingTable.Schema
                Source = "Azure"
            }
        }
    }
    
    return @{
        Success = $false
        TableExists = $false
        TableName = $customTableName
        Error = $createResult.Error
    }
}

# Function to verify Azure connection using existing session only
function Ensure-ValidAzureConnection {
    param(
        [switch]$Silent = $false
    )

    try {
        $context = Get-AzContext
        if (-not $context) {
            if (-not $Silent) {
                Write-Host "  ❌ No Azure context found. Please run 'Connect-AzAccount' first." -ForegroundColor Red
            }
            return $false
        }

        # Test if the context is still valid with a lightweight operation
        try {
            $null = Get-AzSubscription -SubscriptionId $context.Subscription.Id -ErrorAction Stop -WarningAction SilentlyContinue
            if (-not $Silent) {
                Write-Host "  ✓ Azure connection verified" -ForegroundColor Green
            }
            return $true
        } catch {
            # Token is expired or invalid - try to refresh it
            if (-not $Silent) {
                Write-Host "  Token expired. Attempting automatic refresh..." -ForegroundColor Yellow
            }

            try {
                # Try to refresh using existing context info without interactive prompts
                if ($context -and $context.Account -and $context.Account.Id) {
                    # For user accounts, try silent refresh
                    if ($context.Account.Type -ne 'ServicePrincipal') {
                        try {
                            # Try to get a new access token using the existing context
                            $token = Get-AzAccessToken -ResourceUrl "https://management.azure.com/" -ErrorAction Stop
                            if ($token -and $token.Token) {
                                if (-not $Silent) {
                                    Write-Host "  ✓ Token refreshed successfully" -ForegroundColor Green
                                }
                                return $true
                            }
                        }
                        catch {
                            # Try Connect-AzAccount with account ID (should use cached credentials)
                            try {
                                $connectResult = Connect-AzAccount -AccountId $context.Account.Id -TenantId $context.Tenant.Id -Force -ErrorAction Stop -WarningAction SilentlyContinue
                                if ($connectResult) {
                                    # Ensure we're in the right subscription
                                    if ($context.Subscription.Id) {
                                        Set-AzContext -SubscriptionId $context.Subscription.Id -ErrorAction SilentlyContinue | Out-Null
                                    }
                                    if (-not $Silent) {
                                        Write-Host "  ✓ Azure connection refreshed successfully" -ForegroundColor Green
                                    }
                                    return $true
                                }
                            }
                            catch {
                                if (-not $Silent) {
                                    Write-Host "  ❌ Failed to refresh token automatically" -ForegroundColor Red
                                    Write-Host "     Please run 'Connect-AzAccount' to refresh your session" -ForegroundColor Yellow
                                }
                                return $false
                            }
                        }
                    } else {
                        # Service Principal - cannot refresh automatically
                        if (-not $Silent) {
                            Write-Host "  ❌ Service Principal session expired. Please re-authenticate." -ForegroundColor Red
                        }
                        return $false
                    }
                } else {
                    if (-not $Silent) {
                        Write-Host "  ❌ Cannot refresh - insufficient context information" -ForegroundColor Red
                    }
                    return $false
                }
            }
            catch {
                if (-not $Silent) {
                    Write-Host "  ❌ Token refresh failed: $($_.Exception.Message)" -ForegroundColor Red
                    Write-Host "     Please run 'Connect-AzAccount' to refresh your session" -ForegroundColor Yellow
                }
                return $false
            }
        }
    } catch {
        if (-not $Silent) {
            Write-Host "  ❌ Failed to verify Azure connection: $($_.Exception.Message)" -ForegroundColor Red
        }
        return $false
    }
}

# Function to wrap Azure operations with automatic token refresh
function Invoke-AzureOperationWithRetry {
    param(
        [ScriptBlock]$Operation,
        [string]$OperationName = "Azure operation",
        [int]$MaxRetries = 2
    )
    
    $retryCount = 0
    $lastError = $null
    
    while ($retryCount -le $MaxRetries) {
        try {
            # Try the operation
            $result = & $Operation
            return $result
        } catch {
            $lastError = $_
            
            # Check if it's an authentication error
            $errorMessage = $_.Exception.Message
            if ($errorMessage -match "(expired|unauthorized|forbidden|401|403|credentials|acquire token|task was canceled)" -or 
                $_.Exception.GetType().Name -match "(Authentication|Authorization)") {
                
                if ($retryCount -lt $MaxRetries) {
                    Write-Host "  Authentication error detected. Refreshing token (attempt $($retryCount + 1) of $MaxRetries)..." -ForegroundColor Yellow
                    
                    # Try to refresh the connection
                    $refreshed = Ensure-ValidAzureConnection -Silent:$false
                    
                    if ($refreshed) {
                        $retryCount++
                        # Small delay before retry
                        Start-Sleep -Milliseconds 500
                        continue
                    } else {
                        throw $lastError
                    }
                } else {
                    Write-Host "  Maximum retry attempts reached for $OperationName" -ForegroundColor Red
                    throw $lastError
                }
            } else {
                # Not an auth error, throw immediately
                throw
            }
        }
    }
    
    # If we get here, all retries failed
    if ($lastError) {
        throw $lastError
    }
}

# Get the directory where this script is located
$ScriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Definition

# Build full paths
$FullAzureParametersPath = Join-Path $ScriptDirectory $AzureParametersFile
$FullOperationParametersPath = Join-Path $ScriptDirectory $OperationParametersFile
$FullTableListPath = Join-Path $ScriptDirectory $TableListFile
$FullDCRTemplateWithDCEPath = Join-Path $ScriptDirectory $DCRTemplateWithDCEFile
$FullDCRTemplateDirectPath = Join-Path $ScriptDirectory $DCRTemplateDirectFile
$FullCustomTableSchemasPath = Join-Path $ScriptDirectory $CustomTableSchemasDirectory

Write-Host "Starting Azure Data Collection Rules deployment for Cribl Integration..." -ForegroundColor Cyan
Write-Host "Script directory: $ScriptDirectory" -ForegroundColor Gray
Write-Host "Azure parameters file: $FullAzureParametersPath" -ForegroundColor Gray
Write-Host "Operation parameters file: $FullOperationParametersPath" -ForegroundColor Gray
Write-Host "Native table list file: $FullTableListPath" -ForegroundColor Gray
Write-Host "DCR template (with DCE): $FullDCRTemplateWithDCEPath" -ForegroundColor Gray
Write-Host "DCR template (Direct): $FullDCRTemplateDirectPath" -ForegroundColor Gray
if (-not $SkipCriblExport) {
    Write-Host "🔗 Cribl config will be exported to: cribl-dcr-configs\cribl-dcr-config.json" -ForegroundColor Magenta
} else {
    Write-Host "⏭️ Cribl config export disabled" -ForegroundColor Yellow
}

# Function to get table schema from Azure Log Analytics
function Get-LogAnalyticsTableSchema {
    param(
        [string]$WorkspaceResourceId,
        [string]$TableName
    )
    
    try {
        # Use current Az.Accounts method to get access token
        $context = Get-AzContext
        $token = [Microsoft.Azure.Commands.Common.Authentication.AzureSession]::Instance.AuthenticationFactory.Authenticate($context.Account, $context.Environment, $context.Tenant.Id, $null, [Microsoft.Azure.Commands.Common.Authentication.ShowDialog]::Never, $null, "https://management.azure.com/").AccessToken
        
        $headers = @{
            'Authorization' = "Bearer $token"
            'Content-Type' = 'application/json'
        }
        
        # Extract subscription ID and resource group from workspace resource ID
        $resourceIdParts = $WorkspaceResourceId -split '/'
        $subscriptionId = $resourceIdParts[2]
        $resourceGroupName = $resourceIdParts[4]
        $workspaceName = $resourceIdParts[8]
        
        # For custom tables, ensure _CL suffix
        if ($CustomTableMode -and -not $TableName.EndsWith("_CL") -and -not $TableName.StartsWith("Microsoft-")) {
            $TableName = "${TableName}_CL"
        }
        
        # Check for both Microsoft-{TableName} and {TableName}_CL format
        # For custom tables, prioritize _CL suffix check
        if ($CustomTableMode -and -not $TableName.StartsWith("Microsoft-")) {
            # For custom tables, check _CL variant first
            $tableVariants = @("${TableName}_CL", $TableName, "Microsoft-$TableName")
        } else {
            # For native tables, ONLY check Microsoft- prefix and exact name
            # DO NOT check _CL variant to avoid collision with custom tables
            $tableVariants = @("Microsoft-$TableName", $TableName)
        }
        
        foreach ($variant in $tableVariants) {
            $uri = "https://management.azure.com/subscriptions/$subscriptionId/resourceGroups/$resourceGroupName/providers/Microsoft.OperationalInsights/workspaces/$workspaceName/tables/$variant"
            $uri += "?api-version=2022-10-01"
            
            try {
                $response = Invoke-RestMethod -Uri $uri -Method GET -Headers $headers -ErrorAction Stop
                if ($response) {
                    # Check for potential collision
                    if (-not $CustomTableMode -and $variant -ne $TableName -and $variant.EndsWith("_CL")) {
                        Write-Warning "  Potential collision: Found custom table '$variant' while looking for native table '$TableName'"
                        Write-Warning "  This should not happen - native table mode should not find _CL tables"
                        continue  # Skip this variant and continue looking
                    }
                    Write-Host "  Debug: Found table schema for $variant" -ForegroundColor Gray
                    
                    # Debug the schema structure
                    if ($response.properties.schema) {
                        $schemaType = $response.properties.schema.GetType().Name
                        Write-Host "  Debug: Schema type: $schemaType" -ForegroundColor Magenta
                        if ($response.properties.schema.columns) {
                            $columnCount = @($response.properties.schema.columns).Count
                            Write-Host "  Debug: Schema has $columnCount columns in .columns property" -ForegroundColor Magenta
                        }
                        if ($response.properties.schema.standardColumns) {
                            $standardCount = @($response.properties.schema.standardColumns).Count
                            Write-Host "  Debug: Schema has $standardCount columns in .standardColumns property" -ForegroundColor Magenta
                        }
                    }
                    
                    # Flatten schema for backward compatibility
                    $flattenedSchema = $response.properties.schema
                    if ($flattenedSchema.schema) {
                        # Copy nested schema properties to top level for backward compatibility
                        if ($flattenedSchema.schema.columns) {
                            $flattenedSchema.columns = $flattenedSchema.schema.columns
                        }
                        if ($flattenedSchema.schema.standardColumns) {
                            $flattenedSchema.standardColumns = $flattenedSchema.schema.standardColumns
                        }
                    }

                    return @{
                        Exists = $true
                        TableName = $variant
                        Schema = $flattenedSchema
                        RetentionInDays = $response.properties.retentionInDays
                        TotalRetentionInDays = $response.properties.totalRetentionInDays
                        RawResponse = $response
                    }
                }
            } catch {
                # Table variant doesn't exist, continue checking
                continue
            }
        }
        
        # If we get here, no table was found
        if (-not $CustomTableMode) {
            Write-Host "  Debug: Native table not found. Checked variants: $($tableVariants -join ', ')" -ForegroundColor Yellow
            Write-Host "  Note: Custom table with similar name (${TableName}_CL) will NOT be used for native table processing" -ForegroundColor Yellow
        } else {
            Write-Host "  Debug: Custom table not found. Checked variants: $($tableVariants -join ', ')" -ForegroundColor Yellow
        }
        
        return @{
            Exists = $false
            TableName = $null
            Schema = $null
            RetentionInDays = $null
            TotalRetentionInDays = $null
            RawResponse = $null
        }
    } catch {
        Write-Warning "Unable to retrieve table schema for $TableName : $($_.Exception.Message)"
        return @{
            Exists = $null  # Unknown state
            TableName = $TableName
            Schema = $null
            RetentionInDays = $null
            TotalRetentionInDays = $null
            RawResponse = $null
        }
    }
}

# Function to analyze template complexity
function Get-TemplateDeploymentRecommendation {
    param([object]$TableSchema, [string]$TableName, [int]$TemplateSize)
    
    $recommendation = @{
        ShouldDeploy = $true; Reason = ""; ManualDeploymentAdvised = $false
        Warnings = @(); ColumnCount = 0; EstimatedComplexity = "Low"
    }
    
    $schemaColumns = $null
    if ($TableSchema -and $TableSchema.standardColumns) { $schemaColumns = $TableSchema.standardColumns }
    elseif ($TableSchema -and $TableSchema.columns) { $schemaColumns = $TableSchema.columns }
    
    if ($schemaColumns) {
        $recommendation.ColumnCount = $schemaColumns.Count
        
        if ($recommendation.ColumnCount -gt 150) { $recommendation.EstimatedComplexity = "Very High" }
        elseif ($recommendation.ColumnCount -gt 100) { $recommendation.EstimatedComplexity = "High" }
        elseif ($recommendation.ColumnCount -gt 50) { $recommendation.EstimatedComplexity = "Medium" }
        
        if ($TemplateSize -gt 4000000) {
            $recommendation.ShouldDeploy = $false
            $recommendation.ManualDeploymentAdvised = $true
            $recommendation.Reason = "Template size ($([math]::Round($TemplateSize/1024/1024, 2)) MB) exceeds Azure ARM template limit (4 MB)"
        } elseif ($recommendation.ColumnCount -gt 300) {
            $recommendation.ShouldDeploy = $false
            $recommendation.ManualDeploymentAdvised = $true
            $recommendation.Reason = "Table has $($recommendation.ColumnCount) columns, which often causes deployment timeouts and validation issues"
        } elseif ($TemplateSize -gt 2000000) {
            $recommendation.Warnings += "Large template size ($([math]::Round($TemplateSize/1024, 1)) KB) may cause slow deployment"
        }
    }
    
    return $recommendation
}

# Function to process table schema and generate column array
# Azure DCR Stream Naming Requirements:
# - Native Tables: Input = "Custom-<TableName>", Output = "Microsoft-<TableName>"
# - Custom Tables: Input = "Custom-<TableName>", Output = "Custom-<TableName>" (NOT Microsoft-!)
function Get-TableColumns {
    param([string]$TableName, [object]$TableSchema)
    
    $columns = @()
    
    # Debug: Show what we received
    Write-Host "  Debug: TableSchema type: $($TableSchema.GetType().Name)" -ForegroundColor Magenta
    if ($TableSchema) {
        $properties = $TableSchema | Get-Member -MemberType NoteProperty | Select-Object -ExpandProperty Name
        Write-Host "  Debug: TableSchema properties: $($properties -join ', ')" -ForegroundColor Magenta
    }
    
    # Azure returns columns in different properties for custom vs native tables:
    # - Custom tables: .columns contains all user columns, .standardColumns has system columns
    # - Native tables: .standardColumns or .columns contains the table schema
    
    $schemaColumns = $null
    
    if ($CustomTableMode) {
        # For custom tables, prefer .columns (DCR-based) but fall back to .standardColumns (MMA legacy)
        if ($TableSchema -and $TableSchema.columns) {
            Write-Host "  Debug: Custom table - using .columns property (DCR-based table)" -ForegroundColor Magenta
            $schemaColumns = $TableSchema.columns
        } elseif ($TableSchema -and $TableSchema.standardColumns) {
            Write-Host "  Debug: Custom table - using .standardColumns property (MMA legacy table)" -ForegroundColor Yellow
            Write-Host "  ⚠️  Note: This appears to be an MMA (legacy) table. Consider migrating to DCR-based format." -ForegroundColor Yellow
            $schemaColumns = $TableSchema.standardColumns
        } else {
            Write-Host "  Debug: Custom table - no .columns or .standardColumns property found!" -ForegroundColor Red
        }
    } else {
        # For native tables, try standardColumns first, then columns
        if ($TableSchema -and $TableSchema.standardColumns) {
            # Additional safety check: if standardColumns only has TenantId, this might be a custom table
            $standardColCount = @($TableSchema.standardColumns).Count
            if ($standardColCount -eq 1 -and $TableSchema.standardColumns[0].name -eq "TenantId" -and $TableSchema.columns) {
                Write-Warning "  Detected possible custom table schema (only TenantId in standardColumns)"
                Write-Warning "  This might indicate the wrong table was retrieved. Verify table name."
                # Use columns instead for native tables if standardColumns seems wrong
                Write-Host "  Debug: Native table - using .columns property due to suspicious standardColumns" -ForegroundColor Yellow
                $schemaColumns = $TableSchema.columns
            } else {
                Write-Host "  Debug: Native table - using .standardColumns property" -ForegroundColor Magenta
                $schemaColumns = $TableSchema.standardColumns
            }
        } elseif ($TableSchema -and $TableSchema.columns) {
            Write-Host "  Debug: Native table - using .columns property (fallback)" -ForegroundColor Magenta
            $schemaColumns = $TableSchema.columns
        }
    }
    
    # Handle edge cases
    if (-not $schemaColumns -and $TableSchema -is [array]) {
        Write-Host "  Debug: TableSchema is already an array of columns" -ForegroundColor Magenta
        $schemaColumns = $TableSchema
    }
    
    if (-not $schemaColumns) {
        Write-Host "  Debug: Unable to find columns in schema structure!" -ForegroundColor Red
    }
    
    if ($schemaColumns) {
        # Ensure it's an array (PowerShell unwraps single-item arrays)
        $schemaColumns = @($schemaColumns)
        Write-Host "  Debug: schemaColumns count after array conversion: $($schemaColumns.Count)" -ForegroundColor Magenta
        if ($schemaColumns.Count -eq 1) {
            Write-Host "  Debug: Single column found - Name: $($schemaColumns[0].name), Type: $($schemaColumns[0].type)" -ForegroundColor Magenta
        }
        
        # Filter out system columns AND columns with unsupported types
        # For custom tables, use MINIMAL filtering - only remove Azure internal columns
        $systemColumns = if ($CustomTableMode) {
            # For custom tables, only filter out Azure internal billing/resource columns
            # Plus Type which is the table name in Log Analytics
            @("_ResourceId", "_SubscriptionId", "_ItemId", "_IsBillable", "_BilledSize", "Type")
        } else {
            # For native tables, filter out more system columns
            @(
                "TenantId", "SourceSystem", "MG", "ManagementGroupName", 
                "_ResourceId", "Type", "_SubscriptionId", 
                "_ItemId", "_IsBillable", "_BilledSize",
                # Legacy Azure Table Storage columns
                "PartitionKey", "RowKey", "StorageAccount", "AzureDeploymentID", "AzureTableName",
                # Additional system columns that cause issues
                "TimeCollected", "SourceComputerId", "EventOriginId"
            )
        }
        
        # Filter out GUID columns for both native and custom tables - GUIDs not allowed in DCRs
        $filteredColumns = $schemaColumns | Where-Object { 
            $_.name -notin $systemColumns -and 
            $_.type.ToLower() -notin @('guid', 'uniqueidentifier', 'uuid')
        }
        
        Write-Host "  Schema Analysis:" -ForegroundColor Cyan
        Write-Host "    Total columns from Azure: $($schemaColumns.Count)" -ForegroundColor Gray
        
        # Count different types of filtered columns
        $systemFiltered = ($schemaColumns | Where-Object { $_.name -in $systemColumns }).Count
        $guidFiltered = ($schemaColumns | Where-Object { $_.type.ToLower() -in @('guid', 'uniqueidentifier', 'uuid') -and $_.name -notin $systemColumns }).Count
        $totalFiltered = $schemaColumns.Count - $filteredColumns.Count
        
        Write-Host "    System columns filtered: $systemFiltered" -ForegroundColor Gray
        Write-Host "    GUID columns filtered: $guidFiltered" -ForegroundColor Yellow
        Write-Host "    Total filtered: $totalFiltered" -ForegroundColor Gray
        Write-Host "    Columns to include in DCR: $($filteredColumns.Count)" -ForegroundColor Gray
        
        # Track type conversions for debugging
        $typeConversions = @{}
        
        foreach ($column in $filteredColumns) {
            # Map Azure Log Analytics types to valid DCR types
            $dcrType = ConvertTo-DCRColumnType -ColumnType $column.type
            
            # Track type conversions
            if (-not $typeConversions.ContainsKey($column.type)) {
                $typeConversions[$column.type] = $dcrType
            }
            
            $columns += @{
                name = $column.name
                type = $dcrType
            }
        }
        
        # Display type conversion summary
        if ($typeConversions.Count -gt 0) {
            Write-Host "    Type Conversions:" -ForegroundColor Gray
            foreach ($originalType in $typeConversions.Keys | Sort-Object) {
                $convertedType = $typeConversions[$originalType]
                if ($originalType -ne $convertedType) {
                    Write-Host "      $originalType -> $convertedType" -ForegroundColor Yellow
                } else {
                    Write-Host "      $originalType (no change)" -ForegroundColor Gray
                }
            }
        }
        
        return $columns
    } else {
        return $null
    }
}

# Function to display manual deployment instructions
function Show-ManualDeploymentInstructions {
    param([string]$TableName, [string]$TemplatePath, [string]$DCRName, [string]$ResourceGroupName, [string]$Location, [string]$WorkspaceResourceId, [string]$EndpointResourceId, [string]$Reason, [bool]$UseDCE)
    
    Write-Host "`n$('='*80)" -ForegroundColor Yellow
    Write-Host "MANUAL DEPLOYMENT RECOMMENDED: $TableName" -ForegroundColor Yellow
    Write-Host "$('='*80)" -ForegroundColor Yellow
    Write-Host "Reason: $Reason" -ForegroundColor Red
    Write-Host "`nThe generated ARM template has been saved for manual deployment:" -ForegroundColor White
    Write-Host "Template Location: $TemplatePath" -ForegroundColor Cyan
    Write-Host "`nUse Azure Portal -> Deploy a custom template for best results" -ForegroundColor Green
}

# Function to retrieve Cribl configuration information from DCR
function Get-CriblConfigFromDCR {
    param(
        [string]$ResourceGroupName,
        [string]$DCRName,
        [string]$DCEResourceId = $null,
        [string]$TableName = $null
    )
    
    try {
        Write-Host "  Retrieving Cribl config for DCR: $DCRName" -ForegroundColor Gray
        
        # Get DCR details
        $dcr = Get-AzDataCollectionRule -ResourceGroupName $ResourceGroupName -Name $DCRName -ErrorAction Stop
        
        $criblConfig = @{
            DCRName = $dcr.Name
            DCRImmutableId = $dcr.ImmutableId
            StreamName = ""
            TableName = ""
            IngestionEndpoint = ""
            Type = if ($dcr.Kind -eq "Direct") { "Direct" } else { "DCE-based" }
        }
        
        # Debug: Check what we have
        Write-Host "    DCR Type: $($criblConfig.Type)" -ForegroundColor Gray
        Write-Host "    DCR Immutable ID: $($dcr.ImmutableId)" -ForegroundColor Gray
        
        # First, try to get metadata from the generated template file if it exists
        $templatesDir = Join-Path $ScriptDirectory "generated-templates"
        $templateFound = $false
        
        if (Test-Path $templatesDir) {
            # Try to find template file for this table
            $possibleTemplateNames = @()
            if ($TableName) {
                $possibleTemplateNames += "$TableName-latest.json"
            }
            
            # Also try to extract table name from DCR name (format: dcr-prefix-TableName-location)
            $nameParts = $DCRName -split '-'
            if ($nameParts.Count -ge 3) {
                # Typically index 2 is the table name in dcr-jp-TableName-eastus format
                $extractedTableName = $nameParts[2]
                $possibleTemplateNames += "$extractedTableName-latest.json"
            }
            
            foreach ($templateName in $possibleTemplateNames) {
                $templatePath = Join-Path $templatesDir $templateName
                if (Test-Path $templatePath) {
                    Write-Host "    Found template file: $templateName" -ForegroundColor Gray
                    try {
                        $template = Get-Content $templatePath -Raw | ConvertFrom-Json
                        if ($template.metadata) {
                            if ($template.metadata.streamName) {
                                $criblConfig.StreamName = $template.metadata.streamName
                                Write-Host "    Got stream name from template: $($criblConfig.StreamName)" -ForegroundColor Green
                            }
                            if ($template.metadata.tableName) {
                                $criblConfig.TableName = $template.metadata.tableName
                                Write-Host "    Got table name from template: $($criblConfig.TableName)" -ForegroundColor Green
                            }
                            $templateFound = $true
                            break
                        }
                    } catch {
                        Write-Warning "    Could not read template metadata: $($_.Exception.Message)"
                    }
                }
            }
        }
        
        # If we didn't get stream/table from template, try to get from DCR data flows
        if (-not $templateFound -or -not $criblConfig.StreamName -or -not $criblConfig.TableName) {
            Write-Host "    Extracting from DCR data flows..." -ForegroundColor Gray
            
        if ($dcr.DataFlows -and $dcr.DataFlows.Count -gt 0) {
            # First data flow
            $dataFlow = $dcr.DataFlows[0]
            
            # Debug: Show data flow structure
            Write-Host "    DataFlow properties: $($dataFlow.PSObject.Properties.Name -join ', ')" -ForegroundColor DarkGray
            
            # Handle different property names for streams
            if ($dataFlow.streams) {
                $criblConfig.StreamName = $dataFlow.streams[0]
            } elseif ($dataFlow.Streams) {
                $criblConfig.StreamName = $dataFlow.Streams[0]
            } elseif ($dataFlow.PSObject.Properties['streams']) {
                $criblConfig.StreamName = $dataFlow.PSObject.Properties['streams'].Value[0]
            }
            
            # Handle different property names for output stream
            $outputStream = ""
            if ($dataFlow.outputStream) {
                $outputStream = $dataFlow.outputStream
            } elseif ($dataFlow.OutputStream) {
                $outputStream = $dataFlow.OutputStream
            } elseif ($dataFlow.destinations -and $dataFlow.destinations.Count -gt 0) {
                # Sometimes the output is in destinations
                $outputStream = $dataFlow.destinations[0]
            } elseif ($dataFlow.PSObject.Properties['outputStream']) {
                $outputStream = $dataFlow.PSObject.Properties['outputStream'].Value
            }
            
            # Extract table name from output stream or stream name
            if ($outputStream) {
                $criblConfig.TableName = $outputStream -replace '^(Microsoft-|Custom-)', ''
            } elseif ($criblConfig.StreamName) {
                # Fallback: extract from stream name
                $criblConfig.TableName = $criblConfig.StreamName -replace '^(Microsoft-|Custom-)', ''
            }
            
            Write-Host "    Stream Name: $($criblConfig.StreamName)" -ForegroundColor Gray
            Write-Host "    Table Name: $($criblConfig.TableName)" -ForegroundColor Gray
        } else {
                Write-Warning "    No data flows found in DCR"
            }
        }
        
        # Get ingestion endpoint
        if ($dcr.Kind -eq "Direct") {
            # For Direct DCRs, extract the logsIngestion endpoint from the DCR itself
            Write-Host "    Direct DCR - Extracting logsIngestion endpoint from DCR..." -ForegroundColor Gray
            
            $endpoint = $null
            
            # Try different property paths for logsIngestion
            if ($dcr.LogsIngestion) {
                if ($dcr.LogsIngestion.Endpoint) {
                    $endpoint = $dcr.LogsIngestion.Endpoint
                    Write-Host "    Found at LogsIngestion.Endpoint" -ForegroundColor DarkGray
                } elseif ($dcr.LogsIngestion.endpoint) {
                    $endpoint = $dcr.LogsIngestion.endpoint
                    Write-Host "    Found at LogsIngestion.endpoint" -ForegroundColor DarkGray
                }
            } elseif ($dcr.Properties -and $dcr.Properties.LogsIngestion) {
                if ($dcr.Properties.LogsIngestion.Endpoint) {
                    $endpoint = $dcr.Properties.LogsIngestion.Endpoint
                    Write-Host "    Found at Properties.LogsIngestion.Endpoint" -ForegroundColor DarkGray
                } elseif ($dcr.Properties.LogsIngestion.endpoint) {
                    $endpoint = $dcr.Properties.LogsIngestion.endpoint
                    Write-Host "    Found at Properties.LogsIngestion.endpoint" -ForegroundColor DarkGray
                }
            } elseif ($dcr.Properties -and $dcr.Properties.logsIngestion) {
                if ($dcr.Properties.logsIngestion.endpoint) {
                    $endpoint = $dcr.Properties.logsIngestion.endpoint
                    Write-Host "    Found at Properties.logsIngestion.endpoint" -ForegroundColor DarkGray
                }
            }
            
            # Check via PSObject properties
            if (-not $endpoint) {
                $propNames = @('LogsIngestion', 'logsIngestion')
                foreach ($prop in $propNames) {
                    if ($dcr.PSObject.Properties[$prop]) {
                        $logsIngestion = $dcr.PSObject.Properties[$prop].Value
                        if ($logsIngestion.endpoint) {
                            $endpoint = $logsIngestion.endpoint
                            Write-Host "    Found at PSObject.$prop.endpoint" -ForegroundColor DarkGray
                            break
                        } elseif ($logsIngestion.Endpoint) {
                            $endpoint = $logsIngestion.Endpoint
                            Write-Host "    Found at PSObject.$prop.Endpoint" -ForegroundColor DarkGray
                            break
                        }
                    }
                }
            }
            
            # Last resort: parse from JSON
            if (-not $endpoint) {
                try {
                    $dcrJson = $dcr | ConvertTo-Json -Depth 10 | ConvertFrom-Json
                    if ($dcrJson.properties.logsIngestion.endpoint) {
                        $endpoint = $dcrJson.properties.logsIngestion.endpoint
                        Write-Host "    Found via JSON parsing at properties.logsIngestion.endpoint" -ForegroundColor DarkGray
                    } elseif ($dcrJson.logsIngestion.endpoint) {
                        $endpoint = $dcrJson.logsIngestion.endpoint
                        Write-Host "    Found via JSON parsing at logsIngestion.endpoint" -ForegroundColor DarkGray
                    }
                } catch {
                    Write-Host "    Could not parse JSON: $($_.Exception.Message)" -ForegroundColor DarkGray
                }
            }
            
            if ($endpoint) {
                $criblConfig.IngestionEndpoint = $endpoint
                Write-Host "    Direct DCR - LogsIngestion Endpoint: $endpoint" -ForegroundColor Gray
            } else {
                # Fallback to location-based construction if we can't find the logsIngestion endpoint
                Write-Warning "    Could not extract logsIngestion endpoint from Direct DCR, using location-based fallback"
                $location = $dcr.Location.Replace(' ', '').ToLower()
                $criblConfig.IngestionEndpoint = "https://${location}.ingest.monitor.azure.com"
                Write-Host "    Direct DCR - Fallback Ingestion Endpoint: $($criblConfig.IngestionEndpoint)" -ForegroundColor Yellow
            }
        } else {
            # For DCE-based DCRs, check different possible property names
            $dceId = $null
            
            # Try different property names for DCE ID
            if ($DCEResourceId) {
                $dceId = $DCEResourceId
                Write-Host "    Using provided DCE ID" -ForegroundColor Gray
            } elseif ($dcr.DataCollectionEndpointId) {
                $dceId = $dcr.DataCollectionEndpointId
                Write-Host "    Found DataCollectionEndpointId in DCR" -ForegroundColor Gray
            } elseif ($dcr.Properties -and $dcr.Properties.DataCollectionEndpointId) {
                $dceId = $dcr.Properties.DataCollectionEndpointId
                Write-Host "    Found DataCollectionEndpointId in Properties" -ForegroundColor Gray
            } elseif ($dcr.PSObject.Properties['dataCollectionEndpointId']) {
                $dceId = $dcr.PSObject.Properties['dataCollectionEndpointId'].Value
                Write-Host "    Found dataCollectionEndpointId via PSObject" -ForegroundColor Gray
            }
            
            if ($dceId) {
                Write-Host "    DCE Resource ID: $dceId" -ForegroundColor Gray
                $dceResourceGroup = $dceId -split '/' | Select-Object -Index 4
                $dceName = $dceId -split '/' | Select-Object -Last 1
                
                Write-Host "    Retrieving DCE: $dceName from RG: $dceResourceGroup" -ForegroundColor Gray
                
                try {
                    $dce = Get-AzDataCollectionEndpoint -ResourceGroupName $dceResourceGroup -Name $dceName -ErrorAction Stop
                    
                    # Try different property names for ingestion endpoint
                    # The actual property path can vary based on API version
                    $endpoint = $null
                    
                    # Most common location
                    if ($dce.LogsIngestionEndpoint) {
                        $endpoint = $dce.LogsIngestionEndpoint
                        Write-Host "    Found endpoint at LogsIngestionEndpoint" -ForegroundColor DarkGray
                    } 
                    # Check in Properties
                    elseif ($dce.Properties) {
                        if ($dce.Properties.LogsIngestionEndpoint) {
                            $endpoint = $dce.Properties.LogsIngestionEndpoint
                            Write-Host "    Found endpoint at Properties.LogsIngestionEndpoint" -ForegroundColor DarkGray
                        } elseif ($dce.Properties.logsIngestionEndpoint) {
                            $endpoint = $dce.Properties.logsIngestionEndpoint
                            Write-Host "    Found endpoint at Properties.logsIngestionEndpoint" -ForegroundColor DarkGray
                        } elseif ($dce.Properties.logsIngestion -and $dce.Properties.logsIngestion.endpoint) {
                            $endpoint = $dce.Properties.logsIngestion.endpoint
                            Write-Host "    Found endpoint at Properties.logsIngestion.endpoint" -ForegroundColor DarkGray
                        }
                    }
                    # Check via PSObject
                    if (-not $endpoint) {
                        $propNames = @('LogsIngestionEndpoint', 'logsIngestionEndpoint', 'ConfigurationAccessEndpoint')
                        foreach ($prop in $propNames) {
                            if ($dce.PSObject.Properties[$prop] -and $dce.PSObject.Properties[$prop].Value) {
                                $endpoint = $dce.PSObject.Properties[$prop].Value
                                Write-Host "    Found endpoint at PSObject.$prop" -ForegroundColor DarkGray
                                break
                            }
                        }
                    }
                    
                    # Last resort: parse from JSON
                    if (-not $endpoint) {
                        try {
                            $dceJson = $dce | ConvertTo-Json -Depth 10 | ConvertFrom-Json
                            if ($dceJson.properties.logsIngestion.endpoint) {
                                $endpoint = $dceJson.properties.logsIngestion.endpoint
                                Write-Host "    Found endpoint via JSON parsing" -ForegroundColor DarkGray
                            }
                        } catch {}
                    }
                    
                    if ($endpoint) {
                        $criblConfig.IngestionEndpoint = $endpoint
                        Write-Host "    DCE Ingestion Endpoint: $endpoint" -ForegroundColor Gray
                    } else {
                        Write-Warning "    DCE found but could not extract ingestion endpoint"
                        Write-Host "    Available properties: $($dce.PSObject.Properties.Name -join ', ')" -ForegroundColor DarkGray
                        # Don't construct - this means we couldn't get the real endpoint
                        $criblConfig.IngestionEndpoint = "[NEEDS MANUAL CONFIGURATION]"
                    }
                } catch {
                    Write-Warning "    Could not retrieve DCE: $($_.Exception.Message)"
                    # Try to construct from DCE name if we have it
                    if ($dceName) {
                        $location = $dcr.Location.Replace(' ', '').ToLower()
                        $criblConfig.IngestionEndpoint = "https://${dceName}.${location}.ingest.monitor.azure.com"
                        Write-Host "    Using DCE-based fallback: $($criblConfig.IngestionEndpoint)" -ForegroundColor Yellow
                    } else {
                        # Final fallback to location-based endpoint
                        $location = $dcr.Location.Replace(' ', '').ToLower()
                        $criblConfig.IngestionEndpoint = "https://${location}.ingest.monitor.azure.com"
                        Write-Host "    Using location fallback: $($criblConfig.IngestionEndpoint)" -ForegroundColor Yellow
                    }
                }
            } else {
                Write-Warning "    No DCE ID found for DCE-based DCR"
                # Fallback to location-based endpoint
                $location = $dcr.Location.Replace(' ', '').ToLower()
                $criblConfig.IngestionEndpoint = "https://${location}.ingest.monitor.azure.com"
                Write-Host "    Using fallback endpoint: $($criblConfig.IngestionEndpoint)" -ForegroundColor Yellow
            }
        }
        
        Write-Host "    Cribl config retrieved successfully" -ForegroundColor Green
        return $criblConfig
        
    } catch {
        Write-Warning "Could not retrieve Cribl configuration for DCR '$DCRName': $($_.Exception.Message)"
        return $null
    }
}

# Function to display Cribl configuration
function Show-CriblConfiguration {
    param(
        [object]$CriblConfig,
        [string]$TableName
    )
    
    Write-Host "`n  🔗 CRIBL INTEGRATION CONFIGURATION" -ForegroundColor Magenta
    Write-Host "  ═══════════════════════════════════" -ForegroundColor Magenta
    Write-Host "    DCR Immutable ID: " -NoNewline -ForegroundColor White
    Write-Host "$($CriblConfig.DCRImmutableId)" -ForegroundColor Yellow
    Write-Host "    Ingestion Endpoint: " -NoNewline -ForegroundColor White
    Write-Host "$($CriblConfig.IngestionEndpoint)" -ForegroundColor Yellow
    Write-Host "    Stream Name: " -NoNewline -ForegroundColor White
    Write-Host "$($CriblConfig.StreamName)" -ForegroundColor Yellow
    Write-Host "    Target Table: " -NoNewline -ForegroundColor White
    Write-Host "$($CriblConfig.TableName)" -ForegroundColor Yellow
    Write-Host "    DCR Type: " -NoNewline -ForegroundColor White
    Write-Host "$($CriblConfig.Type)" -ForegroundColor Cyan
    Write-Host "  ═══════════════════════════════════" -ForegroundColor Magenta
}

# Function to cleanup old template versions
function Invoke-TemplateCleanup {
    param([string]$TemplatesDirectory, [string]$TableName, [int]$KeepVersions)
    
    if ($KeepVersions -le 0) { return }
    
    $tableTemplates = Get-ChildItem -Path $TemplatesDirectory -Filter "$TableName-*.json" | 
        Where-Object { $_.Name -notlike "*-latest.json" -and $_.Name -match "$TableName-\d{8}-\d{6}\.json$" } | 
        Sort-Object CreationTime -Descending
    
    if ($tableTemplates.Count -gt $KeepVersions) {
        $templatesToDelete = $tableTemplates | Select-Object -Skip $KeepVersions
        Write-Host "    Cleaning up old templates for $TableName (keeping $KeepVersions timestamped versions + latest):" -ForegroundColor Yellow
        foreach ($template in $templatesToDelete) {
            Write-Host "      Removing: $($template.Name)" -ForegroundColor Gray
            Remove-Item -Path $template.FullName -Force
        }
    }
}

# Load operation parameters
if (-not $IgnoreOperationParameters -and (Test-Path $FullOperationParametersPath)) {
    Write-Host "Loading operation parameters from: $FullOperationParametersPath" -ForegroundColor Yellow
    try {
        $operationParams = Get-Content $FullOperationParametersPath | ConvertFrom-Json
        
        if (-not $PSBoundParameters.ContainsKey('CleanupOldTemplates')) { $CleanupOldTemplates = $operationParams.templateManagement.cleanupOldTemplates }
        if (-not $PSBoundParameters.ContainsKey('KeepTemplateVersions')) { $KeepTemplateVersions = $operationParams.templateManagement.keepTemplateVersions }
        if (-not $PSBoundParameters.ContainsKey('CreateDCE')) { $CreateDCE = $operationParams.deployment.createDCE }
        if (-not $PSBoundParameters.ContainsKey('TemplateOnly')) { $TemplateOnly = $operationParams.scriptBehavior.templateOnly }
        if (-not $PSBoundParameters.ContainsKey('CustomTableMode')) { $CustomTableMode = $operationParams.customTableSettings.enabled }
        if (-not $PSBoundParameters.ContainsKey('CustomTableSchemasDirectory')) { $CustomTableSchemasDirectory = $operationParams.customTableSettings.schemasDirectory }
        if (-not $PSBoundParameters.ContainsKey('CustomTableListFile') -and $operationParams.customTableSettings.customTableListFile) { 
            $CustomTableListFile = $operationParams.customTableSettings.customTableListFile 
        }
        if (-not $PSBoundParameters.ContainsKey('TableListFile') -and $operationParams.customTableSettings.nativeTableListFile) { 
            $TableListFile = $operationParams.customTableSettings.nativeTableListFile 
        }
        if (-not $PSBoundParameters.ContainsKey('CustomTableRetentionDays')) { $CustomTableRetentionDays = $operationParams.customTableSettings.defaultRetentionDays }
        if (-not $PSBoundParameters.ContainsKey('CustomTableTotalRetentionDays')) { $CustomTableTotalRetentionDays = $operationParams.customTableSettings.defaultTotalRetentionDays }
        if (-not $PSBoundParameters.ContainsKey('MigrateCustomTablesToDCR') -and $operationParams.customTableSettings.migrateExistingTablesToDCRBased) { 
            $MigrateCustomTablesToDCR = $operationParams.customTableSettings.migrateExistingTablesToDCRBased 
        }
        if (-not $PSBoundParameters.ContainsKey('AutoMigrateCustomTables') -and $operationParams.customTableSettings.autoMigrateExistingTables) { 
            $AutoMigrateCustomTables = $operationParams.customTableSettings.autoMigrateExistingTables 
        }
        
        Write-Host "Operation parameters loaded successfully" -ForegroundColor Green
        Write-Host "  Create DCE: $CreateDCE" -ForegroundColor Cyan
        Write-Host "  Template Only Mode: $TemplateOnly" -ForegroundColor Cyan
        Write-Host "  Custom Table Mode: $CustomTableMode" -ForegroundColor Cyan
        
        if ($CustomTableMode) {
            Write-Host "  Custom Table Settings:" -ForegroundColor Cyan
            Write-Host "    Schemas Directory: $CustomTableSchemasDirectory" -ForegroundColor Gray
            Write-Host "    Default Retention: $CustomTableRetentionDays days" -ForegroundColor Gray
            Write-Host "    Default Total Retention: $CustomTableTotalRetentionDays days" -ForegroundColor Gray
            if ($CustomTableListFile) {
                Write-Host "    Custom Table List File: $CustomTableListFile" -ForegroundColor Gray
            }
        }
        
    } catch {
        Write-Warning "Failed to load operation parameters: $($_.Exception.Message)"
    }
}

# Determine which template to use and deployment mode
$dcrMode = if ($CreateDCE) { "DCE-based" } else { "Direct" }
$templateFile = if ($CreateDCE) { $FullDCRTemplateWithDCEPath } else { $FullDCRTemplateDirectPath }
$processingMode = if ($CustomTableMode) { "Custom Tables" } else { "Native Tables" }

Write-Host "DCR Mode: $dcrMode" -ForegroundColor Cyan
Write-Host "Processing Mode: $processingMode" -ForegroundColor Cyan
Write-Host "Template file: $templateFile" -ForegroundColor Cyan

# Load Azure parameters
Write-Host "Loading Azure parameters from: $FullAzureParametersPath" -ForegroundColor Yellow
try {
    if (!(Test-Path $FullAzureParametersPath)) { throw "Azure parameters file not found: $FullAzureParametersPath" }
    $azureParameters = Get-Content $FullAzureParametersPath | ConvertFrom-Json
    Write-Host "Azure parameters loaded successfully" -ForegroundColor Green
} catch {
    Write-Host "Failed to load Azure parameters: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

# Load table list - use custom table list if in custom mode and file specified
$tableListPath = if ($CustomTableMode -and $CustomTableListFile) {
    Join-Path $ScriptDirectory $CustomTableListFile
} else {
    $FullTableListPath
}

Write-Host "Loading table list from: $tableListPath" -ForegroundColor Yellow
try {
    if (!(Test-Path $tableListPath)) { throw "Table list file not found: $tableListPath" }
    $tableList = Get-Content $tableListPath | ConvertFrom-Json
    Write-Host "Table list loaded successfully - Found $($tableList.Count) tables" -ForegroundColor Green
} catch {
    Write-Host "Failed to load table list: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

# Create custom table schemas directory if it doesn't exist (in custom table mode)
if ($CustomTableMode) {
    if (!(Test-Path $FullCustomTableSchemasPath)) {
        Write-Host "Creating custom table schemas directory: $FullCustomTableSchemasPath" -ForegroundColor Yellow
        New-Item -ItemType Directory -Path $FullCustomTableSchemasPath -Force | Out-Null
        
        # Create a sample schema file for reference
        $sampleSchema = @{
            description = "Sample custom table schema - copy and modify this for your custom tables"
            retentionInDays = 30
            totalRetentionInDays = 90
            columns = @(
                @{
                    name = "TimeGenerated"
                    type = "datetime"
                    description = "Timestamp when the record was generated"
                },
                @{
                    name = "Computer"
                    type = "string"
                    description = "Computer name"
                },
                @{
                    name = "EventID"
                    type = "int"
                    description = "Event identifier"
                },
                @{
                    name = "Message"
                    type = "string"
                    description = "Event message"
                },
                @{
                    name = "Severity"
                    type = "string"
                    description = "Event severity level"
                }
            )
        }
        
        $sampleSchemaPath = Join-Path $FullCustomTableSchemasPath "SampleTable_CL.json.sample"
        $sampleSchema | ConvertTo-Json -Depth 10 | Set-Content $sampleSchemaPath
        Write-Host "  Created sample schema file: $sampleSchemaPath" -ForegroundColor Gray
    }
}

# Load DCR template
Write-Host "Loading DCR template from: $templateFile" -ForegroundColor Yellow
try {
    if (!(Test-Path $templateFile)) { throw "DCR template file not found: $templateFile" }
    $dcrTemplate = Get-Content $templateFile -Raw | ConvertFrom-Json
    Write-Host "DCR template loaded successfully ($dcrMode)" -ForegroundColor Green
} catch {
    Write-Host "Failed to load DCR template: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

# Filter table list if specific DCR requested
if ($SpecificDCR) {
    $tableList = $tableList | Where-Object { $_ -eq $SpecificDCR }
    if ($tableList.Count -eq 0) {
        Write-Host "No table found for DCR: $SpecificDCR" -ForegroundColor Red
        exit 1
    }
    Write-Host "Processing specific DCR: $SpecificDCR" -ForegroundColor Green
}

# Extract Azure parameters
$ResourceGroupName = $azureParameters.resourceGroupName
$WorkspaceName = $azureParameters.workspaceName
$DCRPrefix = $azureParameters.dcrPrefix
$DCRSuffix = $azureParameters.dcrSuffix
$Location = $azureParameters.location

# DCE parameters (only used if CreateDCE is true)
if ($CreateDCE) {
    $DCEResourceGroupName = $azureParameters.dceResourceGroupName
    $DCEPrefix = $azureParameters.dcePrefix
    $DCESuffix = $azureParameters.dceSuffix
}

Write-Host "Global Configuration:" -ForegroundColor White
Write-Host "  Resource Group: $ResourceGroupName" -ForegroundColor Gray
Write-Host "  Workspace: $WorkspaceName" -ForegroundColor Gray
Write-Host "  Location: $Location" -ForegroundColor Gray
Write-Host "  DCR Mode: $dcrMode" -ForegroundColor Cyan
Write-Host "  Processing Mode: $processingMode" -ForegroundColor Cyan
if ($CreateDCE) {
    Write-Host "  DCE Resource Group: $DCEResourceGroupName" -ForegroundColor Gray
}

# Install required modules (required even in template-only mode for schema retrieval)
Write-Host "Checking required PowerShell modules..." -ForegroundColor Yellow
try {
    $requiredModules = @("Az.OperationalInsights", "Az.Monitor", "Az.Resources")
    foreach ($module in $requiredModules) {
        if (!(Get-Module -ListAvailable $module)) {
            Write-Host "Installing $module..." -ForegroundColor Yellow
            Install-Module -Name $module -Repository PSGallery -Force -AllowClobber -Scope CurrentUser
            Write-Host "$module module installed" -ForegroundColor Green
        } else {
            Write-Host "$module module already available" -ForegroundColor Green
        }
    }
    
    if ($TemplateOnly) {
        Write-Host "Template-only mode: Azure modules required for schema retrieval" -ForegroundColor Yellow
    }
} catch {
    Write-Host "Failed to install modules: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

# Check for existing Azure session (required even in template-only mode for schema retrieval)
Write-Host "Checking Azure connection..." -ForegroundColor Yellow
try {
    $context = Get-AzContext -ErrorAction SilentlyContinue
    if (!$context) {
        Write-Host "❌ No Azure context found. Please run 'Connect-AzAccount' first." -ForegroundColor Red
        Write-Host "   This script requires an existing Azure session to proceed." -ForegroundColor Yellow
        exit 1
    } else {
        Write-Host "Found Azure context for: $($context.Account.Id)" -ForegroundColor Green
        Write-Host "  Subscription: $($context.Subscription.Name) ($($context.Subscription.Id))" -ForegroundColor Gray

        # Test if the context is still valid by making a simple API call
        Write-Host "  Testing context validity..." -ForegroundColor Gray
        try {
            $testSubscription = Get-AzSubscription -SubscriptionId $context.Subscription.Id -ErrorAction Stop | Out-Null
            Write-Host "  ✓ Context is valid" -ForegroundColor Green
        } catch {
            # Token is expired or invalid - try to refresh it
            Write-Host "  Token expired. Attempting automatic refresh..." -ForegroundColor Yellow

            try {
                # Try to refresh using existing context info without interactive prompts
                if ($context -and $context.Account -and $context.Account.Id) {
                    # For user accounts, try silent refresh
                    if ($context.Account.Type -ne 'ServicePrincipal') {
                        try {
                            # Try to get a new access token using the existing context
                            $token = Get-AzAccessToken -ResourceUrl "https://management.azure.com/" -ErrorAction Stop
                            if ($token -and $token.Token) {
                                Write-Host "  ✓ Token refreshed successfully" -ForegroundColor Green
                                # Test again to confirm
                                $testSubscription = Get-AzSubscription -SubscriptionId $context.Subscription.Id -ErrorAction Stop | Out-Null
                                Write-Host "  ✓ Context is now valid" -ForegroundColor Green
                            }
                        }
                        catch {
                            # Try Connect-AzAccount with account ID (should use cached credentials)
                            try {
                                $connectResult = Connect-AzAccount -AccountId $context.Account.Id -TenantId $context.Tenant.Id -Force -ErrorAction Stop -WarningAction SilentlyContinue
                                if ($connectResult) {
                                    # Ensure we're in the right subscription
                                    if ($context.Subscription.Id) {
                                        Set-AzContext -SubscriptionId $context.Subscription.Id -ErrorAction SilentlyContinue | Out-Null
                                    }
                                    Write-Host "  ✓ Azure connection refreshed successfully" -ForegroundColor Green
                                }
                            }
                            catch {
                                Write-Host "  ❌ Failed to refresh token automatically" -ForegroundColor Red
                                Write-Host "     Please run 'Connect-AzAccount' to refresh your session" -ForegroundColor Yellow
                                Write-Host "     Error: $($_.Exception.Message)" -ForegroundColor DarkGray
                                exit 1
                            }
                        }
                    } else {
                        # Service Principal - cannot refresh automatically
                        Write-Host "  ❌ Service Principal session expired. Please re-authenticate." -ForegroundColor Red
                        exit 1
                    }
                } else {
                    Write-Host "  ❌ Cannot refresh - insufficient context information" -ForegroundColor Red
                    Write-Host "     Please run 'Connect-AzAccount' to refresh your session" -ForegroundColor Yellow
                    exit 1
                }
            }
            catch {
                Write-Host "  ❌ Token refresh failed: $($_.Exception.Message)" -ForegroundColor Red
                Write-Host "     Please run 'Connect-AzAccount' to refresh your session" -ForegroundColor Yellow
                exit 1
            }
        }
    }

    if ($TemplateOnly) {
        Write-Host "Template-only mode: Using existing Azure session for schema retrieval" -ForegroundColor Yellow
    }
} catch {
    Write-Host "❌ Error checking Azure session: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "   Please ensure you have an active Azure session by running 'Connect-AzAccount'" -ForegroundColor Yellow
    exit 1
}

# Verify workspace (required even in template-only mode for schema retrieval)
Write-Host "Verifying Log Analytics workspace..." -ForegroundColor Yellow
Write-Host "  Resource Group: $ResourceGroupName" -ForegroundColor Gray
Write-Host "  Workspace Name: $WorkspaceName" -ForegroundColor Gray

# First check if the resource group exists
try {
    Write-Host "  Checking if resource group exists..." -ForegroundColor Gray
    $rg = Get-AzResourceGroup -Name $ResourceGroupName -ErrorAction Stop
    Write-Host "  ✓ Resource group found: $($rg.Location)" -ForegroundColor Green
} catch {
    Write-Host "  ✗ Resource group not found: $ResourceGroupName" -ForegroundColor Red
    Write-Host "  Error: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "" -ForegroundColor Red
    Write-Host "  Please verify your azure-parameters.json file contains the correct:" -ForegroundColor Yellow
    Write-Host "    - resourceGroupName" -ForegroundColor Yellow
    Write-Host "    - Ensure you're in the correct subscription" -ForegroundColor Yellow
    
    # List available resource groups
    Write-Host "" -ForegroundColor Yellow
    Write-Host "  Available resource groups in current subscription:" -ForegroundColor Yellow
    $availableRGs = Get-AzResourceGroup | Select-Object -First 10
    foreach ($availRg in $availableRGs) {
        Write-Host "    - $($availRg.ResourceGroupName)" -ForegroundColor Gray
    }
    if ((Get-AzResourceGroup).Count -gt 10) {
        Write-Host "    ... and $((Get-AzResourceGroup).Count - 10) more" -ForegroundColor DarkGray
    }
    exit 1
}

# Now check for the workspace
try {
    Write-Host "  Checking for workspace '$WorkspaceName' in resource group..." -ForegroundColor Gray
    $workspace = Get-AzOperationalInsightsWorkspace -ResourceGroupName $ResourceGroupName -Name $WorkspaceName -ErrorAction Stop
    Write-Host "  ✓ Workspace found: $($workspace.Name)" -ForegroundColor Green
    $workspaceResourceId = $workspace.ResourceId
    Write-Host "  Workspace ID: $workspaceResourceId" -ForegroundColor Gray
    
    if ($TemplateOnly) {
        Write-Host "Template-only mode: Workspace verified for schema retrieval" -ForegroundColor Yellow
    }
} catch {
    Write-Host "  ✗ Workspace not found: '$WorkspaceName' in resource group '$ResourceGroupName'" -ForegroundColor Red
    Write-Host "  Error: $($_.Exception.Message)" -ForegroundColor Red
    
    # List available workspaces in the resource group
    Write-Host "" -ForegroundColor Yellow
    Write-Host "  Checking for available workspaces in resource group '$ResourceGroupName':" -ForegroundColor Yellow
    try {
        $availableWorkspaces = Get-AzOperationalInsightsWorkspace -ResourceGroupName $ResourceGroupName -ErrorAction Stop
        if ($availableWorkspaces) {
            Write-Host "  Found $($availableWorkspaces.Count) workspace(s):" -ForegroundColor Yellow
            foreach ($ws in $availableWorkspaces) {
                Write-Host "    - $($ws.Name)" -ForegroundColor Gray
            }
        } else {
            Write-Host "  No workspaces found in this resource group" -ForegroundColor Red
        }
    } catch {
        Write-Host "  Could not list workspaces: $($_.Exception.Message)" -ForegroundColor Red
    }
    
    Write-Host "" -ForegroundColor Yellow
    Write-Host "  Please verify your azure-parameters.json file contains the correct:" -ForegroundColor Yellow
    Write-Host "    - resourceGroupName: $ResourceGroupName" -ForegroundColor Yellow  
    Write-Host "    - workspaceName: $WorkspaceName" -ForegroundColor Yellow
    exit 1
}

# Initialize summary tracking
$summary = @{
    DCRsProcessed = 0; DCRsCreated = 0; DCRsExisted = 0
    DCEsCreated = 0; DCEsExisted = 0; TablesValidated = 0
    TablesNotFound = 0; SchemasRetrieved = 0; ManualDeploymentRecommended = 0
    ProcessingFailures = @(); ManualDeploymentCases = @()
    CustomTablesCreated = 0; CustomTablesExisted = 0; CustomTablesFailed = 0
    CustomTablesMigrated = 0; TablesSkipped = 0
}

# Initialize Cribl configs collection - load existing if present
$script:allCriblConfigs = @()
if (-not $SkipCriblExport) {
    $criblConfigDir = Join-Path $ScriptDirectory "cribl-dcr-configs"
    $criblConfigPath = Join-Path $criblConfigDir "cribl-dcr-config.json"
    if (Test-Path $criblConfigPath) {
        try {
            Write-Host "Loading existing Cribl configuration..." -ForegroundColor Yellow
            $existingConfig = Get-Content $criblConfigPath -Raw | ConvertFrom-Json
            if ($existingConfig.DCRs) {
                $script:allCriblConfigs = @($existingConfig.DCRs)
                Write-Host "  Loaded $($script:allCriblConfigs.Count) existing DCR configurations" -ForegroundColor Green
            }
        } catch {
            Write-Warning "Could not load existing Cribl config: $($_.Exception.Message)"
        }
    }
}

# Create templates directory
$templatesDir = Join-Path $ScriptDirectory "generated-templates"
if (!(Test-Path $templatesDir)) {
    New-Item -ItemType Directory -Path $templatesDir -Force | Out-Null
    Write-Host "Created templates directory: $templatesDir" -ForegroundColor Green
}

# Process each table
Write-Host "`n$('='*80)" -ForegroundColor Cyan
if ($TemplateOnly) {
    Write-Host "GENERATING TEMPLATES ($dcrMode DCRs - $processingMode)" -ForegroundColor Cyan
} else {
    Write-Host "PROCESSING TABLES ($dcrMode DCRs - $processingMode)" -ForegroundColor Cyan
}
Write-Host "$('='*80)" -ForegroundColor Cyan

foreach ($tableName in $tableList) {
    $summary.DCRsProcessed++
    Write-Host "`n--- Processing: $tableName ---" -ForegroundColor Yellow
    
    try {
        # Handle custom table processing
        if ($CustomTableMode) {
            $customTableResult = Process-CustomTable `
                -TableName $tableName `
                -WorkspaceResourceId $workspaceResourceId `
                -SchemaDirectory $FullCustomTableSchemasPath `
                -RetentionDays $CustomTableRetentionDays `
                -TotalRetentionDays $CustomTableTotalRetentionDays `
                -MigrateExistingToDCR $MigrateCustomTablesToDCR `
                -AutoMigrate $AutoMigrateCustomTables
            
            if (-not $customTableResult.Success) {
                if ($customTableResult.Skipped) {
                    Write-Host "  ⏭️ Skipped custom table: $tableName (user choice)" -ForegroundColor Yellow
                    $summary.TablesSkipped++
                    continue
                } else {
                    Write-Host "  ❌ Failed to process custom table: $tableName" -ForegroundColor Red
                    $summary.CustomTablesFailed++
                    $summary.ProcessingFailures += "Failed to process custom table: $tableName - $($customTableResult.Error)"
                    continue
                }
            }
            
            if ($customTableResult.Source -eq "Created") {
                $summary.CustomTablesCreated++
            } elseif ($customTableResult.Source -eq "Azure") {
                $summary.CustomTablesExisted++
            }
            
            # Update table name to the actual name (with _CL suffix if custom)
            $actualTableName = $customTableResult.TableName
            $tableSchema = $customTableResult.Schema
            
            # For DCR naming, use the original table name without _CL suffix for brevity
            $dcrTableName = $tableName -replace '_CL$', ''
        } else {
            # Native table processing (existing logic)
            $actualTableName = $tableName
            $dcrTableName = $tableName
            
            # Retrieve table schema from Azure
            Write-Host "  Retrieving table schema from Azure..." -ForegroundColor Cyan
            $tableInfo = Get-LogAnalyticsTableSchema -WorkspaceResourceId $workspaceResourceId -TableName $tableName
            
            if ($tableInfo.Exists -ne $true) {
                Write-Host "  ❌ Table not found in Azure - cannot proceed without schema" -ForegroundColor Red
                $summary.TablesNotFound++
                $summary.ProcessingFailures += "Table not found in Azure: $tableName"
                continue
            }
            
            $tableSchema = $tableInfo.Schema
        }
        
        # Build DCR name using the appropriate table name
        $DCRName = "${DCRPrefix}${dcrTableName}-${Location}"
        if (![string]::IsNullOrWhiteSpace($DCRSuffix)) { $DCRName = "${DCRName}-${DCRSuffix}" }
        
        # Validate DCR name length (Azure limits differ by DCR type)
        $maxDCRNameLength = if ($CreateDCE) { 64 } else { 30 }  # Direct DCRs have stricter 30-char limit
        
        if ($DCRName.Length -gt $maxDCRNameLength) {
            Write-Host "  Warning: DCR name '$DCRName' ($($DCRName.Length) chars) exceeds $maxDCRNameLength character limit for $dcrMode DCRs" -ForegroundColor Yellow
            
            if ($CreateDCE) {
                # For DCE-based DCRs, truncate table name if needed
                $maxTableNameLength = $maxDCRNameLength - $DCRPrefix.Length - $Location.Length - 1
                if (![string]::IsNullOrWhiteSpace($DCRSuffix)) {
                    $maxTableNameLength = $maxTableNameLength - $DCRSuffix.Length - 1
                }
                
                $truncatedTableName = $dcrTableName.Substring(0, [Math]::Min($dcrTableName.Length, $maxTableNameLength))
                $DCRName = "${DCRPrefix}${truncatedTableName}-${Location}"
                if (![string]::IsNullOrWhiteSpace($DCRSuffix)) {
                    $DCRName = "${DCRName}-${DCRSuffix}"
                }
            } else {
                # For Direct DCRs, use abbreviated naming to fit 30-char limit
                $tableAbbrev = switch ($dcrTableName) {
                    'CommonSecurityLog' { 'CSL' }
                    'SecurityEvent' { 'SecEvt' }
                    'WindowsEvent' { 'WinEvt' }
                    'Syslog' { 'Syslog' }
                    'DeviceEvents' { 'DevEvt' }
                    'BehaviorAnalytics' { 'BehAna' }
                    default { 
                        # Generic abbreviation: take first 6 chars
                        $dcrTableName.Substring(0, [Math]::Min($dcrTableName.Length, 6))
                    }
                }
                
                $DCRName = "${DCRPrefix}${tableAbbrev}-${Location}"
                if (![string]::IsNullOrWhiteSpace($DCRSuffix)) {
                    $DCRName = "${DCRName}-${DCRSuffix}"
                }
                
                # Final check - if still too long, truncate further
                if ($DCRName.Length -gt 30) {
                    $DCRName = $DCRName.Substring(0, 30)
                    # Ensure doesn't end with hyphen
                    $DCRName = $DCRName.TrimEnd('-')
                }
            }
            
            Write-Host "  DCR name shortened to: $DCRName ($($DCRName.Length) chars)" -ForegroundColor Yellow
        }
        
        # Ensure DCR name meets Azure naming requirements
        $DCRName = $DCRName.Trim('-')  # Remove leading/trailing hyphens
        if ($DCRName.Length -lt 3) {
            throw "DCR name '$DCRName' is too short (minimum 3 characters required)"
        }
        
        Write-Host "  DCR Name: $DCRName" -ForegroundColor White
        Write-Host "  DCR Mode: $dcrMode" -ForegroundColor Cyan
        Write-Host "  Table Type: $(if ($CustomTableMode) { 'Custom' } else { 'Native' })" -ForegroundColor Cyan
        if ($CustomTableMode) {
            Write-Host "  Actual Table Name: $actualTableName" -ForegroundColor Gray
        }
        
        if ($TemplateOnly) {
            Write-Host "  Template-only mode: Skipping Azure resource checks" -ForegroundColor Yellow
        }
        
        # DCE handling (only if CreateDCE is true)
        $dceResourceId = $null
        if ($CreateDCE) {
            $DCEName = "${DCEPrefix}${dcrTableName}-${Location}"
            if (![string]::IsNullOrWhiteSpace($DCESuffix)) { $DCEName = "${DCEName}-${DCESuffix}" }
            
            Write-Host "  DCE Name: $DCEName" -ForegroundColor White
            
            if ($TemplateOnly) {
                # For template-only mode, create placeholder DCE resource ID
                $subscriptionId = "00000000-0000-0000-0000-000000000000"
                $dceResourceId = "/subscriptions/$subscriptionId/resourceGroups/$DCEResourceGroupName/providers/Microsoft.Insights/dataCollectionEndpoints/$DCEName"
                Write-Host "  Template-only mode: Using placeholder DCE ID" -ForegroundColor Yellow
            } else {
                # Verify or create DCE
                try {
                    $dce = Get-AzDataCollectionEndpoint -ResourceGroupName $DCEResourceGroupName -Name $DCEName -ErrorAction Stop
                    Write-Host "  ✓ DCE found: $($dce.Name)" -ForegroundColor Green
                    $dceResourceId = $dce.Id
                    $summary.DCEsExisted++
                } catch {
                    Write-Host "  Creating DCE..." -ForegroundColor Yellow
                    $dceParams = @{
                        ResourceGroupName = $DCEResourceGroupName; Name = $DCEName; Location = $Location
                        NetworkAclsPublicNetworkAccess = "Enabled"
                    }
                    $dce = New-AzDataCollectionEndpoint @dceParams -ErrorAction Stop
                    Write-Host "  ✅ DCE created: $($dce.Name)" -ForegroundColor Green
                    $dceResourceId = $dce.Id
                    $summary.DCEsCreated++
                }
            }
        }
        
        # Check if DCR already exists (skip in template-only mode)
        if (-not $TemplateOnly) {
            $existingDCR = Get-AzDataCollectionRule -ResourceGroupName $ResourceGroupName -Name $DCRName -ErrorAction SilentlyContinue
            if ($existingDCR) {
                Write-Host "  ✓ DCR already exists - skipping deployment" -ForegroundColor Yellow
                $summary.DCRsExisted++
                
                # Still capture Cribl config for existing DCRs
                if (-not $SkipCriblExport -or $ShowCriblConfig) {
                    Write-Host "  Capturing Cribl config for existing DCR..." -ForegroundColor Cyan
                    $criblConfig = Get-CriblConfigFromDCR -ResourceGroupName $ResourceGroupName -DCRName $DCRName -DCEResourceId $dceResourceId -TableName $dcrTableName
                    if ($criblConfig) {
                        if ($ShowCriblConfig) {
                            Show-CriblConfiguration -CriblConfig $criblConfig -TableName $actualTableName
                        }
                        
                        # Store for export (default behavior)
                        if (-not $SkipCriblExport) {
                            # Check if already in collection
                            $exists = $false
                            foreach ($cfg in $script:allCriblConfigs) {
                                if ($cfg.DCRName -eq $criblConfig.DCRName) {
                                    $exists = $true
                                    break
                                }
                            }
                            
                            if (-not $exists) {
                                if (-not $script:allCriblConfigs) { $script:allCriblConfigs = @() }
                                $script:allCriblConfigs += $criblConfig
                            }
                        }
                    }
                }
                
                continue
            }
        }
        
        # Process schema
        Write-Host "  Processing table schema..." -ForegroundColor Cyan
        
        if ($TemplateOnly) {
            Write-Host "  Template-only mode: Using schema from $(if ($CustomTableMode -and $customTableResult.Source -eq 'Created') { 'file' } else { 'Azure' })" -ForegroundColor Yellow
        }
        
        $summary.TablesValidated++
        $summary.SchemasRetrieved++
        $columns = Get-TableColumns -TableName $actualTableName -TableSchema $tableSchema
        
        if ($columns -eq $null -or $columns.Count -eq 0) {
            Write-Host "  ❌ Failed to process table schema - no valid columns found" -ForegroundColor Red
            Write-Host "    This usually means all columns were filtered out as system columns" -ForegroundColor Yellow
            Write-Host "    For custom tables, consider if the table has user-defined columns" -ForegroundColor Yellow
            if ($CustomTableMode) {
                Write-Host "    CloudFlare_CL should have columns like RayID, ClientIP, etc." -ForegroundColor Yellow
                Write-Host "    If table was just created, it might only have system columns" -ForegroundColor Yellow
                Write-Host "    Consider recreating the table with the schema file" -ForegroundColor Yellow
            }
            $summary.ProcessingFailures += "Failed to process schema for table: $actualTableName - no valid columns"
            continue
        }
        
        # Create deployment parameters
        $deploymentParameters = @{
            dataCollectionRuleName = @{ value = $DCRName }
            location = @{ value = $Location }
            workspaceResourceId = @{ value = $workspaceResourceId }
            tableName = @{ value = $actualTableName }
            columns = @{ value = $columns }
        }
        
        # Add DCE parameter if using DCE mode
        if ($CreateDCE) { $deploymentParameters.endpointResourceId = @{ value = $dceResourceId } }
        
        # Save template
        $timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        $templatePath = Join-Path $templatesDir "$dcrTableName-$timestamp.json"
        $latestTemplatePath = Join-Path $templatesDir "$dcrTableName-latest.json"
        
        # Define the hardcoded stream names
        # For custom tables, BOTH streams must use "Custom-" prefix
        # For native tables, input uses "Custom-", output uses "Microsoft-"
        if ($CustomTableMode) {
            $streamName = "Custom-$actualTableName"
            $outputStreamName = "Custom-$actualTableName"  # Custom tables use Custom- for output too!
        } else {
            $streamName = "Custom-$actualTableName"
            $outputStreamName = "Microsoft-$actualTableName"  # Native tables use Microsoft- for output
        }
        
        if ($TemplateOnly) {
            # For template-only mode, create a complete standalone ARM template with columns embedded
            # Deep copy the template by converting to JSON and back
            $templateJsonCopy = $dcrTemplate | ConvertTo-Json -Depth 15
            $standaloneTemplate = $templateJsonCopy | ConvertFrom-Json
            
            # Replace variable references with hardcoded stream names
            # First, update the streamDeclarations to use hardcoded stream name
            if ($standaloneTemplate.resources -and $standaloneTemplate.resources[0].properties.streamDeclarations) {
                # Convert streamDeclarations to JSON string, replace variable references, then convert back
                $streamDeclarationsJson = $standaloneTemplate.resources[0].properties.streamDeclarations | ConvertTo-Json -Depth 10
                $streamDeclarationsJson = $streamDeclarationsJson.Replace('[variables(''streamName'')]', $streamName)
                $standaloneTemplate.resources[0].properties.streamDeclarations = $streamDeclarationsJson | ConvertFrom-Json
                
                # Now inject the actual columns
                if ($standaloneTemplate.resources[0].properties.streamDeclarations.$streamName) {
                    $standaloneTemplate.resources[0].properties.streamDeclarations.$streamName.columns = $columns
                } else {
                    # Create the stream declaration if it doesn't exist
                    $standaloneTemplate.resources[0].properties.streamDeclarations | Add-Member -MemberType NoteProperty -Name $streamName -Value @{ columns = $columns }
                }
            }
            
            # Update dataFlows to use hardcoded stream names
            if ($standaloneTemplate.resources -and $standaloneTemplate.resources[0].properties.dataFlows) {
                foreach ($dataFlow in $standaloneTemplate.resources[0].properties.dataFlows) {
                    # Replace streams array with hardcoded stream name
                    if ($dataFlow.streams) {
                        $dataFlow.streams = @($streamName)
                    }
                    # Replace outputStream with hardcoded output stream name
                    if ($dataFlow.outputStream) {
                        $dataFlow.outputStream = $outputStreamName
                    }
                }
            }
            
            # Remove or comment out the variables section since we're not using them
            if ($standaloneTemplate.variables) {
                # Instead of removing, we'll keep them as documentation but they won't be used
                $standaloneTemplate.variables = @{
                    streamName = $streamName
                    outputStreamName = $outputStreamName
                    '_comment' = 'These variables are hardcoded in the template and not used via variable references'
                }
            }
            
            # Remove table name and columns parameters (not needed since we embed them)
            if ($standaloneTemplate.parameters.tableName) {
                $standaloneTemplate.parameters.PSObject.Properties.Remove('tableName')
            }
            if ($standaloneTemplate.parameters.columns) {
                $standaloneTemplate.parameters.PSObject.Properties.Remove('columns')
            }
            
            # Update parameters to have default values for easier deployment
            if ($standaloneTemplate.parameters.dataCollectionRuleName) {
                $standaloneTemplate.parameters.dataCollectionRuleName | Add-Member -MemberType NoteProperty -Name "defaultValue" -Value $DCRName -Force
            }
            if ($standaloneTemplate.parameters.location) {
                $standaloneTemplate.parameters.location | Add-Member -MemberType NoteProperty -Name "defaultValue" -Value $Location -Force
            }
            
            # Set resource IDs to blank by default for template-only mode
            if ($standaloneTemplate.parameters.workspaceResourceId) {
                $standaloneTemplate.parameters.workspaceResourceId | Add-Member -MemberType NoteProperty -Name "defaultValue" -Value "" -Force
            }
            
            if ($CreateDCE -and $standaloneTemplate.parameters.endpointResourceId) {
                $standaloneTemplate.parameters.endpointResourceId | Add-Member -MemberType NoteProperty -Name "defaultValue" -Value "" -Force
            }
            
            $templateJson = $standaloneTemplate | ConvertTo-Json -Depth 15
        } else {
            # For deployment mode, also create a standalone template with hardcoded values
            # Deep copy the template
            $templateJsonCopy = $dcrTemplate | ConvertTo-Json -Depth 15
            $deploymentTemplate = $templateJsonCopy | ConvertFrom-Json
            
            # Replace variable references with hardcoded stream names in streamDeclarations
            if ($deploymentTemplate.resources -and $deploymentTemplate.resources[0].properties.streamDeclarations) {
                # Convert to JSON, replace variable references, convert back
                $streamDeclarationsJson = $deploymentTemplate.resources[0].properties.streamDeclarations | ConvertTo-Json -Depth 10
                $streamDeclarationsJson = $streamDeclarationsJson.Replace('[variables(''streamName'')]', $streamName)
                $deploymentTemplate.resources[0].properties.streamDeclarations = $streamDeclarationsJson | ConvertFrom-Json
                
                # Inject columns
                if ($deploymentTemplate.resources[0].properties.streamDeclarations.$streamName) {
                    $deploymentTemplate.resources[0].properties.streamDeclarations.$streamName.columns = $columns
                } else {
                    $deploymentTemplate.resources[0].properties.streamDeclarations | Add-Member -MemberType NoteProperty -Name $streamName -Value @{ columns = $columns }
                }
            }
            
            # Update dataFlows to use hardcoded stream names
            if ($deploymentTemplate.resources -and $deploymentTemplate.resources[0].properties.dataFlows) {
                foreach ($dataFlow in $deploymentTemplate.resources[0].properties.dataFlows) {
                    if ($dataFlow.streams) {
                        $dataFlow.streams = @($streamName)
                    }
                    if ($dataFlow.outputStream) {
                        $dataFlow.outputStream = $outputStreamName
                    }
                }
            }
            
            # Update variables section to show the hardcoded values
            if ($deploymentTemplate.variables) {
                $deploymentTemplate.variables = @{
                    streamName = $streamName
                    outputStreamName = $outputStreamName
                    '_comment' = 'These values are hardcoded in the template'
                }
            }
            
            # Remove tableName and columns parameters since we're embedding them
            if ($deploymentTemplate.parameters.tableName) {
                $deploymentTemplate.parameters.PSObject.Properties.Remove('tableName')
            }
            if ($deploymentTemplate.parameters.columns) {
                $deploymentTemplate.parameters.PSObject.Properties.Remove('columns')
            }
            
            # Add deployment-specific metadata
            $deploymentTemplate | Add-Member -MemberType NoteProperty -Name "metadata" -Value @{
                deploymentMode = $dcrMode
                tableName = $actualTableName
                tableType = if ($CustomTableMode) { "Custom" } else { "Native" }
                generatedOn = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
                streamName = $streamName
                outputStreamName = $outputStreamName
            } -Force
            
            $templateJson = $deploymentTemplate | ConvertTo-Json -Depth 15
        }
        
        $templateJson | Set-Content -Path $templatePath -Encoding UTF8
        $templateJson | Set-Content -Path $latestTemplatePath -Encoding UTF8
        
        Write-Host "  Template saved: $dcrTableName-$timestamp.json" -ForegroundColor Gray
        Write-Host "  Latest template: $dcrTableName-latest.json" -ForegroundColor Gray
        Write-Host "  Stream names hardcoded:" -ForegroundColor Cyan
        Write-Host "    Input stream: $streamName" -ForegroundColor Gray
        Write-Host "    Output stream: $outputStreamName" -ForegroundColor Gray
        if ($CustomTableMode) {
            Write-Host "    Note: Custom tables require 'Custom-' prefix for both streams" -ForegroundColor Yellow
        }
        if ($TemplateOnly) {
            Write-Host "  Template is standalone: columns embedded, resource IDs blank by default" -ForegroundColor Yellow
        }
        
        # Cleanup old templates
        if ($CleanupOldTemplates) {
            Invoke-TemplateCleanup -TemplatesDirectory $templatesDir -TableName $dcrTableName -KeepVersions $KeepTemplateVersions
        }
        
        # Analyze template
        $templateSize = $templateJson.Length
        $recommendation = Get-TemplateDeploymentRecommendation -TableSchema $tableSchema -TableName $actualTableName -TemplateSize $templateSize
        
        Write-Host "  Template Analysis:" -ForegroundColor Cyan
        Write-Host "    Size: $([math]::Round($templateSize/1024, 1)) KB" -ForegroundColor Gray
        Write-Host "    Columns: $($columns.Count)" -ForegroundColor Gray
        Write-Host "    Complexity: $($recommendation.EstimatedComplexity)" -ForegroundColor Gray
        
        # Check deployment recommendation
        if (-not $recommendation.ShouldDeploy) {
            Write-Host "  ❌ Automatic deployment not recommended" -ForegroundColor Red
            $summary.ManualDeploymentRecommended++
            $summary.ManualDeploymentCases += @{
                TableName = $actualTableName; Reason = $recommendation.Reason
                TemplatePath = $templatePath; DCRName = $DCRName
            }
            Show-ManualDeploymentInstructions -TableName $actualTableName -TemplatePath $templatePath -DCRName $DCRName -ResourceGroupName $ResourceGroupName -Location $Location -WorkspaceResourceId $workspaceResourceId -EndpointResourceId $dceResourceId -Reason $recommendation.Reason -UseDCE $CreateDCE
            continue
        }
        
        # Validate template structure
        Write-Host "  Validating template structure..." -ForegroundColor Cyan
        try {
            $validateTemplate = Get-Content $templatePath | ConvertFrom-Json
            
            # Check required sections
            $requiredSections = @('$schema', 'contentVersion', 'parameters', 'resources')
            foreach ($section in $requiredSections) {
                if (-not $validateTemplate.$section) {
                    throw "Missing required ARM template section: $section"
                }
            }
            
            # Check resource structure
            if ($validateTemplate.resources.Count -eq 0) {
                throw "No resources defined in ARM template"
            }
            
            $resource = $validateTemplate.resources[0]
            if (-not $resource.type -or -not $resource.apiVersion -or -not $resource.name -or -not $resource.location) {
                throw "Resource missing required properties (type, apiVersion, name, location)"
            }
            
            Write-Host "  ✅ Template validation passed" -ForegroundColor Green
            
        } catch {
            Write-Host "  ❌ Template validation failed: $($_.Exception.Message)" -ForegroundColor Red
            $summary.ProcessingFailures += "Template validation failed for ${actualTableName}: $($_.Exception.Message)"
            continue
        }
        
        # Deploy DCR (skip in template-only mode)
        if ($TemplateOnly) {
            Write-Host "  ✅ Template generated successfully (template-only mode)" -ForegroundColor Green
            Write-Host "  Template location: $latestTemplatePath" -ForegroundColor Cyan
        } else {
            Write-Host "  Deploying $dcrMode DCR using generated template..." -ForegroundColor Cyan
        
        $deploymentName = "dcr-$($dcrMode.ToLower())-$(Get-Date -Format 'yyyyMMdd-HHmmss')-$dcrTableName"
        if ($deploymentName.Length -gt 64) {
            $deploymentName = $deploymentName.Substring(0, 64)
        }
        
        try {
            # Use the generated template with hardcoded values for deployment
            # Build deployment parameters - only need to pass the remaining parameters
            $deployParams = @{
                ResourceGroupName = $ResourceGroupName
                Name = $deploymentName
                TemplateFile = $latestTemplatePath  # Use the generated template with hardcoded values
                dataCollectionRuleName = $DCRName
                location = $Location
                workspaceResourceId = $workspaceResourceId
                ErrorAction = "Stop"
            }
            
            # Add DCE parameter if using DCE mode
            if ($CreateDCE) { 
                $deployParams.endpointResourceId = $dceResourceId 
            }
            
            $deploymentResult = New-AzResourceGroupDeployment @deployParams
                
            if ($deploymentResult.ProvisioningState -eq "Succeeded") {
                Write-Host "  ✅ $dcrMode DCR deployed successfully!" -ForegroundColor Green
                $summary.DCRsCreated++
                
                if ($deploymentResult.Outputs -and $deploymentResult.Outputs.dataCollectionRuleId) {
                    $dcrId = $deploymentResult.Outputs.dataCollectionRuleId.Value
                    Write-Host "  DCR Resource ID: $dcrId" -ForegroundColor Gray
                }
                
                # Retrieve and display Cribl configuration (default behavior unless skipped)
                if (-not $SkipCriblExport -or $ShowCriblConfig) {
                    $criblConfig = Get-CriblConfigFromDCR -ResourceGroupName $ResourceGroupName -DCRName $DCRName -DCEResourceId $dceResourceId -TableName $dcrTableName
                    if ($criblConfig) {
                        if ($ShowCriblConfig) {
                            Show-CriblConfiguration -CriblConfig $criblConfig -TableName $actualTableName
                        }
                        
                        # Store for export (default behavior)
                        if (-not $SkipCriblExport) {
                            if (-not $script:allCriblConfigs) { $script:allCriblConfigs = @() }
                            $script:allCriblConfigs += $criblConfig
                        }
                    }
                }
            } else {
                throw "Deployment failed with state: $($deploymentResult.ProvisioningState)"
            }
            
        } catch {
            $deploymentError = $_.Exception.Message
            
            # Enhanced error analysis
            if ($deploymentError -like "*InvalidTemplateDeployment*") {
                Write-Host "  ❌ Template deployment validation failed" -ForegroundColor Red
                
                # Try to get detailed error information
                try {
                    Start-Sleep -Seconds 2
                    $deployment = Get-AzResourceGroupDeployment -ResourceGroupName $ResourceGroupName -Name $deploymentName -ErrorAction SilentlyContinue
                    if ($deployment -and $deployment.StatusMessage) {
                        try {
                            $statusObj = $deployment.StatusMessage | ConvertFrom-Json
                            if ($statusObj.error -and $statusObj.error.message) {
                                Write-Host "  Error Details: $($statusObj.error.message)" -ForegroundColor Red
                                if ($statusObj.error.details) {
                                    foreach ($detail in $statusObj.error.details) {
                                        Write-Host "    - $($detail.message)" -ForegroundColor Red
                                    }
                                }
                            }
                        } catch {
                            Write-Host "  Raw Status: $($deployment.StatusMessage)" -ForegroundColor Red
                        }
                    }
                } catch {
                    Write-Host "  Could not retrieve detailed error information" -ForegroundColor Yellow
                }
                
                # Recommend manual deployment for complex failures
                Write-Host "  💡 Recommendation: Deploy manually through Azure Portal for better error diagnostics" -ForegroundColor Cyan
                $summary.ManualDeploymentRecommended++
                $summary.ManualDeploymentCases += @{
                    TableName = $actualTableName; Reason = "PowerShell deployment failed - $deploymentError"
                    TemplatePath = $templatePath; DCRName = $DCRName
                }
                Show-ManualDeploymentInstructions -TableName $actualTableName -TemplatePath $latestTemplatePath -DCRName $DCRName -ResourceGroupName $ResourceGroupName -Location $Location -WorkspaceResourceId $workspaceResourceId -EndpointResourceId $dceResourceId -Reason "PowerShell deployment failed with template validation error" -UseDCE $CreateDCE
                continue
            }
            
            Write-Host "  ❌ Deployment failed: $deploymentError" -ForegroundColor Red
            $summary.ManualDeploymentRecommended++
            $summary.ManualDeploymentCases += @{
                TableName = $actualTableName; Reason = "PowerShell deployment failed"
                TemplatePath = $templatePath; DCRName = $DCRName
            }
            Show-ManualDeploymentInstructions -TableName $actualTableName -TemplatePath $latestTemplatePath -DCRName $DCRName -ResourceGroupName $ResourceGroupName -Location $Location -WorkspaceResourceId $workspaceResourceId -EndpointResourceId $dceResourceId -Reason "PowerShell deployment failed" -UseDCE $CreateDCE
            continue
        }
        }
        
        Write-Host "  ✅ Completed: $actualTableName" -ForegroundColor Green
        
    } catch {
        $exceptionMessage = $_.Exception.Message
        Write-Host "  ❌ Exception processing ${tableName}: $exceptionMessage" -ForegroundColor Red
        $summary.ProcessingFailures += "Exception processing ${tableName}: $exceptionMessage"
    }
}

# Template Management Summary
Write-Host "`nTemplate Management..." -ForegroundColor Yellow
if (Test-Path $templatesDir) {
    $allTemplates = Get-ChildItem -Path $templatesDir -Filter "*.json" | Sort-Object Name
    $latestTemplates = $allTemplates | Where-Object { $_.Name -like "*-latest.json" }
    $timestampedTemplates = $allTemplates | Where-Object { $_.Name -notlike "*-latest.json" }
    
    Write-Host "Templates directory: $templatesDir" -ForegroundColor Cyan
    Write-Host "Total templates: $($allTemplates.Count) ($($latestTemplates.Count) latest, $($timestampedTemplates.Count) archived)" -ForegroundColor Gray
    
    if ($summary.ManualDeploymentRecommended -gt 0) {
        Write-Host "`nManual deployment templates:" -ForegroundColor White
        foreach ($case in $summary.ManualDeploymentCases) {
            $latestPath = Join-Path $templatesDir "$($case.TableName)-latest.json"
            Write-Host "  - $($case.TableName): $latestPath" -ForegroundColor Gray
        }
    }
    
    Write-Host "`nTemplate Usage:" -ForegroundColor Cyan
    Write-Host "  Latest templates: Use *-latest.json files for current deployments" -ForegroundColor Gray
    Write-Host "  Archived templates: Timestamped versions for version control" -ForegroundColor Gray
    Write-Host "  Manual deployment: Copy template content to Azure Portal or use Azure CLI" -ForegroundColor Gray
}

# Display final summary
Write-Host "`n$('='*80)" -ForegroundColor Cyan
if ($TemplateOnly) {
    Write-Host "TEMPLATE GENERATION SUMMARY ($dcrMode DCRs - $processingMode)" -ForegroundColor Cyan
} else {
    Write-Host "EXECUTION SUMMARY ($dcrMode DCRs - $processingMode)" -ForegroundColor Cyan
}
Write-Host "$('='*80)" -ForegroundColor Cyan

Write-Host "Results:" -ForegroundColor White
Write-Host "  DCRs Processed: $($summary.DCRsProcessed)" -ForegroundColor Gray
Write-Host "  DCRs Created: $($summary.DCRsCreated)" -ForegroundColor Green
Write-Host "  DCRs Already Existed: $($summary.DCRsExisted)" -ForegroundColor Yellow
Write-Host "  DCR Mode: $dcrMode" -ForegroundColor Cyan
Write-Host "  Processing Mode: $processingMode" -ForegroundColor Cyan

if ($CustomTableMode) {
    Write-Host "`nCustom Table Results:" -ForegroundColor White
    Write-Host "  Tables Created: $($summary.CustomTablesCreated)" -ForegroundColor Green
    Write-Host "  Tables Already Existed: $($summary.CustomTablesExisted)" -ForegroundColor Yellow
    Write-Host "  Tables Skipped: $($summary.TablesSkipped)" -ForegroundColor Yellow
    Write-Host "  Tables Failed: $($summary.CustomTablesFailed)" -ForegroundColor Red
}

if ($CreateDCE) {
    Write-Host "  DCEs Created: $($summary.DCEsCreated)" -ForegroundColor Green
    Write-Host "  DCEs Already Existed: $($summary.DCEsExisted)" -ForegroundColor Yellow
}
Write-Host "  Manual Deployment Recommended: $($summary.ManualDeploymentRecommended)" -ForegroundColor Cyan

if ($summary.ManualDeploymentRecommended -gt 0) {
    Write-Host "`nManual Deployment Cases:" -ForegroundColor Cyan
    foreach ($case in $summary.ManualDeploymentCases) {
        Write-Host "  - $($case.TableName): $($case.Reason)" -ForegroundColor Yellow
    }
}

if ($summary.ProcessingFailures.Count -gt 0) {
    Write-Host "`nProcessing Failures:" -ForegroundColor Red
    foreach ($failure in $summary.ProcessingFailures) {
        Write-Host "  - $failure" -ForegroundColor Red
    }
}

# Export Cribl configuration (default behavior unless explicitly skipped)
if (-not $SkipCriblExport -and $script:allCriblConfigs -and $script:allCriblConfigs.Count -gt 0) {
    # Create cribl-dcr-configs directory if it doesn't exist
    $criblConfigDir = Join-Path $ScriptDirectory "cribl-dcr-configs"
    if (-not (Test-Path $criblConfigDir)) {
        New-Item -ItemType Directory -Path $criblConfigDir -Force | Out-Null
        Write-Host "  Created directory: cribl-dcr-configs" -ForegroundColor Gray
    }
    $exportPath = Join-Path $criblConfigDir "cribl-dcr-config.json"
    
    # Remove duplicates based on DCRName (in case of multiple runs)
    $uniqueDCRs = @{}
    foreach ($dcr in $script:allCriblConfigs) {
        if ($dcr.DCRName -and -not $uniqueDCRs.ContainsKey($dcr.DCRName)) {
            $uniqueDCRs[$dcr.DCRName] = $dcr
        }
    }
    $finalDCRs = $uniqueDCRs.Values | Sort-Object DCRName
    
    $exportData = @{
        GeneratedAt = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
        Purpose = "Cribl Stream Integration with Azure Log Analytics"
        ResourceGroup = $ResourceGroupName
        Workspace = $WorkspaceName
        DCRCount = $finalDCRs.Count
        DCRs = $finalDCRs
    }
    
    $exportData | ConvertTo-Json -Depth 10 | Set-Content $exportPath
    Write-Host "`n📦 Cribl configuration automatically exported to: cribl-dcr-configs\cribl-dcr-config.json" -ForegroundColor Green
    Write-Host "   Total unique DCRs in config: $($finalDCRs.Count)" -ForegroundColor Gray
    Write-Host "   (Use -SkipCriblExport to disable automatic export)" -ForegroundColor Gray
    
    # Generate Cribl destination configuration files
    Write-Host "`n🔧 Generating Cribl Sentinel destination configurations..." -ForegroundColor Cyan
    $genScript = Join-Path $ScriptDirectory "Generate-CriblDestinations.ps1"
    if (Test-Path $genScript) {
        try {
            & $genScript -CriblConfigFile "cribl-dcr-configs\cribl-dcr-config.json" | Out-Null
            Write-Host "✅ Cribl destination configs generated in: cribl-dcr-configs\destinations\" -ForegroundColor Green
        } catch {
            Write-Warning "Could not generate Cribl destination configs: $($_.Exception.Message)"
        }
    }
} elseif ($SkipCriblExport) {
    Write-Host "`n⏭️ Cribl configuration export skipped (as requested)" -ForegroundColor Yellow
} elseif ($script:allCriblConfigs.Count -eq 0) {
    Write-Host "`n⚠️ No DCR configurations to export" -ForegroundColor Yellow
}

Write-Host "`nNext Steps:" -ForegroundColor Cyan
if ($summary.ManualDeploymentRecommended -gt 0) {
    Write-Host "1. Use Azure Portal for manual deployments (better reporting)" -ForegroundColor Yellow
    Write-Host "2. Templates saved in generated-templates directory" -ForegroundColor Gray
    Write-Host "3. Navigate to: https://portal.azure.com -> Deploy a custom template" -ForegroundColor Gray
    Write-Host "4. Upload the *-latest.json files from the generated-templates directory" -ForegroundColor Gray
} else {
    Write-Host "✅ All $dcrMode DCRs deployed successfully! Templates saved for future reference." -ForegroundColor Green
}

Write-Host "`n🔗 Cribl Integration:" -ForegroundColor Cyan
Write-Host "1. Retrieve DCR configuration: from cribl-dcr-configs directory" -ForegroundColor Gray
Write-Host "2. Configure Cribl Sentinel destination with DCR immutable ID and ingestion URL" -ForegroundColor Gray
Write-Host "3. Set up Azure AD App Registration for authentication" -ForegroundColor Gray
Write-Host "4. Grant 'Monitoring Metrics Publisher' role to App on DCRs" -ForegroundColor Gray

if ($CustomTableMode) {
    Write-Host "`n💡 Custom Table Mode Tips:" -ForegroundColor Cyan
    Write-Host "- Schema files should be placed in: $FullCustomTableSchemasPath" -ForegroundColor Gray
    Write-Host "- Custom tables automatically get '_CL' suffix added" -ForegroundColor Gray
    Write-Host "- See SampleTable_CL.json.sample for schema format" -ForegroundColor Gray
} else {
    Write-Host "`n💡 To process custom tables, set 'customTableSettings.enabled' to true in operation-parameters.json" -ForegroundColor Cyan
}

Write-Host "💡 To switch DCR modes, change 'createDCE' in operation-parameters.json" -ForegroundColor Cyan
Write-Host "`nScript completed! 🎉" -ForegroundColor Cyan

# Usage examples for Cribl integration:
# .\Create-TableDCRs.ps1                                                    # Default: Auto-exports Cribl config
# .\Create-TableDCRs.ps1 -ShowCriblConfig                                  # Display + export Cribl config
# .\Create-TableDCRs.ps1 -SkipCriblExport                                  # Deploy without Cribl export
# .\Get-CriblDCRInfo.ps1                                                   # Retrieve existing DCR info for Cribl
# .\Create-TableDCRs.ps1 -CustomTableMode                                   # Process custom tables
# .\Create-TableDCRs.ps1 -CustomTableMode -TemplateOnly                     # Generate templates for custom tables
# .\Create-TableDCRs.ps1 -IgnoreOperationParameters                        # Uses only command-line parameters
# .\Create-TableDCRs.ps1 -TemplateOnly                                     # Template-only mode: generates ARM templates without deploying
# .\Create-TableDCRs.ps1 -SpecificDCR "SecurityEvent"                     # Process specific table only
# .\Create-TableDCRs.ps1 -CreateDCE:$false                                 # Force Direct DCRs
# .\Create-TableDCRs.ps1 -CreateDCE                                        # Force DCE-based DCRs
# .\Create-TableDCRs.ps1 -CleanupOldTemplates -KeepTemplateVersions 3     # Override: cleanup old templates
# .\Create-TableDCRs.ps1 -AzureParametersFile "prod-azure.json"          # Use custom Azure parameters file
# .\Create-TableDCRs.ps1 -OperationParametersFile "custom-ops.json"      # Use custom operation parameters file