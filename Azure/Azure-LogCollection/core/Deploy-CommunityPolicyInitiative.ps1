<#
.SYNOPSIS
    Deploys a custom Azure Policy Initiative bundling all Community Policy diagnostic settings to Event Hub.

.DESCRIPTION
    This script creates a unified Azure Policy Initiative that combines 44 community policy definitions
    for streaming diagnostic settings to Event Hub. Instead of managing individual policy assignments,
    this provides a single initiative assignment that covers all supported Azure resource types.

    NOTE: AKS and PostgreSQLFlexible are excluded because their community policies use Array type
    for resourceLocation which is incompatible with Azure Policy's expression evaluation.
    AKS is covered by the built-in initiative. PostgreSQLFlexible requires manual configuration.

    The script:
    1. Imports community policy definitions from GitHub as custom policies
    2. Creates a policy initiative (policy set definition) grouping all policies
    3. Assigns the initiative at the management group scope
    4. Optionally triggers remediation for existing non-compliant resources

.PARAMETER DeploymentMode
    Deployment topology: Centralized (single Event Hub) or MultiRegion (regional Event Hubs).
    Default: Centralized

.PARAMETER ValidateOnly
    Validates configuration and shows what would be deployed without making changes.

.PARAMETER ShowStatus
    Displays current initiative and policy status without making changes.

.PARAMETER RemoveInitiative
    Removes the initiative assignment, initiative definition, and optionally custom policy definitions.

.PARAMETER Remediate
    Creates remediation tasks after deployment to apply policies to existing resources.

.PARAMETER PolicyTiers
    Selective deployment by tier: Storage, Security, Data, Compute, Integration, Networking, AVD, Other, All.
    Default: All

.PARAMETER SpecificServices
    Deploy only specific services (e.g., "Firewall", "CosmosDB", "BlobServices").

.PARAMETER DebugLogging
    Enable verbose debug logging.

.EXAMPLE
    .\Deploy-CommunityPolicyInitiative.ps1
    Deploys all community policies as a single initiative in Centralized mode.

.EXAMPLE
    .\Deploy-CommunityPolicyInitiative.ps1 -PolicyTiers Storage,Security -Remediate
    Deploys only Storage and Security tier policies with immediate remediation.

.EXAMPLE
    .\Deploy-CommunityPolicyInitiative.ps1 -DeploymentMode MultiRegion
    Deploys initiative with regional Event Hub routing.

.EXAMPLE
    .\Deploy-CommunityPolicyInitiative.ps1 -RemoveInitiative
    Removes the initiative and its assignment.

.NOTES
    Requires: Az.Accounts, Az.Resources, Az.ManagedServiceIdentity, Az.EventHub modules
    Activity Log is NOT included (subscription-level) - use Deploy-SupplementalPolicies.ps1 for Activity Log.
#>

[CmdletBinding(DefaultParameterSetName = 'Deploy')]
param(
    [Parameter(ParameterSetName = 'Deploy')]
    [Parameter(ParameterSetName = 'Validate')]
    [Parameter(ParameterSetName = 'Remove')]
    [ValidateSet("Centralized", "MultiRegion")]
    [string]$DeploymentMode = "Centralized",

    [Parameter(ParameterSetName = 'Validate')]
    [switch]$ValidateOnly,

    [Parameter(ParameterSetName = 'Status')]
    [switch]$ShowStatus,

    [Parameter(ParameterSetName = 'Remove')]
    [switch]$RemoveInitiative,

    [Parameter(ParameterSetName = 'Deploy')]
    [switch]$Remediate,

    [Parameter(ParameterSetName = 'Deploy')]
    [Parameter(ParameterSetName = 'Validate')]
    [ValidateSet("Storage", "Security", "Data", "Compute", "Integration", "Networking", "AVD", "Other", "All")]
    [string[]]$PolicyTiers = @("All"),

    [Parameter(ParameterSetName = 'Deploy')]
    [Parameter(ParameterSetName = 'Validate')]
    [string[]]$SpecificServices,

    [Parameter(ParameterSetName = 'Remove')]
    [switch]$RemovePolicyDefinitions,

    [switch]$DebugLogging
)

#region Script Setup
$ErrorActionPreference = "Stop"
$ScriptPath = Split-Path -Parent $MyInvocation.MyCommand.Path

# Import helper functions
$outputHelperPath = Join-Path $ScriptPath "Output-Helper.ps1"
if (Test-Path $outputHelperPath) {
    . $outputHelperPath
}
else {
    # Minimal fallback functions if Output-Helper.ps1 not found
    function Write-Step { param($msg) Write-Host "`n>> $msg" -ForegroundColor Cyan }
    function Write-SubStep { param($msg, $color) Write-Host "   $msg" -ForegroundColor $(if ($color) { $color } else { "Gray" }) }
    function Write-Success { param($msg) Write-Host "[OK] $msg" -ForegroundColor Green }
    function Write-ErrorMsg { param($msg) Write-Host "[ERROR] $msg" -ForegroundColor Red }
    function Write-WarningMsg { param($msg) Write-Host "[WARN] $msg" -ForegroundColor Yellow }
}
#endregion

#region Configuration
# Load azure-parameters.json
$azureParamsFile = Join-Path $ScriptPath "azure-parameters.json"
if (-not (Test-Path $azureParamsFile)) {
    Write-ErrorMsg "Configuration file not found: $azureParamsFile"
    exit 1
}
$azureParams = Get-Content $azureParamsFile -Raw | ConvertFrom-Json

# Initiative naming
$script:InitiativeName = "Cribl-DiagSettings-EventHub"
$script:InitiativeDisplayName = "Cribl Community Diagnostic Settings to Event Hub"
$script:InitiativeDescription = "Comprehensive diagnostic settings deployment for Azure resources to stream logs to Event Hub for Cribl Stream ingestion. Covers 44 resource types from Azure Community Policy repository."

# Policy definition prefix
$script:PolicyDefPrefix = "Cribl"
$script:PolicyDefSuffix = "DiagSettings-EH"
#endregion

#region Community Policy Data
# GitHub base URL for Community Policy repo
$script:CommunityPolicyBaseUrl = "https://raw.githubusercontent.com/Azure/Community-Policy/main/policyDefinitions/Monitoring"

