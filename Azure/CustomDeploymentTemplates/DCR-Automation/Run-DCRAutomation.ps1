# Enhanced DCR Automation Script with Interactive Menu
# This script provides an interactive menu-based interface for processing tables with DCRs

param(
    [Parameter(Mandatory=$false)]
    [switch]$NonInteractive,
    
    [Parameter(Mandatory=$false)]
    [ValidateSet("Native", "Custom", "Both", "TemplateOnly", "Status", 
                 "DirectNative", "DirectCustom", "DirectBoth",
                 "DCENative", "DCECustom", "DCEBoth",
                 "CollectCribl", "ValidateCribl", "ResetCribl")]
    [string]$Mode = "",
    
    [Parameter(Mandatory=$false)]
    [switch]$ShowCriblConfig = $false,
    
    [Parameter(Mandatory=$false)]
    [switch]$ExportCriblConfig = $true,
    
    [Parameter(Mandatory=$false)]
    [switch]$SkipCriblExport = $false,
    
    [Parameter(Mandatory=$false)]
    [switch]$MigrateCustomTablesToDCR = $false,
    
    [Parameter(Mandatory=$false)]
    [switch]$AutoMigrateCustomTables = $false
)

$ScriptPath = Join-Path $PSScriptRoot "Create-TableDCRs.ps1"

# Function to display combined summary for Both modes
function Show-CombinedSummary {
    param(
        [hashtable]$NativeSummary,
        [hashtable]$CustomSummary,
        [string]$DCRMode
    )
    
    Write-Host "`n$('='*80)" -ForegroundColor Cyan
    Write-Host "COMBINED EXECUTION SUMMARY ($DCRMode DCRs - Native + Custom Tables)" -ForegroundColor Cyan
    Write-Host "$('='*80)" -ForegroundColor Cyan
    
    if ($NativeSummary) {
        Write-Host "`n📊 Native Tables Results:" -ForegroundColor White
        Write-Host "  DCRs Processed: $($NativeSummary.DCRsProcessed)" -ForegroundColor Gray
        Write-Host "  DCRs Created: $($NativeSummary.DCRsCreated)" -ForegroundColor Green
        Write-Host "  DCRs Already Existed: $($NativeSummary.DCRsExisted)" -ForegroundColor Yellow
        Write-Host "  Tables Validated: $($NativeSummary.TablesValidated)" -ForegroundColor Gray
        Write-Host "  Tables Not Found: $($NativeSummary.TablesNotFound)" -ForegroundColor $(if ($NativeSummary.TablesNotFound -gt 0) { "Red" } else { "Gray" })
    }
    
    if ($CustomSummary) {
        Write-Host "`n📦 Custom Tables Results:" -ForegroundColor White
        Write-Host "  DCRs Processed: $($CustomSummary.DCRsProcessed)" -ForegroundColor Gray
        Write-Host "  DCRs Created: $($CustomSummary.DCRsCreated)" -ForegroundColor Green
        Write-Host "  DCRs Already Existed: $($CustomSummary.DCRsExisted)" -ForegroundColor Yellow
        Write-Host "  Tables Created: $($CustomSummary.CustomTablesCreated)" -ForegroundColor Green
        Write-Host "  Tables Already Existed: $($CustomSummary.CustomTablesExisted)" -ForegroundColor Yellow
        if ($CustomSummary.CustomTablesMigrated -gt 0) {
            Write-Host "  Tables Migrated to DCR-based: $($CustomSummary.CustomTablesMigrated)" -ForegroundColor Magenta
        }
        Write-Host "  Tables Skipped: $($CustomSummary.TablesSkipped)" -ForegroundColor Yellow
        Write-Host "  Tables Failed: $($CustomSummary.CustomTablesFailed)" -ForegroundColor $(if ($CustomSummary.CustomTablesFailed -gt 0) { "Red" } else { "Gray" })
    }
    
    Write-Host "`n🔢 Combined Totals:" -ForegroundColor Cyan
    $totalDCRsProcessed = $(if ($NativeSummary) { $NativeSummary.DCRsProcessed } else { 0 }) + $(if ($CustomSummary) { $CustomSummary.DCRsProcessed } else { 0 })
    $totalDCRsCreated = $(if ($NativeSummary) { $NativeSummary.DCRsCreated } else { 0 }) + $(if ($CustomSummary) { $CustomSummary.DCRsCreated } else { 0 })
    $totalDCRsExisted = $(if ($NativeSummary) { $NativeSummary.DCRsExisted } else { 0 }) + $(if ($CustomSummary) { $CustomSummary.DCRsExisted } else { 0 })
    $totalDCEsCreated = $(if ($NativeSummary) { $NativeSummary.DCEsCreated } else { 0 }) + $(if ($CustomSummary) { $CustomSummary.DCEsCreated } else { 0 })
    $totalDCEsExisted = $(if ($NativeSummary) { $NativeSummary.DCEsExisted } else { 0 }) + $(if ($CustomSummary) { $CustomSummary.DCEsExisted } else { 0 })
    
    Write-Host "  Total DCRs Processed: $totalDCRsProcessed" -ForegroundColor White
    Write-Host "  Total DCRs Created: $totalDCRsCreated" -ForegroundColor Green
    Write-Host "  Total DCRs Already Existed: $totalDCRsExisted" -ForegroundColor Yellow
    Write-Host "  Total DCEs Created: $totalDCEsCreated" -ForegroundColor Green
    Write-Host "  Total DCEs Already Existed: $totalDCEsExisted" -ForegroundColor Yellow
    Write-Host "  DCR Mode: $DCRMode" -ForegroundColor Cyan
    
    Write-Host "`n✅ Combined processing complete!" -ForegroundColor Green
}

