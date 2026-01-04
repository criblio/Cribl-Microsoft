# Deploy-VMs.ps1
# Phase 7, SubPhase 7.1: Deploy Test Virtual Machines
# Dependencies: VNet (Phase 2.1), NSGs (Phase 2.2)

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

# Early exit check - skip before any debug logging to reduce noise
# Check both operation params (lab-specific) and azure params (global)
if (-not $OperationParams.deployment.virtualMachines.deployVMs -or -not $AzureParams.virtualMachines.enabled) {
    return @{
        Status = "Skipped"
        Message = "VM deployment disabled"
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
    VMsEnabled = $AzureParams.virtualMachines.enabled
    AuthenticationType = $AzureParams.virtualMachines.configuration.authenticationType
    VMSize = $AzureParams.virtualMachines.configuration.vmSize
    AdminUsername = $AzureParams.virtualMachines.configuration.adminUsername
    AutoShutdownEnabled = $AzureParams.virtualMachines.configuration.autoShutdownEnabled
    VMPasswordProvided = ($null -ne $VMPassword)
    VNetName = $ResourceNames.VNet
} -Context "Deploy-VMs"

# Helper function to generate resource names
function Get-ResourceName {
    param(
        [PSCustomObject]$AzureParams,
        [string]$ResourceType,
        [string]$Suffix
    )

    $prefix = $AzureParams.naming.$ResourceType.prefix
    $suffixConfig = $AzureParams.naming.$ResourceType.suffix
    $baseName = $AzureParams.baseObjectName

    $result = "$prefix$baseName-$Suffix$suffixConfig"
    Write-DebugLog -Message "Generated resource name: $result (type: $ResourceType, suffix: $Suffix)" -Context "Get-ResourceName"
    return $result
}

# Helper function to set VM auto-shutdown
function Set-VMAutoShutdown {
    param(
        [string]$VMName,
        [string]$SubscriptionId,
        [string]$ResourceGroup,
        [string]$VMLocation
    )

    $sw = Start-DebugOperation -Operation "Set-VMAutoShutdown"
    Write-DebugLog -Message "Processing auto-shutdown for VM: $VMName" -Context "Set-VMAutoShutdown"

    if (-not $AzureParams.virtualMachines.configuration.autoShutdownEnabled) {
        Write-DebugLog -Message "SKIP REASON: autoShutdownEnabled is false in configuration" -Context "Set-VMAutoShutdown"
        Stop-DebugOperation -Operation "Set-VMAutoShutdown" -Stopwatch $sw -Success $true
        return
    }

    try {
        $shutdownTime = $AzureParams.virtualMachines.configuration.autoShutdownTime
        $timeZoneId = $AzureParams.virtualMachines.configuration.autoShutdownTimeZone

        Write-DebugLog -Message "Shutdown time: $shutdownTime, TimeZone: $timeZoneId" -Context "Set-VMAutoShutdown"

        $shutdownResourceId = "/subscriptions/$SubscriptionId/resourceGroups/$ResourceGroup/providers/microsoft.devtestlab/schedules/shutdown-computevm-$VMName"
        Write-DebugLog -Message "Checking for existing schedule: $shutdownResourceId" -Context "Set-VMAutoShutdown"

        Write-DebugAzureCall -Cmdlet "Get-AzResource" -Parameters @{
            ResourceId = $shutdownResourceId
        } -Context "Set-VMAutoShutdown"

        $existingSchedule = Get-AzResource -ResourceId $shutdownResourceId -ErrorAction SilentlyContinue
        if ($null -ne $existingSchedule) {
            Write-DebugLog -Message "Auto-shutdown schedule already exists for VM: $VMName" -Context "Set-VMAutoShutdown"
            Write-ToLog -Message "Auto-shutdown already configured: $VMName" -Level "INFO"
            Stop-DebugOperation -Operation "Set-VMAutoShutdown" -Stopwatch $sw -Success $true
            return
        }

        $vmResourceId = "/subscriptions/$SubscriptionId/resourceGroups/$ResourceGroup/providers/Microsoft.Compute/virtualMachines/$VMName"
        Write-DebugLog -Message "VM resource ID: $vmResourceId" -Context "Set-VMAutoShutdown"

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

        Write-DebugAzureCall -Cmdlet "New-AzResource" -Parameters @{
            ResourceId = $shutdownResourceId
            Location = $VMLocation
            Properties = "scheduleProperties"
        } -Context "Set-VMAutoShutdown"

        New-AzResource `
            -ResourceId $shutdownResourceId `
            -Location $VMLocation `
            -Properties $scheduleProperties `
            -Force `
            -ErrorAction Stop | Out-Null

        Write-ToLog -Message "Auto-shutdown configured: $VMName" -Level "SUCCESS"
        Write-DebugLog -Message "Auto-shutdown configured successfully for VM: $VMName" -Context "Set-VMAutoShutdown"
        Stop-DebugOperation -Operation "Set-VMAutoShutdown" -Stopwatch $sw -Success $true

    } catch {
        Write-DebugException -Exception $_.Exception -Context "Set-VMAutoShutdown" -AdditionalInfo @{
            VMName = $VMName
        }
        Write-ToLog -Message "Failed to configure auto-shutdown for $VMName : $($_.Exception.Message)" -Level "WARNING"
        Stop-DebugOperation -Operation "Set-VMAutoShutdown" -Stopwatch $sw -Success $false
    }
}

$mainSw = Start-DebugOperation -Operation "Deploy-VMs"

try {
    Write-DebugLog -Message "Starting VM deployment..." -Context "Deploy-VMs"

    $adminPassword = $null
    $authType = $AzureParams.virtualMachines.configuration.authenticationType
    Write-DebugLog -Message "Authentication type: $authType" -Context "Deploy-VMs"

    if ($authType -eq "password") {
        if ($null -ne $VMPassword) {
            Write-DebugLog -Message "Using provided VMPassword parameter" -Context "Deploy-VMs"
            $adminPassword = $VMPassword
        } else {
            Write-DebugLog -Message "No VMPassword provided, prompting user" -Context "Deploy-VMs"
            $adminPassword = Read-Host "Enter Password for VMs" -AsSecureString
        }
    } elseif ($authType -eq "sshPublicKey") {
        Write-DebugLog -Message "Using SSH public key authentication" -Context "Deploy-VMs"
        if ([string]::IsNullOrWhiteSpace($AzureParams.virtualMachines.configuration.sshPublicKey)) {
            Write-DebugLog -Message "SKIP REASON: SSH public key required but not configured" -Context "Deploy-VMs"
            Write-ToLog -Message "SSH public key required but not configured" -Level "ERROR"
            Stop-DebugOperation -Operation "Deploy-VMs" -Stopwatch $mainSw -Success $false
            return @{
                Status = "Failed"
                Message = "SSH public key required but not configured"
                Data = $null
            }
        }
    }

    $deployedVMs = @()
    $vmIpAddresses = @()
    $vnetName = $ResourceNames.VNet

    Write-DebugLog -Message "VNet name: $vnetName" -Context "Deploy-VMs"

    $subnetKeys = @("security", "o11y")
    Write-DebugLog -Message "Subnet keys to process: $($subnetKeys -join ', ')" -Context "Deploy-VMs"

    foreach ($subnetKey in $subnetKeys) {
        $vmSw = Start-DebugOperation -Operation "Deploy-VM-$subnetKey"

        $vmConfig = $AzureParams.virtualMachines.deployment.$subnetKey
        Write-DebugLog -Message "Processing subnet key: $subnetKey, enabled: $($vmConfig.enabled)" -Context "Deploy-VMs"

        if (-not $vmConfig.enabled) {
            Write-DebugLog -Message "SKIP REASON: VM deployment for subnet '$subnetKey' is disabled" -Context "Deploy-VMs"
            Stop-DebugOperation -Operation "Deploy-VM-$subnetKey" -Stopwatch $vmSw -Success $true
            continue
        }

        $subnetDef = $AzureParams.infrastructure.subnets.$subnetKey
        $vmBaseName = $vmConfig.vmName

        $vmName = Get-ResourceName -AzureParams $AzureParams -ResourceType "vm" -Suffix $vmBaseName
        $nicName = "$vmName-nic"

        Write-DebugLog -Message "VM name: $vmName, NIC name: $nicName" -Context "Deploy-VMs"
        Write-DebugLog -Message "Subnet definition - name: $($subnetDef.name), prefix: $($subnetDef.addressPrefix)" -Context "Deploy-VMs"

        try {
            Write-DebugAzureCall -Cmdlet "Get-AzVM" -Parameters @{
                ResourceGroupName = $ResourceGroupName
                Name = $vmName
            } -Context "Deploy-VMs"

            $existingVM = Get-AzVM -ResourceGroupName $ResourceGroupName -Name $vmName -ErrorAction SilentlyContinue

            if ($null -ne $existingVM -and $SkipExisting) {
                Write-DebugLog -Message "Existing VM found: $vmName, SkipExisting is true" -Context "Deploy-VMs"
                Write-DebugResource -ResourceType "VirtualMachine" -ResourceName $vmName -Properties @{
                    Id = $existingVM.Id
                    VMSize = $existingVM.HardwareProfile.VmSize
                    ProvisioningState = $existingVM.ProvisioningState
                } -Context "Deploy-VMs"

                $deployedVMs += $existingVM

                Write-DebugAzureCall -Cmdlet "Get-AzNetworkInterface" -Parameters @{
                    ResourceGroupName = $ResourceGroupName
                    Name = $nicName
                } -Context "Deploy-VMs"

                $existingNic = Get-AzNetworkInterface -ResourceGroupName $ResourceGroupName -Name $nicName -ErrorAction SilentlyContinue
                if ($null -ne $existingNic) {
                    $privateIp = $existingNic.IpConfigurations[0].PrivateIpAddress
                    Write-DebugLog -Message "Existing NIC found with private IP: $privateIp" -Context "Deploy-VMs"
                    $vmIpAddresses += [PSCustomObject]@{
                        Name = $vmName
                        Subnet = $subnetDef.name
                        PrivateIP = $privateIp
                    }
                }

                Set-VMAutoShutdown -VMName $vmName -SubscriptionId $AzureParams.subscriptionId -ResourceGroup $ResourceGroupName -VMLocation $Location

                Stop-DebugOperation -Operation "Deploy-VM-$subnetKey" -Stopwatch $vmSw -Success $true
                continue
            }

            Write-DebugLog -Message "Creating new VM: $vmName" -Context "Deploy-VMs"

            Write-DebugAzureCall -Cmdlet "Get-AzVirtualNetwork" -Parameters @{
                Name = $vnetName
                ResourceGroupName = $ResourceGroupName
            } -Context "Deploy-VMs"

            $vnet = Get-AzVirtualNetwork -Name $vnetName -ResourceGroupName $ResourceGroupName

            Write-DebugAzureCall -Cmdlet "Get-AzVirtualNetworkSubnetConfig" -Parameters @{
                Name = $subnetDef.name
                VirtualNetwork = "vnet"
            } -Context "Deploy-VMs"

            $subnet = Get-AzVirtualNetworkSubnetConfig -Name $subnetDef.name -VirtualNetwork $vnet
            Write-DebugLog -Message "Subnet ID: $($subnet.Id)" -Context "Deploy-VMs"

            Write-DebugAzureCall -Cmdlet "New-AzNetworkInterface" -Parameters @{
                Name = $nicName
                ResourceGroupName = $ResourceGroupName
                Location = $Location
                SubnetId = $subnet.Id
            } -Context "Deploy-VMs"

            $nic = New-AzNetworkInterface `
                -Name $nicName `
                -ResourceGroupName $ResourceGroupName `
                -Location $Location `
                -SubnetId $subnet.Id `
                -ErrorAction Stop

            Write-DebugLog -Message "NIC created: $nicName, ID: $($nic.Id)" -Context "Deploy-VMs"

            Write-DebugAzureCall -Cmdlet "New-AzVMConfig" -Parameters @{
                VMName = $vmName
                VMSize = $AzureParams.virtualMachines.configuration.vmSize
            } -Context "Deploy-VMs"

            $vmConfigObj = New-AzVMConfig `
                -VMName $vmName `
                -VMSize $AzureParams.virtualMachines.configuration.vmSize `
                -ErrorAction Stop

            if ($authType -eq "password") {
                Write-DebugLog -Message "Configuring VM with password authentication" -Context "Deploy-VMs"
                $vmConfigObj = Set-AzVMOperatingSystem `
                    -VM $vmConfigObj `
                    -Linux `
                    -ComputerName $vmName `
                    -Credential (New-Object System.Management.Automation.PSCredential($AzureParams.virtualMachines.configuration.adminUsername, $adminPassword)) `
                    -DisablePasswordAuthentication:$false `
                    -ErrorAction Stop
            } else {
                Write-DebugLog -Message "Configuring VM with SSH key authentication" -Context "Deploy-VMs"
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

            $imageConfig = @{
                Publisher = $AzureParams.virtualMachines.configuration.publisher
                Offer = $AzureParams.virtualMachines.configuration.offer
                Sku = $AzureParams.virtualMachines.configuration.sku
                Version = $AzureParams.virtualMachines.configuration.version
            }
            Write-DebugLog -Message "Image config - Publisher: $($imageConfig.Publisher), Offer: $($imageConfig.Offer), Sku: $($imageConfig.Sku), Version: $($imageConfig.Version)" -Context "Deploy-VMs"

            $vmConfigObj = Set-AzVMSourceImage `
                -VM $vmConfigObj `
                -PublisherName $imageConfig.Publisher `
                -Offer $imageConfig.Offer `
                -Skus $imageConfig.Sku `
                -Version $imageConfig.Version `
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

            Write-DebugLog -Message "Creating VM (this may take several minutes)..." -Context "Deploy-VMs"
            Write-DebugAzureCall -Cmdlet "New-AzVM" -Parameters @{
                ResourceGroupName = $ResourceGroupName
                Location = $Location
                VM = "vmConfigObj"
            } -Context "Deploy-VMs"

            # Suppress deprecation warnings about default VM size changes
            $originalWarningPreference = $WarningPreference
            $WarningPreference = 'SilentlyContinue'
            try {
                $null = New-AzVM `
                    -ResourceGroupName $ResourceGroupName `
                    -Location $Location `
                    -VM $vmConfigObj `
                    -ErrorAction Stop
            } finally {
                $WarningPreference = $originalWarningPreference
            }

            $vm = Get-AzVM -ResourceGroupName $ResourceGroupName -Name $vmName -ErrorAction Stop

            Write-ToLog -Message "VM created: $vmName" -Level "SUCCESS"
            Write-DebugResource -ResourceType "VirtualMachine" -ResourceName $vmName -Properties @{
                Id = $vm.Id
                VMSize = $vm.HardwareProfile.VmSize
                ProvisioningState = $vm.ProvisioningState
            } -Context "Deploy-VMs"

            $privateIp = $nic.IpConfigurations[0].PrivateIpAddress
            Write-DebugLog -Message "VM private IP: $privateIp" -Context "Deploy-VMs"

            $vmIpAddresses += [PSCustomObject]@{
                Name = $vmName
                Subnet = $subnetDef.name
                PrivateIP = $privateIp
            }

            Set-VMAutoShutdown -VMName $vmName -SubscriptionId $AzureParams.subscriptionId -ResourceGroup $ResourceGroupName -VMLocation $Location

            $deployedVMs += $vm
            Stop-DebugOperation -Operation "Deploy-VM-$subnetKey" -Stopwatch $vmSw -Success $true

        } catch {
            Write-DebugException -Exception $_.Exception -Context "Deploy-VMs" -AdditionalInfo @{
                VMName = $vmName
                SubnetKey = $subnetKey
            }
            Write-ToLog -Message "Failed to create VM $vmName : $($_.Exception.Message)" -Level "ERROR"
            Stop-DebugOperation -Operation "Deploy-VM-$subnetKey" -Stopwatch $vmSw -Success $false
        }
    }

    Write-DebugLog -Message "Total VMs deployed: $($deployedVMs.Count)" -Context "Deploy-VMs"
    Write-ToLog -Message "VM deployment completed" -Level "SUCCESS"
    Stop-DebugOperation -Operation "Deploy-VMs" -Stopwatch $mainSw -Success $true

    return @{
        Status = "Success"
        Message = "VMs deployed successfully"
        Data = @{
            VMs = $deployedVMs
            IPAddresses = $vmIpAddresses
        }
    }

} catch {
    Write-DebugException -Exception $_.Exception -Context "Deploy-VMs"
    Write-ToLog -Message "VM deployment failed: $($_.Exception.Message)" -Level "ERROR"
    Stop-DebugOperation -Operation "Deploy-VMs" -Stopwatch $mainSw -Success $false

    return @{
        Status = "Failed"
        Message = $_.Exception.Message
        Data = $null
    }
}
