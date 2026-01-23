# Analyze-ComplianceGaps.ps1
# Analyzes resource coverage gaps for diagnostic settings policies
# Identifies resources that exist but are not covered by policy initiatives

param(
    [Parameter(Mandatory=$false)]
    [string]$ManagementGroupId,

    [Parameter(Mandatory=$false)]
    [switch]$ShowCompliance,

    [Parameter(Mandatory=$false)]
    [switch]$ExportReport,

    [Parameter(Mandatory=$false)]
    [string]$ReportPath
)

# Import Output-Helper for consistent logging
$scriptPath = Split-Path -Parent $MyInvocation.MyCommand.Path
. "$scriptPath\Output-Helper.ps1"

# Resource types covered by the built-in "Enable allLogs category group" initiative
# Policy Set Definition ID: 0884adba-2312-4468-abeb-5422caed1038
$AllLogsResourceTypes = @(
    "Microsoft.AgFoodPlatform/farmBeats"
    "Microsoft.ApiManagement/service"
    "Microsoft.AppConfiguration/configurationStores"
    "Microsoft.AppPlatform/Spring"
    "Microsoft.Attestation/attestationProviders"
    "Microsoft.Automation/automationAccounts"
    "Microsoft.AVS/privateClouds"
    "Microsoft.Batch/batchAccounts"
    "Microsoft.BotService/botServices"
    "Microsoft.Cache/redis"
    "Microsoft.Cache/redisEnterprise"
    "Microsoft.Cdn/profiles"
    "Microsoft.CognitiveServices/accounts"
    "Microsoft.Communication/CommunicationServices"
    "Microsoft.ContainerRegistry/registries"
    "Microsoft.ContainerService/managedClusters"
    "Microsoft.Databricks/workspaces"
    "Microsoft.DataCollectionHubs/dataCollectionHubs"
    "Microsoft.DataFactory/factories"
    "Microsoft.DataLakeAnalytics/accounts"
    "Microsoft.DataLakeStore/accounts"
    "Microsoft.DBforMariaDB/servers"
    "Microsoft.DBforMySQL/flexibleServers"
    "Microsoft.DBforMySQL/servers"
    "Microsoft.DBforPostgreSQL/flexibleServers"
    "Microsoft.DBforPostgreSQL/servers"
    "Microsoft.DesktopVirtualization/applicationgroups"
    "Microsoft.DesktopVirtualization/hostpools"
    "Microsoft.DesktopVirtualization/workspaces"
    "Microsoft.Devices/IotHubs"
    "Microsoft.Devices/provisioningServices"
    "Microsoft.DigitalTwins/digitalTwinsInstances"
    "Microsoft.DocumentDB/databaseAccounts"
    "Microsoft.EventGrid/domains"
    "Microsoft.EventGrid/partnerNamespaces"
    "Microsoft.EventGrid/partnerTopics"
    "Microsoft.EventGrid/systemTopics"
    "Microsoft.EventGrid/topics"
    "Microsoft.EventHub/namespaces"
    "Microsoft.HealthcareApis/services"
    "Microsoft.Insights/autoscalesettings"
    "Microsoft.Insights/components"
    "Microsoft.IoTCentral/iotApps"
    "Microsoft.KeyVault/managedHsms"
    "Microsoft.KeyVault/vaults"
    "Microsoft.Kusto/Clusters"
    "Microsoft.LoadTestService/loadtests"
    "Microsoft.Logic/integrationAccounts"
    "Microsoft.Logic/workflows"
    "Microsoft.MachineLearningServices/workspaces"
    "Microsoft.Media/mediaservices"
    "Microsoft.Media/mediaservices/liveEvents"
    "Microsoft.Media/mediaservices/streamingEndpoints"
    "Microsoft.Network/applicationGateways"
    "Microsoft.Network/azurefirewalls"
    "Microsoft.Network/bastionHosts"
    "Microsoft.Network/expressRouteCircuits"
    "Microsoft.Network/frontdoors"
    "Microsoft.Network/loadBalancers"
    "Microsoft.Network/natGateways"
    "Microsoft.Network/networkManagers"
    "Microsoft.Network/networkSecurityGroups"
    "Microsoft.Network/p2svpnGateways"
    "Microsoft.Network/privateEndpoints"
    "Microsoft.Network/privateLinkServices"
    "Microsoft.Network/publicIPAddresses"
    "Microsoft.Network/trafficmanagerprofiles"
    "Microsoft.Network/virtualHubs"
    "Microsoft.Network/virtualNetworkGateways"
    "Microsoft.Network/virtualNetworks"
    "Microsoft.Network/vpnGateways"
    "Microsoft.NetworkAnalytics/DataConnectors"
    "Microsoft.NetworkCloud/bareMetalMachines"
    "Microsoft.NetworkCloud/clusters"
    "Microsoft.NetworkCloud/storageAppliances"
    "Microsoft.NetworkFunction/azureTrafficCollectors"
    "Microsoft.OperationalInsights/workspaces"
    "Microsoft.PlayFab/titles"
    "Microsoft.PowerBIDedicated/capacities"
    "Microsoft.Purview/accounts"
    "Microsoft.RecoveryServices/vaults"
    "Microsoft.Relay/namespaces"
    "Microsoft.Search/searchServices"
    "Microsoft.ServiceBus/namespaces"
    "Microsoft.SignalRService/SignalR"
    "Microsoft.SignalRService/WebPubSub"
    "Microsoft.Sql/managedInstances"
    "Microsoft.Sql/servers/databases"
    "Microsoft.Storage/storageAccounts"
    "Microsoft.StorageCache/caches"
    "Microsoft.StreamAnalytics/streamingjobs"
    "Microsoft.Synapse/workspaces"
    "Microsoft.TimeSeriesInsights/environments"
    "Microsoft.VideoIndexer/accounts"
    "Microsoft.Web/hostingEnvironments"
    "Microsoft.Web/sites"
    "Microsoft.Web/sites/slots"
)

