# Enhanced helper script for processing Native and Custom tables with DCR mode selection
# This script provides easy commands to process different table types with Direct or DCE-based DCRs

param(
    [Parameter(Mandatory=$false)]
    [ValidateSet("Native", "Custom", "Both", "TemplateOnly", "Status", 
                 "DirectNative", "DirectCustom", "DirectBoth",
                 "DCENative", "DCECustom", "DCEBoth",
                 "CollectCribl", "ValidateCribl", "ResetCribl")]
    [string]$Mode = "Status",
    
    [Parameter(Mandatory=$false)]
    [ValidateSet("Direct", "DCE", "Current")]
    [string]$DCRMode = "Current",
    
    [Parameter(Mandatory=$false)]
    [switch]$ShowCriblConfig = $false,
    
    [Parameter(Mandatory=$false)]
    [switch]$ExportCriblConfig = $true,
    
    [Parameter(Mandatory=$false)]
    [switch]$SkipCriblExport = $false
)

$ScriptPath = Join-Path $PSScriptRoot "Create-TableDCRs.ps1"

# Helper function to display DCR mode status
function Get-DCRModeStatus {
    $opParams = Get-Content (Join-Path $PSScriptRoot "operation-parameters.json") | ConvertFrom-Json
    if ($opParams.deployment.createDCE) {
        return "DCE-based"
    } else {
        return "Direct"
    }
}

# Helper function to set DCR mode temporarily
function Set-DCRModeParameter {
    param([bool]$UseDCE)
    
    if ($UseDCE) {
        return "-CreateDCE"
    } else {
        return "-CreateDCE:`$false"
    }
}

# Clear any existing configuration if this is first call (to avoid duplicate accumulation across modes)
if ($Mode -ne "Status") {
    $tempMarkerFile = Join-Path $PSScriptRoot ".cribl-collection-in-progress"
    if (-not (Test-Path $tempMarkerFile)) {
        # This is the first call - clear temp accumulation
        New-Item -ItemType File -Path $tempMarkerFile -Force | Out-Null
        
        # Register cleanup on exit
        Register-EngineEvent -SourceIdentifier PowerShell.Exiting -Action {
            $tempFile = Join-Path $PSScriptRoot ".cribl-collection-in-progress"
            if (Test-Path $tempFile) {
                Remove-Item $tempFile -Force -ErrorAction SilentlyContinue
            }
        } | Out-Null
    }
}

