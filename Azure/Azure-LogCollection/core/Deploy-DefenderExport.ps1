# Deploy-DefenderExport.ps1
# Configures Microsoft Defender for Cloud continuous export to Event Hub
#
# IMPORTANT: This script ONLY configures log export. It does NOT enable any Defender plans.
# Defender plans are paid services - this script detects what's already enabled and exports those logs.
#
# What This Exports (if the plan is enabled):
#   - Security Alerts: Threats detected by Defender
#   - Security Recommendations: Posture improvement suggestions
#   - Secure Score: Overall security score changes
#   - Regulatory Compliance: Compliance assessment results
#
# Defender Plans Detected:
#   - Defender for Servers
#   - Defender for App Service
#   - Defender for Databases (SQL, PostgreSQL, MySQL, Cosmos DB, etc.)
#   - Defender for Storage
#   - Defender for Containers
#   - Defender for Key Vault
#   - Defender for Resource Manager
#   - Defender for DNS
#   - Defender for APIs
#
# Required Permissions:
#   - Security Admin or Contributor at subscription level
#   - Contributor on the Event Hub Namespace
#
# Usage:
#   .\Deploy-DefenderExport.ps1                     # Deploy to all subscriptions with Defender enabled
#   .\Deploy-DefenderExport.ps1 -ValidateOnly      # Show Defender status without deploying
#   .\Deploy-DefenderExport.ps1 -RemoveExport      # Remove continuous export configurations
#   .\Deploy-DefenderExport.ps1 -IncludeRecommendations  # Also export recommendations (higher volume)

[CmdletBinding()]
param(
    [Parameter(Mandatory=$false)]
    [switch]$ValidateOnly,

    [Parameter(Mandatory=$false)]
    [switch]$RemoveExport,

    [Parameter(Mandatory=$false)]
    [switch]$IncludeRecommendations,

    [Parameter(Mandatory=$false)]
    [switch]$IncludeSecureScore,

    [Parameter(Mandatory=$false)]
    [switch]$IncludeRegulatoryCompliance,

    [Parameter(Mandatory=$false)]
    [string]$ExportName = "CriblDefenderExport",

    # Override parameters (passed from main menu)
    [Parameter(Mandatory=$false)]
    [Nullable[bool]]$UseExistingNamespaces = $null,

    [Parameter(Mandatory=$false)]
    [string]$CentralizedNamespaceOverride = ""
)

# Script variables
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ScriptPath = Split-Path -Parent $MyInvocation.MyCommand.Path

# Import logging helper
$OutputHelperPath = Join-Path $ScriptPath "Output-Helper.ps1"
if (Test-Path $OutputHelperPath) {
    . $OutputHelperPath
}

#region Defender Plan Definitions

# Defender plan types and their display names
$DefenderPlans = @{
    "VirtualMachines"       = @{ DisplayName = "Defender for Servers"; Tier = "Standard" }
    "AppServices"           = @{ DisplayName = "Defender for App Service"; Tier = "Standard" }
    "SqlServers"            = @{ DisplayName = "Defender for SQL Servers"; Tier = "Standard" }
    "SqlServerVirtualMachines" = @{ DisplayName = "Defender for SQL VMs"; Tier = "Standard" }
    "OpenSourceRelationalDatabases" = @{ DisplayName = "Defender for OSS Databases"; Tier = "Standard" }
    "CosmosDbs"             = @{ DisplayName = "Defender for Cosmos DB"; Tier = "Standard" }
    "StorageAccounts"       = @{ DisplayName = "Defender for Storage"; Tier = "Standard" }
    "Containers"            = @{ DisplayName = "Defender for Containers"; Tier = "Standard" }
    "KeyVaults"             = @{ DisplayName = "Defender for Key Vault"; Tier = "Standard" }
    "Arm"                   = @{ DisplayName = "Defender for Resource Manager"; Tier = "Standard" }
    "Dns"                   = @{ DisplayName = "Defender for DNS"; Tier = "Standard" }
    "Api"                   = @{ DisplayName = "Defender for APIs"; Tier = "Standard" }
}