# Policy paths mapped to their GitHub folder names (excluding Activity Log - subscription level)
# NOTE: AKS and PostgreSQLFlexible are EXCLUDED because they use Array type for resourceLocation
#       which is incompatible with Azure Policy's expression evaluation engine.
#       AKS is covered by the built-in initiative. PostgreSQLFlexible requires manual diagnostic settings.
$script:CommunityPolicyPaths = @{
    # ========== TIER 1: Storage Services ==========
    "BlobServices"              = "To Event Hub/Configure diagnostic settings for Blob Services to Event Hub"
    "FileServices"              = "To Event Hub/Configure diagnostic settings for File Services to Event Hub"
    "QueueServices"             = "To Event Hub/Configure diagnostic settings for Queue Services to Event Hub"
    "TableServices"             = "To Event Hub/Configure diagnostic settings for Table Services to Event Hub"
    "StorageAccounts"           = "To Event Hub/Configure diagnostic settings for Storage Accounts to Event Hub"

    # ========== TIER 2: Security-Critical Services ==========
    # NOTE: AKS excluded - uses Array type for resourceLocation (incompatible), covered by built-in initiative
    "Firewall"                  = "To Event Hub/Deploy Diagnostic Settings for Firewall to Event Hub"
    "NSG"                       = "To Event Hub/Deploy Diagnostic Settings for Network Security Groups to Event Hub"
    "ApplicationGateway"        = "To Event Hub/Deploy Diagnostic Settings for Application Gateway to Event Hub"
    "ExpressRoute"              = "To Event Hub/Deploy Diagnostic Settings for ExpressRoute to Event Hub"
    "VirtualNetwork"            = "To Event Hub/Deploy Diagnostic Settings for Virtual Network to Event Hub"

    # ========== TIER 3: Data Services ==========
    "CosmosDB"                  = "To Event Hub/Deploy Diagnostic Settings for Cosmos DB to Event Hub"
    "DataFactory"               = "To Event Hub/Deploy Diagnostic Settings for Data Factory to Event Hub"
    "MySQL"                     = "To Event Hub/Deploy Diagnostic Settings for Database for MySQL to Event Hub"
    "PostgreSQL"                = "To Event Hub/Deploy Diagnostic Settings for Database for PostgreSQL to Event Hub"
    # NOTE: PostgreSQLFlexible excluded - uses Array type for resourceLocation (incompatible)
    "MariaDB"                   = "To Event Hub/Deploy Diagnostic Settings for MariaDB to Event Hub"
    "SynapseAnalytics"          = "To Event Hub/Deploy Diagnostic Settings for Synapse Analytics to Event Hub"
    "SynapseSparkPool"          = "To Event Hub/Deploy Diagnostic Settings for Synapse Spark Pool to Event Hub"
    "SynapseSQLPool"            = "To Event Hub/Deploy Diagnostic Settings for SQL Pools under Synapse Analytics to Event Hub"
    "DataExplorer"              = "To Event Hub/Deploy Diagnostic Settings for Azure Data Explorer Cluster to Event Hub"
    "Databricks"                = "To Event Hub/Deploy Diagnostic Settings for Databricks to Event Hub"
    "AnalysisServices"          = "To Event Hub/Deploy Diagnostic Settings for Analysis Services to Event Hub"
    "TimeSeriesInsights"        = "To Event Hub/Deploy Diagnostic Settings for Time Series Insights to Event Hub"

    # ========== TIER 4: Compute & Application Services ==========
    "AppService"                = "To Event Hub/Deploy Diagnostic Settings for App Service to Event Hub"
    "FunctionApp"               = "To Event Hub/Deploy Diagnostic Settings for Azure Function App to Event Hub"
    "BatchAccount"              = "To Event Hub/Deploy Diagnostic Settings for Batch Account to Event Hub"
    "MachineLearning"           = "To Event Hub/Deploy Diagnostic Settings for Machine Learning workspace to Event Hub"
    "ApplicationInsights"       = "To Event Hub/Deploy Diagnostic Settings for Application Insights to Event Hub"
    "AutoscaleSettings"         = "To Event Hub/Deploy Diagnostic Settings for Autoscale Settings to Event Hub"
    "DevCenter"                 = "To Event Hub/Deploy Diagnostic Settings for Dev Center to Event Hub"

    # ========== TIER 5: Integration & Messaging ==========
    "LogicApps"                 = "To Event Hub/Deploy Diagnostic Settings for Logic Apps to Event Hub"
    "LogicAppsISE"              = "To Event Hub/Deploy Diagnostic Settings for Logic Apps ISE to Event Hub"
    "EventGridTopic"            = "To Event Hub/Deploy Diagnostic Settings for Event Grid Topic to Event Hub"
    "EventGridSystemTopic"      = "To Event Hub/Deploy Diagnostic Settings for Event Grid System Topic to Event Hub"
    "Relay"                     = "To Event Hub/Deploy Diagnostic Settings for Relay to Event Hub"

    # ========== TIER 6: Networking & CDN ==========
    "LoadBalancer"              = "To Event Hub/Deploy Diagnostic Settings for Load Balancer to Event Hub"
    "TrafficManager"            = "To Event Hub/Deploy Diagnostic Settings for Traffic Manager to Event Hub"
    "CDNEndpoint"               = "To Event Hub/Deploy Diagnostic Settings for CDN Endpoint to Event Hub"

    # ========== TIER 7: Azure Virtual Desktop (AVD) ==========
    "AVDHostPool"               = "To Event Hub/Deploy Diagnostic Settings for AVD Host Pool to Event Hub"
    "AVDApplicationGroup"       = "To Event Hub/Deploy Diagnostic Settings for AVD Application Group to Event Hub"
    "AVDWorkspace"              = "To Event Hub/Deploy Diagnostic Settings for AVD Workspace to Event Hub"
    "AVDScalingPlan"            = "To Event Hub/Deploy Diagnostic Settings for AVD Scaling Plan to Event Hub"

    # ========== TIER 8: Backup & Healthcare ==========
    "RecoveryServicesVault"     = "To Event Hub/Deploy Diagnostic Settings for Recovery Services vault to Event Hub"
    "AzureAPIforFHIR"           = "To Event Hub/Deploy Diagnostic Settings for Azure API for FHIR to Event Hub"
    "PowerBIEmbedded"           = "To Event Hub/Deploy Diagnostic Settings for Power BI Embedded to Event Hub"
}

# Organized policy tiers for selective deployment
$script:CommunityPolicyTiers = @{
    "Storage" = @{
        Description = "Storage Account Services (Blob, File, Queue, Table)"
        Services = @("BlobServices", "FileServices", "QueueServices", "TableServices", "StorageAccounts")
        Priority = 1
    }
    "Security" = @{
        Description = "Security-Critical Network Services"
        Services = @("Firewall", "NSG", "ApplicationGateway", "ExpressRoute", "VirtualNetwork")
        Priority = 2
    }
    "Data" = @{
        Description = "Database and Analytics Services"
        Services = @("CosmosDB", "DataFactory", "MySQL", "PostgreSQL", "MariaDB",
                     "SynapseAnalytics", "SynapseSparkPool", "SynapseSQLPool", "DataExplorer", "Databricks",
                     "AnalysisServices", "TimeSeriesInsights")
        Priority = 3
    }
    "Compute" = @{
        Description = "Compute and Application Services"
        Services = @("AppService", "FunctionApp", "BatchAccount", "MachineLearning", "ApplicationInsights",
                     "AutoscaleSettings", "DevCenter")
        Priority = 4
    }
    "Integration" = @{
        Description = "Integration and Messaging Services"
        Services = @("LogicApps", "LogicAppsISE", "EventGridTopic", "EventGridSystemTopic", "Relay")
        Priority = 5
    }
    "Networking" = @{
        Description = "Networking and CDN Services"
        Services = @("LoadBalancer", "TrafficManager", "CDNEndpoint")
        Priority = 6
    }
    "AVD" = @{
        Description = "Azure Virtual Desktop Components"
        Services = @("AVDHostPool", "AVDApplicationGroup", "AVDWorkspace", "AVDScalingPlan")
        Priority = 7
    }
    "Other" = @{
        Description = "Backup, Healthcare, and Other Services"
        Services = @("RecoveryServicesVault", "AzureAPIforFHIR", "PowerBIEmbedded")
        Priority = 8
    }
}

