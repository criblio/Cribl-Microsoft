# Azure Flow Log Lab - Interactive Menu Interface
# This script provides an interactive menu-based interface for deploying Azure Flow Log Lab infrastructure

param(
    [Parameter(Mandatory=$false)]
    [switch]$NonInteractive,

    [Parameter(Mandatory=$false)]
    [ValidateSet("Full", "VNetOnly", "VPNOnly", "FlowLogsOnly", "CriblCollectorsOnly", "TemplateOnly", "Status", "Validate")]
    [string]$Mode = "",

    [Parameter(Mandatory=$false)]
    [switch]$SkipConfirmation = $false
)

# Get script directory
$ScriptRoot = $PSScriptRoot
$ProdDir = Join-Path $ScriptRoot "prod"
$DeploymentScript = Join-Path $ProdDir "Deploy-AzureFlowLogLab.ps1"

# Function to validate azure-parameters.json configuration
function Test-AzureParametersConfiguration {
    $azureParamsFile = Join-Path $ProdDir "azure-parameters.json"

    if (-not (Test-Path $azureParamsFile)) {
        Write-Host "`n❌ ERROR: azure-parameters.json file not found!" -ForegroundColor Red
        Write-Host "   Please ensure the file exists in the script directory." -ForegroundColor Yellow
        return $false
    }

    try {
        $azParams = Get-Content $azureParamsFile | ConvertFrom-Json
    } catch {
        Write-Host "`n❌ ERROR: azure-parameters.json is not valid JSON!" -ForegroundColor Red
        Write-Host "   Error: $($_.Exception.Message)" -ForegroundColor Yellow
        return $false
    }

    # Define required fields and their default placeholder values
    $requiredFields = @{
        "subscriptionId" = @("<YOUR-SUBSCRIPTION-ID-HERE>", "your-subscription-id", "")
        "resourceGroupName" = @("<YOUR-RG-NAME-HERE>", "your-rg-name", "")
        "location" = @("<YOUR-AZURE-REGION-HERE>", "eastus")
        "baseObjectName" = @("", "vpnlab", "mylab")
        "vnetAddressPrefix" = @("", "10.0.0.0/16")
    }

    $missingFields = @()
    $defaultFields = @()

    foreach ($field in $requiredFields.Keys) {
        $value = $azParams.$field

        if (-not $value -or [string]::IsNullOrWhiteSpace($value)) {
            $missingFields += $field
        } elseif ($requiredFields[$field] -contains $value -and $field -in @("subscriptionId", "resourceGroupName")) {
            $defaultFields += $field
        }
    }

    if ($missingFields.Count -gt 0 -or $defaultFields.Count -gt 0) {
        Write-Host "`n⚠️  CONFIGURATION REQUIRED" -ForegroundColor Yellow
        Write-Host "$('='*60)" -ForegroundColor Yellow
        Write-Host "The azure-parameters.json file needs to be updated before proceeding." -ForegroundColor White
        Write-Host ""

        if ($missingFields.Count -gt 0) {
            Write-Host "❌ Missing required fields:" -ForegroundColor Red
            foreach ($field in $missingFields) {
                Write-Host "   - $field" -ForegroundColor Red
            }
            Write-Host ""
        }

        if ($defaultFields.Count -gt 0) {
            Write-Host "⚠️  Fields still have default/placeholder values:" -ForegroundColor Yellow
            foreach ($field in $defaultFields) {
                $currentValue = $azParams.$field
                Write-Host "   - $field`: '$currentValue'" -ForegroundColor Yellow
            }
            Write-Host ""
        }

        Write-Host "📝 Please update the following fields in azure-parameters.json:" -ForegroundColor Cyan
        Write-Host "   • subscriptionId: Your Azure subscription ID (GUID)" -ForegroundColor Gray
        Write-Host "   • resourceGroupName: Your Azure resource group name" -ForegroundColor Gray
        Write-Host "   • location: Your Azure region (e.g., 'eastus', 'westus2')" -ForegroundColor Gray
        Write-Host "   • baseObjectName: Base name for all resources (e.g., 'vpnlab', 'prod')" -ForegroundColor Gray
        Write-Host "   • vnetAddressPrefix: vNet address space in CIDR (e.g., '10.0.0.0/24')" -ForegroundColor Gray
        Write-Host "$('='*60)" -ForegroundColor Yellow

        return $false
    }

    # Validate CIDR notation
    $cidrPattern = '^([0-9]{1,3}\.){3}[0-9]{1,3}/[0-9]{1,2}$'
    if ($azParams.vnetAddressPrefix -notmatch $cidrPattern) {
        Write-Host "`n⚠️  Invalid vnetAddressPrefix: Must be in CIDR notation (e.g., 10.0.0.0/24)" -ForegroundColor Yellow
        return $false
    }

    return $true
}

