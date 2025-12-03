# Deploy-Monitoring.ps1
# Deploys Log Analytics, Sentinel, VNet Flow Logs, and Private Link for Unified Azure Lab

param(
    [Parameter(Mandatory=$true)]
    [PSCustomObject]$AzureParams,

    [Parameter(Mandatory=$true)]
    [PSCustomObject]$OperationParams,

    [Parameter(Mandatory=$true)]
    [string]$ResourceGroupName,

    [Parameter(Mandatory=$true)]
    [string]$Location,

    [Parameter(Mandatory=$true)]
    [hashtable]$ResourceNames,

    [Parameter(Mandatory=$false)]
    [object]$VNet = $null
)

$SkipExisting = $OperationParams.validation.skipExistingResources

function Deploy-LogAnalyticsWorkspace {
    if (-not $OperationParams.deployment.monitoring.deployLogAnalytics) {
        return $null
    }

    $lawName = $ResourceNames.LogAnalytics
    $lawConfig = $AzureParams.monitoring.logAnalyticsWorkspace

    $existingWorkspace = Get-AzOperationalInsightsWorkspace -ResourceGroupName $ResourceGroupName -Name $lawName -ErrorAction SilentlyContinue

    if ($null -ne $existingWorkspace) {
        if ($SkipExisting) {
            return $existingWorkspace
        } else {
            throw "Log Analytics Workspace already exists"
        }
    }

    try {
        $workspace = New-AzOperationalInsightsWorkspace `
            -ResourceGroupName $ResourceGroupName `
            -Name $lawName `
            -Location $Location `
            -Sku $lawConfig.sku `
            -RetentionInDays $lawConfig.retentionInDays `
            -ErrorAction Stop

        Write-ToLog -Message "Log Analytics Workspace created: $lawName" -Level "SUCCESS"
        return $workspace

    } catch {
        Write-ToLog -Message "Failed to create Log Analytics Workspace: $($_.Exception.Message)" -Level "ERROR"
        throw
    }
}

function Deploy-Sentinel {
    param($Workspace)

    if (-not $OperationParams.deployment.monitoring.deploySentinel -or -not $AzureParams.monitoring.sentinel.enabled) {
        return $null
    }

    if ($null -eq $Workspace) {
        return $null
    }

    $lawName = $ResourceNames.LogAnalytics

    try {
        $solutionName = "SecurityInsights($lawName)"
        $existingSolution = Get-AzResource `
            -ResourceGroupName $ResourceGroupName `
            -ResourceType "Microsoft.OperationsManagement/solutions" `
            -ResourceName $solutionName `
            -ErrorAction SilentlyContinue

        if ($null -ne $existingSolution) {
            return $existingSolution
        }

        $deploymentName = "sentinel-$(Get-Date -Format 'yyyyMMddHHmmss')"
        $template = @{
            '$schema' = "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#"
            contentVersion = "1.0.0.0"
            resources = @(
                @{
                    type = "Microsoft.OperationsManagement/solutions"
                    apiVersion = "2015-11-01-preview"
                    name = "SecurityInsights($lawName)"
                    location = $Location
                    plan = @{
                        name = "SecurityInsights($lawName)"
                        publisher = "Microsoft"
                        product = "OMSGallery/SecurityInsights"
                        promotionCode = ""
                    }
                    properties = @{
                        workspaceResourceId = $Workspace.ResourceId
                    }
                }
            )
        }

        $solution = New-AzResourceGroupDeployment `
            -ResourceGroupName $ResourceGroupName `
            -Name $deploymentName `
            -TemplateObject $template `
            -ErrorAction Stop

        Write-ToLog -Message "Microsoft Sentinel enabled: $lawName" -Level "SUCCESS"
        return $solution

    } catch {
        Write-ToLog -Message "Failed to enable Sentinel: $($_.Exception.Message)" -Level "ERROR"
        throw
    }
}

function Deploy-SentinelDataConnectors {
    param($Workspace)

    if (-not $OperationParams.deployment.monitoring.deploySentinel -or -not $AzureParams.monitoring.sentinel.enabled) {
        return @()
    }

    if ($null -eq $Workspace) {
        return @()
    }

    # Data connectors require manual configuration in Azure Portal
    return @()
}

