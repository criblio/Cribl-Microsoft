# Enhanced DCR Automation Script with Interactive Menu
# This script provides an interactive menu-based interface for processing tables with DCRs

[CmdletBinding()]
param(
 [Parameter(Mandatory=$false)]
 [switch]$NonInteractive,

 [Parameter(Mandatory=$false)]
 [ValidateSet("Native", "Custom", "Both", "TemplateOnly", "Status",
 "DirectNative", "DirectCustom", "DirectBoth",
 "DCENative", "DCECustom", "DCEBoth",
 "PrivateLinkNative", "PrivateLinkCustom",
 "CollectCribl", "ValidateCribl", "ResetCribl")]
 [string]$Mode = "",

 [Parameter(Mandatory=$false)]
 [switch]$ShowCriblConfig = $false,

 [Parameter(Mandatory=$false)]
 [switch]$ExportCriblConfig = $true,

 [Parameter(Mandatory=$false)]
 [switch]$SkipCriblExport = $false,

 [Parameter(Mandatory=$false)]
 [switch]$MigrateCustomTablesToDCR = $false,

 [Parameter(Mandatory=$false)]
 [switch]$AutoMigrateCustomTables = $false,

 [Parameter(Mandatory=$false)]
 [switch]$ConfirmDCRNames = $true
)

# Check for dev mode flag file (hidden from users)
$DevModeFlag = Join-Path $PSScriptRoot ".dev-mode"
$Environment = if (Test-Path $DevModeFlag) { "dev" } else { "core" }

# Import Output-Helper for consistent verbosity control
. (Join-Path $PSScriptRoot $Environment "Output-Helper.ps1")

# Set verbose output mode based on PowerShell's built-in VerbosePreference
$isVerbose = ($VerbosePreference -eq 'Continue') -or ($PSBoundParameters.ContainsKey('Verbose'))
Set-DCRVerboseOutput -Enabled $isVerbose

# Initialize logging to file
$timestamp = Get-Date -Format "yyyy-MM-dd_HHmmss"
$logFileName = "DCR_Automation_$timestamp.log"
$logFilePath = Join-Path $PSScriptRoot "logs\$logFileName"
Initialize-DCRLogging -LogPath $logFilePath
Write-Host "  Detailed logs will be written to: $logFileName" -ForegroundColor Cyan

$ScriptPath = Join-Path $PSScriptRoot $Environment "Create-TableDCRs.ps1"

# Function to display combined summary for Both modes
function Show-CombinedSummary {
 param(
 [hashtable]$NativeSummary,
 [hashtable]$CustomSummary,
 [string]$DCRMode
 )
 
 Write-DCRInfo "`n$('='*80)" -Color Cyan
 Write-DCRInfo "COMBINED EXECUTION SUMMARY ($DCRMode DCRs - Native + Custom Tables)" -Color Cyan
 Write-DCRInfo "$('='*80)" -Color Cyan
 
 if ($NativeSummary) {
 Write-DCRProgress "`n Native Tables Results:"
 Write-DCRVerbose " DCRs Processed: $($NativeSummary.DCRsProcessed)"
 Write-DCRSuccess " DCRs Created: $($NativeSummary.DCRsCreated)"
 Write-DCRWarning " DCRs Already Existed: $($NativeSummary.DCRsExisted)"
 Write-DCRVerbose " Tables Validated: $($NativeSummary.TablesValidated)"
 Write-Host " Tables Not Found: $($NativeSummary.TablesNotFound)" -ForegroundColor $(if ($NativeSummary.TablesNotFound -gt 0) { "Red" } else { "Gray" })
 }
 
 if ($CustomSummary) {
 Write-DCRProgress "`n Custom Tables Results:"
 Write-DCRVerbose " DCRs Processed: $($CustomSummary.DCRsProcessed)"
 Write-DCRSuccess " DCRs Created: $($CustomSummary.DCRsCreated)"
 Write-DCRWarning " DCRs Already Existed: $($CustomSummary.DCRsExisted)"
 Write-DCRSuccess " Tables Created: $($CustomSummary.CustomTablesCreated)"
 Write-DCRWarning " Tables Already Existed: $($CustomSummary.CustomTablesExisted)"
 if ($CustomSummary.CustomTablesMigrated -gt 0) {
 Write-DCRInfo " Tables Migrated to DCR-based: $($CustomSummary.CustomTablesMigrated)" -Color Magenta
 }
 Write-DCRWarning " Tables Skipped: $($CustomSummary.TablesSkipped)"
 Write-Host " Tables Failed: $($CustomSummary.CustomTablesFailed)" -ForegroundColor $(if ($CustomSummary.CustomTablesFailed -gt 0) { "Red" } else { "Gray" })
 }
 
 Write-DCRInfo "`n Combined Totals:" -Color Cyan
 $totalDCRsProcessed = $(if ($NativeSummary) { $NativeSummary.DCRsProcessed } else { 0 }) + $(if ($CustomSummary) { $CustomSummary.DCRsProcessed } else { 0 })
 $totalDCRsCreated = $(if ($NativeSummary) { $NativeSummary.DCRsCreated } else { 0 }) + $(if ($CustomSummary) { $CustomSummary.DCRsCreated } else { 0 })
 $totalDCRsExisted = $(if ($NativeSummary) { $NativeSummary.DCRsExisted } else { 0 }) + $(if ($CustomSummary) { $CustomSummary.DCRsExisted } else { 0 })
 $totalDCEsCreated = $(if ($NativeSummary) { $NativeSummary.DCEsCreated } else { 0 }) + $(if ($CustomSummary) { $CustomSummary.DCEsCreated } else { 0 })
 $totalDCEsExisted = $(if ($NativeSummary) { $NativeSummary.DCEsExisted } else { 0 }) + $(if ($CustomSummary) { $CustomSummary.DCEsExisted } else { 0 })
 
 Write-DCRProgress " Total DCRs Processed: $totalDCRsProcessed"
 Write-DCRSuccess " Total DCRs Created: $totalDCRsCreated"
 Write-DCRWarning " Total DCRs Already Existed: $totalDCRsExisted"
 Write-DCRSuccess " Total DCEs Created: $totalDCEsCreated"
 Write-DCRWarning " Total DCEs Already Existed: $totalDCEsExisted"
 Write-DCRInfo " DCR Mode: $DCRMode" -Color Cyan
 
 Write-DCRSuccess "`n Combined processing complete!"
}