# Service metadata for policy creation
$script:CommunityPolicyMetadata = @{
    # Storage Services
    "BlobServices"              = @{ ResourceType = "Microsoft.Storage/storageAccounts/blobServices"; DisplayName = "Blob Services" }
    "FileServices"              = @{ ResourceType = "Microsoft.Storage/storageAccounts/fileServices"; DisplayName = "File Services" }
    "QueueServices"             = @{ ResourceType = "Microsoft.Storage/storageAccounts/queueServices"; DisplayName = "Queue Services" }
    "TableServices"             = @{ ResourceType = "Microsoft.Storage/storageAccounts/tableServices"; DisplayName = "Table Services" }
    "StorageAccounts"           = @{ ResourceType = "Microsoft.Storage/storageAccounts"; DisplayName = "Storage Accounts" }

    # Security Services (AKS excluded - covered by built-in initiative)
    "Firewall"                  = @{ ResourceType = "Microsoft.Network/azureFirewalls"; DisplayName = "Azure Firewall" }
    "NSG"                       = @{ ResourceType = "Microsoft.Network/networkSecurityGroups"; DisplayName = "Network Security Groups" }
    "ApplicationGateway"        = @{ ResourceType = "Microsoft.Network/applicationGateways"; DisplayName = "Application Gateway" }
    "ExpressRoute"              = @{ ResourceType = "Microsoft.Network/expressRouteCircuits"; DisplayName = "ExpressRoute" }
    "VirtualNetwork"            = @{ ResourceType = "Microsoft.Network/virtualNetworks"; DisplayName = "Virtual Networks" }

    # Data Services
    "CosmosDB"                  = @{ ResourceType = "Microsoft.DocumentDB/databaseAccounts"; DisplayName = "Cosmos DB" }
    "DataFactory"               = @{ ResourceType = "Microsoft.DataFactory/factories"; DisplayName = "Data Factory" }
    "MySQL"                     = @{ ResourceType = "Microsoft.DBforMySQL/servers"; DisplayName = "MySQL" }
    "PostgreSQL"                = @{ ResourceType = "Microsoft.DBforPostgreSQL/servers"; DisplayName = "PostgreSQL" }
    # PostgreSQLFlexible excluded - community policy has incompatible Array parameter type
    "MariaDB"                   = @{ ResourceType = "Microsoft.DBforMariaDB/servers"; DisplayName = "MariaDB" }
    "SynapseAnalytics"          = @{ ResourceType = "Microsoft.Synapse/workspaces"; DisplayName = "Synapse Analytics" }
    "SynapseSparkPool"          = @{ ResourceType = "Microsoft.Synapse/workspaces/bigDataPools"; DisplayName = "Synapse Spark Pool" }
    "SynapseSQLPool"            = @{ ResourceType = "Microsoft.Synapse/workspaces/sqlPools"; DisplayName = "Synapse SQL Pool" }
    "DataExplorer"              = @{ ResourceType = "Microsoft.Kusto/clusters"; DisplayName = "Data Explorer" }
    "Databricks"                = @{ ResourceType = "Microsoft.Databricks/workspaces"; DisplayName = "Databricks" }
    "AnalysisServices"          = @{ ResourceType = "Microsoft.AnalysisServices/servers"; DisplayName = "Analysis Services" }
    "TimeSeriesInsights"        = @{ ResourceType = "Microsoft.TimeSeriesInsights/environments"; DisplayName = "Time Series Insights" }

    # Compute Services
    "AppService"                = @{ ResourceType = "Microsoft.Web/sites"; DisplayName = "App Service" }
    "FunctionApp"               = @{ ResourceType = "Microsoft.Web/sites"; DisplayName = "Function Apps" }
    "BatchAccount"              = @{ ResourceType = "Microsoft.Batch/batchAccounts"; DisplayName = "Batch Account" }
    "MachineLearning"           = @{ ResourceType = "Microsoft.MachineLearningServices/workspaces"; DisplayName = "Machine Learning" }
    "ApplicationInsights"       = @{ ResourceType = "Microsoft.Insights/components"; DisplayName = "Application Insights" }
    "AutoscaleSettings"         = @{ ResourceType = "Microsoft.Insights/autoscalesettings"; DisplayName = "Autoscale Settings" }
    "DevCenter"                 = @{ ResourceType = "Microsoft.DevCenter/devcenters"; DisplayName = "Dev Center" }

    # Integration Services
    "LogicApps"                 = @{ ResourceType = "Microsoft.Logic/workflows"; DisplayName = "Logic Apps" }
    "LogicAppsISE"              = @{ ResourceType = "Microsoft.Logic/integrationServiceEnvironments"; DisplayName = "Logic Apps ISE" }
    "EventGridTopic"            = @{ ResourceType = "Microsoft.EventGrid/topics"; DisplayName = "Event Grid Topics" }
    "EventGridSystemTopic"      = @{ ResourceType = "Microsoft.EventGrid/systemTopics"; DisplayName = "Event Grid System Topics" }
    "Relay"                     = @{ ResourceType = "Microsoft.Relay/namespaces"; DisplayName = "Relay" }

    # Networking Services
    "LoadBalancer"              = @{ ResourceType = "Microsoft.Network/loadBalancers"; DisplayName = "Load Balancer" }
    "TrafficManager"            = @{ ResourceType = "Microsoft.Network/trafficManagerProfiles"; DisplayName = "Traffic Manager" }
    "CDNEndpoint"               = @{ ResourceType = "Microsoft.Cdn/profiles/endpoints"; DisplayName = "CDN Endpoint" }

    # AVD Services
    "AVDHostPool"               = @{ ResourceType = "Microsoft.DesktopVirtualization/hostPools"; DisplayName = "AVD Host Pool" }
    "AVDApplicationGroup"       = @{ ResourceType = "Microsoft.DesktopVirtualization/applicationGroups"; DisplayName = "AVD Application Group" }
    "AVDWorkspace"              = @{ ResourceType = "Microsoft.DesktopVirtualization/workspaces"; DisplayName = "AVD Workspace" }
    "AVDScalingPlan"            = @{ ResourceType = "Microsoft.DesktopVirtualization/scalingPlans"; DisplayName = "AVD Scaling Plan" }

    # Other Services
    "RecoveryServicesVault"     = @{ ResourceType = "Microsoft.RecoveryServices/vaults"; DisplayName = "Recovery Services Vault" }
    "AzureAPIforFHIR"           = @{ ResourceType = "Microsoft.HealthcareApis/services"; DisplayName = "Azure API for FHIR" }
    "PowerBIEmbedded"           = @{ ResourceType = "Microsoft.PowerBIDedicated/capacities"; DisplayName = "Power BI Embedded" }
}
#endregion

#region Deployment Results Tracking
$script:DeploymentResults = @{
    PoliciesImported = @()
    PoliciesExisting = @()
    PoliciesFailed = @()
    InitiativeCreated = $false
    InitiativeUpdated = $false
    InitiativeExisted = $false
    AssignmentCreated = $false
    AssignmentExisted = $false
    AssignmentUpdated = $false
    RemediationCreated = $false
    RemediationFailed = $false
    RolesCreated = 0
    Errors = @()
}
#endregion

#region Helper Functions

function Get-SelectedServices {
    <#
    .SYNOPSIS
        Determines which services to deploy based on tier and service parameters.
    #>
    param()

    $services = @()

    if ($SpecificServices -and $SpecificServices.Count -gt 0) {
        # Use specific services if provided
        foreach ($svc in $SpecificServices) {
            if ($script:CommunityPolicyPaths.ContainsKey($svc)) {
                $services += $svc
            }
            else {
                Write-WarningMsg "Unknown service: $svc (skipping)"
            }
        }
    }
    elseif ($PolicyTiers -contains "All") {
        # All services
        $services = $script:CommunityPolicyPaths.Keys | Sort-Object
    }
    else {
        # Selected tiers
        foreach ($tier in $PolicyTiers) {
            if ($script:CommunityPolicyTiers.ContainsKey($tier)) {
                $services += $script:CommunityPolicyTiers[$tier].Services
            }
        }
    }

    return $services | Select-Object -Unique
}

function Get-PolicyDefinitionName {
    <#
    .SYNOPSIS
        Generates a consistent policy definition name for a service.
    #>
    param([string]$ServiceType)

    return "$($script:PolicyDefPrefix)-$ServiceType-$($script:PolicyDefSuffix)"
}

function Get-AssignmentName {
    <#
    .SYNOPSIS
        Generates initiative assignment name within 24-char limit.
    #>
    param(
        [string]$Region,
        [string]$DepMode
    )

    if ($DepMode -eq "Centralized") {
        return "Cribl-Diag-EH-Central"
    }
    else {
        # MultiRegion: Cribl-Diag-EH-{region} - max 24 chars
        $prefix = "Cribl-Diag-EH-"
        $maxRegionLen = 24 - $prefix.Length
        $truncatedRegion = if ($Region.Length -gt $maxRegionLen) {
            $Region.Substring(0, $maxRegionLen)
        }
        else {
            $Region
        }
        return "$prefix$truncatedRegion"
    }
}

function Connect-AzureIfNeeded {
    <#
    .SYNOPSIS
        Ensures Azure connection is established.
    #>
    Write-Step "Checking Azure Connection..."

    try {
        $context = Get-AzContext
        if (-not $context) {
            Write-SubStep "Not connected. Running Connect-AzAccount..." "Yellow"
            Connect-AzAccount -ErrorAction Stop
            $context = Get-AzContext
        }

        # Validate tenant if specified
        if ($azureParams.tenantId -and $context.Tenant.Id -ne $azureParams.tenantId) {
            Write-SubStep "Switching to configured tenant: $($azureParams.tenantId)" "Yellow"
            Connect-AzAccount -TenantId $azureParams.tenantId -ErrorAction Stop
            $context = Get-AzContext
        }

        Write-Success "Connected to Azure"
        Write-SubStep "Account:      $($context.Account.Id)" "Gray"
        Write-SubStep "Tenant:       $($context.Tenant.Id)" "Gray"
        Write-SubStep "Subscription: $($context.Subscription.Name)" "Gray"
        return $true
    }
    catch {
        Write-ErrorMsg "Failed to connect to Azure: $_"
        return $false
    }
}
#endregion

