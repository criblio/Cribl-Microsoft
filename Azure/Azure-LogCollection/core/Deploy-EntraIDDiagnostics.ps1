# Deploy-EntraIDDiagnostics.ps1
# Configures Microsoft Entra ID (Azure AD) diagnostic settings to stream logs to Event Hub
#
# Entra ID is a GLOBAL service - logs are tenant-wide, not regional.
# This script configures a single diagnostic setting to send all Entra ID logs
# to the centralized Event Hub namespace.
#
# Log Categories:
#   - AuditLogs: Directory changes, app registrations, role assignments
#   - SignInLogs: Interactive user sign-ins
#   - NonInteractiveUserSignInLogs: Token refresh, background auth (5-10x volume of interactive)
#   - ServicePrincipalSignInLogs: App/service principal authentication
#   - ManagedIdentitySignInLogs: Managed identity authentication
#   - ProvisioningLogs: User provisioning events
#   - ADFSSignInLogs: Federated sign-ins (if using ADFS)
#   - RiskyUsers: Identity Protection risky user events
#   - UserRiskEvents: Identity Protection user risk events
#   - NetworkAccessTrafficLogs: Global Secure Access traffic (if enabled)
#   - RiskyServicePrincipals: Risky service principal events
#   - ServicePrincipalRiskEvents: Service principal risk events
#   - EnrichedOffice365AuditLogs: Enriched M365 audit logs
#   - MicrosoftGraphActivityLogs: Graph API activity
#   - RemoteNetworkHealthLogs: Global Secure Access health (if enabled)
#
# Required Permissions:
#   - Security Administrator or Global Administrator in Entra ID
#   - Contributor on the Event Hub Namespace
#
# Usage:
#   .\Deploy-EntraIDDiagnostics.ps1                    # Deploy with default settings
#   .\Deploy-EntraIDDiagnostics.ps1 -ValidateOnly     # Check current configuration
#   .\Deploy-EntraIDDiagnostics.ps1 -RemoveSetting    # Remove the diagnostic setting
#   .\Deploy-EntraIDDiagnostics.ps1 -SecurityOnly     # Deploy security-focused logs only