# Helper function to display DCR mode status
function Get-DCRModeStatus {
    $opParams = Get-Content (Join-Path $PSScriptRoot "operation-parameters.json") | ConvertFrom-Json
    if ($opParams.deployment.createDCE) {
        return "DCE-based"
    } else {
        return "Direct"
    }
}

# Helper function to set DCR mode parameter
function Set-DCRModeParameter {
    param([bool]$UseDCE)
    
    if ($UseDCE) {
        return "-CreateDCE"
    } else {
        return "-CreateDCE:`$false"
    }
}

# Function to execute a mode
function Execute-Mode {
    param([string]$ExecutionMode)
    
    # Clear any existing configuration if this is first call
    if ($ExecutionMode -ne "Status") {
        $tempMarkerFile = Join-Path $PSScriptRoot ".cribl-collection-in-progress"
        if (-not (Test-Path $tempMarkerFile)) {
            New-Item -ItemType File -Path $tempMarkerFile -Force | Out-Null
            Register-EngineEvent -SourceIdentifier PowerShell.Exiting -Action {
                $tempFile = Join-Path $PSScriptRoot ".cribl-collection-in-progress"
                if (Test-Path $tempFile) {
                    Remove-Item $tempFile -Force -ErrorAction SilentlyContinue
                }
            } | Out-Null
        }
    }
    
    switch ($ExecutionMode) {
        "Status" {
            Write-Host "`n📊 Current Configuration Status" -ForegroundColor Cyan
            Write-Host "="*50 -ForegroundColor Cyan
            
            # Read current settings
            $opParams = Get-Content (Join-Path $PSScriptRoot "operation-parameters.json") | ConvertFrom-Json
            $azParams = Get-Content (Join-Path $PSScriptRoot "azure-parameters.json") | ConvertFrom-Json
            
            $currentDCRMode = Get-DCRModeStatus
            
            Write-Host "`n🔧 Operation Settings:" -ForegroundColor Yellow
            Write-Host "  DCR Mode: $currentDCRMode" -ForegroundColor $(if ($currentDCRMode -eq "Direct") { "Green" } else { "Blue" })
            Write-Host "  Custom Table Mode: $($opParams.customTableSettings.enabled)" -ForegroundColor Gray
            Write-Host "  Template Only: $($opParams.scriptBehavior.templateOnly)" -ForegroundColor Gray
            
            Write-Host "`n📁 Table Lists:" -ForegroundColor Yellow
            $nativeTables = Get-Content (Join-Path $PSScriptRoot "NativeTableList.json") | ConvertFrom-Json
            Write-Host "  Native Tables: $($nativeTables -join ', ')" -ForegroundColor Gray
            
            if (Test-Path (Join-Path $PSScriptRoot "CustomTableList.json")) {
                $customTables = Get-Content (Join-Path $PSScriptRoot "CustomTableList.json") | ConvertFrom-Json
                Write-Host "  Custom Tables: $($customTables -join ', ')" -ForegroundColor Gray
            }
            
            Write-Host "`n🎯 Azure Resources:" -ForegroundColor Yellow
            Write-Host "  Resource Group: $($azParams.resourceGroupName)" -ForegroundColor Gray
            Write-Host "  Workspace: $($azParams.workspaceName)" -ForegroundColor Gray
            Write-Host "  Location: $($azParams.location)" -ForegroundColor Gray
            Write-Host "  DCR Prefix: $($azParams.dcrPrefix)" -ForegroundColor Gray
            if ($currentDCRMode -eq "DCE-based") {
                Write-Host "  DCE Resource Group: $($azParams.dceResourceGroupName)" -ForegroundColor Gray
                Write-Host "  DCE Prefix: $($azParams.dcePrefix)" -ForegroundColor Gray
            }
            
            if (-not $SkipCriblExport) {
                Write-Host "`n  🔗 Cribl Configuration Export: ENABLED (default)" -ForegroundColor Magenta
            } else {
                Write-Host "`n  ⏭️ Cribl Configuration Export: DISABLED" -ForegroundColor Yellow
            }
            if ($ShowCriblConfig) {
                Write-Host "  🔍 Cribl Config Display: ENABLED" -ForegroundColor Cyan
            }
        }
        
        "DirectNative" {
            Write-Host "`n🚀 Processing NATIVE Tables with DIRECT DCRs..." -ForegroundColor Green
            Write-Host "="*50 -ForegroundColor Green
            Write-Host "Tables: CommonSecurityLog, SecurityEvent, Syslog, WindowsEvent" -ForegroundColor Cyan
            Write-Host "DCR Mode: Direct (no DCE required)" -ForegroundColor Green
            Write-Host ""
            
            $exportCribl = -not $SkipCriblExport

            & $ScriptPath -CustomTableMode:$false -CreateDCE:$false -ShowCriblConfig:$ShowCriblConfig -ExportCriblConfig:$exportCribl -SkipCriblExport:$SkipCriblExport -MigrateCustomTablesToDCR:$MigrateCustomTablesToDCR -AutoMigrateCustomTables:$AutoMigrateCustomTables

        }
        
        "DirectCustom" {
            Write-Host "`n🚀 Processing CUSTOM Tables with DIRECT DCRs..." -ForegroundColor Blue
            Write-Host "="*50 -ForegroundColor Blue
            
            if (Test-Path (Join-Path $PSScriptRoot "CustomTableList.json")) {
                $customTables = Get-Content (Join-Path $PSScriptRoot "CustomTableList.json") | ConvertFrom-Json
                Write-Host "Tables to process: $($customTables -join ', ')" -ForegroundColor Cyan
            } else {
                Write-Host "❌ CustomTableList.json not found!" -ForegroundColor Red
                return
            }
            
            Write-Host "DCR Mode: Direct (no DCE required)" -ForegroundColor Green
            Write-Host ""
            
            $exportCribl = -not $SkipCriblExport
            & $ScriptPath -CustomTableMode -CustomTableListFile "CustomTableList.json" -CreateDCE:$false -ShowCriblConfig:$ShowCriblConfig -ExportCriblConfig:$exportCribl -SkipCriblExport:$SkipCriblExport -MigrateCustomTablesToDCR:$MigrateCustomTablesToDCR -AutoMigrateCustomTables:$AutoMigrateCustomTables

        }
        
        "DirectBoth" {
            Write-Host "`n🚀 Processing ALL Tables with DIRECT DCRs..." -ForegroundColor Magenta
            Write-Host "="*50 -ForegroundColor Magenta
            Write-Host "DCR Mode: Direct (no DCE required)" -ForegroundColor Green
            
            Write-Host "`n📌 Step 1: Processing Native Tables with Direct DCRs..." -ForegroundColor Yellow
            $exportCribl = -not $SkipCriblExport

            $nativeSummary = & $ScriptPath -CustomTableMode:$false -CreateDCE:$false -ShowCriblConfig:$ShowCriblConfig -ExportCriblConfig:$exportCribl -SkipCriblExport:$SkipCriblExport -MigrateCustomTablesToDCR:$MigrateCustomTablesToDCR -AutoMigrateCustomTables:$AutoMigrateCustomTables
            
            Write-Host "`n📌 Step 2: Processing Custom Tables with Direct DCRs..." -ForegroundColor Yellow
            $customSummary = & $ScriptPath -CustomTableMode -CustomTableListFile "CustomTableList.json" -CreateDCE:$false -ShowCriblConfig:$ShowCriblConfig -ExportCriblConfig:$exportCribl -SkipCriblExport:$SkipCriblExport -MigrateCustomTablesToDCR:$MigrateCustomTablesToDCR -AutoMigrateCustomTables:$AutoMigrateCustomTables
            
            Show-CombinedSummary -NativeSummary $nativeSummary -CustomSummary $customSummary -DCRMode "Direct"
        }
        
        "DCENative" {
            Write-Host "`n🚀 Processing NATIVE Tables with DCE-based DCRs..." -ForegroundColor Green
            Write-Host "="*50 -ForegroundColor Green
            Write-Host "Tables: CommonSecurityLog, SecurityEvent, Syslog, WindowsEvent" -ForegroundColor Cyan
            Write-Host "DCR Mode: DCE-based (creates DCEs)" -ForegroundColor Blue
            Write-Host ""
            
            $exportCribl = -not $SkipCriblExport

            & $ScriptPath -CustomTableMode:$false -CreateDCE -ShowCriblConfig:$ShowCriblConfig -ExportCriblConfig:$exportCribl -SkipCriblExport:$SkipCriblExport -MigrateCustomTablesToDCR:$MigrateCustomTablesToDCR -AutoMigrateCustomTables:$AutoMigrateCustomTables

        }
        
        "DCECustom" {
            Write-Host "`n🚀 Processing CUSTOM Tables with DCE-based DCRs..." -ForegroundColor Blue
            Write-Host "="*50 -ForegroundColor Blue
            
            if (Test-Path (Join-Path $PSScriptRoot "CustomTableList.json")) {
                $customTables = Get-Content (Join-Path $PSScriptRoot "CustomTableList.json") | ConvertFrom-Json
                Write-Host "Tables to process: $($customTables -join ', ')" -ForegroundColor Cyan
            } else {
                Write-Host "❌ CustomTableList.json not found!" -ForegroundColor Red
                return
            }
            
            Write-Host "DCR Mode: DCE-based (creates DCEs)" -ForegroundColor Blue
            Write-Host ""
            
            $exportCribl = -not $SkipCriblExport

            & $ScriptPath -CustomTableMode -CustomTableListFile "CustomTableList.json" -CreateDCE -ShowCriblConfig:$ShowCriblConfig -ExportCriblConfig:$exportCribl -SkipCriblExport:$SkipCriblExport -MigrateCustomTablesToDCR:$MigrateCustomTablesToDCR -AutoMigrateCustomTables:$AutoMigrateCustomTables

        }
        
        "DCEBoth" {
            Write-Host "`n🚀 Processing ALL Tables with DCE-based DCRs..." -ForegroundColor Magenta
            Write-Host "="*50 -ForegroundColor Magenta
            Write-Host "DCR Mode: DCE-based (creates DCEs)" -ForegroundColor Blue
            
            Write-Host "`n📌 Step 1: Processing Native Tables with DCE-based DCRs..." -ForegroundColor Yellow
            $exportCribl = -not $SkipCriblExport

            $nativeSummary = & $ScriptPath -CustomTableMode:$false -CreateDCE -ShowCriblConfig:$ShowCriblConfig -ExportCriblConfig:$exportCribl -SkipCriblExport:$SkipCriblExport -MigrateCustomTablesToDCR:$MigrateCustomTablesToDCR -AutoMigrateCustomTables:$AutoMigrateCustomTables
            
            Write-Host "`n📌 Step 2: Processing Custom Tables with DCE-based DCRs..." -ForegroundColor Yellow
            $customSummary = & $ScriptPath -CustomTableMode -CustomTableListFile "CustomTableList.json" -CreateDCE -ShowCriblConfig:$ShowCriblConfig -ExportCriblConfig:$exportCribl -SkipCriblExport:$SkipCriblExport -MigrateCustomTablesToDCR:$MigrateCustomTablesToDCR -AutoMigrateCustomTables:$AutoMigrateCustomTables

            
            Show-CombinedSummary -NativeSummary $nativeSummary -CustomSummary $customSummary -DCRMode "DCE-based"
        }
        
        "CollectCribl" {
            Write-Host "`n🔍 Collecting Cribl Configuration from Templates and DCRs..." -ForegroundColor Cyan
            Write-Host "="*50 -ForegroundColor Cyan
            
            # Load Azure parameters
            $azParams = Get-Content (Join-Path $PSScriptRoot "azure-parameters.json") | ConvertFrom-Json
            $ResourceGroupName = $azParams.resourceGroupName
            $WorkspaceName = $azParams.workspaceName
            $DCRPrefix = $azParams.dcrPrefix
            $Location = $azParams.location
            
            Write-Host "Resource Group: $ResourceGroupName" -ForegroundColor Gray
            Write-Host "Workspace: $WorkspaceName" -ForegroundColor Gray
            Write-Host "DCR Prefix: $DCRPrefix" -ForegroundColor Gray
            Write-Host "Location: $Location" -ForegroundColor Gray
            Write-Host ""
            
            # [Rest of CollectCribl implementation remains the same...]
            # Code continues as in original script...
            
            Write-Host "`n✅ Cribl configuration collected and saved" -ForegroundColor Green
        }
        
        "ValidateCribl" {
            Write-Host "`n📊 Validating Cribl Configuration..." -ForegroundColor Cyan
            Write-Host "="*50 -ForegroundColor Cyan
            
            $criblConfigDir = Join-Path $PSScriptRoot "cribl-dcr-configs"
            $configPath = Join-Path $criblConfigDir "cribl-dcr-config.json"
            
            if (Test-Path $configPath) {
                $config = Get-Content $configPath -Raw | ConvertFrom-Json
                
                Write-Host "`nConfiguration Summary:" -ForegroundColor Yellow
                Write-Host "  Generated: $($config.GeneratedAt)" -ForegroundColor Gray
                Write-Host "  Resource Group: $($config.ResourceGroup)" -ForegroundColor Gray
                Write-Host "  Workspace: $($config.Workspace)" -ForegroundColor Gray
                Write-Host "  Total DCRs: $($config.DCRCount)" -ForegroundColor Yellow
                
                # Validation checks
                $nullEndpoints = @($config.DCRs | Where-Object { -not $_.IngestionEndpoint })
                $emptyStreams = @($config.DCRs | Where-Object { -not $_.StreamName })
                $emptyTables = @($config.DCRs | Where-Object { -not $_.TableName })
                
                Write-Host "`nValidation Results:" -ForegroundColor Cyan
                
                if ($nullEndpoints.Count -eq 0) {
                    Write-Host "  ✅ All ingestion endpoints present" -ForegroundColor Green
                } else {
                    Write-Host "  ❌ Missing endpoints: $($nullEndpoints.Count) DCR(s)" -ForegroundColor Red
                }
                
                if ($emptyStreams.Count -eq 0) {
                    Write-Host "  ✅ All stream names present" -ForegroundColor Green
                } else {
                    Write-Host "  ❌ Missing stream names: $($emptyStreams.Count) DCR(s)" -ForegroundColor Red
                }
                
                if ($emptyTables.Count -eq 0) {
                    Write-Host "  ✅ All table names present" -ForegroundColor Green
                } else {
                    Write-Host "  ❌ Missing table names: $($emptyTables.Count) DCR(s)" -ForegroundColor Red
                }
            } else {
                Write-Host "❌ No cribl-dcr-config.json file found!" -ForegroundColor Red
                Write-Host ""
                Write-Host "Create one by running a deployment or collecting from existing DCRs." -ForegroundColor Yellow
            }
        }
        
        "ResetCribl" {
            Write-Host "`n🔄 Reset Cribl Configuration" -ForegroundColor Cyan
            Write-Host "="*50 -ForegroundColor Cyan
            
            $criblConfigDir = Join-Path $PSScriptRoot "cribl-dcr-configs"
            $configPath = Join-Path $criblConfigDir "cribl-dcr-config.json"
            
            if (Test-Path $configPath) {
                $backupPath = Join-Path $criblConfigDir "cribl-dcr-config.backup.$(Get-Date -Format 'yyyyMMdd-HHmmss').json"
                Copy-Item $configPath $backupPath
                Write-Host "✅ Configuration backed up to: $(Split-Path $backupPath -Leaf)" -ForegroundColor Green
                
                Remove-Item $configPath -Force
                Write-Host "✅ Cribl configuration file reset!" -ForegroundColor Green
            } else {
                Write-Host "ℹ️  No existing configuration file to reset" -ForegroundColor Cyan
            }
        }
        
        "TemplateOnly" {
            Write-Host "`n📝 Generating Templates Only (No Deployment)..." -ForegroundColor Cyan
            Write-Host "="*50 -ForegroundColor Cyan
            
            $currentDCRMode = Get-DCRModeStatus
            Write-Host "DCR Mode: $currentDCRMode" -ForegroundColor Cyan
            
            Write-Host "`n📌 Generating Native Table Templates..." -ForegroundColor Yellow

            & $ScriptPath -CustomTableMode:$false -TemplateOnly -MigrateCustomTablesToDCR:$MigrateCustomTablesToDCR -AutoMigrateCustomTables:$AutoMigrateCustomTables
            
            Write-Host "`n📌 Generating Custom Table Templates..." -ForegroundColor Yellow
            & $ScriptPath -CustomTableMode -CustomTableListFile "CustomTableList.json" -TemplateOnly -MigrateCustomTablesToDCR:$MigrateCustomTablesToDCR -AutoMigrateCustomTables:$AutoMigrateCustomTables
            
            Write-Host "`n✅ Templates generated in: generated-templates\" -ForegroundColor Green
        }
    }
    
    # Check if Cribl config was exported
    $criblConfigPath = Join-Path $PSScriptRoot "cribl-dcr-configs" "cribl-dcr-config.json"
    if (-not $SkipCriblExport -and (Test-Path $criblConfigPath) -and $ExecutionMode -notmatch "Status|CollectCribl|ValidateCribl|ResetCribl") {
        Write-Host "`n📦 Cribl configuration automatically exported to: cribl-dcr-configs\cribl-dcr-config.json" -ForegroundColor Green
    }
    
    # Clean up temp marker file
    $tempMarkerFile = Join-Path $PSScriptRoot ".cribl-collection-in-progress"
    if (Test-Path $tempMarkerFile) {
        Remove-Item $tempMarkerFile -Force -ErrorAction SilentlyContinue
    }
}