# Function to wait for configuration update
function Wait-ForConfigurationUpdate {
    Write-Host "`n🔧 CONFIGURATION UPDATE REQUIRED" -ForegroundColor Cyan
    Write-Host "$('-'*50)" -ForegroundColor Gray
    Write-Host "Please edit the azure-parameters.json file with your Azure details." -ForegroundColor White
    Write-Host ""

    do {
        $continue = Read-Host "Press Enter after updating azure-parameters.json (or 'q' to quit)"

        if ($continue.ToLower() -eq 'q') {
            Write-Host "`nExiting... Please update azure-parameters.json and run the script again." -ForegroundColor Yellow
            exit 0
        }

        Write-Host "`n🔍 Checking configuration..." -ForegroundColor Cyan

        if (Test-AzureParametersConfiguration) {
            Write-Host "✅ Configuration validated successfully!" -ForegroundColor Green
            Write-Host ""
            Start-Sleep -Seconds 1
            return $true
        } else {
            Write-Host "`n❌ Configuration still needs updates. Please check the fields above." -ForegroundColor Red
            Write-Host ""
        }

    } while ($true)
}

# Function to execute a deployment mode
function Execute-Mode {
    param([string]$ExecutionMode)

    switch ($ExecutionMode) {
        "Status" {
            Write-Host "`n📊 Current Configuration Status" -ForegroundColor Cyan
            Write-Host "="*60 -ForegroundColor Cyan

            $azParams = Get-Content (Join-Path $ProdDir "azure-parameters.json") | ConvertFrom-Json
            $opParams = Get-Content (Join-Path $ProdDir "operation-parameters.json") | ConvertFrom-Json

            Write-Host "`n🔧 Azure Configuration:" -ForegroundColor Yellow
            Write-Host "  Subscription ID: $($azParams.subscriptionId)" -ForegroundColor Gray
            Write-Host "  Resource Group: $($azParams.resourceGroupName)" -ForegroundColor Gray
            Write-Host "  Location: $($azParams.location)" -ForegroundColor Gray
            Write-Host "  Base Object Name: $($azParams.baseObjectName)" -ForegroundColor Gray
            Write-Host "  vNet Address: $($azParams.vnetAddressPrefix)" -ForegroundColor Gray
            Write-Host "  Gateway Subnet: $($azParams.subnets.gateway.addressPrefix)" -ForegroundColor Gray
            Write-Host "  VPN Gateway SKU: $($azParams.vpnGateway.sku)" -ForegroundColor Gray
            Write-Host "  VPN Type: $($azParams.vpnGateway.type)" -ForegroundColor Gray

            Write-Host "`n⚙️  Operation Settings:" -ForegroundColor Yellow
            Write-Host "  Deploy vNet: $($opParams.deployment.deployVNet)" -ForegroundColor Gray
            Write-Host "  Deploy VPN Gateway: $($opParams.deployment.deployVPNGateway)" -ForegroundColor Gray
            Write-Host "  Create Subnets: $($opParams.deployment.createSubnets)" -ForegroundColor Gray
            Write-Host "  Template Only: $($opParams.scriptBehavior.templateOnly)" -ForegroundColor Gray
            Write-Host "  Skip Existing: $($opParams.validation.skipExistingResources)" -ForegroundColor Gray
        }

        "Validate" {
            Write-Host "`n🔍 Validating Configuration..." -ForegroundColor Cyan
            Write-Host "="*60 -ForegroundColor Cyan

            if (Test-AzureParametersConfiguration) {
                Write-Host "`n✅ Configuration is valid!" -ForegroundColor Green

                # Additional validation
                $azParams = Get-Content (Join-Path $ProdDir "azure-parameters.json") | ConvertFrom-Json

                Write-Host "`n📋 Validation Results:" -ForegroundColor Yellow
                Write-Host "  ✅ All required fields present" -ForegroundColor Green
                Write-Host "  ✅ CIDR notation valid" -ForegroundColor Green
                Write-Host "  ✅ Configuration file syntax correct" -ForegroundColor Green
            } else {
                Write-Host "`n❌ Configuration validation failed!" -ForegroundColor Red
            }
        }

        "Full" {
            Write-Host "`n🚀 Full Deployment - vNet + VPN Gateway" -ForegroundColor Green
            Write-Host "="*60 -ForegroundColor Green

            if (-not $SkipConfirmation) {
                $azParams = Get-Content (Join-Path $ProdDir "azure-parameters.json") | ConvertFrom-Json
                $vnetName = "$($azParams.naming.vnet.prefix)$($azParams.baseObjectName)$($azParams.naming.vnet.suffix)"
                $vpnGwName = "$($azParams.naming.vpnGateway.prefix)$($azParams.baseObjectName)$($azParams.naming.vpnGateway.suffix)"
                Write-Host "`n📋 Will deploy:" -ForegroundColor Yellow
                Write-Host "  • Virtual Network: $vnetName ($($azParams.vnetAddressPrefix))" -ForegroundColor White
                Write-Host "  • Gateway Subnet: $($azParams.subnets.gateway.addressPrefix)" -ForegroundColor White
                Write-Host "  • VPN Gateway: $vpnGwName ($($azParams.vpnGateway.sku))" -ForegroundColor White
                Write-Host "`n⏱️  Estimated time: 30-45 minutes (VPN Gateway deployment)" -ForegroundColor Yellow

                $confirm = Read-Host "`nProceed with full deployment? (Y/N)"
                if ($confirm.ToUpper() -ne 'Y') {
                    Write-Host "`nDeployment cancelled." -ForegroundColor Yellow
                    return
                }
            }

            Write-Host "`n🔨 Starting deployment..." -ForegroundColor Cyan
            & $DeploymentScript -Mode Full
        }

        "VNetOnly" {
            Write-Host "`n🚀 vNet Only Deployment" -ForegroundColor Green
            Write-Host "="*60 -ForegroundColor Green

            if (-not $SkipConfirmation) {
                $azParams = Get-Content (Join-Path $ProdDir "azure-parameters.json") | ConvertFrom-Json
                $vnetName = "$($azParams.naming.vnet.prefix)$($azParams.baseObjectName)$($azParams.naming.vnet.suffix)"
                Write-Host "`n📋 Will deploy:" -ForegroundColor Yellow
                Write-Host "  • Virtual Network: $vnetName ($($azParams.vnetAddressPrefix))" -ForegroundColor White
                Write-Host "  • Gateway Subnet: $($azParams.subnets.gateway.addressPrefix)" -ForegroundColor White
                Write-Host "`n⏱️  Estimated time: 1-2 minutes" -ForegroundColor Yellow

                $confirm = Read-Host "`nProceed with vNet deployment? (Y/N)"
                if ($confirm.ToUpper() -ne 'Y') {
                    Write-Host "`nDeployment cancelled." -ForegroundColor Yellow
                    return
                }
            }

            Write-Host "`n🔨 Starting deployment..." -ForegroundColor Cyan
            & $DeploymentScript -Mode VNetOnly
        }

        "VPNOnly" {
            Write-Host "`n🚀 VPN Gateway Only Deployment" -ForegroundColor Blue
            Write-Host "="*60 -ForegroundColor Blue
            Write-Host "`n⚠️  This requires an existing vNet with GatewaySubnet" -ForegroundColor Yellow

            if (-not $SkipConfirmation) {
                $azParams = Get-Content (Join-Path $ProdDir "azure-parameters.json") | ConvertFrom-Json
                $publicIpName = "$($azParams.naming.publicIp.prefix)$($azParams.baseObjectName)-gateway$($azParams.naming.publicIp.suffix)"
                $vpnGwName = "$($azParams.naming.vpnGateway.prefix)$($azParams.baseObjectName)$($azParams.naming.vpnGateway.suffix)"
                Write-Host "`n📋 Will deploy:" -ForegroundColor Yellow
                Write-Host "  • Public IP: $publicIpName" -ForegroundColor White
                Write-Host "  • VPN Gateway: $vpnGwName ($($azParams.vpnGateway.sku))" -ForegroundColor White
                Write-Host "`n⏱️  Estimated time: 30-45 minutes" -ForegroundColor Yellow

                $confirm = Read-Host "`nProceed with VPN Gateway deployment? (Y/N)"
                if ($confirm.ToUpper() -ne 'Y') {
                    Write-Host "`nDeployment cancelled." -ForegroundColor Yellow
                    return
                }
            }

            Write-Host "`n🔨 Starting deployment..." -ForegroundColor Cyan
            & $DeploymentScript -Mode VPNOnly
        }

        "FlowLogsOnly" {
            Write-Host "`n🌊 Flow Logs Only Deployment" -ForegroundColor Cyan
            Write-Host "="*60 -ForegroundColor Cyan
            Write-Host "`n⚠️  This requires an existing vNet" -ForegroundColor Yellow

            if (-not $SkipConfirmation) {
                $azParams = Get-Content (Join-Path $ProdDir "azure-parameters.json") | ConvertFrom-Json
                Write-Host "`n📋 Will deploy:" -ForegroundColor Yellow
                Write-Host "  • Storage Account for flow logs" -ForegroundColor White
                Write-Host "  • VNet-level flow logs ($($azParams.flowLogging.vnetLevel.retentionDays) days retention)" -ForegroundColor White
                if ($azParams.flowLogging.subnetLevel.security.enabled) {
                    Write-Host "  • SecuritySubnet flow logs ($($azParams.flowLogging.subnetLevel.security.retentionDays) days retention)" -ForegroundColor White
                }
                if ($azParams.flowLogging.subnetLevel.o11y.enabled) {
                    Write-Host "  • O11ySubnet flow logs ($($azParams.flowLogging.subnetLevel.o11y.retentionDays) days retention)" -ForegroundColor White
                }
                Write-Host "  • Cribl collector configurations" -ForegroundColor White
                Write-Host "`n⏱️  Estimated time: 5-10 minutes + wait for flow logs to start" -ForegroundColor Yellow

                $confirm = Read-Host "`nProceed with Flow Logs deployment? (Y/N)"
                if ($confirm.ToUpper() -ne 'Y') {
                    Write-Host "`nDeployment cancelled." -ForegroundColor Yellow
                    return
                }
            }

            Write-Host "`n🔨 Starting deployment..." -ForegroundColor Cyan
            & $DeploymentScript -Mode FlowLogsOnly
        }

        "CriblCollectorsOnly" {
            Write-Host "`n🎨 Regenerate Cribl Collectors" -ForegroundColor Magenta
            Write-Host "="*60 -ForegroundColor Magenta
            Write-Host "`n⚠️  This requires existing flow logs with active data" -ForegroundColor Yellow

            if (-not $SkipConfirmation) {
                Write-Host "`n📋 Will do:" -ForegroundColor Yellow
                Write-Host "  • Discover flow log paths from blob storage" -ForegroundColor White
                Write-Host "  • Generate Cribl collector JSON files" -ForegroundColor White
                Write-Host "  • Output to: prod/cribl-collectors/" -ForegroundColor White
                Write-Host "`n⏱️  Estimated time: < 1 minute" -ForegroundColor Yellow

                $confirm = Read-Host "`nProceed with Cribl collector regeneration? (Y/N)"
                if ($confirm.ToUpper() -ne 'Y') {
                    Write-Host "`nOperation cancelled." -ForegroundColor Yellow
                    return
                }
            }

            Write-Host "`n🔨 Starting collector generation..." -ForegroundColor Cyan
            & $DeploymentScript -Mode CriblCollectorsOnly
        }

        "TemplateOnly" {
            Write-Host "`n📝 Generating Templates Only (No Deployment)" -ForegroundColor Cyan
            Write-Host "="*60 -ForegroundColor Cyan

            Write-Host "`n🔨 Generating ARM templates..." -ForegroundColor Cyan
            & $DeploymentScript -Mode TemplateOnly

            Write-Host "`n✅ Templates generated in: generated-templates\" -ForegroundColor Green
        }
    }
}

