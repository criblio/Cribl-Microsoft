# Deploy-ADX.ps1
# Phase 5, SubPhase 5.2: Deploy Azure Data Explorer (Kusto) Cluster and Database
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
if (-not $OperationParams.deployment.analytics.deployADX -or -not $AzureParams.analytics.adx.enabled) {
    return @{
        Status = "Skipped"
        Message = "ADX deployment disabled"
        Data = $null
    }
}

$SkipExisting = $OperationParams.validation.skipExistingResources

# Debug: Log entry parameters
Write-DebugParameters -Parameters @{
    ResourceGroupName = $ResourceGroupName
    Location = $Location
    SkipExisting = $SkipExisting
    DeployADX = $OperationParams.deployment.analytics.deployADX
    ADXEnabled = $AzureParams.analytics.adx.enabled
    ClusterName = $ResourceNames.ADXCluster
} -Context "Deploy-ADX"

# Helper function to convert ISO 8601 duration to TimeSpan
function ConvertTo-TimeSpan {
    param([string]$IsoDuration)

    Write-DebugLog -Message "Converting ISO duration: $IsoDuration" -Context "ConvertTo-TimeSpan"

    if ($IsoDuration -match '^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$') {
        $days = if ($Matches[3]) { [int]$Matches[3] } else { 0 }
        $hours = if ($Matches[4]) { [int]$Matches[4] } else { 0 }
        $minutes = if ($Matches[5]) { [int]$Matches[5] } else { 0 }
        $seconds = if ($Matches[6]) { [int]$Matches[6] } else { 0 }

        $result = New-TimeSpan -Days $days -Hours $hours -Minutes $minutes -Seconds $seconds
        Write-DebugLog -Message "Converted to TimeSpan: $result (Days: $days, Hours: $hours, Minutes: $minutes, Seconds: $seconds)" -Context "ConvertTo-TimeSpan"
        return $result
    }

    Write-DebugLog -Message "ERROR: Invalid ISO 8601 duration format: $IsoDuration" -Context "ConvertTo-TimeSpan"
    throw "Invalid ISO 8601 duration format: $IsoDuration"
}

$mainSw = Start-DebugOperation -Operation "Deploy-ADX"