#region Managed Identity Functions

function Get-OrCreateManagedIdentity {
    <#
    .SYNOPSIS
        Creates or retrieves the shared user-assigned managed identity for policy assignments.
    #>
    Write-Step "Configuring Managed Identity..."

    $identityName = "cribl-diag-policy-identity"
    $resourceGroup = $azureParams.eventHubResourceGroup
    $location = $azureParams.centralizedRegion
    $subscriptionId = $azureParams.eventHubSubscriptionId

    # Set context to Event Hub subscription
    try {
        Set-AzContext -SubscriptionId $subscriptionId -ErrorAction Stop | Out-Null
    }
    catch {
        Write-ErrorMsg "Failed to set subscription context: $_"
        return $null
    }

    # Check if identity exists
    try {
        $identity = Get-AzUserAssignedIdentity -ResourceGroupName $resourceGroup -Name $identityName -ErrorAction SilentlyContinue
        if ($identity) {
            Write-Success "Using existing managed identity: $identityName"
            Write-SubStep "Resource ID: $($identity.Id)" "Gray"
            Write-SubStep "Principal ID: $($identity.PrincipalId)" "Gray"
            return $identity
        }
    }
    catch {
        # Identity doesn't exist, will create
    }

    # Create identity
    Write-SubStep "Creating managed identity: $identityName" "Yellow"
    try {
        $identity = New-AzUserAssignedIdentity `
            -ResourceGroupName $resourceGroup `
            -Name $identityName `
            -Location $location `
            -ErrorAction Stop

        Write-Success "Created managed identity: $identityName"
        Write-SubStep "Resource ID: $($identity.Id)" "Gray"
        Write-SubStep "Principal ID: $($identity.PrincipalId)" "Gray"

        # Wait for AD propagation
        Write-SubStep "Waiting 15 seconds for Azure AD propagation..." "Gray"
        Start-Sleep -Seconds 15

        return $identity
    }
    catch {
        Write-ErrorMsg "Failed to create managed identity: $_"
        return $null
    }
}

function Ensure-ManagedIdentityRoles {
    <#
    .SYNOPSIS
        Ensures the managed identity has required RBAC roles.
    #>
    param(
        [Parameter(Mandatory)]
        $ManagedIdentity
    )

    Write-Step "Configuring RBAC Roles..."

    $rolesCreated = 0
    $principalId = $ManagedIdentity.PrincipalId
    $mgScope = "/providers/Microsoft.Management/managementGroups/$($azureParams.managementGroupId)"

    # Role 1: Monitoring Contributor at management group scope
    $monitoringContributorId = "749f88d5-cbae-40b8-bcfc-e573ddc772fa"
    try {
        $existingRole = Get-AzRoleAssignment -ObjectId $principalId -Scope $mgScope -RoleDefinitionId $monitoringContributorId -ErrorAction SilentlyContinue
        if (-not $existingRole) {
            Write-SubStep "Assigning Monitoring Contributor role..." "Yellow"
            New-AzRoleAssignment `
                -ObjectId $principalId `
                -Scope $mgScope `
                -RoleDefinitionId $monitoringContributorId `
                -ErrorAction Stop | Out-Null
            $rolesCreated++
            Write-SubStep "Monitoring Contributor role assigned" "Green"
        }
        else {
            Write-SubStep "Monitoring Contributor role already assigned" "Gray"
        }
    }
    catch {
        if ($_.Exception.Message -notlike "*already exists*") {
            Write-WarningMsg "Failed to assign Monitoring Contributor: $_"
        }
    }

    # Role 2: Azure Event Hubs Data Owner at Event Hub namespace scope
    # Data Owner is required because DeployIfNotExists policies need listkeys permission
    $eventHubsOwnerId = "f526a384-b230-433a-b45c-95f59c4a2dec"
    $subscriptionId = $azureParams.eventHubSubscriptionId
    $resourceGroup = $azureParams.eventHubResourceGroup

    # Get Event Hub namespaces matching our prefix
    try {
        Set-AzContext -SubscriptionId $subscriptionId -ErrorAction Stop | Out-Null
        $namespaces = Get-AzEventHubNamespace -ResourceGroupName $resourceGroup -ErrorAction Stop |
            Where-Object { $_.Name -like "$($azureParams.eventHubNamespacePrefix)*" }

        foreach ($ns in $namespaces) {
            $nsScope = $ns.Id
            try {
                $existingRole = Get-AzRoleAssignment -ObjectId $principalId -Scope $nsScope -RoleDefinitionId $eventHubsOwnerId -ErrorAction SilentlyContinue
                if (-not $existingRole) {
                    Write-SubStep "Assigning Event Hubs Data Owner to $($ns.Name)..." "Yellow"
                    New-AzRoleAssignment `
                        -ObjectId $principalId `
                        -Scope $nsScope `
                        -RoleDefinitionId $eventHubsOwnerId `
                        -ErrorAction Stop | Out-Null
                    $rolesCreated++
                    Write-SubStep "Event Hubs Data Owner assigned to $($ns.Name)" "Green"
                }
                else {
                    Write-SubStep "Event Hubs Data Owner already assigned to $($ns.Name)" "Gray"
                }
            }
            catch {
                if ($_.Exception.Message -notlike "*already exists*") {
                    Write-WarningMsg "Failed to assign Event Hubs Data Owner to $($ns.Name): $_"
                }
            }
        }
    }
    catch {
        Write-WarningMsg "Failed to configure Event Hub roles: $_"
    }

    $script:DeploymentResults.RolesCreated = $rolesCreated
    if ($rolesCreated -gt 0) {
        Write-Success "Created $rolesCreated new role assignment(s)"
    }
    else {
        Write-Success "All required roles already assigned"
    }
}
#endregion

#region Policy Import Functions