[CmdletBinding()]
param(
    [Parameter(Mandatory=$false)]
    [switch]$ValidateOnly,

    [Parameter(Mandatory=$false)]
    [switch]$RemoveSetting,

    [Parameter(Mandatory=$false)]
    [switch]$SecurityOnly,

    [Parameter(Mandatory=$false)]
    [switch]$IncludeHighVolume,

    [Parameter(Mandatory=$false)]
    [string]$DiagnosticSettingName = "CriblEntraIDLogs",

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

#region Log Category Definitions

# Security-focused categories (recommended baseline)
$SecurityLogCategories = @(
    @{ Category = "AuditLogs"; Enabled = $true }
    @{ Category = "SignInLogs"; Enabled = $true }
    @{ Category = "RiskyUsers"; Enabled = $true }
    @{ Category = "UserRiskEvents"; Enabled = $true }
    @{ Category = "RiskyServicePrincipals"; Enabled = $true }
    @{ Category = "ServicePrincipalRiskEvents"; Enabled = $true }
)

# Standard categories (security + service principal/managed identity)
$StandardLogCategories = @(
    @{ Category = "AuditLogs"; Enabled = $true }
    @{ Category = "SignInLogs"; Enabled = $true }
    @{ Category = "ServicePrincipalSignInLogs"; Enabled = $true }
    @{ Category = "ManagedIdentitySignInLogs"; Enabled = $true }
    @{ Category = "ProvisioningLogs"; Enabled = $true }
    @{ Category = "RiskyUsers"; Enabled = $true }
    @{ Category = "UserRiskEvents"; Enabled = $true }
    @{ Category = "RiskyServicePrincipals"; Enabled = $true }
    @{ Category = "ServicePrincipalRiskEvents"; Enabled = $true }
)

# High-volume categories (adds non-interactive sign-ins - 5-10x volume increase)
$HighVolumeLogCategories = @(
    @{ Category = "AuditLogs"; Enabled = $true }
    @{ Category = "SignInLogs"; Enabled = $true }
    @{ Category = "NonInteractiveUserSignInLogs"; Enabled = $true }
    @{ Category = "ServicePrincipalSignInLogs"; Enabled = $true }
    @{ Category = "ManagedIdentitySignInLogs"; Enabled = $true }
    @{ Category = "ProvisioningLogs"; Enabled = $true }
    @{ Category = "ADFSSignInLogs"; Enabled = $true }
    @{ Category = "RiskyUsers"; Enabled = $true }
    @{ Category = "UserRiskEvents"; Enabled = $true }
    @{ Category = "RiskyServicePrincipals"; Enabled = $true }
    @{ Category = "ServicePrincipalRiskEvents"; Enabled = $true }
    @{ Category = "NetworkAccessTrafficLogs"; Enabled = $true }
    @{ Category = "EnrichedOffice365AuditLogs"; Enabled = $true }
    @{ Category = "MicrosoftGraphActivityLogs"; Enabled = $true }
    @{ Category = "RemoteNetworkHealthLogs"; Enabled = $true }
)

#endregion

#region Helper Functions

# Note: Write-Step, Write-SubStep, Write-Success, Write-WarningMsgMsg, Write-ErrorMsg
# are imported from Output-Helper.ps1

function Get-EventHubNamespace {
    param(
        [PSObject]$AzureParams,
        [Nullable[bool]]$UseExisting,
        [string]$NamespaceOverride
    )

    $subscriptionId = $AzureParams.eventHubSubscriptionId
    $resourceGroup = $AzureParams.eventHubResourceGroup
    $prefix = $AzureParams.eventHubNamespacePrefix
    $centralizedRegion = $AzureParams.centralizedRegion
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
            throw "useExistingNamespaces is true but no namespace name provided. Set centralizedNamespace in azure-parameters.json or use -CentralizedNamespaceOverride"
        }
    } else {
        # Auto-generated name
        $namespaceName = "$prefix-$subId8"
    }

    # Verify namespace exists
    $namespace = Get-AzEventHubNamespace -ResourceGroupName $resourceGroup -Name $namespaceName -ErrorAction SilentlyContinue
    if (-not $namespace) {
        throw "Event Hub Namespace '$namespaceName' not found in resource group '$resourceGroup'. Deploy Event Hub infrastructure first."
    }

    # Get authorization rule
    $authRule = Get-AzEventHubAuthorizationRule -ResourceGroupName $resourceGroup -NamespaceName $namespaceName -Name "RootManageSharedAccessKey" -ErrorAction SilentlyContinue
    if (-not $authRule) {
        throw "Authorization rule 'RootManageSharedAccessKey' not found on namespace '$namespaceName'"
    }

    return @{
        NamespaceName = $namespaceName
        ResourceGroup = $resourceGroup
        SubscriptionId = $subscriptionId
        Region = $namespace.Location
        AuthorizationRuleId = $authRule.Id
    }
}

function Get-EntraIDDiagnosticSettings {
    param([string]$SettingName)

    try {
        $uri = "https://management.azure.com/providers/microsoft.aadiam/diagnosticSettings?api-version=2017-04-01"
        $response = Invoke-AzRestMethod -Uri $uri -Method GET

        if ($response.StatusCode -eq 200) {
            $settings = ($response.Content | ConvertFrom-Json).value
            if ($SettingName) {
                return $settings | Where-Object { $_.name -eq $SettingName }
            }
            return $settings
        }
        return $null
    }
    catch {
        Write-WarningMsg "Could not retrieve Entra ID diagnostic settings: $_"
        return $null
    }
}

function New-EntraIDDiagnosticSetting {
    param(
        [string]$SettingName,
        [string]$EventHubAuthorizationRuleId,
        [string]$EventHubName,
        [array]$LogCategories
    )

    # Build logs array
    $logs = @()
    foreach ($cat in $LogCategories) {
        $logs += @{
            category = $cat.Category
            enabled = $cat.Enabled
        }
    }

    $body = @{
        properties = @{
            eventHubAuthorizationRuleId = $EventHubAuthorizationRuleId
            eventHubName = $EventHubName
            logs = $logs
        }
    } | ConvertTo-Json -Depth 10

    $uri = "https://management.azure.com/providers/microsoft.aadiam/diagnosticSettings/$($SettingName)?api-version=2017-04-01"

    try {
        $response = Invoke-AzRestMethod -Uri $uri -Method PUT -Payload $body

        if ($response.StatusCode -in @(200, 201)) {
            return $response.Content | ConvertFrom-Json
        } else {
            $errorContent = $response.Content | ConvertFrom-Json -ErrorAction SilentlyContinue
            $errorMessage = if ($errorContent.error.message) { $errorContent.error.message } else { $response.Content }
            throw "Failed to create diagnostic setting: $errorMessage"
        }
    }
    catch {
        throw "Error creating Entra ID diagnostic setting: $_"
    }
}

