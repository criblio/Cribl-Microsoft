# Deploy-VNet.ps1
# Phase 2, SubPhase 2.1: Deploy Virtual Network with Subnets
# Dependencies: Resource Group (Phase 1.1)

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
    [hashtable]$ResourceNames
)

# Early exit check - skip before any debug logging to reduce noise
if (-not $OperationParams.deployment.infrastructure.deployVNet) {
    return @{
        Status = "Skipped"
        Message = "VNet deployment disabled"
        Data = $null
    }
}

$SkipExisting = $OperationParams.validation.skipExistingResources

# Debug: Log entry parameters
Write-DebugParameters -Parameters @{
    ResourceGroupName = $ResourceGroupName
    Location = $Location
    SkipExisting = $SkipExisting
    DeployVNet = $OperationParams.deployment.infrastructure.deployVNet
    VNetName = $ResourceNames.VNet
    VNetAddressPrefix = $AzureParams.infrastructure.vnetAddressPrefix
} -Context "Deploy-VNet"

$mainSw = Start-DebugOperation -Operation "Deploy-VNet"

try {
    Write-DebugLog -Message "Starting VNet deployment..." -Context "Deploy-VNet"

    $vnetName = $ResourceNames.VNet
    $vnetCIDR = $AzureParams.infrastructure.vnetAddressPrefix

    Write-DebugLog -Message "VNet Name: $vnetName" -Context "Deploy-VNet"
    Write-DebugLog -Message "VNet CIDR: $vnetCIDR" -Context "Deploy-VNet"

    Write-DebugAzureCall -Cmdlet "Get-AzVirtualNetwork" -Parameters @{
        Name = $vnetName
        ResourceGroupName = $ResourceGroupName
    } -Context "Deploy-VNet"

    $existingVNet = Get-AzVirtualNetwork -Name $vnetName -ResourceGroupName $ResourceGroupName -ErrorAction SilentlyContinue

    if ($null -ne $existingVNet) {
        Write-DebugLog -Message "Existing VNet found: $vnetName" -Context "Deploy-VNet"
        Write-DebugResource -ResourceType "VirtualNetwork" -ResourceName $vnetName -ResourceId $existingVNet.Id -Properties @{
            AddressSpace = ($existingVNet.AddressSpace.AddressPrefixes -join ', ')
            SubnetCount = $existingVNet.Subnets.Count
            ExistingSubnets = ($existingVNet.Subnets.Name -join ', ')
        } -Context "Deploy-VNet"

        if ($SkipExisting) {
            # Check for missing subnets and add them
            $existingSubnets = $existingVNet.Subnets | Select-Object -ExpandProperty Name
            $desiredSubnetNames = @()
            foreach ($subnetKey in $AzureParams.infrastructure.subnets.PSObject.Properties.Name) {
                $desiredSubnetNames += $AzureParams.infrastructure.subnets.$subnetKey.name
            }

            Write-DebugLog -Message "Existing subnets: $($existingSubnets -join ', ')" -Context "Deploy-VNet"
            Write-DebugLog -Message "Desired subnets: $($desiredSubnetNames -join ', ')" -Context "Deploy-VNet"

            # Remove old subnets that are not in desired list
            $subnetsToRemove = $existingSubnets | Where-Object { $_ -notin $desiredSubnetNames }
            if ($subnetsToRemove.Count -gt 0) {
                Write-DebugLog -Message "Subnets to remove: $($subnetsToRemove -join ', ')" -Context "Deploy-VNet"
                foreach ($subnetToRemove in $subnetsToRemove) {
                    Write-DebugLog -Message "Removing subnet: $subnetToRemove" -Context "Deploy-VNet"
                    Remove-AzVirtualNetworkSubnetConfig -Name $subnetToRemove -VirtualNetwork $existingVNet -ErrorAction Stop | Out-Null
                }
                $existingVNet | Set-AzVirtualNetwork -ErrorAction Stop | Out-Null
                $existingVNet = Get-AzVirtualNetwork -Name $vnetName -ResourceGroupName $ResourceGroupName
                $existingSubnets = $existingVNet.Subnets | Select-Object -ExpandProperty Name
            }

            # Add missing subnets
            $missingSubnets = @()
            foreach ($subnetKey in $AzureParams.infrastructure.subnets.PSObject.Properties.Name) {
                $subnet = $AzureParams.infrastructure.subnets.$subnetKey
                if ($subnet.name -notin $existingSubnets) {
                    $missingSubnets += $subnet
                }
            }

            if ($missingSubnets.Count -gt 0) {
                Write-DebugLog -Message "Missing subnets to add: $($missingSubnets.name -join ', ')" -Context "Deploy-VNet"
                foreach ($subnet in $missingSubnets) {
                    Write-DebugLog -Message "Adding subnet: $($subnet.name) with prefix $($subnet.addressPrefix)" -Context "Deploy-VNet"
                    Add-AzVirtualNetworkSubnetConfig -Name $subnet.name -VirtualNetwork $existingVNet -AddressPrefix $subnet.addressPrefix -ErrorAction Stop | Out-Null
                }
                $existingVNet | Set-AzVirtualNetwork -ErrorAction Stop | Out-Null
                $existingVNet = Get-AzVirtualNetwork -Name $vnetName -ResourceGroupName $ResourceGroupName
            }

            Write-ToLog -Message "VNet exists: $vnetName (subnets synchronized)" -Level "SUCCESS"
            Write-DebugLog -Message "Using existing VNet with updated subnets" -Context "Deploy-VNet"
            Stop-DebugOperation -Operation "Deploy-VNet" -Stopwatch $mainSw -Success $true

            return @{
                Status = "Success"
                Message = "VNet already exists (subnets synchronized)"
                Data = @{
                    VNet = $existingVNet
                    Name = $vnetName
                }
            }
        } else {
            Write-DebugLog -Message "ERROR: VNet exists and SkipExisting is false" -Context "Deploy-VNet"
            Stop-DebugOperation -Operation "Deploy-VNet" -Stopwatch $mainSw -Success $false
            throw "Virtual Network already exists"
        }
    }

    # Create new VNet
    Write-DebugLog -Message "Creating new VNet..." -Context "Deploy-VNet"
    Write-DebugAzureCall -Cmdlet "New-AzVirtualNetwork" -Parameters @{
        Name = $vnetName
        ResourceGroupName = $ResourceGroupName
        Location = $Location
        AddressPrefix = $vnetCIDR
    } -Context "Deploy-VNet"

    $vnet = New-AzVirtualNetwork -Name $vnetName -ResourceGroupName $ResourceGroupName -Location $Location -AddressPrefix $vnetCIDR -ErrorAction Stop

    Write-DebugLog -Message "Adding subnets to VNet..." -Context "Deploy-VNet"
    foreach ($subnetKey in $AzureParams.infrastructure.subnets.PSObject.Properties.Name) {
        $subnet = $AzureParams.infrastructure.subnets.$subnetKey
        Write-DebugLog -Message "Adding subnet: $($subnet.name) with prefix $($subnet.addressPrefix)" -Context "Deploy-VNet"
        Add-AzVirtualNetworkSubnetConfig -Name $subnet.name -VirtualNetwork $vnet -AddressPrefix $subnet.addressPrefix -ErrorAction Stop | Out-Null
    }

    Write-DebugLog -Message "Applying VNet configuration..." -Context "Deploy-VNet"
    $vnet | Set-AzVirtualNetwork -ErrorAction Stop | Out-Null
    Write-ToLog -Message "VNet created: $vnetName" -Level "SUCCESS"

    $finalVnet = Get-AzVirtualNetwork -Name $vnetName -ResourceGroupName $ResourceGroupName
    Write-DebugResource -ResourceType "VirtualNetwork" -ResourceName $vnetName -ResourceId $finalVnet.Id -Properties @{
        AddressSpace = ($finalVnet.AddressSpace.AddressPrefixes -join ', ')
        SubnetCount = $finalVnet.Subnets.Count
        Subnets = ($finalVnet.Subnets.Name -join ', ')
    } -Context "Deploy-VNet"

    Stop-DebugOperation -Operation "Deploy-VNet" -Stopwatch $mainSw -Success $true

    return @{
        Status = "Success"
        Message = "VNet created successfully"
        Data = @{
            VNet = $finalVnet
            Name = $vnetName
        }
    }

} catch {
    Write-ToLog -Message "VNet deployment failed: $($_.Exception.Message)" -Level "ERROR"
    Write-DebugException -Exception $_.Exception -Context "Deploy-VNet"
    Stop-DebugOperation -Operation "Deploy-VNet" -Stopwatch $mainSw -Success $false

    return @{
        Status = "Failed"
        Message = $_.Exception.Message
        Data = $null
    }
}
