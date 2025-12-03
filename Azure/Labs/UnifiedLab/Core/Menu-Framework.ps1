# Menu-Framework.ps1
# Shared interactive menu functions for Unified Azure Lab

# Function to clear screen and show header
function Show-MenuHeader {
 param(
 [Parameter(Mandatory=$false)]
 [string]$Title = "AZURE UNIFIED LAB DEPLOYMENT"
 )

 Clear-Host
 Write-Host "`n$('=' * 80)" -ForegroundColor Cyan
 Write-Host " $Title" -ForegroundColor White
 Write-Host "$('=' * 80)" -ForegroundColor Cyan
}

# Function to display current configuration summary
function Show-ConfigurationSummary {
 param(
 [Parameter(Mandatory=$true)]
 [PSCustomObject]$AzureParams,

 [Parameter(Mandatory=$true)]
 [PSCustomObject]$OperationParams
 )

 Write-Host "`n Current Configuration:" -ForegroundColor Cyan
 Write-Host " Subscription: $($AzureParams.subscriptionId)" -ForegroundColor Gray
 Write-Host " Resource Group: $($AzureParams.resourceGroupName)" -ForegroundColor Gray
 Write-Host " Location: $($AzureParams.location)" -ForegroundColor Gray
 Write-Host " Base Name: $($AzureParams.baseObjectName)" -ForegroundColor Gray

 # Display TTL configuration if enabled
 if ($AzureParams.timeToLive.enabled) {
 Write-Host "`n Time to Live (TTL):" -ForegroundColor Yellow
 Write-Host " Status: " -NoNewline -ForegroundColor Gray
 Write-Host "ENABLED" -ForegroundColor Green
 $days = [Math]::Round($AzureParams.timeToLive.hours / 24, 1)
 Write-Host (" Duration: " + $AzureParams.timeToLive.hours + " hours (" + $days + " days)") -ForegroundColor Gray
 Write-Host " Email: $($AzureParams.timeToLive.userEmail)" -ForegroundColor Gray
 Write-Host " Warning: $($AzureParams.timeToLive.warningHours) hours before deletion" -ForegroundColor Gray
 Write-Host " Resource Group will be auto-deleted after TTL expires" -ForegroundColor DarkYellow
 Write-Host " Warning email sent $($AzureParams.timeToLive.warningHours) hours before deletion" -ForegroundColor DarkYellow
 Write-Host " Extend TTL: Update TTL_ExpirationTime tag in Azure Portal" -ForegroundColor DarkCyan
 } else {
 Write-Host "`n Time to Live (TTL): " -NoNewline -ForegroundColor Gray
 Write-Host "DISABLED" -ForegroundColor DarkGray
 Write-Host " Enable in azure-parameters.json to auto-delete lab after expiration" -ForegroundColor DarkGray
 }

 Write-Host "`n Component Status:" -ForegroundColor Cyan

 # Infrastructure
 $infraStatus = if ($OperationParams.deployment.infrastructure.deployVNet) { "" } else { " " }
 Write-Host " ${infraStatus} Infrastructure (VNet, VPN, NSGs)" -ForegroundColor $(if ($OperationParams.deployment.infrastructure.deployVNet) { "Green" } else { "Gray" })

 # Monitoring
 $monStatus = if ($OperationParams.deployment.monitoring.deployLogAnalytics) { "" } else { " " }
 Write-Host " ${monStatus} Monitoring (Log Analytics, Sentinel, Flow Logs)" -ForegroundColor $(if ($OperationParams.deployment.monitoring.deployLogAnalytics) { "Green" } else { "Gray" })

 # Analytics
 $analyticsStatus = if ($OperationParams.deployment.analytics.deployEventHub -or $OperationParams.deployment.analytics.deployADX) { "" } else { " " }
 Write-Host " ${analyticsStatus} Analytics (Event Hub, ADX)" -ForegroundColor $(if ($analyticsStatus -eq "") { "Green" } else { "Gray" })

 # Storage
 $storageStatus = if ($OperationParams.deployment.storage.deployStorageAccount) { "" } else { " " }
 Write-Host " ${storageStatus} Storage (Blob, Queues, Event Grid)" -ForegroundColor $(if ($OperationParams.deployment.storage.deployStorageAccount) { "Green" } else { "Gray" })
}

