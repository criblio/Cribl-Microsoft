# Deploy-Networking.ps1
# Deploys VNet, Subnets, and NSGs for Unified Azure Lab
# Note: VPN Gateway deployment moved to Deploy-VPN.ps1 (Phase 6)

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

$SkipExisting = $OperationParams.validation.skipExistingResources

function Deploy-VirtualNetwork {
    if (-not $OperationParams.deployment.infrastructure.deployVNet) {
        return $null
    }

    $vnetName = $ResourceNames.VNet
    $vnetCIDR = $AzureParams.infrastructure.vnetAddressPrefix

    $existingVNet = Get-AzVirtualNetwork -Name $vnetName -ResourceGroupName $ResourceGroupName -ErrorAction SilentlyContinue

    if ($null -ne $existingVNet) {
        if ($SkipExisting) {
            # Check for missing subnets and add them
            $existingSubnets = $existingVNet.Subnets | Select-Object -ExpandProperty Name
            $desiredSubnetNames = @()
            foreach ($subnetKey in $AzureParams.infrastructure.subnets.PSObject.Properties.Name) {
                $desiredSubnetNames += $AzureParams.infrastructure.subnets.$subnetKey.name
            }

            # Remove old subnets
            $subnetsToRemove = $existingSubnets | Where-Object { $_ -notin $desiredSubnetNames }
            if ($subnetsToRemove.Count -gt 0) {
                foreach ($subnetToRemove in $subnetsToRemove) {
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
                foreach ($subnet in $missingSubnets) {
                    Add-AzVirtualNetworkSubnetConfig -Name $subnet.name -VirtualNetwork $existingVNet -AddressPrefix $subnet.addressPrefix -ErrorAction Stop | Out-Null
                }
                $existingVNet | Set-AzVirtualNetwork -ErrorAction Stop | Out-Null
                $existingVNet = Get-AzVirtualNetwork -Name $vnetName -ResourceGroupName $ResourceGroupName
            }

            return $existingVNet
        } else {
            throw "Virtual Network already exists"
        }
    }

    try {
        $vnet = New-AzVirtualNetwork -Name $vnetName -ResourceGroupName $ResourceGroupName -Location $Location -AddressPrefix $vnetCIDR -ErrorAction Stop

        foreach ($subnetKey in $AzureParams.infrastructure.subnets.PSObject.Properties.Name) {
            $subnet = $AzureParams.infrastructure.subnets.$subnetKey
            Add-AzVirtualNetworkSubnetConfig -Name $subnet.name -VirtualNetwork $vnet -AddressPrefix $subnet.addressPrefix -ErrorAction Stop | Out-Null
        }

        $vnet | Set-AzVirtualNetwork -ErrorAction Stop | Out-Null
        Write-ToLog -Message "VNet created: $vnetName" -Level "SUCCESS"
        return Get-AzVirtualNetwork -Name $vnetName -ResourceGroupName $ResourceGroupName
    } catch {
        Write-ToLog -Message "Failed to create VNet: $($_.Exception.Message)" -Level "ERROR"
        throw
    }
}

function Deploy-NetworkSecurityGroups {
    param($VNet)

    if (-not $OperationParams.deployment.infrastructure.deployNSGs) {
        return @()
    }

    $createdNSGs = @()

    foreach ($subnetKey in $AzureParams.infrastructure.subnets.PSObject.Properties.Name) {
        $subnet = $AzureParams.infrastructure.subnets.$subnetKey

        if ($subnet.name -in @("GatewaySubnet", "AzureBastionSubnet")) {
            continue
        }

        $nsgName = $ResourceNames["NSG_$subnetKey"]
        $existingNSG = Get-AzNetworkSecurityGroup -Name $nsgName -ResourceGroupName $ResourceGroupName -ErrorAction SilentlyContinue

        if ($null -ne $existingNSG) {
            $createdNSGs += $existingNSG
            continue
        }

        try {
            $rules = @()

            if ($AzureParams.infrastructure.networkSecurity.allowOnPremisesTraffic -and $AzureParams.infrastructure.onPremisesNetwork.addressSpaces.Count -gt 0) {
                $priority = 100
                foreach ($onPremNetwork in $AzureParams.infrastructure.onPremisesNetwork.addressSpaces) {
                    $rules += New-AzNetworkSecurityRuleConfig -Name "AllowOnPremises_$priority" -Priority $priority -Direction Inbound -Access Allow -Protocol * -SourceAddressPrefix $onPremNetwork -SourcePortRange * -DestinationAddressPrefix * -DestinationPortRange * -ErrorAction Stop
                    $priority++
                }
            }

            if ($AzureParams.infrastructure.networkSecurity.allowAzureServices) {
                $rules += New-AzNetworkSecurityRuleConfig -Name "AllowAzureServices" -Priority 120 -Direction Inbound -Access Allow -Protocol * -SourceAddressPrefix AzureCloud -SourcePortRange * -DestinationAddressPrefix * -DestinationPortRange * -ErrorAction Stop
            }

            if ($rules.Count -gt 0) {
                $nsg = New-AzNetworkSecurityGroup -Name $nsgName -ResourceGroupName $ResourceGroupName -Location $Location -SecurityRules $rules -ErrorAction Stop
            } else {
                $nsg = New-AzNetworkSecurityGroup -Name $nsgName -ResourceGroupName $ResourceGroupName -Location $Location -ErrorAction Stop
            }

            $createdNSGs += $nsg

            if ($VNet) {
                $subnetConfig = $VNet.Subnets | Where-Object { $_.Name -eq $subnet.name }
                if ($subnetConfig) {
                    $subnetConfig.NetworkSecurityGroup = $nsg
                    $VNet | Set-AzVirtualNetwork -ErrorAction Stop | Out-Null
                }
            }

            Write-ToLog -Message "NSG created: $nsgName" -Level "SUCCESS"
        } catch {
            Write-ToLog -Message "Failed to create NSG $nsgName : $($_.Exception.Message)" -Level "ERROR"
        }
    }

    return $createdNSGs
}

function Deploy-VPNGateway {
    param($VNet)

    if (-not $OperationParams.deployment.infrastructure.deployVPNGateway -or -not $AzureParams.infrastructure.vpnGateway.enabled) {
        return $null
    }

    $vpnName = $ResourceNames.VPNGateway
    $pipName = $ResourceNames.VPNPublicIP

    $existingVPN = Get-AzVirtualNetworkGateway -Name $vpnName -ResourceGroupName $ResourceGroupName -ErrorAction SilentlyContinue
    if ($null -ne $existingVPN) {
        return $existingVPN
    }

    try {
        $pip = New-AzPublicIpAddress -Name $pipName -ResourceGroupName $ResourceGroupName -Location $Location -AllocationMethod Static -Sku Standard -Zone 1,2,3 -ErrorAction Stop

        $vnetName = $VNet.Name
        $VNet = Get-AzVirtualNetwork -Name $vnetName -ResourceGroupName $ResourceGroupName -ErrorAction Stop
        $gatewaySubnet = $VNet.Subnets | Where-Object { $_.Name -eq "GatewaySubnet" }

        if ($null -eq $gatewaySubnet) {
            throw "GatewaySubnet is required for VPN Gateway"
        }

        $gwIpConfig = New-AzVirtualNetworkGatewayIpConfig -Name "gwIpConfig" -SubnetId $gatewaySubnet.Id -PublicIpAddressId $pip.Id -ErrorAction Stop

        $vpnGateway = New-AzVirtualNetworkGateway -Name $vpnName -ResourceGroupName $ResourceGroupName -Location $Location -IpConfigurations $gwIpConfig -GatewayType Vpn -VpnType $AzureParams.infrastructure.vpnGateway.type -GatewaySku $AzureParams.infrastructure.vpnGateway.sku -ErrorAction Stop

        Write-ToLog -Message "VPN Gateway created: $vpnName" -Level "SUCCESS"
        return $vpnGateway
    } catch {
        Write-ToLog -Message "Failed to create VPN Gateway: $($_.Exception.Message)" -Level "ERROR"
        throw
    }
}

function Deploy-AzureBastion {
    param($VNet)

    if (-not $OperationParams.deployment.infrastructure.deployBastion -or -not $AzureParams.infrastructure.bastion.enabled) {
        return $null
    }

    $bastionName = $ResourceNames.Bastion
    $pipName = $ResourceNames.BastionPublicIP

    $existingBastion = Get-AzBastion -ResourceGroupName $ResourceGroupName -Name $bastionName -ErrorAction SilentlyContinue
    if ($null -ne $existingBastion) {
        return $existingBastion
    }

    try {
        $pip = New-AzPublicIpAddress -Name $pipName -ResourceGroupName $ResourceGroupName -Location $Location -AllocationMethod Static -Sku Standard -ErrorAction Stop

        $bastionSubnet = $VNet.Subnets | Where-Object { $_.Name -eq "AzureBastionSubnet" }
        if ($null -eq $bastionSubnet) {
            throw "AzureBastionSubnet is required for Azure Bastion"
        }

        $bastion = New-AzBastion -ResourceGroupName $ResourceGroupName -Name $bastionName -PublicIpAddress $pip -VirtualNetwork $VNet -Sku $AzureParams.infrastructure.bastion.sku -ErrorAction Stop

        Write-ToLog -Message "Azure Bastion created: $bastionName" -Level "SUCCESS"
        return $bastion
    } catch {
        Write-ToLog -Message "Failed to create Azure Bastion: $($_.Exception.Message)" -Level "ERROR"
        throw
    }
}

function Deploy-LocalNetworkGateway {
    $onPremParamsPath = Join-Path $PSScriptRoot "..\onprem-connection-parameters.json"

    if (-not (Test-Path $onPremParamsPath)) {
        return $null
    }

    try {
        $onPremParams = Get-Content $onPremParamsPath -Raw | ConvertFrom-Json
    } catch {
        return $null
    }

    $lngName = $onPremParams.localNetworkGateway.name

    $existingLng = Get-AzLocalNetworkGateway -Name $lngName -ResourceGroupName $ResourceGroupName -ErrorAction SilentlyContinue
    if ($null -ne $existingLng) {
        return $existingLng
    }

    if ($onPremParams.localNetworkGateway.gatewayIpAddress -like "*YOUR-ONPREM-PUBLIC-IP*") {
        return $null
    }

    try {
        $lng = New-AzLocalNetworkGateway -Name $lngName -ResourceGroupName $ResourceGroupName -Location $Location -GatewayIpAddress $onPremParams.localNetworkGateway.gatewayIpAddress -AddressPrefix $onPremParams.localNetworkGateway.addressSpace -ErrorAction Stop

        Write-ToLog -Message "Local Network Gateway created: $lngName" -Level "SUCCESS"
        return $lng
    } catch {
        Write-ToLog -Message "Failed to create Local Network Gateway: $($_.Exception.Message)" -Level "ERROR"
        throw
    }
}

function Deploy-VPNConnection {
    param($VpnGateway, $LocalNetworkGateway)

    $onPremParamsPath = Join-Path $PSScriptRoot "..\onprem-connection-parameters.json"

    if (-not (Test-Path $onPremParamsPath)) {
        return $null
    }

    try {
        $onPremParams = Get-Content $onPremParamsPath -Raw | ConvertFrom-Json
    } catch {
        return $null
    }

    if ($null -eq $VpnGateway -or $null -eq $LocalNetworkGateway) {
        return $null
    }

    $connName = $onPremParams.vpnConnection.name

    $existingConn = Get-AzVirtualNetworkGatewayConnection -Name $connName -ResourceGroupName $ResourceGroupName -ErrorAction SilentlyContinue
    if ($null -ne $existingConn) {
        return $existingConn
    }

    if ($onPremParams.vpnConnection.sharedKey -like "*YOUR-SHARED-KEY-HERE*") {
        return $null
    }

    try {
        $connectionParams = @{
            Name = $connName
            ResourceGroupName = $ResourceGroupName
            Location = $Location
            VirtualNetworkGateway1 = $VpnGateway
            LocalNetworkGateway2 = $LocalNetworkGateway
            ConnectionType = $onPremParams.vpnConnection.connectionType
            SharedKey = $onPremParams.vpnConnection.sharedKey
            EnableBgp = $onPremParams.vpnConnection.enableBgp
            UsePolicyBasedTrafficSelectors = $onPremParams.vpnConnection.usePolicyBasedTrafficSelectors
            ErrorAction = "Stop"
        }

        if ($onPremParams.vpnConnection.ipsecPolicies.enabled) {
            $ipsecPolicy = New-AzIpsecPolicy -SALifeTimeSeconds $onPremParams.vpnConnection.ipsecPolicies.saLifeTimeSeconds -SADataSizeKilobytes $onPremParams.vpnConnection.ipsecPolicies.saDataSizeKilobytes -IpsecEncryption $onPremParams.vpnConnection.ipsecPolicies.ipsecEncryption -IpsecIntegrity $onPremParams.vpnConnection.ipsecPolicies.ipsecIntegrity -IkeEncryption $onPremParams.vpnConnection.ipsecPolicies.ikeEncryption -IkeIntegrity $onPremParams.vpnConnection.ipsecPolicies.ikeIntegrity -DhGroup $onPremParams.vpnConnection.ipsecPolicies.dhGroup -PfsGroup $onPremParams.vpnConnection.ipsecPolicies.pfsGroup
            $connectionParams.IpsecPolicies = $ipsecPolicy
        }

        $conn = New-AzVirtualNetworkGatewayConnection @connectionParams

        Write-ToLog -Message "VPN Connection created: $connName" -Level "SUCCESS"
        return $conn
    } catch {
        Write-ToLog -Message "Failed to create VPN Connection: $($_.Exception.Message)" -Level "ERROR"
        throw
    }
}

# Main execution
# Note: VPN Gateway deployment has been moved to Deploy-VPN.ps1 (Phase 6)
# This allows the long-running VPN deployment to run after all other resources are ready
try {
    $vnet = Deploy-VirtualNetwork
    $nsgs = Deploy-NetworkSecurityGroups -VNet $vnet
    $bastion = Deploy-AzureBastion -VNet $vnet

    Write-ToLog -Message "Infrastructure deployment completed" -Level "SUCCESS"

    return @{
        VNet = $vnet
        NSGs = $nsgs
        Bastion = $bastion
    }
} catch {
    Write-ToLog -Message "Infrastructure deployment failed: $($_.Exception.Message)" -Level "ERROR"
    throw
}
