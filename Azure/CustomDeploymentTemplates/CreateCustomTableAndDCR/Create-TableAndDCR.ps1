# Create Azure Log Analytics Custom Tables and Data Collection Rules
# Run this script from VSCode terminal or PowerShell
# This script will process all table schema files in the table-schemas directory

param(
    [Parameter(Mandatory=$false)]
    [string]$ParametersFile = "parameters.json",
    
    [Parameter(Mandatory=$false)]
    [string]$SchemasDirectory = "table-schemas",
    
    [Parameter(Mandatory=$false)]
    [string]$SpecificTable = ""
)

# Get the directory where this script is located
$ScriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Definition

# Build full paths
$FullParametersPath = Join-Path $ScriptDirectory $ParametersFile
$FullSchemasPath = Join-Path $ScriptDirectory $SchemasDirectory

Write-Host "Starting Azure Log Analytics tables and DCRs creation process..." -ForegroundColor Cyan
Write-Host "Script directory: $ScriptDirectory" -ForegroundColor Gray
Write-Host "Schemas directory: $FullSchemasPath" -ForegroundColor Gray

# Load parameters from JSON file
Write-Host "Loading parameters from: $FullParametersPath" -ForegroundColor Yellow
try {
    if (!(Test-Path $FullParametersPath)) {
        throw "Parameters file not found: $FullParametersPath"
    }
    $parameters = Get-Content $FullParametersPath | ConvertFrom-Json
    Write-Host "Parameters loaded successfully" -ForegroundColor Green
} catch {
    Write-Error "Failed to load parameters: $($_.Exception.Message)"
    exit 1
}

# Get all JSON schema files from the schemas directory
Write-Host "Scanning for table schema files..." -ForegroundColor Yellow
try {
    if (!(Test-Path $FullSchemasPath)) {
        throw "Schemas directory not found: $FullSchemasPath"
    }
    
    $schemaFiles = Get-ChildItem -Path $FullSchemasPath -Filter "*.json" | Where-Object { !$_.PSIsContainer }
    
    if ($SpecificTable) {
        $schemaFiles = $schemaFiles | Where-Object { $_.BaseName -eq $SpecificTable }
        if ($schemaFiles.Count -eq 0) {
            throw "No schema file found for table: $SpecificTable"
        }
        Write-Host "Processing specific table: $SpecificTable" -ForegroundColor Green
    } else {
        Write-Host "Found $($schemaFiles.Count) table schema files" -ForegroundColor Green
    }
    
    if ($schemaFiles.Count -eq 0) {
        throw "No JSON schema files found in: $FullSchemasPath"
    }
    
} catch {
    Write-Error "Failed to scan schema files: $($_.Exception.Message)"
    exit 1
}

# Extract common parameters
$ResourceGroupName = $parameters.resourceGroupName
$WorkspaceName = $parameters.workspaceName
$DCRPrefix = $parameters.dcrPrefix
$DCRSuffix = $parameters.dcrSuffix
$Location = $parameters.location

Write-Host "Global Configuration:" -ForegroundColor White
Write-Host "  Resource Group: $ResourceGroupName" -ForegroundColor Gray
Write-Host "  Workspace: $WorkspaceName" -ForegroundColor Gray
Write-Host "  DCR Prefix: $DCRPrefix" -ForegroundColor Gray
if (![string]::IsNullOrWhiteSpace($DCRSuffix)) {
    Write-Host "  DCR Suffix: $DCRSuffix" -ForegroundColor Gray
}
Write-Host "  Location: $Location" -ForegroundColor Gray

# Install required modules
Write-Host "Checking and installing required PowerShell modules..." -ForegroundColor Yellow
try {
    $requiredModules = @("Az.OperationalInsights", "Az.Monitor")
    foreach ($module in $requiredModules) {
        if (!(Get-Module -ListAvailable $module)) {
            Install-Module -Name $module -Repository PSGallery -Force -AllowClobber -Scope CurrentUser
            Write-Host "$module module installed" -ForegroundColor Green
        } else {
            Write-Host "$module module already installed" -ForegroundColor Green
        }
    }
} catch {
    Write-Error "Failed to install modules: $($_.Exception.Message)"
    exit 1
}

# Login to Azure
Write-Host "Logging into Azure..." -ForegroundColor Yellow
try {
    $context = Get-AzContext
    if (!$context) {
        Connect-AzAccount
        Write-Host "Successfully logged into Azure" -ForegroundColor Green
    } else {
        Write-Host "Already logged into Azure as: $($context.Account.Id)" -ForegroundColor Green
    }
} catch {
    Write-Error "Failed to login to Azure: $($_.Exception.Message)"
    exit 1
}

