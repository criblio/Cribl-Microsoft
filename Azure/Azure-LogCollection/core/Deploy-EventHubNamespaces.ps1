# Deploy Event Hub Namespaces for Diagnostic Logging
# Supports two deployment modes:
# - CENTRALIZED: Single namespace in one region (all logs flow to one location)
# - MULTI-REGION: One namespace per enabled region (logs stay in-region)

[CmdletBinding()]
param(
    [Parameter(Mandatory=$false)]
    [ValidateSet("Centralized", "MultiRegion")]
    [string]$DeploymentMode = "Centralized",

    [Parameter(Mandatory=$false)]
    [switch]$ValidateOnly,

    [Parameter(Mandatory=$false)]
    [switch]$ShowStatus,

    [Parameter(Mandatory=$false)]
    [switch]$RemoveNamespaces,

    [Parameter(Mandatory=$false)]
    [string[]]$SpecificRegions,

    # Override parameters - these take precedence over azure-parameters.json
    [Parameter(Mandatory=$false)]
    [Nullable[bool]]$UseExistingNamespaces = $null,

    [Parameter(Mandatory=$false)]
    [string]$CentralizedNamespaceOverride = "",

    [Parameter(Mandatory=$false)]
    [hashtable]$RegionNamespacesOverride = @{}
)

# Script variables
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ScriptStartTime = Get-Date
$ScriptPath = Split-Path -Parent $MyInvocation.MyCommand.Path

# Load configuration
$azureParamsFile = Join-Path $ScriptPath "azure-parameters.json"

if (-not (Test-Path $azureParamsFile)) {
    Write-Error "azure-parameters.json not found at: $azureParamsFile"
    exit 1
}

try {
    $azureParams = Get-Content $azureParamsFile | ConvertFrom-Json
} catch {
    Write-Error "Failed to parse azure-parameters.json: $_"
    exit 1
}

# Import output helper functions
$OutputHelperPath = Join-Path $ScriptPath "Output-Helper.ps1"
if (Test-Path $OutputHelperPath) {
    . $OutputHelperPath
}

# Initialize summary
$summary = @{
    ResourceGroupCreated = $false
    ResourceGroupExisted = $false
    NamespacesCreated = 0
    NamespacesExisted = 0
    NamespacesFailed = 0
    NamespacesRemoved = 0
    RegionsProcessed = 0
}

#region Helper Functions

function Connect-ToAzure {
    Write-StepHeader "Connecting to Azure"

    try {
        $context = Get-AzContext
        if (-not $context) {
            Write-SubStep "No active Azure context found. Please run Connect-AzAccount first." "Red"
            exit 1
        }

        Write-SubStep "Connected to Azure" "Green"
        Write-SubStep "Account: $($context.Account.Id)" "Gray"

        # Switch to Event Hub subscription
        if ($azureParams.eventHubSubscriptionId) {
            Write-SubStep "Switching to Event Hub subscription: $($azureParams.eventHubSubscriptionId)" "Cyan"
            Set-AzContext -SubscriptionId $azureParams.eventHubSubscriptionId | Out-Null
            $context = Get-AzContext
        }

        Write-SubStep "Subscription: $($context.Subscription.Name) ($($context.Subscription.Id))" "Gray"
        return $true
    } catch {
        Write-SubStep "Failed to connect to Azure: $_" "Red"
        return $false
    }
}

function Get-SubscriptionIdShort {
    # First 8 characters of subscription ID for globally unique naming
    return $azureParams.eventHubSubscriptionId.Substring(0, 8).ToLower()
}

function Get-EffectiveUseExisting {
    # Override parameter takes precedence over config file
    if ($null -ne $UseExistingNamespaces) {
        return $UseExistingNamespaces
    }
    return ($azureParams.useExistingNamespaces -eq $true)
}