#endregion

#region Helper Functions

# Note: Write-Step, Write-SubStep, Write-Success, Write-WarningMsgMsg, Write-ErrorMsg
# are imported from Output-Helper.ps1

function Get-DefenderPlanStatus {
    param([string]$SubscriptionId)

    $enabledPlans = @()
    $disabledPlans = @()

    try {
        # Get all Defender pricing configurations
        $pricings = Get-AzSecurityPricing -ErrorAction SilentlyContinue

        foreach ($pricing in $pricings) {
            $planName = $pricing.Name
            if ($DefenderPlans.ContainsKey($planName)) {
                $displayName = $DefenderPlans[$planName].DisplayName
                if ($pricing.PricingTier -eq "Standard") {
                    $enabledPlans += @{
                        Name = $planName
                        DisplayName = $displayName
                        Tier = $pricing.PricingTier
                    }
                } else {
                    $disabledPlans += @{
                        Name = $planName
                        DisplayName = $displayName
                        Tier = $pricing.PricingTier
                    }
                }
            }
        }
    }
    catch {
        Write-WarningMsg "Could not retrieve Defender plan status: $_"
    }

    return @{
        Enabled = $enabledPlans
        Disabled = $disabledPlans
        HasAnyEnabled = ($enabledPlans.Count -gt 0)
    }
}

function Get-EventHubInfo {
    param(
        [PSObject]$AzureParams,
        [Nullable[bool]]$UseExisting,
        [string]$NamespaceOverride
    )

    $subscriptionId = $AzureParams.eventHubSubscriptionId
    $resourceGroup = $AzureParams.eventHubResourceGroup
    $prefix = $AzureParams.eventHubNamespacePrefix
    $subId8 = $subscriptionId.Substring(0, 8)

    # Determine if using existing namespaces
    $useExistingNamespaces = if ($null -ne $UseExisting) { $UseExisting }
                            elseif ($AzureParams.PSObject.Properties['useExistingNamespaces']) { $AzureParams.useExistingNamespaces }
                            else { $false }

    # Determine namespace name
    if ($useExistingNamespaces) {
        if (-not [string]::IsNullOrEmpty($NamespaceOverride)) {
            $namespaceName = $NamespaceOverride
        } elseif ($AzureParams.PSObject.Properties['centralizedNamespace'] -and -not [string]::IsNullOrEmpty($AzureParams.centralizedNamespace)) {
            $namespaceName = $AzureParams.centralizedNamespace
        } else {
            throw "useExistingNamespaces is true but no namespace name provided"
        }
    } else {
        $namespaceName = "$prefix-$subId8"
    }

    return @{
        NamespaceName = $namespaceName
        ResourceGroup = $resourceGroup
        SubscriptionId = $subscriptionId
    }
}