function Import-CommunityPolicyDefinition {
    <#
    .SYNOPSIS
        Imports a community policy from GitHub as a custom policy definition.
    #>
    param(
        [Parameter(Mandatory)]
        [string]$ServiceType
    )

    $policyName = Get-PolicyDefinitionName -ServiceType $ServiceType
    $mgId = $azureParams.managementGroupId
    $policyPath = $script:CommunityPolicyPaths[$ServiceType]

    if (-not $policyPath) {
        Write-WarningMsg "No policy path defined for: $ServiceType"
        return $null
    }

    # Check if policy already exists
    try {
        $existing = Get-AzPolicyDefinition -Name $policyName -ManagementGroupName $mgId -ErrorAction SilentlyContinue
        if ($existing) {
            Write-SubStep "$ServiceType policy already exists" "Gray"
            $script:DeploymentResults.PoliciesExisting += $ServiceType
            # Return the full resource ID (property is 'Id', not 'PolicyDefinitionId')
            return $existing.Id
        }
    }
    catch {
        # Policy doesn't exist, continue with import
    }

    # Fetch policy from GitHub
    $encodedPath = [System.Uri]::EscapeUriString($policyPath)
    $url = "$($script:CommunityPolicyBaseUrl)/$encodedPath/azurepolicy.json"

    Write-SubStep "Fetching $ServiceType policy from GitHub..." "Yellow"

    try {
        $response = Invoke-RestMethod -Uri $url -ErrorAction Stop
        $policyJson = $response

        # Extract policy properties
        $policyRule = $policyJson.properties.policyRule
        $policyParams = $policyJson.properties.parameters
        $metadata = $policyJson.properties.metadata
        $mode = $policyJson.properties.mode

        # Modify location parameters to allow all regions (remove restrictive allowedValues)
        # Different policies use different parameter names: eventHubLocation, resourceLocation
        # And different types: String or Array
        $locationParamNames = @('eventHubLocation', 'resourceLocation')
        foreach ($locationParamName in $locationParamNames) {
            $locationParam = $policyParams.PSObject.Properties | Where-Object { $_.Name -eq $locationParamName }
            if ($locationParam) {
                $paramValue = $locationParam.Value

                # Remove allowedValues restriction if present
                if ($paramValue.PSObject.Properties | Where-Object { $_.Name -eq 'allowedValues' }) {
                    $paramValue.PSObject.Properties.Remove('allowedValues')
                }

                # Check parameter type and set appropriate default value
                $paramType = $paramValue.type
                if ($paramType -eq 'Array') {
                    # For array type, set empty array as default (matches all locations)
                    $paramValue.defaultValue = @()
                }
                else {
                    # For string type, set empty string as default
                    $paramValue.defaultValue = ""
                }

                # Update metadata description
                if (-not ($paramValue.PSObject.Properties | Where-Object { $_.Name -eq 'metadata' })) {
                    $paramValue | Add-Member -NotePropertyName "metadata" -NotePropertyValue @{} -Force
                }
                $paramValue.metadata.description = "Location filter. Empty value applies to all regions."
            }
        }

        # Create custom metadata
        $customMetadata = @{
            category = "Monitoring"
            version = if ($metadata.version) { $metadata.version } else { "1.0.0" }
            source = "Azure Community Policy"
            importedBy = "Cribl-DiagSettings-Initiative"
            importDate = (Get-Date).ToString("yyyy-MM-dd")
        }

        # Get display name from metadata or generate one
        $displayName = if ($script:CommunityPolicyMetadata[$ServiceType]) {
            "Cribl - $($script:CommunityPolicyMetadata[$ServiceType].DisplayName) Diagnostic Settings to Event Hub"
        }
        else {
            "Cribl - $ServiceType Diagnostic Settings to Event Hub"
        }

        # Create policy definition
        $newPolicy = New-AzPolicyDefinition `
            -Name $policyName `
            -DisplayName $displayName `
            -Description "Deploys diagnostic settings for $ServiceType to stream logs to Event Hub. Source: Azure Community Policy." `
            -Policy ($policyRule | ConvertTo-Json -Depth 50 -Compress) `
            -Parameter ($policyParams | ConvertTo-Json -Depth 20 -Compress) `
            -Mode $mode `
            -Metadata ($customMetadata | ConvertTo-Json -Depth 5 -Compress) `
            -ManagementGroupName $mgId `
            -ErrorAction Stop

        Write-SubStep "$ServiceType policy imported successfully" "Green"
        $script:DeploymentResults.PoliciesImported += $ServiceType
        # Return the full resource ID (property is 'Id', not 'PolicyDefinitionId')
        return $newPolicy.Id
    }
    catch {
        Write-WarningMsg "Failed to import $ServiceType policy: $_"
        $script:DeploymentResults.PoliciesFailed += $ServiceType
        $script:DeploymentResults.Errors += @{
            Operation = "Import policy: $ServiceType"
            Error = $_.Exception.Message
            Timestamp = Get-Date
        }
        return $null
    }
}

function Import-AllCommunityPolicies {
    <#
    .SYNOPSIS
        Imports all selected community policies.
    #>
    param(
        [Parameter(Mandatory)]
        [string[]]$Services
    )

    Write-Step "Importing Community Policy Definitions..."
    Write-SubStep "Target: $($Services.Count) services" "Gray"
    Write-SubStep "Management Group: $($azureParams.managementGroupId)" "Gray"

    $importedPolicies = @{}
    $totalCount = $Services.Count
    $currentCount = 0

    foreach ($service in $Services) {
        $currentCount++
        Write-Host "`r   [$currentCount/$totalCount] Processing $service..." -NoNewline

        $policyId = Import-CommunityPolicyDefinition -ServiceType $service
        if ($policyId) {
            $importedPolicies[$service] = $policyId
        }
    }

    Write-Host ""  # New line after progress
    Write-Success "Policy import complete"
    Write-SubStep "Imported: $($script:DeploymentResults.PoliciesImported.Count)" "Green"
    Write-SubStep "Existing: $($script:DeploymentResults.PoliciesExisting.Count)" "Gray"
    Write-SubStep "Failed:   $($script:DeploymentResults.PoliciesFailed.Count)" "$(if ($script:DeploymentResults.PoliciesFailed.Count -gt 0) { 'Red' } else { 'Gray' })"

    return $importedPolicies
}
#endregion

#region Initiative Functions

function Get-InitiativeParameters {
    <#
    .SYNOPSIS
        Builds the parameter definition for the initiative.
    #>

    return @{
        eventHubAuthorizationRuleId = @{
            type = "String"
            metadata = @{
                displayName = "Event Hub Authorization Rule ID"
                description = "The Event Hub authorization rule resource ID for diagnostic settings."
                strongType = "Microsoft.EventHub/namespaces/authorizationRules"
                assignPermissions = $true
            }
        }
        eventHubName = @{
            type = "String"
            defaultValue = ""
            metadata = @{
                displayName = "Event Hub Name"
                description = "Optional Event Hub name. Leave empty for auto-creation per resource type."
            }
        }
        eventHubLocation = @{
            type = "String"
            defaultValue = ""
            metadata = @{
                displayName = "Event Hub Location Filter"
                description = "Location filter for resources. Empty string applies policy to ALL regions (recommended for Centralized mode)."
            }
        }
        effect = @{
            type = "String"
            defaultValue = "DeployIfNotExists"
            allowedValues = @("DeployIfNotExists", "AuditIfNotExists", "Disabled")
            metadata = @{
                displayName = "Effect"
                description = "Policy effect. DeployIfNotExists will auto-remediate new resources."
            }
        }
        profileName = @{
            type = "String"
            defaultValue = "setbycriblpolicy"
            metadata = @{
                displayName = "Diagnostic Setting Name"
                description = "Name for the diagnostic setting resource."
            }
        }
        metricsEnabled = @{
            type = "String"
            defaultValue = "False"
            allowedValues = @("True", "False")
            metadata = @{
                displayName = "Enable Metrics"
                description = "Whether to stream metrics to Event Hub."
            }
        }
        logsEnabled = @{
            type = "String"
            defaultValue = "True"
            allowedValues = @("True", "False")
            metadata = @{
                displayName = "Enable Logs"
                description = "Whether to stream logs to Event Hub."
            }
        }
    }
}