# Resource types covered by the audit category initiative
# Policy Set Definition ID: f5b29bc4-feca-4cc6-a58a-772dd5e290a5
$AuditResourceTypes = @(
    "Microsoft.AgFoodPlatform/farmBeats"
    "Microsoft.ApiManagement/service"
    "Microsoft.AppConfiguration/configurationStores"
    "Microsoft.Attestation/attestationProviders"
    "Microsoft.Automation/automationAccounts"
    "Microsoft.Batch/batchAccounts"
    "Microsoft.Cache/redis"
    "Microsoft.Cdn/profiles"
    "Microsoft.CognitiveServices/accounts"
    "Microsoft.ContainerRegistry/registries"
    "Microsoft.ContainerService/managedClusters"
    "Microsoft.Databricks/workspaces"
    "Microsoft.DataFactory/factories"
    "Microsoft.DBforMariaDB/servers"
    "Microsoft.DBforMySQL/flexibleServers"
    "Microsoft.DBforMySQL/servers"
    "Microsoft.DBforPostgreSQL/flexibleServers"
    "Microsoft.DBforPostgreSQL/servers"
    "Microsoft.DesktopVirtualization/applicationgroups"
    "Microsoft.DesktopVirtualization/hostpools"
    "Microsoft.DesktopVirtualization/workspaces"
    "Microsoft.Devices/IotHubs"
    "Microsoft.Devices/provisioningServices"
    "Microsoft.DocumentDB/databaseAccounts"
    "Microsoft.EventGrid/domains"
    "Microsoft.EventGrid/systemTopics"
    "Microsoft.EventGrid/topics"
    "Microsoft.EventHub/namespaces"
    "Microsoft.HealthcareApis/services"
    "Microsoft.IoTCentral/iotApps"
    "Microsoft.KeyVault/managedHsms"
    "Microsoft.KeyVault/vaults"
    "Microsoft.Kusto/Clusters"
    "Microsoft.Logic/integrationAccounts"
    "Microsoft.Logic/workflows"
    "Microsoft.MachineLearningServices/workspaces"
    "Microsoft.Media/mediaservices"
    "Microsoft.Network/applicationGateways"
    "Microsoft.Network/azurefirewalls"
    "Microsoft.Network/bastionHosts"
    "Microsoft.Network/expressRouteCircuits"
    "Microsoft.Network/frontdoors"
    "Microsoft.Network/p2svpnGateways"
    "Microsoft.Network/publicIPAddresses"
    "Microsoft.Network/virtualNetworkGateways"
    "Microsoft.Network/vpnGateways"
    "Microsoft.OperationalInsights/workspaces"
    "Microsoft.PowerBIDedicated/capacities"
    "Microsoft.Purview/accounts"
    "Microsoft.RecoveryServices/vaults"
    "Microsoft.Search/searchServices"
    "Microsoft.ServiceBus/namespaces"
    "Microsoft.SignalRService/SignalR"
    "Microsoft.SignalRService/WebPubSub"
    "Microsoft.Sql/managedInstances"
    "Microsoft.Sql/servers/databases"
    "Microsoft.Storage/storageAccounts"
    "Microsoft.StreamAnalytics/streamingjobs"
    "Microsoft.Synapse/workspaces"
    "Microsoft.TimeSeriesInsights/environments"
    "Microsoft.Web/hostingEnvironments"
    "Microsoft.Web/sites"
    "Microsoft.Web/sites/slots"
)

