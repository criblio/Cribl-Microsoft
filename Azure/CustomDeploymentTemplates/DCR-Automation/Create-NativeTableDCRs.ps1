# Create Azure Data Collection Rules for Native Tables (Unified - DCE or Direct)
# Run this script from VSCode terminal or PowerShell
# This script will process all tables listed in TableList.json and retrieve schemas from Azure
# Supports both DCE-based and Direct DCRs based on operation parameters

param(
    [Parameter(Mandatory=$false)]
    [string]$AzureParametersFile = "azure-parameters.json",
    
    [Parameter(Mandatory=$false)]
    [string]$OperationParametersFile = "operation-parameters.json",
    
    [Parameter(Mandatory=$false)]
    [string]$TableListFile = "TableList.json",
    
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
    [switch]$IgnoreOperationParameters = $false
)

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
        'guid' { return 'string' }  # GUIDs must be string in DCR, transformed to guid in output
        'uniqueidentifier' { return 'string' }
        'uuid' { return 'string' }
        default { 
            Write-Warning "Unknown column type '$ColumnType' mapped to 'string'"
            return 'string' 
        }
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

Write-Host "Starting Azure Data Collection Rules (Unified - DCE or Direct) deployment process..." -ForegroundColor Cyan
Write-Host "Script directory: $ScriptDirectory" -ForegroundColor Gray
Write-Host "Azure parameters file: $FullAzureParametersPath" -ForegroundColor Gray
Write-Host "Operation parameters file: $FullOperationParametersPath" -ForegroundColor Gray
Write-Host "Table list file: $FullTableListPath" -ForegroundColor Gray
Write-Host "DCR template (with DCE): $FullDCRTemplateWithDCEPath" -ForegroundColor Gray
Write-Host "DCR template (Direct): $FullDCRTemplateDirectPath" -ForegroundColor Gray

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
        
        # Check for both Microsoft-{TableName} and {TableName}_CL format
        $tableVariants = @("Microsoft-$TableName", "${TableName}_CL", $TableName)
        
        foreach ($variant in $tableVariants) {
            $uri = "https://management.azure.com/subscriptions/$subscriptionId/resourceGroups/$resourceGroupName/providers/Microsoft.OperationalInsights/workspaces/$workspaceName/tables/$variant"
            $uri += "?api-version=2022-10-01"
            
            try {
                $response = Invoke-RestMethod -Uri $uri -Method GET -Headers $headers -ErrorAction Stop
                if ($response) {
                    Write-Host "  Debug: Found table schema for $variant" -ForegroundColor Gray
                    
                    return @{
                        Exists = $true
                        TableName = $variant
                        Schema = $response.properties.schema
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
function Get-TableColumns {
    param([string]$TableName, [object]$TableSchema)
    
    $columns = @()
    
    # Try different schema structures that Azure might return
    $schemaColumns = $null
    if ($TableSchema -and $TableSchema.standardColumns) {
        $schemaColumns = $TableSchema.standardColumns
    } elseif ($TableSchema -and $TableSchema.columns) {
        $schemaColumns = $TableSchema.columns
    }
    
    if ($schemaColumns) {
        # Filter out system columns AND columns with unsupported types
        $systemColumns = @(
            "TenantId", "SourceSystem", "MG", "ManagementGroupName", 
            "_ResourceId", "Type", "_SubscriptionId", 
            "_ItemId", "_IsBillable",
            # Legacy Azure Table Storage columns
            "PartitionKey", "RowKey", "StorageAccount", "AzureDeploymentID", "AzureTableName",
            # Additional system columns that cause issues
            "TimeCollected", "SourceComputerId", "EventOriginId"
        )
        
        $filteredColumns = $schemaColumns | Where-Object { 
            $_.name -notin $systemColumns -and 
            $_.type.ToLower() -notin @('guid', 'uniqueidentifier', 'uuid')
        }
        
        Write-Host "  Schema Analysis:" -ForegroundColor Cyan
        Write-Host "    Total columns from Azure: $($schemaColumns.Count)" -ForegroundColor Gray
        
        # Count different types of filtered columns
        $systemFiltered = ($schemaColumns | Where-Object { $_.name -in $systemColumns }).Count
        $guidFiltered = ($schemaColumns | Where-Object { $_.type.ToLower() -in @('guid', 'uniqueidentifier', 'uuid') }).Count
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
        
        Write-Host "Operation parameters loaded successfully" -ForegroundColor Green
        Write-Host "  Create DCE: $CreateDCE" -ForegroundColor Cyan
        Write-Host "  Template Only Mode: $TemplateOnly" -ForegroundColor Cyan
        
    } catch {
        Write-Warning "Failed to load operation parameters: $($_.Exception.Message)"
    }
}

# Determine which template to use and deployment mode
$dcrMode = if ($CreateDCE) { "DCE-based" } else { "Direct" }
$templateFile = if ($CreateDCE) { $FullDCRTemplateWithDCEPath } else { $FullDCRTemplateDirectPath }

Write-Host "DCR Mode: $dcrMode" -ForegroundColor Cyan
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

# Load table list
Write-Host "Loading table list from: $FullTableListPath" -ForegroundColor Yellow
try {
    if (!(Test-Path $FullTableListPath)) { throw "Table list file not found: $FullTableListPath" }
    $tableList = Get-Content $FullTableListPath | ConvertFrom-Json
    Write-Host "Table list loaded successfully - Found $($tableList.Count) tables" -ForegroundColor Green
} catch {
    Write-Host "Failed to load table list: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
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

# Login to Azure (required even in template-only mode for schema retrieval)
Write-Host "Checking Azure connection..." -ForegroundColor Yellow
try {
    $context = Get-AzContext
    if (!$context) {
        Connect-AzAccount
        Write-Host "Successfully logged into Azure" -ForegroundColor Green
    } else {
        Write-Host "Already logged into Azure as: $($context.Account.Id)" -ForegroundColor Green
    }
    
    if ($TemplateOnly) {
        Write-Host "Template-only mode: Azure connection required for schema retrieval" -ForegroundColor Yellow
    }
} catch {
    Write-Host "Failed to login to Azure: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

# Verify workspace (required even in template-only mode for schema retrieval)
Write-Host "Verifying Log Analytics workspace..." -ForegroundColor Yellow
try {
    $workspace = Get-AzOperationalInsightsWorkspace -ResourceGroupName $ResourceGroupName -Name $WorkspaceName -ErrorAction Stop
    Write-Host "Workspace found: $($workspace.Name)" -ForegroundColor Green
    $workspaceResourceId = $workspace.ResourceId
    Write-Host "Workspace ID: $workspaceResourceId" -ForegroundColor Gray
    
    if ($TemplateOnly) {
        Write-Host "Template-only mode: Workspace verified for schema retrieval" -ForegroundColor Yellow
    }
} catch {
    Write-Host "Workspace not found: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

# Initialize summary tracking
$summary = @{
    DCRsProcessed = 0; DCRsCreated = 0; DCRsExisted = 0
    DCEsCreated = 0; DCEsExisted = 0; TablesValidated = 0
    TablesNotFound = 0; SchemasRetrieved = 0; ManualDeploymentRecommended = 0
    ProcessingFailures = @(); ManualDeploymentCases = @()
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
    Write-Host "GENERATING TEMPLATES ($dcrMode DCRs)" -ForegroundColor Cyan
} else {
    Write-Host "PROCESSING TABLES ($dcrMode DCRs)" -ForegroundColor Cyan
}
Write-Host "$('='*80)" -ForegroundColor Cyan

foreach ($tableName in $tableList) {
    $summary.DCRsProcessed++
    Write-Host "`n--- Processing: $tableName ---" -ForegroundColor Yellow
    
    try {
        # Build DCR name
        $DCRName = "${DCRPrefix}${tableName}-${Location}"
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
                
                $truncatedTableName = $tableName.Substring(0, [Math]::Min($tableName.Length, $maxTableNameLength))
                $DCRName = "${DCRPrefix}${truncatedTableName}-${Location}"
                if (![string]::IsNullOrWhiteSpace($DCRSuffix)) {
                    $DCRName = "${DCRName}-${DCRSuffix}"
                }
            } else {
                # For Direct DCRs, use abbreviated naming to fit 30-char limit
                $tableAbbrev = switch ($tableName) {
                    'CommonSecurityLog' { 'CSL' }
                    'SecurityEvent' { 'SecEvt' }
                    'WindowsEvent' { 'WinEvt' }
                    'Syslog' { 'Syslog' }
                    'DeviceEvents' { 'DevEvt' }
                    'BehaviorAnalytics' { 'BehAna' }
                    default { 
                        # Generic abbreviation: take first 6 chars
                        $tableName.Substring(0, [Math]::Min($tableName.Length, 6))
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
        
        if ($TemplateOnly) {
            Write-Host "  Template-only mode: Skipping Azure resource checks" -ForegroundColor Yellow
        }
        
        # DCE handling (only if CreateDCE is true)
        $dceResourceId = $null
        if ($CreateDCE) {
            $DCEName = "${DCEPrefix}${tableName}-${Location}"
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
                Write-Host "  ✓ DCR already exists - skipping" -ForegroundColor Yellow
                $summary.DCRsExisted++
                continue
            }
        }
        
        # Process schema
        Write-Host "  Processing table schema..." -ForegroundColor Cyan
        
        if ($TemplateOnly) {
            Write-Host "  Template-only mode: Still retrieving actual schema from Azure" -ForegroundColor Yellow
        }
        
        Write-Host "  Retrieving table schema from Azure..." -ForegroundColor Cyan
        Write-Host "  Workspace ID: $workspaceResourceId" -ForegroundColor Gray
        $tableInfo = Get-LogAnalyticsTableSchema -WorkspaceResourceId $workspaceResourceId -TableName $tableName
        
        Write-Host "  Debug: Table lookup result - Exists: $($tableInfo.Exists), Name: $($tableInfo.TableName)" -ForegroundColor Gray
        
        if ($tableInfo.Exists -eq $true) {
            Write-Host "  ✅ Table found: $($tableInfo.TableName)" -ForegroundColor Green
            $summary.TablesValidated++
            $summary.SchemasRetrieved++
            $tableSchema = $tableInfo.Schema
            $columns = Get-TableColumns -TableName $tableName -TableSchema $tableInfo.Schema
            
            if ($columns -eq $null -or $columns.Count -eq 0) {
                Write-Host "  ❌ Failed to process table schema - no valid columns found" -ForegroundColor Red
                $summary.ProcessingFailures += "Failed to process schema for table: $tableName - no valid columns"
                continue
            }
        } else {
            Write-Host "  ❌ Table not found in Azure - cannot proceed without schema" -ForegroundColor Red
            if ($tableInfo.Exists -eq $null) {
                Write-Host "  Debug: Table lookup failed with error (check authentication/permissions)" -ForegroundColor Yellow
            } else {
                Write-Host "  Debug: Table definitely does not exist in workspace" -ForegroundColor Yellow
            }
            $summary.TablesNotFound++
            $summary.ProcessingFailures += "Table not found in Azure: $tableName"
            continue
        }
        
        # Create deployment parameters
        $deploymentParameters = @{
            dataCollectionRuleName = @{ value = $DCRName }
            location = @{ value = $Location }
            workspaceResourceId = @{ value = $workspaceResourceId }
            tableName = @{ value = $tableName }
            columns = @{ value = $columns }
        }
        
        # Add DCE parameter if using DCE mode
        if ($CreateDCE) { $deploymentParameters.endpointResourceId = @{ value = $dceResourceId } }
        
        # Save template
        $timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        $templatePath = Join-Path $templatesDir "$tableName-$timestamp.json"
        $latestTemplatePath = Join-Path $templatesDir "$tableName-latest.json"
        
        # Define the hardcoded stream names
        $streamName = "Custom-$tableName"
        $outputStreamName = "Microsoft-$tableName"
        
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
                tableName = $tableName
                generatedOn = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
                streamName = $streamName
                outputStreamName = $outputStreamName
            } -Force
            
            $templateJson = $deploymentTemplate | ConvertTo-Json -Depth 15
        }
        
        $templateJson | Set-Content -Path $templatePath -Encoding UTF8
        $templateJson | Set-Content -Path $latestTemplatePath -Encoding UTF8
        
        Write-Host "  Template saved: $tableName-$timestamp.json" -ForegroundColor Gray
        Write-Host "  Latest template: $tableName-latest.json" -ForegroundColor Gray
        Write-Host "  Stream names hardcoded:" -ForegroundColor Cyan
        Write-Host "    Input stream: $streamName" -ForegroundColor Gray
        Write-Host "    Output stream: $outputStreamName" -ForegroundColor Gray
        if ($TemplateOnly) {
            Write-Host "  Template is standalone: columns embedded, resource IDs blank by default" -ForegroundColor Yellow
        }
        
        # Cleanup old templates
        if ($CleanupOldTemplates) {
            Invoke-TemplateCleanup -TemplatesDirectory $templatesDir -TableName $tableName -KeepVersions $KeepTemplateVersions
        }
        
        # Analyze template
        $templateSize = $templateJson.Length
        $recommendation = Get-TemplateDeploymentRecommendation -TableSchema $tableSchema -TableName $tableName -TemplateSize $templateSize
        
        Write-Host "  Template Analysis:" -ForegroundColor Cyan
        Write-Host "    Size: $([math]::Round($templateSize/1024, 1)) KB" -ForegroundColor Gray
        Write-Host "    Columns: $($columns.Count)" -ForegroundColor Gray
        Write-Host "    Complexity: $($recommendation.EstimatedComplexity)" -ForegroundColor Gray
        
        # Check deployment recommendation
        if (-not $recommendation.ShouldDeploy) {
            Write-Host "  ❌ Automatic deployment not recommended" -ForegroundColor Red
            $summary.ManualDeploymentRecommended++
            $summary.ManualDeploymentCases += @{
                TableName = $tableName; Reason = $recommendation.Reason
                TemplatePath = $templatePath; DCRName = $DCRName
            }
            Show-ManualDeploymentInstructions -TableName $tableName -TemplatePath $templatePath -DCRName $DCRName -ResourceGroupName $ResourceGroupName -Location $Location -WorkspaceResourceId $workspaceResourceId -EndpointResourceId $dceResourceId -Reason $recommendation.Reason -UseDCE $CreateDCE
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
            $summary.ProcessingFailures += "Template validation failed for ${tableName}: $($_.Exception.Message)"
            continue
        }
        
        # Deploy DCR (skip in template-only mode)
        if ($TemplateOnly) {
            Write-Host "  ✅ Template generated successfully (template-only mode)" -ForegroundColor Green
            Write-Host "  Template location: $latestTemplatePath" -ForegroundColor Cyan
        } else {
            Write-Host "  Deploying $dcrMode DCR using generated template..." -ForegroundColor Cyan
        
        $deploymentName = "dcr-$($dcrMode.ToLower())-$(Get-Date -Format 'yyyyMMdd-HHmmss')-$tableName"
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
                    TableName = $tableName; Reason = "PowerShell deployment failed - $deploymentError"
                    TemplatePath = $templatePath; DCRName = $DCRName
                }
                Show-ManualDeploymentInstructions -TableName $tableName -TemplatePath $latestTemplatePath -DCRName $DCRName -ResourceGroupName $ResourceGroupName -Location $Location -WorkspaceResourceId $workspaceResourceId -EndpointResourceId $dceResourceId -Reason "PowerShell deployment failed with template validation error" -UseDCE $CreateDCE
                continue
            }
            
            Write-Host "  ❌ Deployment failed: $deploymentError" -ForegroundColor Red
            $summary.ManualDeploymentRecommended++
            $summary.ManualDeploymentCases += @{
                TableName = $tableName; Reason = "PowerShell deployment failed"
                TemplatePath = $templatePath; DCRName = $DCRName
            }
            Show-ManualDeploymentInstructions -TableName $tableName -TemplatePath $latestTemplatePath -DCRName $DCRName -ResourceGroupName $ResourceGroupName -Location $Location -WorkspaceResourceId $workspaceResourceId -EndpointResourceId $dceResourceId -Reason "PowerShell deployment failed" -UseDCE $CreateDCE
            continue
        }
        }
        
        Write-Host "  ✅ Completed: $tableName" -ForegroundColor Green
        
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
    Write-Host "TEMPLATE GENERATION SUMMARY ($dcrMode DCRs)" -ForegroundColor Cyan
} else {
    Write-Host "EXECUTION SUMMARY ($dcrMode DCRs)" -ForegroundColor Cyan
}
Write-Host "$('='*80)" -ForegroundColor Cyan

Write-Host "Results:" -ForegroundColor White
Write-Host "  DCRs Processed: $($summary.DCRsProcessed)" -ForegroundColor Gray
Write-Host "  DCRs Created: $($summary.DCRsCreated)" -ForegroundColor Green
Write-Host "  DCRs Already Existed: $($summary.DCRsExisted)" -ForegroundColor Yellow
Write-Host "  DCR Mode: $dcrMode" -ForegroundColor Cyan
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

Write-Host "`nNext Steps:" -ForegroundColor Cyan
if ($summary.ManualDeploymentRecommended -gt 0) {
    Write-Host "1. Use Azure Portal for manual deployments (better reporting)" -ForegroundColor Yellow
    Write-Host "2. Templates saved in generated-templates directory" -ForegroundColor Gray
    Write-Host "3. Navigate to: https://portal.azure.com -> Deploy a custom template" -ForegroundColor Gray
    Write-Host "4. Upload the *-latest.json files from the generated-templates directory" -ForegroundColor Gray
} else {
    Write-Host "✅ All $dcrMode DCRs deployed successfully! Templates saved for future reference." -ForegroundColor Green
}

Write-Host "💡 To switch DCR modes, change 'createDCE' in operation-parameters.json" -ForegroundColor Cyan
Write-Host "`nScript completed! 🎉" -ForegroundColor Cyan

# Usage examples:
# .\ Create-NativeTableDCRs.ps1                                                    # Uses operation-parameters.json settings
# .\ Create-NativeTableDCRs.ps1 -IgnoreOperationParameters                        # Uses only command-line parameters
# .\ Create-NativeTableDCRs.ps1 -TemplateOnly                                     # Template-only mode: generates ARM templates without deploying
# .\ Create-NativeTableDCRs.ps1 -SpecificDCR "SecurityEvent"                     # Process specific table only
# .\ Create-NativeTableDCRs.ps1 -CreateDCE:$false                                 # Force Direct DCRs
# .\ Create-NativeTableDCRs.ps1 -CreateDCE                                        # Force DCE-based DCRs
# .\ Create-NativeTableDCRs.ps1 -CleanupOldTemplates -KeepTemplateVersions 3     # Override: cleanup old templates
# .\ Create-NativeTableDCRs.ps1 -AzureParametersFile "prod-azure.json"          # Use custom Azure parameters file
# .\ Create-NativeTableDCRs.ps1 -OperationParametersFile "custom-ops.json"      # Use custom operation parameters file