function New-DefenderContinuousExport {
    param(
        [string]$SubscriptionId,
        [string]$ExportName,
        [string]$EventHubResourceId,
        [string]$EventHubConnectionString,
        [bool]$IncludeAlerts = $true,
        [bool]$IncludeRecommendations = $false,
        [bool]$IncludeSecureScore = $false,
        [bool]$IncludeRegulatoryCompliance = $false
    )

    # Build the export sources
    $sources = @()
    if ($IncludeAlerts) {
        $sources += @{ eventSource = "Alerts" }
    }
    if ($IncludeRecommendations) {
        $sources += @{ eventSource = "Assessments" }
    }
    if ($IncludeSecureScore) {
        $sources += @{ eventSource = "SecureScores" }
    }
    if ($IncludeRegulatoryCompliance) {
        $sources += @{ eventSource = "RegulatoryComplianceAssessment" }
    }

    if ($sources.Count -eq 0) {
        throw "At least one export source must be selected"
    }

    # Create the automation configuration
    $resourceGroupName = "CriblSecurityExport"
    $location = "eastus"  # Automation resources are global, location is for metadata

    # Ensure resource group exists
    $rg = Get-AzResourceGroup -Name $resourceGroupName -ErrorAction SilentlyContinue
    if (-not $rg) {
        Write-SubStep "Creating resource group '$resourceGroupName' for security automation..."
        New-AzResourceGroup -Name $resourceGroupName -Location $location | Out-Null
    }

    # Build the automation rule using REST API
    $automationBody = @{
        location = $location
        properties = @{
            description = "Cribl Stream - Export Defender alerts to Event Hub"
            isEnabled = $true
            scopes = @("/subscriptions/$SubscriptionId")
            sources = $sources
            actions = @(
                @{
                    actionType = "EventHub"
                    eventHubResourceId = $EventHubResourceId
                    connectionString = $EventHubConnectionString
                }
            )
        }
    } | ConvertTo-Json -Depth 10

    $uri = "https://management.azure.com/subscriptions/$SubscriptionId/resourceGroups/$resourceGroupName/providers/Microsoft.Security/automations/$($ExportName)?api-version=2019-01-01-preview"

    try {
        $response = Invoke-AzRestMethod -Uri $uri -Method PUT -Payload $automationBody

        if ($response.StatusCode -in @(200, 201)) {
            return $response.Content | ConvertFrom-Json
        } else {
            $errorContent = $response.Content | ConvertFrom-Json -ErrorAction SilentlyContinue
            $errorMessage = if ($errorContent.error.message) { $errorContent.error.message } else { $response.Content }
            throw "Failed to create security automation: $errorMessage"
        }
    }
    catch {
        throw "Error creating Defender continuous export: $_"
    }
}

function Remove-DefenderContinuousExport {
    param(
        [string]$SubscriptionId,
        [string]$ExportName
    )

    $resourceGroupName = "CriblSecurityExport"
    $uri = "https://management.azure.com/subscriptions/$SubscriptionId/resourceGroups/$resourceGroupName/providers/Microsoft.Security/automations/$($ExportName)?api-version=2019-01-01-preview"

    try {
        $response = Invoke-AzRestMethod -Uri $uri -Method DELETE
        return $response.StatusCode -in @(200, 204)
    }
    catch {
        return $false
    }
}

function Get-DefenderContinuousExport {
    param(
        [string]$SubscriptionId,
        [string]$ExportName
    )

    $resourceGroupName = "CriblSecurityExport"
    $uri = "https://management.azure.com/subscriptions/$SubscriptionId/resourceGroups/$resourceGroupName/providers/Microsoft.Security/automations/$($ExportName)?api-version=2019-01-01-preview"

    try {
        $response = Invoke-AzRestMethod -Uri $uri -Method GET
        if ($response.StatusCode -eq 200) {
            return $response.Content | ConvertFrom-Json
        }
        return $null
    }
    catch {
        return $null
    }
}

#endregion

#region Main Execution

Write-Host "`n$('='*80)" -ForegroundColor Cyan
Write-Host "  MICROSOFT DEFENDER FOR CLOUD - Continuous Export to Event Hub" -ForegroundColor Cyan
Write-Host "$('='*80)" -ForegroundColor Cyan

Write-Host "`n  IMPORTANT: This script does NOT enable any Defender plans." -ForegroundColor Yellow
Write-Host "  It only configures log export for plans that are ALREADY enabled." -ForegroundColor Yellow
Write-Host "  Defender plans are paid services - enable them separately if needed." -ForegroundColor Yellow

# Load configuration
$azureParamsFile = Join-Path $ScriptPath "azure-parameters.json"
if (-not (Test-Path $azureParamsFile)) {
    throw "Configuration file not found: $azureParamsFile"
}
$azureParams = Get-Content $azureParamsFile | ConvertFrom-Json

# Get subscriptions under management group
Write-Step "Discovering subscriptions under Management Group '$($azureParams.managementGroupId)'..." "Yellow"