# Resource types that support diagnostic settings but are NOT in the built-in initiatives
# These represent gaps that may need custom policies
$KnownGaps = @{
    "Microsoft.Storage/storageAccounts/blobServices" = @{
        Description = "Storage Blob Services"
        BuiltInPolicyId = "b4fe1a3b-0715-4c6c-a5ea-ffc33cf823cb"
        Note = "Covered by supplemental Storage policies"
    }
    "Microsoft.Storage/storageAccounts/fileServices" = @{
        Description = "Storage File Services"
        BuiltInPolicyId = "25a70cc8-2bd4-47f1-90b6-1478e4662c96"
        Note = "Covered by supplemental Storage policies"
    }
    "Microsoft.Storage/storageAccounts/queueServices" = @{
        Description = "Storage Queue Services"
        BuiltInPolicyId = "7bd000e3-37c7-4928-9f31-86c4b77c5c45"
        Note = "Covered by supplemental Storage policies"
    }
    "Microsoft.Storage/storageAccounts/tableServices" = @{
        Description = "Storage Table Services"
        BuiltInPolicyId = $null
        Note = "No built-in Event Hub policy - requires custom policy"
    }
}

function Get-ResourceInventory {
    param(
        [string]$ManagementGroupId
    )

    Write-Host "`n  Querying Azure Resource Graph..." -ForegroundColor Cyan

    $query = @"
resources
| summarize ResourceCount = count() by type
| order by ResourceCount desc
"@

    try {
        $results = Search-AzGraph -Query $query -ManagementGroup $ManagementGroupId -First 1000

        if ($results) {
            return $results
        } else {
            Write-Host "  No resources found in management group." -ForegroundColor Yellow
            return @()
        }
    }
    catch {
        Write-Host "  Error querying Resource Graph: $($_.Exception.Message)" -ForegroundColor Red
        return @()
    }
}

function Get-PolicyComplianceState {
    param(
        [string]$ManagementGroupId
    )

    Write-Host "`n  Checking policy compliance state..." -ForegroundColor Cyan

    try {
        $scope = "/providers/Microsoft.Management/managementGroups/$ManagementGroupId"
        $complianceStates = Get-AzPolicyState -ManagementGroupName $ManagementGroupId -Top 5000 -ErrorAction Stop

        $summary = $complianceStates | Group-Object ComplianceState |
            Select-Object @{N='State';E={$_.Name}}, @{N='Count';E={$_.Count}}

        return @{
            Summary = $summary
            Details = $complianceStates
        }
    }
    catch {
        Write-Host "  Could not retrieve compliance state: $($_.Exception.Message)" -ForegroundColor Yellow
        return $null
    }
}