# Verify workspace exists
Write-Host "Verifying Log Analytics workspace..." -ForegroundColor Yellow
try {
    $workspace = Get-AzOperationalInsightsWorkspace -ResourceGroupName $ResourceGroupName -Name $WorkspaceName -ErrorAction Stop
    Write-Host "Workspace found: $($workspace.Name)" -ForegroundColor Green
    $workspaceResourceId = $workspace.ResourceId
} catch {
    Write-Error "Workspace not found: $($_.Exception.Message)"
    exit 1
}

# Get access token for REST API (used for all table creations)
$token = [Microsoft.Azure.Commands.Common.Authentication.AzureSession]::Instance.AuthenticationFactory.Authenticate($context.Account, $context.Environment, $context.Tenant.Id, $null, $null, $null, 'https://management.azure.com/').AccessToken
$subscriptionId = $context.Subscription.Id

$headers = @{
    'Authorization' = "Bearer $token"
    'Content-Type' = 'application/json'
}

# Initialize summary tracking
$summary = @{
    TablesProcessed = 0
    TablesCreated = 0
    TablesExisted = 0
    DCRsCreated = 0
    DCRsExisted = 0
    Errors = @()
}

# Process each table schema file
Write-Host "`n" + "="*80 -ForegroundColor Cyan
Write-Host "PROCESSING TABLE SCHEMAS" -ForegroundColor Cyan
Write-Host "="*80 -ForegroundColor Cyan

foreach ($schemaFile in $schemaFiles) {
    $summary.TablesProcessed++
    
    Write-Host "`n--- Processing: $($schemaFile.Name) ---" -ForegroundColor Yellow
    
    try {
        # Load and parse schema file
        $schemaData = Get-Content $schemaFile.FullName | ConvertFrom-Json
        
        # Get table name and retention from schema (with fallback to parameters)
        $TableName = if ($schemaData.tableName) { $schemaData.tableName } else { $schemaFile.BaseName }
        $RetentionDays = if ($schemaData.retentionDays) { $schemaData.retentionDays } else { $parameters.retentionDays }
        
        # Ensure table name ends with _CL
        if (-not $TableName.EndsWith("_CL")) {
            $TableName = "${TableName}_CL"
        }
        
        # Convert columns to hashtables
        $columnList = New-Object System.Collections.Generic.List[hashtable]
        foreach ($column in $schemaData.columns) {
            $columnHashtable = @{
                name = [string]$column.name
                type = [string]$column.type
            }
            $columnList.Add($columnHashtable)
        }
        $columns = $columnList.ToArray()
        
        # Build DCR name
        $BaseTableName = $TableName -replace '_CL$', ''
        $DCRName = "${DCRPrefix}${BaseTableName}-${Location}"
        if (![string]::IsNullOrWhiteSpace($DCRSuffix)) {
            $DCRName = "${DCRName}-${DCRSuffix}"
        }
        
        Write-Host "  Table: $TableName ($($columns.Count) columns, $RetentionDays days retention)" -ForegroundColor White
        Write-Host "  DCR: $DCRName" -ForegroundColor White
        
        # Check if table exists
        $tableExists = $false
        try {
            $existingTable = Get-AzOperationalInsightsTable -ResourceGroupName $ResourceGroupName -WorkspaceName $WorkspaceName -TableName $TableName -ErrorAction SilentlyContinue
            if ($existingTable) {
                Write-Host "  ✓ Table already exists - skipping creation" -ForegroundColor Yellow
                $tableExists = $true
                $summary.TablesExisted++
            }
        } catch {
            # Table doesn't exist, will create
        }
        
        # Create table if needed
        if (-not $tableExists) {
            Write-Host "  Creating table..." -ForegroundColor Cyan
            
            $apiVersion = "2022-10-01"
            $uri = "https://management.azure.com/subscriptions/$subscriptionId/resourceGroups/$ResourceGroupName/providers/Microsoft.OperationalInsights/workspaces/$WorkspaceName/tables/$TableName" + "?api-version=$apiVersion"
            
            $tableSchema = @{
                properties = @{
                    retentionInDays = $RetentionDays
                    schema = @{
                        name = $TableName
                        columns = $columns
                    }
                }
            }
            
            $body = $tableSchema | ConvertTo-Json -Depth 10
            $response = Invoke-WebRequest -Uri $uri -Method PUT -Headers $headers -Body $body -UseBasicParsing
            
            if ($response.StatusCode -eq 200 -or $response.StatusCode -eq 201 -or $response.StatusCode -eq 202) {
                Write-Host "  ✅ Table created successfully!" -ForegroundColor Green
                $summary.TablesCreated++
            } else {
                throw "Unexpected status code: $($response.StatusCode)"
            }
        }
        
        # Check if DCR exists
        $dcrExists = $false
        try {
            $existingDCR = Get-AzDataCollectionRule -ResourceGroupName $ResourceGroupName -Name $DCRName -ErrorAction SilentlyContinue
            if ($existingDCR) {
                Write-Host "  ✓ DCR already exists - skipping creation" -ForegroundColor Yellow
                $dcrExists = $true
                $summary.DCRsExisted++
            }
        } catch {
            # DCR doesn't exist, will create
        }
        
        # Create DCR if needed
        if (-not $dcrExists) {
            Write-Host "  Creating DCR..." -ForegroundColor Cyan
            
            # Convert columns to DCR format
            $dcrColumns = @()
            foreach ($column in $columns) {
                $dcrColumns += @{
                    name = $column.name
                    type = $column.type
                }
            }
            
            $streamName = "Custom-$TableName"
            
            $dcrTemplate = @{
                '$schema' = "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#"
                contentVersion = "1.0.0.0"
                parameters = @{}
                resources = @(
                    @{
                        type = "Microsoft.Insights/dataCollectionRules"
                        apiVersion = "2023-03-11"
                        name = $DCRName
                        location = $Location
                        kind = "Direct"
                        properties = @{
                            streamDeclarations = @{
                                $streamName = @{
                                    columns = $dcrColumns
                                }
                            }
                            destinations = @{
                                logAnalytics = @(
                                    @{
                                        workspaceResourceId = $workspaceResourceId
                                        name = "logAnalyticsWorkspace"
                                    }
                                )
                            }
                            dataFlows = @(
                                @{
                                    streams = @($streamName)
                                    destinations = @("logAnalyticsWorkspace")
                                    transformKql = "source"
                                    outputStream = $streamName
                                }
                            )
                        }
                    }
                )
                outputs = @{
                    dataCollectionRuleId = @{
                        type = "string"
                        value = "[resourceId('Microsoft.Insights/dataCollectionRules', '$DCRName')]"
                    }
                }
            }
            
            $deploymentName = "dcr-deployment-$(Get-Date -Format 'yyyyMMdd-HHmmss')-$BaseTableName"
            $deploymentUri = "https://management.azure.com/subscriptions/$subscriptionId/resourceGroups/$ResourceGroupName/providers/Microsoft.Resources/deployments/$deploymentName" + "?api-version=2021-04-01"
            
            $deploymentBody = @{
                properties = @{
                    template = $dcrTemplate
                    mode = "Incremental"
                }
            } | ConvertTo-Json -Depth 20
            
            $dcrResponse = Invoke-WebRequest -Uri $deploymentUri -Method PUT -Headers $headers -Body $deploymentBody -UseBasicParsing
            
            if ($dcrResponse.StatusCode -eq 200 -or $dcrResponse.StatusCode -eq 201 -or $dcrResponse.StatusCode -eq 202) {
                Write-Host "  ✅ DCR created successfully!" -ForegroundColor Green
                $summary.DCRsCreated++
            } else {
                throw "Unexpected DCR status code: $($dcrResponse.StatusCode)"
            }
        }
        
        Write-Host "  ✅ Completed: $($schemaFile.Name)" -ForegroundColor Green
        
    } catch {
        $errorMsg = "Error processing $($schemaFile.Name): $($_.Exception.Message)"
        Write-Host "  ❌ $errorMsg" -ForegroundColor Red
        $summary.Errors += $errorMsg
    }
}

