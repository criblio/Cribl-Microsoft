# Run-AzureUnifiedLab.ps1
# Main entry point for Unified Azure Lab deployment
# Consolidates 6 specialized labs into one cohesive deployment system

<#
.SYNOPSIS
 Unified Azure Lab deployment system for Cribl integration testing

.DESCRIPTION
 Deploy a comprehensive Azure lab environment with modular component selection:
 - Infrastructure: VNet, VPN, Bastion, NSGs
 - Monitoring: Log Analytics, Sentinel, Flow Logs, Private Link
 - Analytics: Event Hub, Azure Data Explorer
 - Storage: Blob, Queues, Event Grid

 Supports incremental deployment - safely run multiple times to add components.

.PARAMETER Mode
 Deployment mode:
 - Full: Deploy all enabled components
 - Infrastructure: VNet and networking only
 - Monitoring: Log Analytics and monitoring only
 - Analytics: Event Hub and ADX only
 - Storage: Storage Account and Event Grid only
 - Custom: Interactive component selection
 - Status: Display configuration and resources
 - Validate: Validate configuration without deploying

.PARAMETER NonInteractive
 Run in non-interactive mode (no menus)

.EXAMPLE
 .\Run-AzureUnifiedLab.ps1
 # Interactive mode with menu

.EXAMPLE
 .\Run-AzureUnifiedLab.ps1 -NonInteractive -Mode Full
 # Deploy all enabled components without prompts

.EXAMPLE
 .\Run-AzureUnifiedLab.ps1 -NonInteractive -Mode Infrastructure
 # Deploy only infrastructure components

.EXAMPLE
 .\Run-AzureUnifiedLab.ps1 -NonInteractive -Mode Full -Verbose
 # Deploy all components with detailed verbose output
#>

[CmdletBinding()]
param(
 [Parameter(Mandatory=$false)]
 [ValidateSet("Full", "Infrastructure", "Monitoring", "Analytics", "Storage", "Custom", "Status", "Validate")]
 [string]$Mode = "",

 [Parameter(Mandatory=$false)]
 [switch]$NonInteractive
)

# Script configuration
$ErrorActionPreference = "Stop"
$ScriptRoot = $PSScriptRoot
$CorePath = Join-Path $ScriptRoot "Core"

# Clean up any orphaned jobs from previous runs to prevent log file cross-contamination
$orphanedJobs = Get-Job | Where-Object { $_.Name -like "Deploy-*" -or $_.Name -like "Generate-*" }
if ($orphanedJobs) {
 Write-Host "`n Cleaning up orphaned jobs from previous runs..." -ForegroundColor Yellow
 $orphanedJobs | Stop-Job -ErrorAction SilentlyContinue
 $orphanedJobs | Remove-Job -Force -ErrorAction SilentlyContinue
}

# Import core modules (dot-source since these are .ps1 scripts, not .psm1 modules)
Write-Host "`n Loading core modules..." -ForegroundColor Cyan

try {
 . (Join-Path $CorePath "Output-Helper.ps1")
 . (Join-Path $CorePath "Validation-Module.ps1")
 . (Join-Path $CorePath "Naming-Engine.ps1")
 . (Join-Path $CorePath "Menu-Framework.ps1")

 # Initialize logging to file
 $timestamp = Get-Date -Format "yyyy-MM-dd_HHmmss"
 $logFileName = "UnifiedLab_Deployment_$timestamp.log"
 $logFilePath = Join-Path $PSScriptRoot "logs\$logFileName"
 Initialize-LabLogging -LogPath $logFilePath

 Write-Host " Core modules loaded successfully" -ForegroundColor Green
 Write-Host "  Log file: $logFileName" -ForegroundColor Cyan
} catch {
 Write-Host " Failed to load core modules" -ForegroundColor Red
 Write-Host " Error: $($_.Exception.Message)" -ForegroundColor Yellow
 exit 1
}

# Load configuration files
Write-Host "`n Loading configuration files..." -ForegroundColor Cyan

$azureParamsPath = Join-Path $ScriptRoot "azure-parameters.json"
$operationParamsPath = Join-Path $ScriptRoot "operation-parameters.json"

if (-not (Test-Path $azureParamsPath)) {
 Write-Host " Azure parameters file not found: $azureParamsPath" -ForegroundColor Red
 exit 1
}

if (-not (Test-Path $operationParamsPath)) {
 Write-Host " Operation parameters file not found: $operationParamsPath" -ForegroundColor Red
 exit 1
}

try {
 $azureParams = Get-Content $azureParamsPath -Raw | ConvertFrom-Json
 $operationParams = Get-Content $operationParamsPath -Raw | ConvertFrom-Json
 Write-Host " Configuration files loaded successfully" -ForegroundColor Green
} catch {
 Write-Host " Failed to load configuration files" -ForegroundColor Red
 Write-Host "Error: $($_.Exception.Message)" -ForegroundColor Yellow
 exit 1
}

# Update naming suffixes based on location
Write-Host "`n Applying location-based naming suffixes..." -ForegroundColor Cyan
try {
 $azureParams = Update-NamingSuffixes -AzureParams $azureParams
 Write-Host " Naming suffixes updated for location: $($azureParams.location)" -ForegroundColor Green
} catch {
 Write-Host " Warning: Failed to update naming suffixes, using configured values" -ForegroundColor Yellow
}

# Validate configuration
Write-Host "`n Validating configuration..." -ForegroundColor Cyan

$validationResult = Test-AzureParametersConfiguration -ConfigPath $azureParamsPath -OperationParams $operationParams
if (-not $validationResult) {
 Write-Host " Configuration validation failed!" -ForegroundColor Red
 exit 1
}

# Validation function already prints success message

# Generate resource names
$resourceNames = Get-AllResourceNames -AzureParams $azureParams

# Extract common parameters
$subscriptionId = $azureParams.subscriptionId
$resourceGroupName = $azureParams.resourceGroupName
$location = $azureParams.location

