# Deploy-VPN.ps1
# Deploys VPN Gateway, Local Network Gateway, and VPN Connection
# This is a long-running operation (~30-45 minutes) and runs as the final phase

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

$ErrorActionPreference = "Stop"
$SkipExisting = $OperationParams.validation.skipExistingResources

function Deploy-VPNGateway {
    param($VNet)

    if (-not $OperationParams.deployment.infrastructure.deployVPNGateway -or -not $AzureParams.infrastructure.vpnGateway.enabled) {
        return $null
    }

    $vpnName = $ResourceNames.VPNGateway
    $pipName = $ResourceNames.VPNPublicIP

    $existingVPN = Get-AzVirtualNetworkGateway -Name $vpnName -ResourceGroupName $ResourceGroupName -ErrorAction SilentlyContinue
    if ($null -ne $existingVPN -and $SkipExisting) {
        Write-ToLog -Message "VPN Gateway already exists: $vpnName" -Level "INFO"
        return $existingVPN
    }

    try {
        # Create Public IP for VPN Gateway
        $pip = New-AzPublicIpAddress -Name $pipName -ResourceGroupName $ResourceGroupName -Location $Location -AllocationMethod Static -Sku Standard -ErrorAction Stop

        $gatewaySubnet = $VNet.Subnets | Where-Object { $_.Name -eq "GatewaySubnet" }

        if ($null -eq $gatewaySubnet) {
            throw "GatewaySubnet is required for VPN Gateway"
        }

        $gwIpConfig = New-AzVirtualNetworkGatewayIpConfig -Name "gwIpConfig" -SubnetId $gatewaySubnet.Id -PublicIpAddressId $pip.Id -ErrorAction Stop

        Write-ToLog -Message "Creating VPN Gateway (this takes 30-45 minutes)..." -Level "INFO"

        $vpnGateway = New-AzVirtualNetworkGateway -Name $vpnName -ResourceGroupName $ResourceGroupName -Location $Location -IpConfigurations $gwIpConfig -GatewayType Vpn -VpnType $AzureParams.infrastructure.vpnGateway.type -GatewaySku $AzureParams.infrastructure.vpnGateway.sku -ErrorAction Stop

        Write-ToLog -Message "VPN Gateway created: $vpnName" -Level "SUCCESS"
        return $vpnGateway
    } catch {
        Write-ToLog -Message "Failed to create VPN Gateway: $($_.Exception.Message)" -Level "ERROR"
        throw
    }
}

function Deploy-LocalNetworkGateway {
    $onPremParams = $AzureParams.infrastructure.onPremises

    if (-not $onPremParams.enabled) {
        return $null
    }

    if (-not $OperationParams.deployment.infrastructure.deployVPNGateway) {
        return $null
    }

    $lngName = $onPremParams.localNetworkGateway.name

    $existingLng = Get-AzLocalNetworkGateway -Name $lngName -ResourceGroupName $ResourceGroupName -ErrorAction SilentlyContinue
    if ($null -ne $existingLng -and $SkipExisting) {
        Write-ToLog -Message "Local Network Gateway already exists: $lngName" -Level "INFO"
        return $existingLng
    }

    if ($onPremParams.localNetworkGateway.gatewayIpAddress -like "*YOUR-ONPREM-PUBLIC-IP*") {
        Write-ToLog -Message "Local Network Gateway skipped - placeholder IP address configured" -Level "INFO"
        return $null
    }

    try {
        $lng = New-AzLocalNetworkGateway -Name $lngName -ResourceGroupName $ResourceGroupName -Location $Location -GatewayIpAddress $onPremParams.localNetworkGateway.gatewayIpAddress -AddressPrefix $onPremParams.localNetworkGateway.addressPrefixes -ErrorAction Stop

        Write-ToLog -Message "Local Network Gateway created: $lngName" -Level "SUCCESS"
        return $lng
    } catch {
        Write-ToLog -Message "Failed to create Local Network Gateway: $($_.Exception.Message)" -Level "ERROR"
        throw
    }
}

function Deploy-VPNConnection {
    param($VpnGateway, $LocalNetworkGateway)

    if ($null -eq $VpnGateway -or $null -eq $LocalNetworkGateway) {
        return $null
    }

    $onPremParams = $AzureParams.infrastructure.onPremises

    if (-not $onPremParams.enabled) {
        return $null
    }

    $connName = $onPremParams.vpnConnection.name

    $existingConn = Get-AzVirtualNetworkGatewayConnection -Name $connName -ResourceGroupName $ResourceGroupName -ErrorAction SilentlyContinue
    if ($null -ne $existingConn -and $SkipExisting) {
        Write-ToLog -Message "VPN Connection already exists: $connName" -Level "INFO"
        return $existingConn
    }

    if ($onPremParams.vpnConnection.sharedKey -like "*YOUR-SHARED-KEY-HERE*") {
        Write-ToLog -Message "VPN Connection skipped - placeholder shared key configured" -Level "INFO"
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
try {
    # Check if VPN deployment is enabled
    if (-not $OperationParams.deployment.infrastructure.deployVPNGateway -or -not $AzureParams.infrastructure.vpnGateway.enabled) {
        Write-ToLog -Message "VPN deployment skipped - not enabled in configuration" -Level "INFO"
        return @{
            Status = "Skipped"
            Message = "VPN deployment disabled"
        }
    }

    # Get VNet reference
    $vnet = Get-AzVirtualNetwork -ResourceGroupName $ResourceGroupName -Name $ResourceNames.VNet -ErrorAction Stop

    if ($null -eq $vnet) {
        throw "VNet not found - VPN Gateway requires existing VNet"
    }

    $vpnGateway = Deploy-VPNGateway -VNet $vnet
    $localNetworkGateway = Deploy-LocalNetworkGateway
    $vpnConnection = Deploy-VPNConnection -VpnGateway $vpnGateway -LocalNetworkGateway $localNetworkGateway

    Write-ToLog -Message "VPN deployment completed" -Level "SUCCESS"

    return @{
        Status = "Success"
        VPNGateway = $vpnGateway
        LocalNetworkGateway = $localNetworkGateway
        VPNConnection = $vpnConnection
    }
} catch {
    Write-ToLog -Message "VPN deployment failed: $($_.Exception.Message)" -Level "ERROR"
    throw
}
