# Deploy-DefenderXDRStreaming.ps1
# Guided setup for Microsoft Defender XDR Streaming API to Event Hub
#
# This script helps configure Defender XDR Streaming API by:
#   1. Validating Defender product licenses in your tenant
#   2. Checking actual usage/onboarding status for each product
#   3. Creating an Event Hub namespace for XDR data
#   4. Providing the Resource ID and portal configuration steps
#   5. Exporting Cribl Stream connection configuration
#
# IMPORTANT: The XDR Streaming API itself must be configured in the Microsoft
# Defender portal - there is no programmatic API for this configuration.
# This script prepares the infrastructure and guides you through the process.
#
# Defender XDR Products Covered:
#   - Microsoft Defender for Endpoint (MDE) - Device telemetry
#   - Microsoft Defender for Identity (MDI) - Identity monitoring
#   - Microsoft Defender for Office 365 (MDO) - Email security
#   - Microsoft Defender for Cloud Apps (MDCA) - SaaS monitoring
#   - XDR Unified Alerts and Incidents
#
# NOT Covered (use Deploy-DefenderExport.ps1 instead):
#   - Microsoft Defender for Cloud (workload protection)
#   - Defender for IoT
#
# Required Permissions:
#   - Azure: Contributor on Event Hub subscription
#   - Microsoft Graph: Organization.Read.All, SecurityEvents.Read.All, SecurityIncident.Read.All
#   - Defender APIs: Machine.Read.All (for MDE validation)
#
# Microsoft Graph Authentication:
#   This script uses Microsoft.Graph PowerShell SDK for Graph API calls.
#   If the SDK is not installed, it falls back to Get-AzAccessToken (limited).
#   For best results, install the Microsoft.Graph modules:
#     Install-Module Microsoft.Graph.Authentication -Scope CurrentUser
#     Install-Module Microsoft.Graph.Identity.DirectoryManagement -Scope CurrentUser
#   The main menu script (Run-AzureLogCollection.ps1) will prompt to install these.
#
# Usage:
#   .\Deploy-DefenderXDRStreaming.ps1                    # Interactive guided setup
#   .\Deploy-DefenderXDRStreaming.ps1 -ValidateOnly     # Check licenses and usage only
#   .\Deploy-DefenderXDRStreaming.ps1 -SkipValidation   # Skip license checks (not recommended)
#   .\Deploy-DefenderXDRStreaming.ps1 -CreateNamespaceOnly  # Only create Event Hub namespace

