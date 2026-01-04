# Deploy-VPNGateway.ps1
# Phase 10, SubPhase 10.1: Deploy VPN Gateway
# Dependencies: VNet with GatewaySubnet (Phase 2.1)
# Note: This is a long-running operation (~30-45 minutes)

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

# Early exit check - skip before any debug logging to reduce noise
if (-not $OperationParams.deployment.infrastructure.deployVPNGateway -or -not $AzureParams.infrastructure.vpnGateway.enabled) {
    return @{
        Status = "Skipped"
        Message = "VPN Gateway deployment disabled"
        Data = $null
    }
}

$ErrorActionPreference = "Stop"
$SkipExisting = $OperationParams.validation.skipExistingResources

# Debug: Log entry parameters
Write-DebugParameters -Parameters @{
    ResourceGroupName = $ResourceGroupName
    Location = $Location
    SkipExisting = $SkipExisting
    DeployVPNGateway = $OperationParams.deployment.infrastructure.deployVPNGateway
    VPNGatewayEnabled = $AzureParams.infrastructure.vpnGateway.enabled
    VPNGatewaySku = $AzureParams.infrastructure.vpnGateway.sku
    VPNGatewayType = $AzureParams.infrastructure.vpnGateway.type
    VNetProvided = ($null -ne $VNet)
} -Context "Deploy-VPNGateway"

$mainSw = Start-DebugOperation -Operation "Deploy-VPNGateway"