switch ($Mode) {
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
        
        Write-Host "`n💡 Available Commands:" -ForegroundColor Green
        
        if (-not $SkipCriblExport) {
            Write-Host "`n  🔗 Cribl Configuration Export: ENABLED (default)" -ForegroundColor Magenta
            Write-Host "    - Will automatically export to cribl-dcr-config.json" -ForegroundColor Gray
            Write-Host "    - Use -SkipCriblExport to disable" -ForegroundColor Gray
        } else {
            Write-Host "`n  ⏭️ Cribl Configuration Export: DISABLED" -ForegroundColor Yellow
        }
        if ($ShowCriblConfig) {
            Write-Host "  🔍 Cribl Config Display: ENABLED" -ForegroundColor Cyan
            Write-Host "    - Will display DCR config after creation" -ForegroundColor Gray
        }
        
        Write-Host "`n  Table Processing (uses current DCR mode: $currentDCRMode):" -ForegroundColor Yellow
        Write-Host "  .\Run-DCRAutomation.ps1 -Mode Native       # Process native tables" -ForegroundColor White
        Write-Host "  .\Run-DCRAutomation.ps1 -Mode Custom       # Process custom tables" -ForegroundColor White
        Write-Host "  .\Run-DCRAutomation.ps1 -Mode Both         # Process both types" -ForegroundColor White
        
        Write-Host "`n  Direct DCR Commands (no DCE required):" -ForegroundColor Green
        Write-Host "  .\Run-DCRAutomation.ps1 -Mode DirectNative # Native tables with Direct DCRs" -ForegroundColor White
        Write-Host "  .\Run-DCRAutomation.ps1 -Mode DirectCustom # Custom tables with Direct DCRs" -ForegroundColor White
        Write-Host "  .\Run-DCRAutomation.ps1 -Mode DirectBoth   # All tables with Direct DCRs" -ForegroundColor White
        
        Write-Host "`n  DCE-based DCR Commands (creates DCEs):" -ForegroundColor Blue
        Write-Host "  .\Run-DCRAutomation.ps1 -Mode DCENative    # Native tables with DCE-based DCRs" -ForegroundColor White
        Write-Host "  .\Run-DCRAutomation.ps1 -Mode DCECustom    # Custom tables with DCE-based DCRs" -ForegroundColor White
        Write-Host "  .\Run-DCRAutomation.ps1 -Mode DCEBoth      # All tables with DCE-based DCRs" -ForegroundColor White
        
        Write-Host "`n  DCR Mode Override (temporary):" -ForegroundColor Magenta
        Write-Host "  .\Run-DCRAutomation.ps1 -Mode Native -DCRMode Direct  # Override to Direct" -ForegroundColor White
        Write-Host "  .\Run-DCRAutomation.ps1 -Mode Custom -DCRMode DCE     # Override to DCE-based" -ForegroundColor White
        
        Write-Host "`n  Other Commands:" -ForegroundColor Cyan
        Write-Host "  .\Run-DCRAutomation.ps1 -Mode TemplateOnly # Generate templates only" -ForegroundColor White
        
        Write-Host "`n  Cribl Configuration Management:" -ForegroundColor Magenta
        Write-Host "  .\Run-DCRAutomation.ps1 -Mode CollectCribl # Collect from existing DCRs" -ForegroundColor White
        Write-Host "  .\Run-DCRAutomation.ps1 -Mode ValidateCribl # Validate configuration" -ForegroundColor White
        Write-Host "  .\Run-DCRAutomation.ps1 -Mode ResetCribl   # Backup and reset config" -ForegroundColor White
        
        Write-Host "`n  Cribl Integration Options:" -ForegroundColor Magenta
        Write-Host "  Default: Automatically exports config to cribl-dcr-config.json" -ForegroundColor Yellow
        Write-Host "  Add -ShowCriblConfig to display DCR config during deployment" -ForegroundColor Gray
        Write-Host "  Add -SkipCriblExport to disable automatic export" -ForegroundColor Gray
        Write-Host "  Example: .\Run-DCRAutomation.ps1 -Mode DirectBoth -ShowCriblConfig" -ForegroundColor Gray
        Write-Host ""
    }
    
    "Native" {
        $dcrModeParam = ""
        $dcrModeDisplay = Get-DCRModeStatus
        
        # Apply DCRMode override if specified
        if ($DCRMode -eq "Direct") {
            $dcrModeParam = Set-DCRModeParameter -UseDCE $false
            $dcrModeDisplay = "Direct (override)"
        } elseif ($DCRMode -eq "DCE") {
            $dcrModeParam = Set-DCRModeParameter -UseDCE $true
            $dcrModeDisplay = "DCE-based (override)"
        }
        
        Write-Host "`n🚀 Processing NATIVE Tables..." -ForegroundColor Green
        Write-Host "="*50 -ForegroundColor Green
        Write-Host "Tables: CommonSecurityLog, SecurityEvent, Syslog, WindowsEvent" -ForegroundColor Cyan
        Write-Host "DCR Mode: $dcrModeDisplay" -ForegroundColor Cyan
        Write-Host ""
        
        # Process native tables
        $exportCribl = -not $SkipCriblExport
        if ($dcrModeParam) {
            & $ScriptPath -CustomTableMode:$false $dcrModeParam -ShowCriblConfig:$ShowCriblConfig -ExportCriblConfig:$exportCribl -SkipCriblExport:$SkipCriblExport
        } else {
            & $ScriptPath -CustomTableMode:$false -ShowCriblConfig:$ShowCriblConfig -ExportCriblConfig:$exportCribl -SkipCriblExport:$SkipCriblExport
        }
    }
    
    "Custom" {
        $dcrModeParam = ""
        $dcrModeDisplay = Get-DCRModeStatus
        
        # Apply DCRMode override if specified
        if ($DCRMode -eq "Direct") {
            $dcrModeParam = Set-DCRModeParameter -UseDCE $false
            $dcrModeDisplay = "Direct (override)"
        } elseif ($DCRMode -eq "DCE") {
            $dcrModeParam = Set-DCRModeParameter -UseDCE $true
            $dcrModeDisplay = "DCE-based (override)"
        }
        
        Write-Host "`n🚀 Processing CUSTOM Tables..." -ForegroundColor Blue
        Write-Host "="*50 -ForegroundColor Blue
        
        # List tables to be processed
        if (Test-Path (Join-Path $PSScriptRoot "CustomTableList.json")) {
            $customTables = Get-Content (Join-Path $PSScriptRoot "CustomTableList.json") | ConvertFrom-Json
            Write-Host "Tables to process: $($customTables -join ', ')" -ForegroundColor Cyan
        } else {
            Write-Host "❌ CustomTableList.json not found!" -ForegroundColor Red
            return
        }
        
        Write-Host "DCR Mode: $dcrModeDisplay" -ForegroundColor Cyan
        Write-Host "Note: Will use Azure schema if table exists, otherwise looks for schema file" -ForegroundColor Gray
        Write-Host ""
        
        # Process custom tables
        $exportCribl = -not $SkipCriblExport
        if ($dcrModeParam) {
            & $ScriptPath -CustomTableMode -CustomTableListFile "CustomTableList.json" $dcrModeParam -ShowCriblConfig:$ShowCriblConfig -ExportCriblConfig:$exportCribl -SkipCriblExport:$SkipCriblExport
        } else {
            & $ScriptPath -CustomTableMode -CustomTableListFile "CustomTableList.json" -ShowCriblConfig:$ShowCriblConfig -ExportCriblConfig:$exportCribl -SkipCriblExport:$SkipCriblExport
        }
    }
    
    "Both" {
        $dcrModeParam = ""
        $dcrModeDisplay = Get-DCRModeStatus
        
        # Apply DCRMode override if specified
        if ($DCRMode -eq "Direct") {
            $dcrModeParam = Set-DCRModeParameter -UseDCE $false
            $dcrModeDisplay = "Direct (override)"
        } elseif ($DCRMode -eq "DCE") {
            $dcrModeParam = Set-DCRModeParameter -UseDCE $true
            $dcrModeDisplay = "DCE-based (override)"
        }
        
        Write-Host "`n🚀 Processing ALL Tables (Native + Custom)..." -ForegroundColor Magenta
        Write-Host "="*50 -ForegroundColor Magenta
        Write-Host "DCR Mode: $dcrModeDisplay" -ForegroundColor Cyan
        
        # First process native tables
        Write-Host "`n📌 Step 1: Processing Native Tables..." -ForegroundColor Yellow
        $exportCribl = -not $SkipCriblExport
        if ($dcrModeParam) {
            & $ScriptPath -CustomTableMode:$false $dcrModeParam -ShowCriblConfig:$ShowCriblConfig -ExportCriblConfig:$exportCribl -SkipCriblExport:$SkipCriblExport
        } else {
            & $ScriptPath -CustomTableMode:$false -ShowCriblConfig:$ShowCriblConfig -ExportCriblConfig:$exportCribl -SkipCriblExport:$SkipCriblExport
        }
        
        # Then process custom tables
        Write-Host "`n📌 Step 2: Processing Custom Tables..." -ForegroundColor Yellow
        if ($dcrModeParam) {
            & $ScriptPath -CustomTableMode -CustomTableListFile "CustomTableList.json" $dcrModeParam -ShowCriblConfig:$ShowCriblConfig -ExportCriblConfig:$exportCribl -SkipCriblExport:$SkipCriblExport
        } else {
            & $ScriptPath -CustomTableMode -CustomTableListFile "CustomTableList.json" -ShowCriblConfig:$ShowCriblConfig -ExportCriblConfig:$exportCribl -SkipCriblExport:$SkipCriblExport
        }
        
        Write-Host "`n✅ Completed processing all tables with $dcrModeDisplay DCRs!" -ForegroundColor Green
    }
    
    # Direct DCR modes
    "DirectNative" {
        Write-Host "`n🚀 Processing NATIVE Tables with DIRECT DCRs..." -ForegroundColor Green
        Write-Host "="*50 -ForegroundColor Green
        Write-Host "Tables: CommonSecurityLog, SecurityEvent, Syslog, WindowsEvent" -ForegroundColor Cyan
        Write-Host "DCR Mode: Direct (no DCE required)" -ForegroundColor Green
        Write-Host ""
        
        $exportCribl = -not $SkipCriblExport
        & $ScriptPath -CustomTableMode:$false -CreateDCE:$false -ShowCriblConfig:$ShowCriblConfig -ExportCriblConfig:$exportCribl -SkipCriblExport:$SkipCriblExport
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
        & $ScriptPath -CustomTableMode -CustomTableListFile "CustomTableList.json" -CreateDCE:$false -ShowCriblConfig:$ShowCriblConfig -ExportCriblConfig:$exportCribl -SkipCriblExport:$SkipCriblExport
    }
    
    "DirectBoth" {
        Write-Host "`n🚀 Processing ALL Tables with DIRECT DCRs..." -ForegroundColor Magenta
        Write-Host "="*50 -ForegroundColor Magenta
        Write-Host "DCR Mode: Direct (no DCE required)" -ForegroundColor Green
        
        Write-Host "`n📌 Step 1: Processing Native Tables with Direct DCRs..." -ForegroundColor Yellow
        $exportCribl = -not $SkipCriblExport
        & $ScriptPath -CustomTableMode:$false -CreateDCE:$false -ShowCriblConfig:$ShowCriblConfig -ExportCriblConfig:$exportCribl -SkipCriblExport:$SkipCriblExport
        
        Write-Host "`n📌 Step 2: Processing Custom Tables with Direct DCRs..." -ForegroundColor Yellow
        & $ScriptPath -CustomTableMode -CustomTableListFile "CustomTableList.json" -CreateDCE:$false -ShowCriblConfig:$ShowCriblConfig -ExportCriblConfig:$exportCribl -SkipCriblExport:$SkipCriblExport
        
        Write-Host "`n✅ Completed processing all tables with Direct DCRs!" -ForegroundColor Green
    }
    
    # DCE-based DCR modes
    "DCENative" {
        Write-Host "`n🚀 Processing NATIVE Tables with DCE-based DCRs..." -ForegroundColor Green
        Write-Host "="*50 -ForegroundColor Green
        Write-Host "Tables: CommonSecurityLog, SecurityEvent, Syslog, WindowsEvent" -ForegroundColor Cyan
        Write-Host "DCR Mode: DCE-based (creates DCEs)" -ForegroundColor Blue
        Write-Host ""
        
        $exportCribl = -not $SkipCriblExport
        & $ScriptPath -CustomTableMode:$false -CreateDCE -ShowCriblConfig:$ShowCriblConfig -ExportCriblConfig:$exportCribl -SkipCriblExport:$SkipCriblExport
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
        & $ScriptPath -CustomTableMode -CustomTableListFile "CustomTableList.json" -CreateDCE -ShowCriblConfig:$ShowCriblConfig -ExportCriblConfig:$exportCribl -SkipCriblExport:$SkipCriblExport
    }
    
    "DCEBoth" {
        Write-Host "`n🚀 Processing ALL Tables with DCE-based DCRs..." -ForegroundColor Magenta
        Write-Host "="*50 -ForegroundColor Magenta
        Write-Host "DCR Mode: DCE-based (creates DCEs)" -ForegroundColor Blue
        
        Write-Host "`n📌 Step 1: Processing Native Tables with DCE-based DCRs..." -ForegroundColor Yellow
        $exportCribl = -not $SkipCriblExport
        & $ScriptPath -CustomTableMode:$false -CreateDCE -ShowCriblConfig:$ShowCriblConfig -ExportCriblConfig:$exportCribl -SkipCriblExport:$SkipCriblExport
        
        Write-Host "`n📌 Step 2: Processing Custom Tables with DCE-based DCRs..." -ForegroundColor Yellow
        & $ScriptPath -CustomTableMode -CustomTableListFile "CustomTableList.json" -CreateDCE -ShowCriblConfig:$ShowCriblConfig -ExportCriblConfig:$exportCribl -SkipCriblExport:$SkipCriblExport
        
        Write-Host "`n✅ Completed processing all tables with DCE-based DCRs!" -ForegroundColor Green
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
        
        # First, load metadata from generated templates
        $templatesPath = Join-Path $PSScriptRoot "generated-templates"
        $templateMetadata = @{}
        
        if (Test-Path $templatesPath) {
            Write-Host "Loading metadata from templates..." -ForegroundColor Yellow
            $templateFiles = Get-ChildItem -Path $templatesPath -Filter "*-latest.json" -File
            
            foreach ($templateFile in $templateFiles) {
                try {
                    $template = Get-Content $templateFile.FullName | ConvertFrom-Json
                    if ($template.metadata -and $template.metadata.streamName) {
                        # Extract table name from filename (format: TableName-latest.json)
                        $tableNameFromFile = $templateFile.Name -replace '-latest\.json$', ''
                        
                        # Store metadata by table name for easier lookup
                        $templateMetadata[$tableNameFromFile] = @{
                            StreamName = $template.metadata.streamName
                            TableName = $template.metadata.tableName
                            OutputStreamName = $template.metadata.outputStreamName
                            DeploymentMode = $template.metadata.deploymentMode
                        }
                        
                        Write-Host "  Loaded metadata for table: $tableNameFromFile" -ForegroundColor Gray
                    }
                } catch {
                    Write-Warning "  Could not load template: $($templateFile.Name)"
                }
            }
            Write-Host "  Loaded metadata for $($templateMetadata.Count) templates" -ForegroundColor Green
        } else {
            Write-Warning "No generated-templates directory found. Stream/Table names may be missing."
        }
        
        # Get all DCRs from Azure
        Write-Host "`nRetrieving DCRs from Azure..." -ForegroundColor Yellow
        $allDCRs = Get-AzDataCollectionRule -ResourceGroupName $ResourceGroupName
        
        # Filter by prefix if specified
        if ($DCRPrefix) {
            $allDCRs = $allDCRs | Where-Object { $_.Name -like "$DCRPrefix*" }
        }
        
        Write-Host "Found $($allDCRs.Count) DCR(s)" -ForegroundColor Green
        
        # Collect configurations
        $criblConfigs = @()
        foreach ($dcr in $allDCRs) {
            Write-Host "  Processing: $($dcr.Name)" -ForegroundColor Gray
            
            $config = @{
                DCRName = $dcr.Name
                DCRImmutableId = $dcr.ImmutableId
                StreamName = ""
                TableName = ""
                IngestionEndpoint = ""
                Type = if ($dcr.Kind -eq "Direct") { "Direct" } else { "DCE-based" }
            }
            
            # Try to extract table name from DCR name first
            # Format is typically: dcr-jp-TableName-eastus
            $tableNameFromDCR = ""
            $nameParts = $dcr.Name -split '-'
            
            if ($nameParts.Count -ge 4) {
                # For dcr-jp-TableName-eastus format
                # Index 0 = dcr, 1 = jp, 2 = TableName, 3 = eastus
                $tableNameFromDCR = $nameParts[2]
            }
            
            Write-Host "    Extracted table name from DCR: $tableNameFromDCR" -ForegroundColor DarkGray
            
            # Get stream and table names from template metadata if available
            $foundMetadata = $false
            foreach ($templateTableName in $templateMetadata.Keys) {
                # Check if this template matches the DCR (case-insensitive)
                if ($templateTableName -ieq $tableNameFromDCR) {
                    $metadata = $templateMetadata[$templateTableName]
                    $config.StreamName = $metadata.StreamName
                    $config.TableName = $metadata.TableName
                    Write-Host "    ✓ Using template metadata for streams/tables" -ForegroundColor Green
                    Write-Host "      Table: $($config.TableName), Stream: $($config.StreamName)" -ForegroundColor Gray
                    $foundMetadata = $true
                    break
                }
            }
            
            if (-not $foundMetadata) {
                # Fallback: use extracted table name
                if ($tableNameFromDCR) {
                    # Handle special cases
                    if ($tableNameFromDCR -eq "CloudFlare") {
                        $config.TableName = "CloudFlare_CL"
                        $config.StreamName = "Custom-CloudFlare_CL"
                    } else {
                        $config.TableName = $tableNameFromDCR
                        $config.StreamName = "Custom-$tableNameFromDCR"
                    }
                    Write-Host "    ⚠ Inferred from DCR name - Table: $($config.TableName), Stream: $($config.StreamName)" -ForegroundColor Yellow
                } else {
                    Write-Host "    ❌ Could not determine stream/table names" -ForegroundColor Red
                }
            }
            
            # Get ingestion endpoint
            if ($dcr.Kind -eq "Direct") {
                $location = $dcr.Location.Replace(' ', '').ToLower()
                $config.IngestionEndpoint = "https://${location}.ingest.monitor.azure.com"
            } else {
                # Try to get DCE endpoint
                $dceId = $null
                if ($dcr.DataCollectionEndpointId) {
                    $dceId = $dcr.DataCollectionEndpointId
                } elseif ($dcr.Properties -and $dcr.Properties.DataCollectionEndpointId) {
                    $dceId = $dcr.Properties.DataCollectionEndpointId
                } elseif ($dcr.PSObject.Properties['dataCollectionEndpointId']) {
                    $dceId = $dcr.PSObject.Properties['dataCollectionEndpointId'].Value
                }
                
                if ($dceId) {
                    $dceRG = $dceId -split '/' | Select-Object -Index 4
                    $dceName = $dceId -split '/' | Select-Object -Last 1
                    try {
                        Write-Host "    Retrieving DCE: $dceName" -ForegroundColor DarkGray
                        $dce = Get-AzDataCollectionEndpoint -ResourceGroupName $dceRG -Name $dceName -ErrorAction Stop
                        
                        # Try to extract the actual ingestion endpoint
                        $endpoint = $null
                        
                        # The property is LogIngestionEndpoint (no 's' after Log)
                        if ($dce.LogIngestionEndpoint) {
                            $endpoint = $dce.LogIngestionEndpoint
                        } 
                        # Check in Properties (unlikely but check anyway)
                        elseif ($dce.Properties) {
                            if ($dce.Properties.LogIngestionEndpoint) {
                                $endpoint = $dce.Properties.LogIngestionEndpoint
                            } elseif ($dce.Properties.logIngestionEndpoint) {
                                $endpoint = $dce.Properties.logIngestionEndpoint  
                            }
                        }
                        # Check via PSObject for the correct property name
                        if (-not $endpoint) {
                            $propNames = @('LogIngestionEndpoint', 'logIngestionEndpoint')
                            foreach ($prop in $propNames) {
                                if ($dce.PSObject.Properties[$prop] -and $dce.PSObject.Properties[$prop].Value) {
                                    $endpoint = $dce.PSObject.Properties[$prop].Value
                                    break
                                }
                            }
                        }
                        # Last resort: parse from JSON
                        if (-not $endpoint) {
                            try {
                                $dceJson = $dce | ConvertTo-Json -Depth 10 | ConvertFrom-Json
                                if ($dceJson.properties.logsIngestion.endpoint) {
                                    $endpoint = $dceJson.properties.logsIngestion.endpoint
                                }
                            } catch {}
                        }
                        
                        if ($endpoint) {
                            $config.IngestionEndpoint = $endpoint
                            Write-Host "      ✓ Endpoint: $endpoint" -ForegroundColor Green
                        } else {
                            Write-Host "      ⚠ Could not extract endpoint from DCE" -ForegroundColor Yellow
                            $config.IngestionEndpoint = "[NEEDS MANUAL CONFIGURATION]"
                        }
                    } catch {
                        Write-Host "      ⚠ Could not retrieve DCE: $($_.Exception.Message)" -ForegroundColor Yellow
                        $config.IngestionEndpoint = "[DCE RETRIEVAL FAILED]"
                    }
                } else {
                    Write-Host "    ⚠ No DCE ID found" -ForegroundColor Yellow
                }
                
                # Final fallback if still no endpoint
                if (-not $config.IngestionEndpoint) {
                    $location = $dcr.Location.Replace(' ', '').ToLower()
                    $config.IngestionEndpoint = "https://${location}.ingest.monitor.azure.com"
                }
            }
            
            $criblConfigs += $config
        }
        
        # Save configuration
        $criblConfigDir = Join-Path $PSScriptRoot "cribl-dcr-configs"
        if (-not (Test-Path $criblConfigDir)) {
            New-Item -ItemType Directory -Path $criblConfigDir -Force | Out-Null
            Write-Host "  Created directory: cribl-dcr-configs" -ForegroundColor Gray
        }
        
        # Create timestamped backup if file exists
        $exportPath = Join-Path $criblConfigDir "cribl-dcr-config.json"
        if (Test-Path $exportPath) {
            $timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
            $backupPath = Join-Path $criblConfigDir "cribl-dcr-config.backup.$timestamp.json"
            Copy-Item $exportPath $backupPath
            Write-Host "  Created backup: cribl-dcr-config.backup.$timestamp.json" -ForegroundColor Gray
        }
        $exportData = @{
            GeneratedAt = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
            Purpose = "Cribl Stream Integration with Azure Log Analytics"
            ResourceGroup = $ResourceGroupName
            Workspace = $WorkspaceName
            DCRCount = $criblConfigs.Count
            DCRs = $criblConfigs | Sort-Object DCRName
        }
        
        $exportData | ConvertTo-Json -Depth 10 | Set-Content $exportPath
        Write-Host "`n✅ Cribl configuration collected and saved to: cribl-dcr-configs\cribl-dcr-config.json" -ForegroundColor Green
        Write-Host "   Total DCRs: $($criblConfigs.Count)" -ForegroundColor Gray
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
            Write-Host ""
            
            # Validation checks
            $nullEndpoints = @($config.DCRs | Where-Object { -not $_.IngestionEndpoint })
            $emptyStreams = @($config.DCRs | Where-Object { -not $_.StreamName })
            $emptyTables = @($config.DCRs | Where-Object { -not $_.TableName })
            
            Write-Host "Validation Results:" -ForegroundColor Cyan
            
            if ($config.DCRCount -gt 1) {
                Write-Host "  ✅ Multiple DCRs captured: $($config.DCRCount)" -ForegroundColor Green
            } else {
                Write-Host "  ⚠️  Only 1 DCR captured (expected more?)" -ForegroundColor Yellow
            }
            
            if ($nullEndpoints.Count -eq 0) {
                Write-Host "  ✅ All ingestion endpoints present" -ForegroundColor Green
            } else {
                Write-Host "  ❌ Missing endpoints: $($nullEndpoints.Count) DCR(s)" -ForegroundColor Red
                $nullEndpoints | ForEach-Object { Write-Host "     - $($_.DCRName)" -ForegroundColor Gray }
            }
            
            if ($emptyStreams.Count -eq 0) {
                Write-Host "  ✅ All stream names present" -ForegroundColor Green
            } else {
                Write-Host "  ❌ Missing stream names: $($emptyStreams.Count) DCR(s)" -ForegroundColor Red
                $emptyStreams | ForEach-Object { Write-Host "     - $($_.DCRName)" -ForegroundColor Gray }
            }
            
            if ($emptyTables.Count -eq 0) {
                Write-Host "  ✅ All table names present" -ForegroundColor Green
            } else {
                Write-Host "  ❌ Missing table names: $($emptyTables.Count) DCR(s)" -ForegroundColor Red
                $emptyTables | ForEach-Object { Write-Host "     - $($_.DCRName)" -ForegroundColor Gray }
            }
            
            if ($ShowCriblConfig) {
                Write-Host "`nDetailed Configuration:" -ForegroundColor Magenta
                $config.DCRs | ForEach-Object {
                    Write-Host "`n  📌 $($_.DCRName)" -ForegroundColor White
                    Write-Host "     Type: $($_.Type)" -ForegroundColor Gray
                    Write-Host "     Table: $($_.TableName)" -ForegroundColor Gray
                    Write-Host "     Stream: $($_.StreamName)" -ForegroundColor Gray
                    Write-Host "     Endpoint: $($_.IngestionEndpoint)" -ForegroundColor Gray
                    Write-Host "     Immutable ID: $($_.DCRImmutableId)" -ForegroundColor DarkGray
                }
            }
        } else {
            Write-Host "❌ No cribl-dcr-config.json file found!" -ForegroundColor Red
            Write-Host ""
            Write-Host "Create one by:" -ForegroundColor Yellow
            Write-Host "  1. Running deployment: .\Run-DCRAutomation.ps1 -Mode DirectBoth" -ForegroundColor Gray
            Write-Host "  2. Or collecting from existing: .\Run-DCRAutomation.ps1 -Mode CollectCribl" -ForegroundColor Gray
        }
    }
    
    "ResetCribl" {
        Write-Host "`n🔄 Reset Cribl Configuration" -ForegroundColor Cyan
        Write-Host "="*50 -ForegroundColor Cyan
        
        $criblConfigDir = Join-Path $PSScriptRoot "cribl-dcr-configs"
        $configPath = Join-Path $criblConfigDir "cribl-dcr-config.json"
        
        if (Test-Path $configPath) {
            # Create backup
            $backupPath = Join-Path $criblConfigDir "cribl-dcr-config.backup.$(Get-Date -Format 'yyyyMMdd-HHmmss').json"
            Copy-Item $configPath $backupPath
            Write-Host "✅ Configuration backed up to: $(Split-Path $backupPath -Leaf)" -ForegroundColor Green
            
            # Remove original
            Remove-Item $configPath -Force
            Write-Host "✅ Cribl configuration file reset!" -ForegroundColor Green
            Write-Host "   Next deployment will create a fresh configuration" -ForegroundColor Gray
        } else {
            Write-Host "ℹ️  No existing configuration file to reset" -ForegroundColor Cyan
        }
    }
    
    "TemplateOnly" {
        $dcrModeParam = ""
        $dcrModeDisplay = Get-DCRModeStatus
        
        # Apply DCRMode override if specified
        if ($DCRMode -eq "Direct") {
            $dcrModeParam = Set-DCRModeParameter -UseDCE $false
            $dcrModeDisplay = "Direct (override)"
        } elseif ($DCRMode -eq "DCE") {
            $dcrModeParam = Set-DCRModeParameter -UseDCE $true
            $dcrModeDisplay = "DCE-based (override)"
        }
        
        Write-Host "`n📝 Generating Templates Only (No Deployment)..." -ForegroundColor Cyan
        Write-Host "="*50 -ForegroundColor Cyan
        Write-Host "DCR Mode: $dcrModeDisplay" -ForegroundColor Cyan
        
        # Generate templates for native tables
        Write-Host "`n📌 Generating Native Table Templates..." -ForegroundColor Yellow
        if ($dcrModeParam) {
            & $ScriptPath -CustomTableMode:$false -TemplateOnly $dcrModeParam
        } else {
            & $ScriptPath -CustomTableMode:$false -TemplateOnly
        }
        
        # Generate templates for custom tables
        Write-Host "`n📌 Generating Custom Table Templates..." -ForegroundColor Yellow
        if ($dcrModeParam) {
            & $ScriptPath -CustomTableMode -CustomTableListFile "CustomTableList.json" -TemplateOnly $dcrModeParam
        } else {
            & $ScriptPath -CustomTableMode -CustomTableListFile "CustomTableList.json" -TemplateOnly
        }
        
        Write-Host "`n✅ Templates generated in: generated-templates\" -ForegroundColor Green
        Write-Host "DCR Template Type: $dcrModeDisplay" -ForegroundColor Cyan
    }
}

# Check if Cribl config was exported (default behavior)
$criblConfigPath = Join-Path $PSScriptRoot "cribl-dcr-configs" "cribl-dcr-config.json"
if (-not $SkipCriblExport -and (Test-Path $criblConfigPath)) {
    Write-Host "`n📦 Cribl configuration automatically exported to: cribl-dcr-configs\cribl-dcr-config.json" -ForegroundColor Green
    Write-Host "Use .\Get-CriblDCRInfo.ps1 to retrieve additional DCR information" -ForegroundColor Cyan
    Write-Host "(Use -SkipCriblExport to disable automatic export in future runs)" -ForegroundColor Gray
} elseif ($SkipCriblExport) {
    Write-Host "`n⏭️ Cribl configuration export was skipped" -ForegroundColor Yellow
}

# Clean up temp marker file
$tempMarkerFile = Join-Path $PSScriptRoot ".cribl-collection-in-progress"
if (Test-Path $tempMarkerFile) {
    Remove-Item $tempMarkerFile -Force -ErrorAction SilentlyContinue
}
