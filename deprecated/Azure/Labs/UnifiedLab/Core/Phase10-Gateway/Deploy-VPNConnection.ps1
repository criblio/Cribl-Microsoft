# Deploy-VPNConnection.ps1
# Phase 10, SubPhase 10.2: Deploy Local Network Gateway and VPN Connection
# Dependencies: VPN Gateway (Phase 10.1)

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
    [object]$VPNGateway = $null
)

# Early exit check - skip before any debug logging to reduce noise
if (-not $AzureParams.infrastructure.onPremises.enabled) {
    return @{
        Status = "Skipped"
        Message = "On-premises connectivity disabled"
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
    OnPremisesEnabled = $AzureParams.infrastructure.onPremises.enabled
    VPNGatewayProvided = ($null -ne $VPNGateway)
} -Context "Deploy-VPNConnection"

$mainSw = Start-DebugOperation -Operation "Deploy-VPNConnection"

try {
    Write-DebugLog -Message "Starting VPN Connection deployment..." -Context "Deploy-VPNConnection"

    # Get VPN Gateway if not provided
    if ($null -eq $VPNGateway) {
        $vpnName = $ResourceNames.VPNGateway
        Write-DebugLog -Message "VPN Gateway not provided, looking up: $vpnName" -Context "Deploy-VPNConnection"
        Write-DebugAzureCall -Cmdlet "Get-AzVirtualNetworkGateway" -Parameters @{
            Name = $vpnName
            ResourceGroupName = $ResourceGroupName
        } -Context "Deploy-VPNConnection"
        $VPNGateway = Get-AzVirtualNetworkGateway -Name $vpnName -ResourceGroupName $ResourceGroupName -ErrorAction SilentlyContinue
    }

    if ($null -eq $VPNGateway) {
        Write-DebugLog -Message "SKIP REASON: VPN Gateway not found" -Context "Deploy-VPNConnection"
        Write-ToLog -Message "VPN Gateway not found, cannot create VPN Connection" -Level "INFO"
        Stop-DebugOperation -Operation "Deploy-VPNConnection" -Stopwatch $mainSw -Success $true
        return @{
            Status = "Skipped"
            Message = "VPN Gateway not available"
            Data = $null
        }
    }

    Write-DebugResource -ResourceType "VirtualNetworkGateway" -ResourceName $VPNGateway.Name -ResourceId $VPNGateway.Id -Properties @{
        ProvisioningState = $VPNGateway.ProvisioningState
        GatewayType = $VPNGateway.GatewayType
    } -Context "Deploy-VPNConnection"

    # Deploy Local Network Gateway
    $lngName = $onPremParams.localNetworkGateway.name
    Write-DebugLog -Message "Local Network Gateway Name: $lngName" -Context "Deploy-VPNConnection"
    Write-DebugLog -Message "Gateway IP Address: $($onPremParams.localNetworkGateway.gatewayIpAddress)" -Context "Deploy-VPNConnection"
    Write-DebugLog -Message "Address Prefixes: $($onPremParams.localNetworkGateway.addressPrefixes -join ', ')" -Context "Deploy-VPNConnection"

    # Check for placeholder IP address
    if ($onPremParams.localNetworkGateway.gatewayIpAddress -like "*YOUR-ONPREM-PUBLIC-IP*" -or
        $onPremParams.localNetworkGateway.gatewayIpAddress -like "*<*>*" -or
        [string]::IsNullOrWhiteSpace($onPremParams.localNetworkGateway.gatewayIpAddress)) {

        Write-DebugLog -Message "SKIP REASON: Gateway IP contains placeholder value" -Context "Deploy-VPNConnection"
        Write-ToLog -Message "Local Network Gateway skipped - placeholder IP address configured" -Level "INFO"
        Stop-DebugOperation -Operation "Deploy-VPNConnection" -Stopwatch $mainSw -Success $true
        return @{
            Status = "Skipped"
            Message = "Placeholder IP address configured - update azure-parameters.json with real on-premises public IP"
            Data = @{
                VPNGateway = $VPNGateway
            }
        }
    }

    Write-DebugAzureCall -Cmdlet "Get-AzLocalNetworkGateway" -Parameters @{
        Name = $lngName
        ResourceGroupName = $ResourceGroupName
    } -Context "Deploy-VPNConnection"
    $localNetworkGateway = Get-AzLocalNetworkGateway -Name $lngName -ResourceGroupName $ResourceGroupName -ErrorAction SilentlyContinue

    if ($null -ne $localNetworkGateway) {
        Write-DebugLog -Message "Existing Local Network Gateway found" -Context "Deploy-VPNConnection"
        Write-DebugResource -ResourceType "LocalNetworkGateway" -ResourceName $lngName -ResourceId $localNetworkGateway.Id -Properties @{
            GatewayIpAddress = $localNetworkGateway.GatewayIpAddress
            AddressSpace = ($localNetworkGateway.LocalNetworkAddressSpace.AddressPrefixes -join ', ')
        } -Context "Deploy-VPNConnection"

        if (-not $SkipExisting) {
            Write-DebugLog -Message "ERROR: Local Network Gateway exists and SkipExisting is false" -Context "Deploy-VPNConnection"
            Stop-DebugOperation -Operation "Deploy-VPNConnection" -Stopwatch $mainSw -Success $false
            throw "Local Network Gateway already exists"
        }
        Write-ToLog -Message "Local Network Gateway already exists: $lngName" -Level "SUCCESS"
    } else {
        # Create Local Network Gateway
        Write-DebugLog -Message "Creating Local Network Gateway..." -Context "Deploy-VPNConnection"
        Write-DebugAzureCall -Cmdlet "New-AzLocalNetworkGateway" -Parameters @{
            Name = $lngName
            ResourceGroupName = $ResourceGroupName
            Location = $Location
            GatewayIpAddress = $onPremParams.localNetworkGateway.gatewayIpAddress
            AddressPrefix = ($onPremParams.localNetworkGateway.addressPrefixes -join ', ')
        } -Context "Deploy-VPNConnection"

        $localNetworkGateway = New-AzLocalNetworkGateway `
            -Name $lngName `
            -ResourceGroupName $ResourceGroupName `
            -Location $Location `
            -GatewayIpAddress $onPremParams.localNetworkGateway.gatewayIpAddress `
            -AddressPrefix $onPremParams.localNetworkGateway.addressPrefixes `
            -ErrorAction Stop

        Write-ToLog -Message "Local Network Gateway created: $lngName" -Level "SUCCESS"
        Write-DebugResource -ResourceType "LocalNetworkGateway" -ResourceName $lngName -ResourceId $localNetworkGateway.Id -Properties @{
            GatewayIpAddress = $localNetworkGateway.GatewayIpAddress
            AddressSpace = ($localNetworkGateway.LocalNetworkAddressSpace.AddressPrefixes -join ', ')
        } -Context "Deploy-VPNConnection"
    }

    # Deploy VPN Connection
    $connName = $onPremParams.vpnConnection.name
    Write-DebugLog -Message "VPN Connection Name: $connName" -Context "Deploy-VPNConnection"
    Write-DebugLog -Message "Connection Type: $($onPremParams.vpnConnection.connectionType)" -Context "Deploy-VPNConnection"
    Write-DebugLog -Message "Enable BGP: $($onPremParams.vpnConnection.enableBgp)" -Context "Deploy-VPNConnection"

    # Check for placeholder shared key
    if ($onPremParams.vpnConnection.sharedKey -like "*YOUR-SHARED-KEY-HERE*" -or
        $onPremParams.vpnConnection.sharedKey -like "*<*>*" -or
        [string]::IsNullOrWhiteSpace($onPremParams.vpnConnection.sharedKey)) {

        Write-DebugLog -Message "SKIP REASON: Shared key contains placeholder value" -Context "Deploy-VPNConnection"
        Write-ToLog -Message "VPN Connection skipped - placeholder shared key configured" -Level "INFO"
        Stop-DebugOperation -Operation "Deploy-VPNConnection" -Stopwatch $mainSw -Success $true
        return @{
            Status = "Skipped"
            Message = "Placeholder shared key configured - update azure-parameters.json with real shared key"
            Data = @{
                VPNGateway = $VPNGateway
                LocalNetworkGateway = $localNetworkGateway
            }
        }
    }

    Write-DebugAzureCall -Cmdlet "Get-AzVirtualNetworkGatewayConnection" -Parameters @{
        Name = $connName
        ResourceGroupName = $ResourceGroupName
    } -Context "Deploy-VPNConnection"
    $existingConn = Get-AzVirtualNetworkGatewayConnection -Name $connName -ResourceGroupName $ResourceGroupName -ErrorAction SilentlyContinue

    if ($null -ne $existingConn) {
        Write-DebugLog -Message "Existing VPN Connection found" -Context "Deploy-VPNConnection"
        Write-DebugResource -ResourceType "VirtualNetworkGatewayConnection" -ResourceName $connName -ResourceId $existingConn.Id -Properties @{
            ConnectionType = $existingConn.ConnectionType
            ConnectionStatus = $existingConn.ConnectionStatus
            ProvisioningState = $existingConn.ProvisioningState
        } -Context "Deploy-VPNConnection"

        if ($SkipExisting) {
            Write-ToLog -Message "VPN Connection already exists: $connName" -Level "SUCCESS"
            Stop-DebugOperation -Operation "Deploy-VPNConnection" -Stopwatch $mainSw -Success $true
            return @{
                Status = "Success"
                Message = "VPN Connection already exists"
                Data = @{
                    VPNGateway = $VPNGateway
                    LocalNetworkGateway = $localNetworkGateway
                    VPNConnection = $existingConn
                }
            }
        } else {
            Write-DebugLog -Message "ERROR: VPN Connection exists and SkipExisting is false" -Context "Deploy-VPNConnection"
            Stop-DebugOperation -Operation "Deploy-VPNConnection" -Stopwatch $mainSw -Success $false
            throw "VPN Connection already exists"
        }
    }

    # Build connection parameters
    Write-DebugLog -Message "Building connection parameters..." -Context "Deploy-VPNConnection"
    $connectionParams = @{
        Name = $connName
        ResourceGroupName = $ResourceGroupName
        Location = $Location
        VirtualNetworkGateway1 = $VPNGateway
        LocalNetworkGateway2 = $localNetworkGateway
        ConnectionType = $onPremParams.vpnConnection.connectionType
        SharedKey = $onPremParams.vpnConnection.sharedKey
        EnableBgp = $onPremParams.vpnConnection.enableBgp
        UsePolicyBasedTrafficSelectors = $onPremParams.vpnConnection.usePolicyBasedTrafficSelectors
        ErrorAction = "Stop"
    }

    Write-DebugAzureCall -Cmdlet "New-AzVirtualNetworkGatewayConnection" -Parameters @{
        Name = $connName
        ResourceGroupName = $ResourceGroupName
        Location = $Location
        VirtualNetworkGateway1 = $VPNGateway.Name
        LocalNetworkGateway2 = $localNetworkGateway.Name
        ConnectionType = $onPremParams.vpnConnection.connectionType
        SharedKey = "********"
        EnableBgp = $onPremParams.vpnConnection.enableBgp
        UsePolicyBasedTrafficSelectors = $onPremParams.vpnConnection.usePolicyBasedTrafficSelectors
    } -Context "Deploy-VPNConnection"

    # Add IPsec policy if enabled
    if ($onPremParams.vpnConnection.ipsecPolicies.enabled) {
        Write-DebugLog -Message "Creating custom IPsec policy..." -Context "Deploy-VPNConnection"
        Write-DebugLog -Message "  SA Lifetime: $($onPremParams.vpnConnection.ipsecPolicies.saLifeTimeSeconds) seconds" -Context "Deploy-VPNConnection"
        Write-DebugLog -Message "  SA Data Size: $($onPremParams.vpnConnection.ipsecPolicies.saDataSizeKilobytes) KB" -Context "Deploy-VPNConnection"
        Write-DebugLog -Message "  IPsec Encryption: $($onPremParams.vpnConnection.ipsecPolicies.ipsecEncryption)" -Context "Deploy-VPNConnection"
        Write-DebugLog -Message "  IPsec Integrity: $($onPremParams.vpnConnection.ipsecPolicies.ipsecIntegrity)" -Context "Deploy-VPNConnection"
        Write-DebugLog -Message "  IKE Encryption: $($onPremParams.vpnConnection.ipsecPolicies.ikeEncryption)" -Context "Deploy-VPNConnection"
        Write-DebugLog -Message "  IKE Integrity: $($onPremParams.vpnConnection.ipsecPolicies.ikeIntegrity)" -Context "Deploy-VPNConnection"
        Write-DebugLog -Message "  DH Group: $($onPremParams.vpnConnection.ipsecPolicies.dhGroup)" -Context "Deploy-VPNConnection"
        Write-DebugLog -Message "  PFS Group: $($onPremParams.vpnConnection.ipsecPolicies.pfsGroup)" -Context "Deploy-VPNConnection"

        $ipsecPolicy = New-AzIpsecPolicy `
            -SALifeTimeSeconds $onPremParams.vpnConnection.ipsecPolicies.saLifeTimeSeconds `
            -SADataSizeKilobytes $onPremParams.vpnConnection.ipsecPolicies.saDataSizeKilobytes `
            -IpsecEncryption $onPremParams.vpnConnection.ipsecPolicies.ipsecEncryption `
            -IpsecIntegrity $onPremParams.vpnConnection.ipsecPolicies.ipsecIntegrity `
            -IkeEncryption $onPremParams.vpnConnection.ipsecPolicies.ikeEncryption `
            -IkeIntegrity $onPremParams.vpnConnection.ipsecPolicies.ikeIntegrity `
            -DhGroup $onPremParams.vpnConnection.ipsecPolicies.dhGroup `
            -PfsGroup $onPremParams.vpnConnection.ipsecPolicies.pfsGroup

        $connectionParams.IpsecPolicies = $ipsecPolicy
        Write-DebugLog -Message "Custom IPsec policy created and added to connection parameters" -Context "Deploy-VPNConnection"
    }

    # Create VPN Connection
    Write-DebugLog -Message "Creating VPN Connection..." -Context "Deploy-VPNConnection"
    $vpnConnection = New-AzVirtualNetworkGatewayConnection @connectionParams

    Write-ToLog -Message "VPN Connection created: $connName" -Level "SUCCESS"
    Write-DebugResource -ResourceType "VirtualNetworkGatewayConnection" -ResourceName $connName -ResourceId $vpnConnection.Id -Properties @{
        ConnectionType = $vpnConnection.ConnectionType
        ConnectionStatus = $vpnConnection.ConnectionStatus
        ProvisioningState = $vpnConnection.ProvisioningState
    } -Context "Deploy-VPNConnection"

    Stop-DebugOperation -Operation "Deploy-VPNConnection" -Stopwatch $mainSw -Success $true

    return @{
        Status = "Success"
        Message = "VPN Connection deployed successfully"
        Data = @{
            VPNGateway = $VPNGateway
            LocalNetworkGateway = $localNetworkGateway
            VPNConnection = $vpnConnection
        }
    }

} catch {
    Write-ToLog -Message "VPN Connection deployment failed: $($_.Exception.Message)" -Level "ERROR"
    Write-DebugException -Exception $_.Exception -Context "Deploy-VPNConnection"
    Stop-DebugOperation -Operation "Deploy-VPNConnection" -Stopwatch $mainSw -Success $false

    return @{
        Status = "Failed"
        Message = $_.Exception.Message
        Data = $null
    }
}
