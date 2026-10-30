# Azure Policy Deployment Engine - Supplemental Policies
# This script deploys individual built-in policies for resources NOT covered by the main initiatives
#
# Gap Coverage:
# - Storage Account Services (Blob, File, Queue, Table) - NOT in any built-in initiative
# - Activity Log (Subscription-level) - Control plane audit logging
#
# These policies complement the main Audit or AllLogs initiatives to provide comprehensive coverage

[CmdletBinding()]
param(
    [Parameter(Mandatory=$false)]
    [ValidateSet("Centralized", "MultiRegion")]
    [string]$DeploymentMode = "Centralized",

    [Parameter(Mandatory=$false)]
    [switch]$ValidateOnly,

    [Parameter(Mandatory=$false)]
    [switch]$ShowStatus,

    [Parameter(Mandatory=$false)]
    [switch]$RemoveAssignments,

    [Parameter(Mandatory=$false)]
    [switch]$Remediate,

    [Parameter(Mandatory=$false)]
    [switch]$IncludeActivityLog,

    [Parameter(Mandatory=$false)]
    [switch]$StorageOnly,

    [Parameter(Mandatory=$false)]
    [switch]$ActivityLogOnly,

    [Parameter(Mandatory=$false)]
    [switch]$TableServicesOnly,

    [Parameter(Mandatory=$false)]
    [string[]]$SpecificRegions,

    # Policy Tier Selection - Controls which community policies to deploy
    # Valid values: Storage, Security, Data, Compute, Integration, Networking, AVD, Other, All
    # Default: Storage (original behavior)
    [Parameter(Mandatory=$false)]
    [ValidateSet("Storage", "Security", "Data", "Compute", "Integration", "Networking", "AVD", "Other", "All")]
    [string[]]$PolicyTiers = @("Storage"),

    # Specific services to deploy (overrides PolicyTiers if specified)
    # Use service names from CommunityPolicyPaths (e.g., AKS, Firewall, CosmosDB)
    [Parameter(Mandatory=$false)]
    [string[]]$SpecificServices,

    # Override parameters
    [Parameter(Mandatory=$false)]
    [Nullable[bool]]$UseExistingNamespaces = $null,

    [Parameter(Mandatory=$false)]
    [string]$CentralizedNamespaceOverride = "",

    [Parameter(Mandatory=$false)]
    [hashtable]$RegionNamespacesOverride = @{},

    [Parameter(Mandatory=$false)]
    [switch]$DebugLogging
)

# Script variables
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ScriptStartTime = Get-Date
$ScriptPath = Split-Path -Parent $MyInvocation.MyCommand.Path

# Import logging helper
$OutputHelperPath = Join-Path $ScriptPath "Output-Helper.ps1"
if (Test-Path $OutputHelperPath) {
    . $OutputHelperPath
}

#region Policy Discovery and Definitions

# Community Policy repo URL - contains policies not available as built-in
# These must be imported into your Azure environment before use
$script:CommunityPolicyRepoBase = "https://api.github.com/repos/Azure/Community-Policy/contents/policyDefinitions/Monitoring"

# ============================================================================
# Community Policy Definitions - Azure/Community-Policy GitHub Repository
# Source: https://github.com/Azure/Community-Policy/tree/main/policyDefinitions/Monitoring/To%20Event%20Hub
# These policies are NOT built-in to Azure and must be imported to your management group
# ============================================================================

# Policy paths mapped to their GitHub folder names
$script:CommunityPolicyPaths = @{
    # ========== TIER 1: Storage Services (Original) ==========
    "BlobServices"              = "To Event Hub/Configure diagnostic settings for Blob Services to Event Hub"
    "FileServices"              = "To Event Hub/Configure diagnostic settings for File Services to Event Hub"
    "QueueServices"             = "To Event Hub/Configure diagnostic settings for Queue Services to Event Hub"
    "TableServices"             = "To Event Hub/Configure diagnostic settings for Table Services to Event Hub"
    "StorageAccounts"           = "To Event Hub/Configure diagnostic settings for Storage Accounts to Event Hub"

    # ========== TIER 2: Security-Critical Services ==========
    "AKS"                       = "To Event Hub/apply-diagnostic-settings-for-aks-microsoft.containerservice-managedclusters-to-a-regional-event-hub"
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
    "PostgreSQLFlexible"        = "To Event Hub/apply-diagnostic-settings-for-microsoft.dbforpostgresql-flexibleservers-to-a-regional-event-hub"
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

    # ========== Activity Log (Subscription-level) ==========
    # NOTE: There is NO built-in Azure Policy for Activity Log to Event Hub
    # This community policy handles subscription-level activity log streaming
    # Using v2 version for improved compatibility and features
    "ActivityLog"               = "configure-azure-activity-logs-to-stream-to-specified-event-hub-v2"
}