# Function to display lab-specific deployment menu
function Show-DeploymentMenu {
 param(
 [Parameter(Mandatory=$false)]
 [string]$LabMode = "public"
 )

 Write-Host "`n LAB DEPLOYMENT OPTIONS:" -ForegroundColor Yellow
 Write-Host " Lab Mode: " -NoNewline -ForegroundColor Cyan
 if ($LabMode -eq "private") {
 Write-Host "PRIVATE " -NoNewline -ForegroundColor Magenta
 Write-Host "(Private Endpoints, AMPLS, DNS Required)" -ForegroundColor Gray
 } else {
 Write-Host "PUBLIC " -NoNewline -ForegroundColor Green
 Write-Host "(Public Endpoints, No DNS Config)" -ForegroundColor Gray
 }
 Write-Host " $('=' * 76)" -ForegroundColor DarkCyan

 Write-Host " [1] Complete Lab Deployment" -ForegroundColor Magenta
 Write-Host " All labs + infrastructure (Everything)" -ForegroundColor Gray
 if ($LabMode -eq "private") {
 Write-Host " Infrastructure, Storage, Monitoring, Analytics (inc. ADX) + Private Endpoints" -ForegroundColor DarkGray
 } else {
 Write-Host " Infrastructure, Storage, Monitoring, Analytics (inc. ADX)" -ForegroundColor DarkGray
 }
 Write-Host " Est. Cost: ~`$10.67-11.67/day (includes ADX ~`$8/day + data costs)" -ForegroundColor Yellow
 Write-Host " Time: 45-75 min (includes VPN + ADX cluster ~15-20 min)" -ForegroundColor DarkGray
 Write-Host " [2] Sentinel Lab Deployment" -ForegroundColor White
 Write-Host " Full Sentinel SIEM lab with all dependencies" -ForegroundColor Gray
 if ($LabMode -eq "private") {
 Write-Host " VNet, VPN, Log Analytics, Sentinel, Flow Logs, AMPLS, Private Endpoints" -ForegroundColor DarkGray
 } else {
 Write-Host " VNet, VPN, Log Analytics, Sentinel, Flow Logs" -ForegroundColor DarkGray
 }
 Write-Host " Est. Cost: ~`$1.33-2/day (+ `$2.46/GB ingested)" -ForegroundColor Cyan
 Write-Host " Time: 15-20 min (40-50 min with VPN)" -ForegroundColor DarkGray
 Write-Host " [3] ADX Lab Deployment" -ForegroundColor White
 Write-Host " Azure Data Explorer with Event Hub integration" -ForegroundColor Gray
 if ($LabMode -eq "private") {
 Write-Host " VNet, VPN, Storage, Event Hub, ADX Cluster + Private Endpoints for all" -ForegroundColor DarkGray
 } else {
 Write-Host " VNet, VPN, Storage, Event Hub, ADX Cluster, Data Connections" -ForegroundColor DarkGray
 }
 Write-Host " Est. Cost: ~`$10-11/day (ADX Dev SKU ~`$8/day)" -ForegroundColor Yellow
 Write-Host " Time: 25-30 min (50-60 min with VPN)" -ForegroundColor DarkGray
 Write-Host " [4] vNet Flow Log Lab" -ForegroundColor White
 Write-Host " Network monitoring with VNet Flow Logs" -ForegroundColor Gray
 if ($LabMode -eq "private") {
 Write-Host " VNet, VPN, Storage, Log Analytics, Flow Logs, Traffic Analytics, AMPLS" -ForegroundColor DarkGray
 } else {
 Write-Host " VNet, VPN, Storage, Log Analytics, Flow Logs, Traffic Analytics" -ForegroundColor DarkGray
 }
 Write-Host " Est. Cost: ~`$1.50-2.17/day (+ storage for flow logs)" -ForegroundColor Cyan
 Write-Host " Time: 15-20 min (40-50 min with VPN)" -ForegroundColor DarkGray
 Write-Host " [5] Event Hub Lab" -ForegroundColor White
 Write-Host " Streaming data ingestion with Event Hub" -ForegroundColor Gray
 if ($LabMode -eq "private") {
 Write-Host " VNet, VPN, Event Hub Namespace, Hubs, Storage (capture), Private Endpoints" -ForegroundColor DarkGray
 } else {
 Write-Host " VNet, VPN, Event Hub Namespace, Hubs, Consumer Groups, Storage (capture)" -ForegroundColor DarkGray
 }
 Write-Host " Est. Cost: ~`$2-2.67/day (+ throughput units)" -ForegroundColor Cyan
 Write-Host " Time: 10-15 min (35-45 min with VPN)" -ForegroundColor DarkGray
 Write-Host " [6] Blob Queue Lab" -ForegroundColor White
 Write-Host " Event-driven blob notifications via Storage Queues" -ForegroundColor Gray
 if ($LabMode -eq "private") {
 Write-Host " VNet, VPN, Storage Account, Queues, Event Grid, Private Endpoints (blob/queue)" -ForegroundColor DarkGray
 } else {
 Write-Host " VNet, VPN, Storage Account, Containers, Queues, Event Grid Subscriptions" -ForegroundColor DarkGray
 }
 Write-Host " Est. Cost: ~`$1.17-1.50/day (+ storage/transactions)" -ForegroundColor Cyan
 Write-Host " Time: 8-12 min (33-42 min with VPN)" -ForegroundColor DarkGray
 Write-Host " [7] Blob Collector Lab" -ForegroundColor White
 Write-Host " Multi-tier blob storage for log collection" -ForegroundColor Gray
 if ($LabMode -eq "private") {
 Write-Host " VNet, VPN, Storage Account, Multiple Containers, Sample Data, Private Endpoints" -ForegroundColor DarkGray
 } else {
 Write-Host " VNet, VPN, Storage Account, Multiple Containers, Sample Data" -ForegroundColor DarkGray
 }
 Write-Host " Est. Cost: ~`$1.17-1.50/day (+ storage used)" -ForegroundColor Cyan
 Write-Host " Time: 8-12 min (33-42 min with VPN)" -ForegroundColor DarkGray
 Write-Host " [8] Basic Infrastructure" -ForegroundColor White
 Write-Host " Foundation networking only (no data services)" -ForegroundColor Gray
 Write-Host " Resource Group, VNet (6 subnets), NSGs, VPN Gateway" -ForegroundColor DarkGray
 Write-Host " Est. Cost: ~`$1/day (VPN Gateway only)" -ForegroundColor Cyan
 Write-Host " Time: 5-10 min (30-45 min with VPN)" -ForegroundColor DarkGray
 Write-Host " $('-' * 76)" -ForegroundColor DarkGray
 Write-Host " [9] Custom Component Selection" -ForegroundColor Cyan
 Write-Host " Interactively choose specific components" -ForegroundColor Gray
 Write-Host " [C] Generate Cribl Stream Configurations" -ForegroundColor Cyan
 Write-Host " Generate sources/destinations for all lab components" -ForegroundColor Gray
 Write-Host " [D] Next Step: DCR Automation" -ForegroundColor Magenta
 Write-Host " Info on creating Data Collection Rules for Cribl destinations" -ForegroundColor Gray
 Write-Host " [S] Status & Resource Display" -ForegroundColor White
 Write-Host " Show current configuration and deployed resources" -ForegroundColor Gray
 Write-Host " [V] Validate Configuration" -ForegroundColor White
 Write-Host " Validate all config files without deploying" -ForegroundColor Gray
 Write-Host " [Q] Quit" -ForegroundColor Red
 Write-Host "$('=' * 80)" -ForegroundColor Cyan
}

