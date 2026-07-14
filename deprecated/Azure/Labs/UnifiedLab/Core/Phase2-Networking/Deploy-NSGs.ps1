# Deploy-NSGs.ps1
# Phase 2, SubPhase 2.2: Deploy Network Security Groups
# Dependencies: VNet (Phase 2.1)

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
if (-not $OperationParams.deployment.infrastructure.deployNSGs) {
    return @{
        Status = "Skipped"
        Message = "NSG deployment disabled"
        Data = $null
    }
}

$SkipExisting = $OperationParams.validation.skipExistingResources

# Debug: Log entry parameters
Write-DebugParameters -Parameters @{
    ResourceGroupName = $ResourceGroupName
    Location = $Location
    SkipExisting = $SkipExisting
    DeployNSGs = $OperationParams.deployment.infrastructure.deployNSGs
    VNetProvided = ($null -ne $VNet)
    AllowOnPremisesTraffic = $AzureParams.infrastructure.networkSecurity.allowOnPremisesTraffic
    AllowAzureServices = $AzureParams.infrastructure.networkSecurity.allowAzureServices
} -Context "Deploy-NSGs"

$mainSw = Start-DebugOperation -Operation "Deploy-NSGs"

try {
    Write-DebugLog -Message "Starting NSG deployment..." -Context "Deploy-NSGs"

    # Get VNet if not provided
    if ($null -eq $VNet) {
        Write-DebugLog -Message "VNet not provided, looking up: $($ResourceNames.VNet)" -Context "Deploy-NSGs"
        Write-DebugAzureCall -Cmdlet "Get-AzVirtualNetwork" -Parameters @{
            Name = $ResourceNames.VNet
            ResourceGroupName = $ResourceGroupName
        } -Context "Deploy-NSGs"
        $VNet = Get-AzVirtualNetwork -Name $ResourceNames.VNet -ResourceGroupName $ResourceGroupName -ErrorAction SilentlyContinue
    }

    Write-DebugLog -Message "allowOnPremisesTraffic: $($AzureParams.infrastructure.networkSecurity.allowOnPremisesTraffic)" -Context "Deploy-NSGs"
    Write-DebugLog -Message "allowAzureServices: $($AzureParams.infrastructure.networkSecurity.allowAzureServices)" -Context "Deploy-NSGs"
    Write-DebugLog -Message "onPremisesNetwork.addressSpaces: $($AzureParams.infrastructure.onPremisesNetwork.addressSpaces -join ', ')" -Context "Deploy-NSGs"

    $createdNSGs = @()

    foreach ($subnetKey in $AzureParams.infrastructure.subnets.PSObject.Properties.Name) {
        $subnet = $AzureParams.infrastructure.subnets.$subnetKey

        # Skip reserved subnets that don't support NSGs
        if ($subnet.name -eq "GatewaySubnet") {
            Write-DebugLog -Message "Skipping NSG for reserved subnet: $($subnet.name)" -Context "Deploy-NSGs"
            continue
        }

        $nsgName = $ResourceNames["NSG_$subnetKey"]
        Write-DebugLog -Message "Processing NSG: $nsgName for subnet: $($subnet.name)" -Context "Deploy-NSGs"

        Write-DebugAzureCall -Cmdlet "Get-AzNetworkSecurityGroup" -Parameters @{
            Name = $nsgName
            ResourceGroupName = $ResourceGroupName
        } -Context "Deploy-NSGs"
        $existingNSG = Get-AzNetworkSecurityGroup -Name $nsgName -ResourceGroupName $ResourceGroupName -ErrorAction SilentlyContinue

        if ($null -ne $existingNSG) {
            Write-DebugLog -Message "NSG already exists: $nsgName" -Context "Deploy-NSGs"
            Write-DebugResource -ResourceType "NetworkSecurityGroup" -ResourceName $nsgName -ResourceId $existingNSG.Id -Properties @{
                RuleCount = $existingNSG.SecurityRules.Count
            } -Context "Deploy-NSGs"
            $createdNSGs += $existingNSG
            continue
        }

        try {
            $rules = @()

            # Add on-premises traffic rules
            if ($AzureParams.infrastructure.networkSecurity.allowOnPremisesTraffic -and $AzureParams.infrastructure.onPremisesNetwork.addressSpaces.Count -gt 0) {
                $priority = 100
                foreach ($onPremNetwork in $AzureParams.infrastructure.onPremisesNetwork.addressSpaces) {
                    Write-DebugLog -Message "Adding on-premises rule for: $onPremNetwork (priority: $priority)" -Context "Deploy-NSGs"
                    $rules += New-AzNetworkSecurityRuleConfig -Name "AllowOnPremises_$priority" -Priority $priority -Direction Inbound -Access Allow -Protocol * -SourceAddressPrefix $onPremNetwork -SourcePortRange * -DestinationAddressPrefix * -DestinationPortRange * -ErrorAction Stop
                    $priority++
                }
            }

            # Add Azure services rule
            if ($AzureParams.infrastructure.networkSecurity.allowAzureServices) {
                Write-DebugLog -Message "Adding Azure services rule (priority: 120)" -Context "Deploy-NSGs"
                $rules += New-AzNetworkSecurityRuleConfig -Name "AllowAzureServices" -Priority 120 -Direction Inbound -Access Allow -Protocol * -SourceAddressPrefix AzureCloud -SourcePortRange * -DestinationAddressPrefix * -DestinationPortRange * -ErrorAction Stop
            }

            Write-DebugLog -Message "Creating NSG with $($rules.Count) rules" -Context "Deploy-NSGs"
            Write-DebugAzureCall -Cmdlet "New-AzNetworkSecurityGroup" -Parameters @{
                Name = $nsgName
                ResourceGroupName = $ResourceGroupName
                Location = $Location
                RuleCount = $rules.Count
            } -Context "Deploy-NSGs"

            if ($rules.Count -gt 0) {
                $nsg = New-AzNetworkSecurityGroup -Name $nsgName -ResourceGroupName $ResourceGroupName -Location $Location -SecurityRules $rules -ErrorAction Stop
            } else {
                $nsg = New-AzNetworkSecurityGroup -Name $nsgName -ResourceGroupName $ResourceGroupName -Location $Location -ErrorAction Stop
            }

            $createdNSGs += $nsg
            Write-DebugResource -ResourceType "NetworkSecurityGroup" -ResourceName $nsgName -ResourceId $nsg.Id -Properties @{
                RuleCount = $nsg.SecurityRules.Count
            } -Context "Deploy-NSGs"

            # Associate NSG with subnet
            if ($VNet) {
                Write-DebugLog -Message "Associating NSG with subnet: $($subnet.name)" -Context "Deploy-NSGs"
                $subnetConfig = $VNet.Subnets | Where-Object { $_.Name -eq $subnet.name }
                if ($subnetConfig) {
                    $subnetConfig.NetworkSecurityGroup = $nsg
                    $VNet | Set-AzVirtualNetwork -ErrorAction Stop | Out-Null
                    Write-DebugLog -Message "NSG associated with subnet successfully" -Context "Deploy-NSGs"
                } else {
                    Write-DebugLog -Message "WARNING: Subnet $($subnet.name) not found in VNet" -Context "Deploy-NSGs"
                }
            }

            Write-ToLog -Message "NSG created: $nsgName" -Level "SUCCESS"
        } catch {
            Write-ToLog -Message "Failed to create NSG $nsgName : $($_.Exception.Message)" -Level "ERROR"
            Write-DebugException -Exception $_.Exception -Context "Deploy-NSGs" -AdditionalInfo @{
                NSGName = $nsgName
                SubnetName = $subnet.name
            }
        }
    }

    Write-DebugLog -Message "NSG deployment completed. Created/found $($createdNSGs.Count) NSGs" -Context "Deploy-NSGs"
    Stop-DebugOperation -Operation "Deploy-NSGs" -Stopwatch $mainSw -Success $true

    return @{
        Status = "Success"
        Message = "NSGs deployed successfully"
        Data = @{
            NSGs = $createdNSGs
            Count = $createdNSGs.Count
        }
    }

} catch {
    Write-ToLog -Message "NSG deployment failed: $($_.Exception.Message)" -Level "ERROR"
    Write-DebugException -Exception $_.Exception -Context "Deploy-NSGs"
    Stop-DebugOperation -Operation "Deploy-NSGs" -Stopwatch $mainSw -Success $false

    return @{
        Status = "Failed"
        Message = $_.Exception.Message
        Data = $null
    }
}