function Get-NamespaceName {
    param(
        [string]$Region,
        [string]$Mode
    )

    $useExisting = Get-EffectiveUseExisting

    if ($Mode -eq "Centralized") {
        # Check override parameter first
        if (-not [string]::IsNullOrWhiteSpace($CentralizedNamespaceOverride)) {
            return $CentralizedNamespaceOverride
        }
        # Check config file if using existing namespaces
        if ($useExisting -and -not [string]::IsNullOrWhiteSpace($azureParams.centralizedNamespace)) {
            return $azureParams.centralizedNamespace
        }
    } else {
        # Multi-region mode
        # Check override parameter first
        if ($RegionNamespacesOverride.ContainsKey($Region)) {
            $overrideName = $RegionNamespacesOverride[$Region]
            if (-not [string]::IsNullOrWhiteSpace($overrideName)) {
                return $overrideName
            }
        }
        # Note: Regions now come from inventory, not config file
        # Custom namespace names for existing namespaces must be passed via override parameter
    }

    # Fall back to auto-generated naming pattern
    $subIdShort = Get-SubscriptionIdShort

    if ($Mode -eq "Centralized") {
        # Single namespace: cribl-diag-a1b2c3d4
        return "$($azureParams.eventHubNamespacePrefix)-$subIdShort"
    } else {
        # Per-region namespace: cribl-diag-a1b2c3d4-eastus
        return "$($azureParams.eventHubNamespacePrefix)-$subIdShort-$Region"
    }
}

function Get-InventoryRegions {
    <#
    .SYNOPSIS
        Loads regions from the inventory file for Multi-Region deployments.
    #>
    $inventoryFile = Join-Path $ScriptPath "region-inventory" "inventory-latest.json"

    if (-not (Test-Path $inventoryFile)) {
        Write-Host "`n  ERROR: No inventory found!" -ForegroundColor Red
        Write-Host "  Run inventory first: .\Run-AzureLogCollection.ps1 -NonInteractive -Mode Inventory" -ForegroundColor Yellow
        return @()
    }

    try {
        $inventory = Get-Content $inventoryFile -Raw | ConvertFrom-Json
        if (-not $inventory.Regions -or $inventory.Regions.Count -eq 0) {
            Write-Host "`n  ERROR: Inventory file contains no regions!" -ForegroundColor Red
            return @()
        }

        # Convert to format expected by deployment logic
        return @($inventory.Regions | ForEach-Object {
            @{
                location = $_.Location
                enabled = $true
                resourceCount = $_.ResourceCount
            }
        })
    } catch {
        Write-Host "`n  ERROR: Failed to read inventory file: $_" -ForegroundColor Red
        return @()
    }
}

function Get-RegionsToProcess {
    param([string]$Mode)

    if ($Mode -eq "Centralized") {
        # Return only the centralized region
        return @(@{ location = $azureParams.centralizedRegion; enabled = $true })
    } else {
        # Return regions from inventory (not config file)
        $regions = Get-InventoryRegions

        # Filter to specific regions if provided
        if ($SpecificRegions -and $SpecificRegions.Count -gt 0) {
            $regions = $regions | Where-Object { $SpecificRegions -contains $_.location }
        }

        return $regions
    }
}

function New-EventHubResourceGroup {
    Write-StepHeader "Ensuring Resource Group Exists"

    $rgName = $azureParams.eventHubResourceGroup
    $rgLocation = if ($DeploymentMode -eq "Centralized") {
        $azureParams.centralizedRegion
    } else {
        (Get-RegionsToProcess -Mode $DeploymentMode | Select-Object -First 1).location
    }

    if ($ValidateOnly) {
        Write-SubStep "VALIDATION: Would ensure resource group '$rgName' exists in '$rgLocation'" "Yellow"
        return $true
    }

    try {
        $rg = Get-AzResourceGroup -Name $rgName -ErrorAction SilentlyContinue

        if ($rg) {
            Write-SubStep "Resource group already exists: $rgName" "Green"
            Write-SubStep "Location: $($rg.Location)" "Gray"
            $script:summary.ResourceGroupExisted = $true
        } else {
            Write-SubStep "Creating resource group: $rgName in $rgLocation" "Cyan"
            New-AzResourceGroup -Name $rgName -Location $rgLocation -Tag @{
                Purpose = "Cribl Diagnostic Logging"
                ManagedBy = "Azure-LogCollection"
                DeploymentMode = $DeploymentMode
            } | Out-Null

            Write-SubStep "Created resource group: $rgName" "Green"
            $script:summary.ResourceGroupCreated = $true
        }

        return $true
    } catch {
        Write-SubStep "Failed to create/verify resource group: $_" "Red"
        return $false
    }
}