# Function to prompt for lab mode (public/private)
function Get-LabMode {
 param(
 [Parameter(Mandatory=$true)]
 [PSCustomObject]$AzureParams
 )

 Write-Host "`n LAB MODE SELECTION" -ForegroundColor Cyan
 Write-Host "$('=' * 80)" -ForegroundColor Cyan
 Write-Host ""
 Write-Host "Choose deployment mode for this lab:" -ForegroundColor White
 Write-Host ""
 Write-Host " [1] PUBLIC Lab (Recommended for Testing)" -ForegroundColor Green
 Write-Host " All resources use public endpoints" -ForegroundColor Gray
 Write-Host " No DNS configuration required" -ForegroundColor Gray
 Write-Host " Faster deployment" -ForegroundColor Gray
 Write-Host " Lower complexity" -ForegroundColor Gray
 Write-Host " Less secure - internet-accessible endpoints" -ForegroundColor Yellow
 Write-Host ""
 Write-Host " [2] PRIVATE Lab (Production/Hybrid/Compliance)" -ForegroundColor Magenta
 Write-Host " All resources use private endpoints within VNet" -ForegroundColor Gray
 Write-Host " Network-isolated, no internet exposure" -ForegroundColor Gray
 Write-Host " Supports hybrid connectivity (VPN/ExpressRoute)" -ForegroundColor Gray
 Write-Host " Requires Active Directory DNS configuration" -ForegroundColor Yellow
 Write-Host " See README.md for DNS setup instructions" -ForegroundColor Yellow
 Write-Host ""
 Write-Host " Current setting in azure-parameters.json: " -NoNewline -ForegroundColor Gray
 if ($AzureParams.labMode -eq "private") {
 Write-Host "PRIVATE" -ForegroundColor Magenta
 } else {
 Write-Host "PUBLIC" -ForegroundColor Green
 }
 Write-Host ""

 do {
 $choice = Read-Host "Select lab mode [1=Public, 2=Private, ENTER=Keep current]"

 if ([string]::IsNullOrWhiteSpace($choice)) {
 return $AzureParams.labMode
 }

 switch ($choice) {
 "1" { return "public" }
 "2" {
 Write-Host ""
 Write-Host " PRIVATE MODE REQUIREMENTS:" -ForegroundColor Yellow
 Write-Host " 1. VPN or ExpressRoute connection to Azure VNet" -ForegroundColor Gray
 Write-Host " 2. Active Directory DNS servers configured with conditional forwarders" -ForegroundColor Gray
 Write-Host " 3. See README.md Active Directory DNS Configuration section" -ForegroundColor Gray
 Write-Host ""
 $confirm = Read-Host "Continue with PRIVATE mode? [y/N]"
 if ($confirm -eq "y" -or $confirm -eq "Y") {
 return "private"
 } else {
 Write-Host " Cancelled. Returning to menu..." -ForegroundColor Gray
 Start-Sleep -Seconds 2
 return $AzureParams.labMode
 }
 }
 default {
 Write-Host " Invalid choice. Please enter 1 or 2." -ForegroundColor Red
 }
 }
 } while ($true)
}