$subscriptions = @()
try {
    $mgSubscriptions = Get-AzManagementGroupSubscription -GroupName $azureParams.managementGroupId -ErrorAction SilentlyContinue
    foreach ($mgSub in $mgSubscriptions) {
        $subId = $mgSub.Id -replace '/subscriptions/', '' -replace '/.*', ''
        $sub = Get-AzSubscription -SubscriptionId $subId -ErrorAction SilentlyContinue
        if ($sub) {
            $subscriptions += $sub
        }
    }
}
catch {
    Write-WarningMsg "Could not enumerate management group subscriptions. Using current subscription."
    $subscriptions = @(Get-AzContext | Select-Object -ExpandProperty Subscription)
}

Write-SubStep "Found $($subscriptions.Count) subscription(s)"

# Process each subscription
$defenderStatus = @{}
$subscriptionsWithDefender = @()

Write-Step "Checking Defender for Cloud status in each subscription..." "Yellow"

foreach ($sub in $subscriptions) {
    Set-AzContext -SubscriptionId $sub.Id | Out-Null
    $status = Get-DefenderPlanStatus -SubscriptionId $sub.Id

    $defenderStatus[$sub.Id] = @{
        Name = $sub.Name
        Status = $status
    }

    if ($status.HasAnyEnabled) {
        $subscriptionsWithDefender += $sub
        Write-Host "`n    $($sub.Name) ($($sub.Id)):" -ForegroundColor White
        Write-Host "      Enabled Plans:" -ForegroundColor Green
        foreach ($plan in $status.Enabled) {
            Write-Host "        - $($plan.DisplayName)" -ForegroundColor Green
        }
        if ($status.Disabled.Count -gt 0) {
            Write-Host "      Disabled Plans (not exported):" -ForegroundColor DarkGray
            foreach ($plan in $status.Disabled) {
                Write-Host "        - $($plan.DisplayName)" -ForegroundColor DarkGray
            }
        }
    } else {
        Write-Host "`n    $($sub.Name): " -NoNewline -ForegroundColor White
        Write-Host "No Defender plans enabled" -ForegroundColor DarkGray
    }
}

# Summary
Write-Step "Summary:" "White"
Write-SubStep "Subscriptions with Defender enabled: $($subscriptionsWithDefender.Count) of $($subscriptions.Count)"

if ($subscriptionsWithDefender.Count -eq 0) {
    Write-Host "`n  No subscriptions have Defender for Cloud enabled." -ForegroundColor Yellow
    Write-Host "  There are no security alerts to export." -ForegroundColor Yellow
    Write-Host "`n  To enable Defender plans:" -ForegroundColor Cyan
    Write-Host "    1. Go to Azure Portal > Microsoft Defender for Cloud" -ForegroundColor Gray
    Write-Host "    2. Select Environment Settings > Your Subscription" -ForegroundColor Gray
    Write-Host "    3. Enable desired Defender plans" -ForegroundColor Gray
    Write-Host "    4. Re-run this script to configure export" -ForegroundColor Gray
    exit 0
}

# ValidateOnly mode - just show status
if ($ValidateOnly) {
    Write-Host "`n  Validation complete. Run without -ValidateOnly to configure export." -ForegroundColor Cyan
    exit 0
}

# RemoveExport mode
if ($RemoveExport) {
    Write-Step "Removing Defender continuous export configurations..." "Red"

    foreach ($sub in $subscriptionsWithDefender) {
        Set-AzContext -SubscriptionId $sub.Id | Out-Null
        Write-SubStep "Removing from $($sub.Name)..."

        $result = Remove-DefenderContinuousExport -SubscriptionId $sub.Id -ExportName $ExportName
        if ($result) {
            Write-Success "Removed export configuration"
        } else {
            Write-WarningMsg "Export configuration not found or already removed"
        }
    }

    Write-Host "`n  Removal complete." -ForegroundColor Green
    exit 0
}

# Get Event Hub information
Write-Step "Resolving Event Hub namespace..." "Yellow"