# Function to check Azure authentication
function Test-AzureAuthentication {
 Write-Host "`n Checking Azure authentication..." -ForegroundColor Cyan

 try {
 $context = Get-AzContext -ErrorAction Stop

 if ($null -eq $context) {
 Write-Host " Not authenticated to Azure" -ForegroundColor Red
 Write-Host "`nPlease run: Connect-AzAccount" -ForegroundColor Yellow
 return $false
 }

 Write-Host " Authenticated as: $($context.Account.Id)" -ForegroundColor Green
 Write-Host " Subscription: $($context.Subscription.Name)" -ForegroundColor Gray

 # Set correct subscription if different
 if ($context.Subscription.Id -ne $subscriptionId) {
 Write-Host "`n Switching to configured subscription..." -ForegroundColor Yellow

 # Try to switch subscription - this may fail if user doesn't have access
 try {
 Set-AzContext -SubscriptionId $subscriptionId -ErrorAction Stop | Out-Null
 Write-Host " Subscription set to: $subscriptionId" -ForegroundColor Green
 } catch {
 # Subscription switch failed - offer options to the user
 Write-Host "`n Current account doesn't have access to configured subscription." -ForegroundColor Yellow
 Write-Host " Configured subscription: $subscriptionId" -ForegroundColor Gray
 Write-Host " Configured tenant: $($azureParams.tenantId)" -ForegroundColor Gray

 # Get all available contexts
 $availableContexts = Get-AzContext -ListAvailable -ErrorAction SilentlyContinue

 Write-Host "`n Available options:" -ForegroundColor Cyan
 Write-Host " [1] Re-authenticate with a different account" -ForegroundColor White
 Write-Host " [2] Use current account and update config to match" -ForegroundColor White
 Write-Host " [3] Cancel deployment" -ForegroundColor White

 if ($availableContexts -and $availableContexts.Count -gt 1) {
 Write-Host " [4] Switch to another cached context" -ForegroundColor White
 }

 $choice = Read-Host "`n Enter choice"

 switch ($choice) {
 "1" {
 Write-Host "`n Launching Azure login..." -ForegroundColor Cyan
 Write-Host " Please authenticate with the account that has access to subscription: $subscriptionId" -ForegroundColor Gray

 # Disconnect current session and re-authenticate
 try {
 Connect-AzAccount -TenantId $azureParams.tenantId -ErrorAction Stop | Out-Null

 # Try setting the subscription again
 Set-AzContext -SubscriptionId $subscriptionId -ErrorAction Stop | Out-Null
 $newContext = Get-AzContext
 Write-Host " Successfully authenticated as: $($newContext.Account.Id)" -ForegroundColor Green
 Write-Host " Subscription: $($newContext.Subscription.Name)" -ForegroundColor Green
 return $true
 } catch {
 Write-Host " Authentication failed: $($_.Exception.Message)" -ForegroundColor Red
 return $false
 }
 }
 "2" {
 Write-Host "`n Updating configuration to use current subscription..." -ForegroundColor Cyan
 $currentContext = Get-AzContext

 # Update the in-memory parameters
 $script:subscriptionId = $currentContext.Subscription.Id
 $azureParams.subscriptionId = $currentContext.Subscription.Id
 $azureParams.tenantId = $currentContext.Tenant.Id

 Write-Host " Using subscription: $($currentContext.Subscription.Name) ($($currentContext.Subscription.Id))" -ForegroundColor Green
 Write-Host " Using tenant: $($currentContext.Tenant.Id)" -ForegroundColor Green
 Write-Host ""
 Write-Host " NOTE: This change is temporary. To make permanent, update azure-parameters.json" -ForegroundColor Yellow
 return $true
 }
 "3" {
 Write-Host "`n Deployment cancelled by user." -ForegroundColor Yellow
 return $false
 }
 "4" {
 if ($availableContexts -and $availableContexts.Count -gt 1) {
 Write-Host "`n Available cached contexts:" -ForegroundColor Cyan
 $i = 1
 foreach ($ctx in $availableContexts) {
 $marker = if ($ctx.Account.Id -eq $context.Account.Id -and $ctx.Subscription.Id -eq $context.Subscription.Id) { " (current)" } else { "" }
 Write-Host " [$i] $($ctx.Account.Id) - $($ctx.Subscription.Name)$marker" -ForegroundColor White
 $i++
 }

 $ctxChoice = Read-Host "`n Enter context number"
 $ctxIndex = [int]$ctxChoice - 1

 if ($ctxIndex -ge 0 -and $ctxIndex -lt $availableContexts.Count) {
 $selectedContext = $availableContexts[$ctxIndex]
 Set-AzContext -Context $selectedContext -ErrorAction Stop | Out-Null

 # Check if this context can access the configured subscription
 try {
 Set-AzContext -SubscriptionId $subscriptionId -ErrorAction Stop | Out-Null
 Write-Host " Switched to: $($selectedContext.Account.Id)" -ForegroundColor Green
 Write-Host " Subscription set to: $subscriptionId" -ForegroundColor Green
 return $true
 } catch {
 Write-Host " Selected context also doesn't have access to configured subscription." -ForegroundColor Yellow
 Write-Host " Please choose option 1 or 2." -ForegroundColor Yellow
 return $false
 }
 } else {
 Write-Host " Invalid selection." -ForegroundColor Red
 return $false
 }
 } else {
 Write-Host " Invalid option." -ForegroundColor Red
 return $false
 }
 }
 default {
 Write-Host " Invalid option. Deployment cancelled." -ForegroundColor Red
 return $false
 }
 }
 }
 }

 return $true

 } catch {
 Write-Host " Azure authentication check failed" -ForegroundColor Red
 Write-Host "Error: $($_.Exception.Message)" -ForegroundColor Yellow
 return $false
 }
}