# Function to get lab-specific deployment configuration
function Get-LabDeploymentConfig {
 param(
 [Parameter(Mandatory=$true)]
 [string]$LabType,

 [Parameter(Mandatory=$true)]
 [string]$LabMode
 )

 $isPrivate = ($LabMode -eq "private")

 switch ($LabType) {
 "CompleteLab" {
 return @{
 Infrastructure = @{ DeployVNet = $true; DeployNSGs = $true; DeployVPN = $true; DeployBastion = $false }
 Storage = @{ Deploy = $true; DeployContainers = $true; DeployQueues = $true; DeployEventGrid = $true; DeployPrivateEndpoints = $isPrivate }
 Monitoring = @{ DeployLogAnalytics = $true; DeploySentinel = $true; DeployFlowLogs = $true; DeployPrivateLink = $isPrivate }
 Analytics = @{ DeployEventHub = $true; DeployADX = $true; DeployPrivateEndpoints = $isPrivate }
 VirtualMachines = @{ DeployVMs = $true }
 }
 }
 "SentinelLab" {
 return @{
 Infrastructure = @{ DeployVNet = $true; DeployNSGs = $true; DeployVPN = $true; DeployBastion = $false }
 Storage = @{ Deploy = $false; DeployContainers = $false; DeployQueues = $false; DeployEventGrid = $false; DeployPrivateEndpoints = $false }
 Monitoring = @{ DeployLogAnalytics = $true; DeploySentinel = $true; DeployFlowLogs = $true; DeployPrivateLink = $isPrivate }
 Analytics = @{ DeployEventHub = $false; DeployADX = $false; DeployPrivateEndpoints = $false }
 }
 }
 "ADXLab" {
 return @{
 Infrastructure = @{ DeployVNet = $true; DeployNSGs = $true; DeployVPN = $true; DeployBastion = $false }
 Storage = @{ Deploy = $true; DeployContainers = $true; DeployQueues = $false; DeployEventGrid = $false; DeployPrivateEndpoints = $isPrivate }
 Monitoring = @{ DeployLogAnalytics = $false; DeploySentinel = $false; DeployFlowLogs = $false; DeployPrivateLink = $false }
 Analytics = @{ DeployEventHub = $true; DeployADX = $true; DeployPrivateEndpoints = $isPrivate }
 }
 }
 "FlowLogLab" {
 return @{
 Infrastructure = @{ DeployVNet = $true; DeployNSGs = $true; DeployVPN = $true; DeployBastion = $false }
 Storage = @{ Deploy = $true; DeployContainers = $true; DeployQueues = $false; DeployEventGrid = $false; DeployPrivateEndpoints = $isPrivate }
 Monitoring = @{ DeployLogAnalytics = $true; DeploySentinel = $false; DeployFlowLogs = $true; DeployPrivateLink = $isPrivate; DeployTrafficAnalytics = $true }
 Analytics = @{ DeployEventHub = $false; DeployADX = $false; DeployPrivateEndpoints = $false }
 VirtualMachines = @{ DeployVMs = $true }
 }
 }
 "EventHubLab" {
 return @{
 Infrastructure = @{ DeployVNet = $true; DeployNSGs = $true; DeployVPN = $true; DeployBastion = $false }
 Storage = @{ Deploy = $true; DeployContainers = $true; DeployQueues = $false; DeployEventGrid = $false; DeployPrivateEndpoints = $isPrivate }
 Monitoring = @{ DeployLogAnalytics = $false; DeploySentinel = $false; DeployFlowLogs = $false; DeployPrivateLink = $false }
 Analytics = @{ DeployEventHub = $true; DeployADX = $false; DeployPrivateEndpoints = $isPrivate; EnableCapture = $true }
 }
 }
 "BlobQueueLab" {
 return @{
 Infrastructure = @{ DeployVNet = $true; DeployNSGs = $true; DeployVPN = $true; DeployBastion = $false }
 Storage = @{ Deploy = $true; DeployContainers = $true; DeployQueues = $true; DeployEventGrid = $true; DeployPrivateEndpoints = $isPrivate }
 Monitoring = @{ DeployLogAnalytics = $false; DeploySentinel = $false; DeployFlowLogs = $false; DeployPrivateLink = $false }
 Analytics = @{ DeployEventHub = $false; DeployADX = $false; DeployPrivateEndpoints = $false }
 }
 }
 "BlobCollectorLab" {
 return @{
 Infrastructure = @{ DeployVNet = $true; DeployNSGs = $true; DeployVPN = $true; DeployBastion = $false }
 Storage = @{ Deploy = $true; DeployContainers = $true; DeployQueues = $false; DeployEventGrid = $false; DeployPrivateEndpoints = $isPrivate; GenerateSampleData = $true }
 Monitoring = @{ DeployLogAnalytics = $false; DeploySentinel = $false; DeployFlowLogs = $false; DeployPrivateLink = $false }
 Analytics = @{ DeployEventHub = $false; DeployADX = $false; DeployPrivateEndpoints = $false }
 }
 }
 "BasicInfrastructure" {
 return @{
 Infrastructure = @{ DeployVNet = $true; DeployNSGs = $true; DeployVPN = $true; DeployBastion = $false }
 Storage = @{ Deploy = $false; DeployContainers = $false; DeployQueues = $false; DeployEventGrid = $false; DeployPrivateEndpoints = $false }
 Monitoring = @{ DeployLogAnalytics = $false; DeploySentinel = $false; DeployFlowLogs = $false; DeployPrivateLink = $false }
 Analytics = @{ DeployEventHub = $false; DeployADX = $false; DeployPrivateEndpoints = $false }
 }
 }
 default {
 throw "Unknown lab type: $LabType"
 }
 }
}

