# Deploy-Analytics.ps1
# Deploys Event Hub Namespace and Azure Data Explorer for Unified Azure Lab

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

function Deploy-EventHubNamespace {
    if (-not $OperationParams.deployment.analytics.deployEventHub) {
        return $null
    }

    $namespaceName = $ResourceNames.EventHubNamespace
    $eventHubConfig = $AzureParams.analytics.eventHub
    $namespaceConfig = $eventHubConfig.namespace

    $existingNamespace = Get-AzEventHubNamespace -ResourceGroupName $ResourceGroupName -Name $namespaceName -ErrorAction SilentlyContinue

    if ($null -ne $existingNamespace) {
        if ($SkipExisting) {
            return $existingNamespace
        } else {
            throw "Event Hub Namespace already exists"
        }
    }

    try {
        $namespace = New-AzEventHubNamespace `
            -ResourceGroupName $ResourceGroupName `
            -Name $namespaceName `
            -Location $Location `
            -SkuName $namespaceConfig.sku `
            -SkuCapacity $namespaceConfig.capacity `
            -ErrorAction Stop

        Write-ToLog -Message "Event Hub Namespace created: $namespaceName" -Level "SUCCESS"
        return $namespace

    } catch {
        Write-ToLog -Message "Failed to create Event Hub Namespace: $($_.Exception.Message)" -Level "ERROR"
        throw
    }
}

function Deploy-EventHubs {
    param($Namespace)

    if ($null -eq $Namespace) {
        return @()
    }

    $namespaceName = $Namespace.Name
    $createdHubs = @()

    foreach ($hubKey in $AzureParams.analytics.eventHub.hubs.PSObject.Properties.Name) {
        $hubConfig = $AzureParams.analytics.eventHub.hubs.$hubKey
        $hubName = $hubConfig.name

        $existingHub = Get-AzEventHub -ResourceGroupName $ResourceGroupName -NamespaceName $namespaceName -Name $hubName -ErrorAction SilentlyContinue

        if ($null -ne $existingHub) {
            $createdHubs += $existingHub
            continue
        }

        try {
            $retentionHours = $hubConfig.messageRetentionInDays * 24

            $hubParams = @{
                ResourceGroupName = $ResourceGroupName
                NamespaceName = $namespaceName
                Name = $hubName
                PartitionCount = $hubConfig.partitionCount
                RetentionTimeInHour = $retentionHours
                CleanupPolicy = "Delete"
                ErrorAction = "Stop"
            }

            $hub = New-AzEventHub @hubParams

            Write-ToLog -Message "Event Hub created: $hubName" -Level "SUCCESS"
            $createdHubs += $hub

        } catch {
            Write-ToLog -Message "Failed to create Event Hub $hubName : $($_.Exception.Message)" -Level "ERROR"
        }
    }

    return $createdHubs
}