function Deploy-FlowLogs {
    param($Workspace, $VNet, $StorageAccount)

    if (-not $OperationParams.deployment.monitoring.deployFlowLogs -or -not $AzureParams.monitoring.flowLogging.enabled) {
        return $null
    }

    if ($null -eq $VNet -or $null -eq $StorageAccount) {
        return $null
    }

    $networkWatcherName = $ResourceNames.NetworkWatcher
    $networkWatcher = Get-AzNetworkWatcher -ResourceGroupName $ResourceGroupName -Name $networkWatcherName -ErrorAction SilentlyContinue

    if ($null -eq $networkWatcher) {
        $nwRG = "NetworkWatcherRG"
        $nwName = "NetworkWatcher_$Location"

        $networkWatcher = Get-AzNetworkWatcher -ResourceGroupName $nwRG -Name $nwName -ErrorAction SilentlyContinue

        if ($null -eq $networkWatcher) {
            $networkWatcher = New-AzNetworkWatcher `
                -ResourceGroupName $ResourceGroupName `
                -Name $networkWatcherName `
                -Location $Location `
                -ErrorAction Stop
            Write-ToLog -Message "Network Watcher created: $networkWatcherName" -Level "SUCCESS"
        }
    }

    $vnetName = $VNet.Name
    $flowLogResults = @{
        VNetLevel = $null
        SubnetLevel = @()
    }

    # Deploy vNet-level flow log
    if ($AzureParams.monitoring.flowLogging.vnetLevel.enabled) {
        try {
            $flowLogConfig = @{
                TargetResourceId = $VNet.Id
                StorageId = $StorageAccount.Id
                Enabled = $true
                RetentionPolicyDays = $AzureParams.monitoring.flowLogging.vnetLevel.retentionDays
            }

            if ($AzureParams.monitoring.flowLogging.vnetLevel.trafficAnalyticsEnabled -and $null -ne $Workspace) {
                $flowLogConfig.EnableTrafficAnalytics = $true
                $flowLogConfig.TrafficAnalyticsWorkspaceId = $Workspace.ResourceId
                $flowLogConfig.TrafficAnalyticsInterval = $AzureParams.monitoring.flowLogging.vnetLevel.trafficAnalyticsInterval
            }

            $flowLogResults.VNetLevel = Set-AzNetworkWatcherFlowLog `
                -NetworkWatcher $networkWatcher `
                -Name "FlowLog-$vnetName" `
                @flowLogConfig `
                -ErrorAction Stop

            Write-ToLog -Message "VNet-level Flow Log configured: $vnetName" -Level "SUCCESS"

        } catch {
            if ($_.Exception.Message -notlike "*CannotCreateMoreThanOneFlowLogPerTargetResource*") {
                Write-ToLog -Message "Failed to configure VNet-level Flow Log: $($_.Exception.Message)" -Level "ERROR"
            }
        }
    }

    # Deploy subnet-level flow logs
    foreach ($subnetKey in $AzureParams.infrastructure.subnets.PSObject.Properties.Name) {
        $subnetDef = $AzureParams.infrastructure.subnets.$subnetKey
        $subnetFlowConfig = $AzureParams.monitoring.flowLogging.subnetLevel.$subnetKey

        if ($null -eq $subnetFlowConfig -or -not $subnetFlowConfig.enabled) {
            continue
        }

        $subnet = Get-AzVirtualNetworkSubnetConfig -Name $subnetDef.name -VirtualNetwork $VNet -ErrorAction SilentlyContinue

        if ($null -eq $subnet) {
            continue
        }

        try {
            $flowLogConfig = @{
                TargetResourceId = $subnet.Id
                StorageId = $StorageAccount.Id
                Enabled = $true
                RetentionPolicyDays = $subnetFlowConfig.retentionDays
            }

            if ($AzureParams.monitoring.flowLogging.vnetLevel.trafficAnalyticsEnabled -and $null -ne $Workspace) {
                $flowLogConfig.EnableTrafficAnalytics = $true
                $flowLogConfig.TrafficAnalyticsWorkspaceId = $Workspace.ResourceId
                $flowLogConfig.TrafficAnalyticsInterval = $AzureParams.monitoring.flowLogging.vnetLevel.trafficAnalyticsInterval
            }

            $flowLogName = "FlowLog-$vnetName-$($subnetDef.name)"

            $subnetFlowLog = Set-AzNetworkWatcherFlowLog `
                -NetworkWatcher $networkWatcher `
                -Name $flowLogName `
                @flowLogConfig `
                -ErrorAction Stop

            $flowLogResults.SubnetLevel += $subnetFlowLog
            Write-ToLog -Message "Subnet-level Flow Log configured: $($subnetDef.name)" -Level "SUCCESS"

        } catch {
            if ($_.Exception.Message -notlike "*CannotCreateMoreThanOneFlowLogPerTargetResource*") {
                Write-ToLog -Message "Failed to configure subnet-level Flow Log: $($_.Exception.Message)" -Level "ERROR"
            }
        }
    }

    return $flowLogResults
}