function Build-PolicyDefinitionReferences {
    <#
    .SYNOPSIS
        Builds the policy definition references array for the initiative.
        Dynamically maps parameters based on what each policy actually supports.
    #>
    param(
        [Parameter(Mandatory)]
        [hashtable]$ImportedPolicies
    )

    $policyRefs = @()

    # Parameter mapping from initiative parameters to possible policy parameter names
    # Key = initiative parameter name, Value = array of possible policy parameter names
    $parameterMappings = @{
        "eventHubAuthorizationRuleId" = @("eventHubAuthorizationRuleId", "eventHubRuleId")
        "eventHubName" = @("eventHubName")
        "eventHubLocation" = @("eventHubLocation", "resourceLocation")
        "effect" = @("effect")
        "profileName" = @("profileName", "settingName", "diagnosticSettingName")
        "metricsEnabled" = @("metricsEnabled")
        "logsEnabled" = @("logsEnabled")
    }

    # Initiative parameter types (for type compatibility checking)
    $initiativeParamTypes = @{
        "eventHubAuthorizationRuleId" = "String"
        "eventHubName" = "String"
        "eventHubLocation" = "String"
        "effect" = "String"
        "profileName" = "String"
        "metricsEnabled" = "String"
        "logsEnabled" = "String"
    }

    foreach ($service in $ImportedPolicies.Keys | Sort-Object) {
        $policyId = $ImportedPolicies[$service]

        # Get the actual policy definition to see what parameters it supports
        $policyParams = $null
        try {
            $policyDef = Get-AzPolicyDefinition -Id $policyId -ErrorAction Stop
            $policyParamNames = @()
            if ($policyDef.Parameter) {
                $policyParams = $policyDef.Parameter
                $policyParamNames = $policyDef.Parameter.PSObject.Properties.Name
            }
        }
        catch {
            Write-WarningMsg "Could not read parameters for $service, using default mapping"
            $policyParamNames = @("eventHubAuthorizationRuleId", "eventHubName", "effect", "profileName", "metricsEnabled", "logsEnabled")
        }

        # Build parameter values only for parameters the policy actually supports
        $parameterValues = @{}

        foreach ($initiativeParam in $parameterMappings.Keys) {
            $possibleNames = $parameterMappings[$initiativeParam]
            $initiativeType = $initiativeParamTypes[$initiativeParam]

            # Find which parameter name this policy uses
            $matchedParam = $null
            foreach ($possibleName in $possibleNames) {
                if ($policyParamNames -contains $possibleName) {
                    $matchedParam = $possibleName
                    break
                }
            }

            if ($matchedParam -and $policyParams) {
                # Check for type compatibility - skip if types don't match
                # (e.g., initiative has String for eventHubLocation but policy uses Array for resourceLocation)
                $policyParamDef = $policyParams.PSObject.Properties | Where-Object { $_.Name -eq $matchedParam }
                if ($policyParamDef) {
                    $policyParamType = $policyParamDef.Value.type
                    if ($policyParamType -and $policyParamType -ne $initiativeType) {
                        # Type mismatch - skip this parameter mapping
                        # The policy will use its default value (empty array for resourceLocation = all regions)
                        if ($DebugLogging) {
                            Write-SubStep "  Skipping $matchedParam for $service - type mismatch (initiative: $initiativeType, policy: $policyParamType)" "Yellow"
                        }
                        continue
                    }
                }
                $parameterValues[$matchedParam] = @{ value = "[parameters('$initiativeParam')]" }
            }
            elseif ($matchedParam) {
                # No policyParams available, use the mapping anyway
                $parameterValues[$matchedParam] = @{ value = "[parameters('$initiativeParam')]" }
            }
        }

        # Only add if we have at least the essential parameters (effect and event hub)
        $hasEventHub = $parameterValues.Keys | Where-Object { $_ -match "eventHub" }
        if ($hasEventHub) {
            $policyRefs += @{
                policyDefinitionId = $policyId
                policyDefinitionReferenceId = "$service-DiagSettings"
                parameters = $parameterValues
            }
        }
        else {
            Write-WarningMsg "Skipping $service - no Event Hub parameter found"
        }
    }

    return $policyRefs
}