function New-EventHubNamespace {
    param(
        [string]$Region,
        [string]$Mode
    )

    $namespaceName = Get-NamespaceName -Region $Region -Mode $Mode
    $rgName = $azureParams.eventHubResourceGroup

    Write-Host "`n  Processing: $Region" -ForegroundColor White
    Write-SubStep "Namespace name: $namespaceName" "Gray"
    Write-SubStep "Full DNS: $namespaceName.servicebus.windows.net" "Gray"

    if ($ValidateOnly) {
        Write-SubStep "VALIDATION: Would create namespace '$namespaceName' in '$Region'" "Yellow"
        $script:summary.NamespacesCreated++
        $script:summary.RegionsProcessed++
        return @{
            Name = $namespaceName
            Region = $Region
            Status = "WouldCreate"
            Mode = $Mode
        }
    }

    try {
        # Check if namespace already exists
        $existing = Get-AzEventHubNamespace -ResourceGroupName $rgName -Name $namespaceName -ErrorAction SilentlyContinue

        if ($existing) {
            Write-SubStep "Namespace already exists: $namespaceName" "Yellow"
            # Defensive property checking for StrictMode compatibility
            $skuInfo = "Unknown"
            if ($existing.PSObject.Properties.Name -contains 'Sku' -and $null -ne $existing.Sku) {
                $sku = $existing.Sku
                $skuName = if ($sku.PSObject.Properties.Name -contains 'Name') { $sku.Name } else { "Unknown" }
                $skuCapacity = if ($sku.PSObject.Properties.Name -contains 'Capacity') { $sku.Capacity } else { "Unknown" }
                $skuInfo = "SKU: $skuName, Capacity: $skuCapacity"
            } elseif ($existing.PSObject.Properties.Name -contains 'SkuName') {
                # Some Az module versions use SkuName directly
                $skuInfo = "SKU: $($existing.SkuName)"
            }
            Write-SubStep $skuInfo "Gray"
            $script:summary.NamespacesExisted++
            $script:summary.RegionsProcessed++

            return @{
                Name = $namespaceName
                Region = $Region
                ResourceId = $existing.Id
                Status = "Existed"
                Mode = $Mode
                AuthorizationRuleId = "$($existing.Id)/authorizationRules/RootManageSharedAccessKey"
            }
        }

        # Create new namespace
        Write-SubStep "Creating Event Hub Namespace..." "Cyan"

        $namespace = New-AzEventHubNamespace `
            -ResourceGroupName $rgName `
            -Name $namespaceName `
            -Location $Region `
            -SkuName $azureParams.eventHubSku `
            -SkuCapacity $azureParams.eventHubCapacity `
            -Tag @{
                Purpose = "Cribl Diagnostic Logging"
                Region = $Region
                ManagedBy = "Azure-LogCollection"
                DeploymentMode = $Mode
            }

        Write-SubStep "Created namespace: $namespaceName" "Green"
        Write-SubStep "Resource ID: $($namespace.Id)" "Gray"

        $script:summary.NamespacesCreated++
        $script:summary.RegionsProcessed++

        return @{
            Name = $namespaceName
            Region = $Region
            ResourceId = $namespace.Id
            Status = "Created"
            Mode = $Mode
            AuthorizationRuleId = "$($namespace.Id)/authorizationRules/RootManageSharedAccessKey"
        }

    } catch {
        Write-SubStep "Failed to create namespace: $_" "Red"
        $script:summary.NamespacesFailed++
        $script:summary.RegionsProcessed++

        return @{
            Name = $namespaceName
            Region = $Region
            Status = "Failed"
            Mode = $Mode
            Error = $_.Exception.Message
        }
    }
}