# Function to prompt for custom component selection
function Get-CustomComponentSelection {
 param(
 [Parameter(Mandatory=$true)]
 [PSCustomObject]$OperationParams
 )

 Write-Host "`n Custom Component Selection" -ForegroundColor Cyan
 Write-Host "$('=' * 80)" -ForegroundColor Cyan
 Write-Host ""

 # Infrastructure components
 Write-Host " Infrastructure Components:" -ForegroundColor Yellow
 $deployVNet = Read-HostBoolean " Deploy VNet and Subnets?" -Default $OperationParams.deployment.infrastructure.deployVNet
 $deployNSGs = Read-HostBoolean " Deploy Network Security Groups?" -Default $OperationParams.deployment.infrastructure.deployNSGs
 $deployVPN = Read-HostBoolean " Deploy VPN Gateway? (30-45 min)" -Default $OperationParams.deployment.infrastructure.deployVPNGateway
 $deployBastion = Read-HostBoolean " Deploy Azure Bastion?" -Default $OperationParams.deployment.infrastructure.deployBastion

 Write-Host ""
 Write-Host " Monitoring Components:" -ForegroundColor Yellow
 $deployLogAnalytics = Read-HostBoolean " Deploy Log Analytics Workspace?" -Default $OperationParams.deployment.monitoring.deployLogAnalytics
 $deploySentinel = Read-HostBoolean " Deploy Microsoft Sentinel?" -Default $OperationParams.deployment.monitoring.deploySentinel
 $deployFlowLogs = Read-HostBoolean " Deploy VNet Flow Logs?" -Default $OperationParams.deployment.monitoring.deployFlowLogs
 $deployPrivateLink = Read-HostBoolean " Deploy Private Link (AMPLS)?" -Default $OperationParams.deployment.monitoring.deployPrivateLink

 Write-Host ""
 Write-Host " Analytics Components:" -ForegroundColor Yellow
 $deployEventHub = Read-HostBoolean " Deploy Event Hub Namespace?" -Default $OperationParams.deployment.analytics.deployEventHub
 $deployADX = Read-HostBoolean " Deploy ADX Cluster? (~$8/day)" -Default $OperationParams.deployment.analytics.deployADX

 Write-Host ""
 Write-Host " Storage Components:" -ForegroundColor Yellow
 $deployStorage = Read-HostBoolean " Deploy Storage Account?" -Default $OperationParams.deployment.storage.deployStorageAccount
 $deployContainers = Read-HostBoolean " Deploy Blob Containers?" -Default $OperationParams.deployment.storage.deployContainers
 $deployQueues = Read-HostBoolean " Deploy Storage Queues?" -Default $OperationParams.deployment.storage.deployQueues
 $deployEventGrid = Read-HostBoolean " Deploy Event Grid?" -Default $OperationParams.deployment.storage.deployEventGrid

 return @{
 Infrastructure = @{
 DeployVNet = $deployVNet
 DeployNSGs = $deployNSGs
 DeployVPN = $deployVPN
 DeployBastion = $deployBastion
 }
 Monitoring = @{
 DeployLogAnalytics = $deployLogAnalytics
 DeploySentinel = $deploySentinel
 DeployFlowLogs = $deployFlowLogs
 DeployPrivateLink = $deployPrivateLink
 }
 Analytics = @{
 DeployEventHub = $deployEventHub
 DeployADX = $deployADX
 }
 Storage = @{
 DeployStorage = $deployStorage
 DeployContainers = $deployContainers
 DeployQueues = $deployQueues
 DeployEventGrid = $deployEventGrid
 }
 }
}