try {
    Write-DebugLog -Message "Starting ADX deployment..." -Context "Deploy-ADX"

    $clusterName = $ResourceNames.ADXCluster
    $clusterConfig = $AzureParams.analytics.adx

    Write-DebugLog -Message "ADX Cluster Name: $clusterName" -Context "Deploy-ADX"
    Write-DebugLog -Message "SKU Name: $($clusterConfig.cluster.sku.name)" -Context "Deploy-ADX"
    Write-DebugLog -Message "SKU Tier: $($clusterConfig.cluster.sku.tier)" -Context "Deploy-ADX"
    Write-DebugLog -Message "SKU Capacity: $($clusterConfig.cluster.sku.capacity)" -Context "Deploy-ADX"

    # Check for existing cluster
    Write-DebugAzureCall -Cmdlet "Get-AzKustoCluster" -Parameters @{
        ResourceGroupName = $ResourceGroupName
        Name = $clusterName
    } -Context "Deploy-ADX"
    $existingCluster = Get-AzKustoCluster -ResourceGroupName $ResourceGroupName -Name $clusterName -ErrorAction SilentlyContinue

    $cluster = $null
    if ($null -ne $existingCluster) {
        Write-DebugLog -Message "Existing ADX Cluster found" -Context "Deploy-ADX"
        Write-DebugResource -ResourceType "KustoCluster" -ResourceName $clusterName -ResourceId $existingCluster.Id -Properties @{
            State = $existingCluster.State
            Sku = $existingCluster.SkuName
        } -Context "Deploy-ADX"

        if ($SkipExisting) {
            Write-ToLog -Message "ADX Cluster exists: $clusterName" -Level "SUCCESS"
            $cluster = $existingCluster
        } else {
            Write-DebugLog -Message "ERROR: Cluster exists and SkipExisting is false" -Context "Deploy-ADX"
            Stop-DebugOperation -Operation "Deploy-ADX" -Stopwatch $mainSw -Success $false
            throw "ADX Cluster already exists"
        }
    } else {
        # Create new cluster
        Write-DebugLog -Message "Creating new ADX Cluster (this takes 10-15 minutes)..." -Context "Deploy-ADX"
        Write-DebugAzureCall -Cmdlet "New-AzKustoCluster" -Parameters @{
            ResourceGroupName = $ResourceGroupName
            Name = $clusterName
            Location = $Location
            SkuName = $clusterConfig.cluster.sku.name
            SkuTier = $clusterConfig.cluster.sku.tier
            SkuCapacity = $clusterConfig.cluster.sku.capacity
        } -Context "Deploy-ADX"

        $cluster = New-AzKustoCluster `
            -ResourceGroupName $ResourceGroupName `
            -Name $clusterName `
            -Location $Location `
            -SkuName $clusterConfig.cluster.sku.name `
            -SkuTier $clusterConfig.cluster.sku.tier `
            -SkuCapacity $clusterConfig.cluster.sku.capacity `
            -ErrorAction Stop

        Write-ToLog -Message "ADX Cluster created: $clusterName" -Level "SUCCESS"
        Write-DebugResource -ResourceType "KustoCluster" -ResourceName $clusterName -ResourceId $cluster.Id -Properties @{
            State = $cluster.State
            Sku = $cluster.SkuName
        } -Context "Deploy-ADX"
    }

    # Deploy ADX Database
    $database = $null
    if ($null -ne $cluster) {
        $databaseName = $clusterConfig.database.name
        $databaseConfig = $clusterConfig.database

        Write-DebugLog -Message "ADX Database Name: $databaseName" -Context "Deploy-ADX"
        Write-DebugLog -Message "Soft Delete Period: $($databaseConfig.softDeletePeriod)" -Context "Deploy-ADX"
        Write-DebugLog -Message "Hot Cache Period: $($databaseConfig.hotCachePeriod)" -Context "Deploy-ADX"

        Write-DebugAzureCall -Cmdlet "Get-AzKustoDatabase" -Parameters @{
            ResourceGroupName = $ResourceGroupName
            ClusterName = $clusterName
            Name = $databaseName
        } -Context "Deploy-ADX"
        $existingDatabase = Get-AzKustoDatabase -ResourceGroupName $ResourceGroupName -ClusterName $clusterName -Name $databaseName -ErrorAction SilentlyContinue

        if ($null -ne $existingDatabase) {
            Write-DebugLog -Message "ADX Database already exists: $databaseName" -Context "Deploy-ADX"
            $database = $existingDatabase
        } else {
            Write-DebugLog -Message "Converting retention periods..." -Context "Deploy-ADX"
            $softDeleteTimeSpan = ConvertTo-TimeSpan -IsoDuration $databaseConfig.softDeletePeriod
            $hotCacheTimeSpan = ConvertTo-TimeSpan -IsoDuration $databaseConfig.hotCachePeriod

            Write-DebugLog -Message "Creating new ADX Database..." -Context "Deploy-ADX"
            Write-DebugAzureCall -Cmdlet "New-AzKustoDatabase" -Parameters @{
                ResourceGroupName = $ResourceGroupName
                ClusterName = $clusterName
                Name = $databaseName
                Kind = "ReadWrite"
                Location = $Location
            } -Context "Deploy-ADX"

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
        }
    }

    # Create ADX Tables
    $createdTables = @()
    if ($null -ne $cluster -and $null -ne $database) {
        Write-DebugLog -Message "Creating ADX Tables in cluster: $clusterName, database: $($database.Name)" -Context "Deploy-ADX"

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
            Write-DebugLog -Message "Creating table: $($table.Name) with $($table.Schema.Count) columns" -Context "Deploy-ADX"

            try {
                $schemaString = $table.Schema -join ", "
                $kqlCommand = ".create table $($table.Name) ($schemaString)"

                Write-DebugAzureCall -Cmdlet "New-AzKustoScript" -Parameters @{
                    ResourceGroupName = $ResourceGroupName
                    ClusterName = $clusterName
                    DatabaseName = $database.Name
                    Name = "create-table-$($table.Name)"
                } -Context "Deploy-ADX"

                New-AzKustoScript `
                    -ResourceGroupName $ResourceGroupName `
                    -ClusterName $clusterName `
                    -DatabaseName $database.Name `
                    -Name "create-table-$($table.Name)" `
                    -ScriptContent $kqlCommand `
                    -ForceUpdateTag ([guid]::NewGuid().ToString()) `
                    -ContinueOnError $false `
                    -ErrorAction Stop | Out-Null

                Write-ToLog -Message "ADX Table created: $($table.Name)" -Level "SUCCESS"
                $createdTables += $table.Name

            } catch {
                Write-DebugLog -Message "Table creation failed or table already exists: $($table.Name) - $($_.Exception.Message)" -Context "Deploy-ADX"
            }
        }
    }

    Write-DebugLog -Message "ADX deployment completed successfully" -Context "Deploy-ADX"
    Stop-DebugOperation -Operation "Deploy-ADX" -Stopwatch $mainSw -Success $true

    return @{
        Status = "Success"
        Message = "ADX deployed successfully"
        Data = @{
            Cluster = $cluster
            Database = $database
            Tables = $createdTables
        }
    }

} catch {
    Write-ToLog -Message "ADX deployment failed: $($_.Exception.Message)" -Level "ERROR"
    Write-DebugException -Exception $_.Exception -Context "Deploy-ADX"
    Stop-DebugOperation -Operation "Deploy-ADX" -Stopwatch $mainSw -Success $false

    return @{
        Status = "Failed"
        Message = $_.Exception.Message
        Data = $null
    }
}