# Function to display the main menu
function Show-MainMenu {
    Clear-Host
    Write-Host "`n$('='*60)" -ForegroundColor Cyan
    Write-Host "         AZURE VNET & VPN DEPLOYMENT MENU" -ForegroundColor White
    Write-Host "$('='*60)" -ForegroundColor Cyan

    $azParams = Get-Content (Join-Path $ProdDir "azure-parameters.json") | ConvertFrom-Json
    $vnetName = "$($azParams.naming.vnet.prefix)$($azParams.baseObjectName)$($azParams.naming.vnet.suffix)"
    $vpnGwName = "$($azParams.naming.vpnGateway.prefix)$($azParams.baseObjectName)$($azParams.naming.vpnGateway.suffix)"
    Write-Host "`n📍 Current Configuration:" -ForegroundColor Cyan
    Write-Host "   Subscription: $($azParams.subscriptionId)" -ForegroundColor Gray
    Write-Host "   Resource Group: $($azParams.resourceGroupName)" -ForegroundColor Gray
    Write-Host "   Location: $($azParams.location)" -ForegroundColor Gray
    Write-Host "   vNet: $vnetName ($($azParams.vnetAddressPrefix))" -ForegroundColor Gray
    Write-Host "   VPN Gateway: $vpnGwName ($($azParams.vpnGateway.sku))" -ForegroundColor Gray

    Write-Host "`n📋 DEPLOYMENT OPTIONS:" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  [1] ⚡ Full Deployment (vNet + VPN Gateway + Flow Logs + VMs)" -ForegroundColor Magenta
    Write-Host "      ➤ Deploy complete Flow Log Lab infrastructure" -ForegroundColor Gray
    Write-Host "      ⏱️  Time: 45-60 minutes" -ForegroundColor DarkGray
    Write-Host "  $('-'*56)" -ForegroundColor DarkGray
    Write-Host "  [2] Deploy vNet Only" -ForegroundColor White
    Write-Host "      ⏱️  Time: 1-2 minutes" -ForegroundColor DarkGray
    Write-Host "  [3] Deploy VPN Gateway Only (requires existing vNet)" -ForegroundColor White
    Write-Host "      ⏱️  Time: 30-45 minutes" -ForegroundColor DarkGray
    Write-Host "  [4] Deploy Flow Logs Only (requires existing vNet)" -ForegroundColor White
    Write-Host "      ⏱️  Time: 5-10 minutes" -ForegroundColor DarkGray
    Write-Host "  [5] Regenerate Cribl Collectors (from existing flow logs)" -ForegroundColor White
    Write-Host "      ⏱️  Time: < 1 minute" -ForegroundColor DarkGray
    Write-Host "  $('-'*56)" -ForegroundColor DarkGray
    Write-Host "  [6] Check Deployment Status" -ForegroundColor White
    Write-Host "  [7] Validate Configuration" -ForegroundColor White
    Write-Host "  $('-'*56)" -ForegroundColor DarkGray
    Write-Host "  [Q] Quit" -ForegroundColor Red
    Write-Host "$('='*60)" -ForegroundColor Cyan
}