function Show-GapAnalysis {
    param(
        [array]$ResourceInventory,
        [hashtable]$ComplianceData
    )

    Write-Host "`n$('='*80)" -ForegroundColor White
    Write-Host "  DIAGNOSTIC SETTINGS COVERAGE GAP ANALYSIS" -ForegroundColor Cyan
    Write-Host "$('='*80)" -ForegroundColor White

    # Categorize resources
    $coveredByAllLogs = @()
    $coveredByAudit = @()
    $knownGapsFound = @()
    $potentialGaps = @()
    $infrastructureTypes = @()

    # Infrastructure resource types that don't have diagnostic settings
    $infrastructurePatterns = @(
        "Microsoft.Resources/*"
        "Microsoft.Authorization/*"
        "Microsoft.Compute/disks"
        "Microsoft.Compute/snapshots"
        "Microsoft.Compute/images"
        "Microsoft.Compute/galleries*"
        "Microsoft.Network/networkInterfaces"
        "Microsoft.Network/routeTables"
        "Microsoft.Network/networkSecurityGroups/securityRules"
        "Microsoft.ManagedIdentity/*"
        "Microsoft.Portal/*"
        "Microsoft.AlertsManagement/*"
        "Microsoft.Insights/actionGroups"
        "Microsoft.Insights/activityLogAlerts"
        "Microsoft.Insights/dataCollectionRules"
        "Microsoft.Insights/diagnosticSettings"
        "Microsoft.Insights/metricAlerts"
        "Microsoft.Insights/scheduledQueryRules"
        "Microsoft.Security/*"
        "Microsoft.PolicyInsights/*"
        "Microsoft.Advisor/*"
    )

    foreach ($resource in $ResourceInventory) {
        $resourceType = $resource.type
        $count = $resource.ResourceCount

        # Check if it's an infrastructure type (no diagnostic settings)
        $isInfrastructure = $false
        foreach ($pattern in $infrastructurePatterns) {
            if ($pattern.EndsWith("*")) {
                $prefix = $pattern.TrimEnd('*')
                if ($resourceType -like "$prefix*") {
                    $isInfrastructure = $true
                    break
                }
            } elseif ($resourceType -eq $pattern) {
                $isInfrastructure = $true
                break
            }
        }

        if ($isInfrastructure) {
            $infrastructureTypes += [PSCustomObject]@{
                ResourceType = $resourceType
                Count = $count
                Category = "Infrastructure"
            }
            continue
        }

        # Check coverage
        if ($AllLogsResourceTypes -contains $resourceType) {
            $coveredByAllLogs += [PSCustomObject]@{
                ResourceType = $resourceType
                Count = $count
                Initiative = "allLogs + audit"
            }
        }
        elseif ($AuditResourceTypes -contains $resourceType) {
            $coveredByAudit += [PSCustomObject]@{
                ResourceType = $resourceType
                Count = $count
                Initiative = "audit only"
            }
        }
        elseif ($KnownGaps.ContainsKey($resourceType)) {
            $gap = $KnownGaps[$resourceType]
            $knownGapsFound += [PSCustomObject]@{
                ResourceType = $resourceType
                Count = $count
                Description = $gap.Description
                HasBuiltInPolicy = $null -ne $gap.BuiltInPolicyId
                Note = $gap.Note
            }
        }
        else {
            $potentialGaps += [PSCustomObject]@{
                ResourceType = $resourceType
                Count = $count
            }
        }
    }

    # Display results
    Write-Host "`n  COVERED BY BUILT-IN INITIATIVES" -ForegroundColor Green
    Write-Host "  $('-'*60)" -ForegroundColor Gray

    if ($coveredByAllLogs.Count -gt 0) {
        $totalCovered = ($coveredByAllLogs | Measure-Object -Property Count -Sum).Sum
        Write-Host "  [OK] $($coveredByAllLogs.Count) resource types ($totalCovered resources) covered by allLogs/audit" -ForegroundColor Green

        if ($coveredByAllLogs.Count -le 20) {
            foreach ($item in $coveredByAllLogs | Sort-Object Count -Descending) {
                Write-Host "       $($item.Count.ToString().PadLeft(6)) x $($item.ResourceType)" -ForegroundColor Gray
            }
        } else {
            $top10 = $coveredByAllLogs | Sort-Object Count -Descending | Select-Object -First 10
            foreach ($item in $top10) {
                Write-Host "       $($item.Count.ToString().PadLeft(6)) x $($item.ResourceType)" -ForegroundColor Gray
            }
            Write-Host "       ... and $($coveredByAllLogs.Count - 10) more resource types" -ForegroundColor DarkGray
        }
    }

    # Known gaps (supplemental policies available)
    if ($knownGapsFound.Count -gt 0) {
        Write-Host "`n  KNOWN GAPS - SUPPLEMENTAL POLICIES AVAILABLE" -ForegroundColor Yellow
        Write-Host "  $('-'*60)" -ForegroundColor Gray

        foreach ($gap in $knownGapsFound | Sort-Object Count -Descending) {
            $status = if ($gap.HasBuiltInPolicy) { "[POLICY]" } else { "[CUSTOM]" }
            Write-Host "  $status $($gap.Count.ToString().PadLeft(6)) x $($gap.ResourceType)" -ForegroundColor Yellow
            Write-Host "           $($gap.Note)" -ForegroundColor DarkYellow
        }
    }

    # Potential gaps (may need investigation)
    if ($potentialGaps.Count -gt 0) {
        Write-Host "`n  POTENTIAL GAPS - INVESTIGATION NEEDED" -ForegroundColor Magenta
        Write-Host "  $('-'*60)" -ForegroundColor Gray
        Write-Host "  These resource types are not covered by built-in initiatives." -ForegroundColor DarkGray
        Write-Host "  Some may not support diagnostic settings; others may need custom policies." -ForegroundColor DarkGray

        foreach ($gap in $potentialGaps | Sort-Object Count -Descending | Select-Object -First 20) {
            Write-Host "  [?] $($gap.Count.ToString().PadLeft(6)) x $($gap.ResourceType)" -ForegroundColor Magenta
        }

        if ($potentialGaps.Count -gt 20) {
            Write-Host "       ... and $($potentialGaps.Count - 20) more resource types" -ForegroundColor DarkGray
        }
    }

    # Infrastructure types (no diagnostic settings needed)
    if ($infrastructureTypes.Count -gt 0) {
        Write-Host "`n  INFRASTRUCTURE RESOURCES (No Diagnostic Settings)" -ForegroundColor DarkGray
        Write-Host "  $('-'*60)" -ForegroundColor Gray
        $totalInfra = ($infrastructureTypes | Measure-Object -Property Count -Sum).Sum
        Write-Host "  $($infrastructureTypes.Count) resource types ($totalInfra resources) - no diagnostic settings available" -ForegroundColor DarkGray
    }

    # Summary
    Write-Host "`n$('='*80)" -ForegroundColor White
    Write-Host "  SUMMARY" -ForegroundColor Cyan
    Write-Host "$('='*80)" -ForegroundColor White

    $totalResources = ($ResourceInventory | Measure-Object -Property ResourceCount -Sum).Sum
    $coveredResources = ($coveredByAllLogs | Measure-Object -Property Count -Sum).Sum
    $gapResources = ($knownGapsFound | Measure-Object -Property Count -Sum).Sum +
                    ($potentialGaps | Measure-Object -Property Count -Sum).Sum

    Write-Host "  Total Resources:                 $totalResources" -ForegroundColor White
    Write-Host "  Covered by Initiatives:          $coveredResources" -ForegroundColor Green
    Write-Host "  Known Gaps (policy available):   $(($knownGapsFound | Measure-Object -Property Count -Sum).Sum)" -ForegroundColor Yellow
    Write-Host "  Potential Gaps (investigate):    $(($potentialGaps | Measure-Object -Property Count -Sum).Sum)" -ForegroundColor Magenta
    Write-Host "  Infrastructure (no diag):        $(($infrastructureTypes | Measure-Object -Property Count -Sum).Sum)" -ForegroundColor DarkGray

    # Recommendations
    Write-Host "`n  RECOMMENDATIONS" -ForegroundColor Cyan
    Write-Host "  $('-'*60)" -ForegroundColor Gray

    $recommendations = @()

    if (($knownGapsFound | Where-Object { $_.ResourceType -like "*storageAccounts*" }).Count -gt 0) {
        $recommendations += "Deploy Storage supplemental policies (menu option [5] or [6])"
    }

    if ($potentialGaps.Count -gt 0) {
        $recommendations += "Review potential gaps - check if resources support diagnostic settings"
    }

    if ($recommendations.Count -eq 0) {
        $recommendations += "No critical gaps identified - coverage looks complete"
    }

    $i = 1
    foreach ($rec in $recommendations) {
        Write-Host "  $i. $rec" -ForegroundColor Cyan
        $i++
    }

    # Return data for export
    return @{
        CoveredByInitiatives = $coveredByAllLogs
        KnownGaps = $knownGapsFound
        PotentialGaps = $potentialGaps
        Infrastructure = $infrastructureTypes
        Summary = @{
            TotalResources = $totalResources
            CoveredResources = $coveredResources
            GapResources = $gapResources
        }
    }
}