# Helper function to read boolean from user
function Read-HostBoolean {
 param(
 [Parameter(Mandatory=$true)]
 [string]$Prompt,

 [Parameter(Mandatory=$false)]
 [bool]$Default = $true
 )

 $defaultText = if ($Default) { "Y/n" } else { "y/N" }
 $response = Read-Host "$Prompt [$defaultText]"

 if ([string]::IsNullOrWhiteSpace($response)) {
 return $Default
 }

 return $response.ToUpper() -eq "Y"
}

# Function to confirm deployment
function Confirm-Deployment {
 param(
 [Parameter(Mandatory=$true)]
 [string]$Mode,

 [Parameter(Mandatory=$true)]
 [hashtable]$Components,

 [Parameter(Mandatory=$false)]
 [int]$EstimatedMinutes = 10
 )

 Write-Host "`n Deployment Confirmation" -ForegroundColor Yellow
 Write-Host "$('=' * 80)" -ForegroundColor Yellow
 Write-Host ""
 Write-Host " Mode: $Mode" -ForegroundColor Cyan
 Write-Host ""
 Write-Host "Components to deploy:" -ForegroundColor White

 $componentList = @()

 if ($Components.Infrastructure) {
 foreach ($key in $Components.Infrastructure.Keys) {
 if ($Components.Infrastructure[$key]) {
 $componentList += " Infrastructure: $key"
 }
 }
 }

 if ($Components.Monitoring) {
 foreach ($key in $Components.Monitoring.Keys) {
 if ($Components.Monitoring[$key]) {
 $componentList += " Monitoring: $key"
 }
 }
 }

 if ($Components.Analytics) {
 foreach ($key in $Components.Analytics.Keys) {
 if ($Components.Analytics[$key]) {
 $componentList += " Analytics: $key"
 }
 }
 }

 if ($Components.Storage) {
 foreach ($key in $Components.Storage.Keys) {
 if ($Components.Storage[$key]) {
 $componentList += " Storage: $key"
 }
 }
 }

 if ($componentList.Count -eq 0) {
 Write-Host " (No components selected for deployment)" -ForegroundColor Gray
 return $false
 }

 foreach ($item in $componentList) {
 Write-Host $item -ForegroundColor Green
 }

 Write-Host ""
 Write-Host " Estimated deployment time: $EstimatedMinutes minutes" -ForegroundColor Cyan
 Write-Host ""
 Write-Host "$('=' * 80)" -ForegroundColor Yellow

 $response = Read-Host "`nProceed with deployment? (Y/N)"
 return $response.ToUpper() -eq "Y"
}

