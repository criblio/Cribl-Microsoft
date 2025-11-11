# Create Azure Data Collection Rules for Tables (Native and Custom)

[CmdletBinding()]
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
 [switch]$SkipCriblExport = $false,

 [Parameter(Mandatory=$false)]
 [switch]$ConfirmDCRNames = $true
)

# Import Output-Helper for consistent verbosity control
. (Join-Path $PSScriptRoot "Output-Helper.ps1")

# Set verbose output mode based on PowerShell's built-in VerbosePreference
$isVerbose = ($VerbosePreference -eq 'Continue') -or ($PSBoundParameters.ContainsKey('Verbose'))
Set-DCRVerboseOutput -Enabled $isVerbose

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
 Write-DCRError " No Azure context found. Please run 'Connect-AzAccount' first."
 }
 return $false
 }

 # Test if the token is still valid by making a simple API call
 # Suppress warnings about token expiration
 try {
 $testResult = Get-AzSubscription -SubscriptionId $context.Subscription.Id -ErrorAction Stop -WarningAction SilentlyContinue 2>$null | Out-Null

 if (-not $Silent) {
 # Only show this on initial check, not during processing
 Write-DCRSuccess " Azure connection verified" -NoNewline
 Write-DCRVerbose " (Token valid)"
 }
 return $true
 }
 catch {
 # Token is expired or invalid - try to refresh it
 if (-not $Silent) {
 Write-DCRWarning " Token expired. Attempting automatic refresh..."
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
 Write-DCRSuccess " Token refreshed successfully"
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
 Write-DCRSuccess " Azure connection refreshed successfully"
 }
 return $true
 }
 }
 catch {
 if (-not $Silent) {
 Write-DCRError " Failed to refresh token automatically"
 Write-DCRWarning " Please run 'Connect-AzAccount' to refresh your session"
 }
 return $false
 }
 }
 } else {
 # Service Principal - cannot refresh automatically
 if (-not $Silent) {
 Write-DCRError " Service Principal session expired. Please re-authenticate."
 }
 return $false
 }
 } else {
 if (-not $Silent) {
 Write-DCRError " Cannot refresh - insufficient context information"
 }
 return $false
 }
 }
 catch {
 if (-not $Silent) {
 Write-DCRError " Token refresh failed: $($_.Exception.Message)"
 Write-DCRWarning " Please run 'Connect-AzAccount' to refresh your session"
 }
 return $false
 }
 }

 } catch {
 # General error with Azure connection
 if (-not $Silent) {
 Write-DCRError " Failed to verify Azure connection: $($_.Exception.Message)"
 }
 return $false
 }
}

# Function to add DCE to Azure Monitor Private Link Scope
function Add-DCEToAMPLS {
 param(
 [Parameter(Mandatory=$true)]
 [string]$DCEResourceId,

 [Parameter(Mandatory=$false)]
 [string]$AMPLSResourceId,

 [Parameter(Mandatory=$false)]
 [string]$AMPLSResourceGroupName,

 [Parameter(Mandatory=$false)]
 [string]$AMPLSName
 )

 try {
 # Determine AMPLS resource ID
 if (-not $AMPLSResourceId) {
 if ($AMPLSResourceGroupName -and $AMPLSName) {
 $context = Get-AzContext
 $subscriptionId = $context.Subscription.Id
 $AMPLSResourceId = "/subscriptions/$subscriptionId/resourceGroups/$AMPLSResourceGroupName/providers/Microsoft.Insights/privateLinkScopes/$AMPLSName"
 Write-DCRVerbose " Constructed AMPLS Resource ID: $AMPLSResourceId"
 } else {
 Write-Warning " Cannot add DCE to AMPLS: No AMPLS Resource ID or Name/ResourceGroup provided"
 return $false
 }
 }

 # Extract DCE name from resource ID for the scoped resource name
 $dceName = $DCEResourceId -split '/' | Select-Object -Last 1
 $scopedResourceName = "$dceName-ampls-connection"

 # Extract AMPLS details from resource ID
 $amplsRgName = ($AMPLSResourceId -split '/')[4]
 $amplsScopeName = ($AMPLSResourceId -split '/')[-1]

 Write-DCRInfo " Adding DCE to Azure Monitor Private Link Scope..." -Color Cyan
 Write-DCRVerbose " AMPLS: $amplsScopeName"
 Write-DCRVerbose " DCE: $dceName"

 # Check if scoped resource already exists
 try {
 $existing = Get-AzInsightsPrivateLinkScopedResource `
 -ResourceGroupName $amplsRgName `
 -ScopeName $amplsScopeName `
 -Name $scopedResourceName `
 -ErrorAction SilentlyContinue

 if ($existing) {
 Write-DCRWarning " DCE already associated with AMPLS"
 return $true
 }
 } catch {
 # Resource doesn't exist, continue with creation
 }

 # Create the scoped resource association
 $scopedResource = New-AzInsightsPrivateLinkScopedResource `
 -ResourceGroupName $amplsRgName `
 -ScopeName $amplsScopeName `
 -Name $scopedResourceName `
 -LinkedResourceId $DCEResourceId `
 -ErrorAction Stop

 Write-DCRSuccess " DCE successfully added to AMPLS"
 return $true

 } catch {
 Write-Warning " Failed to add DCE to AMPLS: $($_.Exception.Message)"
 Write-DCRWarning " You may need to manually add the DCE to the AMPLS in the Azure Portal"
 return $false
 }
}

# Function to create Azure Monitor Private Link Scope if it doesn't exist
function New-AMPLSIfNotExists {
 param(
 [Parameter(Mandatory=$true)]
 [string]$ResourceGroupName,

 [Parameter(Mandatory=$true)]
 [string]$AMPLSName,

 [Parameter(Mandatory=$true)]
 [string]$Location
 )

 try {
 Write-DCRInfo " Checking if AMPLS exists: $AMPLSName" -Color Cyan

 # Check if AMPLS already exists
 $existingAMPLS = Get-AzInsightsPrivateLinkScope `
 -ResourceGroupName $ResourceGroupName `
 -Name $AMPLSName `
 -ErrorAction SilentlyContinue

 if ($existingAMPLS) {
 Write-DCRWarning " AMPLS already exists: $AMPLSName"
 return $existingAMPLS.Id
 }

 # Create new AMPLS (AMPLS is a global resource)
 Write-DCRInfo " Creating new AMPLS: $AMPLSName" -Color Cyan
 Write-DCRVerbose " Resource Group: $ResourceGroupName"
 Write-DCRVerbose " Location: global"

 $newAMPLS = New-AzInsightsPrivateLinkScope `
 -ResourceGroupName $ResourceGroupName `
 -Name $AMPLSName `
 -Location "global" `
 -ErrorAction Stop

 Write-DCRSuccess " AMPLS created successfully"
 Write-DCRVerbose " Resource ID: $($newAMPLS.Id)"

 return $newAMPLS.Id

 } catch {
 Write-Warning " Failed to create AMPLS: $($_.Exception.Message)"
 throw
 }
}