# Function to wait for user
function Wait-ForUser {
    Write-Host "`nPress any key to continue..." -ForegroundColor Yellow
    $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
}

# Main script logic
if ($NonInteractive -or $Mode) {
    # Non-interactive mode
    if ($Mode) {
        if (-not (Test-AzureParametersConfiguration)) {
            Write-Host "`n❌ Configuration validation failed in non-interactive mode!" -ForegroundColor Red
            Write-Host "Please update azure-parameters.json with valid values." -ForegroundColor Yellow
            exit 1
        }
        Execute-Mode -ExecutionMode $Mode
    } else {
        Write-Host "❌ Non-interactive mode requires -Mode parameter" -ForegroundColor Red
        Write-Host "Example: .\Run-VPNSetup.ps1 -NonInteractive -Mode Full" -ForegroundColor Yellow
    }
} else {
    # Interactive menu mode
    $continue = $true

    # Validate configuration before showing menu
    Write-Host "`n🔍 Validating azure-parameters.json configuration..." -ForegroundColor Cyan
    if (-not (Test-AzureParametersConfiguration)) {
        if (-not (Wait-ForConfigurationUpdate)) {
            Write-Host "`nExiting due to configuration issues." -ForegroundColor Red
            exit 1
        }
    } else {
        Write-Host "✅ Configuration validated successfully!" -ForegroundColor Green
        Start-Sleep -Seconds 1
    }

    while ($continue) {
        Show-MainMenu
        $choice = Read-Host "`nSelect an option"

        switch ($choice.ToUpper()) {
            "1" {
                Execute-Mode -ExecutionMode "Full"
                Wait-ForUser
            }
            "2" {
                Execute-Mode -ExecutionMode "VNetOnly"
                Wait-ForUser
            }
            "3" {
                Execute-Mode -ExecutionMode "VPNOnly"
                Wait-ForUser
            }
            "4" {
                Execute-Mode -ExecutionMode "FlowLogsOnly"
                Wait-ForUser
            }
            "5" {
                Execute-Mode -ExecutionMode "CriblCollectorsOnly"
                Wait-ForUser
            }
            "6" {
                Execute-Mode -ExecutionMode "Status"
                Wait-ForUser
            }
            "7" {
                Execute-Mode -ExecutionMode "Validate"
                Wait-ForUser
            }
            "Q" {
                Write-Host "`n👋 Exiting Azure Flow Log Lab Tool. Goodbye!" -ForegroundColor Cyan
                $continue = $false
            }
            default {
                Write-Host "`n❌ Invalid choice. Please select 1-7 or Q to quit." -ForegroundColor Red
                Start-Sleep -Seconds 2
            }
        }
    }
}

Write-Host "`n✨ Azure VPN Setup Complete!" -ForegroundColor Green
Write-Host ""