function New-DiagSettingsInitiative {
    <#
    .SYNOPSIS
        Creates or updates the diagnostic settings policy initiative.
    #>
    param(
        [Parameter(Mandatory)]
        [hashtable]$ImportedPolicies
    )

    Write-Step "Creating Policy Initiative..."

    $mgId = $azureParams.managementGroupId
    $initiativeParams = Get-InitiativeParameters
    $policyRefs = Build-PolicyDefinitionReferences -ImportedPolicies $ImportedPolicies

    if ($policyRefs.Count -eq 0) {
        Write-ErrorMsg "No policies available to include in initiative"
        return $null
    }

    Write-SubStep "Policies to include: $($policyRefs.Count)" "Gray"

    # Check if initiative exists
    try {
        $existing = Get-AzPolicySetDefinition -Name $script:InitiativeName -ManagementGroupName $mgId -ErrorAction SilentlyContinue

        if ($existing) {
            # Compare policy counts to determine if update needed
            $existingCount = if ($existing.PolicyDefinition) { $existing.PolicyDefinition.Count } else { 0 }

            if ($policyRefs.Count -gt $existingCount) {
                Write-SubStep "Updating initiative with $($policyRefs.Count - $existingCount) new policies..." "Yellow"

                $updated = Set-AzPolicySetDefinition `
                    -Name $script:InitiativeName `
                    -ManagementGroupName $mgId `
                    -PolicyDefinition ($policyRefs | ConvertTo-Json -Depth 20 -Compress) `
                    -Parameter ($initiativeParams | ConvertTo-Json -Depth 10 -Compress) `
                    -ErrorAction Stop

                Write-Success "Initiative updated successfully"
                $script:DeploymentResults.InitiativeUpdated = $true
                return $updated
            }
            else {
                Write-SubStep "Initiative already exists with $existingCount policies" "Gray"
                $script:DeploymentResults.InitiativeExisted = $true
                return $existing
            }
        }
    }
    catch {
        # Initiative doesn't exist, will create
    }

    # Create new initiative
    Write-SubStep "Creating new initiative: $($script:InitiativeName)" "Yellow"

    $metadata = @{
        category = "Monitoring"
        version = "1.0.0"
        source = "Cribl Azure Log Collection Solution"
        createdDate = (Get-Date).ToString("yyyy-MM-dd")
    }

    try {
        $initiative = New-AzPolicySetDefinition `
            -Name $script:InitiativeName `
            -DisplayName $script:InitiativeDisplayName `
            -Description $script:InitiativeDescription `
            -PolicyDefinition ($policyRefs | ConvertTo-Json -Depth 20 -Compress) `
            -Parameter ($initiativeParams | ConvertTo-Json -Depth 10 -Compress) `
            -Metadata ($metadata | ConvertTo-Json -Depth 5 -Compress) `
            -ManagementGroupName $mgId `
            -ErrorAction Stop

        Write-Success "Initiative created successfully"
        Write-SubStep "Name: $($script:InitiativeName)" "Gray"
        Write-SubStep "Policies: $($policyRefs.Count)" "Gray"

        $script:DeploymentResults.InitiativeCreated = $true
        return $initiative
    }
    catch {
        Write-ErrorMsg "Failed to create initiative: $_"
        $script:DeploymentResults.Errors += @{
            Operation = "Create initiative"
            Error = $_.Exception.Message
            Timestamp = Get-Date
        }
        return $null
    }
}
#endregion

#region Assignment Functions

function Get-EventHubAuthorizationRuleId {
    <#
    .SYNOPSIS
        Gets the Event Hub authorization rule ID for the centralized namespace.
    #>
    param(
        [string]$Region = ""
    )

    $subscriptionId = $azureParams.eventHubSubscriptionId
    $resourceGroup = $azureParams.eventHubResourceGroup
    $prefix = $azureParams.eventHubNamespacePrefix

    try {
        Set-AzContext -SubscriptionId $subscriptionId -ErrorAction Stop | Out-Null

        # Find namespace matching our prefix
        $namespaces = @(Get-AzEventHubNamespace -ResourceGroupName $resourceGroup -ErrorAction Stop |
            Where-Object { $_.Name -like "$prefix*" })

        if ($Region) {
            $namespaces = @($namespaces | Where-Object { $_.Location -eq $Region })
        }

        if ($namespaces.Count -eq 0) {
            Write-WarningMsg "No Event Hub namespace found matching prefix: $prefix"
            return $null
        }

        $namespace = $namespaces[0]

        # Get RootManageSharedAccessKey authorization rule
        $authRule = Get-AzEventHubAuthorizationRule -ResourceGroupName $resourceGroup -NamespaceName $namespace.Name -ErrorAction Stop |
            Where-Object { $_.Name -eq "RootManageSharedAccessKey" } |
            Select-Object -First 1

        if (-not $authRule) {
            Write-WarningMsg "No authorization rule found for namespace: $($namespace.Name)"
            return $null
        }

        return $authRule.Id
    }
    catch {
        Write-ErrorMsg "Failed to get Event Hub authorization rule: $_"
        return $null
    }
}

function New-InitiativeAssignment {
    <#
    .SYNOPSIS
        Creates the initiative assignment at management group scope.
    #>
    param(
        [Parameter(Mandatory)]
        $Initiative,

        [Parameter(Mandatory)]
        $ManagedIdentity,

        [string]$Region = ""
    )

    Write-Step "Creating Initiative Assignment..."

    $mgId = $azureParams.managementGroupId
    $mgScope = "/providers/Microsoft.Management/managementGroups/$mgId"
    $assignmentName = Get-AssignmentName -Region $Region -DepMode $DeploymentMode
    $location = $azureParams.centralizedRegion

    # Get Event Hub authorization rule ID
    $authRuleId = Get-EventHubAuthorizationRuleId -Region $Region
    if (-not $authRuleId) {
        Write-ErrorMsg "Cannot create assignment without Event Hub authorization rule"
        return $null
    }

    # Build assignment parameters
    $diagSettingName = if ($azureParams.diagnosticSettingName) { $azureParams.diagnosticSettingName } else { "setbycriblpolicy" }

    $assignmentParams = @{
        eventHubAuthorizationRuleId = $authRuleId
        eventHubName = ""  # Empty for auto-creation per resource type
        eventHubLocation = if ($DeploymentMode -eq "Centralized") { "" } else { $Region }
        effect = "DeployIfNotExists"
        profileName = $diagSettingName
        metricsEnabled = "False"
        logsEnabled = "True"
    }

    # Check if assignment exists
    try {
        $existing = Get-AzPolicyAssignment -Name $assignmentName -Scope $mgScope -ErrorAction SilentlyContinue
        if ($existing) {
            Write-SubStep "Assignment already exists: $assignmentName" "Gray"
            $script:DeploymentResults.AssignmentExisted = $true
            return $existing
        }
    }
    catch {
        # Assignment doesn't exist, will create
    }

    Write-SubStep "Creating assignment: $assignmentName" "Yellow"
    Write-SubStep "Scope: $mgScope" "Gray"

    try {
        # Build resource selectors for multi-region mode
        $resourceSelectors = $null
        if ($DeploymentMode -eq "MultiRegion" -and $Region) {
            $resourceSelectors = @(
                @{
                    name = "ResourcesIn$($Region -replace '-','')"
                    selectors = @(
                        @{
                            kind = "resourceLocation"
                            "in" = @($Region)
                        }
                    )
                }
            )
        }

        $assignmentSplat = @{
            Name = $assignmentName
            DisplayName = "$($script:InitiativeDisplayName) - $(if ($DeploymentMode -eq 'Centralized') { 'Centralized' } else { $Region })"
            Description = "Cribl diagnostic settings initiative assignment for streaming Azure resource logs to Event Hub."
            PolicySetDefinition = $Initiative
            Scope = $mgScope
            Location = $location
            PolicyParameterObject = $assignmentParams
            IdentityType = "UserAssigned"
            IdentityId = $ManagedIdentity.Id
            ErrorAction = "Stop"
        }

        $assignment = New-AzPolicyAssignment @assignmentSplat

        Write-Success "Initiative assignment created successfully"
        Write-SubStep "Name: $assignmentName" "Gray"

        $script:DeploymentResults.AssignmentCreated = $true
        return $assignment
    }
    catch {
        Write-ErrorMsg "Failed to create assignment: $_"
        $script:DeploymentResults.Errors += @{
            Operation = "Create initiative assignment"
            Error = $_.Exception.Message
            Timestamp = Get-Date
        }
        return $null
    }
}
#endregion

#region Remediation Functions

function Start-InitiativeRemediation {
    <#
    .SYNOPSIS
        Creates a remediation task for the initiative assignment.
    #>
    param(
        [Parameter(Mandatory)]
        [string]$AssignmentName
    )

    Write-Step "Creating Remediation Task..."

    $mgId = $azureParams.managementGroupId
    $mgScope = "/providers/Microsoft.Management/managementGroups/$mgId"
    $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $remediationName = "Remediate-$AssignmentName-$timestamp"
    $assignmentId = "$mgScope/providers/Microsoft.Authorization/policyAssignments/$AssignmentName"

    try {
        Write-SubStep "Creating remediation: $remediationName" "Yellow"

        $remediation = Start-AzPolicyRemediation `
            -Name $remediationName `
            -PolicyAssignmentId $assignmentId `
            -Scope $mgScope `
            -ResourceDiscoveryMode ReEvaluateCompliance `
            -ErrorAction Stop

        Write-Success "Remediation task created"
        Write-SubStep "Name: $remediationName" "Gray"
        Write-SubStep "Status: $($remediation.ProvisioningState)" "Gray"

        $script:DeploymentResults.RemediationCreated = $true
        return $remediation
    }
    catch {
        if ($_.Exception.Message -like "*no resources*" -or $_.Exception.Message -like "*nothing to remediate*") {
            Write-SubStep "No resources require remediation (all compliant or no matching resources)" "Gray"
            $script:DeploymentResults.RemediationCreated = $true
            return $null
        }

        Write-WarningMsg "Failed to create remediation: $_"
        $script:DeploymentResults.RemediationFailed = $true
        $script:DeploymentResults.Errors += @{
            Operation = "Create remediation"
            Error = $_.Exception.Message
            Timestamp = Get-Date
        }
        return $null
    }
}
#endregion

#region Status and Removal Functions

function Show-InitiativeStatus {
    <#
    .SYNOPSIS
        Displays current initiative and policy status.
    #>
    Write-Step "Initiative Status"

    $mgId = $azureParams.managementGroupId

    # Check initiative
    try {
        $initiative = Get-AzPolicySetDefinition -Name $script:InitiativeName -ManagementGroupName $mgId -ErrorAction SilentlyContinue
        if ($initiative) {
            $policyCount = if ($initiative.PolicyDefinition) { $initiative.PolicyDefinition.Count } else { 0 }
            Write-Success "Initiative exists: $($script:InitiativeName)"
            Write-SubStep "Policies included: $policyCount" "Gray"
        }
        else {
            Write-SubStep "Initiative not found: $($script:InitiativeName)" "Yellow"
        }
    }
    catch {
        Write-SubStep "Error checking initiative: $_" "Red"
    }

    # Check assignments
    Write-Host ""
    Write-SubStep "Assignments:" "Cyan"
    $mgScope = "/providers/Microsoft.Management/managementGroups/$mgId"
    try {
        $assignments = Get-AzPolicyAssignment -Scope $mgScope -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -like "Cribl-Diag-EH-*" }

        if ($assignments) {
            foreach ($a in $assignments) {
                Write-SubStep "  $($a.Name) - $($a.DisplayName)" "Gray"
            }
        }
        else {
            Write-SubStep "  No initiative assignments found" "Yellow"
        }
    }
    catch {
        Write-SubStep "  Error checking assignments: $_" "Red"
    }

    # Check custom policy definitions
    Write-Host ""
    Write-SubStep "Custom Policy Definitions:" "Cyan"
    try {
        $customPolicies = Get-AzPolicyDefinition -ManagementGroupName $mgId -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -like "$($script:PolicyDefPrefix)-*-$($script:PolicyDefSuffix)" }

        if ($customPolicies) {
            Write-SubStep "  Found $($customPolicies.Count) custom policy definitions" "Gray"
        }
        else {
            Write-SubStep "  No custom policy definitions found" "Yellow"
        }
    }
    catch {
        Write-SubStep "  Error checking policies: $_" "Red"
    }
}

function Remove-InitiativeDeployment {
    <#
    .SYNOPSIS
        Removes initiative assignment, definition, and optionally custom policies.
    #>
    Write-Step "Removing Initiative Deployment..."

    $mgId = $azureParams.managementGroupId
    $mgScope = "/providers/Microsoft.Management/managementGroups/$mgId"

    # Remove assignments first
    Write-SubStep "Removing assignments..." "Yellow"
    try {
        $assignments = Get-AzPolicyAssignment -Scope $mgScope -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -like "Cribl-Diag-EH-*" }

        foreach ($a in $assignments) {
            Write-SubStep "  Removing: $($a.Name)" "Gray"
            Remove-AzPolicyAssignment -Name $a.Name -Scope $mgScope -ErrorAction Stop
        }
        Write-SubStep "Assignments removed" "Green"
    }
    catch {
        Write-WarningMsg "Error removing assignments: $_"
    }

    # Remove initiative
    Write-SubStep "Removing initiative definition..." "Yellow"
    try {
        Remove-AzPolicySetDefinition -Name $script:InitiativeName -ManagementGroupName $mgId -Force -ErrorAction Stop
        Write-SubStep "Initiative removed" "Green"
    }
    catch {
        if ($_.Exception.Message -notlike "*not found*") {
            Write-WarningMsg "Error removing initiative: $_"
        }
    }

    # Remove custom policies if requested
    if ($RemovePolicyDefinitions) {
        Write-SubStep "Removing custom policy definitions..." "Yellow"
        try {
            $customPolicies = Get-AzPolicyDefinition -ManagementGroupName $mgId -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -like "$($script:PolicyDefPrefix)-*-$($script:PolicyDefSuffix)" }

            foreach ($p in $customPolicies) {
                Write-SubStep "  Removing: $($p.Name)" "Gray"
                Remove-AzPolicyDefinition -Name $p.Name -ManagementGroupName $mgId -Force -ErrorAction SilentlyContinue
            }
            Write-SubStep "Policy definitions removed" "Green"
        }
        catch {
            Write-WarningMsg "Error removing policy definitions: $_"
        }
    }

    Write-Success "Initiative deployment removed"
}
#endregion