# Function to execute deployment based on mode
function Invoke-Deployment {
 param(
 [Parameter(Mandatory=$true)]
 [string]$DeploymentMode,

 [Parameter(Mandatory=$false)]
 [hashtable]$CustomComponents = @{}
 )

 Write-Host "`n$('='*80)" -ForegroundColor Cyan
 Write-Host "STARTING DEPLOYMENT: $DeploymentMode" -ForegroundColor White
 Write-Host "$('='*80)" -ForegroundColor Cyan

 $startTime = Get-Date
 $results = @{}

 try {
 # Determine which components to deploy
 $deployInfrastructure = $false
 $deployMonitoring = $false
 $deployAnalytics = $false
 $deployStorage = $false

 switch ($DeploymentMode) {
 "Full" {
 $deployInfrastructure = $operationParams.deployment.infrastructure.deployVNet
 $deployMonitoring = $operationParams.deployment.monitoring.deployLogAnalytics
 $deployAnalytics = $operationParams.deployment.analytics.deployEventHub
 $deployStorage = $operationParams.deployment.storage.deployStorageAccount
 }
 "Infrastructure" {
 $deployInfrastructure = $true
 }
 "Monitoring" {
 $deployMonitoring = $true
 }
 "Analytics" {
 $deployAnalytics = $true
 }
 "Storage" {
 $deployStorage = $true
 }
 "Custom" {
 $deployInfrastructure = $CustomComponents.Infrastructure.DeployVNet -or $CustomComponents.Infrastructure.DeployVPN -or $CustomComponents.Infrastructure.DeployBastion
 $deployMonitoring = $CustomComponents.Monitoring.DeployLogAnalytics -or $CustomComponents.Monitoring.DeploySentinel
 $deployAnalytics = $CustomComponents.Analytics.DeployEventHub -or $CustomComponents.Analytics.DeployADX
 $deployStorage = $CustomComponents.Storage.Deploy -or $CustomComponents.Storage.DeployStorage
 $deployVMs = $CustomComponents.VirtualMachines.DeployVMs
 }
 }

 # MENU OVERRIDE: Apply CustomComponents to override operation-parameters.json
 # This ensures menu selections take precedence over config file defaults
 if ($CustomComponents.Count -gt 0) {
 Write-Host "`n Applying menu configuration overrides..." -ForegroundColor Cyan

 # Create a deep copy of operationParams to avoid modifying the original
 $operationParamsOverride = $operationParams | ConvertTo-Json -Depth 10 | ConvertFrom-Json

 # Override Infrastructure settings
 if ($CustomComponents.Infrastructure) {
 if ($null -ne $CustomComponents.Infrastructure.DeployVNet) {
 $operationParamsOverride.deployment.infrastructure.deployVNet = $CustomComponents.Infrastructure.DeployVNet
 $operationParamsOverride.deployment.infrastructure.deploySubnets = $CustomComponents.Infrastructure.DeployVNet
 $operationParamsOverride.deployment.infrastructure.deployNSGs = $CustomComponents.Infrastructure.DeployVNet
 }
 if ($null -ne $CustomComponents.Infrastructure.DeployVPN) {
 $operationParamsOverride.deployment.infrastructure.deployVPNGateway = $CustomComponents.Infrastructure.DeployVPN
 }
 if ($null -ne $CustomComponents.Infrastructure.DeployBastion) {
 $operationParamsOverride.deployment.infrastructure.deployBastion = $CustomComponents.Infrastructure.DeployBastion
 }
 }

 # Override Monitoring settings
 if ($CustomComponents.Monitoring) {
 if ($null -ne $CustomComponents.Monitoring.DeployLogAnalytics) {
 $operationParamsOverride.deployment.monitoring.deployLogAnalytics = $CustomComponents.Monitoring.DeployLogAnalytics
 }
 if ($null -ne $CustomComponents.Monitoring.DeploySentinel) {
 $operationParamsOverride.deployment.monitoring.deploySentinel = $CustomComponents.Monitoring.DeploySentinel
 }
 if ($null -ne $CustomComponents.Monitoring.DeployFlowLogs) {
 $operationParamsOverride.deployment.monitoring.deployFlowLogs = $CustomComponents.Monitoring.DeployFlowLogs
 }
 if ($null -ne $CustomComponents.Monitoring.DeployPrivateLink) {
 $operationParamsOverride.deployment.monitoring.deployPrivateLink = $CustomComponents.Monitoring.DeployPrivateLink
 }
 }

 # Override Analytics settings
 if ($CustomComponents.Analytics) {
 if ($null -ne $CustomComponents.Analytics.DeployEventHub) {
 $operationParamsOverride.deployment.analytics.deployEventHub = $CustomComponents.Analytics.DeployEventHub
 }
 if ($null -ne $CustomComponents.Analytics.DeployADX) {
 $operationParamsOverride.deployment.analytics.deployADX = $CustomComponents.Analytics.DeployADX
 }
 }

 # Override Storage settings
 if ($CustomComponents.Storage) {
 # Support both 'Deploy' (from menu configs) and 'DeployStorage' (for consistency)
 $storageValue = if ($null -ne $CustomComponents.Storage.Deploy) { $CustomComponents.Storage.Deploy } else { $CustomComponents.Storage.DeployStorage }

 if ($null -ne $storageValue) {
 $operationParamsOverride.deployment.storage.deployStorageAccount = $storageValue
 }
 if ($null -ne $CustomComponents.Storage.DeployContainers) {
 $operationParamsOverride.deployment.storage.deployContainers = $CustomComponents.Storage.DeployContainers
 }
 if ($null -ne $CustomComponents.Storage.DeployQueues) {
 $operationParamsOverride.deployment.storage.deployQueues = $CustomComponents.Storage.DeployQueues
 }
 if ($null -ne $CustomComponents.Storage.DeployEventGrid) {
 $operationParamsOverride.deployment.storage.deployEventGrid = $CustomComponents.Storage.DeployEventGrid
 }
 }

 # Override VirtualMachines settings
 if ($CustomComponents.VirtualMachines) {
 if ($null -ne $CustomComponents.VirtualMachines.DeployVMs) {
 $operationParamsOverride.deployment.virtualMachines.deployVMs = $CustomComponents.VirtualMachines.DeployVMs
 }
 }

 # Replace operationParams with the overridden version for all downstream scripts
 $operationParams = $operationParamsOverride

 Write-Host " Menu overrides applied successfully" -ForegroundColor Green
 }

 # Helper function to log - uses the unified log file initialized at script start
 function Write-Log {
 param(
 [string]$Message,
 [string]$Level = "INFO"
 )
 Write-ToLog -Message $Message -Level $Level
 }

 Write-Log "Deployment started: $DeploymentMode"
 Write-Log "Resource Group: $resourceGroupName"
 Write-Log "Location: $location"

 # Get current Azure context for job initialization
 $currentContext = Get-AzContext
 $subscriptionId = $currentContext.Subscription.Id
 $tenantId = $currentContext.Tenant.Id
 $menuFrameworkPath = Join-Path $CorePath "Menu-Framework.ps1"
 $outputHelperPath = Join-Path $CorePath "Output-Helper.ps1"
 $unifiedLogPath = $global:LabLogFilePath  # Use the unified log file for all jobs

 # ============================================================================
 # PRE-DEPLOYMENT: Collect required user input upfront
 # ============================================================================
 # Prompt for VM password before starting deployment if password auth is configured
 $vmPassword = $null
 $deployVMs = $operationParams.deployment.virtualMachines.deployVMs -and $azureParams.virtualMachines.enabled
 if ($deployVMs -and $azureParams.virtualMachines.configuration.authenticationType -eq "password") {
 Write-Host "`n Pre-Deployment: Collecting required credentials" -ForegroundColor Cyan
 $vmPassword = Read-Host "Enter Password for VMs" -AsSecureString
 Write-Host ""
 }

 # ============================================================================
 # PHASE 1: Resource Group + TTL Logic App (~1-2 min)
 # ============================================================================
 Write-Host "`n PHASE 1: Resource Group + TTL Logic App" -NoNewline -ForegroundColor Cyan
 Write-Host " (~1-2 min)" -ForegroundColor DarkGray -NoNewline

 $rgSuccess = $false

 if ($deployInfrastructure) {
 Write-Log "PHASE 1: Creating Resource Group and TTL Logic App"

 try {
 # Create Resource Group with TTL tags
 $rg = Get-AzResourceGroup -Name $resourceGroupName -ErrorAction SilentlyContinue

 if ($null -eq $rg) {
 # Create base tags
 $tags = @{
 "Environment" = "Lab"
 "ManagedBy" = "UnifiedAzureLab"
 "CreatedDate" = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ssZ")
 }

 # Add TTL tags if enabled
 if ($azureParams.timeToLive.enabled) {
 $expirationTime = (Get-Date).AddHours($azureParams.timeToLive.hours)
 $warningTime = $expirationTime.AddHours(-$azureParams.timeToLive.warningHours)

 $tags["TTL_Enabled"] = "true"
 $tags["TTL_ExpirationTime"] = $expirationTime.ToString("yyyy-MM-ddTHH:mm:ssZ")
 $tags["TTL_WarningTime"] = $warningTime.ToString("yyyy-MM-ddTHH:mm:ssZ")
 $tags["TTL_UserEmail"] = $azureParams.timeToLive.userEmail
 $tags["TTL_Hours"] = $azureParams.timeToLive.hours.ToString()
 }

 $rg = New-AzResourceGroup -Name $resourceGroupName -Location $location -Tag $tags -ErrorAction Stop
 Write-Log "Resource Group created: $resourceGroupName" -Level "SUCCESS"
 $rgSuccess = $true
 } else {
 # Update TTL tags if RG exists and TTL is enabled
 if ($azureParams.timeToLive.enabled) {
 $existingTags = $rg.Tags
 if ($null -eq $existingTags) { $existingTags = @{} }

 $expirationTime = (Get-Date).AddHours($azureParams.timeToLive.hours)
 $warningTime = $expirationTime.AddHours(-$azureParams.timeToLive.warningHours)

 $existingTags["TTL_Enabled"] = "true"
 $existingTags["TTL_ExpirationTime"] = $expirationTime.ToString("yyyy-MM-ddTHH:mm:ssZ")
 $existingTags["TTL_WarningTime"] = $warningTime.ToString("yyyy-MM-ddTHH:mm:ssZ")
 $existingTags["TTL_UserEmail"] = $azureParams.timeToLive.userEmail
 $existingTags["TTL_Hours"] = $azureParams.timeToLive.hours.ToString()
 $existingTags["TTL_WarningSent"] = "false"

 Set-AzResourceGroup -Name $resourceGroupName -Tag $existingTags | Out-Null
 }
 Write-Log "Resource Group already exists: $resourceGroupName (TTL extended)" -Level "SUCCESS"
 $rgSuccess = $true
 }

 $results["ResourceGroup"] = @{
 Status = "Success"
 Message = "Resource Group ready"
 }

 } catch {
 Write-Log "Resource Group creation failed: $($_.Exception.Message)" -Level "ERROR"
 $results["ResourceGroup"] = @{
 Status = "Failed"
 Message = $_.Exception.Message
 }
 Write-Host " [FAILED]" -ForegroundColor Red
 }

 # Deploy TTL Logic App (if RG succeeded and TTL enabled)
 if ($rgSuccess -and $azureParams.timeToLive.enabled) {
 $ttlScript = Join-Path $CorePath "Deploy-TTLCleanupFunction.ps1"

 if (Test-Path $ttlScript) {
 try {
 $ttlJob = Start-Job -Name "Deploy-TTLCleanup" -ScriptBlock {
 param($Script, $AzParams, $OpParams, $RgName, $Loc, $ResNames, $MenuFwPath, $OutHelpPath, $SubId, $TenantId, $LogPath)
 Import-Module Az.Accounts, Az.Resources -ErrorAction SilentlyContinue
 Set-AzContext -SubscriptionId $SubId -TenantId $TenantId -ErrorAction SilentlyContinue | Out-Null
 . $OutHelpPath
 . $MenuFwPath
 # Initialize logging to unified log file
 $global:LabLogFilePath = $LogPath
 $global:LabLogToFileEnabled = $true
 & $Script -AzureParams $AzParams -OperationParams $OpParams -ResourceGroupName $RgName -Location $Loc -ResourceNames $ResNames *>&1
 } -ArgumentList $ttlScript, $azureParams, $operationParams, $resourceGroupName, $location, $resourceNames, $menuFrameworkPath, $outputHelperPath, $subscriptionId, $tenantId, $unifiedLogPath

 $ttlJob | Wait-Job | Out-Null
 $ttlResult = Receive-Job -Job $ttlJob
 Remove-Job -Job $ttlJob -Force

 $results["TTLCleanup"] = @{
 Status = "Success"
 Message = "TTL Logic App deployed"
 }
 Write-Log "TTL Logic App deployed successfully" -Level "SUCCESS"
 } catch {
 Write-Log "TTL Logic App deployment failed: $($_.Exception.Message)" -Level "ERROR"
 $results["TTLCleanup"] = @{
 Status = "Failed"
 Message = $_.Exception.Message
 }
 }
 } else {
 $results["TTLCleanup"] = @{ Status = "Skipped"; Message = "Script not found" }
 }
 } elseif (-not $azureParams.timeToLive.enabled) {
 $results["TTLCleanup"] = @{ Status = "Skipped"; Message = "TTL not enabled" }
 } else {
 $results["TTLCleanup"] = @{ Status = "Skipped"; Message = "RG creation failed" }
 }

 # Show Phase 1 result
 if ($results["ResourceGroup"].Status -eq "Success") {
 if ($results["TTLCleanup"].Status -eq "Success") {
 Write-Host " [OK]" -ForegroundColor Green
 } elseif ($results["TTLCleanup"].Status -eq "Skipped") {
 Write-Host " [OK]" -ForegroundColor Green
 } else {
 Write-Host " [PARTIAL]" -ForegroundColor Yellow
 }
 } else {
 Write-Host " [FAILED]" -ForegroundColor Red
 }
 } else {
 $results["ResourceGroup"] = @{ Status = "Skipped"; Message = "Infrastructure deployment disabled" }
 $results["TTLCleanup"] = @{ Status = "Skipped"; Message = "Infrastructure deployment disabled" }
 Write-Host " [SKIPPED]" -ForegroundColor DarkGray
 Write-Log "Phase 1 skipped - Infrastructure deployment disabled"
 }

 # ============================================================================
 # PHASE 2: Networking - VNet, Subnet, NSG (~3-5 min)
 # Note: VPN Gateway moved to Phase 6 (runs last due to 30-45 min deployment time)
 # ============================================================================
 Write-Host " PHASE 2: Networking (VNet, Subnet, NSG)" -NoNewline -ForegroundColor Cyan
 Write-Host " (~3-5 min)" -ForegroundColor DarkGray -NoNewline

 if ($deployInfrastructure -and $rgSuccess) {
 Write-Log "PHASE 2: Starting Networking deployment"
 $infraScript = Join-Path $CorePath "Deploy-Networking.ps1"

 try {
 $infraJob = Start-Job -Name "Deploy-Networking" -ScriptBlock {
 param($Script, $AzParams, $OpParams, $RgName, $Loc, $ResNames, $MenuFwPath, $OutHelpPath, $SubId, $TenantId, $LogPath)
 Import-Module Az.Accounts, Az.Resources, Az.Network -ErrorAction SilentlyContinue
 Set-AzContext -SubscriptionId $SubId -TenantId $TenantId -ErrorAction SilentlyContinue | Out-Null
 . $OutHelpPath
 . $MenuFwPath
 # Initialize logging to unified log file
 $global:LabLogFilePath = $LogPath
 $global:LabLogToFileEnabled = $true
 & $Script -AzureParams $AzParams -OperationParams $OpParams -ResourceGroupName $RgName -Location $Loc -ResourceNames $ResNames *>&1
 } -ArgumentList $infraScript, $azureParams, $operationParams, $resourceGroupName, $location, $resourceNames, $menuFrameworkPath, $outputHelperPath, $subscriptionId, $tenantId, $unifiedLogPath

 $infraJob | Wait-Job | Out-Null
 $infraResult = Receive-Job -Job $infraJob
 Remove-Job -Job $infraJob -Force

 $results["Infrastructure"] = @{
 Status = "Success"
 Message = "Networking deployed successfully"
 Data = $infraResult
 }
 Write-Host " [OK]" -ForegroundColor Green
 Write-Log "Infrastructure deployment completed successfully" -Level "SUCCESS"
 } catch {
 Write-Log "Infrastructure deployment failed: $($_.Exception.Message)" -Level "ERROR"
 $results["Infrastructure"] = @{
 Status = "Failed"
 Message = $_.Exception.Message
 Data = $null
 }
 Write-Host " [FAILED]" -ForegroundColor Red
 }
 } else {
 $results["Infrastructure"] = @{
 Status = "Skipped"
 Message = "Infrastructure deployment disabled or RG failed"
 Data = $null
 }
 Write-Host " [SKIPPED]" -ForegroundColor DarkGray
 Write-Log "Infrastructure deployment skipped"
 }

 # ============================================================================
 # PHASE 3: Storage, Monitoring, Analytics (Parallel) (~10-15 min)
 # ============================================================================
 Write-Host " PHASE 3: Storage, Monitoring, Analytics" -NoNewline -ForegroundColor Cyan
 Write-Host " (~10-15 min, parallel)" -ForegroundColor DarkGray -NoNewline

 Write-Log "PHASE 3: Starting parallel component deployments"

 # Get VNet reference for Monitoring (if available)
 $vnet = $null
 if ($results["Infrastructure"].Data.VNet) {
 $vnet = $results["Infrastructure"].Data.VNet
 } else {
 $vnet = Get-AzVirtualNetwork -ResourceGroupName $resourceGroupName -Name $resourceNames.VNet -ErrorAction SilentlyContinue
 }

 # Prepare parallel jobs
 $parallelJobs = @()
 $jobNames = @{}

 # Storage Job
 if ($deployStorage) {
 Write-Log "Starting Storage deployment job"
 $storageScript = Join-Path $CorePath "Deploy-Storage.ps1"
 $storageJob = Start-Job -Name "Deploy-Storage" -ScriptBlock {
 param($Script, $AzParams, $OpParams, $RgName, $Loc, $ResNames, $SubId, $TenantId, $MenuFwPath, $OutHelpPath, $LogPath)
 Import-Module Az.Accounts, Az.Storage, Az.EventGrid -ErrorAction SilentlyContinue
 Set-AzContext -SubscriptionId $SubId -TenantId $TenantId -ErrorAction SilentlyContinue | Out-Null
 . $OutHelpPath
 . $MenuFwPath
 # Initialize logging to unified log file
 $global:LabLogFilePath = $LogPath
 $global:LabLogToFileEnabled = $true
 & $Script -AzureParams $AzParams -OperationParams $OpParams -ResourceGroupName $RgName -Location $Loc -ResourceNames $ResNames *>&1
 } -ArgumentList $storageScript, $azureParams, $operationParams, $resourceGroupName, $location, $resourceNames, $subscriptionId, $tenantId, $menuFrameworkPath, $outputHelperPath, $unifiedLogPath
 $parallelJobs += $storageJob
 $jobNames[$storageJob.Id] = "Storage"
 } else {
 $results["Storage"] = @{ Status = "Skipped"; Message = "Storage deployment disabled"; Data = $null }
 Write-Log "Storage deployment skipped"
 }

 # Monitoring Job
 if ($deployMonitoring) {
 Write-Log "Starting Monitoring deployment job"
 $monitoringScript = Join-Path $CorePath "Deploy-Monitoring.ps1"
 $monitoringJob = Start-Job -Name "Deploy-Monitoring" -ScriptBlock {
 param($Script, $AzParams, $OpParams, $RgName, $Loc, $ResNames, $VNetObj, $SubId, $TenantId, $MenuFwPath, $OutHelpPath, $LogPath)
 Import-Module Az.Accounts, Az.OperationalInsights, Az.SecurityInsights, Az.Network -ErrorAction SilentlyContinue
 Set-AzContext -SubscriptionId $SubId -TenantId $TenantId -ErrorAction SilentlyContinue | Out-Null
 . $OutHelpPath
 . $MenuFwPath
 # Initialize logging to unified log file
 $global:LabLogFilePath = $LogPath
 $global:LabLogToFileEnabled = $true
 & $Script -AzureParams $AzParams -OperationParams $OpParams -ResourceGroupName $RgName -Location $Loc -ResourceNames $ResNames -VNet $VNetObj *>&1
 } -ArgumentList $monitoringScript, $azureParams, $operationParams, $resourceGroupName, $location, $resourceNames, $vnet, $subscriptionId, $tenantId, $menuFrameworkPath, $outputHelperPath, $unifiedLogPath
 $parallelJobs += $monitoringJob
 $jobNames[$monitoringJob.Id] = "Monitoring"
 } else {
 $results["Monitoring"] = @{ Status = "Skipped"; Message = "Monitoring deployment disabled"; Data = $null }
 Write-Log "Monitoring deployment skipped"
 }

 # Analytics Job
 if ($deployAnalytics) {
 Write-Log "Starting Analytics deployment job"
 $analyticsScript = Join-Path $CorePath "Deploy-Analytics.ps1"
 $analyticsJob = Start-Job -Name "Deploy-Analytics" -ScriptBlock {
 param($Script, $AzParams, $OpParams, $RgName, $Loc, $ResNames, $SubId, $TenantId, $MenuFwPath, $OutHelpPath, $LogPath)
 Import-Module Az.Accounts, Az.EventHub, Az.Kusto -ErrorAction SilentlyContinue
 Set-AzContext -SubscriptionId $SubId -TenantId $TenantId -ErrorAction SilentlyContinue | Out-Null
 . $OutHelpPath
 . $MenuFwPath
 # Initialize logging to unified log file
 $global:LabLogFilePath = $LogPath
 $global:LabLogToFileEnabled = $true
 & $Script -AzureParams $AzParams -OperationParams $OpParams -ResourceGroupName $RgName -Location $Loc -ResourceNames $ResNames *>&1
 } -ArgumentList $analyticsScript, $azureParams, $operationParams, $resourceGroupName, $location, $resourceNames, $subscriptionId, $tenantId, $menuFrameworkPath, $outputHelperPath, $unifiedLogPath
 $parallelJobs += $analyticsJob
 $jobNames[$analyticsJob.Id] = "Analytics"
 } else {
 $results["Analytics"] = @{ Status = "Skipped"; Message = "Analytics deployment disabled"; Data = $null }
 Write-Log "Analytics deployment skipped"
 }

 # Wait for parallel jobs and collect results
 if ($parallelJobs.Count -gt 0) {
 $runningComponents = $jobNames.Values -join ", "
 Write-Log "Waiting for parallel jobs: $runningComponents"

 # Wait for all jobs to complete
 $parallelJobs | Wait-Job | Out-Null

 # Collect results
 $phase3Success = $true
 foreach ($job in $parallelJobs) {
 $jobName = $jobNames[$job.Id]

 try {
 $jobOutput = Receive-Job -Job $job -ErrorAction Stop

 $results[$jobName] = @{
 Status = "Success"
 Message = "$jobName deployed successfully"
 Data = $jobOutput
 }
 Write-Log "$jobName deployment completed successfully" -Level "SUCCESS"
 } catch {
 $phase3Success = $false
 Write-Log "$jobName deployment failed: $($_.Exception.Message)" -Level "ERROR"
 $results[$jobName] = @{
 Status = "Failed"
 Message = $_.Exception.Message
 Data = $null
 }
 }
 Remove-Job -Job $job -Force
 }

 if ($phase3Success) {
 Write-Host " [OK]" -ForegroundColor Green
 } else {
 Write-Host " [PARTIAL]" -ForegroundColor Yellow
 }
 } else {
 Write-Host " [SKIPPED]" -ForegroundColor DarkGray
 }

 # ============================================================================
 # PHASE 4: VMs, DCRs (~5-10 min)
 # ============================================================================
 Write-Host " PHASE 4: VMs, DCRs" -NoNewline -ForegroundColor Cyan
 Write-Host " (~5-10 min)" -ForegroundColor DarkGray -NoNewline

 Write-Log "PHASE 4: Starting dependent component deployments"
 $phase4Success = $true
 $phase4HasWork = $false

 # VM deployment (depends on Infrastructure/VNet)
 # Note: $deployVMs and $vmPassword are set in PRE-DEPLOYMENT section
 if ($deployVMs) {
 $phase4HasWork = $true
 Write-Log "Starting VM deployment"
 $vmScript = Join-Path $CorePath "Deploy-VMs.ps1"

 try {
 # Use Start-Job to isolate console output
 $vmJob = Start-Job -Name "Deploy-VMs" -ScriptBlock {
 param($Script, $AzParams, $OpParams, $RgName, $Loc, $ResNames, $MenuFwPath, $OutHelpPath, $SubId, $TenantId, $LogPath, $VmPwd)
 Import-Module Az.Accounts, Az.Compute, Az.Network -ErrorAction SilentlyContinue
 Set-AzContext -SubscriptionId $SubId -TenantId $TenantId -ErrorAction SilentlyContinue | Out-Null
 . $OutHelpPath
 . $MenuFwPath
 # Initialize logging to unified log file
 $global:LabLogFilePath = $LogPath
 $global:LabLogToFileEnabled = $true
 & $Script -AzureParams $AzParams -OperationParams $OpParams -ResourceGroupName $RgName -Location $Loc -ResourceNames $ResNames -VMPassword $VmPwd *>&1
 } -ArgumentList $vmScript, $azureParams, $operationParams, $resourceGroupName, $location, $resourceNames, $menuFrameworkPath, $outputHelperPath, $subscriptionId, $tenantId, $unifiedLogPath, $vmPassword

 $vmJob | Wait-Job | Out-Null
 $vmResult = Receive-Job -Job $vmJob
 Remove-Job -Job $vmJob -Force

 $results["VirtualMachines"] = @{
 Status = "Success"
 Message = "Virtual Machines deployed successfully"
 Data = $vmResult
 }
 Write-Log "VM deployment completed successfully" -Level "SUCCESS"
 } catch {
 $phase4Success = $false
 Write-Log "VM deployment failed: $($_.Exception.Message)" -Level "ERROR"
 $results["VirtualMachines"] = @{
 Status = "Failed"
 Message = $_.Exception.Message
 Data = $null
 }
 }
 } else {
 $results["VirtualMachines"] = @{
 Status = "Skipped"
 Message = "VM deployment disabled"
 Data = $null
 }
 Write-Log "VM deployment skipped"
 }

 # DCR deployment (depends on Monitoring/Log Analytics)
 if ($deployMonitoring -and $results["Monitoring"].Status -eq "Success") {
 $phase4HasWork = $true
 Write-Log "Starting DCR deployment"
 $dcrScript = Join-Path $CorePath "Deploy-DCRs.ps1"

 try {
 # Use Start-Job to isolate console output
 $dcrJob = Start-Job -Name "Deploy-DCRs" -ScriptBlock {
 param($Script, $AzParams, $OpParams, $RgName, $Loc, $ResNames, $LabModeVal, $MenuFwPath, $OutHelpPath, $SubId, $TenantId, $LogPath)
 Import-Module Az.Accounts, Az.Monitor -ErrorAction SilentlyContinue
 Set-AzContext -SubscriptionId $SubId -TenantId $TenantId -ErrorAction SilentlyContinue | Out-Null
 . $OutHelpPath
 . $MenuFwPath
 # Initialize logging to unified log file
 $global:LabLogFilePath = $LogPath
 $global:LabLogToFileEnabled = $true
 & $Script -AzureParams $AzParams -OperationParams $OpParams -ResourceGroupName $RgName -Location $Loc -ResourceNames $ResNames -LabMode $LabModeVal *>&1
 } -ArgumentList $dcrScript, $azureParams, $operationParams, $resourceGroupName, $location, $resourceNames, $labMode, $menuFrameworkPath, $outputHelperPath, $subscriptionId, $tenantId, $unifiedLogPath

 $dcrJob | Wait-Job | Out-Null
 $dcrResult = Receive-Job -Job $dcrJob
 Remove-Job -Job $dcrJob -Force

 $results["DCRs"] = @{
 Status = "Success"
 Message = "DCRs deployed successfully"
 Data = $dcrResult
 }
 Write-Log "DCR deployment completed successfully" -Level "SUCCESS"
 } catch {
 $phase4Success = $false
 $results["DCRs"] = @{
 Status = "Failed"
 Message = $_.Exception.Message
 Data = $null
 }
 Write-Log "DCR deployment failed: $($_.Exception.Message)" -Level "ERROR"
 }
 } else {
 $results["DCRs"] = @{
 Status = "Skipped"
 Message = "DCR deployment skipped (Monitoring not deployed or failed)"
 Data = $null
 }
 Write-Log "DCR deployment skipped"
 }

 if (-not $phase4HasWork) {
 Write-Host " [SKIPPED]" -ForegroundColor DarkGray
 } elseif ($phase4Success) {
 Write-Host " [OK]" -ForegroundColor Green
 } else {
 Write-Host " [PARTIAL]" -ForegroundColor Yellow
 }

 # ============================================================================
 # PHASE 5: Cribl Configuration Generation (~1 min)
 # ============================================================================
 Write-Host " PHASE 5: Cribl Configs" -NoNewline -ForegroundColor Cyan
 Write-Host " (~1 min)" -ForegroundColor DarkGray -NoNewline

 Write-Log "PHASE 5: Starting Cribl configuration generation"
 $criblConfigScript = Join-Path $CorePath "Generate-CriblConfigs.ps1"
 $criblConfigsDir = Join-Path $PSScriptRoot "Cribl-Configs"

 try {
 # Use Start-Job to isolate console output
 $criblJob = Start-Job -Name "Generate-CriblConfigs" -ScriptBlock {
 param($Script, $AzParams, $OpParams, $RgName, $Loc, $ResNames, $OutDir, $MenuFwPath, $OutHelpPath, $SubId, $TenantId, $LogPath)
 Import-Module Az.Accounts -ErrorAction SilentlyContinue
 Set-AzContext -SubscriptionId $SubId -TenantId $TenantId -ErrorAction SilentlyContinue | Out-Null
 . $OutHelpPath
 . $MenuFwPath
 # Initialize logging to unified log file
 $global:LabLogFilePath = $LogPath
 $global:LabLogToFileEnabled = $true
 & $Script -AzureParams $AzParams -OperationParams $OpParams -ResourceGroupName $RgName -Location $Loc -ResourceNames $ResNames -OutputDirectory $OutDir *>&1
 } -ArgumentList $criblConfigScript, $azureParams, $operationParams, $resourceGroupName, $location, $resourceNames, $criblConfigsDir, $menuFrameworkPath, $outputHelperPath, $subscriptionId, $tenantId, $unifiedLogPath

 $criblJob | Wait-Job | Out-Null
 $criblConfigs = Receive-Job -Job $criblJob
 Remove-Job -Job $criblJob -Force

 $results["CriblConfigs"] = @{
 Status = "Success"
 Message = "Cribl configurations generated successfully"
 Data = $criblConfigs
 }
 Write-Host " [OK]" -ForegroundColor Green
 Write-Log "Cribl configuration generation completed" -Level "SUCCESS"
 } catch {
 $results["CriblConfigs"] = @{
 Status = "Failed"
 Message = $_.Exception.Message
 }
 Write-Host " [FAILED]" -ForegroundColor Red
 Write-Log "Cribl configuration generation failed: $($_.Exception.Message)" -Level "ERROR"
 }

 # ============================================================================
 # PHASE 6: VPN Gateway (~30-45 min)
 # ============================================================================
 $vpnEnabled = $operationParams.deployment.infrastructure.deployVPNGateway -and $azureParams.infrastructure.vpnGateway.enabled
 if ($vpnEnabled) {
 Write-Host " PHASE 6: VPN Gateway" -NoNewline -ForegroundColor Cyan
 Write-Host " (~30-45 min)" -ForegroundColor DarkGray -NoNewline

 if ($deployInfrastructure -and $results["Infrastructure"].Status -eq "Success") {
 Write-Log "PHASE 6: Starting VPN Gateway deployment"
 $vpnScript = Join-Path $CorePath "Deploy-VPN.ps1"

 try {
 $vpnJob = Start-Job -Name "Deploy-VPN" -ScriptBlock {
 param($Script, $AzParams, $OpParams, $RgName, $Loc, $ResNames, $MenuFwPath, $OutHelpPath, $SubId, $TenantId, $LogPath)
 Import-Module Az.Accounts, Az.Network -ErrorAction SilentlyContinue
 Set-AzContext -SubscriptionId $SubId -TenantId $TenantId -ErrorAction SilentlyContinue | Out-Null
 . $OutHelpPath
 . $MenuFwPath
 $global:LabLogFilePath = $LogPath
 $global:LabLogToFileEnabled = $true
 & $Script -AzureParams $AzParams -OperationParams $OpParams -ResourceGroupName $RgName -Location $Loc -ResourceNames $ResNames *>&1
 } -ArgumentList $vpnScript, $azureParams, $operationParams, $resourceGroupName, $location, $resourceNames, $menuFrameworkPath, $outputHelperPath, $subscriptionId, $tenantId, $unifiedLogPath

 $vpnJob | Wait-Job | Out-Null
 $vpnResult = Receive-Job -Job $vpnJob
 Remove-Job -Job $vpnJob -Force

 $results["VPNGateway"] = @{
 Status = "Success"
 Message = "VPN Gateway deployed successfully"
 Data = $vpnResult
 }
 Write-Host " [OK]" -ForegroundColor Green
 Write-Log "VPN Gateway deployment completed successfully" -Level "SUCCESS"
 } catch {
 $results["VPNGateway"] = @{
 Status = "Failed"
 Message = $_.Exception.Message
 Data = $null
 }
 Write-Host " [FAILED]" -ForegroundColor Red
 Write-Log "VPN Gateway deployment failed: $($_.Exception.Message)" -Level "ERROR"
 }
 } else {
 $results["VPNGateway"] = @{
 Status = "Skipped"
 Message = "VPN Gateway skipped (Infrastructure not deployed)"
 Data = $null
 }
 Write-Host " [SKIPPED]" -ForegroundColor DarkGray
 Write-Log "VPN Gateway deployment skipped - Infrastructure not available"
 }
 } else {
 $results["VPNGateway"] = @{
 Status = "Skipped"
 Message = "VPN Gateway deployment disabled"
 Data = $null
 }
 }

 # ============================================================================
 # DEPLOYMENT COMPLETE - Summary
 # ============================================================================
 $endTime = Get-Date
 $duration = $endTime - $startTime

 Write-Log "Deployment completed in $([math]::Round($duration.TotalMinutes, 2)) minutes"

 # Build clean summary
 Write-Host "`n"
 Write-Host "$('='*60)" -ForegroundColor Green
 Write-Host " DEPLOYMENT COMPLETE" -ForegroundColor White
 Write-Host "$('='*60)" -ForegroundColor Green

 Write-Host "`n Deployment Time: $([math]::Round($duration.TotalMinutes, 2)) minutes" -ForegroundColor Cyan
 Write-Host " Resource Group: $resourceGroupName" -ForegroundColor White

 # TTL Info (if enabled)
 if ($azureParams.timeToLive.enabled -and $results["TTLCleanup"].Status -eq "Success") {
 $ttlHours = $azureParams.timeToLive.hours
 $expirationTime = (Get-Date).AddHours($ttlHours)
 Write-Host "`n TTL Auto-Cleanup: ENABLED" -ForegroundColor Yellow
 Write-Host " Expires: $($expirationTime.ToString('yyyy-MM-dd HH:mm')) ($ttlHours hours)" -ForegroundColor Yellow
 }

 # Component Status Summary
 Write-Host "`n Results:" -ForegroundColor Cyan
 $componentOrder = @("ResourceGroup", "TTLCleanup", "Infrastructure", "Storage", "Monitoring", "Analytics", "VirtualMachines", "DCRs", "CriblConfigs", "VPNGateway")

 $successCount = 0
 $failedCount = 0
 $skippedCount = 0

 foreach ($component in $componentOrder) {
 if ($results.ContainsKey($component)) {
 $status = $results[$component].Status
 switch ($status) {
 "Success" {
 Write-Host " [OK] $component" -ForegroundColor Green
 $successCount++
 }
 "Failed" {
 Write-Host " [FAIL] $component" -ForegroundColor Red
 $failedCount++
 }
 "Skipped" {
 Write-Host " [--] $component" -ForegroundColor DarkGray
 $skippedCount++
 }
 }
 }
 }

 Write-Host "`n $successCount succeeded, $failedCount failed, $skippedCount skipped" -ForegroundColor Gray

 # Key Resources
 Write-Host "`n Resources:" -ForegroundColor Cyan
 if ($results["Infrastructure"].Status -eq "Success") {
 Write-Host " VNet: $($resourceNames.VNet)" -ForegroundColor White
 }
 if ($results["Monitoring"].Status -eq "Success") {
 Write-Host " Log Analytics: $($resourceNames.LogAnalytics)" -ForegroundColor White
 }
 if ($results["Storage"].Status -eq "Success") {
 Write-Host " Storage: $($resourceNames.StorageAccount)" -ForegroundColor White
 }
 if ($results["Analytics"].Status -eq "Success") {
 Write-Host " Event Hub: $($resourceNames.EventHubNamespace)" -ForegroundColor White
 }

 # Output locations
 Write-Host "`n Output:" -ForegroundColor Cyan
 if ($results["CriblConfigs"].Status -eq "Success") {
 Write-Host " Cribl Configs: $criblConfigsDir" -ForegroundColor White
 }
 Write-Host " Log: $unifiedLogPath" -ForegroundColor White

 Write-Host "`n$('='*60)" -ForegroundColor Green

 return $results

 } catch {
 Write-Host "`n DEPLOYMENT FAILED!" -ForegroundColor Red
 Write-Host "Error: $($_.Exception.Message)" -ForegroundColor Yellow
 throw
 }
}