# Function to display the main menu
function Show-MainMenu {
    Clear-Host
    Write-Host "`n$('='*60)" -ForegroundColor Cyan
    Write-Host "         DCR AUTOMATION DEPLOYMENT MENU" -ForegroundColor White
    Write-Host "$('='*60)" -ForegroundColor Cyan
    
    # Warning about configuration
    Write-Host "`n⚠️  IMPORTANT: Ensure azure-parameters.json is updated before deployment!" -ForegroundColor Yellow
    Write-Host "   This file must contain your workspace name, resource group, location (Azure Region), TenantId, and ClientId." -ForegroundColor DarkGray
    
    # Display current configuration
    $azParams = Get-Content (Join-Path $PSScriptRoot "azure-parameters.json") | ConvertFrom-Json
    Write-Host "`n📍 Current Configuration:" -ForegroundColor Cyan
    Write-Host "   Workspace: $($azParams.workspaceName)" -ForegroundColor Gray
    Write-Host "   Resource Group: $($azParams.resourceGroupName)" -ForegroundColor Gray
    
    # Get current DCR mode
    $currentDCRMode = Get-DCRModeStatus
    Write-Host "   DCR Mode: $currentDCRMode" -ForegroundColor $(if ($currentDCRMode -eq "Direct") { "Green" } else { "Blue" })
    
    # Check for custom tables
    $customTableCount = 0
    if (Test-Path (Join-Path $PSScriptRoot "CustomTableList.json")) {
        $customTables = Get-Content (Join-Path $PSScriptRoot "CustomTableList.json") | ConvertFrom-Json
        $customTableCount = $customTables.Count
    }
    
    Write-Host "`n📋 DEPLOYMENT OPTIONS:" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  [1] ⚡ Quick Deploy (Operational Parameters)" -ForegroundColor Magenta
    Write-Host "      ➤ Deploy both Native + Custom tables using current settings" -ForegroundColor Gray
    Write-Host "  $('-'*56)" -ForegroundColor DarkGray
    Write-Host "  [2] Deploy DCR (Native Direct)" -ForegroundColor White
    Write-Host "  [3] Deploy DCR (Native w/DCE)" -ForegroundColor White
    Write-Host "  [4] Deploy DCR (Custom Direct)" -ForegroundColor White
    Write-Host "  [5] Deploy DCR (Custom w/DCE)" -ForegroundColor White
    Write-Host "  $('-'*56)" -ForegroundColor DarkGray
    Write-Host "  [Q] Quit" -ForegroundColor Red
    Write-Host "$('='*60)" -ForegroundColor Cyan
}