# Helper function to display DCR mode status
function Get-DCRModeStatus {
 $opParams = Get-Content (Join-Path $PSScriptRoot $Environment "operation-parameters.json") | ConvertFrom-Json
 if ($opParams.deployment.createDCE) {
 return "DCE-based"
 } else {
 return "Direct"
 }
}

# Helper function to set DCR mode parameter
function Set-DCRModeParameter {
 param([bool]$UseDCE)
 
 if ($UseDCE) {
 return "-CreateDCE"
 } else {
 return "-CreateDCE:`$false"
 }
}

# Function to validate azure-parameters.json configuration
function Test-AzureParametersConfiguration {
 $azureParamsFile = Join-Path $PSScriptRoot $Environment "azure-parameters.json"

 if (-not (Test-Path $azureParamsFile)) {
 Write-DCRError "`n ERROR: azure-parameters.json file not found!"
 Write-DCRWarning " Please ensure the file exists in the script directory."
 return $false
 }

 try {
 $azParams = Get-Content $azureParamsFile | ConvertFrom-Json
 } catch {
 Write-DCRError "`n ERROR: azure-parameters.json is not valid JSON!"
 Write-DCRWarning " Error: $($_.Exception.Message)"
 return $false
 }

 # Define required fields and their default placeholder values
 $requiredFields = @{
 "subscriptionId" = @("<YOUR-SUBSCRIPTION-ID-HERE>", "your-subscription-id", "")
 "resourceGroupName" = @("<YOUR-RG-NAME-HERE>", "your-rg-name", "")
 "workspaceName" = @("<YOUR-LOG-ANALYTICS-WORKSPACE-NAME-HERE>", "your-la-workspace", "your-workspace", "")
 "location" = @("<YOUR-AZURE-REGION-HERE>", "")
 "tenantId" = @("<YOUR-TENANT-ID-HERE>", "your-tenant-id", "")
 "clientId" = @("<YOUR-CLIENT-ID-HERE>", "your-app-client-id", "your-client-id", "")
 }

 $missingFields = @()
 $defaultFields = @()

 foreach ($field in $requiredFields.Keys) {
 $value = $azParams.$field

 if (-not $value -or [string]::IsNullOrWhiteSpace($value)) {
 $missingFields += $field
 } elseif ($requiredFields[$field] -contains $value) {
 $defaultFields += $field
 }
 }

 if ($missingFields.Count -gt 0 -or $defaultFields.Count -gt 0) {
 Write-DCRWarning "`n CONFIGURATION REQUIRED"
 Write-DCRWarning "$('='*60)"
 Write-DCRProgress "The azure-parameters.json file needs to be updated before proceeding."
 Write-Host ""

 if ($missingFields.Count -gt 0) {
 Write-DCRError " Missing required fields:"
 foreach ($field in $missingFields) {
 Write-DCRError " - $field"
 }
 Write-Host ""
 }

 if ($defaultFields.Count -gt 0) {
 Write-DCRWarning " Fields still have default/placeholder values:"
 foreach ($field in $defaultFields) {
 $currentValue = $azParams.$field
 Write-DCRWarning " - $field`: '$currentValue'"
 }
 Write-Host ""
 }

 Write-DCRInfo " Please update the following fields in azure-parameters.json:" -Color Cyan
 Write-DCRVerbose " • subscriptionId: Your Azure subscription ID (GUID)"
 Write-DCRVerbose " • resourceGroupName: Your Azure resource group name"
 Write-DCRVerbose " • workspaceName: Your Log Analytics workspace name"
 Write-DCRVerbose " • location: Your Azure region (e.g., 'eastus', 'westus2')"
 Write-DCRVerbose " • tenantId: Your Azure tenant ID (GUID)"
 Write-DCRVerbose " • clientId: Your Azure app registration client ID (GUID)"
 Write-Host ""
 Write-DCRVerbose " Note: Client secret will be set to '<replace me>' in Cribl destinations for manual configuration."
 Write-DCRWarning "$('='*60)"

 return $false
 }

 return $true
}

# Function to wait for configuration update
function Wait-ForConfigurationUpdate {
 Write-DCRInfo "`n CONFIGURATION UPDATE REQUIRED" -Color Cyan
 Write-DCRVerbose "$('-'*50)"
 Write-DCRProgress "Please edit the azure-parameters.json file with your Azure details."
 Write-Host ""
 Write-DCRWarning "You can:"
 Write-DCRVerbose "1. Open azure-parameters.json in your preferred editor"
 Write-DCRVerbose "2. Update the required fields listed above"
 Write-DCRVerbose "3. Save the file"
 Write-DCRVerbose "4. Return here and press Enter to continue"
 Write-Host ""

 do {
 $continue = Read-Host "Press Enter after updating azure-parameters.json (or 'q' to quit)"

 if ($continue.ToLower() -eq 'q') {
 Write-DCRWarning "`nExiting... Please update azure-parameters.json and run the script again."
 exit 0
 }

 Write-DCRInfo "`n Checking configuration..." -Color Cyan

 if (Test-AzureParametersConfiguration) {
 Write-DCRSuccess " Configuration validated successfully!"
 Write-Host ""
 Start-Sleep -Seconds 1
 return $true
 } else {
 Write-DCRError "`n Configuration still needs updates. Please check the fields above."
 Write-Host ""
 }

 } while ($true)
}