function Remove-EntraIDDiagnosticSetting {
    param([string]$SettingName)

    $uri = "https://management.azure.com/providers/microsoft.aadiam/diagnosticSettings/$($SettingName)?api-version=2017-04-01"

    try {
        $response = Invoke-AzRestMethod -Uri $uri -Method DELETE

        if ($response.StatusCode -in @(200, 204)) {
            return $true
        } else {
            $errorContent = $response.Content | ConvertFrom-Json -ErrorAction SilentlyContinue
            throw "Failed to remove diagnostic setting: $($errorContent.error.message)"
        }
    }
    catch {
        throw "Error removing Entra ID diagnostic setting: $_"
    }
}

#endregion

#region Main Execution

Write-Host "`n$('='*80)" -ForegroundColor Cyan
Write-Host "  ENTRA ID DIAGNOSTIC SETTINGS - Event Hub Streaming" -ForegroundColor Cyan
Write-Host "$('='*80)" -ForegroundColor Cyan

# Load configuration
$azureParamsFile = Join-Path $ScriptPath "azure-parameters.json"
if (-not (Test-Path $azureParamsFile)) {
    throw "Configuration file not found: $azureParamsFile"
}
$azureParams = Get-Content $azureParamsFile | ConvertFrom-Json

Write-Step "Configuration:" "White"
Write-SubStep "Tenant: $($(Get-AzContext).Tenant.Id)"
Write-SubStep "Diagnostic Setting Name: $DiagnosticSettingName"

# Determine which log categories to use
if ($SecurityOnly) {
    $selectedCategories = $SecurityLogCategories
    Write-SubStep "Log Profile: Security Only (6 categories)"
} elseif ($IncludeHighVolume) {
    $selectedCategories = $HighVolumeLogCategories
    Write-SubStep "Log Profile: High Volume - includes NonInteractiveUserSignInLogs (15 categories)"
    Write-WarningMsg "NonInteractiveUserSignInLogs can be 5-10x the volume of interactive sign-ins!"
} else {
    $selectedCategories = $StandardLogCategories
    Write-SubStep "Log Profile: Standard (9 categories)"
}

# Handle ValidateOnly mode
if ($ValidateOnly) {
    Write-Step "Checking existing Entra ID diagnostic settings..." "Yellow"

    $existingSettings = Get-EntraIDDiagnosticSettings

    if ($existingSettings -and $existingSettings.Count -gt 0) {
        Write-Host "`n  Existing Diagnostic Settings:" -ForegroundColor Cyan
        foreach ($setting in $existingSettings) {
            Write-Host "`n    Name: $($setting.name)" -ForegroundColor White
            if ($setting.properties.eventHubAuthorizationRuleId) {
                Write-SubStep "Event Hub: $($setting.properties.eventHubAuthorizationRuleId.Split('/')[-3])"
            }
            if ($setting.properties.workspaceId) {
                Write-SubStep "Log Analytics: $($setting.properties.workspaceId.Split('/')[-1])"
            }
            if ($setting.properties.storageAccountId) {
                Write-SubStep "Storage Account: $($setting.properties.storageAccountId.Split('/')[-1])"
            }

            $enabledLogs = ($setting.properties.logs | Where-Object { $_.enabled -eq $true }).category
            Write-SubStep "Enabled Categories: $($enabledLogs.Count)"
            foreach ($log in $enabledLogs) {
                Write-Host "      - $log" -ForegroundColor DarkGray
            }
        }
    } else {
        Write-WarningMsg "No Entra ID diagnostic settings configured"
    }

    # Check for our specific setting
    $ourSetting = $existingSettings | Where-Object { $_.name -eq $DiagnosticSettingName }
    if ($ourSetting) {
        Write-Success "Cribl diagnostic setting '$DiagnosticSettingName' is configured"
    } else {
        Write-WarningMsg "Cribl diagnostic setting '$DiagnosticSettingName' is NOT configured"
    }

    exit 0
}