# Function to display current status
function Show-Status {
 Show-MenuHeader -Title "AZURE UNIFIED LAB - STATUS"
 Show-ConfigurationSummary -AzureParams $azureParams -OperationParams $operationParams

 Write-Host "`n Planned Resource Names:" -ForegroundColor Cyan
 Show-ResourceNames -Names $resourceNames

 Write-Host "`n Checking deployed resources..." -ForegroundColor Cyan

 # Check for existing resources
 $rg = Get-AzResourceGroup -Name $resourceGroupName -ErrorAction SilentlyContinue
 if ($null -ne $rg) {
 Write-Host "`n Resource Group exists: $resourceGroupName" -ForegroundColor Green

 $resources = Get-AzResource -ResourceGroupName $resourceGroupName
 Write-Host "`n Deployed Resources ($($resources.Count)):" -ForegroundColor Cyan

 foreach ($resource in $resources | Sort-Object ResourceType) {
 Write-Host " $($resource.ResourceType): $($resource.Name)" -ForegroundColor White
 }
 } else {
 Write-Host "`n Resource Group does not exist: $resourceGroupName" -ForegroundColor Yellow
 Write-Host " Run deployment to create resources" -ForegroundColor Gray
 }
}

# Main execution
function Main {
 # Check Azure authentication
 if (-not (Test-AzureAuthentication)) {
 exit 1
 }

 # Non-interactive mode
 if ($NonInteractive) {
 if ([string]::IsNullOrWhiteSpace($Mode)) {
 Write-Host " Mode parameter is required in non-interactive mode" -ForegroundColor Red
 Write-Host " Use: -Mode Full|Infrastructure|Monitoring|Analytics|Storage|Validate" -ForegroundColor Yellow
 exit 1
 }

 if ($Mode -eq "Status") {
 Show-Status
 exit 0
 }

 if ($Mode -eq "Validate") {
 Write-Host "`n Configuration validation passed!" -ForegroundColor Green
 exit 0
 }

 # Execute deployment
 Invoke-Deployment -DeploymentMode $Mode
 exit 0
 }

 # Interactive mode
 $continue = $true

 # Prompt for lab mode at the beginning (public/private)
 $labMode = Get-LabMode -AzureParams $azureParams

 # Update azure-parameters.json if mode changed
 if ($labMode -ne $azureParams.labMode) {
 $azureParams.labMode = $labMode
 Write-Host "`n Lab mode updated to: $labMode" -ForegroundColor Cyan

 # Auto-enable/disable private endpoints based on mode
 if ($labMode -eq "private") {
 $operationParams.privateEndpoints.deployAll = $true
 Write-Host " Private endpoints enabled for all resources" -ForegroundColor Green
 } else {
 $operationParams.privateEndpoints.deployAll = $false
 Write-Host " Public endpoints will be used" -ForegroundColor Green
 }
 }

 while ($continue) {
 Show-MenuHeader
 Show-ConfigurationSummary -AzureParams $azureParams -OperationParams $operationParams
 Show-DeploymentMenu -LabMode $labMode

 $choice = Read-Host "`nSelect option"

 switch ($choice.ToUpper()) {
 "1" {
 # Complete Lab Deployment
 $labConfig = Get-LabDeploymentConfig -LabType "CompleteLab" -LabMode $labMode

 if (Confirm-Deployment -Mode "Complete Lab Deployment" -Components $labConfig -EstimatedMinutes 45) {
 Invoke-Deployment -DeploymentMode "Custom" -CustomComponents $labConfig
 Wait-ForUser
 }
 }
 "2" {
 # Sentinel Lab Deployment
 $labConfig = Get-LabDeploymentConfig -LabType "SentinelLab" -LabMode $labMode

 if (Confirm-Deployment -Mode "Sentinel Lab" -Components $labConfig -EstimatedMinutes 20) {
 Invoke-Deployment -DeploymentMode "Custom" -CustomComponents $labConfig
 Wait-ForUser
 }
 }
 "3" {
 # ADX Lab Deployment
 Write-Host ""
 Write-Host " WARNING: Azure Data Explorer Cluster Costs" -ForegroundColor Yellow
 Write-Host " Minimum cost: ~$8/day (Dev SKU)" -ForegroundColor Yellow
 Write-Host " Deployment time: 25-30 minutes" -ForegroundColor Yellow
 Write-Host ""
 $confirmADX = Read-Host "Continue with ADX Lab deployment? [y/N]"

 if ($confirmADX -eq "y" -or $confirmADX -eq "Y") {
 $labConfig = Get-LabDeploymentConfig -LabType "ADXLab" -LabMode $labMode

 if (Confirm-Deployment -Mode "ADX Lab" -Components $labConfig -EstimatedMinutes 30) {
 Invoke-Deployment -DeploymentMode "Custom" -CustomComponents $labConfig
 Wait-ForUser
 }
 }
 }
 "4" {
 # vNet Flow Log Lab
 $labConfig = Get-LabDeploymentConfig -LabType "FlowLogLab" -LabMode $labMode

 if (Confirm-Deployment -Mode "vNet Flow Log Lab" -Components $labConfig -EstimatedMinutes 20) {
 Invoke-Deployment -DeploymentMode "Custom" -CustomComponents $labConfig
 Wait-ForUser
 }
 }
 "5" {
 # Event Hub Lab
 $labConfig = Get-LabDeploymentConfig -LabType "EventHubLab" -LabMode $labMode

 if (Confirm-Deployment -Mode "Event Hub Lab" -Components $labConfig -EstimatedMinutes 15) {
 Invoke-Deployment -DeploymentMode "Custom" -CustomComponents $labConfig
 Wait-ForUser
 }
 }
 "6" {
 # Blob Queue Lab
 $labConfig = Get-LabDeploymentConfig -LabType "BlobQueueLab" -LabMode $labMode

 if (Confirm-Deployment -Mode "Blob Queue Lab" -Components $labConfig -EstimatedMinutes 12) {
 Invoke-Deployment -DeploymentMode "Custom" -CustomComponents $labConfig
 Wait-ForUser
 }
 }
 "7" {
 # Blob Collector Lab
 $labConfig = Get-LabDeploymentConfig -LabType "BlobCollectorLab" -LabMode $labMode

 if (Confirm-Deployment -Mode "Blob Collector Lab" -Components $labConfig -EstimatedMinutes 12) {
 Invoke-Deployment -DeploymentMode "Custom" -CustomComponents $labConfig
 Wait-ForUser
 }
 }
 "8" {
 # Basic Infrastructure
 $labConfig = Get-LabDeploymentConfig -LabType "BasicInfrastructure" -LabMode $labMode

 if (Confirm-Deployment -Mode "Basic Infrastructure" -Components $labConfig -EstimatedMinutes 10) {
 Invoke-Deployment -DeploymentMode "Custom" -CustomComponents $labConfig
 Wait-ForUser
 }
 }
 "9" {
 # Custom Component Selection
 $customComponents = Get-CustomComponentSelection -OperationParams $operationParams

 if (Confirm-Deployment -Mode "Custom Deployment" -Components $customComponents -EstimatedMinutes 30) {
 Invoke-Deployment -DeploymentMode "Custom" -CustomComponents $customComponents
 Wait-ForUser
 }
 }
 "S" {
 # Status & Resource Display
 Show-Status
 Wait-ForUser
 }
 "C" {
 # Generate Cribl Stream Configurations
 Write-Host "`n--- Generate Cribl Stream Configurations ---" -ForegroundColor Yellow

 Write-Host " This will generate Cribl Stream configurations for:" -ForegroundColor Gray
 Write-Host " - Log Analytics Workspace collectors" -ForegroundColor DarkGray
 Write-Host " - Blob Storage collectors (including flow logs)" -ForegroundColor DarkGray
 Write-Host " - Event Hub sources" -ForegroundColor DarkGray
 Write-Host " - Storage Queue sources" -ForegroundColor DarkGray
 Write-Host " - ADX destinations" -ForegroundColor DarkGray
 Write-Host ""

 $skipWait = Read-Host "Skip waiting for flow logs? (Y/N) [N]"
 $skipWaitSwitch = if ($skipWait -eq "Y" -or $skipWait -eq "y") { "-SkipWait" } else { "" }

 # Call the Cribl-Integration script in standalone mode
 $generatorScript = Join-Path $CorePath "Cribl-Integration.ps1"
 if (Test-Path $generatorScript) {
 if ($skipWaitSwitch) {
 & $generatorScript -AzureParams $azureParams -ResourceGroupName $azureParams.resourceGroupName -ResourceNames $resourceNames -SkipWait
 } else {
 & $generatorScript -AzureParams $azureParams -ResourceGroupName $azureParams.resourceGroupName -ResourceNames $resourceNames
 }
 } else {
 Write-Host " Generator script not found: $generatorScript" -ForegroundColor Red
 }

 Wait-ForUser
 }
 "D" {
 # DCR Automation Information
 Write-Host "`n$('='*80)" -ForegroundColor Magenta
 Write-Host "NEXT STEP: DATA COLLECTION RULES (DCRs)" -ForegroundColor White
 Write-Host "$('='*80)" -ForegroundColor Magenta

 Write-Host "`n What are DCRs?" -ForegroundColor Cyan
 Write-Host " Data Collection Rules define how data flows into Log Analytics tables." -ForegroundColor Gray
 Write-Host " They create ingestion endpoints that Cribl Stream sends data to." -ForegroundColor Gray

 Write-Host "`n UnifiedLab vs DCR-Automation:" -ForegroundColor Cyan
 Write-Host " UnifiedLab (this script):" -ForegroundColor Yellow
 Write-Host " - Deploys Azure infrastructure (VNet, Storage, Event Hub, ADX, etc.)" -ForegroundColor Gray
 Write-Host " - Generates Cribl SOURCES (where to collect data from)" -ForegroundColor Gray
 Write-Host "`n DCR-Automation (separate script):" -ForegroundColor Yellow
 Write-Host " - Creates Data Collection Rules for Log Analytics tables" -ForegroundColor Gray
 Write-Host " - Generates Cribl DESTINATIONS (where to send data to)" -ForegroundColor Gray

 Write-Host "`n Typical Workflow:" -ForegroundColor Cyan
 Write-Host " 1. Run UnifiedLab (this script) - Deploy infrastructure" -ForegroundColor White
 Write-Host " 2. Run DCR-Automation - Create DCRs for tables" -ForegroundColor White
 Write-Host " 3. Configure Cribl Stream:" -ForegroundColor White
 Write-Host " - Import SOURCES from UnifiedLab" -ForegroundColor Gray
 Write-Host " - Import DESTINATIONS from DCR-Automation" -ForegroundColor Gray
 Write-Host " 4. Data flows: Event Hub -> Cribl -> DCR -> Log Analytics" -ForegroundColor White

 Write-Host "`n DCR-Automation Location:" -ForegroundColor Cyan
 $dcrPath = "..\..\CustomDeploymentTemplates\DCR-Automation"
 $fullPath = Join-Path $ScriptRoot $dcrPath
 if (Test-Path $fullPath) {
 Write-Host " Found: $fullPath" -ForegroundColor Green
 Write-Host "`n To run DCR-Automation:" -ForegroundColor Yellow
 Write-Host " cd $fullPath" -ForegroundColor Gray
 Write-Host " .\Run-DCRAutomation.ps1" -ForegroundColor Gray
 } else {
 Write-Host " Path: Azure/CustomDeploymentTemplates/DCR-Automation/" -ForegroundColor Gray
 Write-Host " (Not found from current location)" -ForegroundColor Yellow
 }

 Write-Host "`n DCR-Automation Features:" -ForegroundColor Cyan
 Write-Host " - Creates DCRs for native tables (SecurityEvent, Syslog, etc.)" -ForegroundColor Gray
 Write-Host " - Creates DCRs for custom tables (with _CL suffix)" -ForegroundColor Gray
 Write-Host " - Supports Direct DCRs and DCE-based DCRs" -ForegroundColor Gray
 Write-Host " - Auto-generates Cribl destination configurations" -ForegroundColor Gray
 Write-Host " - Validates table schemas" -ForegroundColor Gray

 Write-Host "`n Documentation:" -ForegroundColor Cyan
 Write-Host " Main Repo CLAUDE.md: Azure/CustomDeploymentTemplates/DCR-Automation/" -ForegroundColor Gray
 Write-Host " UnifiedLab CLAUDE.md: See 'DCR-Automation vs UnifiedLab' section" -ForegroundColor Gray

 Write-Host ""
 Wait-ForUser
 }
 "V" {
 # Validate Configuration
 Write-Host "`n Configuration validation passed!" -ForegroundColor Green
 Wait-ForUser
 }
 "Q" {
 Write-Host "`n Exiting..." -ForegroundColor Cyan
 $continue = $false
 }
 default {
 Write-Host "`n Invalid option. Please try again." -ForegroundColor Yellow
 Start-Sleep -Seconds 1
 }
 }
 }
}

# Execute main function
Main