[CmdletBinding()]
param(
    [Parameter(Mandatory=$false)]
    [switch]$ValidateOnly,

    [Parameter(Mandatory=$false)]
    [switch]$SkipValidation,

    [Parameter(Mandatory=$false)]
    [switch]$CreateNamespaceOnly,

    [Parameter(Mandatory=$false)]
    [string]$NamespaceNameOverride = "",

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

#region Configuration

# Load azure-parameters.json
$azureParamsFile = Join-Path $ScriptPath "azure-parameters.json"
if (-not (Test-Path $azureParamsFile)) {
    Write-Error "azure-parameters.json not found at: $azureParamsFile"
    exit 1
}

try {
    $azureParams = Get-Content $azureParamsFile -Raw | ConvertFrom-Json
} catch {
    Write-Error "Failed to parse azure-parameters.json: $_"
    exit 1
}

# Load resource-coverage.json to check deployment mode
$resourceCoverageFile = Join-Path $ScriptPath "resource-coverage.json"
$deploymentMode = "Centralized"  # Default
if (Test-Path $resourceCoverageFile) {
    try {
        $resourceCoverage = Get-Content $resourceCoverageFile -Raw | ConvertFrom-Json
        if ($resourceCoverage.deploymentSettings.mode) {
            $deploymentMode = $resourceCoverage.deploymentSettings.mode
        }
    } catch {
        Write-WarningMsg "Could not parse resource-coverage.json, defaulting to Centralized mode"
    }
}

# XDR namespace settings - use shared namespace in Centralized mode, separate in Multi-Region
$XDRNamespaceSuffix = $azureParams.eventHubSubscriptionId.Substring(0, 8).ToLower()
if ($deploymentMode -eq "Centralized") {
    # Use the same namespace as other components for simpler management
    $XDRNamespacePrefix = $azureParams.eventHubNamespacePrefix
    $script:UseSharedNamespace = $true
} else {
    # Multi-Region: Use separate XDR namespace for cleaner organization
    $XDRNamespacePrefix = "cribl-xdr"
    $script:UseSharedNamespace = $false
}

#endregion

#region Defender Product Definitions

# Defender XDR products and their detection methods
$DefenderXDRProducts = @{
    "DefenderForEndpoint" = @{
        DisplayName = "Microsoft Defender for Endpoint"
        ShortName = "MDE"
        Description = "Endpoint detection and response for Windows, macOS, Linux, iOS, Android"
        StreamingTables = @("DeviceEvents", "DeviceInfo", "DeviceLogonEvents", "DeviceNetworkEvents",
                           "DeviceProcessEvents", "DeviceFileEvents", "DeviceRegistryEvents",
                           "DeviceImageLoadEvents", "DeviceFileCertificateInfo", "DeviceNetworkInfo")
        LicenseSKUs = @(
            "DEFENDER_ENDPOINT_P1",      # Defender for Endpoint P1
            "DEFENDER_ENDPOINT_P2",      # Defender for Endpoint P2
            "MDE_SMB",                   # Defender for Business
            "M365_E5",                   # Microsoft 365 E5
            "M365_E5_SECURITY",          # Microsoft 365 E5 Security
            "SPE_E5",                    # Microsoft 365 E5 (alt SKU)
            "IDENTITY_THREAT_PROTECTION" # Microsoft 365 E5 Security
        )
        ServicePlanIds = @(
            "871d91ec-ec1a-452b-a83f-bd76c7d770ef",  # Defender for Endpoint P2
            "8e0c0a52-6a6c-4d40-8370-dd62790dcd70",  # Defender for Endpoint P1
            "bfc1bbd9-981b-4f71-9b82-17c35fd0e2a4"   # Defender for Endpoint (E5)
        )
        ValidationMethod = "DefenderAPI"
        APIEndpoint = "https://api.security.microsoft.com/api/machines"
        RequiredPermission = "Machine.Read.All"
    }
    "DefenderForIdentity" = @{
        DisplayName = "Microsoft Defender for Identity"
        ShortName = "MDI"
        Description = "Identity threat detection for Active Directory and Entra ID"
        StreamingTables = @("IdentityLogonEvents", "IdentityQueryEvents", "IdentityDirectoryEvents")
        LicenseSKUs = @(
            "ATA",                       # Advanced Threat Analytics (legacy)
            "AATP",                      # Azure ATP (legacy name)
            "IDENTITY_THREAT_PROTECTION",
            "M365_E5",
            "M365_E5_SECURITY",
            "SPE_E5",
            "EMS_E5"                     # Enterprise Mobility + Security E5
        )
        ServicePlanIds = @(
            "14ab5db5-e6c4-4b20-b4bc-13e36fd2227f",  # Azure ATP
            "f20fedf3-f3c3-43c3-8267-2bfdd51c0939"   # Defender for Identity
        )
        ValidationMethod = "GraphAPI"
        APIEndpoint = "https://graph.microsoft.com/v1.0/security/identities/sensors"
        RequiredPermission = "SecurityIdentitiesSensors.Read.All"
    }
    "DefenderForOffice365" = @{
        DisplayName = "Microsoft Defender for Office 365"
        ShortName = "MDO"
        Description = "Email and collaboration security for Exchange Online, Teams, SharePoint"
        StreamingTables = @("EmailEvents", "EmailAttachmentInfo", "EmailUrlInfo", "EmailPostDeliveryEvents")
        LicenseSKUs = @(
            "ATP_ENTERPRISE",            # Defender for Office 365 P1
            "THREAT_INTELLIGENCE",       # Defender for Office 365 P2
            "M365_E5",
            "M365_E5_SECURITY",
            "SPE_E5",
            "OFFICE365_MULTIGEO"         # Often bundled
        )
        ServicePlanIds = @(
            "8c098270-9dd4-4350-9b30-ba4703f3b36b",  # ATP P1
            "5e10f1c1-0d9a-4e23-9e3f-9f7a7d0c7a19"   # ATP P2
        )
        ValidationMethod = "GraphAPI"
        APIEndpoint = "https://graph.microsoft.com/v1.0/security/threatIntelligence"
        RequiredPermission = "ThreatIntelligence.Read.All"
    }
    "DefenderForCloudApps" = @{
        DisplayName = "Microsoft Defender for Cloud Apps"
        ShortName = "MDCA"
        Description = "Cloud Access Security Broker (CASB) for SaaS application monitoring"
        StreamingTables = @("CloudAppEvents")
        LicenseSKUs = @(
            "ADALLOM_S_DISCOVERY",       # Cloud App Discovery
            "ADALLOM_S_STANDALONE",      # Cloud App Security Standalone
            "M365_E5",
            "M365_E5_SECURITY",
            "SPE_E5",
            "EMS_E5"
        )
        ServicePlanIds = @(
            "2e2ddb96-6af9-4b1d-a3f0-d6ecfd22edb2",  # Cloud App Security
            "932ad362-64a8-4783-9106-97849a1a30b9"   # Defender for Cloud Apps
        )
        ValidationMethod = "License"
        APIEndpoint = $null
        RequiredPermission = $null
    }
    "XDRAlerts" = @{
        DisplayName = "Microsoft Defender XDR Alerts"
        ShortName = "XDR"
        Description = "Unified alerts and incidents from all Defender products"
        StreamingTables = @("AlertInfo", "AlertEvidence", "UrlClickEvents")
        LicenseSKUs = @(
            "M365_E5",
            "M365_E5_SECURITY",
            "SPE_E5",
            "IDENTITY_THREAT_PROTECTION"
        )
        ServicePlanIds = @(
            "bf28f719-7844-4079-9c78-c1307898e192"   # Microsoft 365 Defender
        )
        ValidationMethod = "GraphAPI"
        APIEndpoint = "https://graph.microsoft.com/v1.0/security/incidents"
        RequiredPermission = "SecurityIncident.Read.All"
    }
}

#endregion

#region Table Metadata - Tier and Volume Information

# Detailed table metadata with export tiers and volume estimates
# Tier 1: Essential - Always export (high value, foundation for detection)
# Tier 2: Recommended - High value for comprehensive visibility
# Tier 3: Situational - Export based on specific use cases (often high volume)
$XDRTableMetadata = @{
    # Alerts (XDR) - Always Tier 1
    "AlertInfo" = @{
        Tier = 1
        TierName = "Essential"
        Product = "XDR"
        Description = "Alert metadata, severity, category, MITRE ATT&CK mappings"
        WhyExport = "Foundation for all XDR alerts - critical for incident correlation"
        Volume = "Low"
        VolumeEstimate = "~100 MB-1 GB/day"
    }
    "AlertEvidence" = @{
        Tier = 1
        TierName = "Essential"
        Product = "XDR"
        Description = "Entities associated with alerts (files, processes, IPs, users)"
        WhyExport = "Context for all alerts - enables pivot and enrichment"
        Volume = "Low"
        VolumeEstimate = "~100 MB-1 GB/day"
    }
    "UrlClickEvents" = @{
        Tier = 2
        TierName = "Recommended"
        Product = "MDO"
        Description = "SafeLinks click events - user URL click behavior"
        WhyExport = "User click behavior, compromised link detection"
        Volume = "Low-Medium"
        VolumeEstimate = "Depends on mail volume"
    }

    # Endpoint (MDE) - Mixed tiers based on value/volume
    "DeviceProcessEvents" = @{
        Tier = 1
        TierName = "Essential"
        Product = "MDE"
        Description = "Process creation and related events"
        WhyExport = "Core for threat hunting - process execution visibility"
        Volume = "High"
        VolumeEstimate = "~50-100 GB/day per 1K endpoints"
        Warning = $null
    }
    "DeviceNetworkEvents" = @{
        Tier = 1
        TierName = "Essential"
        Product = "MDE"
        Description = "Network connections and related events"
        WhyExport = "C2 detection, lateral movement visibility"
        Volume = "High"
        VolumeEstimate = "~30-80 GB/day per 1K endpoints"
        Warning = $null
    }
    "DeviceLogonEvents" = @{
        Tier = 1
        TierName = "Essential"
        Product = "MDE"
        Description = "Local and network logon events"
        WhyExport = "Authentication monitoring, credential attack detection"
        Volume = "Medium"
        VolumeEstimate = "~5-15 GB/day per 1K endpoints"
        Warning = $null
    }
    "DeviceFileEvents" = @{
        Tier = 2
        TierName = "Recommended"
        Product = "MDE"
        Description = "File creation, modification, deletion"
        WhyExport = "Ransomware detection, data exfiltration visibility"
        Volume = "High"
        VolumeEstimate = "~30-60 GB/day per 1K endpoints"
        Warning = $null
    }
    "DeviceRegistryEvents" = @{
        Tier = 2
        TierName = "Recommended"
        Product = "MDE"
        Description = "Registry modifications"
        WhyExport = "Persistence mechanism detection"
        Volume = "Medium"
        VolumeEstimate = "~10-30 GB/day per 1K endpoints"
        Warning = $null
    }
    "DeviceEvents" = @{
        Tier = 2
        TierName = "Recommended"
        Product = "MDE"
        Description = "Misc security events (AV, exploit protection, ASR)"
        WhyExport = "AV detections, ASR blocks, exploit attempts"
        Volume = "Low-Medium"
        VolumeEstimate = "~2-10 GB/day per 1K endpoints"
        Warning = $null
    }
    "DeviceImageLoadEvents" = @{
        Tier = 3
        TierName = "Situational"
        Product = "MDE"
        Description = "DLL loading events"
        WhyExport = "DLL sideloading detection, but very high volume"
        Volume = "Very High"
        VolumeEstimate = "~100+ GB/day per 1K endpoints"
        Warning = "CAUTION: Extremely high volume. Consider filtering in Cribl before SIEM."
    }
    "DeviceInfo" = @{
        Tier = 3
        TierName = "Situational"
        Product = "MDE"
        Description = "Device inventory and configuration snapshots"
        WhyExport = "Asset context and inventory"
        Volume = "Low"
        VolumeEstimate = "Periodic snapshots"
        Warning = $null
    }
    "DeviceNetworkInfo" = @{
        Tier = 3
        TierName = "Situational"
        Product = "MDE"
        Description = "Network adapter information"
        WhyExport = "Network configuration changes"
        Volume = "Low"
        VolumeEstimate = "Periodic snapshots"
        Warning = $null
    }
    "DeviceFileCertificateInfo" = @{
        Tier = 3
        TierName = "Situational"
        Product = "MDE"
        Description = "Certificate info for signed files"
        WhyExport = "Code signing verification"
        Volume = "Low"
        VolumeEstimate = "Varies"
        Warning = $null
    }

    # Email (MDO)
    "EmailEvents" = @{
        Tier = 1
        TierName = "Essential"
        Product = "MDO"
        Description = "Email delivery events"
        WhyExport = "Phishing detection, BEC monitoring"
        Volume = "Low-Medium"
        VolumeEstimate = "Depends on mail volume"
        Warning = $null
    }
    "EmailAttachmentInfo" = @{
        Tier = 2
        TierName = "Recommended"
        Product = "MDO"
        Description = "Attachment metadata"
        WhyExport = "Malicious attachment analysis"
        Volume = "Low-Medium"
        VolumeEstimate = "Depends on mail volume"
        Warning = $null
    }
    "EmailUrlInfo" = @{
        Tier = 2
        TierName = "Recommended"
        Product = "MDO"
        Description = "URLs in emails"
        WhyExport = "Phishing URL detection"
        Volume = "Low-Medium"
        VolumeEstimate = "Depends on mail volume"
        Warning = $null
    }
    "EmailPostDeliveryEvents" = @{
        Tier = 3
        TierName = "Situational"
        Product = "MDO"
        Description = "Post-delivery actions (ZAP, user actions)"
        WhyExport = "ZAP actions, remediation tracking"
        Volume = "Low"
        VolumeEstimate = "Low volume"
        Warning = $null
    }

    # Identity (MDI)
    "IdentityLogonEvents" = @{
        Tier = 1
        TierName = "Essential"
        Product = "MDI"
        Description = "AD/Entra authentication events"
        WhyExport = "Identity-based attack detection"
        Volume = "Medium"
        VolumeEstimate = "~5-20 GB/day"
        Warning = $null
    }
    "IdentityDirectoryEvents" = @{
        Tier = 2
        TierName = "Recommended"
        Product = "MDI"
        Description = "AD directory changes"
        WhyExport = "AD changes, privilege escalation detection"
        Volume = "Medium"
        VolumeEstimate = "~5-20 GB/day"
        Warning = $null
    }
    "IdentityQueryEvents" = @{
        Tier = 3
        TierName = "Situational"
        Product = "MDI"
        Description = "AD queries (LDAP, DNS, etc.)"
        WhyExport = "LDAP reconnaissance detection"
        Volume = "High"
        VolumeEstimate = "High volume from normal AD operations"
        Warning = "CAUTION: High volume from normal AD operations. Valuable for recon detection but noisy."
    }

    # Cloud Apps (MDCA)
    "CloudAppEvents" = @{
        Tier = 2
        TierName = "Recommended"
        Product = "MDCA"
        Description = "Cloud app activity (SaaS)"
        WhyExport = "SaaS compromise, data exfiltration detection"
        Volume = "Medium"
        VolumeEstimate = "Varies by SaaS usage"
        Warning = $null
    }
}

# Not supported in Streaming API (for reference)
$XDRTablesNotSupported = @{
    "BehaviorEntities" = "Not yet supported in Streaming API"
    "BehaviorInfo" = "Not yet supported in Streaming API"
    "TVM Tables" = "Vulnerability/software inventory not available via Streaming API"
}

#endregion

#region Helper Functions

# Note: Write-Step, Write-SubStep, Write-Success, Write-WarningMsgMsg, Write-ErrorMsg, Write-Info
# are imported from Output-Helper.ps1

function Get-XDRNamespaceName {
    if (-not [string]::IsNullOrWhiteSpace($NamespaceNameOverride)) {
        return $NamespaceNameOverride
    }
    return "$XDRNamespacePrefix-$XDRNamespaceSuffix"
}

# Track Graph connection state
$script:GraphConnectionState = @{
    IsConnected = $false
    ConnectionMethod = $null  # "SDK" or "Token"
}

function Ensure-GraphConnection {
    <#
    .SYNOPSIS
        Ensures connection to Microsoft Graph with appropriate scopes.
    .DESCRIPTION
        Attempts to connect using Microsoft.Graph SDK first, then falls back to
        Get-AzAccessToken if SDK is not available. Returns connection info.
    .OUTPUTS
        Hashtable with IsConnected, Method, and optional Token/Headers
    #>

    # If already connected, return cached state
    if ($script:GraphConnectionState.IsConnected) {
        return $script:GraphConnectionState
    }

    # Try Microsoft.Graph SDK first (preferred method)
    if (Get-Module -ListAvailable -Name Microsoft.Graph.Authentication -ErrorAction SilentlyContinue) {
        try {
            # Check if already connected to Graph
            $context = Get-MgContext -ErrorAction SilentlyContinue
            if ($context) {
                Write-Success "Connected to Microsoft Graph (SDK)"
                Write-SubStep "Account: $($context.Account)" "Gray"
                $script:GraphConnectionState = @{
                    IsConnected = $true
                    ConnectionMethod = "SDK"
                    Context = $context
                }
                return $script:GraphConnectionState
            }

            # Not connected, try to connect with required scopes
            Write-SubStep "Connecting to Microsoft Graph..." "Cyan"
            $scopes = @(
                "Organization.Read.All",
                "SecurityEvents.Read.All",
                "SecurityIncident.Read.All"
            )

            # Connect using the same tenant as Azure context
            $azContext = Get-AzContext -ErrorAction SilentlyContinue
            if ($azContext -and $azContext.Tenant.Id) {
                Connect-MgGraph -Scopes $scopes -TenantId $azContext.Tenant.Id -NoWelcome -ErrorAction Stop
            } else {
                Connect-MgGraph -Scopes $scopes -NoWelcome -ErrorAction Stop
            }

            $context = Get-MgContext
            Write-Success "Connected to Microsoft Graph (SDK)"
            Write-SubStep "Account: $($context.Account)" "Gray"
            $script:GraphConnectionState = @{
                IsConnected = $true
                ConnectionMethod = "SDK"
                Context = $context
            }
            return $script:GraphConnectionState
        }
        catch {
            Write-SubStep "Graph SDK connection failed: $($_.Exception.Message)" "Yellow"
            # Fall through to token method
        }
    }

    # Fallback: Use Get-AzAccessToken
    try {
        $graphToken = Get-AzAccessToken -ResourceUrl "https://graph.microsoft.com/" -ErrorAction Stop

        $script:GraphConnectionState = @{
            IsConnected = $true
            ConnectionMethod = "Token"
            Token = $graphToken.Token
            Headers = @{
                "Authorization" = "Bearer $($graphToken.Token)"
                "Content-Type" = "application/json"
            }
        }
        Write-Success "Connected to Microsoft Graph (Token)"
        return $script:GraphConnectionState
    }
    catch {
        Write-WarningMsg "Could not connect to Microsoft Graph"
        Write-SubStep "License validation will be limited" "Yellow"
        $script:GraphConnectionState = @{
            IsConnected = $false
            ConnectionMethod = $null
            Error = $_.Exception.Message
        }
        return $script:GraphConnectionState
    }
}

function Invoke-GraphRequest {
    <#
    .SYNOPSIS
        Makes a request to Microsoft Graph API using available connection method.
    .PARAMETER Uri
        The Graph API URI (e.g., "https://graph.microsoft.com/v1.0/subscribedSkus")
    .PARAMETER Method
        HTTP method (default: GET)
    #>
    param(
        [Parameter(Mandatory=$true)]
        [string]$Uri,

        [Parameter(Mandatory=$false)]
        [string]$Method = "GET"
    )

    $graphState = Ensure-GraphConnection

    if (-not $graphState.IsConnected) {
        throw "Not connected to Microsoft Graph"
    }

    if ($graphState.ConnectionMethod -eq "SDK") {
        # Use Invoke-MgGraphRequest
        return Invoke-MgGraphRequest -Uri $Uri -Method $Method -ErrorAction Stop
    }
    else {
        # Use REST with token
        return Invoke-RestMethod -Uri $Uri -Headers $graphState.Headers -Method $Method -ErrorAction Stop
    }
}

#endregion

#region License Validation Functions

function Get-TenantLicenses {
    <#
    .SYNOPSIS
        Retrieves all subscribed SKUs (licenses) in the tenant via Graph API.
    .DESCRIPTION
        Uses the subscribedSkus endpoint to get organization-level license information.
        Uses Microsoft.Graph SDK if available, falls back to REST API.
        Requires Organization.Read.All permission.
    #>

    Write-Step "Checking tenant licenses..."

    # Ensure Graph connection first
    $graphState = Ensure-GraphConnection
    if (-not $graphState.IsConnected) {
        Write-WarningMsg "Not connected to Microsoft Graph"
        Write-SubStep "License check skipped (no permission)" "Yellow"
        return $null
    }

    try {
        # Try using Microsoft.Graph SDK cmdlet first (if available and connected via SDK)
        if ($graphState.ConnectionMethod -eq "SDK" -and (Get-Command Get-MgSubscribedSku -ErrorAction SilentlyContinue)) {
            $licenses = Get-MgSubscribedSku -ErrorAction Stop
            Write-Success "Retrieved $($licenses.Count) license SKUs from tenant"
            # Convert to consistent format
            return $licenses | ForEach-Object {
                @{
                    skuPartNumber = $_.SkuPartNumber
                    skuId = $_.SkuId
                    consumedUnits = $_.ConsumedUnits
                    prepaidUnits = @{
                        enabled = $_.PrepaidUnits.Enabled
                        suspended = $_.PrepaidUnits.Suspended
                        warning = $_.PrepaidUnits.Warning
                    }
                    servicePlans = $_.ServicePlans | ForEach-Object {
                        @{
                            servicePlanId = $_.ServicePlanId
                            servicePlanName = $_.ServicePlanName
                            provisioningStatus = $_.ProvisioningStatus
                        }
                    }
                }
            }
        }

        # Fall back to direct Graph API call
        $response = Invoke-GraphRequest -Uri "https://graph.microsoft.com/v1.0/subscribedSkus"

        $licenseData = if ($response.value) { $response.value } else { $response }
        Write-Success "Retrieved $($licenseData.Count) license SKUs from tenant"
        return $licenseData
    }
    catch {
        $errorMsg = $_.Exception.Message
        if ($errorMsg -match "403|Forbidden|Authorization") {
            Write-WarningMsg "Insufficient permissions to read tenant licenses"
            Write-SubStep "Required: Organization.Read.All" "Yellow"
            Write-SubStep "Run: Connect-MgGraph -Scopes 'Organization.Read.All'" "Gray"
        }
        elseif ($errorMsg -match "401|Unauthorized") {
            Write-WarningMsg "Not authenticated to Microsoft Graph"
            Write-SubStep "Run: Connect-MgGraph -Scopes 'Organization.Read.All'" "Yellow"
        }
        else {
            Write-WarningMsg "Failed to retrieve licenses: $errorMsg"
        }
        return $null
    }
}

function Test-DefenderProductLicense {
    <#
    .SYNOPSIS
        Checks if a specific Defender product is licensed in the tenant.
    .PARAMETER ProductKey
        Key from $DefenderXDRProducts hashtable
    .PARAMETER TenantLicenses
        Array of license SKUs from Get-TenantLicenses
    #>
    param(
        [string]$ProductKey,
        [array]$TenantLicenses
    )

    $product = $DefenderXDRProducts[$ProductKey]
    $foundLicenses = @()
    $foundSKUs = @()  # Track found SKUs separately to avoid duplicate entries

    foreach ($license in $TenantLicenses) {
        # Get the SKU part number - handle both hashtable and object formats
        $skuPartNumber = $license.skuPartNumber
        $consumedUnits = $license.consumedUnits
        $prepaidEnabled = $license.prepaidUnits.enabled
        $servicePlans = $license.servicePlans

        # Check SKU part number against known Defender SKUs
        foreach ($sku in $product.LicenseSKUs) {
            if ($skuPartNumber -match $sku) {
                $foundLicenses += @{
                    SKU = $skuPartNumber
                    ConsumedUnits = $consumedUnits
                    PrepaidUnits = $prepaidEnabled
                }
                $foundSKUs += $skuPartNumber
            }
        }

        # Check service plan IDs within the license
        if ($servicePlans) {
            foreach ($servicePlan in $servicePlans) {
                $planId = $servicePlan.servicePlanId
                $planName = $servicePlan.servicePlanName
                $provStatus = $servicePlan.provisioningStatus

                foreach ($targetPlanId in $product.ServicePlanIds) {
                    if ($planId -eq $targetPlanId -and $provStatus -eq "Success") {
                        # Only add if we haven't already added this SKU
                        if ($foundSKUs -notcontains $skuPartNumber) {
                            $foundLicenses += @{
                                SKU = $skuPartNumber
                                ServicePlan = $planName
                                ConsumedUnits = $consumedUnits
                                PrepaidUnits = $prepaidEnabled
                            }
                            $foundSKUs += $skuPartNumber
                        }
                    }
                }
            }
        }
    }

    return $foundLicenses
}

function Test-DefenderForEndpointUsage {
    <#
    .SYNOPSIS
        Checks if Defender for Endpoint has onboarded devices.
    .DESCRIPTION
        Uses the Defender for Endpoint API to check for machines.
        Requires Machine.Read.All permission on WindowsDefenderATP.
    #>

    try {
        # Try to get token for Defender API
        $defenderToken = Get-AzAccessToken -ResourceUrl "https://api.security.microsoft.com" -ErrorAction Stop

        $headers = @{
            "Authorization" = "Bearer $($defenderToken.Token)"
            "Content-Type" = "application/json"
        }

        # Get machine count (limit to 1 to just check if any exist)
        $response = Invoke-RestMethod -Uri "https://api.security.microsoft.com/api/machines?`$top=100" `
            -Headers $headers -Method Get -ErrorAction Stop

        $machineCount = $response.value.Count
        $activeCount = ($response.value | Where-Object { $_.healthStatus -eq "Active" }).Count

        return @{
            IsActive = ($machineCount -gt 0)
            TotalDevices = $machineCount
            ActiveDevices = $activeCount
            Message = if ($machineCount -gt 0) { "$machineCount device(s) onboarded ($activeCount active)" } else { "No devices onboarded" }
        }
    }
    catch {
        $errorMsg = $_.Exception.Message
        if ($errorMsg -match "403|Forbidden") {
            return @{
                IsActive = $null
                Message = "Cannot verify - need Machine.Read.All permission on WindowsDefenderATP"
            }
        }
        elseif ($errorMsg -match "404|NotFound") {
            return @{
                IsActive = $false
                Message = "Defender for Endpoint not configured in tenant"
            }
        }
        else {
            return @{
                IsActive = $null
                Message = "Cannot verify: $errorMsg"
            }
        }
    }
}

function Test-DefenderForIdentityUsage {
    <#
    .SYNOPSIS
        Checks if Defender for Identity has sensors deployed.
    .DESCRIPTION
        Uses Graph API security/identities/sensors endpoint.
        Uses Microsoft.Graph SDK if available, falls back to REST API.
        Requires SecurityIdentitiesSensors.Read.All permission.
    #>

    $graphState = Ensure-GraphConnection
    if (-not $graphState.IsConnected) {
        return @{
            IsActive = $null
            Message = "Cannot verify - not connected to Microsoft Graph"
        }
    }

    try {
        # Try v1.0 first, fall back to beta
        $response = $null
        try {
            $response = Invoke-GraphRequest -Uri "https://graph.microsoft.com/v1.0/security/identities/sensors"
        }
        catch {
            $response = Invoke-GraphRequest -Uri "https://graph.microsoft.com/beta/security/identities/sensors"
        }

        $sensors = if ($response.value) { $response.value } else { @($response) }
        $sensorCount = $sensors.Count
        $healthySensors = ($sensors | Where-Object { $_.healthStatus -eq "healthy" }).Count

        return @{
            IsActive = ($sensorCount -gt 0)
            TotalSensors = $sensorCount
            HealthySensors = $healthySensors
            Message = if ($sensorCount -gt 0) { "$sensorCount sensor(s) deployed ($healthySensors healthy)" } else { "No sensors deployed" }
        }
    }
    catch {
        $errorMsg = $_.Exception.Message
        if ($errorMsg -match "403|Forbidden") {
            return @{
                IsActive = $null
                Message = "Cannot verify - need SecurityIdentitiesSensors.Read.All permission"
            }
        }
        elseif ($errorMsg -match "404|NotFound") {
            return @{
                IsActive = $false
                Message = "Defender for Identity not configured in tenant"
            }
        }
        else {
            return @{
                IsActive = $null
                Message = "Cannot verify: $errorMsg"
            }
        }
    }
}

function Test-DefenderXDRAlertsUsage {
    <#
    .SYNOPSIS
        Checks if XDR has any incidents/alerts (indicates active usage).
    .DESCRIPTION
        Uses Microsoft.Graph SDK if available, falls back to REST API.
        Requires SecurityIncident.Read.All permission.
    #>

    $graphState = Ensure-GraphConnection
    if (-not $graphState.IsConnected) {
        return @{
            IsActive = $null
            Message = "Cannot verify - not connected to Microsoft Graph"
        }
    }

    try {
        # Check for recent incidents (last 30 days)
        $thirtyDaysAgo = (Get-Date).AddDays(-30).ToString("yyyy-MM-ddTHH:mm:ssZ")
        $uri = "https://graph.microsoft.com/v1.0/security/incidents?`$filter=createdDateTime ge $thirtyDaysAgo&`$top=10"

        $response = Invoke-GraphRequest -Uri $uri

        $incidents = if ($response.value) { $response.value } else { @($response) }
        $incidentCount = $incidents.Count

        return @{
            IsActive = ($incidentCount -gt 0)
            RecentIncidents = $incidentCount
            Message = if ($incidentCount -gt 0) { "$incidentCount incident(s) in last 30 days" } else { "No recent incidents" }
        }
    }
    catch {
        $errorMsg = $_.Exception.Message
        if ($errorMsg -match "403|Forbidden") {
            return @{
                IsActive = $null
                Message = "Cannot verify - need SecurityIncident.Read.All permission"
            }
        }
        else {
            return @{
                IsActive = $null
                Message = "Cannot verify: $errorMsg"
            }
        }
    }
}

function Get-DefenderProductStatus {
    <#
    .SYNOPSIS
        Comprehensive check of all Defender XDR products - license and usage.
    .OUTPUTS
        Hashtable with status for each product
    #>

    Write-Host "`n$('='*80)" -ForegroundColor Cyan
    Write-Host "  DEFENDER XDR PRODUCT VALIDATION" -ForegroundColor Cyan
    Write-Host "$('='*80)" -ForegroundColor Cyan

    $results = @{}

    # Get tenant licenses first
    $tenantLicenses = Get-TenantLicenses
    $hasLicenseData = ($null -ne $tenantLicenses)

    foreach ($productKey in $DefenderXDRProducts.Keys) {
        $product = $DefenderXDRProducts[$productKey]

        Write-Step "$($product.DisplayName) ($($product.ShortName))"
        Write-SubStep $product.Description "DarkGray"

        $status = @{
            ProductKey = $productKey
            DisplayName = $product.DisplayName
            ShortName = $product.ShortName
            IsLicensed = $false
            IsActive = $null
            LicenseDetails = @()
            UsageDetails = $null
            StreamingTables = $product.StreamingTables
            ConfigurationRecommendation = ""
        }

        # Check license
        if ($hasLicenseData) {
            $licenses = Test-DefenderProductLicense -ProductKey $productKey -TenantLicenses $tenantLicenses
            # Ensure licenses is always treated as an array for Count check
            $licensesArray = @($licenses)

            if ($licensesArray.Count -gt 0 -and $null -ne $licensesArray[0]) {
                $status.IsLicensed = $true
                $status.LicenseDetails = $licensesArray
                Write-Success "Licensed via: $($licensesArray[0].SKU)"

                if ($licensesArray[0].ConsumedUnits) {
                    Write-SubStep "  Consumed: $($licensesArray[0].ConsumedUnits) / $($licensesArray[0].PrepaidUnits) available" "Gray"
                }
            }
            else {
                Write-WarningMsg "No license detected"
                $status.ConfigurationRecommendation = "Product not licensed - logs will not be available for streaming"
            }
        }
        else {
            Write-SubStep "License check skipped (no permission)" "Yellow"
        }

        # Check usage based on product type
        if ($status.IsLicensed -or -not $hasLicenseData) {
            switch ($productKey) {
                "DefenderForEndpoint" {
                    $usage = Test-DefenderForEndpointUsage
                    $status.UsageDetails = $usage
                    $status.IsActive = $usage.IsActive

                    if ($usage.IsActive -eq $true) {
                        Write-Success "Active: $($usage.Message)"
                    }
                    elseif ($usage.IsActive -eq $false) {
                        Write-WarningMsg "Not active: $($usage.Message)"
                        $status.ConfigurationRecommendation = "Onboard devices to Defender for Endpoint to generate telemetry"
                    }
                    else {
                        Write-Info $usage.Message
                    }
                }
                "DefenderForIdentity" {
                    $usage = Test-DefenderForIdentityUsage
                    $status.UsageDetails = $usage
                    $status.IsActive = $usage.IsActive

                    if ($usage.IsActive -eq $true) {
                        Write-Success "Active: $($usage.Message)"
                    }
                    elseif ($usage.IsActive -eq $false) {
                        Write-WarningMsg "Not active: $($usage.Message)"
                        $status.ConfigurationRecommendation = "Deploy MDI sensors on domain controllers to generate identity telemetry"
                    }
                    else {
                        Write-Info $usage.Message
                    }
                }
                "DefenderForOffice365" {
                    # MDO is typically active if licensed and Exchange Online is in use
                    if ($status.IsLicensed) {
                        Write-Info "Assumed active if Exchange Online mailboxes exist"
                        $status.IsActive = $true
                        $status.UsageDetails = @{ Message = "Active if Exchange Online is configured" }
                    }
                    else {
                        $status.IsActive = $false
                        $status.ConfigurationRecommendation = "License Defender for Office 365 P1 or P2 for email protection telemetry"
                    }
                }
                "DefenderForCloudApps" {
                    # MDCA is typically active if licensed
                    if ($status.IsLicensed) {
                        Write-Info "Assumed active if license is assigned"
                        $status.IsActive = $true
                        $status.UsageDetails = @{ Message = "Active if MDCA policies are configured" }
                    }
                    else {
                        $status.IsActive = $false
                        $status.ConfigurationRecommendation = "License Defender for Cloud Apps for SaaS monitoring telemetry"
                    }
                }
                "XDRAlerts" {
                    $usage = Test-DefenderXDRAlertsUsage
                    $status.UsageDetails = $usage
                    $status.IsActive = $usage.IsActive

                    if ($usage.IsActive -eq $true) {
                        Write-Success "Active: $($usage.Message)"
                    }
                    elseif ($usage.IsActive -eq $false) {
                        Write-Info "No recent incidents - this is normal for new deployments"
                        $status.IsActive = $true  # Consider active if licensed
                    }
                    else {
                        Write-Info $usage.Message
                    }
                }
            }
        }

        # Streaming tables info
        Write-SubStep "Tables: $($product.StreamingTables -join ', ')" "DarkGray"

        $results[$productKey] = $status
    }

    return $results
}

#endregion

#region Event Hub Functions

function New-XDREventHubNamespace {
    <#
    .SYNOPSIS
        Creates an Event Hub namespace for XDR streaming data.
    #>

    $namespaceName = Get-XDRNamespaceName
    $resourceGroup = $azureParams.eventHubResourceGroup
    $location = $azureParams.centralizedRegion
    $subscriptionId = $azureParams.eventHubSubscriptionId

    Write-Host "`n$('='*80)" -ForegroundColor Green
    Write-Host "  EVENT HUB NAMESPACE SETUP" -ForegroundColor Green
    Write-Host "$('='*80)" -ForegroundColor Green

    Write-Step "Namespace Configuration"
    Write-SubStep "Name:           $namespaceName" "White"
    Write-SubStep "Resource Group: $resourceGroup" "White"
    Write-SubStep "Location:       $location" "White"
    Write-SubStep "Subscription:   $subscriptionId" "White"
    if ($script:UseSharedNamespace) {
        Write-SubStep "Mode:           Shared (same as Azure diagnostic logs)" "Cyan"
    } else {
        Write-SubStep "Mode:           Dedicated (separate XDR namespace)" "Yellow"
    }

    # Set subscription context
    try {
        Set-AzContext -SubscriptionId $subscriptionId -ErrorAction Stop | Out-Null
        Write-Success "Subscription context set"
    }
    catch {
        Write-ErrorMsg "Failed to set subscription context: $_"
        return $null
    }

    # Check if resource group exists
    Write-Step "Checking resource group..."
    $rg = Get-AzResourceGroup -Name $resourceGroup -ErrorAction SilentlyContinue
    if (-not $rg) {
        Write-SubStep "Creating resource group: $resourceGroup" "Yellow"
        try {
            $rg = New-AzResourceGroup -Name $resourceGroup -Location $location -ErrorAction Stop
            Write-Success "Resource group created"
        }
        catch {
            Write-ErrorMsg "Failed to create resource group: $_"
            return $null
        }
    }
    else {
        Write-Success "Resource group exists"
    }

    # Check if namespace already exists
    Write-Step "Checking Event Hub namespace..."
    $existingNs = Get-AzEventHubNamespace -ResourceGroupName $resourceGroup -Name $namespaceName -ErrorAction SilentlyContinue

    if ($existingNs) {
        Write-Success "Namespace already exists"
        Write-SubStep "Status: $($existingNs.ProvisioningState)" "Gray"
    }
    else {
        Write-SubStep "Creating namespace: $namespaceName" "Yellow"
        Write-SubStep "This may take 1-2 minutes..." "Gray"

        try {
            $newNs = New-AzEventHubNamespace `
                -ResourceGroupName $resourceGroup `
                -Name $namespaceName `
                -Location $location `
                -SkuName $azureParams.eventHubSku `
                -SkuCapacity $azureParams.eventHubCapacity `
                -ErrorAction Stop

            Write-Success "Namespace created successfully"
            $existingNs = $newNs
        }
        catch {
            Write-ErrorMsg "Failed to create namespace: $_"
            return $null
        }
    }

    # Get the Resource ID
    $resourceId = $existingNs.Id

    # Get connection string for Cribl
    Write-Step "Retrieving connection information..."
    try {
        $authRule = Get-AzEventHubAuthorizationRule -ResourceGroupName $resourceGroup `
            -NamespaceName $namespaceName -Name "RootManageSharedAccessKey" -ErrorAction Stop

        $keys = Get-AzEventHubKey -ResourceGroupName $resourceGroup `
            -NamespaceName $namespaceName -AuthorizationRuleName "RootManageSharedAccessKey" -ErrorAction Stop

        Write-Success "Connection information retrieved"
    }
    catch {
        Write-WarningMsg "Could not retrieve connection keys: $_"
        $keys = $null
    }

    return @{
        NamespaceName = $namespaceName
        ResourceId = $resourceId
        ResourceGroup = $resourceGroup
        Location = $location
        ConnectionString = $keys.PrimaryConnectionString
        PrimaryKey = $keys.PrimaryKey
        Endpoint = "$namespaceName.servicebus.windows.net"
    }
}

#endregion

#region Output Functions

function Show-PortalConfiguration {
    <#
    .SYNOPSIS
        Displays the portal configuration steps with the Resource ID and detailed table selection guidance.
    #>
    param(
        [hashtable]$NamespaceInfo,
        [hashtable]$ProductStatus
    )

    Write-Host "`n$('='*80)" -ForegroundColor Magenta
    Write-Host "  DEFENDER XDR STREAMING API - PORTAL CONFIGURATION" -ForegroundColor Magenta
    Write-Host "$('='*80)" -ForegroundColor Magenta

    Write-Host "`n  The XDR Streaming API must be configured in the Microsoft Defender portal." -ForegroundColor White
    Write-Host "  This script has prepared the Event Hub - follow these steps to complete setup." -ForegroundColor Gray

    # -------------------------------------------------------------------------
    # SECTION 1: Event Hub Configuration Values
    # -------------------------------------------------------------------------
    Write-Host "`n  $('-'*76)" -ForegroundColor DarkGray
    Write-Host "  EVENT HUB CONFIGURATION VALUES (copy these for the portal)" -ForegroundColor Cyan
    Write-Host "  $('-'*76)" -ForegroundColor DarkGray

    Write-Host "`n  Namespace Name:" -ForegroundColor White
    Write-Host "    $($NamespaceInfo.NamespaceName)" -ForegroundColor Green

    Write-Host "`n  Resource ID (copy this exactly):" -ForegroundColor White
    Write-Host "    $($NamespaceInfo.ResourceId)" -ForegroundColor Green

    Write-Host "`n  Event Hub Name:" -ForegroundColor White
    Write-Host "    (Leave BLANK - Azure will auto-create per table)" -ForegroundColor Yellow

    # -------------------------------------------------------------------------
    # SECTION 2: Tables by Defender Product
    # -------------------------------------------------------------------------
    Write-Host "`n  $('-'*76)" -ForegroundColor DarkGray
    Write-Host "  AVAILABLE TABLES BY DEFENDER PRODUCT" -ForegroundColor Cyan
    Write-Host "  $('-'*76)" -ForegroundColor DarkGray

    Write-Host "`n  All tables are shown below organized by Defender product." -ForegroundColor White
    Write-Host "  You can configure streaming even before licensing - data flows once licensed." -ForegroundColor Gray
    Write-Host "`n  Tier Legend: T1=Essential, T2=Recommended, T3=Situational (high volume)" -ForegroundColor DarkGray

    # Build lists of tables by tier (for all products, regardless of license)
    $tier1Tables = @()
    $tier2Tables = @()
    $tier3Tables = @()

    # Process each product and show ALL tables
    foreach ($productKey in @("DefenderForEndpoint", "DefenderForIdentity", "DefenderForOffice365", "DefenderForCloudApps", "XDRAlerts")) {
        if (-not $ProductStatus.ContainsKey($productKey)) { continue }

        $product = $ProductStatus[$productKey]
        $isLicensed = $product.IsLicensed
        $isActive = $product.IsActive -eq $true -or $null -eq $product.IsActive

        # Product header with license status
        Write-Host "`n  $($product.DisplayName) ($($product.ShortName))" -ForegroundColor White

        # Show license status
        Write-Host "    License: " -NoNewline -ForegroundColor Gray
        if ($isLicensed) {
            Write-Host "LICENSED" -NoNewline -ForegroundColor Green
            if ($isActive) {
                Write-Host " (Active)" -ForegroundColor Green
            } else {
                Write-Host " (Not yet active - $($product.ConfigurationRecommendation))" -ForegroundColor Yellow
            }
        } else {
            Write-Host "NOT LICENSED" -ForegroundColor DarkYellow
            Write-Host "    (Tables shown for planning - data flows once product is licensed)" -ForegroundColor DarkGray
        }

        # Show all tables for this product
        Write-Host "    Tables:" -ForegroundColor Gray
        foreach ($table in ($product.StreamingTables | Sort-Object)) {
            $metadata = $XDRTableMetadata[$table]
            $tierInfo = if ($metadata) { "T$($metadata.Tier)" } else { "T2" }
            $volumeInfo = if ($metadata) { "[$($metadata.Volume)]" } else { "" }

            # Color based on tier and license status
            $tableColor = if (-not $isLicensed) { "DarkGray" }
                          elseif ($metadata -and $metadata.Tier -eq 1) { "Green" }
                          elseif ($metadata -and $metadata.Tier -eq 2) { "Yellow" }
                          else { "DarkYellow" }

            $checkbox = if ($isLicensed) { "[X]" } else { "[ ]" }
            Write-Host "      $checkbox $table " -NoNewline -ForegroundColor $tableColor
            Write-Host "($tierInfo) $volumeInfo" -ForegroundColor DarkGray

            # Add to tier lists for later summary (only if licensed)
            if ($isLicensed) {
                if ($metadata) {
                    switch ($metadata.Tier) {
                        1 { $tier1Tables += $table }
                        2 { $tier2Tables += $table }
                        3 { $tier3Tables += $table }
                    }
                } else {
                    $tier2Tables += $table
                }
            }
        }
    }

    # -------------------------------------------------------------------------
    # SECTION 3: Quick Reference by Tier (for licensed products)
    # -------------------------------------------------------------------------
    Write-Host "`n  $('-'*76)" -ForegroundColor DarkGray
    Write-Host "  QUICK REFERENCE - LICENSED TABLES BY TIER" -ForegroundColor Cyan
    Write-Host "  $('-'*76)" -ForegroundColor DarkGray

    Write-Host "`n  Based on your current licenses, here's a quick reference:" -ForegroundColor Gray

    # Tier 1: Essential
    Write-Host "`n  TIER 1 - ESSENTIAL (Start here):" -ForegroundColor Green
    if ($tier1Tables.Count -gt 0) {
        Write-Host "    $($tier1Tables -join ', ')" -ForegroundColor White
    } else {
        Write-Host "    (None - requires MDE or XDR license)" -ForegroundColor DarkGray
    }

    # Tier 2: Recommended
    Write-Host "`n  TIER 2 - RECOMMENDED (Add next):" -ForegroundColor Yellow
    if ($tier2Tables.Count -gt 0) {
        Write-Host "    $($tier2Tables -join ', ')" -ForegroundColor White
    } else {
        Write-Host "    (None currently licensed)" -ForegroundColor DarkGray
    }

    # Tier 3: Situational
    Write-Host "`n  TIER 3 - SITUATIONAL (High volume - evaluate carefully):" -ForegroundColor DarkYellow
    if ($tier3Tables.Count -gt 0) {
        Write-Host "    $($tier3Tables -join ', ')" -ForegroundColor White
    } else {
        Write-Host "    (None currently licensed)" -ForegroundColor DarkGray
    }

    # -------------------------------------------------------------------------
    # SECTION 4: Phased Implementation
    # -------------------------------------------------------------------------
    Write-Host "`n  $('-'*76)" -ForegroundColor DarkGray
    Write-Host "  RECOMMENDED IMPLEMENTATION PHASES" -ForegroundColor Cyan
    Write-Host "  $('-'*76)" -ForegroundColor DarkGray

    $phase1 = @($tier1Tables | Sort-Object -Unique)
    $phase2 = @($tier2Tables | Where-Object { $_ -in @("DeviceNetworkEvents", "DeviceFileEvents", "EmailEvents") } | Sort-Object -Unique)
    $phase3 = @($tier2Tables | Where-Object { $_ -notin $phase2 } | Sort-Object -Unique)

    Write-Host "`n  Phase 1 (Start Here):" -ForegroundColor Green
    if ($phase1.Count -gt 0) {
        Write-Host "    $($phase1 -join ', ')" -ForegroundColor White
    } else {
        Write-Host "    (No Tier 1 tables available - check licenses)" -ForegroundColor Yellow
    }

    Write-Host "`n  Phase 2 (After validating Phase 1):" -ForegroundColor Yellow
    if ($phase2.Count -gt 0) {
        Write-Host "    Add: $($phase2 -join ', ')" -ForegroundColor White
    }

    Write-Host "`n  Phase 3 (Expand coverage):" -ForegroundColor Yellow
    if ($phase3.Count -gt 0) {
        Write-Host "    Add: $($phase3 -join ', ')" -ForegroundColor White
    }

    Write-Host "`n  Phase 4 (Evaluate based on detection needs):" -ForegroundColor DarkGray
    if ($tier3Tables.Count -gt 0) {
        Write-Host "    Consider: $($tier3Tables -join ', ')" -ForegroundColor DarkGray
    }

    # -------------------------------------------------------------------------
    # SECTION 5: Volume Warnings
    # -------------------------------------------------------------------------
    $highVolumeTables = @($tier1Tables + $tier2Tables + $tier3Tables | Where-Object {
        $meta = $XDRTableMetadata[$_]
        $meta -and $meta.Warning
    })

    if ($highVolumeTables.Count -gt 0) {
        Write-Host "`n  $('-'*76)" -ForegroundColor DarkGray
        Write-Host "  VOLUME WARNINGS" -ForegroundColor Red
        Write-Host "  $('-'*76)" -ForegroundColor DarkGray

        foreach ($table in $highVolumeTables) {
            $metadata = $XDRTableMetadata[$table]
            Write-Host "`n  $table" -ForegroundColor Yellow
            Write-Host "    $($metadata.Warning)" -ForegroundColor Red
            Write-Host "    Estimated: $($metadata.VolumeEstimate)" -ForegroundColor Gray
        }
    }

    # -------------------------------------------------------------------------
    # SECTION 6: Tables Not Supported
    # -------------------------------------------------------------------------
    Write-Host "`n  $('-'*76)" -ForegroundColor DarkGray
    Write-Host "  TABLES NOT AVAILABLE IN STREAMING API" -ForegroundColor DarkGray
    Write-Host "  $('-'*76)" -ForegroundColor DarkGray

    foreach ($table in $XDRTablesNotSupported.Keys) {
        Write-Host "    $table - $($XDRTablesNotSupported[$table])" -ForegroundColor DarkGray
    }

    # -------------------------------------------------------------------------
    # SECTION 4: Step-by-Step Portal Instructions
    # -------------------------------------------------------------------------
    Write-Host "`n  $('-'*76)" -ForegroundColor DarkGray
    Write-Host "  PORTAL CONFIGURATION STEPS" -ForegroundColor Cyan
    Write-Host "  $('-'*76)" -ForegroundColor DarkGray

    Write-Host "`n  Step 1: Open the Microsoft Defender portal" -ForegroundColor White
    Write-Host "          https://security.microsoft.com/settings/mtp_settings/raw_data_export" -ForegroundColor Cyan

    Write-Host "`n  Step 2: Click 'Add' to create a new streaming configuration" -ForegroundColor White

    Write-Host "`n  Step 3: Configure the Event Hub destination" -ForegroundColor White
    Write-Host "          - Name: Cribl-XDR-Streaming" -ForegroundColor Gray
    Write-Host "          - Destination: 'Forward events to Azure Event Hub'" -ForegroundColor Gray
    Write-Host "          - Event Hub Namespace Resource ID:" -ForegroundColor Gray
    Write-Host "            $($NamespaceInfo.ResourceId)" -ForegroundColor Green
    Write-Host "          - Event Hub Name: (leave blank)" -ForegroundColor Gray

    Write-Host "`n  Step 4: Select event types using the checklist above" -ForegroundColor White
    Write-Host "          - Select ONLY the green [X] tables listed above" -ForegroundColor Green
    Write-Host "          - Skip the gray [ ] tables (no license or not active)" -ForegroundColor DarkGray

    Write-Host "`n  Step 5: Click 'Save'" -ForegroundColor White

    # -------------------------------------------------------------------------
    # SECTION 5: Expected Results
    # -------------------------------------------------------------------------
    Write-Host "`n  $('-'*76)" -ForegroundColor DarkGray
    Write-Host "  EXPECTED RESULTS" -ForegroundColor Cyan
    Write-Host "  $('-'*76)" -ForegroundColor DarkGray

    # Combine all recommended tables for selection
    $tablesToSelect = @($tier1Tables + $tier2Tables + $tier3Tables | Sort-Object -Unique)

    Write-Host "`n  After saving, Azure will automatically create Event Hubs for each table:" -ForegroundColor Gray
    if ($tablesToSelect.Count -gt 0) {
        foreach ($table in ($tablesToSelect | Sort-Object -Unique)) {
            Write-Host "    - $table" -ForegroundColor White
        }
        Write-Host "`n  Data should begin flowing within 5-10 minutes of configuration." -ForegroundColor Gray
    }
    else {
        Write-Host "    (No tables selected - configure licenses first)" -ForegroundColor Yellow
    }

    Write-Host "`n$('='*80)" -ForegroundColor Magenta
}

function Export-CriblConfiguration {
    <#
    .SYNOPSIS
        Exports Cribl Stream configuration for the XDR Event Hub.
    #>
    param(
        [hashtable]$NamespaceInfo,
        [hashtable]$ProductStatus
    )

    Write-Host "`n$('='*80)" -ForegroundColor Blue
    Write-Host "  CRIBL STREAM CONFIGURATION EXPORT" -ForegroundColor Blue
    Write-Host "$('='*80)" -ForegroundColor Blue

    # Build list of expected Event Hubs
    $expectedEventHubs = @()
    foreach ($productKey in $ProductStatus.Keys) {
        $product = $ProductStatus[$productKey]
        if ($product.IsLicensed -and ($product.IsActive -eq $true -or $product.IsActive -eq $null)) {
            foreach ($table in $product.StreamingTables) {
                $expectedEventHubs += $table
            }
        }
    }

    $criblConfig = @{
        exportDate = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
        exportType = "DefenderXDRStreaming"
        description = "Microsoft Defender XDR Streaming API to Event Hub for Cribl Stream"
        namespace = @{
            name = $NamespaceInfo.NamespaceName
            endpoint = $NamespaceInfo.Endpoint
            resourceId = $NamespaceInfo.ResourceId
            connectionString = $NamespaceInfo.ConnectionString
        }
        criblSource = @{
            type = "azure_event_hub"
            brokers = "$($NamespaceInfo.Endpoint):9093"
            groupId = "cribl-xdr-consumer"
            authType = "sasl"
            saslMechanism = "PLAIN"
            saslUsername = "`$ConnectionString"
            saslPassword = "(use Primary Connection String from Azure Portal)"
            tls = @{
                enabled = $true
            }
            topics = $expectedEventHubs
            topicPattern = "*"
            consumerGroup = "`$Default"
        }
        expectedEventHubs = $expectedEventHubs
        defenderProducts = @{}
    }

    # Add product status
    foreach ($productKey in $ProductStatus.Keys) {
        $product = $ProductStatus[$productKey]
        $criblConfig.defenderProducts[$productKey] = @{
            displayName = $product.DisplayName
            isLicensed = $product.IsLicensed
            isActive = $product.IsActive
            tables = $product.StreamingTables
        }
    }

    # Export to file
    $configDir = Join-Path $ScriptPath "cribl-configs"
    if (-not (Test-Path $configDir)) {
        New-Item -ItemType Directory -Path $configDir -Force | Out-Null
    }

    $configFile = Join-Path $configDir "xdr-streaming-config.json"
    $criblConfig | ConvertTo-Json -Depth 10 | Set-Content -Path $configFile -Encoding UTF8

    Write-Success "Configuration exported to:"
    Write-SubStep $configFile "White"

    Write-Host "`n  Cribl Stream Source Configuration:" -ForegroundColor Cyan
    Write-Host "  $('-'*60)" -ForegroundColor DarkGray
    Write-Host "  Type:              Azure Event Hub" -ForegroundColor White
    Write-Host "  Brokers:           $($NamespaceInfo.Endpoint):9093" -ForegroundColor White
    Write-Host "  Group ID:          cribl-xdr-consumer" -ForegroundColor White
    Write-Host "  Auth Type:         SASL PLAIN" -ForegroundColor White
    Write-Host "  Username:          `$ConnectionString" -ForegroundColor White
    Write-Host "  Password:          (Primary Connection String)" -ForegroundColor White
    Write-Host "  TLS:               Enabled" -ForegroundColor White
    Write-Host "  Consumer Group:    `$Default" -ForegroundColor White
    Write-Host "  Topics:            * (all)" -ForegroundColor White

    if ($NamespaceInfo.ConnectionString) {
        Write-Host "`n  Connection String (for Cribl):" -ForegroundColor Cyan
        Write-Host "  $($NamespaceInfo.ConnectionString.Substring(0, 80))..." -ForegroundColor DarkGray
    }

    Write-Host "`n$('='*80)" -ForegroundColor Blue

    return $configFile
}

function Show-Summary {
    <#
    .SYNOPSIS
        Shows a summary of what was configured and next steps.
    #>
    param(
        [hashtable]$ProductStatus,
        [hashtable]$NamespaceInfo
    )

    Write-Host "`n$('='*80)" -ForegroundColor Green
    Write-Host "  DEFENDER XDR STREAMING SETUP SUMMARY" -ForegroundColor Green
    Write-Host "$('='*80)" -ForegroundColor Green

    # Product summary
    Write-Host "`n  DEFENDER PRODUCTS STATUS:" -ForegroundColor Cyan

    $licensedCount = 0
    $activeCount = 0
    $notConfiguredReasons = @()

    foreach ($productKey in $ProductStatus.Keys) {
        $product = $ProductStatus[$productKey]

        $statusIcon = if ($product.IsLicensed -and $product.IsActive) { "[OK]" }
                     elseif ($product.IsLicensed) { "[!]" }
                     else { "[X]" }

        $statusColor = if ($product.IsLicensed -and $product.IsActive) { "Green" }
                      elseif ($product.IsLicensed) { "Yellow" }
                      else { "Red" }

        Write-Host "    $statusIcon $($product.DisplayName)" -ForegroundColor $statusColor

        if ($product.IsLicensed) { $licensedCount++ }
        if ($product.IsActive) { $activeCount++ }

        if (-not $product.IsLicensed -and $product.ConfigurationRecommendation) {
            $notConfiguredReasons += "    - $($product.ShortName): $($product.ConfigurationRecommendation)"
        }
    }

    Write-Host "`n  Summary: $licensedCount licensed, $activeCount active" -ForegroundColor White

    if ($notConfiguredReasons.Count -gt 0) {
        Write-Host "`n  PRODUCTS NOT CONFIGURED (logs will not be collected):" -ForegroundColor Yellow
        foreach ($reason in $notConfiguredReasons) {
            Write-Host $reason -ForegroundColor Yellow
        }
    }

    # Infrastructure summary
    if ($NamespaceInfo) {
        Write-Host "`n  EVENT HUB INFRASTRUCTURE:" -ForegroundColor Cyan
        Write-Host "    Namespace: $($NamespaceInfo.NamespaceName)" -ForegroundColor Green
        Write-Host "    Resource ID ready for portal configuration" -ForegroundColor Green
        Write-Host "    Cribl configuration exported" -ForegroundColor Green
    }

    # Next steps
    Write-Host "`n  NEXT STEPS:" -ForegroundColor Cyan
    Write-Host "    1. Open: https://security.microsoft.com/settings/mtp_settings/raw_data_export" -ForegroundColor White
    Write-Host "    2. Configure streaming with the Resource ID shown above" -ForegroundColor White
    Write-Host "    3. Create Cribl Stream Event Hub source with exported config" -ForegroundColor White
    Write-Host "    4. Verify data flow in Cribl Live Data view" -ForegroundColor White

    Write-Host "`n$('='*80)" -ForegroundColor Green
}

#endregion

#region Main Execution

Write-Host "`n$('='*80)" -ForegroundColor Cyan
Write-Host "  MICROSOFT DEFENDER XDR STREAMING API SETUP" -ForegroundColor Cyan
Write-Host "  Stream Defender telemetry to Event Hub for Cribl Stream" -ForegroundColor Gray
Write-Host "$('='*80)" -ForegroundColor Cyan

# Validate Azure connection
$context = Get-AzContext
if (-not $context) {
    Write-ErrorMsg "Not connected to Azure. Please run Connect-AzAccount first."
    exit 1
}

Write-Success "Connected to Azure"
Write-SubStep "Account: $($context.Account.Id)" "Gray"
Write-SubStep "Tenant:  $($context.Tenant.Id)" "Gray"

# Step 1: Validate Defender products
$productStatus = $null
if (-not $SkipValidation -and -not $CreateNamespaceOnly) {
    $productStatus = Get-DefenderProductStatus

    # Check if any products are licensed
    $anyLicensed = $productStatus.Values | Where-Object { $_.IsLicensed -eq $true }

    if (-not $anyLicensed) {
        Write-Host "`n$('='*80)" -ForegroundColor Red
        Write-Host "  WARNING: No Defender XDR products appear to be licensed!" -ForegroundColor Red
        Write-Host "$('='*80)" -ForegroundColor Red
        Write-Host "`n  The XDR Streaming API requires at least one of these products:" -ForegroundColor Yellow
        Write-Host "    - Microsoft Defender for Endpoint (P1 or P2)" -ForegroundColor Gray
        Write-Host "    - Microsoft Defender for Identity" -ForegroundColor Gray
        Write-Host "    - Microsoft Defender for Office 365 (P1 or P2)" -ForegroundColor Gray
        Write-Host "    - Microsoft Defender for Cloud Apps" -ForegroundColor Gray
        Write-Host "    - Microsoft 365 E5 / E5 Security" -ForegroundColor Gray
        Write-Host "`n  Without these licenses, streaming will produce no data." -ForegroundColor Yellow

        if (-not $ValidateOnly) {
            $continue = Read-Host "`n  Continue anyway? (y/N)"
            if ($continue -ne 'y' -and $continue -ne 'Y') {
                Write-Host "`n  Setup cancelled." -ForegroundColor Gray
                exit 0
            }
        }
    }
}

if ($ValidateOnly) {
    Write-Host "`n  Validation complete. Use -CreateNamespaceOnly or run without switches to continue setup." -ForegroundColor Cyan
    exit 0
}

# Step 2: Create Event Hub namespace
$namespaceInfo = New-XDREventHubNamespace

if (-not $namespaceInfo) {
    Write-ErrorMsg "Failed to create/configure Event Hub namespace. Setup incomplete."
    exit 1
}

if ($CreateNamespaceOnly) {
    Write-Host "`n  Namespace created. Resource ID:" -ForegroundColor Cyan
    Write-Host "  $($namespaceInfo.ResourceId)" -ForegroundColor Green
    exit 0
}

# Step 3: Show portal configuration instructions
if ($productStatus) {
    Show-PortalConfiguration -NamespaceInfo $namespaceInfo -ProductStatus $productStatus
}
else {
    # Minimal guidance without product status
    Write-Host "`n  Event Hub Resource ID (for Defender portal):" -ForegroundColor Cyan
    Write-Host "  $($namespaceInfo.ResourceId)" -ForegroundColor Green
    Write-Host "`n  Portal URL: https://security.microsoft.com/settings/mtp_settings/raw_data_export" -ForegroundColor Cyan
}

# Step 4: Export Cribl configuration
if ($productStatus) {
    $configFile = Export-CriblConfiguration -NamespaceInfo $namespaceInfo -ProductStatus $productStatus
}

# Step 5: Show summary
if ($productStatus) {
    Show-Summary -ProductStatus $productStatus -NamespaceInfo $namespaceInfo
}

# Offer to open portal
Write-Host "`n  Would you like to open the Defender portal now? (Y/n): " -ForegroundColor Cyan -NoNewline
$openPortal = Read-Host

if ($openPortal -ne 'n' -and $openPortal -ne 'N') {
    Start-Process "https://security.microsoft.com/settings/mtp_settings/raw_data_export"
    Write-Host "  Opening Defender portal..." -ForegroundColor Green
}

Write-Host "`n  Setup complete!" -ForegroundColor Green

#endregion