# Function to display deployment progress
function Show-DeploymentProgress {
 param(
 [Parameter(Mandatory=$true)]
 [string]$Phase,

 [Parameter(Mandatory=$true)]
 [string]$Message,

 [Parameter(Mandatory=$false)]
 [ValidateSet("Info", "Success", "Warning", "Error")]
 [string]$Type = "Info"
 )

 $icon = switch ($Type) {
 "Info" { " " }
 "Success" { "" }
 "Warning" { " " }
 "Error" { "" }
 }

 $color = switch ($Type) {
 "Info" { "Cyan" }
 "Success" { "Green" }
 "Warning" { "Yellow" }
 "Error" { "Red" }
 }

 Write-Host "`n[$Phase] $icon $Message" -ForegroundColor $color
}

# Function to wait for user after operation
function Wait-ForUser {
 param(
 [Parameter(Mandatory=$false)]
 [string]$Message = "Press any key to continue..."
 )

 Write-Host "`n$Message" -ForegroundColor Yellow
 $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
}

# Function to display deployment summary
function Show-DeploymentSummary {
 param(
 [Parameter(Mandatory=$true)]
 [hashtable]$Results
 )

 Write-Host "`n$('=' * 80)" -ForegroundColor Green
 Write-Host " DEPLOYMENT SUMMARY" -ForegroundColor White
 Write-Host "$('=' * 80)" -ForegroundColor Green

 $successCount = 0
 $failureCount = 0
 $skippedCount = 0

 foreach ($component in $Results.Keys) {
 $result = $Results[$component]

 switch ($result.Status) {
 "Success" {
 Write-Host " $component`: $($result.Message)" -ForegroundColor Green
 $successCount++
 }
 "Failed" {
 Write-Host " $component`: $($result.Message)" -ForegroundColor Red
 $failureCount++
 }
 "Skipped" {
 Write-Host " $component`: $($result.Message)" -ForegroundColor Gray
 $skippedCount++
 }
 }
 }

 Write-Host ""
 Write-Host "Summary: $successCount succeeded, $failureCount failed, $skippedCount skipped" -ForegroundColor Cyan
 Write-Host "$('=' * 80)" -ForegroundColor Green
}

# Functions are available via dot-sourcing
# No Export-ModuleMember needed for .ps1 script files
