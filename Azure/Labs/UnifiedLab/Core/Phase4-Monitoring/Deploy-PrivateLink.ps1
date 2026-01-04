# Deploy-PrivateLink.ps1
# Phase 4, SubPhase 4.4: Deploy Azure Monitor Private Link Scope (AMPLS)
# Dependencies: Log Analytics Workspace (Phase 4.1), VNet (Phase 2.1)

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
    [object]$Workspace = $null,

    [Parameter(Mandatory=$false)]
    [object]$VNet = $null
)

# Early exit check - skip before any debug logging to reduce noise
if (-not $OperationParams.deployment.monitoring.deployPrivateLink -or -not $AzureParams.monitoring.privateLink.enabled) {
    return @{
        Status = "Skipped"
        Message = "Private Link deployment disabled"
        Data = $null
    }
}

# Debug: Log entry parameters
Write-DebugParameters -Parameters @{
    ResourceGroupName = $ResourceGroupName
    Location = $Location
    DeployPrivateLink = $OperationParams.deployment.monitoring.deployPrivateLink
    PrivateLinkEnabled = $AzureParams.monitoring.privateLink.enabled
    WorkspaceProvided = ($null -ne $Workspace)
    VNetProvided = ($null -ne $VNet)
} -Context "Deploy-PrivateLink"

$mainSw = Start-DebugOperation -Operation "Deploy-PrivateLink"