# Function to add Log Analytics Workspace to AMPLS
function Add-WorkspaceToAMPLS {
 param(
 [Parameter(Mandatory=$true)]
 [string]$WorkspaceResourceId,

 [Parameter(Mandatory=$true)]
 [string]$AMPLSResourceId
 )

 try {
 # Extract workspace name from resource ID
 $workspaceName = $WorkspaceResourceId -split '/' | Select-Object -Last 1
 $scopedResourceName = "$workspaceName-ampls-connection"

 # Extract AMPLS details from resource ID
 $amplsRgName = ($AMPLSResourceId -split '/')[4]
 $amplsScopeName = ($AMPLSResourceId -split '/')[-1]

 Write-DCRInfo " Adding Log Analytics Workspace to AMPLS..." -Color Cyan
 Write-DCRVerbose " AMPLS: $amplsScopeName"
 Write-DCRVerbose " Workspace: $workspaceName"

 # Check if scoped resource already exists
 try {
 $existing = Get-AzInsightsPrivateLinkScopedResource `
 -ResourceGroupName $amplsRgName `
 -ScopeName $amplsScopeName `
 -Name $scopedResourceName `
 -ErrorAction SilentlyContinue

 if ($existing) {
 Write-DCRWarning " Workspace already associated with AMPLS"
 return $true
 }
 } catch {
 # Resource doesn't exist, continue with creation
 }

 # Create the scoped resource association
 $scopedResource = New-AzInsightsPrivateLinkScopedResource `
 -ResourceGroupName $amplsRgName `
 -ScopeName $amplsScopeName `
 -Name $scopedResourceName `
 -LinkedResourceId $WorkspaceResourceId `
 -ErrorAction Stop

 Write-DCRSuccess " Workspace successfully added to AMPLS"
 return $true

 } catch {
 Write-Warning " Failed to add Workspace to AMPLS: $($_.Exception.Message)"
 Write-DCRWarning " You may need to manually add the Workspace to the AMPLS in the Azure Portal"
 return $false
 }
}

# Function to periodically check and refresh token during long operations
function Test-TokenRefresh {
 param(
 [int]$Counter,
 [int]$CheckInterval = 5 # Check every N operations
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
 'guid' { return 'string' } # GUIDs not allowed in DCR - must convert to string
 'uniqueidentifier' { return 'string' } # SQL Server GUID type - convert to string
 'uuid' { return 'string' } # PostgreSQL UUID type - convert to string
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
 
 Write-DCRInfo " Creating custom table: $TableName" -Color Cyan
 
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
 
 Write-DCRVerbose " Sending table creation request..."
 $response = Invoke-RestMethod -Uri $uri -Method PUT -Headers $headers -Body $body -ErrorAction Stop
 
 Write-DCRSuccess " Custom table created successfully: $TableName"
 Write-DCRVerbose " Retention: $RetentionInDays days (archive: $TotalRetentionInDays days)"
 
 return @{
 Success = $true
 TableName = $TableName
 Response = $response
 }
 
 } catch {
 $errorMessage = $_.Exception.Message
 
 # Check if table already exists
 if ($errorMessage -like "*already exists*" -or $errorMessage -like "*Conflict*") {
 Write-DCRWarning " Table already exists: $TableName"
 return @{
 Success = $false
 AlreadyExists = $true
 TableName = $TableName
 Error = $errorMessage
 }
 }
 
 Write-DCRError " Failed to create custom table: $errorMessage"
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
 
 Write-DCRInfo " Attempting to migrate custom table to DCR-based ingestion: $TableName" -Color Cyan
 
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
 
 Write-DCRVerbose " Checking current ingestion mode..."
 $tableInfo = Invoke-RestMethod -Uri $checkUri -Method GET -Headers $headers -ErrorAction Stop
 
 # Check if already DCR-based (plan property indicates ingestion type)
 if ($tableInfo.properties.plan -eq "Analytics") {
 # Check for ingestion type indicators
 if ($tableInfo.properties.ingestionType -eq "DCRBased" -or 
 $tableInfo.properties.schema.tableType -eq "Microsoft" -or
 $tableInfo.properties.provisioningState -match "DCR") {
 Write-DCRSuccess " Table is already configured for DCR-based ingestion"
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
 
 Write-DCRVerbose " Sending migration request..."
 Write-DCRVerbose " URI: $migrateUri"
 
 # Send migration request (POST with empty body)
 $response = Invoke-RestMethod -Uri $migrateUri -Method POST -Headers $headers -Body "{}" -ErrorAction Stop
 
 Write-DCRSuccess " Migration initiated successfully for table: $TableName"
 Write-DCRVerbose " Status: Table will now accept data through DCR-based ingestion"
 
 # Wait a moment for migration to propagate
 Write-DCRVerbose " Waiting for migration to complete..."
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
 Write-DCRWarning "  Table is already migrated or in process: $TableName"
 return @{
 Success = $true
 AlreadyMigrated = $true
 TableName = $TableName
 Message = "Table already migrated or migration in progress"
 }
 } elseif ($statusCode -eq 404) {
 Write-DCRError " Table not found for migration: $TableName"
 return @{
 Success = $false
 TableName = $TableName
 Error = "Table not found"
 }
 } elseif ($statusCode -eq 400 -or $errorMessage -like "*not eligible*" -or $errorMessage -like "*cannot be migrated*") {
 Write-DCRWarning " Table not eligible for DCR-based migration: $TableName"
 Write-DCRVerbose " This table type may not support DCR-based ingestion"
 return @{
 Success = $false
 TableName = $TableName
 Error = "Table not eligible for DCR-based ingestion"
 NotEligible = $true
 }
 } else {
 Write-DCRError " Failed to migrate table: $errorMessage"
 if ($statusCode) {
 Write-DCRVerbose " Status Code: $statusCode"
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
 Write-DCRWarning " Schema file not found: $schemaFilePath"
 return $null
 }
 
 Write-DCRInfo " Loading schema from file: $schemaFilePath" -Color Cyan
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
 
 Write-DCRSuccess " Schema loaded: $($columns.Count) columns"
 
 return @{
 columns = $columns
 retentionInDays = if ($schemaContent.retentionInDays) { $schemaContent.retentionInDays } else { 30 }
 totalRetentionInDays = if ($schemaContent.totalRetentionInDays) { $schemaContent.totalRetentionInDays } else { 90 }
 description = if ($schemaContent.description) { $schemaContent.description } else { "" }
 }
 
 } catch {
 Write-DCRError " Failed to load schema from file: $($_.Exception.Message)"
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
 
 Write-DCRInfo " Processing custom table: $customTableName" -Color Cyan
 
 # First, check if table exists in Azure
 Write-DCRVerbose " Checking if custom table exists in Azure..."
 $existingTable = Get-LogAnalyticsTableSchema -WorkspaceResourceId $WorkspaceResourceId -TableName $customTableName
 
 if ($existingTable.Exists -eq $true) {
 Write-DCRSuccess " Custom table exists in Azure: $($existingTable.TableName)"
 Write-DCRVerbose " Using existing schema from Azure (same as native table processing)"
 
 # Detect table type and get column count for informational purposes
 $isMMATable = $false
 if ($existingTable.Schema -and $existingTable.Schema.columns) {
 $columnCount = $existingTable.Schema.columns.Count
 Write-DCRVerbose " Azure schema has $columnCount total columns"
 } elseif ($existingTable.Schema -and $existingTable.Schema.standardColumns) {
 $columnCount = $existingTable.Schema.standardColumns.Count
 Write-DCRWarning " MMA (legacy) table detected - has $columnCount columns in standardColumns only"
 $isMMATable = $true
 }

 # Auto-enable migration for MMA tables
 $shouldAttemptMigration = $MigrateExistingToDCR -or $AutoMigrate
 if ($isMMATable -and -not $shouldAttemptMigration) {
 Write-DCRInfo " MMA table detected - automatic migration recommended" -Color Cyan
 Write-DCRVerbose " MMA tables should be migrated to DCR-based format for better performance"
 $shouldAttemptMigration = $true
 }

 # Attempt to migrate existing table to DCR-based if requested or if MMA table detected
 # ONLY apply to existing tables, not newly created ones
 if ($shouldAttemptMigration) {
 Write-DCRInfo " DCR-based ingestion migration check for existing table" -Color Cyan
 
 $shouldMigrate = $false
 if ($AutoMigrate) {
 # Auto-migrate without prompting
 $shouldMigrate = $true
 Write-DCRVerbose " Auto-migration enabled"
 } else {
 # Prompt user for confirmation with different messages based on table type
 if ($isMMATable) {
 Write-DCRWarning " MMA table detected. Migration to DCR-based format is REQUIRED for DCR creation."
 Write-Host " Migrate this MMA table to DCR-based ingestion? (Y/N): " -NoNewline -ForegroundColor Yellow
 } else {
 Write-Host " Migrate this existing table to DCR-based ingestion? (Y/N): " -NoNewline -ForegroundColor Yellow
 }
 $response = Read-Host
 $shouldMigrate = ($response -eq 'Y' -or $response -eq 'y')

 if (-not $shouldMigrate -and $isMMATable) {
 Write-DCRError " Cannot create DCR for MMA table without migration. Skipping table."
 }
 }
 
 if ($shouldMigrate) {
 $migrationResult = Convert-CustomTableToDCRBased `
 -WorkspaceResourceId $WorkspaceResourceId `
 -TableName $existingTable.TableName
 
 if ($migrationResult.Success) {
 if ($migrationResult.AlreadyMigrated) {
 Write-DCRInfo "  Table already uses DCR-based ingestion" -Color Cyan
 } else {
 Write-DCRSuccess " Successfully migrated existing table to DCR-based ingestion"
 # Update summary if tracking migrations
 if ($summary.CustomTablesMigrated) {
 $summary.CustomTablesMigrated++
 }
 }
 } elseif ($migrationResult.NotEligible) {
 Write-DCRWarning "  Continuing with classic ingestion mode"
 }
 } else {
 Write-DCRWarning " Skipping migration - table will use classic ingestion"

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
 Write-DCRWarning " Custom table not found in Azure. Looking for schema definition..."
 
 $schemaFromFile = Get-CustomTableSchemaFromFile -TableName $TableName -SchemaDirectory $SchemaDirectory
 
 if (-not $schemaFromFile) {
 # Neither table nor schema exists - prompt user for action
 $schemaFilePath = Join-Path $SchemaDirectory "$customTableName.json"
 Write-DCRWarning ""
 Write-DCRWarning " CUSTOM TABLE SETUP REQUIRED"
 Write-DCRWarning " "
 Write-DCRProgress " Table: $customTableName"
 Write-DCRError " Status: Not found in Azure"
 Write-DCRError " Schema: Not found locally"
 Write-DCRWarning ""
 Write-DCRInfo " To proceed, you need to either:" -Color Cyan
 Write-DCRVerbose " 1. Create the table manually in Azure Portal, then re-run this script"
 Write-DCRVerbose " 2. Create a schema file at: $schemaFilePath"
 Write-DCRVerbose " (See custom-table-schemas/MyCustomApp_CL.json for an example)"
 Write-DCRWarning ""
 
 # Ask user if they want to continue without this table
 Write-Host " Do you want to skip this table and continue? (Y/N): " -NoNewline -ForegroundColor Yellow
 $response = Read-Host
 
 if ($response -eq 'Y' -or $response -eq 'y') {
 Write-DCRWarning " Skipping table: $customTableName"
 return @{
 Success = $false
 TableExists = $false
 TableName = $customTableName
 Error = "Skipped by user - no schema found"
 Skipped = $true
 }
 } else {
 Write-DCRError " Stopping script. Please create the schema file and re-run."
 Write-DCRInfo " Example command to create a basic schema file:" -Color Cyan
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
 Write-DCRInfo " Creating custom table from schema file..." -Color Cyan
 
 $createResult = New-LogAnalyticsCustomTable `
 -WorkspaceResourceId $WorkspaceResourceId `
 -TableName $customTableName `
 -Columns $schemaFromFile.columns `
 -RetentionInDays ($schemaFromFile.retentionInDays ?? $RetentionDays) `
 -TotalRetentionInDays ($schemaFromFile.totalRetentionInDays ?? $TotalRetentionDays)
 
 if ($createResult.Success) {
 # Wait a moment for table to be available
 Write-DCRVerbose " Waiting for table to be available..."
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
 Write-DCRError " No Azure context found. Please run 'Connect-AzAccount' first."
 }
 return $false
 }

 # Test if the context is still valid with a lightweight operation
 try {
 $null = Get-AzSubscription -SubscriptionId $context.Subscription.Id -ErrorAction Stop -WarningAction SilentlyContinue
 if (-not $Silent) {
 Write-DCRSuccess " Azure connection verified"
 }
 return $true
 } catch {
 # Token is expired or invalid - try to refresh it
 if (-not $Silent) {
 Write-DCRWarning " Token expired. Attempting automatic refresh..."
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
 Write-DCRSuccess " Token refreshed successfully"
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
 Write-DCRSuccess " Azure connection refreshed successfully"
 }
 return $true
 }
 }
 catch {
 if (-not $Silent) {
 Write-DCRError " Failed to refresh token automatically"
 Write-DCRWarning " Please run 'Connect-AzAccount' to refresh your session"
 }
 return $false
 }
 }
 } else {
 # Service Principal - cannot refresh automatically
 if (-not $Silent) {
 Write-DCRError " Service Principal session expired. Please re-authenticate."
 }
 return $false
 }
 } else {
 if (-not $Silent) {
 Write-DCRError " Cannot refresh - insufficient context information"
 }
 return $false
 }
 }
 catch {
 if (-not $Silent) {
 Write-DCRError " Token refresh failed: $($_.Exception.Message)"
 Write-DCRWarning " Please run 'Connect-AzAccount' to refresh your session"
 }
 return $false
 }
 }
 } catch {
 if (-not $Silent) {
 Write-DCRError " Failed to verify Azure connection: $($_.Exception.Message)"
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
 Write-DCRWarning " Authentication error detected. Refreshing token (attempt $($retryCount + 1) of $MaxRetries)..."
 
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
 Write-DCRError " Maximum retry attempts reached for $OperationName"
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

# Function to confirm DCR/DCE name with user and allow custom override
function Confirm-ResourceName {
 param(
 [string]$ResourceType, # "DCR" or "DCE"
 [string]$ProposedName,
 [string]$TableName,
 [int]$MaxLength,
 [bool]$WasAbbreviated = $false
 )

 # Display the proposed name
 Write-Host ""
 Write-DCRProgress " $ResourceType Name Proposed: $ProposedName"
 if ($WasAbbreviated) {
 Write-DCRWarning " Note: Table name was abbreviated to meet $MaxLength character limit"
 }
 Write-DCRVerbose " Table: $TableName"
 Write-DCRVerbose " Length: $($ProposedName.Length) characters (max: $MaxLength)"

 # Prompt user for confirmation
 Write-Host " Accept this $ResourceType name? [Y]es / [N]o (skip) / [E]dit: " -NoNewline -ForegroundColor Yellow
 $response = Read-Host

 switch ($response.ToUpper()) {
 'Y' {
 # Accept the proposed name
 Write-DCRSuccess " Name accepted: $ProposedName"
 return @{
 Action = 'Accept'
 Name = $ProposedName
 }
 }
 'N' {
 # Skip this DCR/DCE
 Write-DCRWarning " Skipping $ResourceType creation for $TableName"
 return @{
 Action = 'Skip'
 Name = $null
 }
 }
 { $_ -in @('E', 'C') } {
 # Allow custom name entry with validation loop - start with proposed name
 $validCustomName = $false
 $customName = $ProposedName

 while (-not $validCustomName) {
 Write-Host "`n Edit $ResourceType name (max $MaxLength chars)" -ForegroundColor Cyan
 Write-Host " Current value: " -NoNewline -ForegroundColor Yellow
 Write-Host "$customName" -ForegroundColor White
 Write-Host " Enter new name (or press Enter to keep current): " -NoNewline -ForegroundColor Yellow
 $userInput = Read-Host

 # If user just presses Enter, keep the current/proposed name
 if ([string]::IsNullOrWhiteSpace($userInput)) {
 $customName = $customName.Trim()
 $validCustomName = $true
 break
 }

 # User provided new input
 $customName = $userInput

 # Validate custom name
 if ([string]::IsNullOrWhiteSpace($customName)) {
 Write-DCRError " Custom name cannot be empty."
 Write-Host " Try again? [Y]es / [N]o (use proposed name): " -NoNewline -ForegroundColor Yellow
 $retry = Read-Host
 if ($retry.ToUpper() -ne 'Y') {
 Write-DCRInfo " Using proposed name: $ProposedName" -Color Cyan
 return @{
 Action = 'Accept'
 Name = $ProposedName
 }
 }
 continue
 }

 # Trim and validate length
 $customName = $customName.Trim()
 if ($customName.Length -gt $MaxLength) {
 Write-DCRError " Custom name exceeds maximum length of $MaxLength characters (provided: $($customName.Length) chars)."
 Write-Host " Try again? [Y]es / [N]o (use proposed name): " -NoNewline -ForegroundColor Yellow
 $retry = Read-Host
 if ($retry.ToUpper() -ne 'Y') {
 Write-DCRInfo " Using proposed name: $ProposedName" -Color Cyan
 return @{
 Action = 'Accept'
 Name = $ProposedName
 }
 }
 continue
 }

 # Validate minimum length
 if ($customName.Length -lt 3) {
 Write-DCRError " Custom name too short (minimum 3 characters, provided: $($customName.Length) chars)."
 Write-Host " Try again? [Y]es / [N]o (use proposed name): " -NoNewline -ForegroundColor Yellow
 $retry = Read-Host
 if ($retry.ToUpper() -ne 'Y') {
 Write-DCRInfo " Using proposed name: $ProposedName" -Color Cyan
 return @{
 Action = 'Accept'
 Name = $ProposedName
 }
 }
 continue
 }

 # Clean up name (remove leading/trailing hyphens)
 $customName = $customName.Trim('-')

 # Name is valid
 $validCustomName = $true
 }

 Write-DCRSuccess " Custom name accepted: $customName"
 return @{
 Action = 'Accept'
 Name = $customName
 }
 }
 default {
 # Default to accepting the proposed name
 Write-DCRInfo " No valid option selected. Accepting proposed name: $ProposedName" -Color Cyan
 return @{
 Action = 'Accept'
 Name = $ProposedName
 }
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
$FullCustomTableSchemasPath = Join-Path $ScriptDirectory $CustomTableSchemasDirectory

Write-DCRInfo "Starting Azure Data Collection Rules deployment for Cribl Integration..." -Color Cyan
Write-DCRVerbose "Script directory: $ScriptDirectory"
Write-DCRVerbose "Azure parameters file: $FullAzureParametersPath"
Write-DCRVerbose "Operation parameters file: $FullOperationParametersPath"
Write-DCRVerbose "Native table list file: $FullTableListPath"
Write-DCRVerbose "DCR template (with DCE): $FullDCRTemplateWithDCEPath"
Write-DCRVerbose "DCR template (Direct): $FullDCRTemplateDirectPath"
if (-not $SkipCriblExport) {
 Write-DCRInfo " Cribl config will be exported to: cribl-dcr-configs\cribl-dcr-config.json" -Color Magenta
} else {
 Write-DCRWarning "⏭ Cribl config export disabled"
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
 Write-Warning " Potential collision: Found custom table '$variant' while looking for native table '$TableName'"
 Write-Warning " This should not happen - native table mode should not find _CL tables"
 continue # Skip this variant and continue looking
 }
 Write-DCRVerbose " Debug: Found table schema for $variant"
 
 # Debug the schema structure
 if ($response.properties.schema) {
 $schemaType = $response.properties.schema.GetType().Name
 Write-DCRInfo " Debug: Schema type: $schemaType" -Color Magenta
 if ($response.properties.schema.columns) {
 $columnCount = @($response.properties.schema.columns).Count
 Write-DCRInfo " Debug: Schema has $columnCount columns in .columns property" -Color Magenta
 }
 if ($response.properties.schema.standardColumns) {
 $standardCount = @($response.properties.schema.standardColumns).Count
 Write-DCRInfo " Debug: Schema has $standardCount columns in .standardColumns property" -Color Magenta
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
 Write-DCRWarning " Debug: Native table not found. Checked variants: $($tableVariants -join ', ')"
 Write-DCRWarning " Note: Custom table with similar name (${TableName}_CL) will NOT be used for native table processing"
 } else {
 Write-DCRWarning " Debug: Custom table not found. Checked variants: $($tableVariants -join ', ')"
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
 Exists = $null # Unknown state
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
 Write-DCRInfo " Debug: TableSchema type: $($TableSchema.GetType().Name)" -Color Magenta
 if ($TableSchema) {
 $properties = $TableSchema | Get-Member -MemberType NoteProperty | Select-Object -ExpandProperty Name
 Write-DCRInfo " Debug: TableSchema properties: $($properties -join ', ')" -Color Magenta
 }
 
 # Azure returns columns in different properties for custom vs native tables:
 # - Custom tables: .columns contains all user columns, .standardColumns has system columns
 # - Native tables: .standardColumns or .columns contains the table schema
 
 $schemaColumns = $null
 
 if ($CustomTableMode) {
 # For custom tables, prefer .columns (DCR-based) but fall back to .standardColumns (MMA legacy)
 if ($TableSchema -and $TableSchema.columns) {
 Write-DCRInfo " Debug: Custom table - using .columns property (DCR-based table)" -Color Magenta
 $schemaColumns = $TableSchema.columns
 } elseif ($TableSchema -and $TableSchema.standardColumns) {
 Write-DCRWarning " Debug: Custom table - using .standardColumns property (MMA legacy table)"
 Write-DCRWarning " Note: This appears to be an MMA (legacy) table. Consider migrating to DCR-based format."
 $schemaColumns = $TableSchema.standardColumns
 } else {
 Write-DCRError " Debug: Custom table - no .columns or .standardColumns property found!"
 }
 } else {
 # For native tables, try standardColumns first, then columns
 if ($TableSchema -and $TableSchema.standardColumns) {
 # Additional safety check: if standardColumns only has TenantId, this might be a custom table
 $standardColCount = @($TableSchema.standardColumns).Count
 if ($standardColCount -eq 1 -and $TableSchema.standardColumns[0].name -eq "TenantId" -and $TableSchema.columns) {
 Write-Warning " Detected possible custom table schema (only TenantId in standardColumns)"
 Write-Warning " This might indicate the wrong table was retrieved. Verify table name."
 # Use columns instead for native tables if standardColumns seems wrong
 Write-DCRWarning " Debug: Native table - using .columns property due to suspicious standardColumns"
 $schemaColumns = $TableSchema.columns
 } else {
 Write-DCRInfo " Debug: Native table - using .standardColumns property" -Color Magenta
 $schemaColumns = $TableSchema.standardColumns
 }
 } elseif ($TableSchema -and $TableSchema.columns) {
 Write-DCRInfo " Debug: Native table - using .columns property (fallback)" -Color Magenta
 $schemaColumns = $TableSchema.columns
 }
 }
 
 # Handle edge cases
 if (-not $schemaColumns -and $TableSchema -is [array]) {
 Write-DCRInfo " Debug: TableSchema is already an array of columns" -Color Magenta
 $schemaColumns = $TableSchema
 }
 
 if (-not $schemaColumns) {
 Write-DCRError " Debug: Unable to find columns in schema structure!"
 }
 
 if ($schemaColumns) {
 # Ensure it's an array (PowerShell unwraps single-item arrays)
 $schemaColumns = @($schemaColumns)
 Write-DCRInfo " Debug: schemaColumns count after array conversion: $($schemaColumns.Count)" -Color Magenta
 if ($schemaColumns.Count -eq 1) {
 Write-DCRInfo " Debug: Single column found - Name: $($schemaColumns[0].name), Type: $($schemaColumns[0].type)" -Color Magenta
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
 
 Write-DCRInfo " Schema Analysis:" -Color Cyan
 Write-DCRVerbose " Total columns from Azure: $($schemaColumns.Count)"
 
 # Count different types of filtered columns
 $systemFiltered = ($schemaColumns | Where-Object { $_.name -in $systemColumns }).Count
 $guidFiltered = ($schemaColumns | Where-Object { $_.type.ToLower() -in @('guid', 'uniqueidentifier', 'uuid') -and $_.name -notin $systemColumns }).Count
 $totalFiltered = $schemaColumns.Count - $filteredColumns.Count
 
 Write-DCRVerbose " System columns filtered: $systemFiltered"
 Write-DCRWarning " GUID columns filtered: $guidFiltered"
 Write-DCRVerbose " Total filtered: $totalFiltered"
 Write-DCRVerbose " Columns to include in DCR: $($filteredColumns.Count)"
 
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
 Write-DCRVerbose " Type Conversions:"
 foreach ($originalType in $typeConversions.Keys | Sort-Object) {
 $convertedType = $typeConversions[$originalType]
 if ($originalType -ne $convertedType) {
 Write-DCRWarning " $originalType -> $convertedType"
 } else {
 Write-DCRVerbose " $originalType (no change)"
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
 
 Write-DCRWarning "`n$('='*80)"
 Write-DCRWarning "MANUAL DEPLOYMENT RECOMMENDED: $TableName"
 Write-DCRWarning "$('='*80)"
 Write-DCRError "Reason: $Reason"
 Write-DCRProgress "`nThe generated ARM template has been saved for manual deployment:"
 Write-DCRInfo "Template Location: $TemplatePath" -Color Cyan
 Write-DCRSuccess "`nUse Azure Portal -> Deploy a custom template for best results"
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
 Write-DCRVerbose " Retrieving Cribl config for DCR: $DCRName"
 
 # Get DCR details
 $dcr = Get-AzDataCollectionRule -ResourceGroupName $ResourceGroupName -Name $DCRName -ErrorAction Stop

 # Get full DCR via REST API to access logsIngestion endpoint (read-only property not exposed by PowerShell cmdlet)
 $dcrResource = $null
 try {
 $subscriptionId = (Get-AzContext).Subscription.Id
 $dcrResourceId = "/subscriptions/$subscriptionId/resourceGroups/$ResourceGroupName/providers/Microsoft.Insights/dataCollectionRules/$DCRName"
 $apiVersion = "2023-03-11"

 $restResult = Invoke-AzRestMethod -Method GET -Path "$dcrResourceId`?api-version=$apiVersion" -ErrorAction Stop

 if ($restResult.StatusCode -eq 200) {
 $dcrResource = $restResult.Content | ConvertFrom-Json
 Write-DCRVerbose " Retrieved full DCR resource via REST API"
 } else {
 Write-DCRVerbose " REST API returned status: $($restResult.StatusCode)"
 }
 } catch {
 Write-DCRVerbose " Could not retrieve DCR via REST API: $($_.Exception.Message)"
 }

 $criblConfig = @{
 DCRName = $dcr.Name
 DCRImmutableId = $dcr.ImmutableId
 StreamName = ""
 TableName = ""
 IngestionEndpoint = ""
 Type = if ($dcr.Kind -eq "Direct") { "Direct" } else { "DCE-based" }
 }
 
 # Debug: Check what we have
 Write-DCRVerbose " DCR Type: $($criblConfig.Type)"
 Write-DCRVerbose " DCR Immutable ID: $($dcr.ImmutableId)"
 
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
 Write-DCRVerbose " Found template file: $templateName"
 try {
 $template = Get-Content $templatePath -Raw | ConvertFrom-Json
 if ($template.metadata) {
 if ($template.metadata.streamName) {
 $criblConfig.StreamName = $template.metadata.streamName
 Write-DCRSuccess " Got stream name from template: $($criblConfig.StreamName)"
 }
 if ($template.metadata.tableName) {
 $criblConfig.TableName = $template.metadata.tableName
 Write-DCRSuccess " Got table name from template: $($criblConfig.TableName)"
 }
 $templateFound = $true
 break
 }
 } catch {
 Write-Warning " Could not read template metadata: $($_.Exception.Message)"
 }
 }
 }
 }
 
 # If we didn't get stream/table from template, try to get from DCR data flows
 if (-not $templateFound -or -not $criblConfig.StreamName -or -not $criblConfig.TableName) {
 Write-DCRVerbose " Extracting from DCR data flows..."
 
 if ($dcr.DataFlows -and $dcr.DataFlows.Count -gt 0) {
 # First data flow
 $dataFlow = $dcr.DataFlows[0]
 
 # Debug: Show data flow structure
 Write-DCRVerbose " DataFlow properties: $($dataFlow.PSObject.Properties.Name -join ', ')"
 
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
 
 Write-DCRVerbose " Stream Name: $($criblConfig.StreamName)"
 Write-DCRVerbose " Table Name: $($criblConfig.TableName)"
 } else {
 Write-Warning " No data flows found in DCR"
 }
 }
 
 # Get ingestion endpoint
 if ($dcr.Kind -eq "Direct") {
 # For Direct DCRs, extract the logsIngestion endpoint from the DCR itself
 Write-DCRVerbose " Direct DCR - Extracting logsIngestion endpoint from DCR..."
 
 $endpoint = $null

 # Try REST API response first (most reliable for ARM properties)
 if ($dcrResource) {
 # Try properties.logsIngestion.endpoint (standard ARM path)
 if ($dcrResource.properties -and $dcrResource.properties.logsIngestion -and $dcrResource.properties.logsIngestion.endpoint) {
 $endpoint = $dcrResource.properties.logsIngestion.endpoint
 Write-DCRSuccess " Found at dcrResource.properties.logsIngestion.endpoint (REST API)"
 }
 # Try direct logsIngestion.endpoint
 elseif ($dcrResource.logsIngestion -and $dcrResource.logsIngestion.endpoint) {
 $endpoint = $dcrResource.logsIngestion.endpoint
 Write-DCRSuccess " Found at dcrResource.logsIngestion.endpoint (REST API)"
 }
 }
 # Try different property paths for logsIngestion from Get-AzDataCollectionRule
 elseif ($dcr.LogsIngestion) {
 if ($dcr.LogsIngestion.Endpoint) {
 $endpoint = $dcr.LogsIngestion.Endpoint
 Write-DCRVerbose " Found at LogsIngestion.Endpoint"
 } elseif ($dcr.LogsIngestion.endpoint) {
 $endpoint = $dcr.LogsIngestion.endpoint
 Write-DCRVerbose " Found at LogsIngestion.endpoint"
 }
 } elseif ($dcr.Properties -and $dcr.Properties.LogsIngestion) {
 if ($dcr.Properties.LogsIngestion.Endpoint) {
 $endpoint = $dcr.Properties.LogsIngestion.Endpoint
 Write-DCRVerbose " Found at Properties.LogsIngestion.Endpoint"
 } elseif ($dcr.Properties.LogsIngestion.endpoint) {
 $endpoint = $dcr.Properties.LogsIngestion.endpoint
 Write-DCRVerbose " Found at Properties.LogsIngestion.endpoint"
 }
 } elseif ($dcr.Properties -and $dcr.Properties.logsIngestion) {
 if ($dcr.Properties.logsIngestion.endpoint) {
 $endpoint = $dcr.Properties.logsIngestion.endpoint
 Write-DCRVerbose " Found at Properties.logsIngestion.endpoint"
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
 Write-DCRVerbose " Found at PSObject.$prop.endpoint"
 break
 } elseif ($logsIngestion.Endpoint) {
 $endpoint = $logsIngestion.Endpoint
 Write-DCRVerbose " Found at PSObject.$prop.Endpoint"
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
 Write-DCRVerbose " Found via JSON parsing at properties.logsIngestion.endpoint"
 } elseif ($dcrJson.logsIngestion.endpoint) {
 $endpoint = $dcrJson.logsIngestion.endpoint
 Write-DCRVerbose " Found via JSON parsing at logsIngestion.endpoint"
 }
 } catch {
 Write-DCRVerbose " Could not parse JSON: $($_.Exception.Message)"
 }
 }
 
 if ($endpoint) {
 $criblConfig.IngestionEndpoint = $endpoint
 Write-DCRVerbose " Direct DCR - LogsIngestion Endpoint: $endpoint"
 } else {
 # Fallback to location-based construction if we can't find the logsIngestion endpoint
 Write-Warning " Could not extract logsIngestion endpoint from Direct DCR, using location-based fallback"
 $location = $dcr.Location.Replace(' ', '').ToLower()
 $criblConfig.IngestionEndpoint = "https://${location}.ingest.monitor.azure.com"
 Write-DCRWarning " Direct DCR - Fallback Ingestion Endpoint: $($criblConfig.IngestionEndpoint)"
 }
 } else {
 # For DCE-based DCRs, check different possible property names
 $dceId = $null
 
 # Try different property names for DCE ID
 if ($DCEResourceId) {
 $dceId = $DCEResourceId
 Write-DCRVerbose " Using provided DCE ID"
 } elseif ($dcr.DataCollectionEndpointId) {
 $dceId = $dcr.DataCollectionEndpointId
 Write-DCRVerbose " Found DataCollectionEndpointId in DCR"
 } elseif ($dcr.Properties -and $dcr.Properties.DataCollectionEndpointId) {
 $dceId = $dcr.Properties.DataCollectionEndpointId
 Write-DCRVerbose " Found DataCollectionEndpointId in Properties"
 } elseif ($dcr.PSObject.Properties['dataCollectionEndpointId']) {
 $dceId = $dcr.PSObject.Properties['dataCollectionEndpointId'].Value
 Write-DCRVerbose " Found dataCollectionEndpointId via PSObject"
 }
 
 if ($dceId) {
 Write-DCRVerbose " DCE Resource ID: $dceId"
 $dceResourceGroup = $dceId -split '/' | Select-Object -Index 4
 $dceName = $dceId -split '/' | Select-Object -Last 1
 
 Write-DCRVerbose " Retrieving DCE: $dceName from RG: $dceResourceGroup"
 
 try {
 $dce = Get-AzDataCollectionEndpoint -ResourceGroupName $dceResourceGroup -Name $dceName -ErrorAction Stop
 
 # Try different property names for ingestion endpoint
 # The actual property path can vary based on API version
 $endpoint = $null
 
 # Most common location
 if ($dce.LogsIngestionEndpoint) {
 $endpoint = $dce.LogsIngestionEndpoint
 Write-DCRVerbose " Found endpoint at LogsIngestionEndpoint"
 } 
 # Check in Properties
 elseif ($dce.Properties) {
 if ($dce.Properties.LogsIngestionEndpoint) {
 $endpoint = $dce.Properties.LogsIngestionEndpoint
 Write-DCRVerbose " Found endpoint at Properties.LogsIngestionEndpoint"
 } elseif ($dce.Properties.logsIngestionEndpoint) {
 $endpoint = $dce.Properties.logsIngestionEndpoint
 Write-DCRVerbose " Found endpoint at Properties.logsIngestionEndpoint"
 } elseif ($dce.Properties.logsIngestion -and $dce.Properties.logsIngestion.endpoint) {
 $endpoint = $dce.Properties.logsIngestion.endpoint
 Write-DCRVerbose " Found endpoint at Properties.logsIngestion.endpoint"
 }
 }
 # Check via PSObject
 if (-not $endpoint) {
 $propNames = @('LogsIngestionEndpoint', 'logsIngestionEndpoint', 'ConfigurationAccessEndpoint')
 foreach ($prop in $propNames) {
 if ($dce.PSObject.Properties[$prop] -and $dce.PSObject.Properties[$prop].Value) {
 $endpoint = $dce.PSObject.Properties[$prop].Value
 Write-DCRVerbose " Found endpoint at PSObject.$prop"
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
 Write-DCRVerbose " Found endpoint via JSON parsing"
 }
 } catch {}
 }
 
 if ($endpoint) {
 $criblConfig.IngestionEndpoint = $endpoint
 Write-DCRVerbose " DCE Ingestion Endpoint: $endpoint"
 } else {
 Write-Warning " DCE found but could not extract ingestion endpoint"
 Write-DCRVerbose " Available properties: $($dce.PSObject.Properties.Name -join ', ')"
 # Don't construct - this means we couldn't get the real endpoint
 $criblConfig.IngestionEndpoint = "[NEEDS MANUAL CONFIGURATION]"
 }
 } catch {
 Write-Warning " Could not retrieve DCE: $($_.Exception.Message)"
 # Try to construct from DCE name if we have it
 if ($dceName) {
 $location = $dcr.Location.Replace(' ', '').ToLower()
 $criblConfig.IngestionEndpoint = "https://${dceName}.${location}.ingest.monitor.azure.com"
 Write-DCRWarning " Using DCE-based fallback: $($criblConfig.IngestionEndpoint)"
 } else {
 # Final fallback to location-based endpoint
 $location = $dcr.Location.Replace(' ', '').ToLower()
 $criblConfig.IngestionEndpoint = "https://${location}.ingest.monitor.azure.com"
 Write-DCRWarning " Using location fallback: $($criblConfig.IngestionEndpoint)"
 }
 }
 } else {
 Write-Warning " No DCE ID found for DCE-based DCR"
 # Fallback to location-based endpoint
 $location = $dcr.Location.Replace(' ', '').ToLower()
 $criblConfig.IngestionEndpoint = "https://${location}.ingest.monitor.azure.com"
 Write-DCRWarning " Using fallback endpoint: $($criblConfig.IngestionEndpoint)"
 }
 }

 # Fallback: If StreamName or TableName is still empty, generate defaults based on DCR name
 if (-not $criblConfig.StreamName -or -not $criblConfig.TableName) {
 Write-DCRWarning " Generating fallback stream/table names from DCR name..."

 # Extract table name from DCR name (e.g., "dcr-jp-SecurityEvent-eastus" -> "SecurityEvent")
 # Pattern: dcr-<prefix>-<TableName>-<location>
 if ($DCRName -match '^dcr-[^-]+-([^-]+)-[^-]+$') {
 $tableName = $matches[1]
 Write-DCRVerbose " Extracted table name: $tableName"
 } elseif ($DCRName -match '^dcr-[^-]+-(.+)-[^-]+$') {
 # Handle abbreviated names like CSL
 $tableName = $matches[1]
 Write-DCRVerbose " Extracted abbreviated table name: $tableName"
 } else {
 # Last resort: use the full DCR name minus prefix/suffix
 $tableName = $DCRName -replace '^dcr-[^-]+-', '' -replace '-[^-]+$', ''
 Write-DCRVerbose " Using DCR-based table name: $tableName"
 }

 if (-not $criblConfig.StreamName) {
 # For native tables, input stream uses Custom- prefix
 $criblConfig.StreamName = "Custom-$tableName"
 Write-DCRWarning " Generated stream name: $($criblConfig.StreamName)"
 }

 if (-not $criblConfig.TableName) {
 $criblConfig.TableName = $tableName
 Write-DCRWarning " Generated table name: $($criblConfig.TableName)"
 }
 }

 Write-DCRSuccess " Cribl config retrieved successfully"
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
 
 Write-DCRInfo "`n CRIBL INTEGRATION CONFIGURATION" -Color Magenta
 Write-DCRInfo " " -Color Magenta
 Write-Host " DCR Immutable ID: " -NoNewline -ForegroundColor White
 Write-DCRWarning "$($CriblConfig.DCRImmutableId)"
 Write-Host " Ingestion Endpoint: " -NoNewline -ForegroundColor White
 Write-DCRWarning "$($CriblConfig.IngestionEndpoint)"
 Write-Host " Stream Name: " -NoNewline -ForegroundColor White
 Write-DCRWarning "$($CriblConfig.StreamName)"
 Write-Host " Target Table: " -NoNewline -ForegroundColor White
 Write-DCRWarning "$($CriblConfig.TableName)"
 Write-Host " DCR Type: " -NoNewline -ForegroundColor White
 Write-DCRInfo "$($CriblConfig.Type)" -Color Cyan
 Write-DCRInfo " " -Color Magenta
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
 Write-DCRWarning " Cleaning up old templates for $TableName (keeping $KeepVersions timestamped versions + latest):"
 foreach ($template in $templatesToDelete) {
 Write-DCRVerbose " Removing: $($template.Name)"
 Remove-Item -Path $template.FullName -Force
 }
 }
}

# Load operation parameters
if (-not $IgnoreOperationParameters -and (Test-Path $FullOperationParametersPath)) {
 Write-DCRWarning "Loading operation parameters from: $FullOperationParametersPath"
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

 # Load Private Link parameters
 $script:PrivateLinkEnabled = $false
 $script:DCEPublicNetworkAccess = "Enabled"
 $script:AMPLSResourceId = ""
 $script:AMPLSResourceGroupName = ""
 $script:AMPLSName = ""

 if ($operationParams.privateLink) {
 $script:PrivateLinkEnabled = $operationParams.privateLink.enabled
 $script:DCEPublicNetworkAccess = $operationParams.privateLink.dcePublicNetworkAccess
 $script:AMPLSResourceId = $operationParams.privateLink.amplsResourceId
 $script:AMPLSResourceGroupName = $operationParams.privateLink.amplsResourceGroupName
 $script:AMPLSName = $operationParams.privateLink.amplsName
 }

 Write-DCRSuccess "Operation parameters loaded successfully"
 Write-DCRInfo " Create DCE: $CreateDCE" -Color Cyan
 Write-DCRInfo " Template Only Mode: $TemplateOnly" -Color Cyan
 Write-DCRInfo " Custom Table Mode: $CustomTableMode" -Color Cyan

 if ($CreateDCE -and $script:PrivateLinkEnabled) {
 Write-DCRInfo " Private Link: ENABLED" -Color Magenta
 Write-Host " DCE Public Network Access: $script:DCEPublicNetworkAccess" -ForegroundColor $(if ($script:DCEPublicNetworkAccess -eq "Disabled") { "Green" } else { "Yellow" })
 if ($script:AMPLSResourceId) {
 Write-DCRVerbose " AMPLS Resource ID: $script:AMPLSResourceId"
 } elseif ($script:AMPLSName) {
 Write-DCRVerbose " AMPLS Name: $script:AMPLSName"
 }
 }
 
 if ($CustomTableMode) {
 Write-DCRInfo " Custom Table Settings:" -Color Cyan
 Write-DCRVerbose " Schemas Directory: $CustomTableSchemasDirectory"
 Write-DCRVerbose " Default Retention: $CustomTableRetentionDays days"
 Write-DCRVerbose " Default Total Retention: $CustomTableTotalRetentionDays days"
 if ($CustomTableListFile) {
 Write-DCRVerbose " Custom Table List File: $CustomTableListFile"
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

Write-DCRInfo "DCR Mode: $dcrMode" -Color Cyan
Write-DCRInfo "Processing Mode: $processingMode" -Color Cyan
Write-DCRInfo "Template file: $templateFile" -Color Cyan

# Load Azure parameters
Write-DCRWarning "Loading Azure parameters from: $FullAzureParametersPath"
try {
 if (!(Test-Path $FullAzureParametersPath)) { throw "Azure parameters file not found: $FullAzureParametersPath" }
 $azureParameters = Get-Content $FullAzureParametersPath | ConvertFrom-Json
 Write-DCRSuccess "Azure parameters loaded successfully"
} catch {
 Write-DCRError "Failed to load Azure parameters: $($_.Exception.Message)"
 exit 1
}

# Load table list - use custom table list if in custom mode and file specified
$tableListPath = if ($CustomTableMode -and $CustomTableListFile) {
 Join-Path $ScriptDirectory $CustomTableListFile
} else {
 $FullTableListPath
}

Write-DCRWarning "Loading table list from: $tableListPath"
try {
 if (!(Test-Path $tableListPath)) { throw "Table list file not found: $tableListPath" }
 $tableList = Get-Content $tableListPath | ConvertFrom-Json
 Write-DCRSuccess "Table list loaded successfully - Found $($tableList.Count) tables"
} catch {
 Write-DCRError "Failed to load table list: $($_.Exception.Message)"
 exit 1
}

# Create custom table schemas directory if it doesn't exist (in custom table mode)
if ($CustomTableMode) {
 if (!(Test-Path $FullCustomTableSchemasPath)) {
 Write-DCRWarning "Creating custom table schemas directory: $FullCustomTableSchemasPath"
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
 Write-DCRVerbose " Created sample schema file: $sampleSchemaPath"
 }
}

# Load DCR template
Write-DCRWarning "Loading DCR template from: $templateFile"
try {
 if (!(Test-Path $templateFile)) { throw "DCR template file not found: $templateFile" }
 $dcrTemplate = Get-Content $templateFile -Raw | ConvertFrom-Json
 Write-DCRSuccess "DCR template loaded successfully ($dcrMode)"
} catch {
 Write-DCRError "Failed to load DCR template: $($_.Exception.Message)"
 exit 1
}

# Filter table list if specific DCR requested
if ($SpecificDCR) {
 $tableList = $tableList | Where-Object { $_ -eq $SpecificDCR }
 if ($tableList.Count -eq 0) {
 Write-DCRError "No table found for DCR: $SpecificDCR"
 exit 1
 }
 Write-DCRSuccess "Processing specific DCR: $SpecificDCR"
}

# Extract Azure parameters
$ResourceGroupName = $azureParameters.resourceGroupName
$WorkspaceName = $azureParameters.workspaceName
$DCRPrefix = $azureParameters.dcrPrefix
$DCRSuffix = $azureParameters.dcrSuffix
$Location = $azureParameters.location
$SubscriptionId = $azureParameters.subscriptionId

# Set Azure subscription context
if ($SubscriptionId -and $SubscriptionId -ne "<YOUR-SUBSCRIPTION-ID-HERE>") {
 try {
 Write-DCRInfo "Setting Azure subscription context to: $SubscriptionId" -Color Cyan
 Set-AzContext -SubscriptionId $SubscriptionId -ErrorAction Stop | Out-Null
 Write-DCRSuccess " Azure subscription context set successfully"
 } catch {
 Write-DCRWarning " Warning: Failed to set subscription context. Using current subscription."
 Write-DCRWarning " Error: $($_.Exception.Message)"
 }
} else {
 Write-DCRWarning " No subscription ID configured in azure-parameters.json. Using current Azure context subscription."
}

# DCE parameters (only used if CreateDCE is true)
if ($CreateDCE) {
 $DCEResourceGroupName = $azureParameters.resourceGroupName
 $DCEPrefix = $azureParameters.dcePrefix
 $DCESuffix = $azureParameters.dceSuffix
}

Write-DCRProgress "Global Configuration:"
Write-DCRVerbose " Resource Group: $ResourceGroupName"
Write-DCRVerbose " Workspace: $WorkspaceName"
Write-DCRVerbose " Location: $Location"
Write-DCRInfo " DCR Mode: $dcrMode" -Color Cyan
Write-DCRInfo " Processing Mode: $processingMode" -Color Cyan
if ($CreateDCE) {
 Write-DCRVerbose " DCE Resource Group: $DCEResourceGroupName"
}

# Install required modules (required even in template-only mode for schema retrieval)
Write-DCRWarning "Checking required PowerShell modules..."
try {
 $requiredModules = @("Az.OperationalInsights", "Az.Monitor", "Az.Resources")
 foreach ($module in $requiredModules) {
 if (!(Get-Module -ListAvailable $module)) {
 Write-DCRWarning "Installing $module..."
 Install-Module -Name $module -Repository PSGallery -Force -AllowClobber -Scope CurrentUser
 Write-DCRSuccess "$module module installed"
 } else {
 Write-DCRSuccess "$module module already available"
 }
 }
 
 if ($TemplateOnly) {
 Write-DCRWarning "Template-only mode: Azure modules required for schema retrieval"
 }
} catch {
 Write-DCRError "Failed to install modules: $($_.Exception.Message)"
 exit 1
}

# Check for existing Azure session (required even in template-only mode for schema retrieval)
Write-DCRWarning "Checking Azure connection..."
try {
 $context = Get-AzContext -ErrorAction SilentlyContinue
 if (!$context) {
 Write-DCRError " No Azure context found. Please run 'Connect-AzAccount' first."
 Write-DCRWarning " This script requires an existing Azure session to proceed."
 exit 1
 } else {
 Write-DCRSuccess "Found Azure context for: $($context.Account.Id)"
 Write-DCRVerbose " Subscription: $($context.Subscription.Name) ($($context.Subscription.Id))"

 # Test if the context is still valid by making a simple API call
 Write-DCRVerbose " Testing context validity..."
 try {
 $testSubscription = Get-AzSubscription -SubscriptionId $context.Subscription.Id -ErrorAction Stop | Out-Null
 Write-DCRSuccess " Context is valid"
 } catch {
 # Token is expired or invalid - try to refresh it
 Write-DCRWarning " Token expired. Attempting automatic refresh..."

 try {
 # Try to refresh using existing context info without interactive prompts
 if ($context -and $context.Account -and $context.Account.Id) {
 # For user accounts, try silent refresh
 if ($context.Account.Type -ne 'ServicePrincipal') {
 try {
 # Try to get a new access token using the existing context
 $token = Get-AzAccessToken -ResourceUrl "https://management.azure.com/" -ErrorAction Stop
 if ($token -and $token.Token) {
 Write-DCRSuccess " Token refreshed successfully"
 # Test again to confirm
 $testSubscription = Get-AzSubscription -SubscriptionId $context.Subscription.Id -ErrorAction Stop | Out-Null
 Write-DCRSuccess " Context is now valid"
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
 Write-DCRSuccess " Azure connection refreshed successfully"
 }
 }
 catch {
 Write-DCRError " Failed to refresh token automatically"
 Write-DCRWarning " Please run 'Connect-AzAccount' to refresh your session"
 Write-DCRVerbose " Error: $($_.Exception.Message)"
 exit 1
 }
 }
 } else {
 # Service Principal - cannot refresh automatically
 Write-DCRError " Service Principal session expired. Please re-authenticate."
 exit 1
 }
 } else {
 Write-DCRError " Cannot refresh - insufficient context information"
 Write-DCRWarning " Please run 'Connect-AzAccount' to refresh your session"
 exit 1
 }
 }
 catch {
 Write-DCRError " Token refresh failed: $($_.Exception.Message)"
 Write-DCRWarning " Please run 'Connect-AzAccount' to refresh your session"
 exit 1
 }
 }
 }

 if ($TemplateOnly) {
 Write-DCRWarning "Template-only mode: Using existing Azure session for schema retrieval"
 }
} catch {
 Write-DCRError " Error checking Azure session: $($_.Exception.Message)"
 Write-DCRWarning " Please ensure you have an active Azure session by running 'Connect-AzAccount'"
 exit 1
}

# Verify workspace (required even in template-only mode for schema retrieval)
Write-DCRWarning "Verifying Log Analytics workspace..."
Write-DCRVerbose " Resource Group: $ResourceGroupName"
Write-DCRVerbose " Workspace Name: $WorkspaceName"

# First check if the resource group exists
try {
 Write-DCRVerbose " Checking if resource group exists..."
 $rg = Get-AzResourceGroup -Name $ResourceGroupName -ErrorAction Stop
 Write-DCRSuccess " Resource group found: $($rg.Location)"
} catch {
 Write-DCRError " Resource group not found: $ResourceGroupName"
 Write-DCRError " Error: $($_.Exception.Message)"
 Write-DCRError ""
 Write-DCRWarning " Please verify your azure-parameters.json file contains the correct:"
 Write-DCRWarning " - resourceGroupName"
 Write-DCRWarning " - Ensure you're in the correct subscription"
 
 # List available resource groups
 Write-DCRWarning ""
 Write-DCRWarning " Available resource groups in current subscription:"
 $availableRGs = Get-AzResourceGroup | Select-Object -First 10
 foreach ($availRg in $availableRGs) {
 Write-DCRVerbose " - $($availRg.ResourceGroupName)"
 }
 if ((Get-AzResourceGroup).Count -gt 10) {
 Write-DCRVerbose " ... and $((Get-AzResourceGroup).Count - 10) more"
 }
 exit 1
}

# Now check for the workspace
try {
 Write-DCRVerbose " Checking for workspace '$WorkspaceName' in resource group..."
 $workspace = Get-AzOperationalInsightsWorkspace -ResourceGroupName $ResourceGroupName -Name $WorkspaceName -ErrorAction Stop
 Write-DCRSuccess " Workspace found: $($workspace.Name)"
 $workspaceResourceId = $workspace.ResourceId
 Write-DCRVerbose " Workspace ID: $workspaceResourceId"
 
 if ($TemplateOnly) {
 Write-DCRWarning "Template-only mode: Workspace verified for schema retrieval"
 }
} catch {
 Write-DCRError " Workspace not found: '$WorkspaceName' in resource group '$ResourceGroupName'"
 Write-DCRError " Error: $($_.Exception.Message)"
 
 # List available workspaces in the resource group
 Write-DCRWarning ""
 Write-DCRWarning " Checking for available workspaces in resource group '$ResourceGroupName':"
 try {
 $availableWorkspaces = Get-AzOperationalInsightsWorkspace -ResourceGroupName $ResourceGroupName -ErrorAction Stop
 if ($availableWorkspaces) {
 Write-DCRWarning " Found $($availableWorkspaces.Count) workspace(s):"
 foreach ($ws in $availableWorkspaces) {
 Write-DCRVerbose " - $($ws.Name)"
 }
 } else {
 Write-DCRError " No workspaces found in this resource group"
 }
 } catch {
 Write-DCRError " Could not list workspaces: $($_.Exception.Message)"
 }
 
 Write-DCRWarning ""
 Write-DCRWarning " Please verify your azure-parameters.json file contains the correct:"
 Write-DCRWarning " - resourceGroupName: $ResourceGroupName" 
 Write-DCRWarning " - workspaceName: $WorkspaceName"
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
 Write-DCRWarning "Loading existing Cribl configuration..."
 $existingConfig = Get-Content $criblConfigPath -Raw | ConvertFrom-Json
 if ($existingConfig.DCRs) {
 $script:allCriblConfigs = @($existingConfig.DCRs)
 Write-DCRSuccess " Loaded $($script:allCriblConfigs.Count) existing DCR configurations"
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
 Write-DCRSuccess "Created templates directory: $templatesDir"
}

# Process each table
Write-DCRInfo "`n$('='*80)" -Color Cyan
if ($TemplateOnly) {
 Write-DCRInfo "GENERATING TEMPLATES ($dcrMode DCRs - $processingMode)" -Color Cyan
} else {
 Write-DCRInfo "PROCESSING TABLES ($dcrMode DCRs - $processingMode)" -Color Cyan
}
Write-DCRInfo "$('='*80)" -Color Cyan

foreach ($tableName in $tableList) {
 $summary.DCRsProcessed++
 Write-DCRWarning "`n--- Processing: $tableName ---"
 
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
 Write-DCRWarning " ⏭ Skipped custom table: $tableName (user choice)"
 $summary.TablesSkipped++
 continue
 } else {
 Write-DCRError " Failed to process custom table: $tableName"
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
 Write-DCRInfo " Retrieving table schema from Azure..." -Color Cyan
 $tableInfo = Get-LogAnalyticsTableSchema -WorkspaceResourceId $workspaceResourceId -TableName $tableName
 
 if ($tableInfo.Exists -ne $true) {
 Write-DCRError " Table not found in Azure - cannot proceed without schema"
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
 $maxDCRNameLength = if ($CreateDCE) { 64 } else { 30 } # Direct DCRs have stricter 30-char limit
 $originalDCRNameLength = $DCRName.Length # Store original length before abbreviation

 if ($DCRName.Length -gt $maxDCRNameLength) {
 Write-DCRWarning " Warning: DCR name '$DCRName' ($($DCRName.Length) chars) exceeds $maxDCRNameLength character limit for $dcrMode DCRs"
 
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
 
 Write-DCRWarning " DCR name shortened to: $DCRName ($($DCRName.Length) chars)"
 }
 
 # Ensure DCR name meets Azure naming requirements
 $DCRName = $DCRName.Trim('-') # Remove leading/trailing hyphens
 if ($DCRName.Length -lt 3) {
 throw "DCR name '$DCRName' is too short (minimum 3 characters required)"
 }

 # Track if name was abbreviated for confirmation prompt
 $wasAbbreviated = ($originalDCRNameLength -gt $maxDCRNameLength)

 # Confirmation prompt if ConfirmDCRNames is enabled
 if ($ConfirmDCRNames) {
 $confirmation = Confirm-ResourceName -ResourceType "DCR" `
 -ProposedName $DCRName `
 -TableName $dcrTableName `
 -MaxLength $maxDCRNameLength `
 -WasAbbreviated $wasAbbreviated

 if ($confirmation.Action -eq 'Skip') {
 Write-DCRWarning " Skipping DCR for table: $dcrTableName"
 continue
 }

 # Use confirmed or custom name
 $DCRName = $confirmation.Name
 }

 Write-DCRProgress " DCR Name: $DCRName"
 Write-DCRInfo " DCR Mode: $dcrMode" -Color Cyan
 Write-DCRInfo " Table Type: $(if ($CustomTableMode) { 'Custom' } else { 'Native' })" -Color Cyan
 if ($CustomTableMode) {
 Write-DCRVerbose " Actual Table Name: $actualTableName"
 }
 
 if ($TemplateOnly) {
 Write-DCRWarning " Template-only mode: Skipping Azure resource checks"
 }
 
 # DCE handling (only if CreateDCE is true)
 $dceResourceId = $null
 if ($CreateDCE) {
 $DCEName = "${DCEPrefix}${dcrTableName}-${Location}"
 if (![string]::IsNullOrWhiteSpace($DCESuffix)) { $DCEName = "${DCEName}-${DCESuffix}" }

 # Confirmation prompt for DCE name if ConfirmDCRNames is enabled
 if ($ConfirmDCRNames) {
 $dceConfirmation = Confirm-ResourceName -ResourceType "DCE" `
 -ProposedName $DCEName `
 -TableName $dcrTableName `
 -MaxLength 64 `
 -WasAbbreviated $false

 if ($dceConfirmation.Action -eq 'Skip') {
 Write-DCRWarning " Skipping DCE for table: $dcrTableName (DCR will also be skipped)"
 continue
 }

 # Use confirmed or custom name
 $DCEName = $dceConfirmation.Name
 }

 Write-DCRProgress " DCE Name: $DCEName"

 if ($TemplateOnly) {
 # For template-only mode, create placeholder DCE resource ID
 $subscriptionId = "00000000-0000-0000-0000-000000000000"
 $dceResourceId = "/subscriptions/$subscriptionId/resourceGroups/$DCEResourceGroupName/providers/Microsoft.Insights/dataCollectionEndpoints/$DCEName"
 Write-DCRWarning " Template-only mode: Using placeholder DCE ID"
 } else {
 # Verify or create DCE
 try {
 $dce = Get-AzDataCollectionEndpoint -ResourceGroupName $DCEResourceGroupName -Name $DCEName -ErrorAction Stop
 Write-DCRSuccess " DCE found: $($dce.Name)"
 $dceResourceId = $dce.Id
 $summary.DCEsExisted++
 } catch {
 Write-DCRWarning " Creating DCE..."

 # Determine network access setting
 $networkAccess = if ($script:PrivateLinkEnabled -and $script:DCEPublicNetworkAccess) {
 $script:DCEPublicNetworkAccess
 } else {
 "Enabled"
 }

 $dceParams = @{
 ResourceGroupName = $DCEResourceGroupName
 Name = $DCEName
 Location = $Location
 NetworkAclsPublicNetworkAccess = $networkAccess
 }

 Write-Host " DCE Network Access: $networkAccess" -ForegroundColor $(if ($networkAccess -eq "Disabled") { "Green" } else { "Cyan" })

 $dce = New-AzDataCollectionEndpoint @dceParams -ErrorAction Stop
 Write-DCRSuccess " DCE created: $($dce.Name)"
 $dceResourceId = $dce.Id
 $summary.DCEsCreated++

 # Apply owner tag if configured
 if ($AzureParams.ownerTag -and $AzureParams.ownerTag -ne "<YOUR-EMAIL-OR-NAME-HERE>") {
 try {
 $dceResource = Get-AzResource -ResourceId $dceResourceId -ErrorAction Stop
 $tags = if ($dceResource.Tags) { $dceResource.Tags } else { @{} }
 $tags["Owner"] = $AzureParams.ownerTag
 Set-AzResource -ResourceId $dceResourceId -Tag $tags -Force -ErrorAction Stop | Out-Null
 Write-DCRVerbose " Owner tag applied: $($AzureParams.ownerTag)"
 } catch {
 Write-DCRWarning " Failed to apply owner tag: $($_.Exception.Message)"
 }
 }

 # Add DCE to AMPLS if Private Link is enabled
 if ($script:PrivateLinkEnabled -and $networkAccess -eq "Disabled") {
 if ($script:AMPLSResourceId -or ($script:AMPLSResourceGroupName -and $script:AMPLSName)) {
 $amplsAdded = Add-DCEToAMPLS `
 -DCEResourceId $dceResourceId `
 -AMPLSResourceId $script:AMPLSResourceId `
 -AMPLSResourceGroupName $script:AMPLSResourceGroupName `
 -AMPLSName $script:AMPLSName

 if ($amplsAdded) {
 Write-DCRSuccess " Private Link configured for DCE"
 } else {
 Write-Warning " DCE created but AMPLS association failed. Configure Private Link manually."
 }
 } else {
 Write-Warning " Private Link enabled but no AMPLS configured. DCE created with private-only access but not associated with AMPLS."
 Write-DCRWarning " Please manually add DCE to AMPLS in Azure Portal"
 }
 }
 }
 }
 }
 
 # Check if DCR already exists (skip in template-only mode)
 if (-not $TemplateOnly) {
 $existingDCR = Get-AzDataCollectionRule -ResourceGroupName $ResourceGroupName -Name $DCRName -ErrorAction SilentlyContinue
 if ($existingDCR) {
 Write-DCRWarning " DCR already exists - skipping deployment"
 $summary.DCRsExisted++
 
 # Still capture Cribl config for existing DCRs
 if (-not $SkipCriblExport -or $ShowCriblConfig) {
 Write-DCRInfo " Capturing Cribl config for existing DCR..." -Color Cyan
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
 Write-DCRInfo " Processing table schema..." -Color Cyan
 
 if ($TemplateOnly) {
 Write-DCRWarning " Template-only mode: Using schema from $(if ($CustomTableMode -and $customTableResult.Source -eq 'Created') { 'file' } else { 'Azure' })"
 }
 
 $summary.TablesValidated++
 $summary.SchemasRetrieved++
 $columns = Get-TableColumns -TableName $actualTableName -TableSchema $tableSchema
 
 if ($columns -eq $null -or $columns.Count -eq 0) {
 Write-DCRError " Failed to process table schema - no valid columns found"
 Write-DCRWarning " This usually means all columns were filtered out as system columns"
 Write-DCRWarning " For custom tables, consider if the table has user-defined columns"
 if ($CustomTableMode) {
 Write-DCRWarning " CloudFlare_CL should have columns like RayID, ClientIP, etc."
 Write-DCRWarning " If table was just created, it might only have system columns"
 Write-DCRWarning " Consider recreating the table with the schema file"
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
 $outputStreamName = "Custom-$actualTableName" # Custom tables use Custom- for output too!
 } else {
 $streamName = "Custom-$actualTableName"
 $outputStreamName = "Microsoft-$actualTableName" # Native tables use Microsoft- for output
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
 
 Write-DCRVerbose " Template saved: $dcrTableName-$timestamp.json"
 Write-DCRVerbose " Latest template: $dcrTableName-latest.json"
 Write-DCRInfo " Stream names hardcoded:" -Color Cyan
 Write-DCRVerbose " Input stream: $streamName"
 Write-DCRVerbose " Output stream: $outputStreamName"
 if ($CustomTableMode) {
 Write-DCRWarning " Note: Custom tables require 'Custom-' prefix for both streams"
 }
 if ($TemplateOnly) {
 Write-DCRWarning " Template is standalone: columns embedded, resource IDs blank by default"
 }
 
 # Cleanup old templates
 if ($CleanupOldTemplates) {
 Invoke-TemplateCleanup -TemplatesDirectory $templatesDir -TableName $dcrTableName -KeepVersions $KeepTemplateVersions
 }
 
 # Analyze template
 $templateSize = $templateJson.Length
 $recommendation = Get-TemplateDeploymentRecommendation -TableSchema $tableSchema -TableName $actualTableName -TemplateSize $templateSize
 
 Write-DCRInfo " Template Analysis:" -Color Cyan
 Write-DCRVerbose " Size: $([math]::Round($templateSize/1024, 1)) KB"
 Write-DCRVerbose " Columns: $($columns.Count)"
 Write-DCRVerbose " Complexity: $($recommendation.EstimatedComplexity)"
 
 # Check deployment recommendation
 if (-not $recommendation.ShouldDeploy) {
 Write-DCRError " Automatic deployment not recommended"
 $summary.ManualDeploymentRecommended++
 $summary.ManualDeploymentCases += @{
 TableName = $actualTableName; Reason = $recommendation.Reason
 TemplatePath = $templatePath; DCRName = $DCRName
 }
 Show-ManualDeploymentInstructions -TableName $actualTableName -TemplatePath $templatePath -DCRName $DCRName -ResourceGroupName $ResourceGroupName -Location $Location -WorkspaceResourceId $workspaceResourceId -EndpointResourceId $dceResourceId -Reason $recommendation.Reason -UseDCE $CreateDCE
 continue
 }
 
 # Validate template structure
 Write-DCRInfo " Validating template structure..." -Color Cyan
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
 
 Write-DCRSuccess " Template validation passed"
 
 } catch {
 Write-DCRError " Template validation failed: $($_.Exception.Message)"
 $summary.ProcessingFailures += "Template validation failed for ${actualTableName}: $($_.Exception.Message)"
 continue
 }
 
 # Deploy DCR (skip in template-only mode)
 if ($TemplateOnly) {
 Write-DCRSuccess " Template generated successfully (template-only mode)"
 Write-DCRInfo " Template location: $latestTemplatePath" -Color Cyan
 } else {
 Write-DCRInfo " Deploying $dcrMode DCR using generated template..." -Color Cyan
 
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
 TemplateFile = $latestTemplatePath # Use the generated template with hardcoded values
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
 Write-DCRSuccess " $dcrMode DCR deployed successfully!"
 $summary.DCRsCreated++

 if ($deploymentResult.Outputs -and $deploymentResult.Outputs.dataCollectionRuleId) {
 $dcrId = $deploymentResult.Outputs.dataCollectionRuleId.Value
 Write-DCRVerbose " DCR Resource ID: $dcrId"

 # Apply owner tag if configured
 if ($AzureParams.ownerTag -and $AzureParams.ownerTag -ne "<YOUR-EMAIL-OR-NAME-HERE>") {
 try {
 $dcrResource = Get-AzResource -ResourceId $dcrId -ErrorAction Stop
 $tags = if ($dcrResource.Tags) { $dcrResource.Tags } else { @{} }
 $tags["Owner"] = $AzureParams.ownerTag
 Set-AzResource -ResourceId $dcrId -Tag $tags -Force -ErrorAction Stop | Out-Null
 Write-DCRVerbose " Owner tag applied: $($AzureParams.ownerTag)"
 } catch {
 Write-DCRWarning " Failed to apply owner tag: $($_.Exception.Message)"
 }
 }
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
 Write-DCRError " Template deployment validation failed"
 
 # Try to get detailed error information
 try {
 Start-Sleep -Seconds 2
 $deployment = Get-AzResourceGroupDeployment -ResourceGroupName $ResourceGroupName -Name $deploymentName -ErrorAction SilentlyContinue
 if ($deployment -and $deployment.StatusMessage) {
 try {
 $statusObj = $deployment.StatusMessage | ConvertFrom-Json
 if ($statusObj.error -and $statusObj.error.message) {
 Write-DCRError " Error Details: $($statusObj.error.message)"
 if ($statusObj.error.details) {
 foreach ($detail in $statusObj.error.details) {
 Write-DCRError " - $($detail.message)"
 }
 }
 }
 } catch {
 Write-DCRError " Raw Status: $($deployment.StatusMessage)"
 }
 }
 } catch {
 Write-DCRWarning " Could not retrieve detailed error information"
 }
 
 # Recommend manual deployment for complex failures
 Write-DCRInfo " Recommendation: Deploy manually through Azure Portal for better error diagnostics" -Color Cyan
 $summary.ManualDeploymentRecommended++
 $summary.ManualDeploymentCases += @{
 TableName = $actualTableName; Reason = "PowerShell deployment failed - $deploymentError"
 TemplatePath = $templatePath; DCRName = $DCRName
 }
 Show-ManualDeploymentInstructions -TableName $actualTableName -TemplatePath $latestTemplatePath -DCRName $DCRName -ResourceGroupName $ResourceGroupName -Location $Location -WorkspaceResourceId $workspaceResourceId -EndpointResourceId $dceResourceId -Reason "PowerShell deployment failed with template validation error" -UseDCE $CreateDCE
 continue
 }
 
 Write-DCRError " Deployment failed: $deploymentError"
 $summary.ManualDeploymentRecommended++
 $summary.ManualDeploymentCases += @{
 TableName = $actualTableName; Reason = "PowerShell deployment failed"
 TemplatePath = $templatePath; DCRName = $DCRName
 }
 Show-ManualDeploymentInstructions -TableName $actualTableName -TemplatePath $latestTemplatePath -DCRName $DCRName -ResourceGroupName $ResourceGroupName -Location $Location -WorkspaceResourceId $workspaceResourceId -EndpointResourceId $dceResourceId -Reason "PowerShell deployment failed" -UseDCE $CreateDCE
 continue
 }
 }
 
 Write-DCRSuccess " Completed: $actualTableName"
 
 } catch {
 $exceptionMessage = $_.Exception.Message
 Write-DCRError " Exception processing ${tableName}: $exceptionMessage"
 $summary.ProcessingFailures += "Exception processing ${tableName}: $exceptionMessage"
 }
}

# Template Management Summary
Write-DCRWarning "`nTemplate Management..."
if (Test-Path $templatesDir) {
 $allTemplates = Get-ChildItem -Path $templatesDir -Filter "*.json" | Sort-Object Name
 $latestTemplates = $allTemplates | Where-Object { $_.Name -like "*-latest.json" }
 $timestampedTemplates = $allTemplates | Where-Object { $_.Name -notlike "*-latest.json" }
 
 Write-DCRInfo "Templates directory: $templatesDir" -Color Cyan
 Write-DCRVerbose "Total templates: $($allTemplates.Count) ($($latestTemplates.Count) latest, $($timestampedTemplates.Count) archived)"
 
 if ($summary.ManualDeploymentRecommended -gt 0) {
 Write-DCRProgress "`nManual deployment templates:"
 foreach ($case in $summary.ManualDeploymentCases) {
 $latestPath = Join-Path $templatesDir "$($case.TableName)-latest.json"
 Write-DCRVerbose " - $($case.TableName): $latestPath"
 }
 }
 
 Write-DCRInfo "`nTemplate Usage:" -Color Cyan
 Write-DCRVerbose " Latest templates: Use *-latest.json files for current deployments"
 Write-DCRVerbose " Archived templates: Timestamped versions for version control"
 Write-DCRVerbose " Manual deployment: Copy template content to Azure Portal or use Azure CLI"
}

# Display final summary
Write-DCRInfo "`n$('='*80)" -Color Cyan
if ($TemplateOnly) {
 Write-DCRInfo "TEMPLATE GENERATION SUMMARY ($dcrMode DCRs - $processingMode)" -Color Cyan
} else {
 Write-DCRInfo "EXECUTION SUMMARY ($dcrMode DCRs - $processingMode)" -Color Cyan
}
Write-DCRInfo "$('='*80)" -Color Cyan

Write-DCRProgress "Results:"
Write-DCRVerbose " DCRs Processed: $($summary.DCRsProcessed)"
Write-DCRSuccess " DCRs Created: $($summary.DCRsCreated)"
Write-DCRWarning " DCRs Already Existed: $($summary.DCRsExisted)"
Write-DCRInfo " DCR Mode: $dcrMode" -Color Cyan
Write-DCRInfo " Processing Mode: $processingMode" -Color Cyan

if ($CustomTableMode) {
 Write-DCRProgress "`nCustom Table Results:"
 Write-DCRSuccess " Tables Created: $($summary.CustomTablesCreated)"
 Write-DCRWarning " Tables Already Existed: $($summary.CustomTablesExisted)"
 Write-DCRWarning " Tables Skipped: $($summary.TablesSkipped)"
 Write-DCRError " Tables Failed: $($summary.CustomTablesFailed)"
}

if ($CreateDCE) {
 Write-DCRSuccess " DCEs Created: $($summary.DCEsCreated)"
 Write-DCRWarning " DCEs Already Existed: $($summary.DCEsExisted)"
}
Write-DCRInfo " Manual Deployment Recommended: $($summary.ManualDeploymentRecommended)" -Color Cyan

if ($summary.ManualDeploymentRecommended -gt 0) {
 Write-DCRInfo "`nManual Deployment Cases:" -Color Cyan
 foreach ($case in $summary.ManualDeploymentCases) {
 Write-DCRWarning " - $($case.TableName): $($case.Reason)"
 }
}

if ($summary.ProcessingFailures.Count -gt 0) {
 Write-DCRError "`nProcessing Failures:"
 foreach ($failure in $summary.ProcessingFailures) {
 Write-DCRError " - $failure"
 }
}

# Export Cribl configuration (default behavior unless explicitly skipped)
if (-not $SkipCriblExport -and $script:allCriblConfigs -and $script:allCriblConfigs.Count -gt 0) {
 # Create cribl-dcr-configs directory if it doesn't exist
 $criblConfigDir = Join-Path $ScriptDirectory "cribl-dcr-configs"
 if (-not (Test-Path $criblConfigDir)) {
 New-Item -ItemType Directory -Path $criblConfigDir -Force | Out-Null
 Write-DCRVerbose " Created directory: cribl-dcr-configs"
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
 Write-DCRSuccess "`n Cribl configuration automatically exported to: cribl-dcr-configs\cribl-dcr-config.json"
 Write-DCRVerbose " Total unique DCRs in config: $($finalDCRs.Count)"
 Write-DCRVerbose " (Use -SkipCriblExport to disable automatic export)"
 
 # Generate Cribl destination configuration files
 Write-DCRInfo "`n Generating Cribl Sentinel destination configurations..." -Color Cyan
 $genScript = Join-Path $ScriptDirectory "Generate-CriblDestinations.ps1"
 if (Test-Path $genScript) {
 try {
 & $genScript -CriblConfigFile "cribl-dcr-configs\cribl-dcr-config.json" | Out-Null
 Write-DCRSuccess " Cribl destination configs generated in: cribl-dcr-configs\destinations\"
 } catch {
 Write-Warning "Could not generate Cribl destination configs: $($_.Exception.Message)"
 }
 }
} elseif ($SkipCriblExport) {
 Write-DCRWarning "`n⏭ Cribl configuration export skipped (as requested)"
} elseif ($script:allCriblConfigs.Count -eq 0) {
 Write-DCRWarning "`n No DCR configurations to export"
}

Write-DCRInfo "`nNext Steps:" -Color Cyan
if ($summary.ManualDeploymentRecommended -gt 0) {
 Write-DCRWarning "1. Use Azure Portal for manual deployments (better reporting)"
 Write-DCRVerbose "2. Templates saved in generated-templates directory"
 Write-DCRVerbose "3. Navigate to: https://portal.azure.com -> Deploy a custom template"
 Write-DCRVerbose "4. Upload the *-latest.json files from the generated-templates directory"
} else {
 Write-DCRSuccess " All $dcrMode DCRs deployed successfully! Templates saved for future reference."
}

Write-DCRInfo "`n Cribl Integration:" -Color Cyan
Write-DCRVerbose "1. Retrieve DCR configuration: from cribl-dcr-configs directory"
Write-DCRVerbose "2. Configure Cribl Sentinel destination with DCR immutable ID and ingestion URL"
Write-DCRVerbose "3. Set up Azure AD App Registration for authentication"
Write-DCRVerbose "4. Grant 'Monitoring Metrics Publisher' role to App on DCRs"

if ($CustomTableMode) {
 Write-DCRInfo "`n Custom Table Mode Tips:" -Color Cyan
 Write-DCRVerbose "- Schema files should be placed in: $FullCustomTableSchemasPath"
 Write-DCRVerbose "- Custom tables automatically get '_CL' suffix added"
 Write-DCRVerbose "- See SampleTable_CL.json.sample for schema format"
} else {
 Write-DCRInfo "`n To process custom tables, set 'customTableSettings.enabled' to true in operation-parameters.json" -Color Cyan
}

Write-DCRInfo " To switch DCR modes, change 'createDCE' in operation-parameters.json" -Color Cyan
Write-DCRInfo "`nScript completed! " -Color Cyan

# Usage examples for Cribl integration:
# .\Create-TableDCRs.ps1 # Default: Auto-exports Cribl config
# .\Create-TableDCRs.ps1 -ShowCriblConfig # Display + export Cribl config
# .\Create-TableDCRs.ps1 -SkipCriblExport # Deploy without Cribl export
# .\Get-CriblDCRInfo.ps1 # Retrieve existing DCR info for Cribl
# .\Create-TableDCRs.ps1 -CustomTableMode # Process custom tables
# .\Create-TableDCRs.ps1 -CustomTableMode -TemplateOnly # Generate templates for custom tables
# .\Create-TableDCRs.ps1 -IgnoreOperationParameters # Uses only command-line parameters
# .\Create-TableDCRs.ps1 -TemplateOnly # Template-only mode: generates ARM templates without deploying
# .\Create-TableDCRs.ps1 -SpecificDCR "SecurityEvent" # Process specific table only
# .\Create-TableDCRs.ps1 -CreateDCE:$false # Force Direct DCRs
# .\Create-TableDCRs.ps1 -CreateDCE # Force DCE-based DCRs
# .\Create-TableDCRs.ps1 -CleanupOldTemplates -KeepTemplateVersions 3 # Override: cleanup old templates
# .\Create-TableDCRs.ps1 -AzureParametersFile "prod-azure.json" # Use custom Azure parameters file
# .\Create-TableDCRs.ps1 -OperationParametersFile "custom-ops.json" # Use custom operation parameters file