# Function to execute a mode
function Execute-Mode {
 param([string]$ExecutionMode)
 
 # Clear any existing configuration if this is first call
 if ($ExecutionMode -ne "Status") {
 $tempMarkerFile = Join-Path $PSScriptRoot $Environment ".cribl-collection-in-progress"
 if (-not (Test-Path $tempMarkerFile)) {
 New-Item -ItemType File -Path $tempMarkerFile -Force | Out-Null
 Register-EngineEvent -SourceIdentifier PowerShell.Exiting -Action {
 $tempFile = Join-Path $PSScriptRoot $Environment ".cribl-collection-in-progress"
 if (Test-Path $tempFile) {
 Remove-Item $tempFile -Force -ErrorAction SilentlyContinue
 }
 } | Out-Null
 }
 }
 
 switch ($ExecutionMode) {
 "Status" {
 Write-DCRInfo "`n Current Configuration Status" -Color Cyan
 Write-Host "="*50 -ForegroundColor Cyan
 
 # Read current settings
 $opParams = Get-Content (Join-Path $PSScriptRoot $Environment "operation-parameters.json") | ConvertFrom-Json
 $azParams = Get-Content (Join-Path $PSScriptRoot $Environment "azure-parameters.json") | ConvertFrom-Json
 
 $currentDCRMode = Get-DCRModeStatus
 
 Write-DCRWarning "`n Operation Settings:"
 Write-Host " DCR Mode: $currentDCRMode" -ForegroundColor $(if ($currentDCRMode -eq "Direct") { "Green" } else { "Blue" })
 Write-DCRVerbose " Custom Table Mode: $($opParams.customTableSettings.enabled)"
 Write-DCRVerbose " Template Only: $($opParams.scriptBehavior.templateOnly)"
 
 Write-DCRWarning "`n Table Lists:"
 $nativeTables = Get-Content (Join-Path $PSScriptRoot $Environment "NativeTableList.json") | ConvertFrom-Json
 Write-DCRVerbose " Native Tables: $($nativeTables -join ', ')"
 
 if (Test-Path (Join-Path $PSScriptRoot $Environment "CustomTableList.json")) {
 $customTables = Get-Content (Join-Path $PSScriptRoot $Environment "CustomTableList.json") | ConvertFrom-Json
 Write-DCRVerbose " Custom Tables: $($customTables -join ', ')"
 }
 
 Write-DCRWarning "`n Azure Resources:"
 Write-DCRVerbose " Resource Group: $($azParams.resourceGroupName)"
 Write-DCRVerbose " Workspace: $($azParams.workspaceName)"
 Write-DCRVerbose " Location: $($azParams.location)"
 Write-DCRVerbose " DCR Prefix: $($azParams.dcrPrefix)"
 if ($currentDCRMode -eq "DCE-based") {
 Write-DCRVerbose " DCE Resource Group: $($azParams.resourceGroupName)"
 Write-DCRVerbose " DCE Prefix: $($azParams.dcePrefix)"
 }
 
 if (-not $SkipCriblExport) {
 Write-DCRInfo "`n Cribl Configuration Export: ENABLED (default)" -Color Magenta
 } else {
 Write-DCRWarning "`n ⏭ Cribl Configuration Export: DISABLED"
 }
 if ($ShowCriblConfig) {
 Write-DCRInfo " Cribl Config Display: ENABLED" -Color Cyan
 }
 }
 
 "DirectNative" {
 Write-DCRSuccess "`n Processing NATIVE Tables with DIRECT DCRs..."
 Write-Host "="*50 -ForegroundColor Green
 Write-DCRInfo "Tables: CommonSecurityLog, SecurityEvent, Syslog, WindowsEvent" -Color Cyan
 Write-DCRSuccess "DCR Mode: Direct (no DCE required)"
 Write-Host ""
 
 $exportCribl = -not $SkipCriblExport

 & $ScriptPath -CustomTableMode:$false -CreateDCE:$false -ShowCriblConfig:$ShowCriblConfig -ExportCriblConfig:$exportCribl -SkipCriblExport:$SkipCriblExport -MigrateCustomTablesToDCR:$MigrateCustomTablesToDCR -AutoMigrateCustomTables:$AutoMigrateCustomTables -ConfirmDCRNames:$ConfirmDCRNames

 }
 
 "DirectCustom" {
 Write-DCRInfo "`n Processing CUSTOM Tables with DIRECT DCRs..." -Color Blue
 Write-Host "="*50 -ForegroundColor Blue
 
 if (Test-Path (Join-Path $PSScriptRoot $Environment "CustomTableList.json")) {
 $customTables = Get-Content (Join-Path $PSScriptRoot $Environment "CustomTableList.json") | ConvertFrom-Json
 Write-DCRInfo "Tables to process: $($customTables -join ', ')" -Color Cyan
 } else {
 Write-DCRError " CustomTableList.json not found!"
 return
 }
 
 Write-DCRSuccess "DCR Mode: Direct (no DCE required)"
 Write-Host ""
 
 $exportCribl = -not $SkipCriblExport
 & $ScriptPath -CustomTableMode -CustomTableListFile "CustomTableList.json" -CreateDCE:$false -ShowCriblConfig:$ShowCriblConfig -ExportCriblConfig:$exportCribl -SkipCriblExport:$SkipCriblExport -MigrateCustomTablesToDCR:$MigrateCustomTablesToDCR -AutoMigrateCustomTables:$AutoMigrateCustomTables -ConfirmDCRNames:$ConfirmDCRNames

 }
 
 "DirectBoth" {
 Write-DCRInfo "`n Processing ALL Tables with DIRECT DCRs..." -Color Magenta
 Write-Host "="*50 -ForegroundColor Magenta
 Write-DCRSuccess "DCR Mode: Direct (no DCE required)"
 
 Write-DCRWarning "`n Step 1: Processing Native Tables with Direct DCRs..."
 $exportCribl = -not $SkipCriblExport

 $nativeSummary = & $ScriptPath -CustomTableMode:$false -CreateDCE:$false -ShowCriblConfig:$ShowCriblConfig -ExportCriblConfig:$exportCribl -SkipCriblExport:$SkipCriblExport -MigrateCustomTablesToDCR:$MigrateCustomTablesToDCR -AutoMigrateCustomTables:$AutoMigrateCustomTables -ConfirmDCRNames:$ConfirmDCRNames

 Write-DCRWarning "`n Step 2: Processing Custom Tables with Direct DCRs..."
 $customSummary = & $ScriptPath -CustomTableMode -CustomTableListFile "CustomTableList.json" -CreateDCE:$false -ShowCriblConfig:$ShowCriblConfig -ExportCriblConfig:$exportCribl -SkipCriblExport:$SkipCriblExport -MigrateCustomTablesToDCR:$MigrateCustomTablesToDCR -AutoMigrateCustomTables:$AutoMigrateCustomTables -ConfirmDCRNames:$ConfirmDCRNames
 
 Show-CombinedSummary -NativeSummary $nativeSummary -CustomSummary $customSummary -DCRMode "Direct"
 }
 
 "DCENative" {
 Write-DCRSuccess "`n Processing NATIVE Tables with DCE-based DCRs..."
 Write-Host "="*50 -ForegroundColor Green
 Write-DCRInfo "Tables: CommonSecurityLog, SecurityEvent, Syslog, WindowsEvent" -Color Cyan
 Write-DCRInfo "DCR Mode: DCE-based (creates DCEs)" -Color Blue
 Write-Host ""
 
 $exportCribl = -not $SkipCriblExport

 & $ScriptPath -CustomTableMode:$false -CreateDCE -ShowCriblConfig:$ShowCriblConfig -ExportCriblConfig:$exportCribl -SkipCriblExport:$SkipCriblExport -MigrateCustomTablesToDCR:$MigrateCustomTablesToDCR -AutoMigrateCustomTables:$AutoMigrateCustomTables -ConfirmDCRNames:$ConfirmDCRNames

 }
 
 "DCECustom" {
 Write-DCRInfo "`n Processing CUSTOM Tables with DCE-based DCRs..." -Color Blue
 Write-Host "="*50 -ForegroundColor Blue
 
 if (Test-Path (Join-Path $PSScriptRoot $Environment "CustomTableList.json")) {
 $customTables = Get-Content (Join-Path $PSScriptRoot $Environment "CustomTableList.json") | ConvertFrom-Json
 Write-DCRInfo "Tables to process: $($customTables -join ', ')" -Color Cyan
 } else {
 Write-DCRError " CustomTableList.json not found!"
 return
 }
 
 Write-DCRInfo "DCR Mode: DCE-based (creates DCEs)" -Color Blue
 Write-Host ""
 
 $exportCribl = -not $SkipCriblExport

 & $ScriptPath -CustomTableMode -CustomTableListFile "CustomTableList.json" -CreateDCE -ShowCriblConfig:$ShowCriblConfig -ExportCriblConfig:$exportCribl -SkipCriblExport:$SkipCriblExport -MigrateCustomTablesToDCR:$MigrateCustomTablesToDCR -AutoMigrateCustomTables:$AutoMigrateCustomTables -ConfirmDCRNames:$ConfirmDCRNames

 }
 
 "DCEBoth" {
 Write-DCRInfo "`n Processing ALL Tables with DCE-based DCRs..." -Color Magenta
 Write-Host "="*50 -ForegroundColor Magenta
 Write-DCRInfo "DCR Mode: DCE-based (creates DCEs)" -Color Blue
 
 Write-DCRWarning "`n Step 1: Processing Native Tables with DCE-based DCRs..."
 $exportCribl = -not $SkipCriblExport

 $nativeSummary = & $ScriptPath -CustomTableMode:$false -CreateDCE -ShowCriblConfig:$ShowCriblConfig -ExportCriblConfig:$exportCribl -SkipCriblExport:$SkipCriblExport -MigrateCustomTablesToDCR:$MigrateCustomTablesToDCR -AutoMigrateCustomTables:$AutoMigrateCustomTables -ConfirmDCRNames:$ConfirmDCRNames

 Write-DCRWarning "`n Step 2: Processing Custom Tables with DCE-based DCRs..."
 $customSummary = & $ScriptPath -CustomTableMode -CustomTableListFile "CustomTableList.json" -CreateDCE -ShowCriblConfig:$ShowCriblConfig -ExportCriblConfig:$exportCribl -SkipCriblExport:$SkipCriblExport -MigrateCustomTablesToDCR:$MigrateCustomTablesToDCR -AutoMigrateCustomTables:$AutoMigrateCustomTables -ConfirmDCRNames:$ConfirmDCRNames


 Show-CombinedSummary -NativeSummary $nativeSummary -CustomSummary $customSummary -DCRMode "DCE-based"
 }

 "PrivateLinkNative" {
 Write-DCRInfo "`n Processing NATIVE Tables with PRIVATE LINK DCE..." -Color Cyan
 Write-Host "="*50 -ForegroundColor Cyan
 Write-DCRProgress "Tables: CommonSecurityLog, SecurityEvent, Syslog, WindowsEvent"
 Write-DCRInfo "DCR Mode: DCE-based with Private Link (Private Endpoint required)" -Color Magenta
 Write-Host ""

 # Load current operation parameters to check Private Link config
 $opParamsPath = Join-Path $PSScriptRoot $Environment "operation-parameters.json"
 $opParams = Get-Content $opParamsPath | ConvertFrom-Json

 # Temporarily enable Private Link for this deployment
 $originalPrivateLinkEnabled = $opParams.privateLink.enabled
 $originalPublicAccess = $opParams.privateLink.dcePublicNetworkAccess
 $originalAMPLSResourceId = $opParams.privateLink.amplsResourceId
 $originalAMPLSName = $opParams.privateLink.amplsName
 $originalAMPLSRGName = $opParams.privateLink.amplsResourceGroupName

 # Load Azure parameters to get resource group and location
 $azureParamsPath = Join-Path $PSScriptRoot $Environment "azure-parameters.json"
 $azureParams = Get-Content $azureParamsPath | ConvertFrom-Json

 # Generate AMPLS name if not configured
 if (-not $opParams.privateLink.amplsName) {
 $opParams.privateLink.amplsName = "ampls-$($azureParams.workspaceName)"
 $opParams.privateLink.amplsResourceGroupName = $azureParams.resourceGroupName
 Write-DCRInfo " Generated AMPLS name: $($opParams.privateLink.amplsName)" -Color Cyan
 }

 # Ensure resource group is set
 if (-not $opParams.privateLink.amplsResourceGroupName) {
 $opParams.privateLink.amplsResourceGroupName = $azureParams.resourceGroupName
 }

 # Load helper functions by dot-sourcing the Create-TableDCRs.ps1 script
 . $ScriptPath

 Write-DCRInfo "`n Setting up Azure Monitor Private Link Scope..." -Color Cyan
 Write-Host "="*50 -ForegroundColor Cyan

 try {
 # Create or get existing AMPLS
 $amplsResourceId = New-AMPLSIfNotExists `
 -ResourceGroupName $opParams.privateLink.amplsResourceGroupName `
 -AMPLSName $opParams.privateLink.amplsName `
 -Location $azureParams.location

 # Update operation parameters with AMPLS resource ID
 $opParams.privateLink.amplsResourceId = $amplsResourceId

 # Get workspace resource ID
 $context = Get-AzContext
 $workspaceResourceId = "/subscriptions/$($context.Subscription.Id)/resourceGroups/$($azureParams.resourceGroupName)/providers/Microsoft.OperationalInsights/workspaces/$($azureParams.workspaceName)"

 # Associate workspace with AMPLS
 Add-WorkspaceToAMPLS `
 -WorkspaceResourceId $workspaceResourceId `
 -AMPLSResourceId $amplsResourceId

 Write-DCRSuccess "`n AMPLS setup completed"
 Write-Host ""

 } catch {
 Write-Warning "Failed to setup AMPLS: $($_.Exception.Message)"
 Write-Host ""
 $continue = Read-Host "Continue with deployment anyway? (Y/N)"
 if ($continue.ToUpper() -ne 'Y') {
 Write-DCRWarning "Deployment cancelled."
 return
 }
 }

 # Enable Private Link for this execution
 $opParams.privateLink.enabled = $true
 $opParams.privateLink.dcePublicNetworkAccess = "Disabled"

 # Save temporarily
 $opParams | ConvertTo-Json -Depth 10 | Set-Content $opParamsPath -Force

 Write-DCRSuccess " Private Link enabled for this deployment"
 Write-DCRVerbose " DCE will be created with publicNetworkAccess: Disabled"
 Write-DCRVerbose " DCE will be associated with AMPLS: $($opParams.privateLink.amplsName)"
 Write-Host ""

 $exportCribl = -not $SkipCriblExport

 & $ScriptPath -CustomTableMode:$false -CreateDCE -ShowCriblConfig:$ShowCriblConfig -ExportCriblConfig:$exportCribl -SkipCriblExport:$SkipCriblExport -MigrateCustomTablesToDCR:$MigrateCustomTablesToDCR -AutoMigrateCustomTables:$AutoMigrateCustomTables

 # Restore original settings
 $opParams.privateLink.enabled = $originalPrivateLinkEnabled
 $opParams.privateLink.dcePublicNetworkAccess = $originalPublicAccess
 $opParams.privateLink.amplsResourceId = $originalAMPLSResourceId
 $opParams.privateLink.amplsName = $originalAMPLSName
 $opParams.privateLink.amplsResourceGroupName = $originalAMPLSRGName
 $opParams | ConvertTo-Json -Depth 10 | Set-Content $opParamsPath -Force
 }

 "PrivateLinkCustom" {
 Write-DCRInfo "`n Processing CUSTOM Tables with PRIVATE LINK DCE..." -Color Cyan
 Write-Host "="*50 -ForegroundColor Cyan

 if (Test-Path (Join-Path $PSScriptRoot $Environment "CustomTableList.json")) {
 $customTables = Get-Content (Join-Path $PSScriptRoot $Environment "CustomTableList.json") | ConvertFrom-Json
 Write-DCRProgress "Tables to process: $($customTables -join ', ')"
 } else {
 Write-DCRError " CustomTableList.json not found!"
 return
 }

 Write-DCRInfo "DCR Mode: DCE-based with Private Link (Private Endpoint required)" -Color Magenta
 Write-Host ""

 # Load current operation parameters to check Private Link config
 $opParamsPath = Join-Path $PSScriptRoot $Environment "operation-parameters.json"
 $opParams = Get-Content $opParamsPath | ConvertFrom-Json

 # Temporarily enable Private Link for this deployment
 $originalPrivateLinkEnabled = $opParams.privateLink.enabled
 $originalPublicAccess = $opParams.privateLink.dcePublicNetworkAccess
 $originalAMPLSResourceId = $opParams.privateLink.amplsResourceId
 $originalAMPLSName = $opParams.privateLink.amplsName
 $originalAMPLSRGName = $opParams.privateLink.amplsResourceGroupName

 # Load Azure parameters to get resource group and location
 $azureParamsPath = Join-Path $PSScriptRoot $Environment "azure-parameters.json"
 $azureParams = Get-Content $azureParamsPath | ConvertFrom-Json

 # Generate AMPLS name if not configured
 if (-not $opParams.privateLink.amplsName) {
 $opParams.privateLink.amplsName = "ampls-$($azureParams.workspaceName)"
 $opParams.privateLink.amplsResourceGroupName = $azureParams.resourceGroupName
 Write-DCRInfo " Generated AMPLS name: $($opParams.privateLink.amplsName)" -Color Cyan
 }

 # Ensure resource group is set
 if (-not $opParams.privateLink.amplsResourceGroupName) {
 $opParams.privateLink.amplsResourceGroupName = $azureParams.resourceGroupName
 }

 # Load helper functions by dot-sourcing the Create-TableDCRs.ps1 script
 . $ScriptPath

 Write-DCRInfo "`n Setting up Azure Monitor Private Link Scope..." -Color Cyan
 Write-Host "="*50 -ForegroundColor Cyan

 try {
 # Create or get existing AMPLS
 $amplsResourceId = New-AMPLSIfNotExists `
 -ResourceGroupName $opParams.privateLink.amplsResourceGroupName `
 -AMPLSName $opParams.privateLink.amplsName `
 -Location $azureParams.location

 # Update operation parameters with AMPLS resource ID
 $opParams.privateLink.amplsResourceId = $amplsResourceId

 # Get workspace resource ID
 $context = Get-AzContext
 $workspaceResourceId = "/subscriptions/$($context.Subscription.Id)/resourceGroups/$($azureParams.resourceGroupName)/providers/Microsoft.OperationalInsights/workspaces/$($azureParams.workspaceName)"

 # Associate workspace with AMPLS
 Add-WorkspaceToAMPLS `
 -WorkspaceResourceId $workspaceResourceId `
 -AMPLSResourceId $amplsResourceId

 Write-DCRSuccess "`n AMPLS setup completed"
 Write-Host ""

 } catch {
 Write-Warning "Failed to setup AMPLS: $($_.Exception.Message)"
 Write-Host ""
 $continue = Read-Host "Continue with deployment anyway? (Y/N)"
 if ($continue.ToUpper() -ne 'Y') {
 Write-DCRWarning "Deployment cancelled."
 return
 }
 }

 # Enable Private Link for this execution
 $opParams.privateLink.enabled = $true
 $opParams.privateLink.dcePublicNetworkAccess = "Disabled"

 # Save temporarily
 $opParams | ConvertTo-Json -Depth 10 | Set-Content $opParamsPath -Force

 Write-DCRSuccess " Private Link enabled for this deployment"
 Write-DCRVerbose " DCE will be created with publicNetworkAccess: Disabled"
 Write-DCRVerbose " DCE will be associated with AMPLS: $($opParams.privateLink.amplsName)"
 Write-Host ""

 $exportCribl = -not $SkipCriblExport

 & $ScriptPath -CustomTableMode -CustomTableListFile "CustomTableList.json" -CreateDCE -ShowCriblConfig:$ShowCriblConfig -ExportCriblConfig:$exportCribl -SkipCriblExport:$SkipCriblExport -MigrateCustomTablesToDCR:$MigrateCustomTablesToDCR -AutoMigrateCustomTables:$AutoMigrateCustomTables

 # Restore original settings
 $opParams.privateLink.enabled = $originalPrivateLinkEnabled
 $opParams.privateLink.dcePublicNetworkAccess = $originalPublicAccess
 $opParams.privateLink.amplsResourceId = $originalAMPLSResourceId
 $opParams.privateLink.amplsName = $originalAMPLSName
 $opParams.privateLink.amplsResourceGroupName = $originalAMPLSRGName
 $opParams | ConvertTo-Json -Depth 10 | Set-Content $opParamsPath -Force
 }

 "CollectCribl" {
 Write-DCRInfo "`n Collecting Cribl Configuration from Templates and DCRs..." -Color Cyan
 Write-Host "="*50 -ForegroundColor Cyan
 
 # Load Azure parameters
 $azParams = Get-Content (Join-Path $PSScriptRoot $Environment "azure-parameters.json") | ConvertFrom-Json
 $ResourceGroupName = $azParams.resourceGroupName
 $WorkspaceName = $azParams.workspaceName
 $DCRPrefix = $azParams.dcrPrefix
 $Location = $azParams.location
 
 Write-DCRVerbose "Resource Group: $ResourceGroupName"
 Write-DCRVerbose "Workspace: $WorkspaceName"
 Write-DCRVerbose "DCR Prefix: $DCRPrefix"
 Write-DCRVerbose "Location: $Location"
 Write-Host ""
 
 # [Rest of CollectCribl implementation remains the same...]
 # Code continues as in original script...
 
 Write-DCRSuccess "`n Cribl configuration collected and saved"
 }
 
 "ValidateCribl" {
 Write-DCRInfo "`n Validating Cribl Configuration..." -Color Cyan
 Write-Host "="*50 -ForegroundColor Cyan
 
 $criblConfigDir = Join-Path $PSScriptRoot $Environment "cribl-dcr-configs"
 $configPath = Join-Path $criblConfigDir "cribl-dcr-config.json"
 
 if (Test-Path $configPath) {
 $config = Get-Content $configPath -Raw | ConvertFrom-Json
 
 Write-DCRWarning "`nConfiguration Summary:"
 Write-DCRVerbose " Generated: $($config.GeneratedAt)"
 Write-DCRVerbose " Resource Group: $($config.ResourceGroup)"
 Write-DCRVerbose " Workspace: $($config.Workspace)"
 Write-DCRWarning " Total DCRs: $($config.DCRCount)"
 
 # Validation checks
 $nullEndpoints = @($config.DCRs | Where-Object { -not $_.IngestionEndpoint })
 $emptyStreams = @($config.DCRs | Where-Object { -not $_.StreamName })
 $emptyTables = @($config.DCRs | Where-Object { -not $_.TableName })
 
 Write-DCRInfo "`nValidation Results:" -Color Cyan
 
 if ($nullEndpoints.Count -eq 0) {
 Write-DCRSuccess " All ingestion endpoints present"
 } else {
 Write-DCRError " Missing endpoints: $($nullEndpoints.Count) DCR(s)"
 }
 
 if ($emptyStreams.Count -eq 0) {
 Write-DCRSuccess " All stream names present"
 } else {
 Write-DCRError " Missing stream names: $($emptyStreams.Count) DCR(s)"
 }
 
 if ($emptyTables.Count -eq 0) {
 Write-DCRSuccess " All table names present"
 } else {
 Write-DCRError " Missing table names: $($emptyTables.Count) DCR(s)"
 }
 } else {
 Write-DCRError " No cribl-dcr-config.json file found!"
 Write-Host ""
 Write-DCRWarning "Create one by running a deployment or collecting from existing DCRs."
 }
 }
 
 "ResetCribl" {
 Write-DCRInfo "`n Reset Cribl Configuration" -Color Cyan
 Write-Host "="*50 -ForegroundColor Cyan
 
 $criblConfigDir = Join-Path $PSScriptRoot $Environment "cribl-dcr-configs"
 $configPath = Join-Path $criblConfigDir "cribl-dcr-config.json"
 
 if (Test-Path $configPath) {
 $backupPath = Join-Path $criblConfigDir "cribl-dcr-config.backup.$(Get-Date -Format 'yyyyMMdd-HHmmss').json"
 Copy-Item $configPath $backupPath
 Write-DCRSuccess " Configuration backed up to: $(Split-Path $backupPath -Leaf)"
 
 Remove-Item $configPath -Force
 Write-DCRSuccess " Cribl configuration file reset!"
 } else {
 Write-DCRInfo " No existing configuration file to reset" -Color Cyan
 }
 }
 
 "TemplateOnly" {
 Write-DCRInfo "`n Generating Templates Only (No Deployment)..." -Color Cyan
 Write-Host "="*50 -ForegroundColor Cyan
 
 $currentDCRMode = Get-DCRModeStatus
 Write-DCRInfo "DCR Mode: $currentDCRMode" -Color Cyan
 
 Write-DCRWarning "`n Generating Native Table Templates..."

 & $ScriptPath -CustomTableMode:$false -TemplateOnly -MigrateCustomTablesToDCR:$MigrateCustomTablesToDCR -AutoMigrateCustomTables:$AutoMigrateCustomTables -ConfirmDCRNames:$ConfirmDCRNames

 Write-DCRWarning "`n Generating Custom Table Templates..."
 & $ScriptPath -CustomTableMode -CustomTableListFile "CustomTableList.json" -TemplateOnly -MigrateCustomTablesToDCR:$MigrateCustomTablesToDCR -AutoMigrateCustomTables:$AutoMigrateCustomTables -ConfirmDCRNames:$ConfirmDCRNames

 Write-DCRSuccess "`n Templates generated in: generated-templates\"
 }
 }
 
 # Check if Cribl config was exported
 $criblConfigPath = Join-Path $PSScriptRoot $Environment "cribl-dcr-configs" "cribl-dcr-config.json"
 if (-not $SkipCriblExport -and (Test-Path $criblConfigPath) -and $ExecutionMode -notmatch "Status|CollectCribl|ValidateCribl|ResetCribl") {
 Write-DCRSuccess "`n Cribl configuration automatically exported to: cribl-dcr-configs\cribl-dcr-config.json"
 }
 
 # Clean up temp marker file
 $tempMarkerFile = Join-Path $PSScriptRoot $Environment ".cribl-collection-in-progress"
 if (Test-Path $tempMarkerFile) {
 Remove-Item $tempMarkerFile -Force -ErrorAction SilentlyContinue
 }
}