try {
    Write-DebugLog -Message "Starting Private Link deployment..." -Context "Deploy-PrivateLink"

    # Get Workspace if not provided
    if ($null -eq $Workspace) {
        Write-DebugLog -Message "Workspace not provided, looking up: $($ResourceNames.LogAnalytics)" -Context "Deploy-PrivateLink"
        Write-DebugAzureCall -Cmdlet "Get-AzOperationalInsightsWorkspace" -Parameters @{
            ResourceGroupName = $ResourceGroupName
            Name = $ResourceNames.LogAnalytics
        } -Context "Deploy-PrivateLink"
        $Workspace = Get-AzOperationalInsightsWorkspace -ResourceGroupName $ResourceGroupName -Name $ResourceNames.LogAnalytics -ErrorAction SilentlyContinue
    }

    # Get VNet if not provided
    if ($null -eq $VNet) {
        Write-DebugLog -Message "VNet not provided, looking up: $($ResourceNames.VNet)" -Context "Deploy-PrivateLink"
        Write-DebugAzureCall -Cmdlet "Get-AzVirtualNetwork" -Parameters @{
            ResourceGroupName = $ResourceGroupName
            Name = $ResourceNames.VNet
        } -Context "Deploy-PrivateLink"
        $VNet = Get-AzVirtualNetwork -ResourceGroupName $ResourceGroupName -Name $ResourceNames.VNet -ErrorAction SilentlyContinue
    }

    if ($null -eq $VNet -or $null -eq $Workspace) {
        Write-DebugLog -Message "SKIP REASON: VNet or Workspace not available" -Context "Deploy-PrivateLink"
        Stop-DebugOperation -Operation "Deploy-PrivateLink" -Stopwatch $mainSw -Success $true
        return @{
            Status = "Skipped"
            Message = "VNet or Workspace not available"
            Data = $null
        }
    }

    $amplsConfig = $AzureParams.monitoring.privateLink
    $amplsName = "ampls-$($AzureParams.baseObjectName)-$Location"
    Write-DebugLog -Message "AMPLS Name: $amplsName" -Context "Deploy-PrivateLink"

    # Create or get AMPLS
    Write-DebugAzureCall -Cmdlet "Get-AzResource" -Parameters @{
        ResourceGroupName = $ResourceGroupName
        ResourceType = "Microsoft.Insights/privateLinkScopes"
        Name = $amplsName
    } -Context "Deploy-PrivateLink"

    $existingAMPLS = Get-AzResource `
        -ResourceGroupName $ResourceGroupName `
        -ResourceType "Microsoft.Insights/privateLinkScopes" `
        -Name $amplsName `
        -ErrorAction SilentlyContinue

    if ($null -ne $existingAMPLS) {
        Write-DebugLog -Message "Existing AMPLS found" -Context "Deploy-PrivateLink"
        $ampls = Get-AzResource -ResourceId $existingAMPLS.ResourceId
    } else {
        Write-DebugLog -Message "Creating new AMPLS..." -Context "Deploy-PrivateLink"
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
    Write-DebugLog -Message "Checking for scoped resource: $scopedResourceName" -Context "Deploy-PrivateLink"

    $existingScopedResource = Get-AzResource `
        -ResourceGroupName $ResourceGroupName `
        -ResourceType "Microsoft.Insights/privateLinkScopes/scopedResources" `
        -Name "$amplsName/$scopedResourceName" `
        -ErrorAction SilentlyContinue

    if ($null -eq $existingScopedResource) {
        Write-DebugLog -Message "Adding workspace to AMPLS..." -Context "Deploy-PrivateLink"
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
    } else {
        Write-DebugLog -Message "Workspace already associated with AMPLS" -Context "Deploy-PrivateLink"
    }

    # Create Private Endpoint
    $privateEndpointName = "pe-ampls-$($AzureParams.baseObjectName)"
    Write-DebugLog -Message "Private Endpoint Name: $privateEndpointName" -Context "Deploy-PrivateLink"

    Write-DebugAzureCall -Cmdlet "Get-AzPrivateEndpoint" -Parameters @{
        ResourceGroupName = $ResourceGroupName
        Name = $privateEndpointName
    } -Context "Deploy-PrivateLink"

    $existingPE = Get-AzPrivateEndpoint -ResourceGroupName $ResourceGroupName -Name $privateEndpointName -ErrorAction SilentlyContinue

    if ($null -ne $existingPE) {
        Write-DebugLog -Message "Private Endpoint already exists" -Context "Deploy-PrivateLink"
        Stop-DebugOperation -Operation "Deploy-PrivateLink" -Stopwatch $mainSw -Success $true
        return @{
            Status = "Success"
            Message = "Private Link already exists"
            Data = @{
                AMPLS = $ampls
                PrivateEndpoint = $existingPE
            }
        }
    }

    # Find PrivateLinkSubnet
    Write-DebugLog -Message "Looking for PrivateLinkSubnet in VNet..." -Context "Deploy-PrivateLink"
    $privateLinkSubnet = $VNet.Subnets | Where-Object { $_.Name -eq "PrivateLinkSubnet" }
    if ($null -eq $privateLinkSubnet) {
        Write-DebugLog -Message "ERROR: PrivateLinkSubnet not found in VNet" -Context "Deploy-PrivateLink"
        Stop-DebugOperation -Operation "Deploy-PrivateLink" -Stopwatch $mainSw -Success $false
        throw "PrivateLinkSubnet is required for Private Link"
    }
    Write-DebugLog -Message "PrivateLinkSubnet found: $($privateLinkSubnet.Id)" -Context "Deploy-PrivateLink"

    Write-DebugLog -Message "Disabling private endpoint network policies on subnet..." -Context "Deploy-PrivateLink"
    $privateLinkSubnet.PrivateEndpointNetworkPolicies = "Disabled"
    $VNet | Set-AzVirtualNetwork -ErrorAction Stop | Out-Null

    Write-DebugLog -Message "Creating Private Link Service Connection..." -Context "Deploy-PrivateLink"
    $plsConnection = New-AzPrivateLinkServiceConnection `
        -Name "$privateEndpointName-connection" `
        -PrivateLinkServiceId $ampls.ResourceId `
        -GroupId "azuremonitor" `
        -ErrorAction Stop

    Write-DebugLog -Message "Creating Private Endpoint..." -Context "Deploy-PrivateLink"
    Write-DebugAzureCall -Cmdlet "New-AzPrivateEndpoint" -Parameters @{
        ResourceGroupName = $ResourceGroupName
        Name = $privateEndpointName
        Location = $Location
    } -Context "Deploy-PrivateLink"

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
        Write-DebugLog -Message "Checking for Private DNS Zone: $dnsZoneName" -Context "Deploy-PrivateLink"

        $existingDnsZone = Get-AzPrivateDnsZone -ResourceGroupName $ResourceGroupName -Name $dnsZoneName -ErrorAction SilentlyContinue

        if ($null -eq $existingDnsZone) {
            Write-DebugLog -Message "Creating Private DNS Zone..." -Context "Deploy-PrivateLink"
            New-AzPrivateDnsZone `
                -ResourceGroupName $ResourceGroupName `
                -Name $dnsZoneName `
                -ErrorAction Stop | Out-Null

            Write-DebugLog -Message "Linking DNS Zone to VNet..." -Context "Deploy-PrivateLink"
            New-AzPrivateDnsVirtualNetworkLink `
                -ResourceGroupName $ResourceGroupName `
                -ZoneName $dnsZoneName `
                -Name "link-to-$($VNet.Name)" `
                -VirtualNetworkId $VNet.Id `
                -ErrorAction Stop | Out-Null

            Write-ToLog -Message "Private DNS Zone created and linked: $dnsZoneName" -Level "SUCCESS"
        } else {
            Write-DebugLog -Message "Private DNS Zone already exists" -Context "Deploy-PrivateLink"
        }
    }

    Write-DebugLog -Message "Private Link deployment completed successfully" -Context "Deploy-PrivateLink"
    Stop-DebugOperation -Operation "Deploy-PrivateLink" -Stopwatch $mainSw -Success $true

    return @{
        Status = "Success"
        Message = "Private Link deployed successfully"
        Data = @{
            AMPLS = $ampls
            PrivateEndpoint = $privateEndpoint
        }
    }

} catch {
    Write-ToLog -Message "Private Link deployment failed: $($_.Exception.Message)" -Level "ERROR"
    Write-DebugException -Exception $_.Exception -Context "Deploy-PrivateLink"
    Stop-DebugOperation -Operation "Deploy-PrivateLink" -Stopwatch $mainSw -Success $false

    return @{
        Status = "Failed"
        Message = $_.Exception.Message
        Data = $null
    }
}