# Handle RemoveSetting mode
if ($RemoveSetting) {
    Write-Step "Removing Entra ID diagnostic setting '$DiagnosticSettingName'..." "Red"

    $existingSetting = Get-EntraIDDiagnosticSettings -SettingName $DiagnosticSettingName
    if (-not $existingSetting) {
        Write-WarningMsg "Diagnostic setting '$DiagnosticSettingName' not found - nothing to remove"
        exit 0
    }

    try {
        Remove-EntraIDDiagnosticSetting -SettingName $DiagnosticSettingName
        Write-Success "Removed diagnostic setting '$DiagnosticSettingName'"
    }
    catch {
        Write-ErrorMsg "Failed to remove diagnostic setting: $_"
        exit 1
    }

    exit 0
}

# Get Event Hub namespace information
Write-Step "Resolving Event Hub namespace..." "Yellow"

try {
    # Set context to Event Hub subscription
    $currentContext = Get-AzContext
    if ($currentContext.Subscription.Id -ne $azureParams.eventHubSubscriptionId) {
        Write-SubStep "Switching to Event Hub subscription..."
        Set-AzContext -SubscriptionId $azureParams.eventHubSubscriptionId | Out-Null
    }

    $ehInfo = Get-EventHubNamespace -AzureParams $azureParams -UseExisting $UseExistingNamespaces -NamespaceOverride $CentralizedNamespaceOverride

    Write-Success "Found namespace: $($ehInfo.NamespaceName)"
    Write-SubStep "Region: $($ehInfo.Region)"
    Write-SubStep "Resource Group: $($ehInfo.ResourceGroup)"
}
catch {
    Write-ErrorMsg "$_"
    exit 1
}

# Check for existing setting
Write-Step "Checking for existing diagnostic setting..." "Yellow"
$existingSetting = Get-EntraIDDiagnosticSettings -SettingName $DiagnosticSettingName

if ($existingSetting) {
    Write-WarningMsg "Diagnostic setting '$DiagnosticSettingName' already exists"
    Write-SubStep "Will update with current configuration"
}

# Create/Update diagnostic setting
Write-Step "Configuring Entra ID diagnostic setting..." "Green"

Write-SubStep "Setting Name: $DiagnosticSettingName"
Write-SubStep "Event Hub Namespace: $($ehInfo.NamespaceName)"
Write-SubStep "Log Categories: $($selectedCategories.Count)"

foreach ($cat in $selectedCategories) {
    Write-Host "      - $($cat.Category)" -ForegroundColor DarkGray
}

try {
    $result = New-EntraIDDiagnosticSetting `
        -SettingName $DiagnosticSettingName `
        -EventHubAuthorizationRuleId $ehInfo.AuthorizationRuleId `
        -EventHubName "" `
        -LogCategories $selectedCategories

    Write-Success "Entra ID diagnostic setting configured successfully"

    Write-Host "`n  Entra ID logs will be sent to:" -ForegroundColor Cyan
    Write-SubStep "Namespace: $($ehInfo.NamespaceName)"
    Write-SubStep "Region: $($ehInfo.Region)"
    Write-Host "`n  Event Hubs will be auto-created:" -ForegroundColor Cyan
    Write-SubStep "insights-logs-auditlogs"
    Write-SubStep "insights-logs-signinlogs"
    Write-SubStep "insights-logs-noninteractiveusersigninlogs (if enabled)"
    Write-SubStep "... and more based on selected categories"
}
catch {
    Write-ErrorMsg "Failed to configure diagnostic setting: $_"
    exit 1
}

Write-Host "`n$('='*80)" -ForegroundColor Green
Write-Host "  ENTRA ID DIAGNOSTIC SETTINGS COMPLETE" -ForegroundColor Green
Write-Host "$('='*80)" -ForegroundColor Green

Write-Host "`n  IMPORTANT NOTES:" -ForegroundColor Yellow
Write-Host "  - Entra ID is a global service - logs are NOT region-specific" -ForegroundColor Gray
Write-Host "  - All logs go to the centralized Event Hub regardless of deployment mode" -ForegroundColor Gray
Write-Host "  - NonInteractiveUserSignInLogs can generate 5-10x more data than interactive" -ForegroundColor Gray
Write-Host "  - Logs may take 15-30 minutes to start appearing in Event Hub" -ForegroundColor Gray

#endregion