function Remove-EventHubNamespace {
    param(
        [string]$Region,
        [string]$Mode
    )

    $namespaceName = Get-NamespaceName -Region $Region -Mode $Mode
    $rgName = $azureParams.eventHubResourceGroup

    Write-Host "`n  Processing: $Region" -ForegroundColor White
    Write-SubStep "Namespace name: $namespaceName" "Gray"

    if ($ValidateOnly) {
        Write-SubStep "VALIDATION: Would remove namespace '$namespaceName'" "Yellow"
        return
    }

    try {
        $existing = Get-AzEventHubNamespace -ResourceGroupName $rgName -Name $namespaceName -ErrorAction SilentlyContinue

        if ($existing) {
            Write-SubStep "Removing namespace: $namespaceName" "Red"
            Remove-AzEventHubNamespace -ResourceGroupName $rgName -Name $namespaceName -Force
            Write-SubStep "Removed namespace: $namespaceName" "Green"
            $script:summary.NamespacesRemoved++
        } else {
            Write-SubStep "Namespace not found: $namespaceName" "Yellow"
        }
    } catch {
        Write-SubStep "Failed to remove namespace: $_" "Red"
    }
}

function Show-NamespaceStatus {
    Write-StepHeader "Event Hub Namespace Status"

    $rgName = $azureParams.eventHubResourceGroup
    $subIdShort = Get-SubscriptionIdShort

    # Check resource group
    Write-Host "`n  Resource Group: $rgName" -ForegroundColor Cyan
    try {
        $rg = Get-AzResourceGroup -Name $rgName -ErrorAction SilentlyContinue
        if ($rg) {
            Write-SubStep "Status: EXISTS" "Green"
            Write-SubStep "Location: $($rg.Location)" "Gray"
        } else {
            Write-SubStep "Status: NOT FOUND" "Yellow"
            return
        }
    } catch {
        Write-SubStep "Status: ERROR - $_" "Red"
        return
    }

    # Check for centralized namespace
    Write-Host "`n  Centralized Mode Namespace:" -ForegroundColor Cyan
    $centralName = Get-NamespaceName -Region $azureParams.centralizedRegion -Mode "Centralized"
    try {
        $ns = Get-AzEventHubNamespace -ResourceGroupName $rgName -Name $centralName -ErrorAction SilentlyContinue
        if ($ns) {
            Write-SubStep "$centralName - EXISTS ($($ns.Location))" "Green"
        } else {
            Write-SubStep "$centralName - NOT DEPLOYED" "Yellow"
        }
    } catch {
        Write-SubStep "$centralName - NOT DEPLOYED" "Yellow"
    }

    # Check for multi-region namespaces (from inventory)
    Write-Host "`n  Multi-Region Mode Namespaces (from inventory):" -ForegroundColor Cyan
    $inventoryRegions = Get-InventoryRegions

    if ($inventoryRegions.Count -eq 0) {
        Write-SubStep "No inventory found - run Inventory mode first" "Yellow"
    } else {
        foreach ($regionConfig in $inventoryRegions) {
            $region = $regionConfig.location
            $namespaceName = Get-NamespaceName -Region $region -Mode "MultiRegion"

            try {
                $ns = Get-AzEventHubNamespace -ResourceGroupName $rgName -Name $namespaceName -ErrorAction SilentlyContinue
                if ($ns) {
                    Write-Host "    $region : $namespaceName - EXISTS" -ForegroundColor Green
                } else {
                    Write-Host "    $region : $namespaceName - NOT DEPLOYED" -ForegroundColor Yellow
                }
            } catch {
                Write-Host "    $region : $namespaceName - NOT DEPLOYED" -ForegroundColor Yellow
            }
        }
    }

    # Show naming pattern
    Write-Host "`n  Naming Pattern:" -ForegroundColor Cyan
    Write-SubStep "Subscription ID (short): $subIdShort" "Gray"
    Write-SubStep "Centralized: {prefix}-{subId8} (e.g., $($azureParams.eventHubNamespacePrefix)-$subIdShort)" "Gray"
    Write-SubStep "Multi-Region: {prefix}-{subId8}-{region} (e.g., $($azureParams.eventHubNamespacePrefix)-$subIdShort-eastus)" "Gray"
}

