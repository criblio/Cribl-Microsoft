# Deploy-EventHub.ps1
# Phase 5, SubPhase 5.1: Deploy Event Hub Namespace and Event Hubs
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
if (-not $OperationParams.deployment.analytics.deployEventHub) {
    return @{
        Status = "Skipped"
        Message = "Event Hub deployment disabled"
        Data = $null
    }
}

$SkipExisting = $OperationParams.validation.skipExistingResources

# Debug: Log entry parameters
Write-DebugParameters -Parameters @{
    ResourceGroupName = $ResourceGroupName
    Location = $Location
    SkipExisting = $SkipExisting
    DeployEventHub = $OperationParams.deployment.analytics.deployEventHub
    NamespaceName = $ResourceNames.EventHubNamespace
} -Context "Deploy-EventHub"

$mainSw = Start-DebugOperation -Operation "Deploy-EventHub"

try {
    Write-DebugLog -Message "Starting Event Hub deployment..." -Context "Deploy-EventHub"

    $namespaceName = $ResourceNames.EventHubNamespace
    $eventHubConfig = $AzureParams.analytics.eventHub
    $namespaceConfig = $eventHubConfig.namespace

    Write-DebugLog -Message "Event Hub Namespace Name: $namespaceName" -Context "Deploy-EventHub"
    Write-DebugLog -Message "SKU: $($namespaceConfig.sku)" -Context "Deploy-EventHub"
    Write-DebugLog -Message "Capacity: $($namespaceConfig.capacity)" -Context "Deploy-EventHub"

    # Check for existing namespace
    Write-DebugAzureCall -Cmdlet "Get-AzEventHubNamespace" -Parameters @{
        ResourceGroupName = $ResourceGroupName
        Name = $namespaceName
    } -Context "Deploy-EventHub"
    $existingNamespace = Get-AzEventHubNamespace -ResourceGroupName $ResourceGroupName -Name $namespaceName -ErrorAction SilentlyContinue

    $namespace = $null
    if ($null -ne $existingNamespace) {
        Write-DebugLog -Message "Existing Event Hub Namespace found" -Context "Deploy-EventHub"
        Write-DebugResource -ResourceType "EventHubNamespace" -ResourceName $namespaceName -ResourceId $existingNamespace.Id -Properties @{
            Sku = $existingNamespace.Sku.Name
            Capacity = $existingNamespace.Sku.Capacity
            Status = $existingNamespace.Status
        } -Context "Deploy-EventHub"

        if ($SkipExisting) {
            Write-ToLog -Message "Event Hub Namespace exists: $namespaceName" -Level "SUCCESS"
            $namespace = $existingNamespace
        } else {
            Write-DebugLog -Message "ERROR: Namespace exists and SkipExisting is false" -Context "Deploy-EventHub"
            Stop-DebugOperation -Operation "Deploy-EventHub" -Stopwatch $mainSw -Success $false
            throw "Event Hub Namespace already exists"
        }
    } else {
        # Create new namespace
        Write-DebugLog -Message "Creating new Event Hub Namespace..." -Context "Deploy-EventHub"
        Write-DebugAzureCall -Cmdlet "New-AzEventHubNamespace" -Parameters @{
            ResourceGroupName = $ResourceGroupName
            Name = $namespaceName
            Location = $Location
            SkuName = $namespaceConfig.sku
            SkuCapacity = $namespaceConfig.capacity
        } -Context "Deploy-EventHub"

        $namespace = New-AzEventHubNamespace `
            -ResourceGroupName $ResourceGroupName `
            -Name $namespaceName `
            -Location $Location `
            -SkuName $namespaceConfig.sku `
            -SkuCapacity $namespaceConfig.capacity `
            -ErrorAction Stop

        Write-ToLog -Message "Event Hub Namespace created: $namespaceName" -Level "SUCCESS"
        Write-DebugResource -ResourceType "EventHubNamespace" -ResourceName $namespaceName -ResourceId $namespace.Id -Properties @{
            Sku = $namespace.Sku.Name
            Capacity = $namespace.Sku.Capacity
        } -Context "Deploy-EventHub"
    }

    # Deploy Event Hubs
    $createdHubs = @()
    Write-DebugLog -Message "Deploying Event Hubs to namespace: $namespaceName" -Context "Deploy-EventHub"

    foreach ($hubKey in $eventHubConfig.hubs.PSObject.Properties.Name) {
        $hubConfig = $eventHubConfig.hubs.$hubKey
        $hubName = $hubConfig.name

        Write-DebugLog -Message "Processing Event Hub: $hubName" -Context "Deploy-EventHub"
        Write-DebugLog -Message "  Partition Count: $($hubConfig.partitionCount)" -Context "Deploy-EventHub"
        Write-DebugLog -Message "  Retention Days: $($hubConfig.messageRetentionInDays)" -Context "Deploy-EventHub"

        Write-DebugAzureCall -Cmdlet "Get-AzEventHub" -Parameters @{
            ResourceGroupName = $ResourceGroupName
            NamespaceName = $namespaceName
            Name = $hubName
        } -Context "Deploy-EventHub"
        $existingHub = Get-AzEventHub -ResourceGroupName $ResourceGroupName -NamespaceName $namespaceName -Name $hubName -ErrorAction SilentlyContinue

        if ($null -ne $existingHub) {
            Write-DebugLog -Message "Event Hub already exists: $hubName" -Context "Deploy-EventHub"
            $createdHubs += $existingHub
            continue
        }

        try {
            $retentionHours = $hubConfig.messageRetentionInDays * 24
            Write-DebugLog -Message "  Retention Hours (calculated): $retentionHours" -Context "Deploy-EventHub"

            $hubParams = @{
                ResourceGroupName = $ResourceGroupName
                NamespaceName = $namespaceName
                Name = $hubName
                PartitionCount = $hubConfig.partitionCount
                RetentionTimeInHour = $retentionHours
                CleanupPolicy = "Delete"
                ErrorAction = "Stop"
            }

            Write-DebugAzureCall -Cmdlet "New-AzEventHub" -Parameters $hubParams -Context "Deploy-EventHub"
            $hub = New-AzEventHub @hubParams

            Write-ToLog -Message "Event Hub created: $hubName" -Level "SUCCESS"
            $createdHubs += $hub

        } catch {
            Write-ToLog -Message "Failed to create Event Hub $hubName : $($_.Exception.Message)" -Level "ERROR"
            Write-DebugException -Exception $_.Exception -Context "Deploy-EventHub"
        }
    }

    # Deploy Consumer Groups
    $createdGroups = @()
    Write-DebugLog -Message "Deploying Consumer Groups..." -Context "Deploy-EventHub"

    foreach ($hubKey in $eventHubConfig.hubs.PSObject.Properties.Name) {
        $hubConfig = $eventHubConfig.hubs.$hubKey
        $hubName = $hubConfig.name

        if ($hubConfig.consumerGroups) {
            Write-DebugLog -Message "Processing consumer groups for hub: $hubName" -Context "Deploy-EventHub"

            foreach ($groupName in $hubConfig.consumerGroups) {
                Write-DebugLog -Message "  Consumer Group: $groupName" -Context "Deploy-EventHub"

                $existingGroup = Get-AzEventHubConsumerGroup `
                    -ResourceGroupName $ResourceGroupName `
                    -NamespaceName $namespaceName `
                    -EventHubName $hubName `
                    -Name $groupName `
                    -ErrorAction SilentlyContinue

                if ($null -ne $existingGroup) {
                    Write-DebugLog -Message "  Consumer Group already exists: $groupName" -Context "Deploy-EventHub"
                    $createdGroups += $existingGroup
                    continue
                }

                try {
                    Write-DebugAzureCall -Cmdlet "New-AzEventHubConsumerGroup" -Parameters @{
                        ResourceGroupName = $ResourceGroupName
                        NamespaceName = $namespaceName
                        EventHubName = $hubName
                        Name = $groupName
                    } -Context "Deploy-EventHub"

                    $group = New-AzEventHubConsumerGroup `
                        -ResourceGroupName $ResourceGroupName `
                        -NamespaceName $namespaceName `
                        -EventHubName $hubName `
                        -Name $groupName `
                        -ErrorAction Stop

                    Write-ToLog -Message "Consumer Group created: $groupName" -Level "SUCCESS"
                    $createdGroups += $group

                } catch {
                    Write-ToLog -Message "Failed to create Consumer Group $groupName : $($_.Exception.Message)" -Level "ERROR"
                    Write-DebugException -Exception $_.Exception -Context "Deploy-EventHub"
                }
            }
        }
    }

    # Deploy Shared Access Policies
    $createdPolicies = @()
    $authConfig = $eventHubConfig.authentication

    if ($authConfig.sharedAccessPolicies) {
        Write-DebugLog -Message "Deploying Shared Access Policies..." -Context "Deploy-EventHub"

        foreach ($policyKey in $authConfig.sharedAccessPolicies.PSObject.Properties.Name) {
            $policyConfig = $authConfig.sharedAccessPolicies.$policyKey
            $policyName = $policyConfig.name

            Write-DebugLog -Message "Processing policy: $policyName" -Context "Deploy-EventHub"

            $existingPolicy = Get-AzEventHubAuthorizationRule `
                -ResourceGroupName $ResourceGroupName `
                -Namespace $namespaceName `
                -Name $policyName `
                -ErrorAction SilentlyContinue

            if ($null -ne $existingPolicy) {
                Write-DebugLog -Message "Policy already exists: $policyName" -Context "Deploy-EventHub"
                $createdPolicies += $existingPolicy
                continue
            }

            try {
                $rights = @()
                if ($policyConfig.rights.send) { $rights += "Send" }
                if ($policyConfig.rights.listen) { $rights += "Listen" }
                if ($policyConfig.rights.manage) { $rights += "Manage" }

                Write-DebugLog -Message "  Rights to assign: $($rights -join ', ')" -Context "Deploy-EventHub"
                Write-DebugAzureCall -Cmdlet "New-AzEventHubAuthorizationRule" -Parameters @{
                    ResourceGroupName = $ResourceGroupName
                    Namespace = $namespaceName
                    Name = $policyName
                    Rights = ($rights -join ', ')
                } -Context "Deploy-EventHub"

                $policy = New-AzEventHubAuthorizationRule `
                    -ResourceGroupName $ResourceGroupName `
                    -Namespace $namespaceName `
                    -Name $policyName `
                    -Rights $rights `
                    -ErrorAction Stop

                Write-ToLog -Message "Shared Access Policy created: $policyName" -Level "SUCCESS"
                $createdPolicies += $policy

            } catch {
                Write-ToLog -Message "Failed to create policy $policyName : $($_.Exception.Message)" -Level "ERROR"
                Write-DebugException -Exception $_.Exception -Context "Deploy-EventHub"
            }
        }
    }

    Write-DebugLog -Message "Event Hub deployment completed successfully" -Context "Deploy-EventHub"
    Stop-DebugOperation -Operation "Deploy-EventHub" -Stopwatch $mainSw -Success $true

    return @{
        Status = "Success"
        Message = "Event Hub deployed successfully"
        Data = @{
            Namespace = $namespace
            EventHubs = $createdHubs
            ConsumerGroups = $createdGroups
            SharedAccessPolicies = $createdPolicies
        }
    }

} catch {
    Write-ToLog -Message "Event Hub deployment failed: $($_.Exception.Message)" -Level "ERROR"
    Write-DebugException -Exception $_.Exception -Context "Deploy-EventHub"
    Stop-DebugOperation -Operation "Deploy-EventHub" -Stopwatch $mainSw -Success $false

    return @{
        Status = "Failed"
        Message = $_.Exception.Message
        Data = $null
    }
}