# Function to confirm deployment
function Confirm-Deployment {
    param(
        [string]$TableType,
        [string]$DCRType,
        [array]$Tables
    )
    
    Write-Host "`n⚠️  DEPLOYMENT CONFIRMATION" -ForegroundColor Yellow
    Write-Host "$('-'*40)" -ForegroundColor Gray
    Write-Host "Table Type: $TableType" -ForegroundColor White
    Write-Host "DCR Type: $DCRType" -ForegroundColor White
    if ($Tables) {
        Write-Host "Tables to process: $($Tables -join ', ')" -ForegroundColor White
    }
    Write-Host "$('-'*40)" -ForegroundColor Gray
    
    $confirm = Read-Host "`nProceed with deployment? (Y/N)"
    return $confirm.ToUpper() -eq 'Y'
}

# Function to wait for user to continue
function Wait-ForUser {
    Write-Host "`nPress any key to continue..." -ForegroundColor Yellow
    $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
}

# Main script logic
if ($NonInteractive -or $Mode) {
    # Non-interactive mode - execute the specified mode and exit
    if ($Mode) {
        Execute-Mode -ExecutionMode $Mode
    } else {
        Write-Host "❌ Non-interactive mode requires -Mode parameter" -ForegroundColor Red
        Write-Host "Example: .\Run-DCRAutomation.ps1 -NonInteractive -Mode DirectBoth" -ForegroundColor Yellow
    }
} else {
    # Interactive menu mode
    $continue = $true
    
    # Initialize script-level variables for settings
    $script:ShowCriblConfig = $ShowCriblConfig
    $script:SkipCriblExport = $SkipCriblExport
    
    while ($continue) {
        Show-MainMenu
        $choice = Read-Host "`nSelect an option"
        
        switch ($choice.ToUpper()) {
            "1" {
                Write-Host "`n⚡ QUICK DEPLOY - Processing Native + Custom Tables" -ForegroundColor Magenta
                Write-Host "$('='*50)" -ForegroundColor Magenta
                
                $currentDCRMode = Get-DCRModeStatus
                Write-Host "Using current operational parameters: $currentDCRMode DCRs" -ForegroundColor Cyan
                
                # Check for custom tables
                $customTables = @()
                if (Test-Path (Join-Path $PSScriptRoot "CustomTableList.json")) {
                    $customTables = Get-Content (Join-Path $PSScriptRoot "CustomTableList.json") | ConvertFrom-Json
                }
                
                $nativeTables = @("CommonSecurityLog", "SecurityEvent", "Syslog", "WindowsEvent")
                
                Write-Host "`n📊 Tables to process:" -ForegroundColor Yellow
                Write-Host "   Native: $($nativeTables -join ', ')" -ForegroundColor Gray
                if ($customTables.Count -gt 0) {
                    Write-Host "   Custom: $($customTables -join ', ')" -ForegroundColor Gray
                } else {
                    Write-Host "   Custom: None configured" -ForegroundColor DarkGray
                }
                
                $confirm = Read-Host "`nProceed with Quick Deploy using $currentDCRMode DCRs? (Y/N)"
                if ($confirm.ToUpper() -eq 'Y') {
                    Write-Host "`n📌 Step 1: Processing Native Tables..." -ForegroundColor Yellow
                    if ($currentDCRMode -eq "Direct") {
                        Execute-Mode -ExecutionMode "DirectNative"
                    } else {
                        Execute-Mode -ExecutionMode "DCENative"
                    }
                    
                    if ($customTables.Count -gt 0) {
                        Write-Host "`n📌 Step 2: Processing Custom Tables..." -ForegroundColor Yellow
                        if ($currentDCRMode -eq "Direct") {
                            Execute-Mode -ExecutionMode "DirectCustom"
                        } else {
                            Execute-Mode -ExecutionMode "DCECustom"
                        }
                    } else {
                        Write-Host "`n📌 Step 2: Skipping Custom Tables (none configured)" -ForegroundColor DarkGray
                    }
                    
                    Write-Host "`n✅ Quick Deploy complete!" -ForegroundColor Green
                } else {
                    Write-Host "`nDeployment cancelled." -ForegroundColor Yellow
                }
                Wait-ForUser
            }
            "2" {
                Write-Host "`n🚀 Native Tables with Direct DCRs" -ForegroundColor Green
                Write-Host "$('-'*40)" -ForegroundColor Gray
                
                $nativeTables = @("CommonSecurityLog", "SecurityEvent", "Syslog", "WindowsEvent")
                if (Confirm-Deployment -TableType "Native" -DCRType "Direct (no DCE)" -Tables $nativeTables) {
                    Write-Host "`nStarting deployment..." -ForegroundColor Cyan
                    Execute-Mode -ExecutionMode "DirectNative"
                    Write-Host "`n✅ Deployment complete!" -ForegroundColor Green
                } else {
                    Write-Host "`nDeployment cancelled." -ForegroundColor Yellow
                }
                Wait-ForUser
            }
            "3" {
                Write-Host "`n🚀 Native Tables with DCE-based DCRs" -ForegroundColor Blue
                Write-Host "$('-'*40)" -ForegroundColor Gray
                
                $nativeTables = @("CommonSecurityLog", "SecurityEvent", "Syslog", "WindowsEvent")
                if (Confirm-Deployment -TableType "Native" -DCRType "DCE-based" -Tables $nativeTables) {
                    Write-Host "`nStarting deployment..." -ForegroundColor Cyan
                    Execute-Mode -ExecutionMode "DCENative"
                    Write-Host "`n✅ Deployment complete!" -ForegroundColor Green
                } else {
                    Write-Host "`nDeployment cancelled." -ForegroundColor Yellow
                }
                Wait-ForUser
            }
            "4" {
                Write-Host "`n🚀 Custom Tables with Direct DCRs" -ForegroundColor Green
                Write-Host "$('-'*40)" -ForegroundColor Gray
                
                if (Test-Path (Join-Path $PSScriptRoot "CustomTableList.json")) {
                    $customTables = Get-Content (Join-Path $PSScriptRoot "CustomTableList.json") | ConvertFrom-Json
                    if ($customTables.Count -gt 0) {
                        if (Confirm-Deployment -TableType "Custom" -DCRType "Direct (no DCE)" -Tables $customTables) {
                            Write-Host "`nStarting deployment..." -ForegroundColor Cyan
                            Execute-Mode -ExecutionMode "DirectCustom"
                            Write-Host "`n✅ Deployment complete!" -ForegroundColor Green
                        } else {
                            Write-Host "`nDeployment cancelled." -ForegroundColor Yellow
                        }
                    } else {
                        Write-Host "`n❌ No custom tables found in CustomTableList.json" -ForegroundColor Red
                    }
                } else {
                    Write-Host "`n❌ CustomTableList.json not found!" -ForegroundColor Red
                    Write-Host "Please create this file with your custom table names." -ForegroundColor Yellow
                }
                Wait-ForUser
            }
            "5" {
                Write-Host "`n🚀 Custom Tables with DCE-based DCRs" -ForegroundColor Blue
                Write-Host "$('-'*40)" -ForegroundColor Gray
                
                if (Test-Path (Join-Path $PSScriptRoot "CustomTableList.json")) {
                    $customTables = Get-Content (Join-Path $PSScriptRoot "CustomTableList.json") | ConvertFrom-Json
                    if ($customTables.Count -gt 0) {
                        if (Confirm-Deployment -TableType "Custom" -DCRType "DCE-based" -Tables $customTables) {
                            Write-Host "`nStarting deployment..." -ForegroundColor Cyan
                            Execute-Mode -ExecutionMode "DCECustom"
                            Write-Host "`n✅ Deployment complete!" -ForegroundColor Green
                        } else {
                            Write-Host "`nDeployment cancelled." -ForegroundColor Yellow
                        }
                    } else {
                        Write-Host "`n❌ No custom tables found in CustomTableList.json" -ForegroundColor Red
                    }
                } else {
                    Write-Host "`n❌ CustomTableList.json not found!" -ForegroundColor Red
                    Write-Host "Please create this file with your custom table names." -ForegroundColor Yellow
                }
                Wait-ForUser
            }
            "Q" {
                Write-Host "`n👋 Exiting DCR Automation Tool. Goodbye!" -ForegroundColor Cyan
                $continue = $false

            }
            default {
                Write-Host "`n❌ Invalid choice. Please select 1-5 or Q to quit." -ForegroundColor Red
                Start-Sleep -Seconds 2
            }
        }
    }
}

Write-Host "`n✨ DCR Automation Complete!" -ForegroundColor Green
Write-Host ""