try {
    # Switch to Event Hub subscription
    Set-AzContext -SubscriptionId $azureParams.eventHubSubscriptionId | Out-Null

    $ehInfo = Get-EventHubInfo -AzureParams $azureParams -UseExisting $UseExistingNamespaces -NamespaceOverride $CentralizedNamespaceOverride

    # Verify namespace exists and get connection string
    $namespace = Get-AzEventHubNamespace -ResourceGroupName $ehInfo.ResourceGroup -Name $ehInfo.NamespaceName -ErrorAction SilentlyContinue
    if (-not $namespace) {
        throw "Event Hub Namespace '$($ehInfo.NamespaceName)' not found. Deploy Event Hub infrastructure first."
    }

    $authRule = Get-AzEventHubAuthorizationRule -ResourceGroupName $ehInfo.ResourceGroup -NamespaceName $ehInfo.NamespaceName -Name "RootManageSharedAccessKey"
    $keys = Get-AzEventHubKey -ResourceGroupName $ehInfo.ResourceGroup -NamespaceName $ehInfo.NamespaceName -AuthorizationRuleName "RootManageSharedAccessKey"

    $eventHubResourceId = $authRule.Id -replace '/authorizationRules/.*', ''
    $connectionString = $keys.PrimaryConnectionString

    Write-Success "Found namespace: $($ehInfo.NamespaceName)"
    Write-SubStep "Region: $($namespace.Location)"
}
catch {
    Write-ErrorMsg "$_"
    exit 1
}

# Configure export for each subscription with Defender
Write-Step "Configuring Defender continuous export..." "Green"

Write-SubStep "Export Name: $ExportName"
Write-SubStep "Target: $($ehInfo.NamespaceName)"
Write-SubStep "Data Sources:"
Write-Host "      - Security Alerts (always included)" -ForegroundColor Gray
if ($IncludeRecommendations) {
    Write-Host "      - Security Recommendations" -ForegroundColor Gray
}
if ($IncludeSecureScore) {
    Write-Host "      - Secure Score Changes" -ForegroundColor Gray
}
if ($IncludeRegulatoryCompliance) {
    Write-Host "      - Regulatory Compliance Results" -ForegroundColor Gray
}

$successCount = 0
$failCount = 0

foreach ($sub in $subscriptionsWithDefender) {
    Set-AzContext -SubscriptionId $sub.Id | Out-Null
    Write-Host "`n    Configuring $($sub.Name)..." -ForegroundColor White

    try {
        $result = New-DefenderContinuousExport `
            -SubscriptionId $sub.Id `
            -ExportName $ExportName `
            -EventHubResourceId $eventHubResourceId `
            -EventHubConnectionString $connectionString `
            -IncludeAlerts $true `
            -IncludeRecommendations $IncludeRecommendations `
            -IncludeSecureScore $IncludeSecureScore `
            -IncludeRegulatoryCompliance $IncludeRegulatoryCompliance

        Write-Success "Continuous export configured"
        $successCount++
    }
    catch {
        Write-ErrorMsg "Failed: $_"
        $failCount++
    }
}

Write-Host "`n$('='*80)" -ForegroundColor Green
Write-Host "  DEFENDER CONTINUOUS EXPORT COMPLETE" -ForegroundColor Green
Write-Host "$('='*80)" -ForegroundColor Green

Write-Host "`n  Results:" -ForegroundColor White
Write-SubStep "Successful: $successCount subscription(s)"
if ($failCount -gt 0) {
    Write-SubStep "Failed: $failCount subscription(s)" -Color "Red"
}

Write-Host "`n  Security alerts will be sent to Event Hub:" -ForegroundColor Cyan
Write-SubStep "Namespace: $($ehInfo.NamespaceName)"
Write-SubStep "Event Hub: insights-security-alerts (auto-created)"

Write-Host "`n  REMINDER:" -ForegroundColor Yellow
Write-Host "  - Only alerts from ENABLED Defender plans will be exported" -ForegroundColor Gray
Write-Host "  - To get more alerts, enable additional Defender plans in Azure Portal" -ForegroundColor Gray
Write-Host "  - Alerts may take a few minutes to start flowing" -ForegroundColor Gray

#endregion