#region Summary Function

function Show-DeploymentSummary {
    <#
    .SYNOPSIS
        Displays deployment summary.
    #>
    Write-Host ""
    Write-Host "============================================================" -ForegroundColor Cyan
    Write-Host "  DEPLOYMENT SUMMARY" -ForegroundColor Cyan
    Write-Host "============================================================" -ForegroundColor Cyan
    Write-Host ""

    # Policy Definitions
    Write-Host "  POLICY DEFINITIONS:" -ForegroundColor White
    Write-Host "    Imported:  $($script:DeploymentResults.PoliciesImported.Count)" -ForegroundColor Green
    Write-Host "    Existing:  $($script:DeploymentResults.PoliciesExisting.Count)" -ForegroundColor Gray
    Write-Host "    Failed:    $($script:DeploymentResults.PoliciesFailed.Count)" -ForegroundColor $(if ($script:DeploymentResults.PoliciesFailed.Count -gt 0) { "Red" } else { "Gray" })
    Write-Host ""

    # Initiative
    Write-Host "  INITIATIVE:" -ForegroundColor White
    if ($script:DeploymentResults.InitiativeCreated) {
        Write-Host "    Status:    Created" -ForegroundColor Green
    }
    elseif ($script:DeploymentResults.InitiativeUpdated) {
        Write-Host "    Status:    Updated" -ForegroundColor Yellow
    }
    elseif ($script:DeploymentResults.InitiativeExisted) {
        Write-Host "    Status:    Already Exists" -ForegroundColor Gray
    }
    else {
        Write-Host "    Status:    Not Created" -ForegroundColor Red
    }
    Write-Host ""

    # Assignment
    Write-Host "  ASSIGNMENT:" -ForegroundColor White
    if ($script:DeploymentResults.AssignmentCreated) {
        Write-Host "    Status:    Created" -ForegroundColor Green
    }
    elseif ($script:DeploymentResults.AssignmentExisted) {
        Write-Host "    Status:    Already Exists" -ForegroundColor Gray
    }
    else {
        Write-Host "    Status:    Not Created" -ForegroundColor Red
    }
    Write-Host ""

    # Roles
    Write-Host "  RBAC ROLES:" -ForegroundColor White
    Write-Host "    Created:   $($script:DeploymentResults.RolesCreated)" -ForegroundColor $(if ($script:DeploymentResults.RolesCreated -gt 0) { "Green" } else { "Gray" })
    Write-Host ""

    # Remediation
    if ($Remediate) {
        Write-Host "  REMEDIATION:" -ForegroundColor White
        if ($script:DeploymentResults.RemediationCreated) {
            Write-Host "    Status:    Task Created" -ForegroundColor Green
        }
        elseif ($script:DeploymentResults.RemediationFailed) {
            Write-Host "    Status:    Failed" -ForegroundColor Red
        }
        Write-Host ""
    }

    # Errors
    if ($script:DeploymentResults.Errors.Count -gt 0) {
        Write-Host "  ERRORS ($($script:DeploymentResults.Errors.Count)):" -ForegroundColor Red
        foreach ($err in $script:DeploymentResults.Errors | Select-Object -First 5) {
            Write-Host "    - $($err.Operation): $($err.Error)" -ForegroundColor Red
        }
        if ($script:DeploymentResults.Errors.Count -gt 5) {
            Write-Host "    ... and $($script:DeploymentResults.Errors.Count - 5) more" -ForegroundColor Red
        }
        Write-Host ""
    }

    Write-Host "============================================================" -ForegroundColor Cyan

    # Next Steps
    $totalPolicies = $script:DeploymentResults.PoliciesImported.Count + $script:DeploymentResults.PoliciesExisting.Count
    if ($totalPolicies -gt 0 -and ($script:DeploymentResults.AssignmentCreated -or $script:DeploymentResults.AssignmentExisted)) {
        Write-Host ""
        Write-Host "  NEXT STEPS:" -ForegroundColor Cyan
        if (-not $Remediate) {
            Write-Host "    1. Wait 15-30 minutes for compliance evaluation" -ForegroundColor White
            Write-Host "    2. Run with -Remediate to apply to existing resources" -ForegroundColor White
            Write-Host "    3. Configure Cribl Stream Event Hub sources" -ForegroundColor White
        }
        else {
            Write-Host "    1. Monitor remediation progress in Azure Portal" -ForegroundColor White
            Write-Host "    2. Check Event Hub for incoming data" -ForegroundColor White
            Write-Host "    3. Configure Cribl Stream Event Hub sources" -ForegroundColor White
        }
        Write-Host ""
        Write-Host "  NOTE: Activity Log requires separate deployment." -ForegroundColor Yellow
        Write-Host "        Use Deploy-SupplementalPolicies.ps1 -ActivityLogOnly" -ForegroundColor Yellow
        Write-Host ""
    }
}
#endregion

#region Main Execution

Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  Cribl Community Policy Initiative Deployment" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  Mode: $DeploymentMode" -ForegroundColor Gray
Write-Host "  Management Group: $($azureParams.managementGroupId)" -ForegroundColor Gray
Write-Host "============================================================" -ForegroundColor Cyan

# Connect to Azure
if (-not (Connect-AzureIfNeeded)) {
    Write-ErrorMsg "Cannot proceed without Azure connection"
    exit 1
}

# Handle different modes
if ($ShowStatus) {
    Show-InitiativeStatus
    exit 0
}

if ($RemoveInitiative) {
    Remove-InitiativeDeployment
    exit 0
}

# Get selected services
$selectedServices = Get-SelectedServices
if ($selectedServices.Count -eq 0) {
    Write-ErrorMsg "No services selected for deployment"
    exit 1
}

Write-SubStep "Services to deploy: $($selectedServices.Count)" "Gray"

if ($ValidateOnly) {
    Write-Step "Validation Mode - No changes will be made"
    Write-SubStep "Selected tiers: $($PolicyTiers -join ', ')" "Gray"
    Write-SubStep "Services:" "Gray"
    foreach ($svc in $selectedServices | Sort-Object) {
        $tier = ($script:CommunityPolicyTiers.GetEnumerator() | Where-Object { $_.Value.Services -contains $svc }).Name
        Write-SubStep "  - $svc ($tier)" "Gray"
    }
    exit 0
}

# Create or get managed identity
$managedIdentity = Get-OrCreateManagedIdentity
if (-not $managedIdentity) {
    Write-ErrorMsg "Failed to configure managed identity. Cannot proceed."
    exit 1
}

# Ensure RBAC roles
Ensure-ManagedIdentityRoles -ManagedIdentity $managedIdentity

# Import community policies
$importedPolicies = Import-AllCommunityPolicies -Services $selectedServices
if ($importedPolicies.Count -eq 0) {
    Write-ErrorMsg "No policies were successfully imported. Cannot create initiative."
    exit 1
}

# Create or update initiative
$initiative = New-DiagSettingsInitiative -ImportedPolicies $importedPolicies
if (-not $initiative) {
    Write-ErrorMsg "Failed to create initiative. Cannot proceed with assignment."
    Show-DeploymentSummary
    exit 1
}

# Create assignment
$assignmentName = Get-AssignmentName -Region $azureParams.centralizedRegion -DepMode $DeploymentMode
$assignment = New-InitiativeAssignment -Initiative $initiative -ManagedIdentity $managedIdentity -Region $azureParams.centralizedRegion

# Remediation
if ($Remediate -and $assignment) {
    Start-InitiativeRemediation -AssignmentName $assignmentName
}

# Show summary
Show-DeploymentSummary

#endregion