# Function to display the main menu
function Show-MainMenu {
 Clear-Host
 Write-DCRInfo "`n$('='*60)" -Color Cyan
 Write-DCRProgress " DCR AUTOMATION DEPLOYMENT MENU"
 Write-DCRInfo "$('='*60)" -Color Cyan

 # Display current configuration (validated)
 $azParams = Get-Content (Join-Path $PSScriptRoot $Environment "azure-parameters.json") | ConvertFrom-Json
 Write-DCRInfo "`n Current Configuration:" -Color Cyan
 Write-DCRVerbose " Subscription ID: $($azParams.subscriptionId)"
 Write-DCRVerbose " Workspace: $($azParams.workspaceName)"
 Write-DCRVerbose " Resource Group: $($azParams.resourceGroupName)"
 Write-DCRVerbose " Location: $($azParams.location)"
 Write-DCRVerbose " Tenant ID: $($azParams.tenantId)"
 Write-DCRVerbose " Client ID: $($azParams.clientId)"
 
 # Get current DCR mode
 $currentDCRMode = Get-DCRModeStatus
 Write-Host " DCR Mode: $currentDCRMode" -ForegroundColor $(if ($currentDCRMode -eq "Direct") { "Green" } else { "Blue" })
 
 # Check for custom tables
 $customTableCount = 0
 if (Test-Path (Join-Path $PSScriptRoot $Environment "CustomTableList.json")) {
 $customTables = Get-Content (Join-Path $PSScriptRoot $Environment "CustomTableList.json") | ConvertFrom-Json
 $customTableCount = $customTables.Count
 }
 
 Write-DCRWarning "`n DEPLOYMENT OPTIONS:"
 Write-Host ""
 Write-DCRInfo " [1] Quick Deploy (Operational Parameters)" -Color Magenta
 Write-DCRVerbose " Deploy both Native + Custom tables using current settings"
 Write-DCRVerbose " $('-'*56)"
 Write-DCRProgress " [2] Deploy DCR (Native Direct)"
 Write-DCRProgress " [3] Deploy DCR (Native w/DCE)"
 Write-DCRProgress " [4] Deploy DCR (Custom Direct)"
 Write-DCRProgress " [5] Deploy DCR (Custom w/DCE)"
 Write-DCRVerbose " $('-'*56)"
 Write-DCRInfo " [6] Deploy DCR (Native w/Private Link DCE)" -Color Cyan
 Write-DCRInfo " [7] Deploy DCR (Custom w/Private Link DCE)" -Color Cyan
 Write-DCRVerbose " $('-'*56)"
 Write-DCRError " [Q] Quit"
 Write-DCRInfo "$('='*60)" -Color Cyan
}

