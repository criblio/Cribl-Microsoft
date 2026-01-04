# Deploy-ResourceGroup.ps1
# Phase 1, SubPhase 1.1: Deploy Azure Resource Group with TTL tags
# Dependencies: None (first resource to be created)

param(
    [Parameter(Mandatory=$true)]
    [PSCustomObject]$AzureParams,

    [Parameter(Mandatory=$true)]
    [PSCustomObject]$OperationParams,

    [Parameter(Mandatory=$true)]
    [string]$ResourceGroupName,

    [Parameter(Mandatory=$true)]
    [string]$Location,

    [Parameter(Mandatory=$false)]
    [hashtable]$ResourceNames = @{}
)

# Debug: Log entry parameters
Write-DebugParameters -Parameters @{
    ResourceGroupName = $ResourceGroupName
    Location = $Location
    TTLEnabled = $AzureParams.timeToLive.enabled
    TTLHours = $AzureParams.timeToLive.hours
} -Context "Deploy-ResourceGroup"

$mainSw = Start-DebugOperation -Operation "Deploy-ResourceGroup"

try {
    Write-DebugLog -Message "Starting Resource Group deployment..." -Context "Deploy-ResourceGroup"

    Write-DebugAzureCall -Cmdlet "Get-AzResourceGroup" -Parameters @{
        Name = $ResourceGroupName
    } -Context "Deploy-ResourceGroup"

    $existingRG = Get-AzResourceGroup -Name $ResourceGroupName -ErrorAction SilentlyContinue

    if ($null -eq $existingRG) {
        Write-DebugLog -Message "Resource Group does not exist, creating..." -Context "Deploy-ResourceGroup"

        # Create base tags
        $tags = @{
            "Environment" = "Lab"
            "ManagedBy" = "UnifiedAzureLab"
            "CreatedDate" = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ssZ")
        }

        # Add TTL tags if enabled
        if ($AzureParams.timeToLive.enabled) {
            $expirationTime = (Get-Date).AddHours($AzureParams.timeToLive.hours)
            $warningTime = $expirationTime.AddHours(-$AzureParams.timeToLive.warningHours)

            $tags["TTL_Enabled"] = "true"
            $tags["TTL_ExpirationTime"] = $expirationTime.ToString("yyyy-MM-ddTHH:mm:ssZ")
            $tags["TTL_WarningTime"] = $warningTime.ToString("yyyy-MM-ddTHH:mm:ssZ")
            $tags["TTL_UserEmail"] = $AzureParams.timeToLive.userEmail
            $tags["TTL_Hours"] = $AzureParams.timeToLive.hours.ToString()

            Write-DebugLog -Message "TTL tags configured - Expiration: $($tags['TTL_ExpirationTime'])" -Context "Deploy-ResourceGroup"
        }

        Write-DebugAzureCall -Cmdlet "New-AzResourceGroup" -Parameters @{
            Name = $ResourceGroupName
            Location = $Location
            Tags = "tags hashtable"
        } -Context "Deploy-ResourceGroup"

        $rg = New-AzResourceGroup -Name $ResourceGroupName -Location $Location -Tag $tags -ErrorAction Stop

        Write-ToLog -Message "Resource Group created: $ResourceGroupName" -Level "SUCCESS"
        Write-DebugResource -ResourceType "ResourceGroup" -ResourceName $ResourceGroupName -ResourceId $rg.ResourceId -Properties @{
            Location = $rg.Location
            ProvisioningState = $rg.ProvisioningState
        } -Context "Deploy-ResourceGroup"

    } else {
        Write-DebugLog -Message "Resource Group already exists" -Context "Deploy-ResourceGroup"
        Write-DebugResource -ResourceType "ResourceGroup" -ResourceName $ResourceGroupName -ResourceId $existingRG.ResourceId -Properties @{
            Location = $existingRG.Location
            ProvisioningState = $existingRG.ProvisioningState
        } -Context "Deploy-ResourceGroup"

        # Update TTL tags if enabled
        if ($AzureParams.timeToLive.enabled) {
            Write-DebugLog -Message "Updating TTL tags on existing Resource Group" -Context "Deploy-ResourceGroup"

            $existingTags = $existingRG.Tags
            if ($null -eq $existingTags) { $existingTags = @{} }

            $expirationTime = (Get-Date).AddHours($AzureParams.timeToLive.hours)
            $warningTime = $expirationTime.AddHours(-$AzureParams.timeToLive.warningHours)

            $existingTags["TTL_Enabled"] = "true"
            $existingTags["TTL_ExpirationTime"] = $expirationTime.ToString("yyyy-MM-ddTHH:mm:ssZ")
            $existingTags["TTL_WarningTime"] = $warningTime.ToString("yyyy-MM-ddTHH:mm:ssZ")
            $existingTags["TTL_UserEmail"] = $AzureParams.timeToLive.userEmail
            $existingTags["TTL_Hours"] = $AzureParams.timeToLive.hours.ToString()
            $existingTags["TTL_WarningSent"] = "false"

            Write-DebugAzureCall -Cmdlet "Set-AzResourceGroup" -Parameters @{
                Name = $ResourceGroupName
                Tags = "updated tags"
            } -Context "Deploy-ResourceGroup"

            Set-AzResourceGroup -Name $ResourceGroupName -Tag $existingTags | Out-Null
            Write-DebugLog -Message "TTL tags updated - Expiration: $($existingTags['TTL_ExpirationTime'])" -Context "Deploy-ResourceGroup"
        }

        Write-ToLog -Message "Resource Group already exists: $ResourceGroupName (TTL extended)" -Level "SUCCESS"
        $rg = $existingRG
    }

    Stop-DebugOperation -Operation "Deploy-ResourceGroup" -Stopwatch $mainSw -Success $true

    return @{
        Status = "Success"
        Message = "Resource Group ready"
        Data = @{
            ResourceGroup = $rg
            Name = $ResourceGroupName
            Location = $Location
        }
    }

} catch {
    Write-ToLog -Message "Resource Group deployment failed: $($_.Exception.Message)" -Level "ERROR"
    Write-DebugException -Exception $_.Exception -Context "Deploy-ResourceGroup"
    Stop-DebugOperation -Operation "Deploy-ResourceGroup" -Stopwatch $mainSw -Success $false

    return @{
        Status = "Failed"
        Message = $_.Exception.Message
        Data = $null
    }
}