# Display final summary
Write-Host "`n" + "="*80 -ForegroundColor Cyan
Write-Host "EXECUTION SUMMARY" -ForegroundColor Cyan
Write-Host "="*80 -ForegroundColor Cyan

Write-Host "Tables:" -ForegroundColor White
Write-Host "  Processed: $($summary.TablesProcessed)" -ForegroundColor Gray
Write-Host "  Created: $($summary.TablesCreated)" -ForegroundColor Green
Write-Host "  Already Existed: $($summary.TablesExisted)" -ForegroundColor Yellow

Write-Host "DCRs:" -ForegroundColor White
Write-Host "  Created: $($summary.DCRsCreated)" -ForegroundColor Green
Write-Host "  Already Existed: $($summary.DCRsExisted)" -ForegroundColor Yellow

if ($summary.Errors.Count -gt 0) {
    Write-Host "Errors:" -ForegroundColor Red
    foreach ($error in $summary.Errors) {
        Write-Host "  - $error" -ForegroundColor Red
    }
} else {
    Write-Host "Errors: None" -ForegroundColor Green
}

Write-Host "`nScript completed! 🎉" -ForegroundColor Cyan

# Usage examples:
# .\Create-TableAndDCR.ps1                                    # Process all schemas
# .\Create-TableAndDCR.ps1 -SpecificTable "SecurityEvents"   # Process only SecurityEvents schema
# .\Create-TableAndDCR.ps1 -ParametersFile "prod-params.json" # Use custom parameters file