function Deploy-PrivateLink {
    param($Workspace, $VNet)

    if (-not $OperationParams.deployment.monitoring.deployPrivateLink -or -not $AzureParams.monitoring.privateLink.enabled) {
        return $null
    }

    if ($null -eq $VNet -or $null -eq $Workspace) {
        return $null
    }

    $amplsConfig = $AzureParams.monitoring.privateLink
    $amplsName = "ampls-$($AzureParams.baseObjectName)-$Location"

    try {
        $existingAMPLS = Get-AzResource `
            -ResourceGroupName $ResourceGroupName `
            -ResourceType "Microsoft.Insights/privateLinkScopes" `
            -Name $amplsName `
            -ErrorAction SilentlyContinue

        if ($null -ne $existingAMPLS) {
            $ampls = Get-AzResource -ResourceId $existingAMPLS.ResourceId
        } else {
            $ampls = New-AzResource `
                -ResourceGroupName $ResourceGroupName `
                -ResourceType "Microsoft.Insights/privateLinkScopes" `
                -ResourceName $amplsName `
                -Location "global" `
                -Properties @{} `
                -Force `
                -ErrorAction Stop

            Write-ToLog -Message "AMPLS created: $amplsName" -Level "SUCCESS"
        }

        # Add Log Analytics Workspace to AMPLS
        $scopedResourceName = "$amplsName-law"
        $existingScopedResource = Get-AzResource `
            -ResourceGroupName $ResourceGroupName `
            -ResourceType "Microsoft.Insights/privateLinkScopes/scopedResources" `
            -Name "$amplsName/$scopedResourceName" `
            -ErrorAction SilentlyContinue

        if ($null -eq $existingScopedResource) {
            New-AzResource `
                -ResourceGroupName $ResourceGroupName `
                -ResourceType "Microsoft.Insights/privateLinkScopes/scopedResources" `
                -ResourceName "$amplsName/$scopedResourceName" `
                -Properties @{
                    linkedResourceId = $Workspace.ResourceId
                } `
                -Force `
                -ErrorAction Stop | Out-Null

            Write-ToLog -Message "Workspace associated with AMPLS" -Level "SUCCESS"
        }

        # Create Private Endpoint
        $privateEndpointName = "pe-ampls-$($AzureParams.baseObjectName)"
        $existingPE = Get-AzPrivateEndpoint -ResourceGroupName $ResourceGroupName -Name $privateEndpointName -ErrorAction SilentlyContinue

        if ($null -ne $existingPE) {
            return @{
                AMPLS = $ampls
                PrivateEndpoint = $existingPE
            }
        }

        $privateLinkSubnet = $VNet.Subnets | Where-Object { $_.Name -eq "PrivateLinkSubnet" }
        if ($null -eq $privateLinkSubnet) {
            throw "PrivateLinkSubnet is required for Private Link"
        }

        $privateLinkSubnet.PrivateEndpointNetworkPolicies = "Disabled"
        $VNet | Set-AzVirtualNetwork -ErrorAction Stop | Out-Null

        $plsConnection = New-AzPrivateLinkServiceConnection `
            -Name "$privateEndpointName-connection" `
            -PrivateLinkServiceId $ampls.ResourceId `
            -GroupId "azuremonitor" `
            -ErrorAction Stop

        $privateEndpoint = New-AzPrivateEndpoint `
            -ResourceGroupName $ResourceGroupName `
            -Name $privateEndpointName `
            -Location $Location `
            -Subnet $privateLinkSubnet `
            -PrivateLinkServiceConnection $plsConnection `
            -ErrorAction Stop

        Write-ToLog -Message "Private Endpoint created: $privateEndpointName" -Level "SUCCESS"

        # Create Private DNS Zone if configured
        if ($amplsConfig.createPrivateDnsZone) {
            $dnsZoneName = "privatelink.monitor.azure.com"
            $existingDnsZone = Get-AzPrivateDnsZone -ResourceGroupName $ResourceGroupName -Name $dnsZoneName -ErrorAction SilentlyContinue

            if ($null -eq $existingDnsZone) {
                New-AzPrivateDnsZone `
                    -ResourceGroupName $ResourceGroupName `
                    -Name $dnsZoneName `
                    -ErrorAction Stop | Out-Null

                New-AzPrivateDnsVirtualNetworkLink `
                    -ResourceGroupName $ResourceGroupName `
                    -ZoneName $dnsZoneName `
                    -Name "link-to-$($VNet.Name)" `
                    -VirtualNetworkId $VNet.Id `
                    -ErrorAction Stop | Out-Null

                Write-ToLog -Message "Private DNS Zone created and linked: $dnsZoneName" -Level "SUCCESS"
            }
        }

        return @{
            AMPLS = $ampls
            PrivateEndpoint = $privateEndpoint
        }

    } catch {
        Write-ToLog -Message "Failed to create Private Link resources: $($_.Exception.Message)" -Level "ERROR"
        throw
    }
}

# Main execution
try {
    $storageAccount = $null
    if ($ResourceNames.StorageAccount) {
        $storageAccount = Get-AzStorageAccount `
            -ResourceGroupName $ResourceGroupName `
            -Name $ResourceNames.StorageAccount `
            -ErrorAction SilentlyContinue
    }

    $workspace = Deploy-LogAnalyticsWorkspace
    $sentinel = Deploy-Sentinel -Workspace $workspace
    $dataConnectors = Deploy-SentinelDataConnectors -Workspace $workspace
    $flowLogs = Deploy-FlowLogs -Workspace $workspace -VNet $VNet -StorageAccount $storageAccount
    $privateLink = Deploy-PrivateLink -Workspace $workspace -VNet $VNet

    Write-ToLog -Message "Monitoring deployment completed" -Level "SUCCESS"

    return @{
        Workspace = $workspace
        Sentinel = $sentinel
        DataConnectors = $dataConnectors
        FlowLogs = $flowLogs
        PrivateLink = $privateLink
    }

} catch {
    Write-ToLog -Message "Monitoring deployment failed: $($_.Exception.Message)" -Level "ERROR"
    throw
}