function Export-CriblConfiguration {
    param([array]$NamespaceResults)

    Write-StepHeader "Exporting Cribl Stream Configuration"

    $rgName = $azureParams.eventHubResourceGroup
    $criblConfigs = @()

    foreach ($ns in $NamespaceResults) {
        if ($ns.Status -eq "Created" -or $ns.Status -eq "Existed") {
            try {
                # Get connection string
                $keys = Get-AzEventHubKey `
                    -ResourceGroupName $rgName `
                    -Namespace $ns.Name `
                    -Name "RootManageSharedAccessKey" `
                    -ErrorAction SilentlyContinue

                if ($keys) {
                    $criblConfigs += @{
                        region = $ns.Region
                        namespace = $ns.Name
                        deploymentMode = $ns.Mode
                        connectionString = $keys.PrimaryConnectionString
                        eventHubPattern = "insights-logs-*"
                        consumerGroup = "`$Default"
                    }
                    Write-SubStep "Retrieved config for: $($ns.Name)" "Green"
                }
            } catch {
                Write-SubStep "Could not get connection string for $($ns.Name): $_" "Yellow"
            }
        }
    }

    if ($criblConfigs.Count -gt 0) {
        # Create Cribl config directory
        $criblDir = Join-Path $ScriptPath "cribl-configs"
        if (-not (Test-Path $criblDir)) {
            New-Item -ItemType Directory -Path $criblDir -Force | Out-Null
        }

        # Export main config
        $configFile = Join-Path $criblDir "event-hub-sources.json"
        @{
            exportDate = (Get-Date -Format "yyyy-MM-dd HH:mm:ss")
            managementGroupId = $azureParams.managementGroupId
            deploymentMode = $DeploymentMode
            sources = $criblConfigs
        } | ConvertTo-Json -Depth 10 | Set-Content -Path $configFile

        Write-SubStep "Cribl configuration exported to: $configFile" "Green"
        Write-Host "`n  NOTE: Connection strings contain sensitive credentials." -ForegroundColor Yellow
        Write-Host "  Store securely and do not commit to source control." -ForegroundColor Yellow
    }
}

function Show-DeploymentSummary {
    param([array]$Results)

    Write-StepHeader "DEPLOYMENT SUMMARY"

    $duration = (Get-Date) - $ScriptStartTime

    Write-Host "`n  Deployment Mode: $DeploymentMode" -ForegroundColor Cyan

    Write-Host "`n  Resource Group:" -ForegroundColor Cyan
    if ($summary.ResourceGroupCreated) {
        Write-Host "    Created: $($azureParams.eventHubResourceGroup)" -ForegroundColor Green
    } elseif ($summary.ResourceGroupExisted) {
        Write-Host "    Already existed: $($azureParams.eventHubResourceGroup)" -ForegroundColor Yellow
    }

    Write-Host "`n  Event Hub Namespaces:" -ForegroundColor Cyan
    Write-Host "    Created: $($summary.NamespacesCreated)" -ForegroundColor Green
    Write-Host "    Already existed: $($summary.NamespacesExisted)" -ForegroundColor Yellow
    Write-Host "    Failed: $($summary.NamespacesFailed)" -ForegroundColor $(if ($summary.NamespacesFailed -gt 0) { "Red" } else { "Gray" })
    Write-Host "    Removed: $($summary.NamespacesRemoved)" -ForegroundColor $(if ($summary.NamespacesRemoved -gt 0) { "Cyan" } else { "Gray" })

    Write-Host "`n  Regions Processed: $($summary.RegionsProcessed)" -ForegroundColor Cyan
    Write-Host "`n  Duration: $($duration.ToString('mm\:ss'))" -ForegroundColor Gray

    if ($ValidateOnly) {
        Write-Host "`n  VALIDATION MODE - No resources were deployed" -ForegroundColor Yellow
    } elseif ($RemoveNamespaces) {
        Write-Host "`n  Namespace removal complete!" -ForegroundColor Cyan
    } else {
        Write-Host "`n  Event Hub Namespaces deployed!" -ForegroundColor Green

        if ($Results -and $Results.Count -gt 0) {
            Write-Host "`n  NEXT STEP: Deploy policy assignments using:" -ForegroundColor Yellow
            Write-Host "    .\Run-AzureLogCollection.ps1" -ForegroundColor White
        }
    }

    # Export results for use by policy deployment script
    if ($Results -and $Results.Count -gt 0 -and -not $ValidateOnly) {
        $outputFile = Join-Path $ScriptPath "namespace-deployment-results.json"
        @{
            deploymentMode = $DeploymentMode
            timestamp = (Get-Date -Format "yyyy-MM-dd HH:mm:ss")
            namespaces = $Results
        } | ConvertTo-Json -Depth 10 | Set-Content -Path $outputFile
        Write-Host "`n  Results exported to: $outputFile" -ForegroundColor Cyan
    }
}