try {
    Write-DebugLog -Message "Starting VPN Gateway deployment..." -Context "Deploy-VPNGateway"

    $vpnName = $ResourceNames.VPNGateway
    $pipName = $ResourceNames.VPNPublicIP

    Write-DebugLog -Message "VPN Gateway Name: $vpnName" -Context "Deploy-VPNGateway"
    Write-DebugLog -Message "Public IP Name: $pipName" -Context "Deploy-VPNGateway"

    # Check for existing VPN Gateway
    Write-DebugAzureCall -Cmdlet "Get-AzVirtualNetworkGateway" -Parameters @{
        Name = $vpnName
        ResourceGroupName = $ResourceGroupName
    } -Context "Deploy-VPNGateway"
    $existingVPN = Get-AzVirtualNetworkGateway -Name $vpnName -ResourceGroupName $ResourceGroupName -ErrorAction SilentlyContinue

    if ($null -ne $existingVPN) {
        Write-DebugLog -Message "Existing VPN Gateway found" -Context "Deploy-VPNGateway"
        Write-DebugResource -ResourceType "VirtualNetworkGateway" -ResourceName $vpnName -ResourceId $existingVPN.Id -Properties @{
            ProvisioningState = $existingVPN.ProvisioningState
            GatewayType = $existingVPN.GatewayType
            VpnType = $existingVPN.VpnType
            Sku = $existingVPN.Sku.Name
        } -Context "Deploy-VPNGateway"

        if ($SkipExisting) {
            Write-ToLog -Message "VPN Gateway already exists: $vpnName" -Level "SUCCESS"
            Stop-DebugOperation -Operation "Deploy-VPNGateway" -Stopwatch $mainSw -Success $true
            return @{
                Status = "Success"
                Message = "VPN Gateway already exists"
                Data = @{
                    VPNGateway = $existingVPN
                }
            }
        } else {
            Write-DebugLog -Message "ERROR: VPN Gateway exists and SkipExisting is false" -Context "Deploy-VPNGateway"
            Stop-DebugOperation -Operation "Deploy-VPNGateway" -Stopwatch $mainSw -Success $false
            throw "VPN Gateway already exists"
        }
    }

    # Get VNet if not provided
    if ($null -eq $VNet) {
        Write-DebugLog -Message "VNet not provided, looking up: $($ResourceNames.VNet)" -Context "Deploy-VPNGateway"
        Write-DebugAzureCall -Cmdlet "Get-AzVirtualNetwork" -Parameters @{
            Name = $ResourceNames.VNet
            ResourceGroupName = $ResourceGroupName
        } -Context "Deploy-VPNGateway"
        $VNet = Get-AzVirtualNetwork -ResourceGroupName $ResourceGroupName -Name $ResourceNames.VNet -ErrorAction SilentlyContinue
    }

    if ($null -eq $VNet) {
        Write-DebugLog -Message "ERROR: VNet required for VPN Gateway but not found" -Context "Deploy-VPNGateway"
        Stop-DebugOperation -Operation "Deploy-VPNGateway" -Stopwatch $mainSw -Success $false
        throw "VNet not found - VPN Gateway requires existing VNet"
    }

    Write-DebugResource -ResourceType "VirtualNetwork" -ResourceName $VNet.Name -ResourceId $VNet.Id -Properties @{
        AddressSpace = ($VNet.AddressSpace.AddressPrefixes -join ', ')
        SubnetCount = $VNet.Subnets.Count
        Subnets = ($VNet.Subnets.Name -join ', ')
    } -Context "Deploy-VPNGateway"

    # Check for GatewaySubnet
    Write-DebugLog -Message "Looking for GatewaySubnet in VNet..." -Context "Deploy-VPNGateway"
    $gatewaySubnet = $VNet.Subnets | Where-Object { $_.Name -eq "GatewaySubnet" }

    if ($null -eq $gatewaySubnet) {
        Write-DebugLog -Message "ERROR: GatewaySubnet not found in VNet!" -Context "Deploy-VPNGateway"
        Stop-DebugOperation -Operation "Deploy-VPNGateway" -Stopwatch $mainSw -Success $false
        throw "GatewaySubnet is required for VPN Gateway"
    }

    Write-DebugLog -Message "GatewaySubnet found: $($gatewaySubnet.Id)" -Context "Deploy-VPNGateway"
    Write-DebugLog -Message "GatewaySubnet AddressPrefix: $($gatewaySubnet.AddressPrefix)" -Context "Deploy-VPNGateway"

    # Create Public IP for VPN Gateway (Basic SKU with Dynamic allocation for Basic VPN Gateway)
    Write-DebugLog -Message "Creating Public IP for VPN Gateway..." -Context "Deploy-VPNGateway"
    Write-DebugAzureCall -Cmdlet "New-AzPublicIpAddress" -Parameters @{
        Name = $pipName
        ResourceGroupName = $ResourceGroupName
        Location = $Location
        AllocationMethod = "Dynamic"
        Sku = "Basic"
    } -Context "Deploy-VPNGateway"

    $pip = New-AzPublicIpAddress `
        -Name $pipName `
        -ResourceGroupName $ResourceGroupName `
        -Location $Location `
        -AllocationMethod Dynamic `
        -Sku Basic `
        -ErrorAction Stop

    Write-DebugLog -Message "Public IP created: $($pip.Id)" -Context "Deploy-VPNGateway"

    # Create Gateway IP Configuration
    Write-DebugLog -Message "Creating Gateway IP Configuration..." -Context "Deploy-VPNGateway"
    $gwIpConfig = New-AzVirtualNetworkGatewayIpConfig `
        -Name "gwIpConfig" `
        -SubnetId $gatewaySubnet.Id `
        -PublicIpAddressId $pip.Id `
        -ErrorAction Stop

    Write-DebugLog -Message "Gateway IP Config created" -Context "Deploy-VPNGateway"

    # Create VPN Gateway
    Write-ToLog -Message "Creating VPN Gateway (this takes 30-45 minutes)..." -Level "INFO"
    Write-DebugLog -Message "Starting VPN Gateway creation - this is a long-running operation" -Context "Deploy-VPNGateway"
    Write-DebugAzureCall -Cmdlet "New-AzVirtualNetworkGateway" -Parameters @{
        Name = $vpnName
        ResourceGroupName = $ResourceGroupName
        Location = $Location
        GatewayType = "Vpn"
        VpnType = $AzureParams.infrastructure.vpnGateway.type
        GatewaySku = $AzureParams.infrastructure.vpnGateway.sku
    } -Context "Deploy-VPNGateway"

    $vpnGateway = New-AzVirtualNetworkGateway `
        -Name $vpnName `
        -ResourceGroupName $ResourceGroupName `
        -Location $Location `
        -IpConfigurations $gwIpConfig `
        -GatewayType Vpn `
        -VpnType $AzureParams.infrastructure.vpnGateway.type `
        -GatewaySku $AzureParams.infrastructure.vpnGateway.sku `
        -ErrorAction Stop

    Write-ToLog -Message "VPN Gateway created: $vpnName" -Level "SUCCESS"
    Write-DebugResource -ResourceType "VirtualNetworkGateway" -ResourceName $vpnName -ResourceId $vpnGateway.Id -Properties @{
        ProvisioningState = $vpnGateway.ProvisioningState
        GatewayType = $vpnGateway.GatewayType
        VpnType = $vpnGateway.VpnType
        Sku = $vpnGateway.Sku.Name
    } -Context "Deploy-VPNGateway"

    Stop-DebugOperation -Operation "Deploy-VPNGateway" -Stopwatch $mainSw -Success $true

    return @{
        Status = "Success"
        Message = "VPN Gateway deployed successfully"
        Data = @{
            VPNGateway = $vpnGateway
            PublicIP = $pip
        }
    }

} catch {
    Write-ToLog -Message "VPN Gateway deployment failed: $($_.Exception.Message)" -Level "ERROR"
    Write-DebugException -Exception $_.Exception -Context "Deploy-VPNGateway"
    Stop-DebugOperation -Operation "Deploy-VPNGateway" -Stopwatch $mainSw -Success $false

    return @{
        Status = "Failed"
        Message = $_.Exception.Message
        Data = $null
    }
}
