# Deploy-VMs.ps1
# Deploys test VMs for traffic generation and flow log testing in Unified Azure Lab

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
    [SecureString]$VMPassword = $null
)

$ErrorActionPreference = "Stop"
$SkipExisting = $OperationParams.validation.skipExistingResources

function Set-VMAutoShutdown {
    param(
        [string]$VMName,
        [string]$SubscriptionId,
        [string]$ResourceGroup,
        [string]$VMLocation
    )

    if (-not $AzureParams.virtualMachines.configuration.autoShutdownEnabled) {
        return
    }

    try {
        $shutdownTime = $AzureParams.virtualMachines.configuration.autoShutdownTime
        $timeZoneId = $AzureParams.virtualMachines.configuration.autoShutdownTimeZone

        # Check if auto-shutdown already exists
        $shutdownResourceId = "/subscriptions/$SubscriptionId/resourceGroups/$ResourceGroup/providers/microsoft.devtestlab/schedules/shutdown-computevm-$VMName"
        $existingSchedule = Get-AzResource -ResourceId $shutdownResourceId -ErrorAction SilentlyContinue
        if ($null -ne $existingSchedule) {
            Write-ToLog -Message "Auto-shutdown already configured: $VMName" -Level "INFO"
            return
        }

        # Construct the VM resource ID
        $vmResourceId = "/subscriptions/$SubscriptionId/resourceGroups/$ResourceGroup/providers/Microsoft.Compute/virtualMachines/$VMName"

        $scheduleProperties = @{
            status = "Enabled"
            taskType = "ComputeVmShutdownTask"
            dailyRecurrence = @{
                time = $shutdownTime
            }
            timeZoneId = $timeZoneId
            notificationSettings = @{
                status = "Disabled"
            }
            targetResourceId = $vmResourceId
        }

        New-AzResource `
            -ResourceId $shutdownResourceId `
            -Location $VMLocation `
            -Properties $scheduleProperties `
            -Force `
            -ErrorAction Stop | Out-Null

        Write-ToLog -Message "Auto-shutdown configured: $VMName" -Level "SUCCESS"

    } catch {
        Write-ToLog -Message "Failed to configure auto-shutdown for $VMName : $($_.Exception.Message)" -Level "WARNING"
    }
}

function Deploy-TestVMs {
    if (-not $AzureParams.virtualMachines.enabled) {
        return $null
    }

    $adminPassword = $null
    if ($AzureParams.virtualMachines.configuration.authenticationType -eq "password") {
        if ($null -ne $VMPassword) {
            $adminPassword = $VMPassword
        } else {
            # Fallback to interactive prompt (only works in foreground)
            $adminPassword = Read-Host "Enter Password for VMs" -AsSecureString
        }
    } elseif ($AzureParams.virtualMachines.configuration.authenticationType -eq "sshPublicKey") {
        if ([string]::IsNullOrWhiteSpace($AzureParams.virtualMachines.configuration.sshPublicKey)) {
            Write-ToLog -Message "SSH public key required but not configured" -Level "ERROR"
            return $null
        }
    }

    $deployedVMs = @()
    $vmIpAddresses = @()
    $vnetName = $ResourceNames.VNet

    foreach ($subnetKey in @("bastion", "security", "o11y")) {
        $vmConfig = $AzureParams.virtualMachines.deployment.$subnetKey

        if (-not $vmConfig.enabled) {
            continue
        }

        $subnetDef = $AzureParams.infrastructure.subnets.$subnetKey
        $vmBaseName = $vmConfig.vmName

        $vmName = Get-ResourceName -AzureParams $AzureParams -ResourceType "vm" -Suffix $vmBaseName
        $nicName = "$vmName-nic"

        try {
            $existingVM = Get-AzVM -ResourceGroupName $ResourceGroupName -Name $vmName -ErrorAction SilentlyContinue
            if ($null -ne $existingVM -and $SkipExisting) {
                $deployedVMs += $existingVM

                $existingNic = Get-AzNetworkInterface -ResourceGroupName $ResourceGroupName -Name $nicName -ErrorAction SilentlyContinue
                if ($null -ne $existingNic) {
                    $privateIp = $existingNic.IpConfigurations[0].PrivateIpAddress
                    $vmIpAddresses += [PSCustomObject]@{
                        Name = $vmName
                        Subnet = $subnetDef.name
                        PrivateIP = $privateIp
                    }
                }

                # Ensure auto-shutdown is configured for existing VMs
                Set-VMAutoShutdown -VMName $vmName -SubscriptionId $AzureParams.subscriptionId -ResourceGroup $ResourceGroupName -VMLocation $Location

                continue
            }

            $vnet = Get-AzVirtualNetwork -Name $vnetName -ResourceGroupName $ResourceGroupName
            $subnet = Get-AzVirtualNetworkSubnetConfig -Name $subnetDef.name -VirtualNetwork $vnet

            $nic = New-AzNetworkInterface `
                -Name $nicName `
                -ResourceGroupName $ResourceGroupName `
                -Location $Location `
                -SubnetId $subnet.Id `
                -ErrorAction Stop

            $vmConfigObj = New-AzVMConfig `
                -VMName $vmName `
                -VMSize $AzureParams.virtualMachines.configuration.vmSize `
                -ErrorAction Stop

            if ($AzureParams.virtualMachines.configuration.authenticationType -eq "password") {
                $vmConfigObj = Set-AzVMOperatingSystem `
                    -VM $vmConfigObj `
                    -Linux `
                    -ComputerName $vmName `
                    -Credential (New-Object System.Management.Automation.PSCredential($AzureParams.virtualMachines.configuration.adminUsername, $adminPassword)) `
                    -DisablePasswordAuthentication:$false `
                    -ErrorAction Stop
            } else {
                $vmConfigObj = Set-AzVMOperatingSystem `
                    -VM $vmConfigObj `
                    -Linux `
                    -ComputerName $vmName `
                    -Credential (New-Object System.Management.Automation.PSCredential($AzureParams.virtualMachines.configuration.adminUsername, (ConvertTo-SecureString "PlaceholderNotUsed" -AsSecureString -Force))) `
                    -DisablePasswordAuthentication:$true `
                    -ErrorAction Stop

                Add-AzVMSshPublicKey `
                    -VM $vmConfigObj `
                    -KeyData $AzureParams.virtualMachines.configuration.sshPublicKey `
                    -Path "/home/$($AzureParams.virtualMachines.configuration.adminUsername)/.ssh/authorized_keys" `
                    -ErrorAction Stop
            }

            $vmConfigObj = Set-AzVMSourceImage `
                -VM $vmConfigObj `
                -PublisherName $AzureParams.virtualMachines.configuration.publisher `
                -Offer $AzureParams.virtualMachines.configuration.offer `
                -Skus $AzureParams.virtualMachines.configuration.sku `
                -Version $AzureParams.virtualMachines.configuration.version `
                -ErrorAction Stop

            $vmConfigObj = Add-AzVMNetworkInterface `
                -VM $vmConfigObj `
                -Id $nic.Id `
                -ErrorAction Stop

            $vmConfigObj = Set-AzVMOSDisk `
                -VM $vmConfigObj `
                -CreateOption FromImage `
                -StorageAccountType $AzureParams.virtualMachines.configuration.osDiskType `
                -ErrorAction Stop

            $vmConfigObj = Set-AzVMBootDiagnostic `
                -VM $vmConfigObj `
                -Disable `
                -ErrorAction Stop

            $null = New-AzVM `
                -ResourceGroupName $ResourceGroupName `
                -Location $Location `
                -VM $vmConfigObj `
                -ErrorAction Stop

            # Retrieve the actual VM object to get the resource ID
            $vm = Get-AzVM -ResourceGroupName $ResourceGroupName -Name $vmName -ErrorAction Stop

            Write-ToLog -Message "VM created: $vmName" -Level "SUCCESS"
            $privateIp = $nic.IpConfigurations[0].PrivateIpAddress

            $vmIpAddresses += [PSCustomObject]@{
                Name = $vmName
                Subnet = $subnetDef.name
                PrivateIP = $privateIp
            }

            # Configure auto-shutdown for newly created VM
            Set-VMAutoShutdown -VMName $vmName -SubscriptionId $AzureParams.subscriptionId -ResourceGroup $ResourceGroupName -VMLocation $Location

            $deployedVMs += $vm

        } catch {
            Write-ToLog -Message "Failed to create VM $vmName : $($_.Exception.Message)" -Level "ERROR"
        }
    }

    return @{
        VMs = $deployedVMs
        IPAddresses = $vmIpAddresses
    }
}

function Get-ResourceName {
    param(
        [PSCustomObject]$AzureParams,
        [string]$ResourceType,
        [string]$Suffix
    )

    $prefix = $AzureParams.naming.$ResourceType.prefix
    $suffixConfig = $AzureParams.naming.$ResourceType.suffix
    $baseName = $AzureParams.baseObjectName

    return "$prefix$baseName-$Suffix$suffixConfig"
}

# Main execution
try {
    $result = Deploy-TestVMs

    Write-ToLog -Message "VM deployment completed" -Level "SUCCESS"

    return $result

} catch {
    Write-ToLog -Message "VM deployment failed: $($_.Exception.Message)" -Level "ERROR"
    throw
}