#endregion

#region Main Execution

# Handle status check
if ($ShowStatus) {
    if (-not (Connect-ToAzure)) { exit 1 }
    Show-NamespaceStatus
    exit 0
}

# Connect to Azure
if (-not (Connect-ToAzure)) {
    exit 1
}

# Get regions to process based on mode
$regionsToProcess = Get-RegionsToProcess -Mode $DeploymentMode

if ($regionsToProcess.Count -eq 0) {
    Write-Host "`n  ERROR: No regions to process!" -ForegroundColor Red
    if ($DeploymentMode -eq "MultiRegion") {
        Write-Host "  Please set 'enabled: true' for at least one region in azure-parameters.json" -ForegroundColor Yellow
    }
    exit 1
}

Write-Host "`n  Deployment Mode: $DeploymentMode" -ForegroundColor Cyan
Write-Host "  Regions to process: $($regionsToProcess.location -join ', ')" -ForegroundColor Cyan

# Handle removal
if ($RemoveNamespaces) {
    Write-StepHeader "Removing Event Hub Namespaces - $DeploymentMode Mode"

    foreach ($regionConfig in $regionsToProcess) {
        Remove-EventHubNamespace -Region $regionConfig.location -Mode $DeploymentMode
    }

    Show-DeploymentSummary
    exit 0
}

# Check if using existing namespaces (use effective value which considers overrides)
if (Get-EffectiveUseExisting) {
    Write-StepHeader "Using Existing Event Hub Namespaces"
    Write-Host "`n  Mode: USE EXISTING NAMESPACES" -ForegroundColor Yellow
    Write-Host "  Skipping namespace creation - will use pre-existing namespaces." -ForegroundColor Yellow

    # Validate that namespaces exist
    $results = @()
    foreach ($regionConfig in $regionsToProcess) {
        $namespaceName = Get-NamespaceName -Region $regionConfig.location -Mode $DeploymentMode
        Write-Host "`n  Verifying: $($regionConfig.location)" -ForegroundColor White
        Write-SubStep "Expected namespace: $namespaceName" "Gray"

        try {
            $ns = Get-AzEventHubNamespace -ResourceGroupName $azureParams.eventHubResourceGroup -Name $namespaceName -ErrorAction SilentlyContinue
            if ($ns) {
                Write-SubStep "Namespace found: $namespaceName" "Green"
                $results += @{
                    Name = $namespaceName
                    Region = $regionConfig.location
                    ResourceId = $ns.Id
                    Status = "Existed"
                    Mode = $DeploymentMode
                    AuthorizationRuleId = "$($ns.Id)/authorizationRules/RootManageSharedAccessKey"
                }
                $script:summary.NamespacesExisted++
            } else {
                Write-SubStep "Namespace NOT FOUND: $namespaceName" "Red"
                Write-SubStep "Ensure the namespace exists or change to CREATE NEW mode" "Yellow"
                $script:summary.NamespacesFailed++
            }
        } catch {
            Write-SubStep "Error checking namespace: $_" "Red"
            $script:summary.NamespacesFailed++
        }
        $script:summary.RegionsProcessed++
    }

    # Show summary and export config if any namespaces were found
    Show-DeploymentSummary -Results $results
    if ($summary.NamespacesExisted -gt 0) {
        Export-CriblConfiguration -NamespaceResults $results
    }
    exit 0
}

# Deploy namespaces
Write-StepHeader "Deploying Event Hub Namespaces - $DeploymentMode Mode"

# Ensure resource group exists
if (-not (New-EventHubResourceGroup)) {
    exit 1
}

# Deploy namespace(s) based on mode
$results = @()
foreach ($regionConfig in $regionsToProcess) {
    $result = New-EventHubNamespace -Region $regionConfig.location -Mode $DeploymentMode
    $results += $result
}

# Show summary
Show-DeploymentSummary -Results $results

# Export Cribl configuration
if (-not $ValidateOnly -and ($summary.NamespacesCreated -gt 0 -or $summary.NamespacesExisted -gt 0)) {
    Export-CriblConfiguration -NamespaceResults $results
}

#endregion