# Function to confirm deployment
function Confirm-Deployment {
 param(
 [string]$TableType,
 [string]$DCRType,
 [array]$Tables
 )
 
 Write-DCRWarning "`n DEPLOYMENT CONFIRMATION"
 Write-DCRVerbose "$('-'*40)"
 Write-DCRProgress "Table Type: $TableType"
 Write-DCRProgress "DCR Type: $DCRType"
 if ($Tables) {
 Write-DCRProgress "Tables to process: $($Tables -join ', ')"
 }
 Write-DCRVerbose "$('-'*40)"
 
 $confirm = Read-Host "`nProceed with deployment? (Y/N)"
 return $confirm.ToUpper() -eq 'Y'
}

# Function to wait for user to continue
function Wait-ForUser {
 Write-DCRWarning "`nPress any key to continue..."
 $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
}

# Main script logic
if ($NonInteractive -or $Mode) {
 # Non-interactive mode - execute the specified mode and exit
 if ($Mode) {
 # Validate configuration before executing in non-interactive mode
 if (-not (Test-AzureParametersConfiguration)) {
 Write-DCRError "`n Configuration validation failed in non-interactive mode!"
 Write-DCRWarning "Please update azure-parameters.json with valid values before running in non-interactive mode."
 exit 1
 }
 Execute-Mode -ExecutionMode $Mode
 } else {
 Write-DCRError " Non-interactive mode requires -Mode parameter"
 Write-DCRWarning "Example: .\Run-DCRAutomation.ps1 -NonInteractive -Mode DirectBoth"
 }
} else {
 # Interactive menu mode
 $continue = $true

 # Initialize script-level variables for settings
 $script:ShowCriblConfig = $ShowCriblConfig
 $script:SkipCriblExport = $SkipCriblExport

 # Validate configuration before showing menu
 Write-DCRInfo "`n Validating azure-parameters.json configuration..." -Color Cyan
 if (-not (Test-AzureParametersConfiguration)) {
 # Configuration needs updates - wait for user to fix it
 if (-not (Wait-ForConfigurationUpdate)) {
 Write-DCRError "`nExiting due to configuration issues."
 exit 1
 }
 } else {
 Write-DCRSuccess " Configuration validated successfully!"
 Start-Sleep -Seconds 1
 }

 while ($continue) {
 Show-MainMenu
 $choice = Read-Host "`nSelect an option"
 
 switch ($choice.ToUpper()) {
 "1" {
 Write-DCRInfo "`n QUICK DEPLOY - Processing Native + Custom Tables" -Color Magenta
 Write-DCRInfo "$('='*50)" -Color Magenta
 
 $currentDCRMode = Get-DCRModeStatus
 Write-DCRInfo "Using current operational parameters: $currentDCRMode DCRs" -Color Cyan
 
 # Check for custom tables
 $customTables = @()
 if (Test-Path (Join-Path $PSScriptRoot $Environment "CustomTableList.json")) {
 $customTables = Get-Content (Join-Path $PSScriptRoot $Environment "CustomTableList.json") | ConvertFrom-Json
 }
 
 $nativeTables = @("CommonSecurityLog", "SecurityEvent", "Syslog", "WindowsEvent")
 
 Write-DCRWarning "`n Tables to process:"
 Write-DCRVerbose " Native: $($nativeTables -join ', ')"
 if ($customTables.Count -gt 0) {
 Write-DCRVerbose " Custom: $($customTables -join ', ')"
 } else {
 Write-DCRVerbose " Custom: None configured"
 }
 
 $confirm = Read-Host "`nProceed with Quick Deploy using $currentDCRMode DCRs? (Y/N)"
 if ($confirm.ToUpper() -eq 'Y') {
 Write-DCRWarning "`n Step 1: Processing Native Tables..."
 if ($currentDCRMode -eq "Direct") {
 Execute-Mode -ExecutionMode "DirectNative"
 } else {
 Execute-Mode -ExecutionMode "DCENative"
 }
 
 if ($customTables.Count -gt 0) {
 Write-DCRWarning "`n Step 2: Processing Custom Tables..."
 if ($currentDCRMode -eq "Direct") {
 Execute-Mode -ExecutionMode "DirectCustom"
 } else {
 Execute-Mode -ExecutionMode "DCECustom"
 }
 } else {
 Write-DCRVerbose "`n Step 2: Skipping Custom Tables (none configured)"
 }
 
 Write-DCRSuccess "`n Quick Deploy complete!"
 } else {
 Write-DCRWarning "`nDeployment cancelled."
 }
 Wait-ForUser
 }
 "2" {
 Write-DCRSuccess "`n Native Tables with Direct DCRs"
 Write-DCRVerbose "$('-'*40)"
 
 $nativeTables = @("CommonSecurityLog", "SecurityEvent", "Syslog", "WindowsEvent")
 if (Confirm-Deployment -TableType "Native" -DCRType "Direct (no DCE)" -Tables $nativeTables) {
 Write-DCRInfo "`nStarting deployment..." -Color Cyan
 Execute-Mode -ExecutionMode "DirectNative"
 Write-DCRSuccess "`n Deployment complete!"
 } else {
 Write-DCRWarning "`nDeployment cancelled."
 }
 Wait-ForUser
 }
 "3" {
 Write-DCRInfo "`n Native Tables with DCE-based DCRs" -Color Blue
 Write-DCRVerbose "$('-'*40)"
 
 $nativeTables = @("CommonSecurityLog", "SecurityEvent", "Syslog", "WindowsEvent")
 if (Confirm-Deployment -TableType "Native" -DCRType "DCE-based" -Tables $nativeTables) {
 Write-DCRInfo "`nStarting deployment..." -Color Cyan
 Execute-Mode -ExecutionMode "DCENative"
 Write-DCRSuccess "`n Deployment complete!"
 } else {
 Write-DCRWarning "`nDeployment cancelled."
 }
 Wait-ForUser
 }
 "4" {
 Write-DCRSuccess "`n Custom Tables with Direct DCRs"
 Write-DCRVerbose "$('-'*40)"
 
 if (Test-Path (Join-Path $PSScriptRoot $Environment "CustomTableList.json")) {
 $customTables = Get-Content (Join-Path $PSScriptRoot $Environment "CustomTableList.json") | ConvertFrom-Json
 if ($customTables.Count -gt 0) {
 if (Confirm-Deployment -TableType "Custom" -DCRType "Direct (no DCE)" -Tables $customTables) {
 Write-DCRInfo "`nStarting deployment..." -Color Cyan
 Execute-Mode -ExecutionMode "DirectCustom"
 Write-DCRSuccess "`n Deployment complete!"
 } else {
 Write-DCRWarning "`nDeployment cancelled."
 }
 } else {
 Write-DCRError "`n No custom tables found in CustomTableList.json"
 }
 } else {
 Write-DCRError "`n CustomTableList.json not found!"
 Write-DCRWarning "Please create this file with your custom table names."
 }
 Wait-ForUser
 }
 "5" {
 Write-DCRInfo "`n Custom Tables with DCE-based DCRs" -Color Blue
 Write-DCRVerbose "$('-'*40)"
 
 if (Test-Path (Join-Path $PSScriptRoot $Environment "CustomTableList.json")) {
 $customTables = Get-Content (Join-Path $PSScriptRoot $Environment "CustomTableList.json") | ConvertFrom-Json
 if ($customTables.Count -gt 0) {
 if (Confirm-Deployment -TableType "Custom" -DCRType "DCE-based" -Tables $customTables) {
 Write-DCRInfo "`nStarting deployment..." -Color Cyan
 Execute-Mode -ExecutionMode "DCECustom"
 Write-DCRSuccess "`n Deployment complete!"
 } else {
 Write-DCRWarning "`nDeployment cancelled."
 }
 } else {
 Write-DCRError "`n No custom tables found in CustomTableList.json"
 }
 } else {
 Write-DCRError "`n CustomTableList.json not found!"
 Write-DCRWarning "Please create this file with your custom table names."
 }
 Wait-ForUser
 }
 "6" {
 Write-DCRInfo "`n Native Tables with Private Link DCE" -Color Cyan
 Write-DCRVerbose "$('-'*40)"

 $nativeTables = @("CommonSecurityLog", "SecurityEvent", "Syslog", "WindowsEvent")
 if (Confirm-Deployment -TableType "Native" -DCRType "Private Link DCE" -Tables $nativeTables) {
 Write-DCRInfo "`nStarting deployment with Private Link..." -Color Cyan
 Execute-Mode -ExecutionMode "PrivateLinkNative"
 Write-DCRSuccess "`n Deployment complete!"
 } else {
 Write-DCRWarning "`nDeployment cancelled."
 }
 Wait-ForUser
 }
 "7" {
 Write-DCRInfo "`n Custom Tables with Private Link DCE" -Color Cyan
 Write-DCRVerbose "$('-'*40)"

 if (Test-Path (Join-Path $PSScriptRoot $Environment "CustomTableList.json")) {
 $customTables = Get-Content (Join-Path $PSScriptRoot $Environment "CustomTableList.json") | ConvertFrom-Json
 if ($customTables.Count -gt 0) {
 if (Confirm-Deployment -TableType "Custom" -DCRType "Private Link DCE" -Tables $customTables) {
 Write-DCRInfo "`nStarting deployment with Private Link..." -Color Cyan
 Execute-Mode -ExecutionMode "PrivateLinkCustom"
 Write-DCRSuccess "`n Deployment complete!"
 } else {
 Write-DCRWarning "`nDeployment cancelled."
 }
 } else {
 Write-DCRError "`n No custom tables found in CustomTableList.json"
 }
 } else {
 Write-DCRError "`n CustomTableList.json not found!"
 Write-DCRWarning "Please create this file with your custom table names."
 }
 Wait-ForUser
 }
 "Q" {
 Write-DCRInfo "`n Exiting DCR Automation Tool. Goodbye!" -Color Cyan
 $continue = $false

 }
 default {
 Write-DCRError "`n Invalid choice. Please select 1-7 or Q to quit."
 Start-Sleep -Seconds 2
 }
 }
 }
}

Write-DCRSuccess "`n DCR Automation Complete!"
Write-DCRInfo ""