# Organized policy tiers for selective deployment
$script:CommunityPolicyTiers = @{
    "Storage" = @{
        Description = "Storage Account Services (Blob, File, Queue, Table)"
        Services = @("BlobServices", "FileServices", "QueueServices", "TableServices", "StorageAccounts")
        Priority = 1
    }
    "Security" = @{
        Description = "Security-Critical Network and Container Services"
        Services = @("AKS", "Firewall", "NSG", "ApplicationGateway", "ExpressRoute", "VirtualNetwork")
        Priority = 2
    }
    "Data" = @{
        Description = "Database and Analytics Services"
        Services = @("CosmosDB", "DataFactory", "MySQL", "PostgreSQL", "PostgreSQLFlexible", "MariaDB",
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

# Service metadata for policy creation and assignment
$script:CommunityPolicyMetadata = @{
    # Storage Services
    "BlobServices"              = @{ ResourceType = "Microsoft.Storage/storageAccounts/blobServices"; AssignmentPrefix = "Cribl-Blob" }
    "FileServices"              = @{ ResourceType = "Microsoft.Storage/storageAccounts/fileServices"; AssignmentPrefix = "Cribl-File" }
    "QueueServices"             = @{ ResourceType = "Microsoft.Storage/storageAccounts/queueServices"; AssignmentPrefix = "Cribl-Queue" }
    "TableServices"             = @{ ResourceType = "Microsoft.Storage/storageAccounts/tableServices"; AssignmentPrefix = "Cribl-Table" }
    "StorageAccounts"           = @{ ResourceType = "Microsoft.Storage/storageAccounts"; AssignmentPrefix = "Cribl-Storage" }

    # Security Services
    "AKS"                       = @{ ResourceType = "Microsoft.ContainerService/managedClusters"; AssignmentPrefix = "Cribl-AKS" }
    "Firewall"                  = @{ ResourceType = "Microsoft.Network/azureFirewalls"; AssignmentPrefix = "Cribl-Firewall" }
    "NSG"                       = @{ ResourceType = "Microsoft.Network/networkSecurityGroups"; AssignmentPrefix = "Cribl-NSG" }
    "ApplicationGateway"        = @{ ResourceType = "Microsoft.Network/applicationGateways"; AssignmentPrefix = "Cribl-AppGW" }
    "ExpressRoute"              = @{ ResourceType = "Microsoft.Network/expressRouteCircuits"; AssignmentPrefix = "Cribl-ExpRoute" }
    "VirtualNetwork"            = @{ ResourceType = "Microsoft.Network/virtualNetworks"; AssignmentPrefix = "Cribl-VNet" }

    # Data Services
    "CosmosDB"                  = @{ ResourceType = "Microsoft.DocumentDB/databaseAccounts"; AssignmentPrefix = "Cribl-Cosmos" }
    "DataFactory"               = @{ ResourceType = "Microsoft.DataFactory/factories"; AssignmentPrefix = "Cribl-ADF" }
    "MySQL"                     = @{ ResourceType = "Microsoft.DBforMySQL/servers"; AssignmentPrefix = "Cribl-MySQL" }
    "PostgreSQL"                = @{ ResourceType = "Microsoft.DBforPostgreSQL/servers"; AssignmentPrefix = "Cribl-PgSQL" }
    "PostgreSQLFlexible"        = @{ ResourceType = "Microsoft.DBforPostgreSQL/flexibleServers"; AssignmentPrefix = "Cribl-PgFlex" }
    "MariaDB"                   = @{ ResourceType = "Microsoft.DBforMariaDB/servers"; AssignmentPrefix = "Cribl-MariaDB" }
    "SynapseAnalytics"          = @{ ResourceType = "Microsoft.Synapse/workspaces"; AssignmentPrefix = "Cribl-Synapse" }
    "SynapseSparkPool"          = @{ ResourceType = "Microsoft.Synapse/workspaces/bigDataPools"; AssignmentPrefix = "Cribl-SynSpark" }
    "SynapseSQLPool"            = @{ ResourceType = "Microsoft.Synapse/workspaces/sqlPools"; AssignmentPrefix = "Cribl-SynSQL" }
    "DataExplorer"              = @{ ResourceType = "Microsoft.Kusto/clusters"; AssignmentPrefix = "Cribl-ADX" }
    "Databricks"                = @{ ResourceType = "Microsoft.Databricks/workspaces"; AssignmentPrefix = "Cribl-Databricks" }
    "AnalysisServices"          = @{ ResourceType = "Microsoft.AnalysisServices/servers"; AssignmentPrefix = "Cribl-Analysis" }
    "TimeSeriesInsights"        = @{ ResourceType = "Microsoft.TimeSeriesInsights/environments"; AssignmentPrefix = "Cribl-TSI" }

    # Compute Services
    "AppService"                = @{ ResourceType = "Microsoft.Web/sites"; AssignmentPrefix = "Cribl-AppSvc" }
    "FunctionApp"               = @{ ResourceType = "Microsoft.Web/sites"; AssignmentPrefix = "Cribl-Func" }
    "BatchAccount"              = @{ ResourceType = "Microsoft.Batch/batchAccounts"; AssignmentPrefix = "Cribl-Batch" }
    "MachineLearning"           = @{ ResourceType = "Microsoft.MachineLearningServices/workspaces"; AssignmentPrefix = "Cribl-ML" }
    "ApplicationInsights"       = @{ ResourceType = "Microsoft.Insights/components"; AssignmentPrefix = "Cribl-AppIns" }
    "AutoscaleSettings"         = @{ ResourceType = "Microsoft.Insights/autoscalesettings"; AssignmentPrefix = "Cribl-Scale" }
    "DevCenter"                 = @{ ResourceType = "Microsoft.DevCenter/devcenters"; AssignmentPrefix = "Cribl-DevCtr" }

    # Integration Services
    "LogicApps"                 = @{ ResourceType = "Microsoft.Logic/workflows"; AssignmentPrefix = "Cribl-Logic" }
    "LogicAppsISE"              = @{ ResourceType = "Microsoft.Logic/integrationServiceEnvironments"; AssignmentPrefix = "Cribl-ISE" }
    "EventGridTopic"            = @{ ResourceType = "Microsoft.EventGrid/topics"; AssignmentPrefix = "Cribl-EGTopic" }
    "EventGridSystemTopic"      = @{ ResourceType = "Microsoft.EventGrid/systemTopics"; AssignmentPrefix = "Cribl-EGSys" }
    "Relay"                     = @{ ResourceType = "Microsoft.Relay/namespaces"; AssignmentPrefix = "Cribl-Relay" }

    # Networking Services
    "LoadBalancer"              = @{ ResourceType = "Microsoft.Network/loadBalancers"; AssignmentPrefix = "Cribl-LB" }
    "TrafficManager"            = @{ ResourceType = "Microsoft.Network/trafficManagerProfiles"; AssignmentPrefix = "Cribl-TM" }
    "CDNEndpoint"               = @{ ResourceType = "Microsoft.Cdn/profiles/endpoints"; AssignmentPrefix = "Cribl-CDN" }

    # AVD Services
    "AVDHostPool"               = @{ ResourceType = "Microsoft.DesktopVirtualization/hostPools"; AssignmentPrefix = "Cribl-AVDHost" }
    "AVDApplicationGroup"       = @{ ResourceType = "Microsoft.DesktopVirtualization/applicationGroups"; AssignmentPrefix = "Cribl-AVDApp" }
    "AVDWorkspace"              = @{ ResourceType = "Microsoft.DesktopVirtualization/workspaces"; AssignmentPrefix = "Cribl-AVDWks" }
    "AVDScalingPlan"            = @{ ResourceType = "Microsoft.DesktopVirtualization/scalingPlans"; AssignmentPrefix = "Cribl-AVDScale" }

    # Other Services
    "RecoveryServicesVault"     = @{ ResourceType = "Microsoft.RecoveryServices/vaults"; AssignmentPrefix = "Cribl-RSV" }
    "AzureAPIforFHIR"           = @{ ResourceType = "Microsoft.HealthcareApis/services"; AssignmentPrefix = "Cribl-FHIR" }
    "PowerBIEmbedded"           = @{ ResourceType = "Microsoft.PowerBIDedicated/capacities"; AssignmentPrefix = "Cribl-PBI" }

    # Activity Log (Subscription-level - special handling required)
    # NOTE: Activity Log is subscription-level, not resource-level
    "ActivityLog"               = @{ ResourceType = "Microsoft.Insights/diagnosticSettings"; AssignmentPrefix = "Cribl-Activity"; IsSubscriptionLevel = $true }
}

# Cache for community policy definitions
$script:CommunityPolicyCache = @{}

function Search-CommunityPolicyRepo {
    <#
    .SYNOPSIS
        Searches the Azure Community-Policy GitHub repository for policy definitions.
    .DESCRIPTION
        The Community-Policy repo contains policies that are NOT built-in to Azure.
        These policies must be imported into your Azure environment before use.
        This is the PRIMARY source for Event Hub streaming policies across all service types.
        Source: https://github.com/Azure/Community-Policy/tree/main/policyDefinitions/Monitoring/To%20Event%20Hub
    .PARAMETER ServiceType
        The service type to find a policy for (e.g., BlobServices, AKS, Firewall, CosmosDB, etc.)
        Valid values are the keys in $script:CommunityPolicyPaths hashtable.
    .OUTPUTS
        Returns the policy JSON content if found, or $null if not found.
    #>
    param(
        [Parameter(Mandatory=$true)]
        [string]$ServiceType
    )

    # Validate service type exists in our paths
    if (-not $script:CommunityPolicyPaths.ContainsKey($ServiceType)) {
        Write-SubStep "  Unknown service type: $ServiceType" "Red"
        Write-SubStep "  Valid types: $($script:CommunityPolicyPaths.Keys -join ', ')" "Gray"
        return $null
    }

    Write-SubStep "  Searching Azure Community-Policy repository for $ServiceType..." "Cyan"

    # Check cache first
    if ($script:CommunityPolicyCache.ContainsKey($ServiceType)) {
        Write-SubStep "  Found in cache" "Gray"
        return $script:CommunityPolicyCache[$ServiceType]
    }

    $policyPath = $script:CommunityPolicyPaths[$ServiceType]
    if (-not $policyPath) {
        Write-SubStep "  No known community policy path for $ServiceType" "Yellow"
        return $null
    }

    try {
        $headers = @{
            "Accept" = "application/vnd.github.v3+json"
            "User-Agent" = "Cribl-Azure-LogCollection"
        }

        # Construct the API URL to get the folder contents
        $encodedPath = [System.Uri]::EscapeDataString($policyPath)
        $apiUrl = "$script:CommunityPolicyRepoBase/$encodedPath"

        Write-SubStep "  Fetching policy folder: $policyPath" "Gray"

        $folderContents = Invoke-RestMethod -Uri $apiUrl -Headers $headers -Method Get -ErrorAction Stop

        # Look for azurepolicy.json or similar
        $policyFile = $folderContents | Where-Object { $_.name -eq "azurepolicy.json" }

        if (-not $policyFile) {
            # Try other common names
            $policyFile = $folderContents | Where-Object { $_.name -like "*.json" -and $_.name -notlike "*parameters*" -and $_.name -notlike "*rules*" }
            if ($policyFile -is [array]) {
                $policyFile = $policyFile | Select-Object -First 1
            }
        }

        if ($policyFile) {
            Write-SubStep "  Found policy file: $($policyFile.name)" "Gray"

            # Download the policy content
            $policyContent = Invoke-RestMethod -Uri $policyFile.download_url -Headers $headers -ErrorAction Stop

            # Validate it's a valid policy with DeployIfNotExists
            $policyJson = $policyContent | ConvertTo-Json -Depth 30
            if ($policyJson -notmatch "DeployIfNotExists") {
                Write-SubStep "  Policy found but is not DeployIfNotExists type" "Yellow"
                return $null
            }

            if ($policyJson -notmatch "eventHub") {
                Write-SubStep "  Policy found but does not configure Event Hub" "Yellow"
                return $null
            }

            Write-SubStep "  Found valid community policy for $ServiceType" "Green"

            # Cache the result
            $script:CommunityPolicyCache[$ServiceType] = $policyContent

            return $policyContent
        } else {
            Write-SubStep "  No policy JSON file found in folder" "Yellow"
        }

        return $null

    } catch {
        Write-SubStep "  Community policy search failed: $_" "Yellow"
        return $null
    }
}

function Import-CommunityPolicyDefinition {
    <#
    .SYNOPSIS
        Imports a community policy definition into Azure.
    .DESCRIPTION
        Takes a policy definition from the Community-Policy repo and creates it
        as a custom policy in the user's Azure management group.
    .PARAMETER PolicyContent
        The policy JSON content from the community repo.
    .PARAMETER ServiceType
        The storage service type this policy is for.
    .PARAMETER ManagementGroupId
        The management group to create the policy in.
    .OUTPUTS
        Returns the policy definition ID if successful, or $null if failed.
    #>
    param(
        [Parameter(Mandatory=$true)]
        $PolicyContent,

        [Parameter(Mandatory=$true)]
        [string]$ServiceType,

        [Parameter(Mandatory=$true)]
        [string]$ManagementGroupId
    )

    # Generate a policy name that identifies it as imported from community
    $policyName = "Cribl-Community-$ServiceType-DiagSettings-EventHub"

    Write-SubStep "  Importing community policy: $policyName" "Cyan"

    # Check if policy already exists
    $existingPolicy = $null
    $needsUpdate = $false
    try {
        $existingPolicy = Get-AzPolicyDefinition -Name $policyName -ManagementGroupName $ManagementGroupId -ErrorAction SilentlyContinue
        if ($existingPolicy) {
            # Check if existing policy has region restriction that needs to be removed
            # Note: Az module uses 'Parameter' (singular), not 'Parameters' (plural)
            $existingParams = $null
            if ($existingPolicy.PSObject.Properties['Properties'] -and $existingPolicy.Properties.PSObject.Properties['Parameters']) {
                $existingParams = $existingPolicy.Properties.Parameters
            } elseif ($existingPolicy.PSObject.Properties['Parameters']) {
                $existingParams = $existingPolicy.Parameters
            } elseif ($existingPolicy.PSObject.Properties['Parameter']) {
                # Az module returns 'Parameter' (singular)
                $existingParams = $existingPolicy.Parameter
            }

            if ($existingParams -and $existingParams.PSObject.Properties['eventHubLocation']) {
                $existingLocationParam = $existingParams.eventHubLocation
                if ($existingLocationParam.PSObject.Properties['allowedValues']) {
                    Write-SubStep "  Existing policy has region restriction - will update" "Yellow"
                    $needsUpdate = $true
                }
            }

            if (-not $needsUpdate) {
                Write-SubStep "  Community policy already exists in Azure" "Green"
                # Handle both Az module structures for PolicyDefinitionId
                $hasIdProperty = $null -ne $existingPolicy.PSObject.Properties['PolicyDefinitionId']
                $policyId = if ($hasIdProperty) { $existingPolicy.PolicyDefinitionId } else { $existingPolicy.Id }
                return $policyId
            }
        }
    } catch {
        # Policy doesn't exist, proceed with creation
    }

    try {
        # Extract policy components from community policy format
        # Community policies typically have: name, properties.displayName, properties.policyRule, properties.parameters
        $displayName = $null
        $description = $null
        $policyRule = $null
        $policyParameters = $null
        $mode = "Indexed"

        # Handle different policy JSON structures
        if ($PolicyContent.PSObject.Properties['properties']) {
            # Standard Azure policy format: { name: "", properties: { displayName, policyRule, parameters } }
            $props = $PolicyContent.properties
            $displayName = $props.displayName
            $description = $props.description
            $policyRule = $props.policyRule
            $policyParameters = $props.parameters
            if ($props.PSObject.Properties['mode']) {
                $mode = $props.mode
            }
        } else {
            # Flat format: { displayName, policyRule, parameters }
            $displayName = $PolicyContent.displayName
            $description = $PolicyContent.description
            $policyRule = $PolicyContent.policyRule
            $policyParameters = $PolicyContent.parameters
            if ($PolicyContent.PSObject.Properties['mode']) {
                $mode = $PolicyContent.mode
            }
        }

        if (-not $policyRule) {
            Write-SubStep "  Invalid policy format: no policyRule found" "Red"
            return $null
        }

        # Modify policy parameters to remove region restrictions and configure for deployment mode
        # Community policies often have hardcoded allowedValues for eventHubLocation
        # The policy logic uses: if eventHubLocation is "" (empty), apply to ALL resources
        #                        if eventHubLocation has a value, apply only to resources in that region
        if ($policyParameters) {
            # Check for eventHubLocation parameter (used by storage service policies)
            if ($policyParameters.PSObject.Properties['eventHubLocation']) {
                $locationParam = $policyParameters.eventHubLocation

                # Remove allowedValues restriction if present
                if ($locationParam.PSObject.Properties['allowedValues']) {
                    $locationParam.PSObject.Properties.Remove('allowedValues')
                    Write-SubStep "  Removed region restriction from eventHubLocation parameter" "Gray"
                }

                # Determine the location value based on deployment mode
                # Centralized mode: Use empty string "" to apply to ALL resources in ALL regions
                # Regional mode: Use specific region to apply only to resources in that region
                $locationValue = if ($DeploymentMode -eq "Centralized") {
                    ""  # Empty string = apply to ALL regions (policy condition: anyOf equals "")
                } else {
                    $azureParams.centralizedRegion  # Specific region for multi-region mode
                }

                # Update default value
                if ($locationParam.PSObject.Properties['defaultValue']) {
                    $locationParam.defaultValue = $locationValue
                } else {
                    $locationParam | Add-Member -NotePropertyName 'defaultValue' -NotePropertyValue $locationValue -Force
                }

                if ($locationValue -eq "") {
                    Write-SubStep "  Set eventHubLocation to ALL regions (Centralized mode)" "Gray"
                } else {
                    Write-SubStep "  Set eventHubLocation to: $locationValue (Regional mode)" "Gray"
                }
            }
        }

        # Build description with attribution, respecting Azure's 512 character limit
        $attribution = " [Imported from Azure Community-Policy by Cribl]"
        $maxDescLength = 512 - $attribution.Length
        if ($description.Length -gt $maxDescLength) {
            $description = $description.Substring(0, $maxDescLength - 3) + "..."
        }
        $finalDescription = "$description$attribution"

        # Truncate display name if needed (Azure limit is 128 characters)
        $finalDisplayName = "$displayName (Community - Cribl)"
        if ($finalDisplayName.Length -gt 128) {
            $finalDisplayName = $finalDisplayName.Substring(0, 125) + "..."
        }

        # Create or update the policy definition
        if ($needsUpdate -and $existingPolicy) {
            # Update existing policy to remove region restriction
            Write-SubStep "  Updating existing policy to remove region restriction..." "Cyan"
            $policyDefinition = Set-AzPolicyDefinition `
                -Name $policyName `
                -DisplayName $finalDisplayName `
                -Description $finalDescription `
                -Policy ($policyRule | ConvertTo-Json -Depth 30) `
                -Parameter ($policyParameters | ConvertTo-Json -Depth 20) `
                -Mode $mode `
                -ManagementGroupName $ManagementGroupId `
                -ErrorAction Stop
            Write-SubStep "  Successfully updated community policy" "Green"
        } else {
            # Create new policy
            $policyDefinition = New-AzPolicyDefinition `
                -Name $policyName `
                -DisplayName $finalDisplayName `
                -Description $finalDescription `
                -Policy ($policyRule | ConvertTo-Json -Depth 30) `
                -Parameter ($policyParameters | ConvertTo-Json -Depth 20) `
                -Mode $mode `
                -ManagementGroupName $ManagementGroupId `
                -ErrorAction Stop
            Write-SubStep "  Successfully imported community policy" "Green"
        }

        # Handle both Az module structures for PolicyDefinitionId
        $hasIdProperty = $null -ne $policyDefinition.PSObject.Properties['PolicyDefinitionId']
        $policyId = if ($hasIdProperty) { $policyDefinition.PolicyDefinitionId } else { $policyDefinition.Id }

        Write-SubStep "  Policy ID: $policyId" "Gray"

        return $policyId

    } catch {
        Write-SubStep "  Failed to import community policy: $_" "Red"
        return $null
    }
}

function New-CustomStoragePolicy {
    <#
    .SYNOPSIS
        Creates a custom policy for a storage service type when the built-in policy is unavailable.
    .DESCRIPTION
        Generates and deploys a custom Azure Policy that mirrors the functionality of
        the built-in diagnostic settings policies for storage services.
    #>
    param(
        [Parameter(Mandatory=$true)]
        [ValidateSet("BlobServices", "FileServices", "QueueServices", "TableServices")]
        [string]$ServiceType
    )

    $policyConfig = $script:StoragePolicies[$ServiceType]
    $policyName = "Cribl-$ServiceType-DiagSettings-EventHub"
    $resourceType = $policyConfig.ResourceType

    Write-SubStep "Creating custom policy: $policyName" "Cyan"

    # Check if custom policy already exists
    try {
        $existingPolicy = Get-AzPolicyDefinition -Name $policyName -ManagementGroupName $azureParams.managementGroupId -ErrorAction SilentlyContinue
        if ($existingPolicy) {
            Write-SubStep "  Custom policy already exists" "Green"
            # Handle both Az module structures for PolicyDefinitionId
            $hasIdProperty = $null -ne $existingPolicy.PSObject.Properties['PolicyDefinitionId']
            $policyId = if ($hasIdProperty) { $existingPolicy.PolicyDefinitionId } else { $existingPolicy.Id }
            $script:StoragePolicies[$ServiceType].PolicyDefinitionId = $policyId
            $script:StoragePolicies[$ServiceType].IsCustom = $true
            return $policyId
        }
    } catch {
        # Policy doesn't exist, create it
    }

    # Map resource type to ARM template resource type
    $armResourceType = switch ($ServiceType) {
        "BlobServices" { "Microsoft.Storage/storageAccounts/blobServices/providers/diagnosticSettings" }
        "FileServices" { "Microsoft.Storage/storageAccounts/fileServices/providers/diagnosticSettings" }
        "QueueServices" { "Microsoft.Storage/storageAccounts/queueServices/providers/diagnosticSettings" }
        "TableServices" { "Microsoft.Storage/storageAccounts/tableServices/providers/diagnosticSettings" }
    }

    # Custom policy definition matching the pattern of built-in storage policies
    $policyRule = @{
        if = @{
            allOf = @(
                @{
                    field = "type"
                    equals = $resourceType
                }
            )
        }
        then = @{
            effect = "[parameters('effect')]"
            details = @{
                type = "Microsoft.Insights/diagnosticSettings"
                name = "[parameters('profileName')]"
                existenceCondition = @{
                    allOf = @(
                        @{
                            field = "Microsoft.Insights/diagnosticSettings/logs.enabled"
                            equals = "true"
                        }
                        @{
                            field = "Microsoft.Insights/diagnosticSettings/eventHubAuthorizationRuleId"
                            equals = "[parameters('eventHubAuthorizationRuleId')]"
                        }
                    )
                }
                roleDefinitionIds = @(
                    "/providers/microsoft.authorization/roleDefinitions/749f88d5-cbae-40b8-bcfc-e573ddc772fa"
                    "/providers/microsoft.authorization/roleDefinitions/92aaf0da-9dab-42b6-94a3-d43ce8d16293"
                )
                deployment = @{
                    properties = @{
                        mode = "incremental"
                        template = @{
                            '$schema' = "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#"
                            contentVersion = "1.0.0.0"
                            parameters = @{
                                resourceName = @{ type = "string" }
                                eventHubAuthorizationRuleId = @{ type = "string" }
                                eventHubName = @{ type = "string" }
                                profileName = @{ type = "string" }
                                location = @{ type = "string" }
                            }
                            resources = @(
                                @{
                                    type = $armResourceType
                                    apiVersion = "2021-05-01-preview"
                                    name = "[concat(parameters('resourceName'), '/Microsoft.Insights/', parameters('profileName'))]"
                                    location = "[parameters('location')]"
                                    properties = @{
                                        eventHubAuthorizationRuleId = "[parameters('eventHubAuthorizationRuleId')]"
                                        eventHubName = "[parameters('eventHubName')]"
                                        logs = @(
                                            @{ category = "StorageRead"; enabled = $true }
                                            @{ category = "StorageWrite"; enabled = $true }
                                            @{ category = "StorageDelete"; enabled = $true }
                                        )
                                        metrics = @(
                                            @{ category = "Transaction"; enabled = $false }
                                        )
                                    }
                                }
                            )
                        }
                        parameters = @{
                            resourceName = @{ value = "[field('fullName')]" }
                            eventHubAuthorizationRuleId = @{ value = "[parameters('eventHubAuthorizationRuleId')]" }
                            eventHubName = @{ value = "[parameters('eventHubName')]" }
                            profileName = @{ value = "[parameters('profileName')]" }
                            location = @{ value = "[field('location')]" }
                        }
                    }
                }
            }
        }
    }

    $policyParameters = @{
        effect = @{
            type = "String"
            metadata = @{
                displayName = "Effect"
                description = "Enable or disable the execution of the policy"
            }
            allowedValues = @("DeployIfNotExists", "Disabled")
            defaultValue = "DeployIfNotExists"
        }
        profileName = @{
            type = "String"
            metadata = @{
                displayName = "Profile name"
                description = "The diagnostic settings profile name"
            }
            defaultValue = "setByPolicy-EventHub"
        }
        eventHubAuthorizationRuleId = @{
            type = "String"
            metadata = @{
                displayName = "Event Hub Authorization Rule Id"
                description = "The Event Hub authorization rule Id for Azure Diagnostics"
                strongType = "Microsoft.EventHub/namespaces/authorizationRules"
                assignPermissions = $true
            }
        }
        eventHubName = @{
            type = "String"
            metadata = @{
                displayName = "Event Hub Name"
                description = "The Event Hub name to stream to (leave empty for auto-creation)"
            }
            defaultValue = ""
        }
    }

    try {
        $policyDefinition = New-AzPolicyDefinition `
            -Name $policyName `
            -DisplayName "Configure diagnostic settings for $ServiceType to Event Hub (Custom - Cribl)" `
            -Description "Custom policy created by Cribl Azure Log Collection. Deploys diagnostic settings for Storage $ServiceType to stream StorageRead, StorageWrite, StorageDelete logs to Event Hub. Created because the built-in policy was unavailable." `
            -Policy ($policyRule | ConvertTo-Json -Depth 30) `
            -Parameter ($policyParameters | ConvertTo-Json -Depth 10) `
            -Mode "Indexed" `
            -ManagementGroupName $azureParams.managementGroupId `
            -ErrorAction Stop

        Write-SubStep "  Created custom policy: $policyName" "Green"

        # Handle both Az module structures for PolicyDefinitionId
        $hasIdProperty = $null -ne $policyDefinition.PSObject.Properties['PolicyDefinitionId']
        $policyId = if ($hasIdProperty) { $policyDefinition.PolicyDefinitionId } else { $policyDefinition.Id }

        # Update the policy config
        $script:StoragePolicies[$ServiceType].PolicyDefinitionId = $policyId
        $script:StoragePolicies[$ServiceType].IsCustom = $true

        return $policyId

    } catch {
        Write-SubStep "  Failed to create custom policy: $_" "Red"
        return $null
    }
}

function Get-ServicesToProcess {
    <#
    .SYNOPSIS
        Determines which services to process based on parameters.
    .DESCRIPTION
        If SpecificServices is provided, uses those.
        Otherwise, builds list from PolicyTiers parameter.
    #>

    $servicesToProcess = @()

    if ($SpecificServices -and $SpecificServices.Count -gt 0) {
        # Use specific services if provided
        foreach ($svc in $SpecificServices) {
            if ($script:CommunityPolicyPaths.ContainsKey($svc)) {
                $servicesToProcess += $svc
            } else {
                Write-SubStep "  Unknown service: $svc (skipping)" "Yellow"
            }
        }
    } else {
        # Build from PolicyTiers
        $tiersToProcess = if ($PolicyTiers -contains "All") {
            $script:CommunityPolicyTiers.Keys
        } else {
            $PolicyTiers
        }

        foreach ($tier in $tiersToProcess) {
            if ($script:CommunityPolicyTiers.ContainsKey($tier)) {
                $servicesToProcess += $script:CommunityPolicyTiers[$tier].Services
            }
        }
    }

    return $servicesToProcess | Select-Object -Unique
}

function Initialize-PolicyDefinitions {
    <#
    .SYNOPSIS
        Initializes policy definitions by discovering or importing policy IDs.
    .DESCRIPTION
        Policy discovery follows this priority order:
        1. Check if community policy already exists in Azure (previously imported)
        2. Search Azure/Community-Policy GitHub repo and import if found
        3. Fall back to custom policy creation for storage services only
        4. For Activity Log, search for built-in Azure policies

        Supports tiered deployment:
        - Storage: Blob, File, Queue, Table services
        - Security: AKS, Firewall, NSG, Application Gateway, ExpressRoute, Virtual Network
        - Data: Cosmos DB, Data Factory, databases, Synapse, etc.
        - Compute: App Service, Functions, Batch, ML, etc.
        - Integration: Logic Apps, Event Grid, Relay
        - Networking: Load Balancer, Traffic Manager, CDN
        - AVD: Host Pool, Application Group, Workspace, Scaling Plan
        - Other: Recovery Services, FHIR, Power BI

        Source: https://github.com/Azure/Community-Policy/tree/main/policyDefinitions/Monitoring/To%20Event%20Hub
    #>

    Write-StepHeader "Discovering Policy Definitions"

    # Track results
    $discoveredCount = 0
    $importedCount = 0
    $customCreatedCount = 0
    $failedCount = 0
    $skippedCount = 0

    # Initialize the imported policies hashtable
    $script:ImportedPolicies = @{}

    # Determine which services to process
    $servicesToProcess = Get-ServicesToProcess

    if ($servicesToProcess.Count -eq 0) {
        Write-SubStep "No services selected for policy deployment" "Yellow"
        return @{
            Discovered = 0
            Imported = 0
            CustomCreated = 0
            Skipped = 0
            Failed = 0
        }
    }

    # Display what we're processing
    Write-Host ""
    Write-SubStep "Community Policy Import" "Cyan"
    Write-SubStep "  Source: Azure/Community-Policy GitHub repository" "Gray"
    Write-SubStep "  Note: These are NOT built-in Azure policies - they will be imported to your management group" "Gray"
    Write-Host ""

    # Show tiers being processed
    if (-not $SpecificServices) {
        $tiersToShow = if ($PolicyTiers -contains "All") { $script:CommunityPolicyTiers.Keys | Sort-Object { $script:CommunityPolicyTiers[$_].Priority } } else { $PolicyTiers }
        Write-SubStep "Policy Tiers Selected:" "Cyan"
        foreach ($tier in $tiersToShow) {
            if ($script:CommunityPolicyTiers.ContainsKey($tier)) {
                $tierInfo = $script:CommunityPolicyTiers[$tier]
                Write-SubStep "  [$tier] $($tierInfo.Description) ($($tierInfo.Services.Count) services)" "Gray"
            }
        }
        Write-Host ""
    }

    Write-SubStep "Processing $($servicesToProcess.Count) service(s)..." "Cyan"
    Write-Host ""

    # Group services by tier for organized output
    $servicesByTier = @{}
    foreach ($svc in $servicesToProcess) {
        $tierName = "Other"
        foreach ($tier in $script:CommunityPolicyTiers.Keys) {
            if ($script:CommunityPolicyTiers[$tier].Services -contains $svc) {
                $tierName = $tier
                break
            }
        }
        if (-not $servicesByTier.ContainsKey($tierName)) {
            $servicesByTier[$tierName] = @()
        }
        $servicesByTier[$tierName] += $svc
    }

    # Process each tier
    foreach ($tierName in ($servicesByTier.Keys | Sort-Object { $script:CommunityPolicyTiers[$_].Priority })) {
        $tierServices = $servicesByTier[$tierName]
        $tierInfo = $script:CommunityPolicyTiers[$tierName]

        Write-SubStep "[$tierName] $($tierInfo.Description)" "Cyan"

        foreach ($serviceType in $tierServices) {
            Write-SubStep "  Processing: $serviceType..." "White"

            $policyId = $null
            $metadata = $script:CommunityPolicyMetadata[$serviceType]

            # Step 1: Check if community policy already exists in Azure
            $communityPolicyName = "Cribl-Community-$serviceType-DiagSettings-EventHub"
            $needsUpdate = $false
            try {
                $existingPolicy = Get-AzPolicyDefinition -Name $communityPolicyName -ManagementGroupName $azureParams.managementGroupId -ErrorAction SilentlyContinue
                if ($existingPolicy) {
                    # Check if existing policy has region restriction that needs to be removed
                    # Note: Az module uses 'Parameter' (singular), not 'Parameters' (plural)
                    $existingParams = $null
                    if ($existingPolicy.PSObject.Properties['Properties'] -and $existingPolicy.Properties.PSObject.Properties['Parameters']) {
                        $existingParams = $existingPolicy.Properties.Parameters
                    } elseif ($existingPolicy.PSObject.Properties['Parameters']) {
                        $existingParams = $existingPolicy.Parameters
                    } elseif ($existingPolicy.PSObject.Properties['Parameter']) {
                        # Az module returns 'Parameter' (singular)
                        $existingParams = $existingPolicy.Parameter
                    }

                    if ($existingParams -and $existingParams.PSObject.Properties['eventHubLocation']) {
                        $existingLocationParam = $existingParams.eventHubLocation
                        if ($existingLocationParam.PSObject.Properties['allowedValues']) {
                            Write-SubStep "    Found existing policy with region restriction - will update" "Yellow"
                            $needsUpdate = $true
                        }
                    }

                    if (-not $needsUpdate) {
                        $hasIdProperty = $null -ne $existingPolicy.PSObject.Properties['PolicyDefinitionId']
                        $policyId = if ($hasIdProperty) { $existingPolicy.PolicyDefinitionId } else { $existingPolicy.Id }
                        Write-SubStep "    Found existing policy in Azure" "Green"
                        $discoveredCount++
                    }
                }
            } catch {
                # Policy doesn't exist, continue to import
            }

            # Step 2: If not found OR needs update, search Community-Policy repo and import/update
            if (-not $policyId -or $needsUpdate) {
                $communityPolicy = Search-CommunityPolicyRepo -ServiceType $serviceType
                if ($communityPolicy) {
                    $policyId = Import-CommunityPolicyDefinition `
                        -PolicyContent $communityPolicy `
                        -ServiceType $serviceType `
                        -ManagementGroupId $azureParams.managementGroupId

                    if ($policyId) {
                        Write-SubStep "    Imported from community repo" "Green"
                        $importedCount++
                    } else {
                        Write-SubStep "    Failed to import" "Yellow"
                    }
                } else {
                    Write-SubStep "    Community policy not found in GitHub" "Yellow"
                }
            }

            # Step 3: For storage services only, fall back to custom policy creation
            if (-not $policyId -and $tierName -eq "Storage" -and $serviceType -in @("BlobServices", "FileServices", "QueueServices", "TableServices")) {
                Write-SubStep "    Creating custom policy as fallback..." "Yellow"
                $policyId = New-CustomStoragePolicy -ServiceType $serviceType
                if ($policyId) {
                    Write-SubStep "    Created custom policy" "Green"
                    $customCreatedCount++
                } else {
                    Write-SubStep "    Failed to create policy" "Red"
                    $failedCount++
                }
            } elseif (-not $policyId) {
                Write-SubStep "    No policy available for $serviceType" "Red"
                $failedCount++
            }

            # Store the policy ID
            if ($policyId) {
                $script:ImportedPolicies[$serviceType] = @{
                    PolicyDefinitionId = $policyId
                    ServiceType = $serviceType
                    ResourceType = $metadata.ResourceType
                    AssignmentPrefix = $metadata.AssignmentPrefix
                    IsCommunity = $policyId -match "Cribl-Community"
                    IsCustom = $policyId -match "Cribl-"
                    Tier = $tierName
                }

                # Also update StoragePolicies if it's a storage service
                if ($script:StoragePolicies.ContainsKey($serviceType)) {
                    $script:StoragePolicies[$serviceType].PolicyDefinitionId = $policyId
                    $script:StoragePolicies[$serviceType].IsCustom = $true
                    $script:StoragePolicies[$serviceType].IsCommunity = $policyId -match "Cribl-Community"
                }
            }
        }

        Write-Host ""
    }

    # Activity Log - use community policy (NO built-in Azure Policy exists for Activity Log to Event Hub)
    # Note: Check both flags since -ActivityLogOnly runs this script WITHOUT -IncludeActivityLog
    if ($IncludeActivityLog -or $ActivityLogOnly) {
        Write-SubStep "Activity Log Policy" "Cyan"
        Write-SubStep "  Source: Azure Community-Policy repository" "Gray"
        Write-SubStep "  Note: No built-in Azure Policy exists for Activity Log to Event Hub" "Gray"

        $activityLogPolicyId = $null
        $serviceType = "ActivityLog"
        $communityPolicyName = "Cribl-Community-$serviceType-DiagSettings-EventHub"

        # Step 1: Check if community policy already exists in Azure (previously imported)
        try {
            $existingPolicy = Get-AzPolicyDefinition -Name $communityPolicyName -ManagementGroupName $azureParams.managementGroupId -ErrorAction SilentlyContinue
            if ($existingPolicy) {
                $hasIdProperty = $null -ne $existingPolicy.PSObject.Properties['PolicyDefinitionId']
                $activityLogPolicyId = if ($hasIdProperty) { $existingPolicy.PolicyDefinitionId } else { $existingPolicy.Id }
                Write-SubStep "  Found existing policy in Azure" "Green"
                $discoveredCount++
            }
        } catch {
            # Policy doesn't exist, continue to import
        }

        # Step 2: If not found, search Community-Policy repo and import
        if (-not $activityLogPolicyId) {
            $communityPolicy = Search-CommunityPolicyRepo -ServiceType $serviceType
            if ($communityPolicy) {
                $activityLogPolicyId = Import-CommunityPolicyDefinition `
                    -PolicyContent $communityPolicy `
                    -ServiceType $serviceType `
                    -ManagementGroupId $azureParams.managementGroupId

                if ($activityLogPolicyId) {
                    Write-SubStep "  Imported from community repo" "Green"
                    $importedCount++
                } else {
                    Write-SubStep "  Failed to import community policy" "Red"
                    $failedCount++
                }
            } else {
                Write-SubStep "  Community policy not found in GitHub" "Red"
                $failedCount++
            }
        }

        # Store the policy ID
        $script:ActivityLogPolicy.PolicyDefinitionId = $activityLogPolicyId

        if ($activityLogPolicyId) {
            Write-SubStep "  Activity Log: Policy ready" "Green"
        } else {
            Write-SubStep "  Activity Log: No policy available" "Yellow"
        }
        Write-Host ""
    }

    # Final summary
    $totalRequested = $servicesToProcess.Count + $(if ($IncludeActivityLog -or $ActivityLogOnly) { 1 } else { 0 })
    $totalSuccess = $discoveredCount + $importedCount + $customCreatedCount

    Write-Host "  ============================================================" -ForegroundColor Cyan
    Write-SubStep "Policy Initialization Summary" "Cyan"
    Write-Host "  ============================================================" -ForegroundColor Cyan
    if ($discoveredCount -gt 0) {
        Write-SubStep "  Found existing in Azure: $discoveredCount" "Green"
    }
    if ($importedCount -gt 0) {
        Write-SubStep "  Imported from community repo: $importedCount" "Green"
    }
    if ($customCreatedCount -gt 0) {
        Write-SubStep "  Custom policies created: $customCreatedCount" "Green"
    }
    if ($failedCount -gt 0) {
        Write-SubStep "  Failed: $failedCount" "Red"
    }
    Write-SubStep "  Total policies available: $totalSuccess / $totalRequested" "Cyan"

    # If we have critical failures, prompt user
    if ($failedCount -gt 0) {
        Write-Host ""
        Write-Host "  WARNING: Some policies could not be initialized." -ForegroundColor Yellow
        Write-Host "  Resources without policies will NOT have automatic diagnostic settings deployment." -ForegroundColor Yellow
        Write-Host ""

        $continue = Read-Host "  Continue with available policies? (Y/N)"
        if ($continue -ne "Y" -and $continue -ne "y") {
            Write-Host ""
            Write-Host "  Exiting policy initialization." -ForegroundColor Yellow
            exit 0
        }
    }

    return @{
        Discovered = $discoveredCount
        Imported = $importedCount
        CustomCreated = $customCreatedCount
        Skipped = $skippedCount
        Failed = $failedCount
        TotalServices = $servicesToProcess.Count
        ImportedPolicies = $script:ImportedPolicies
    }
}

# Storage Service Policies
# Policy IDs are discovered/imported at runtime using Initialize-PolicyDefinitions
# Priority: 1) Existing community policy in Azure 2) Import from Community-Policy repo 3) Create custom
# Source: https://github.com/Azure/Community-Policy/tree/main/policyDefinitions/Monitoring/To%20Event%20Hub
$script:StoragePolicies = @{
    "BlobServices" = @{
        PolicyDefinitionId = $null  # Discovered/imported at runtime
        DisplayName = "Configure diagnostic settings for Blob Services to Event Hub"
        Description = "Deploys diagnostic settings for Blob Services to stream StorageRead, StorageWrite, StorageDelete logs to Event Hub"
        ResourceType = "Microsoft.Storage/storageAccounts/blobServices"
        LogCategories = @("StorageRead", "StorageWrite", "StorageDelete")
        AssignmentPrefix = "Cribl-Blob"
        IsCustom = $false
        IsCommunity = $false
    }
    "FileServices" = @{
        PolicyDefinitionId = $null  # Discovered/imported at runtime
        DisplayName = "Configure diagnostic settings for File Services to Event Hub"
        Description = "Deploys diagnostic settings for File Services to stream StorageRead, StorageWrite, StorageDelete logs to Event Hub"
        ResourceType = "Microsoft.Storage/storageAccounts/fileServices"
        LogCategories = @("StorageRead", "StorageWrite", "StorageDelete")
        AssignmentPrefix = "Cribl-File"
        IsCustom = $false
        IsCommunity = $false
    }
    "QueueServices" = @{
        PolicyDefinitionId = $null  # Discovered/imported at runtime
        DisplayName = "Configure diagnostic settings for Queue Services to Event Hub"
        Description = "Deploys diagnostic settings for Queue Services to stream StorageRead, StorageWrite, StorageDelete logs to Event Hub"
        ResourceType = "Microsoft.Storage/storageAccounts/queueServices"
        LogCategories = @("StorageRead", "StorageWrite", "StorageDelete")
        AssignmentPrefix = "Cribl-Queue"
        IsCustom = $false
        IsCommunity = $false
    }
    "TableServices" = @{
        PolicyDefinitionId = $null  # Discovered/imported at runtime
        DisplayName = "Configure diagnostic settings for Table Services to Event Hub"
        Description = "Deploys diagnostic settings for Table Services to stream StorageRead, StorageWrite, StorageDelete logs to Event Hub"
        ResourceType = "Microsoft.Storage/storageAccounts/tableServices"
        LogCategories = @("StorageRead", "StorageWrite", "StorageDelete")
        AssignmentPrefix = "Cribl-Table"
        IsCustom = $false
        IsCommunity = $false
    }
}

# Activity Log Policy (Subscription-level control plane logging)
# Policy ID is discovered at runtime
$script:ActivityLogPolicy = @{
    PolicyDefinitionId = $null  # Discovered at runtime
    DisplayName = "Configure Azure Activity logs to stream to specified Event Hub"
    Description = "Deploys diagnostic settings for Azure Activity to stream subscription audit logs to Event Hub"
    AssignmentName = "Cribl-ActivityLog"
}

#endregion

# Load configuration
$azureParamsFile = Join-Path $ScriptPath "azure-parameters.json"

if (-not (Test-Path $azureParamsFile)) {
    Write-Error "azure-parameters.json not found at: $azureParamsFile"
    exit 1
}

try {
    $azureParams = Get-Content $azureParamsFile | ConvertFrom-Json
} catch {
    Write-Error "Failed to parse azure-parameters.json: $_"
    exit 1
}

# Initialize summary
$script:summary = @{
    StoragePoliciesCreated = 0
    StoragePoliciesExisted = 0
    StoragePoliciesFailed = 0
    ActivityLogCreated = 0
    ActivityLogExisted = 0
    ActivityLogFailed = 0
    RoleAssignmentsCreated = 0
    SubscriptionsProcessed = 0
    RemediationTasksCreated = 0
    RemediationTasksFailed = 0
}

#region Helper Functions

function Write-StepHeader {
    param([string]$Message)
    Write-Host "`n$('='*80)" -ForegroundColor Cyan
    Write-Host "  $Message" -ForegroundColor Cyan
    Write-Host "$('='*80)" -ForegroundColor Cyan
    # Also log to file if logging is enabled
    if (Get-Command Write-ToLog -ErrorAction SilentlyContinue) {
        Write-ToLog -Message "========== $Message ==========" -Level "INFO"
    }
}

function Write-SubStep {
    param([string]$Message, [string]$Color = "White")
    Write-Host "    $Message" -ForegroundColor $Color
    # Also log to file if logging is enabled
    if (Get-Command Write-ToLog -ErrorAction SilentlyContinue) {
        $level = switch ($Color) {
            "Red" { "ERROR" }
            "Yellow" { "WARNING" }
            "Green" { "SUCCESS" }
            default { "INFO" }
        }
        Write-ToLog -Message $Message -Level $level
    }
}

function Connect-ToAzure {
    Write-StepHeader "Connecting to Azure"

    try {
        $context = Get-AzContext
        if (-not $context) {
            Write-SubStep "No active Azure context found. Please run Connect-AzAccount first." "Red"
            exit 1
        }

        Write-SubStep "Connected to Azure" "Green"
        Write-SubStep "Account: $($context.Account.Id)" "Gray"
        Write-SubStep "Subscription: $($context.Subscription.Name)" "Gray"

        return $true
    } catch {
        Write-SubStep "Failed to connect to Azure: $_" "Red"
        return $false
    }
}

function Get-SubscriptionIdShort {
    return $azureParams.eventHubSubscriptionId.Substring(0, 8).ToLower()
}

function Get-PolicyAssignmentParams {
    <#
    .SYNOPSIS
        Builds policy assignment parameters dynamically based on what the policy definition expects.
    .DESCRIPTION
        Azure policy parameter names change over time. This function inspects the policy definition
        to determine the correct parameter names and builds the parameter object accordingly.
    #>
    param(
        [Parameter(Mandatory=$true)]
        $PolicyDefinition,

        [Parameter(Mandatory=$true)]
        [string]$EventHubAuthRuleId,

        [Parameter(Mandatory=$false)]
        [string]$EventHubName = "",

        [Parameter(Mandatory=$false)]
        [string]$ProfileName = "setbycriblpolicy",

        [Parameter(Mandatory=$false)]
        [string]$ResourceLocation = ""
    )

    $assignmentParams = @{}

    # Get the policy parameters - use defensive checks for StrictMode compatibility
    # Different Az module versions return different structures:
    # - Older: $policy.Properties.Parameters
    # - Newer: $policy.Parameters directly
    $policyParams = $null
    $paramNames = @()

    # Method 1: Check if Properties property exists and has Parameters
    $hasPropertiesProperty = $false
    try {
        $hasPropertiesProperty = $null -ne $PolicyDefinition.PSObject.Properties['Properties']
    } catch {
        # PSObject.Properties access failed - continue to other methods
    }

    if ($hasPropertiesProperty) {
        try {
            $propsValue = $PolicyDefinition.Properties
            if ($null -ne $propsValue) {
                $hasParamsInProps = $null -ne $propsValue.PSObject.Properties['Parameters']
                if ($hasParamsInProps) {
                    $policyParams = $propsValue.Parameters
                    Write-DebugLog -Message "Found parameters via Properties.Parameters" -Context "Get-PolicyAssignmentParams"
                }
            }
        } catch {
            Write-DebugLog -Message "Error accessing Properties.Parameters: $_" -Context "Get-PolicyAssignmentParams"
        }
    }

    # Method 2: Check if direct Parameters property exists
    if ($null -eq $policyParams) {
        $hasDirectParams = $false
        try {
            $hasDirectParams = $null -ne $PolicyDefinition.PSObject.Properties['Parameters']
        } catch {
            # PSObject.Properties access failed
        }

        if ($hasDirectParams) {
            try {
                $policyParams = $PolicyDefinition.Parameters
                Write-DebugLog -Message "Found parameters via direct Parameters property" -Context "Get-PolicyAssignmentParams"
            } catch {
                Write-DebugLog -Message "Error accessing direct Parameters: $_" -Context "Get-PolicyAssignmentParams"
            }
        }
    }

    # Method 3: Check for 'Parameter' (singular) - Az module uses this naming
    if ($null -eq $policyParams) {
        $hasSingularParam = $false
        try {
            $hasSingularParam = $null -ne $PolicyDefinition.PSObject.Properties['Parameter']
        } catch { }

        if ($hasSingularParam) {
            try {
                $policyParams = $PolicyDefinition.Parameter
                Write-DebugLog -Message "Found parameters via direct Parameter (singular) property" -Context "Get-PolicyAssignmentParams"
            } catch {
                Write-DebugLog -Message "Error accessing Parameter (singular): $_" -Context "Get-PolicyAssignmentParams"
            }
        }
    }

    # Method 4: Try using Get-Member as last resort
    if ($null -eq $policyParams) {
        try {
            $members = Get-Member -InputObject $PolicyDefinition -MemberType Properties -ErrorAction SilentlyContinue
            $memberNames = @($members | ForEach-Object { $_.Name })
            Write-DebugLog -Message "PolicyDefinition members: $($memberNames -join ', ')" -Context "Get-PolicyAssignmentParams"

            if ($memberNames -contains 'Parameter') {
                # Az module uses 'Parameter' (singular)
                $policyParams = $PolicyDefinition.Parameter
                Write-DebugLog -Message "Found parameters via Get-Member Parameter (singular) check" -Context "Get-PolicyAssignmentParams"
            } elseif ($memberNames -contains 'Parameters') {
                $policyParams = $PolicyDefinition.Parameters
                Write-DebugLog -Message "Found parameters via Get-Member Parameters check" -Context "Get-PolicyAssignmentParams"
            } elseif ($memberNames -contains 'Properties') {
                $props = $PolicyDefinition.Properties
                if ($null -ne $props) {
                    $propsMembers = Get-Member -InputObject $props -MemberType Properties -ErrorAction SilentlyContinue
                    $propsMemberNames = @($propsMembers | ForEach-Object { $_.Name })
                    if ($propsMemberNames -contains 'Parameters') {
                        $policyParams = $props.Parameters
                        Write-DebugLog -Message "Found parameters via Get-Member Properties check" -Context "Get-PolicyAssignmentParams"
                    }
                }
            }
        } catch {
            Write-DebugLog -Message "Get-Member fallback failed: $_" -Context "Get-PolicyAssignmentParams"
        }
    }

    # Extract parameter names from whatever we got
    if ($null -ne $policyParams) {
        try {
            if ($policyParams -is [System.Collections.IDictionary]) {
                $paramNames = @($policyParams.Keys)
            } else {
                # Use Get-Member for safe property enumeration
                $policyParamsMembers = Get-Member -InputObject $policyParams -MemberType Properties -ErrorAction SilentlyContinue
                if ($policyParamsMembers) {
                    $paramNames = @($policyParamsMembers | ForEach-Object { $_.Name })
                }
            }
        } catch {
            Write-DebugLog -Message "Error extracting parameter names: $_" -Context "Get-PolicyAssignmentParams"
        }
    }

    Write-DebugLog -Message "Policy parameters found: $($paramNames -join ', ')" -Context "Get-PolicyAssignmentParams"

    if ($paramNames.Count -eq 0) {
        # Try one more method: Convert the entire policy definition to JSON and parse it
        try {
            $policyJson = $PolicyDefinition | ConvertTo-Json -Depth 10 -ErrorAction SilentlyContinue
            if ($policyJson) {
                # Look for parameter patterns in the JSON
                $foundParams = @()
                if ($policyJson -match '"eventHubRuleId"') { $foundParams += "eventHubRuleId" }
                if ($policyJson -match '"eventHubAuthorizationRuleId"') { $foundParams += "eventHubAuthorizationRuleId" }
                if ($policyJson -match '"eventHubName"') { $foundParams += "eventHubName" }
                if ($policyJson -match '"effect"') { $foundParams += "effect" }
                if ($policyJson -match '"profileName"') { $foundParams += "profileName" }
                if ($policyJson -match '"settingName"') { $foundParams += "settingName" }
                if ($policyJson -match '"resourceLocation"') { $foundParams += "resourceLocation" }
                if ($policyJson -match '"logsEnabled"') { $foundParams += "logsEnabled" }
                if ($policyJson -match '"metricsEnabled"') { $foundParams += "metricsEnabled" }

                if ($foundParams.Count -gt 0) {
                    $paramNames = $foundParams
                    Write-DebugLog -Message "Found parameters via JSON parsing: $($paramNames -join ', ')" -Context "Get-PolicyAssignmentParams"
                }
            }
        } catch {
            Write-DebugLog -Message "JSON parsing fallback failed: $_" -Context "Get-PolicyAssignmentParams"
        }
    }

    if ($paramNames.Count -eq 0) {
        Write-SubStep "  Warning: Could not read policy parameters - using default parameter names" "Yellow"
        # Fall back to common parameter names for community policies
        # Community policies typically use: eventHubRuleId, profileName, eventHubLocation
        # Built-in policies may use: eventHubAuthorizationRuleId, settingName, resourceLocation
        # We'll try to detect which set to use based on policy name
        $policyName = ""
        try {
            if ($PolicyDefinition.PSObject.Properties['Name']) {
                $policyName = $PolicyDefinition.Name
            } elseif ($PolicyDefinition.PSObject.Properties['DisplayName']) {
                $policyName = $PolicyDefinition.DisplayName
            }
        } catch { }

        if ($policyName -match "ActivityLog") {
            # Activity Log community policy uses different parameters than storage community policies
            # Uses eventHubAuthorizationRuleId (like built-in policies) NOT eventHubRuleId
            $paramNames = @("eventHubAuthorizationRuleId", "eventHubName", "effect", "profileName")
            Write-DebugLog -Message "Using Activity Log policy parameter names" -Context "Get-PolicyAssignmentParams"
        } elseif ($policyName -match "Community|Cribl-Community") {
            # Storage community policies - use community parameter names
            # These use eventHubRuleId, profileName, eventHubLocation
            $paramNames = @("eventHubRuleId", "eventHubName", "effect", "profileName", "eventHubLocation", "logsEnabled", "metricsEnabled")
            Write-DebugLog -Message "Using community storage policy parameter names" -Context "Get-PolicyAssignmentParams"
        } else {
            # Built-in policy - use built-in parameter names
            $paramNames = @("eventHubAuthorizationRuleId", "eventHubName", "effect", "profileName", "resourceLocation")
            Write-DebugLog -Message "Using built-in policy parameter names" -Context "Get-PolicyAssignmentParams"
        }
    } else {
        Write-DebugLog -Message "Successfully detected $($paramNames.Count) policy parameters: $($paramNames -join ', ')" -Context "Get-PolicyAssignmentParams"
    }

    # Map our values to the correct parameter names
    # Only add parameters that exist in the policy definition
    foreach ($paramName in $paramNames) {
        switch -Regex ($paramName) {
            # Event Hub authorization rule ID - various naming patterns (mutually exclusive)
            "^eventHubRuleId$" {
                $assignmentParams[$paramName] = $EventHubAuthRuleId
                Write-DebugLog -Message "  Mapped $paramName = $EventHubAuthRuleId" -Context "Get-PolicyAssignmentParams"
            }
            "^eventHubAuthorizationRuleId$" {
                $assignmentParams[$paramName] = $EventHubAuthRuleId
                Write-DebugLog -Message "  Mapped $paramName = $EventHubAuthRuleId" -Context "Get-PolicyAssignmentParams"
            }
            # Event Hub name
            "^eventHubName$" {
                $assignmentParams[$paramName] = $EventHubName
            }
            # Effect
            "^effect$" {
                $assignmentParams[$paramName] = "DeployIfNotExists"
            }
            # Profile name / diagnostic setting name (mutually exclusive)
            "^profileName$" {
                $assignmentParams[$paramName] = $ProfileName
            }
            "^settingName$" {
                $assignmentParams[$paramName] = $ProfileName
            }
            # Location parameters (mutually exclusive)
            # eventHubLocation is used by community policies
            # In Centralized mode: Use "" (empty) to apply policy to ALL regions
            # In Regional mode: Use specific region to filter resources
            "^eventHubLocation$" {
                if ($DeploymentMode -eq "Centralized") {
                    # Empty string means policy applies to ALL resources regardless of region
                    $assignmentParams[$paramName] = ""
                    Write-DebugLog -Message "  Mapped $paramName = '' (ALL regions - Centralized mode)" -Context "Get-PolicyAssignmentParams"
                } elseif ($ResourceLocation) {
                    $assignmentParams[$paramName] = $ResourceLocation
                } else {
                    $assignmentParams[$paramName] = $azureParams.centralizedRegion
                }
            }
            # resourceLocation is used by built-in policies
            "^resourceLocation$" {
                if ($ResourceLocation) {
                    $assignmentParams[$paramName] = $ResourceLocation
                } else {
                    $assignmentParams[$paramName] = $azureParams.centralizedRegion
                }
            }
            # Metrics enabled (typically false for log collection)
            "^metricsEnabled$" {
                $assignmentParams[$paramName] = $false
            }
            "^logsEnabled$" {
                $assignmentParams[$paramName] = $true
            }
        }
    }

    Write-DebugLog -Message "Built assignment params: $($assignmentParams.Keys -join ', ')" -Context "Get-PolicyAssignmentParams"
    return $assignmentParams
}

function Get-EventHubNamespaceName {
    param([string]$Region, [string]$Mode)

    $subIdShort = Get-SubscriptionIdShort

    if ($Mode -eq "Centralized") {
        if ($CentralizedNamespaceOverride) {
            return $CentralizedNamespaceOverride
        }
        if ($azureParams.centralizedNamespace) {
            return $azureParams.centralizedNamespace
        }
        return "$($azureParams.eventHubNamespacePrefix)-$subIdShort"
    } else {
        if ($RegionNamespacesOverride.ContainsKey($Region)) {
            return $RegionNamespacesOverride[$Region]
        }
        return "$($azureParams.eventHubNamespacePrefix)-$subIdShort-$Region"
    }
}

function Get-EventHubAuthorizationRuleId {
    param([string]$Region, [string]$Mode)

    $namespaceName = Get-EventHubNamespaceName -Region $Region -Mode $Mode

    return "/subscriptions/$($azureParams.eventHubSubscriptionId)/resourceGroups/$($azureParams.eventHubResourceGroup)/providers/Microsoft.EventHub/namespaces/$namespaceName/authorizationRules/RootManageSharedAccessKey"
}

function Get-OrCreateManagedIdentity {
    <#
    .SYNOPSIS
        Gets or creates the user-assigned managed identity for policy assignments.
    .DESCRIPTION
        Creates a shared user-assigned managed identity that will be used by all
        policy assignments in this solution. This eliminates the need to wait for
        identity propagation after each policy assignment.
    .RETURNS
        The managed identity object with Id and PrincipalId properties.
    .THROWS
        Throws an error if the identity cannot be created or retrieved.
    #>

    $identityName = "cribl-diag-policy-identity"
    $resourceGroup = $azureParams.eventHubResourceGroup
    $subscriptionId = $azureParams.eventHubSubscriptionId
    $location = $azureParams.centralizedRegion

    Write-SubStep "Checking for managed identity: $identityName" "Cyan"

    # Set subscription context
    try {
        Set-AzContext -SubscriptionId $subscriptionId -ErrorAction Stop | Out-Null
    } catch {
        $errorMsg = "Failed to set subscription context for managed identity: $_"
        Write-ErrorLog $errorMsg
        throw $errorMsg
    }

    # Check if identity already exists
    try {
        $existingIdentity = Get-AzUserAssignedIdentity -ResourceGroupName $resourceGroup -Name $identityName -ErrorAction SilentlyContinue

        if ($existingIdentity) {
            Write-SubStep "  Found existing managed identity" "Green"
            Write-SubStep "  Principal ID: $($existingIdentity.PrincipalId)" "Gray"
            return $existingIdentity
        }
    } catch {
        # Identity doesn't exist, will create it
    }

    # Create the identity
    Write-SubStep "  Creating user-assigned managed identity..." "Cyan"
    try {
        $newIdentity = New-AzUserAssignedIdentity `
            -ResourceGroupName $resourceGroup `
            -Name $identityName `
            -Location $location `
            -ErrorAction Stop

        Write-SubStep "  Created managed identity successfully" "Green"
        Write-SubStep "  Principal ID: $($newIdentity.PrincipalId)" "Gray"
        Write-SubStep "  Resource ID: $($newIdentity.Id)" "Gray"

        # Wait briefly for Azure AD propagation
        Write-SubStep "  Waiting for Azure AD propagation (15 seconds)..." "Gray"
        Start-Sleep -Seconds 15

        return $newIdentity

    } catch {
        $errorMsg = "Failed to create managed identity '$identityName': $_"
        Write-ErrorLog $errorMsg
        throw $errorMsg
    }
}

function Ensure-ManagedIdentityRoles {
    <#
    .SYNOPSIS
        Ensures the managed identity has the required RBAC roles.
    .DESCRIPTION
        Assigns Monitoring Contributor (at management group scope) and
        Azure Event Hubs Data Owner (at Event Hub namespace scope) roles
        to the managed identity if not already assigned.
    .PARAMETER PrincipalId
        The PrincipalId of the managed identity.
    .THROWS
        Throws an error if role assignments fail.
    #>
    param(
        [Parameter(Mandatory=$true)]
        [string]$PrincipalId
    )

    Write-SubStep "Ensuring RBAC roles for managed identity..." "Cyan"

    $mgScope = "/providers/Microsoft.Management/managementGroups/$($azureParams.managementGroupId)"
    $rolesAssigned = 0
    $rolesFailed = 0

    # Role 1: Monitoring Contributor at management group scope
    Write-SubStep "  Checking Monitoring Contributor role..." "Gray"
    try {
        $existingRole = Get-AzRoleAssignment -ObjectId $PrincipalId -Scope $mgScope -RoleDefinitionName "Monitoring Contributor" -ErrorAction SilentlyContinue

        if ($existingRole) {
            Write-SubStep "  Monitoring Contributor: Already assigned" "Green"
        } else {
            New-AzRoleAssignment -ObjectId $PrincipalId -Scope $mgScope -RoleDefinitionName "Monitoring Contributor" -ErrorAction Stop | Out-Null
            Write-SubStep "  Monitoring Contributor: Assigned" "Green"
            $rolesAssigned++
        }
    } catch {
        $errorMsg = "Failed to assign Monitoring Contributor role: $_"
        Write-ErrorLog $errorMsg
        $rolesFailed++
    }

    # Role 2: Azure Event Hubs Data Owner at Event Hub namespace scope
    # Data Owner is required because DeployIfNotExists policies need listkeys permission
    # Get the namespace name for centralized mode
    $namespaceName = Get-EventHubNamespaceName -Region $azureParams.centralizedRegion -Mode "Centralized"
    $ehScope = "/subscriptions/$($azureParams.eventHubSubscriptionId)/resourceGroups/$($azureParams.eventHubResourceGroup)/providers/Microsoft.EventHub/namespaces/$namespaceName"

    Write-SubStep "  Checking Event Hubs Data Owner role..." "Gray"
    try {
        $existingEhRole = Get-AzRoleAssignment -ObjectId $PrincipalId -Scope $ehScope -RoleDefinitionName "Azure Event Hubs Data Owner" -ErrorAction SilentlyContinue

        if ($existingEhRole) {
            Write-SubStep "  Event Hubs Data Owner: Already assigned" "Green"
        } else {
            New-AzRoleAssignment -ObjectId $PrincipalId -Scope $ehScope -RoleDefinitionName "Azure Event Hubs Data Owner" -ErrorAction Stop | Out-Null
            Write-SubStep "  Event Hubs Data Owner: Assigned" "Green"
            $rolesAssigned++
        }
    } catch {
        $errorMsg = "Failed to assign Event Hubs Data Owner role: $_"
        Write-ErrorLog $errorMsg
        $rolesFailed++
    }

    # Check for failures
    if ($rolesFailed -gt 0) {
        $errorMsg = "Failed to assign $rolesFailed RBAC role(s). Policy remediation will fail without proper permissions."
        Write-ErrorLog $errorMsg
        throw $errorMsg
    }

    if ($rolesAssigned -gt 0) {
        Write-SubStep "  Waiting for role assignment propagation (10 seconds)..." "Gray"
        Start-Sleep -Seconds 10
    }

    Write-SubStep "  RBAC roles verified" "Green"
}

function Start-PolicyRemediation {
    <#
    .SYNOPSIS
        Creates and starts a remediation task for a policy assignment.
    .DESCRIPTION
        Triggers remediation for existing non-compliant resources. New resources
        are automatically remediated by DeployIfNotExists, but existing resources
        require an explicit remediation task.
    #>
    param(
        [Parameter(Mandatory=$true)]
        [string]$AssignmentName,
        [Parameter(Mandatory=$true)]
        [string]$Scope
    )

    # Build remediation task name
    $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $remediationName = "Remediate-$AssignmentName-$timestamp"

    # Get the full policy assignment ID
    $assignmentId = "$Scope/providers/Microsoft.Authorization/policyAssignments/$AssignmentName"

    Write-SubStep "Creating remediation task: $remediationName" "Cyan"
    Write-SubStep "  Assignment: $AssignmentName" "Gray"

    try {
        # Create the remediation task
        $remediation = Start-AzPolicyRemediation `
            -Name $remediationName `
            -PolicyAssignmentId $assignmentId `
            -Scope $Scope `
            -ResourceDiscoveryMode ReEvaluateCompliance `
            -ErrorAction Stop

        Write-SubStep "  Remediation task created successfully" "Green"
        Write-SubStep "  Status: $($remediation.ProvisioningState)" "Gray"
        Write-DebugLog -Message "Created remediation task: $remediationName for assignment $AssignmentName" -Context "Start-PolicyRemediation"

        $script:summary.RemediationTasksCreated++
        return $remediation

    } catch {
        # Check if the error is because there are no non-compliant resources
        if ($_.Exception.Message -match "no resources to remediate" -or $_.Exception.Message -match "PolicyAssignmentNotFound") {
            Write-SubStep "  No non-compliant resources found (or compliance not yet evaluated)" "Yellow"
            Write-SubStep "  Remediation will happen automatically for new resources" "Gray"
            return $null
        }

        Write-SubStep "  Failed to create remediation task: $_" "Red"
        Write-DebugLog -Message "Failed to create remediation task for $AssignmentName : $_" -Context "Start-PolicyRemediation"
        $script:summary.RemediationTasksFailed++
        return $null
    }
}

function Get-OrCreateTableServicesPolicy {
    <#
    .SYNOPSIS
        Creates or retrieves the custom Table Services diagnostic settings policy.
    .DESCRIPTION
        Since there is no built-in Azure Policy for Table Services diagnostic settings to Event Hub,
        this function creates a custom policy definition that mirrors the built-in policies for
        Blob, File, and Queue services.
    #>
    param()

    # Derive policy name - check for community policy first, then custom
    $communityPolicyName = "Cribl-Community-TableServices-DiagSettings-EventHub"
    $customPolicyName = "Cribl-TableServices-DiagSettings-EventHub"
    $scope = "/providers/Microsoft.Management/managementGroups/$($azureParams.managementGroupId)"

    Write-SubStep "Checking for Table Services policy..." "Cyan"

    # Check if community policy already exists
    try {
        $existingPolicy = Get-AzPolicyDefinition -Name $communityPolicyName -ManagementGroupName $azureParams.managementGroupId -ErrorAction SilentlyContinue
        if ($existingPolicy) {
            Write-SubStep "  Community policy already exists: $communityPolicyName" "Green"
            return $existingPolicy
        }
    } catch {
        # Community policy doesn't exist, check custom
    }

    # Check if custom policy already exists
    try {
        $existingPolicy = Get-AzPolicyDefinition -Name $customPolicyName -ManagementGroupName $azureParams.managementGroupId -ErrorAction SilentlyContinue
        if ($existingPolicy) {
            Write-SubStep "  Custom policy already exists: $customPolicyName" "Green"
            return $existingPolicy
        }
    } catch {
        # Custom policy doesn't exist, create it
    }

    Write-SubStep "  Creating custom Table Services policy..." "Yellow"

    # Custom policy definition matching the pattern of built-in storage policies
    $policyRule = @{
        if = @{
            allOf = @(
                @{
                    field = "type"
                    equals = "Microsoft.Storage/storageAccounts/tableServices"
                }
            )
        }
        then = @{
            effect = "[parameters('effect')]"
            details = @{
                type = "Microsoft.Insights/diagnosticSettings"
                name = "[parameters('profileName')]"
                existenceCondition = @{
                    allOf = @(
                        @{
                            field = "Microsoft.Insights/diagnosticSettings/logs.enabled"
                            equals = "true"
                        }
                        @{
                            field = "Microsoft.Insights/diagnosticSettings/eventHubAuthorizationRuleId"
                            equals = "[parameters('eventHubAuthorizationRuleId')]"
                        }
                    )
                }
                roleDefinitionIds = @(
                    "/providers/microsoft.authorization/roleDefinitions/749f88d5-cbae-40b8-bcfc-e573ddc772fa"
                    "/providers/microsoft.authorization/roleDefinitions/92aaf0da-9dab-42b6-94a3-d43ce8d16293"
                )
                deployment = @{
                    properties = @{
                        mode = "incremental"
                        template = @{
                            '$schema' = "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#"
                            contentVersion = "1.0.0.0"
                            parameters = @{
                                resourceName = @{ type = "string" }
                                eventHubAuthorizationRuleId = @{ type = "string" }
                                eventHubName = @{ type = "string" }
                                profileName = @{ type = "string" }
                                location = @{ type = "string" }
                            }
                            resources = @(
                                @{
                                    type = "Microsoft.Storage/storageAccounts/tableServices/providers/diagnosticSettings"
                                    apiVersion = "2021-05-01-preview"
                                    name = "[concat(parameters('resourceName'), '/Microsoft.Insights/', parameters('profileName'))]"
                                    location = "[parameters('location')]"
                                    properties = @{
                                        eventHubAuthorizationRuleId = "[parameters('eventHubAuthorizationRuleId')]"
                                        eventHubName = "[parameters('eventHubName')]"
                                        logs = @(
                                            @{
                                                category = "StorageRead"
                                                enabled = $true
                                            }
                                            @{
                                                category = "StorageWrite"
                                                enabled = $true
                                            }
                                            @{
                                                category = "StorageDelete"
                                                enabled = $true
                                            }
                                        )
                                        metrics = @(
                                            @{
                                                category = "Transaction"
                                                enabled = $false
                                            }
                                        )
                                    }
                                }
                            )
                        }
                        parameters = @{
                            resourceName = @{ value = "[field('fullName')]" }
                            eventHubAuthorizationRuleId = @{ value = "[parameters('eventHubAuthorizationRuleId')]" }
                            eventHubName = @{ value = "[parameters('eventHubName')]" }
                            profileName = @{ value = "[parameters('profileName')]" }
                            location = @{ value = "[field('location')]" }
                        }
                    }
                }
            }
        }
    }

    $policyParameters = @{
        effect = @{
            type = "String"
            metadata = @{
                displayName = "Effect"
                description = "Enable or disable the execution of the policy"
            }
            allowedValues = @("DeployIfNotExists", "Disabled")
            defaultValue = "DeployIfNotExists"
        }
        profileName = @{
            type = "String"
            metadata = @{
                displayName = "Profile name"
                description = "The diagnostic settings profile name"
            }
            defaultValue = "setByPolicy-EventHub"
        }
        eventHubAuthorizationRuleId = @{
            type = "String"
            metadata = @{
                displayName = "Event Hub Authorization Rule Id"
                description = "The Event Hub authorization rule Id for Azure Diagnostics"
                strongType = "Microsoft.EventHub/namespaces/authorizationRules"
                assignPermissions = $true
            }
        }
        eventHubName = @{
            type = "String"
            metadata = @{
                displayName = "Event Hub Name"
                description = "The Event Hub name to stream to (leave empty for auto-creation)"
            }
            defaultValue = ""
        }
    }

    try {
        $policyDefinition = New-AzPolicyDefinition `
            -Name $customPolicyName `
            -DisplayName "Configure diagnostic settings for Table Services to Event Hub (Custom)" `
            -Description "Deploys diagnostic settings for Storage Table Services to stream StorageRead, StorageWrite, StorageDelete logs to Event Hub. This is a custom policy as no built-in policy exists for Table Services Event Hub integration." `
            -Policy ($policyRule | ConvertTo-Json -Depth 30) `
            -Parameter ($policyParameters | ConvertTo-Json -Depth 10) `
            -Mode "Indexed" `
            -ManagementGroupName $azureParams.managementGroupId `
            -ErrorAction Stop

        Write-SubStep "  Created custom policy: $customPolicyName" "Green"
        return $policyDefinition
    } catch {
        Write-SubStep "  Failed to create custom policy: $_" "Red"
        return $null
    }
}

function Get-StorageAssignmentName {
    param(
        [string]$ServiceType,
        [string]$Region,
        [string]$DepMode
    )

    # Azure policy assignment names at management group scope have max 24 characters
    $prefix = $script:StoragePolicies[$ServiceType].AssignmentPrefix

    if ($DepMode -eq "Centralized") {
        return "$prefix-Central"
    } else {
        # Truncate region if needed (24 - prefix length - 1 for hyphen)
        $maxRegionLen = 24 - $prefix.Length - 1
        $truncatedRegion = if ($Region.Length -gt $maxRegionLen) {
            $Region.Substring(0, $maxRegionLen)
        } else {
            $Region
        }
        return "$prefix-$truncatedRegion"
    }
}

function New-StoragePolicyAssignment {
    param(
        [string]$ServiceType,
        [string]$Region,
        [string]$DepMode
    )

    $policy = $script:StoragePolicies[$ServiceType]
    $assignmentName = Get-StorageAssignmentName -ServiceType $ServiceType -Region $Region -DepMode $DepMode
    $scope = "/providers/Microsoft.Management/managementGroups/$($azureParams.managementGroupId)"
    $eventHubAuthRuleId = Get-EventHubAuthorizationRuleId -Region $Region -Mode $DepMode
    $namespaceName = Get-EventHubNamespaceName -Region $Region -Mode $DepMode
    $diagSettingName = if ($azureParams.diagnosticSettingName) { $azureParams.diagnosticSettingName } else { "setbycriblpolicy" }

    Write-SubStep "Deploying $ServiceType policy..." "Cyan"
    Write-SubStep "  Assignment: $assignmentName" "Gray"

    # For custom policies, ensure the policy definition exists
    if ($policy.IsCustom) {
        if (-not $policy.PolicyDefinitionId) {
            Write-SubStep "  Creating custom policy for $ServiceType..." "Cyan"
            if ($ServiceType -eq "TableServices") {
                $customPolicyId = Get-OrCreateTableServicesPolicy
            } else {
                $customPolicyId = New-CustomStoragePolicy -ServiceType $ServiceType
            }
            if (-not $customPolicyId) {
                Write-SubStep "  Failed to create custom policy for $ServiceType" "Red"
                $script:summary.StoragePoliciesFailed++
                return $null
            }
            $policy.PolicyDefinitionId = $customPolicyId
        }
    }

    # Check if policy definition was discovered
    if (-not $policy.PolicyDefinitionId) {
        Write-SubStep "  Policy definition not available - skipping $ServiceType" "Red"
        Write-SubStep "  This policy may have been deprecated by Microsoft" "Yellow"
        $script:summary.StoragePoliciesFailed++
        return $null
    }

    # Check if namespace exists
    try {
        $ns = Get-AzEventHubNamespace -ResourceGroupName $azureParams.eventHubResourceGroup -Name $namespaceName -ErrorAction SilentlyContinue
        if (-not $ns) {
            Write-SubStep "  Event Hub Namespace not found: $namespaceName" "Yellow"
            Write-SubStep "  Run Deploy-EventHubNamespaces.ps1 first" "Yellow"
            $script:summary.StoragePoliciesFailed++
            return $null
        }
    } catch {
        Write-SubStep "  Could not verify namespace: $_" "Yellow"
    }

    # Check if assignment exists
    try {
        $existingAssignment = Get-AzPolicyAssignment -Name $assignmentName -Scope $scope -ErrorAction SilentlyContinue
        if ($existingAssignment) {
            Write-SubStep "  Assignment already exists: $assignmentName" "Yellow"
            $script:summary.StoragePoliciesExisted++
            return $existingAssignment
        }
    } catch {
        # Assignment doesn't exist, continue
    }

    try {
        # Get the policy definition - handle custom vs built-in policies
        $policyDef = $null
        if ($policy.IsCustom -or $policy.IsCommunity) {
            # Custom/Community policies are scoped to management group
            # Try community policy name first, then custom policy name
            $communityPolicyName = "Cribl-Community-$ServiceType-DiagSettings-EventHub"
            $customPolicyName = "Cribl-$ServiceType-DiagSettings-EventHub"

            $policyDef = Get-AzPolicyDefinition -Name $communityPolicyName -ManagementGroupName $azureParams.managementGroupId -ErrorAction SilentlyContinue
            if (-not $policyDef) {
                $policyDef = Get-AzPolicyDefinition -Name $customPolicyName -ManagementGroupName $azureParams.managementGroupId -ErrorAction Stop
            }
        } else {
            # Built-in policies use the full ID
            $policyDef = Get-AzPolicyDefinition -Id $policy.PolicyDefinitionId -ErrorAction Stop
        }

        if (-not $policyDef) {
            Write-SubStep "  Failed to find policy: $($policy.PolicyDefinitionId)" "Red"
            $script:summary.StoragePoliciesFailed++
            return $null
        }

        # Build parameters dynamically based on what the policy expects
        $assignmentParams = Get-PolicyAssignmentParams `
            -PolicyDefinition $policyDef `
            -EventHubAuthRuleId $eventHubAuthRuleId `
            -EventHubName "" `
            -ProfileName $diagSettingName

        # Build display name and description
        if ($DepMode -eq "Centralized") {
            $displayName = "Cribl $ServiceType Diagnostic Settings - Centralized"
            $description = "$($policy.Description). Logs sent to centralized Event Hub for Cribl Stream."
        } else {
            $displayName = "Cribl $ServiceType Diagnostic Settings - $Region"
            $description = "$($policy.Description). Logs sent to regional Event Hub in $Region for Cribl Stream."
        }

        # Build resource selectors for multi-region mode
        $resourceSelectors = $null
        if ($DepMode -eq "MultiRegion") {
            $resourceSelectors = @(
                @{
                    name = "ResourceLocationSelector"
                    selectors = @(
                        @{
                            kind = "resourceLocation"
                            in = @($Region)
                        }
                    )
                }
            )
        }

        # Create assignment with user-assigned managed identity
        $assignmentSplat = @{
            Name = $assignmentName
            DisplayName = $displayName
            Description = $description
            PolicyDefinition = $policyDef
            Scope = $scope
            PolicyParameterObject = $assignmentParams
            IdentityType = "UserAssigned"
            IdentityId = $script:managedIdentity.Id
            Location = $azureParams.centralizedRegion
            ErrorAction = "Stop"
        }

        if ($resourceSelectors) {
            $assignmentSplat.ResourceSelector = $resourceSelectors
        }

        $assignment = New-AzPolicyAssignment @assignmentSplat

        Write-SubStep "  Created assignment: $assignmentName" "Green"
        Write-SubStep "  Using shared managed identity (RBAC roles pre-configured)" "Gray"

        $script:summary.StoragePoliciesCreated++
        return $assignment

    } catch {
        Write-SubStep "  Failed to create assignment: $_" "Red"
        $script:summary.StoragePoliciesFailed++
        return $null
    }
}

function New-ActivityLogPolicyAssignment {
    # Activity Log policy is assigned at management group level to apply to all subscriptions
    $assignmentName = $script:ActivityLogPolicy.AssignmentName
    $scope = "/providers/Microsoft.Management/managementGroups/$($azureParams.managementGroupId)"
    $eventHubAuthRuleId = Get-EventHubAuthorizationRuleId -Region $azureParams.centralizedRegion -Mode "Centralized"

    Write-SubStep "Deploying Activity Log policy to management group: $($azureParams.managementGroupId)" "Cyan"

    # Check if policy definition was discovered
    if (-not $script:ActivityLogPolicy.PolicyDefinitionId) {
        Write-SubStep "  Policy definition not discovered - skipping Activity Log" "Red"
        Write-SubStep "  This policy may have been deprecated by Microsoft" "Yellow"
        $script:summary.ActivityLogFailed++
        return $null
    }

    # Check if assignment exists
    try {
        $existingAssignment = Get-AzPolicyAssignment -Name $assignmentName -Scope $scope -ErrorAction SilentlyContinue
        if ($existingAssignment) {
            Write-SubStep "  Assignment already exists" "Yellow"
            $script:summary.ActivityLogExisted++
            return $existingAssignment
        }
    } catch {
        # Assignment doesn't exist, continue
    }

    try {
        # Get the policy definition
        $policyDef = Get-AzPolicyDefinition -Id $script:ActivityLogPolicy.PolicyDefinitionId -ErrorAction Stop

        if (-not $policyDef) {
            Write-SubStep "  Failed to find built-in policy" "Red"
            $script:summary.ActivityLogFailed++
            return $null
        }

        # Build parameters dynamically based on what the policy expects
        $assignmentParams = Get-PolicyAssignmentParams `
            -PolicyDefinition $policyDef `
            -EventHubAuthRuleId $eventHubAuthRuleId `
            -EventHubName "" `
            -ResourceLocation $azureParams.centralizedRegion

        $displayName = "Cribl Activity Log to Event Hub"
        $description = "Streams Azure Activity Log (control plane audit logs) to Event Hub for Cribl Stream ingestion"

        # Create assignment with user-assigned managed identity
        $assignment = New-AzPolicyAssignment `
            -Name $assignmentName `
            -DisplayName $displayName `
            -Description $description `
            -PolicyDefinition $policyDef `
            -Scope $scope `
            -PolicyParameterObject $assignmentParams `
            -IdentityType "UserAssigned" `
            -IdentityId $script:managedIdentity.Id `
            -Location $azureParams.centralizedRegion `
            -ErrorAction Stop

        Write-SubStep "  Created assignment: $assignmentName" "Green"
        Write-SubStep "  Using shared managed identity (RBAC roles pre-configured)" "Gray"

        $script:summary.ActivityLogCreated++
        return $assignment

    } catch {
        Write-SubStep "  Failed to create assignment: $_" "Red"
        $script:summary.ActivityLogFailed++
        return $null
    }
}

function Remove-StoragePolicyAssignment {
    param(
        [string]$ServiceType,
        [string]$Region,
        [string]$DepMode
    )

    $assignmentName = Get-StorageAssignmentName -ServiceType $ServiceType -Region $Region -DepMode $DepMode
    $scope = "/providers/Microsoft.Management/managementGroups/$($azureParams.managementGroupId)"

    try {
        $existing = Get-AzPolicyAssignment -Name $assignmentName -Scope $scope -ErrorAction SilentlyContinue
        if ($existing) {
            Remove-AzPolicyAssignment -Name $assignmentName -Scope $scope -ErrorAction Stop
            Write-SubStep "Removed: $assignmentName" "Green"
            return $true
        } else {
            Write-SubStep "Not found: $assignmentName" "Gray"
            return $false
        }
    } catch {
        Write-SubStep "Failed to remove $assignmentName : $_" "Red"
        return $false
    }
}

function Remove-ActivityLogPolicyAssignment {
    # Activity Log policy is assigned at management group level
    $assignmentName = $script:ActivityLogPolicy.AssignmentName
    $scope = "/providers/Microsoft.Management/managementGroups/$($azureParams.managementGroupId)"

    try {
        $existing = Get-AzPolicyAssignment -Name $assignmentName -Scope $scope -ErrorAction SilentlyContinue
        if ($existing) {
            Remove-AzPolicyAssignment -Name $assignmentName -Scope $scope -ErrorAction Stop
            Write-SubStep "Removed Activity Log assignment from management group: $($azureParams.managementGroupId)" "Green"
            return $true
        } else {
            Write-SubStep "Activity Log assignment not found in management group: $($azureParams.managementGroupId)" "Gray"
            return $false
        }
    } catch {
        Write-SubStep "Failed to remove Activity Log assignment: $_" "Red"
        return $false
    }
}

function Show-DeploymentSummary {
    Write-StepHeader "Deployment Summary"

    Write-Host "`n  STORAGE POLICIES:" -ForegroundColor Yellow
    Write-Host "    Created:  $($summary.StoragePoliciesCreated)" -ForegroundColor Green
    Write-Host "    Existed:  $($summary.StoragePoliciesExisted)" -ForegroundColor Gray
    Write-Host "    Failed:   $($summary.StoragePoliciesFailed)" -ForegroundColor $(if ($summary.StoragePoliciesFailed -gt 0) { "Red" } else { "Gray" })

    if ($IncludeActivityLog -or $ActivityLogOnly) {
        Write-Host "`n  ACTIVITY LOG:" -ForegroundColor Yellow
        Write-Host "    Created:  $($summary.ActivityLogCreated)" -ForegroundColor Green
        Write-Host "    Existed:  $($summary.ActivityLogExisted)" -ForegroundColor Gray
        Write-Host "    Failed:   $($summary.ActivityLogFailed)" -ForegroundColor $(if ($summary.ActivityLogFailed -gt 0) { "Red" } else { "Gray" })
        Write-Host "    Subscriptions: $($summary.SubscriptionsProcessed)" -ForegroundColor Gray
    }

    Write-Host "`n  ROLE ASSIGNMENTS:" -ForegroundColor Yellow
    Write-Host "    Created:  $($summary.RoleAssignmentsCreated)" -ForegroundColor Green

    if ($summary.RemediationTasksCreated -gt 0 -or $summary.RemediationTasksFailed -gt 0) {
        Write-Host "`n  REMEDIATION TASKS:" -ForegroundColor Yellow
        Write-Host "    Created:  $($summary.RemediationTasksCreated)" -ForegroundColor Green
        Write-Host "    Failed:   $($summary.RemediationTasksFailed)" -ForegroundColor $(if ($summary.RemediationTasksFailed -gt 0) { "Red" } else { "Gray" })
    }

    $totalCreated = $summary.StoragePoliciesCreated + $summary.ActivityLogCreated
    $totalFailed = $summary.StoragePoliciesFailed + $summary.ActivityLogFailed

    if ($totalFailed -eq 0 -and $totalCreated -gt 0) {
        Write-Host "`n  Supplemental policies deployed successfully!" -ForegroundColor Green
        Write-Host "`n  COVERAGE ADDED:" -ForegroundColor Yellow
        Write-Host "    - Storage Blob Services (StorageRead/Write/Delete)" -ForegroundColor White
        Write-Host "    - Storage File Services (StorageRead/Write/Delete)" -ForegroundColor White
        Write-Host "    - Storage Queue Services (StorageRead/Write/Delete)" -ForegroundColor White
        if ($IncludeActivityLog -or $ActivityLogOnly) {
            Write-Host "    - Azure Activity Log (control plane audit)" -ForegroundColor White
        }
        Write-Host "`n  NOTE: Table Services requires a custom policy (not available built-in)" -ForegroundColor Yellow

        if ($Remediate) {
            Write-Host "`n  NEXT STEPS:" -ForegroundColor Yellow
            Write-Host "    1. Monitor remediation task progress in Azure Portal" -ForegroundColor White
            Write-Host "    2. Monitor Event Hubs for incoming diagnostic logs" -ForegroundColor White
            Write-Host "    3. Configure Cribl Stream Event Hub sources" -ForegroundColor White
        } else {
            Write-Host "`n  NEXT STEPS:" -ForegroundColor Yellow
            Write-Host "    1. Wait 15-30 minutes for initial compliance evaluation" -ForegroundColor White
            Write-Host "    2. Run with -Remediate to create remediation tasks for existing resources" -ForegroundColor White
            Write-Host "    3. Monitor Event Hubs for incoming diagnostic logs" -ForegroundColor White
        }
    }
}

function Show-Status {
    Write-StepHeader "Current Supplemental Policy Status"

    $scope = "/providers/Microsoft.Management/managementGroups/$($azureParams.managementGroupId)"

    Write-Host "`n  STORAGE POLICIES (Management Group: $($azureParams.managementGroupId)):" -ForegroundColor Yellow

    foreach ($serviceType in $script:StoragePolicies.Keys) {
        $assignmentName = Get-StorageAssignmentName -ServiceType $serviceType -Region $azureParams.centralizedRegion -DepMode $DeploymentMode
        try {
            $assignment = Get-AzPolicyAssignment -Name $assignmentName -Scope $scope -ErrorAction SilentlyContinue
            if ($assignment) {
                Write-Host "    [DEPLOYED] $serviceType" -ForegroundColor Green
                Write-Host "               Assignment: $assignmentName" -ForegroundColor Gray
            } else {
                Write-Host "    [NOT DEPLOYED] $serviceType" -ForegroundColor Yellow
            }
        } catch {
            Write-Host "    [UNKNOWN] $serviceType - Error checking status" -ForegroundColor Red
        }
    }

    Write-Host "`n  TABLE SERVICES:" -ForegroundColor Yellow
    Write-Host "    [NOT AVAILABLE] No built-in Event Hub policy exists" -ForegroundColor Red
    Write-Host "                    Custom policy required for Table Services" -ForegroundColor Gray

    Write-Host "`n  ACTIVITY LOG:" -ForegroundColor Yellow
    # Check Activity Log in each subscription under the management group
    try {
        $subscriptions = Get-AzManagementGroupSubscription -GroupName $azureParams.managementGroupId -ErrorAction SilentlyContinue
        if ($subscriptions) {
            foreach ($sub in $subscriptions) {
                # Extract just the subscription GUID from the full path
                $subId = $sub.Id
                if ($subId -match '/subscriptions/([a-f0-9-]+)$') {
                    $subId = $Matches[1]
                } elseif (-not ($subId -match '^[a-f0-9-]+$')) {
                    Write-Host "    [UNKNOWN] Could not parse subscription ID: $($sub.Id)" -ForegroundColor Gray
                    continue
                }
                $subScope = "/subscriptions/$subId"
                try {
                    $assignment = Get-AzPolicyAssignment -Name $script:ActivityLogPolicy.AssignmentName -Scope $subScope -ErrorAction SilentlyContinue
                    if ($assignment) {
                        Write-Host "    [DEPLOYED] Subscription: $subId" -ForegroundColor Green
                    } else {
                        Write-Host "    [NOT DEPLOYED] Subscription: $subId" -ForegroundColor Yellow
                    }
                } catch {
                    Write-Host "    [UNKNOWN] Subscription: $subId" -ForegroundColor Gray
                }
            }
        } else {
            Write-Host "    Could not enumerate subscriptions in management group" -ForegroundColor Yellow
        }
    } catch {
        Write-Host "    Error checking Activity Log status: $_" -ForegroundColor Red
    }
}

#endregion

#region Main Execution

# Initialize logging early to capture all output
if (Get-Command Initialize-PolicyLogging -ErrorAction SilentlyContinue) {
    $logsDir = Join-Path $ScriptPath "logs"
    if (-not (Test-Path $logsDir)) {
        New-Item -ItemType Directory -Path $logsDir -Force | Out-Null
    }
    $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $logFile = Join-Path $logsDir "deploy-SupplementalPolicies-$timestamp.log"
    # Use -DebugLogging switch to enable verbose debug output
    $logInitResult = Initialize-PolicyLogging -LogPath $logFile -EnableDebug $DebugLogging.IsPresent
    if ($logInitResult) {
        Write-ToLog -Message "Script started with parameters: DeploymentMode=$DeploymentMode, IncludeActivityLog=$IncludeActivityLog" -Level "INFO"
        if ($DebugLogging.IsPresent) {
            Write-ToLog -Message "Debug logging ENABLED via -DebugLogging switch" -Level "DEBUG"
        }
    }
}

# Show status and exit
if ($ShowStatus) {
    if (-not (Connect-ToAzure)) { exit 1 }
    Show-Status
    exit 0
}

# Connect to Azure
if (-not (Connect-ToAzure)) { exit 1 }

# Discover policy definitions (resilient to ID changes)
$discoveryResult = Initialize-PolicyDefinitions
$totalUsable = $discoveryResult.Discovered + $discoveryResult.CustomCreated
if ($totalUsable -eq 0 -and $discoveryResult.Skipped -eq 0) {
    Write-Host "`n  CRITICAL: No policies available for deployment." -ForegroundColor Red
    Write-Host "  All discovery methods failed and no custom policies could be created." -ForegroundColor Red
    exit 1
}
if ($discoveryResult.Skipped -gt 0) {
    Write-Host "`n  NOTE: $($discoveryResult.Skipped) policy/policies were skipped." -ForegroundColor Yellow
    Write-Host "  These resource types will NOT have automatic diagnostic settings deployment." -ForegroundColor Yellow
}

Write-StepHeader "Deploying Supplemental Policies"
Write-SubStep "Deployment Mode: $DeploymentMode" "Cyan"
Write-SubStep "Management Group: $($azureParams.managementGroupId)" "Gray"
Write-SubStep "Event Hub Subscription: $($azureParams.eventHubSubscriptionId)" "Gray"

# Determine what to deploy
$deployStorage = -not $ActivityLogOnly -and -not $TableServicesOnly
$deployActivityLog = ($IncludeActivityLog -or $ActivityLogOnly) -and -not $TableServicesOnly
$deployTableServices = $TableServicesOnly

# Handle removal
if ($RemoveAssignments) {
    Write-StepHeader "Removing Supplemental Policy Assignments"

    if ($deployStorage) {
        Write-Host "`n  Removing Storage Policies..." -ForegroundColor Yellow
        foreach ($serviceType in $script:StoragePolicies.Keys) {
            Remove-StoragePolicyAssignment -ServiceType $serviceType -Region $azureParams.centralizedRegion -DepMode $DeploymentMode
        }
    }

    if ($deployActivityLog) {
        Write-Host "`n  Removing Activity Log Policy..." -ForegroundColor Yellow
        Write-Host "  (Removing from management group level)" -ForegroundColor Gray
        Remove-ActivityLogPolicyAssignment
    }

    Write-Host "`n  Removal complete." -ForegroundColor Green
    exit 0
}

# Validate only
if ($ValidateOnly) {
    Write-StepHeader "Validation Mode - No Changes Will Be Made"
    Write-SubStep "Would deploy Storage policies: $deployStorage" "Cyan"
    Write-SubStep "Would deploy Activity Log: $deployActivityLog" "Cyan"
    Write-SubStep "Target Management Group: $($azureParams.managementGroupId)" "Gray"
    exit 0
}

# ============================================================================
# Initialize Managed Identity for Policy Assignments
# ============================================================================
Write-StepHeader "Initializing Managed Identity"
Write-SubStep "User-assigned managed identity is used for all policy assignments" "Gray"
Write-SubStep "This eliminates identity propagation delays and simplifies RBAC management" "Gray"

try {
    # Get or create the managed identity
    $script:managedIdentity = Get-OrCreateManagedIdentity

    # Ensure RBAC roles are assigned
    Ensure-ManagedIdentityRoles -PrincipalId $script:managedIdentity.PrincipalId

    Write-SubStep "Managed identity ready for policy assignments" "Green"

} catch {
    Write-ErrorLog "Failed to initialize managed identity: $_"
    Write-Host "`n  ERROR: Cannot proceed without managed identity." -ForegroundColor Red
    Write-Host "  Please check the logs above and resolve the issue." -ForegroundColor Red
    exit 1
}

# Deploy Storage Policies
if ($deployStorage) {
    Write-Host "`n  Deploying Storage Service Policies..." -ForegroundColor Yellow
    Write-Host "  (Blob, File, Queue - Table requires custom policy)" -ForegroundColor Gray

    foreach ($serviceType in $script:StoragePolicies.Keys) {
        New-StoragePolicyAssignment -ServiceType $serviceType -Region $azureParams.centralizedRegion -DepMode $DeploymentMode
    }
}

# Deploy Activity Log Policy at Management Group Level
if ($deployActivityLog) {
    Write-Host "`n  Deploying Activity Log Policy..." -ForegroundColor Yellow
    Write-Host "  (Assigned at management group level - applies to all subscriptions)" -ForegroundColor Gray

    New-ActivityLogPolicyAssignment
}

# Deploy Table Services Custom Policy Only
if ($deployTableServices) {
    Write-Host "`n  Deploying Table Services Custom Policy..." -ForegroundColor Yellow
    Write-Host "  (Custom policy required - no built-in Azure Policy exists)" -ForegroundColor Gray

    # Only deploy TableServices
    New-StoragePolicyAssignment -ServiceType "TableServices" -Region $azureParams.centralizedRegion -DepMode $DeploymentMode
}

# Create remediation tasks if requested
$totalCreated = $summary.StoragePoliciesCreated + $summary.ActivityLogCreated
if ($Remediate -and $totalCreated -gt 0) {
    Write-StepHeader "Creating Remediation Tasks"
    Write-SubStep "Remediation tasks apply policies to existing non-compliant resources" "Gray"
    Write-SubStep "New resources are automatically remediated by DeployIfNotExists" "Gray"

    $mgScope = "/providers/Microsoft.Management/managementGroups/$($azureParams.managementGroupId)"

    # Remediate storage policies
    if ($deployStorage) {
        foreach ($serviceType in $script:StoragePolicies.Keys) {
            $assignmentName = Get-StorageAssignmentName -ServiceType $serviceType -Region $azureParams.centralizedRegion -DepMode $DeploymentMode
            Start-PolicyRemediation -AssignmentName $assignmentName -Scope $mgScope
        }
    }

    # Remediate Activity Log policy
    if ($deployActivityLog -and $summary.ActivityLogCreated -gt 0) {
        $activityLogAssignment = $script:ActivityLogPolicy.AssignmentName
        Start-PolicyRemediation -AssignmentName $activityLogAssignment -Scope $mgScope
    }

    # Remediate Table Services policy
    if ($deployTableServices) {
        $tableAssignment = Get-StorageAssignmentName -ServiceType "TableServices" -Region $azureParams.centralizedRegion -DepMode $DeploymentMode
        Start-PolicyRemediation -AssignmentName $tableAssignment -Scope $mgScope
    }
} elseif ($Remediate) {
    Write-SubStep "No new assignments created - skipping remediation" "Gray"
}

# Show summary
Show-DeploymentSummary

# Finalize logging
if (Get-Command Complete-PolicyLogging -ErrorAction SilentlyContinue) {
    Complete-PolicyLogging
}

#endregion