function Deploy-ConsumerGroups {
    param($Namespace)

    if ($null -eq $Namespace) {
        return @()
    }

    $namespaceName = $Namespace.Name
    $createdGroups = @()

    foreach ($hubKey in $AzureParams.analytics.eventHub.hubs.PSObject.Properties.Name) {
        $hubConfig = $AzureParams.analytics.eventHub.hubs.$hubKey
        $hubName = $hubConfig.name

        if ($hubConfig.consumerGroups) {
            foreach ($groupName in $hubConfig.consumerGroups) {
                $existingGroup = Get-AzEventHubConsumerGroup `
                    -ResourceGroupName $ResourceGroupName `
                    -NamespaceName $namespaceName `
                    -EventHubName $hubName `
                    -Name $groupName `
                    -ErrorAction SilentlyContinue

                if ($null -ne $existingGroup) {
                    $createdGroups += $existingGroup
                    continue
                }

                try {
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
                }
            }
        }
    }

    return $createdGroups
}

function Deploy-SharedAccessPolicies {
    param($Namespace)

    if ($null -eq $Namespace) {
        return @()
    }

    $namespaceName = $Namespace.Name
    $createdPolicies = @()

    $authConfig = $AzureParams.analytics.eventHub.authentication

    if ($authConfig.sharedAccessPolicies) {
        foreach ($policyKey in $authConfig.sharedAccessPolicies.PSObject.Properties.Name) {
            $policyConfig = $authConfig.sharedAccessPolicies.$policyKey
            $policyName = $policyConfig.name

            $existingPolicy = Get-AzEventHubAuthorizationRule `
                -ResourceGroupName $ResourceGroupName `
                -Namespace $namespaceName `
                -Name $policyName `
                -ErrorAction SilentlyContinue

            if ($null -ne $existingPolicy) {
                $createdPolicies += $existingPolicy
                continue
            }

            try {
                $rights = @()
                if ($policyConfig.rights.send) { $rights += "Send" }
                if ($policyConfig.rights.listen) { $rights += "Listen" }
                if ($policyConfig.rights.manage) { $rights += "Manage" }

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
            }
        }
    }

    return $createdPolicies
}

function Deploy-ADXCluster {
    if (-not $OperationParams.deployment.analytics.deployADX -or -not $AzureParams.analytics.adx.enabled) {
        return $null
    }

    $clusterName = $ResourceNames.ADXCluster
    $clusterConfig = $AzureParams.analytics.adx

    $existingCluster = Get-AzKustoCluster -ResourceGroupName $ResourceGroupName -Name $clusterName -ErrorAction SilentlyContinue

    if ($null -ne $existingCluster) {
        if ($SkipExisting) {
            return $existingCluster
        } else {
            throw "ADX Cluster already exists"
        }
    }

    try {
        $cluster = New-AzKustoCluster `
            -ResourceGroupName $ResourceGroupName `
            -Name $clusterName `
            -Location $Location `
            -SkuName $clusterConfig.cluster.sku.name `
            -SkuTier $clusterConfig.cluster.sku.tier `
            -SkuCapacity $clusterConfig.cluster.sku.capacity `
            -ErrorAction Stop

        Write-ToLog -Message "ADX Cluster created: $clusterName" -Level "SUCCESS"
        return $cluster

    } catch {
        Write-ToLog -Message "Failed to create ADX Cluster: $($_.Exception.Message)" -Level "ERROR"
        throw
    }
}

function ConvertTo-TimeSpan {
    param([string]$IsoDuration)

    if ($IsoDuration -match '^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$') {
        $days = if ($Matches[3]) { [int]$Matches[3] } else { 0 }
        $hours = if ($Matches[4]) { [int]$Matches[4] } else { 0 }
        $minutes = if ($Matches[5]) { [int]$Matches[5] } else { 0 }
        $seconds = if ($Matches[6]) { [int]$Matches[6] } else { 0 }

        return New-TimeSpan -Days $days -Hours $hours -Minutes $minutes -Seconds $seconds
    }

    throw "Invalid ISO 8601 duration format: $IsoDuration"
}

function Deploy-ADXDatabase {
    param($Cluster)

    if ($null -eq $Cluster) {
        return $null
    }

    $clusterName = $Cluster.Name
    $databaseName = $AzureParams.analytics.adx.database.name
    $databaseConfig = $AzureParams.analytics.adx.database

    $existingDatabase = Get-AzKustoDatabase -ResourceGroupName $ResourceGroupName -ClusterName $clusterName -Name $databaseName -ErrorAction SilentlyContinue

    if ($null -ne $existingDatabase) {
        return $existingDatabase
    }

    try {
        $softDeleteTimeSpan = ConvertTo-TimeSpan -IsoDuration $databaseConfig.softDeletePeriod
        $hotCacheTimeSpan = ConvertTo-TimeSpan -IsoDuration $databaseConfig.hotCachePeriod

        $database = New-AzKustoDatabase `
            -ResourceGroupName $ResourceGroupName `
            -ClusterName $clusterName `
            -Name $databaseName `
            -Kind ReadWrite `
            -Location $Location `
            -SoftDeletePeriod $softDeleteTimeSpan `
            -HotCachePeriod $hotCacheTimeSpan `
            -ErrorAction Stop

        Write-ToLog -Message "ADX Database created: $databaseName" -Level "SUCCESS"
        return $database

    } catch {
        Write-ToLog -Message "Failed to create ADX Database: $($_.Exception.Message)" -Level "ERROR"
        throw
    }
}

function Create-ADXTables {
    param($Cluster, $Database)

    if ($null -eq $Cluster -or $null -eq $Database) {
        return @()
    }

    $clusterName = $Cluster.Name
    $databaseName = $Database.Name

    $createdTables = @()

    $tables = @(
        @{
            Name = "CommonSecurityLog"
            Schema = @(
                "TimeGenerated:datetime",
                "Activity:string",
                "AdditionalExtensions:string",
                "ApplicationProtocol:string",
                "CollectorHostName:string",
                "CommunicationDirection:string",
                "Computer:string",
                "DestinationDnsDomain:string",
                "DestinationHostName:string",
                "DestinationIP:string",
                "DestinationMACAddress:string",
                "DestinationNTDomain:string",
                "DestinationPort:int",
                "DestinationProcessId:int",
                "DestinationProcessName:string",
                "DestinationServiceName:string",
                "DestinationTranslatedAddress:string",
                "DestinationTranslatedPort:int",
                "DestinationUserID:string",
                "DestinationUserName:string",
                "DestinationUserPrivileges:string",
                "DeviceAction:string",
                "DeviceAddress:string",
                "DeviceCustomDate1:string",
                "DeviceCustomDate1Label:string",
                "DeviceCustomDate2:string",
                "DeviceCustomDate2Label:string",
                "DeviceCustomFloatingPoint1:real",
                "DeviceCustomFloatingPoint1Label:string",
                "DeviceCustomFloatingPoint2:real",
                "DeviceCustomFloatingPoint2Label:string",
                "DeviceCustomFloatingPoint3:real",
                "DeviceCustomFloatingPoint3Label:string",
                "DeviceCustomFloatingPoint4:real",
                "DeviceCustomFloatingPoint4Label:string",
                "DeviceCustomIPv6Address1:string",
                "DeviceCustomIPv6Address1Label:string",
                "DeviceCustomIPv6Address2:string",
                "DeviceCustomIPv6Address2Label:string",
                "DeviceCustomIPv6Address3:string",
                "DeviceCustomIPv6Address3Label:string",
                "DeviceCustomIPv6Address4:string",
                "DeviceCustomIPv6Address4Label:string",
                "DeviceCustomNumber1:int",
                "DeviceCustomNumber1Label:string",
                "DeviceCustomNumber2:int",
                "DeviceCustomNumber2Label:string",
                "DeviceCustomNumber3:int",
                "DeviceCustomNumber3Label:string",
                "DeviceCustomString1:string",
                "DeviceCustomString1Label:string",
                "DeviceCustomString2:string",
                "DeviceCustomString2Label:string",
                "DeviceCustomString3:string",
                "DeviceCustomString3Label:string",
                "DeviceCustomString4:string",
                "DeviceCustomString4Label:string",
                "DeviceCustomString5:string",
                "DeviceCustomString5Label:string",
                "DeviceCustomString6:string",
                "DeviceCustomString6Label:string",
                "DeviceDnsDomain:string",
                "DeviceEventCategory:string",
                "DeviceEventClassID:string",
                "DeviceExternalID:string",
                "DeviceFacility:string",
                "DeviceInboundInterface:string",
                "DeviceMacAddress:string",
                "DeviceName:string",
                "DeviceNtDomain:string",
                "DeviceOutboundInterface:string",
                "DevicePayloadId:string",
                "DeviceProduct:string",
                "DeviceTimeZone:string",
                "DeviceTranslatedAddress:string",
                "DeviceVendor:string",
                "DeviceVersion:string",
                "EndTime:datetime",
                "EventCount:int",
                "EventOutcome:string",
                "EventType:int",
                "ExternalID:int",
                "ExtID:string",
                "FieldDeviceCustomNumber1:long",
                "FieldDeviceCustomNumber2:long",
                "FieldDeviceCustomNumber3:long",
                "FileCreateTime:string",
                "FileHash:string",
                "FileID:string",
                "FileModificationTime:string",
                "FileName:string",
                "FilePath:string",
                "FilePermission:string",
                "FileSize:int",
                "FileType:string",
                "FlexDate1:string",
                "FlexDate1Label:string",
                "FlexNumber1:int",
                "FlexNumber1Label:string",
                "FlexNumber2:int",
                "FlexNumber2Label:string",
                "FlexString1:string",
                "FlexString1Label:string",
                "FlexString2:string",
                "FlexString2Label:string",
                "IndicatorThreatType:string",
                "LogSeverity:string",
                "MaliciousIP:string",
                "MaliciousIPCountry:string",
                "MaliciousIPLatitude:real",
                "MaliciousIPLongitude:real",
                "Message:string",
                "OldFileCreateTime:string",
                "OldFileHash:string",
                "OldFileID:string",
                "OldFileModificationTime:string",
                "OldFileName:string",
                "OldFilePath:string",
                "OldFilePermission:string",
                "OldFileSize:int",
                "OldFileType:string",
                "OriginalLogSeverity:string",
                "ProcessID:int",
                "ProcessName:string",
                "Protocol:string",
                "Reason:string",
                "ReceiptTime:string",
                "ReceivedBytes:long",
                "RemoteIP:string",
                "RemotePort:string",
                "ReportReferenceLink:string",
                "RequestClientApplication:string",
                "RequestContext:string",
                "RequestCookies:string",
                "RequestMethod:string",
                "RequestURL:string",
                "SentBytes:long",
                "SimplifiedDeviceAction:string",
                "SourceDnsDomain:string",
                "SourceHostName:string",
                "SourceIP:string",
                "SourceMACAddress:string",
                "SourceNTDomain:string",
                "SourcePort:int",
                "SourceProcessId:int",
                "SourceProcessName:string",
                "SourceServiceName:string",
                "SourceSystem:string",
                "SourceTranslatedAddress:string",
                "SourceTranslatedPort:int",
                "SourceUserID:string",
                "SourceUserName:string",
                "SourceUserPrivileges:string",
                "StartTime:datetime",
                "TenantId:string",
                "ThreatConfidence:string",
                "ThreatDescription:string",
                "ThreatSeverity:int",
                "Type:string"
            )
        }
    )

    foreach ($table in $tables) {
        try {
            $schemaString = $table.Schema -join ", "
            $kqlCommand = ".create table $($table.Name) ($schemaString)"

            New-AzKustoScript `
                -ResourceGroupName $ResourceGroupName `
                -ClusterName $clusterName `
                -DatabaseName $databaseName `
                -Name "create-table-$($table.Name)" `
                -ScriptContent $kqlCommand `
                -ForceUpdateTag ([guid]::NewGuid().ToString()) `
                -ContinueOnError $false `
                -ErrorAction Stop | Out-Null

            Write-ToLog -Message "ADX Table created: $($table.Name)" -Level "SUCCESS"
            $createdTables += $table.Name

        } catch {
            # Table may already exist
        }
    }

    return $createdTables
}

# Main execution
try {
    $storageAccount = $null
    if ($ResourceNames.StorageAccount) {
        $storageAccount = Get-AzStorageAccount `
            -ResourceGroupName $ResourceGroupName `
            -Name $ResourceNames.StorageAccount `
            -ErrorAction SilentlyContinue
    }

    $namespace = Deploy-EventHubNamespace
    $eventHubs = Deploy-EventHubs -Namespace $namespace
    $consumerGroups = Deploy-ConsumerGroups -Namespace $namespace
    $sharedAccessPolicies = Deploy-SharedAccessPolicies -Namespace $namespace
    $adxCluster = Deploy-ADXCluster
    $adxDatabase = Deploy-ADXDatabase -Cluster $adxCluster
    $adxTables = Create-ADXTables -Cluster $adxCluster -Database $adxDatabase

    Write-ToLog -Message "Analytics deployment completed" -Level "SUCCESS"

    return @{
        EventHubNamespace = $namespace
        EventHubs = $eventHubs
        ConsumerGroups = $consumerGroups
        SharedAccessPolicies = $sharedAccessPolicies
        ADXCluster = $adxCluster
        ADXDatabase = $adxDatabase
        ADXTables = $adxTables
    }

} catch {
    Write-ToLog -Message "Analytics deployment failed: $($_.Exception.Message)" -Level "ERROR"
    throw
}