function Export-GapReport {
    param(
        [hashtable]$AnalysisData,
        [string]$OutputPath
    )

    $report = @{
        GeneratedAt = (Get-Date -Format "yyyy-MM-dd HH:mm:ss")
        Summary = $AnalysisData.Summary
        CoveredByInitiatives = $AnalysisData.CoveredByInitiatives
        KnownGaps = $AnalysisData.KnownGaps
        PotentialGaps = $AnalysisData.PotentialGaps
    }

    $report | ConvertTo-Json -Depth 10 | Out-File -FilePath $OutputPath -Encoding UTF8

    Write-Host "`n  Report exported to: $OutputPath" -ForegroundColor Green
}

# Main execution
function Start-ComplianceGapAnalysis {
    param(
        [string]$ManagementGroupId,
        [switch]$ShowCompliance,
        [switch]$ExportReport,
        [string]$ReportPath
    )

    Write-Host "`n$('='*80)" -ForegroundColor Cyan
    Write-Host "  COMPLIANCE GAP ANALYSIS" -ForegroundColor Cyan
    Write-Host "  Analyzing diagnostic settings policy coverage" -ForegroundColor Gray
    Write-Host "$('='*80)" -ForegroundColor Cyan

    # Load configuration if ManagementGroupId not specified
    if ([string]::IsNullOrEmpty($ManagementGroupId)) {
        $configPath = Join-Path $scriptPath "azure-parameters.json"
        if (Test-Path $configPath) {
            $config = Get-Content $configPath -Raw | ConvertFrom-Json
            $ManagementGroupId = $config.managementGroupId
        } else {
            Write-Host "  Error: ManagementGroupId not specified and azure-parameters.json not found" -ForegroundColor Red
            return
        }
    }

    Write-Host "`n  Management Group: $ManagementGroupId" -ForegroundColor White

    # Get resource inventory
    $inventory = Get-ResourceInventory -ManagementGroupId $ManagementGroupId

    if ($inventory.Count -eq 0) {
        Write-Host "  No resources found to analyze." -ForegroundColor Yellow
        return
    }

    Write-Host "  Found $($inventory.Count) resource types" -ForegroundColor Green

    # Get compliance state if requested
    $complianceData = $null
    if ($ShowCompliance) {
        $complianceData = Get-PolicyComplianceState -ManagementGroupId $ManagementGroupId
    }

    # Perform gap analysis
    $analysisData = Show-GapAnalysis -ResourceInventory $inventory -ComplianceData $complianceData

    # Export report if requested
    if ($ExportReport) {
        if ([string]::IsNullOrEmpty($ReportPath)) {
            $reportDir = Join-Path $scriptPath "reports"
            if (-not (Test-Path $reportDir)) {
                New-Item -ItemType Directory -Path $reportDir -Force | Out-Null
            }
            $ReportPath = Join-Path $reportDir "gap-analysis-$(Get-Date -Format 'yyyyMMdd-HHmmss').json"
        }
        Export-GapReport -AnalysisData $analysisData -OutputPath $ReportPath
    }

    Write-Host "`n$('='*80)" -ForegroundColor Cyan

    return $analysisData
}

# Export functions
Export-ModuleMember -Function Start-ComplianceGapAnalysis -ErrorAction SilentlyContinue

# If run directly (not dot-sourced)
if ($MyInvocation.InvocationName -ne '.') {
    Start-ComplianceGapAnalysis -ManagementGroupId $ManagementGroupId -ShowCompliance:$ShowCompliance -ExportReport:$ExportReport -ReportPath $ReportPath
}
