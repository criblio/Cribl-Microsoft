# Create Azure Data Collection Rules for Native Tables
# Run this script from VSCode terminal or PowerShell
# This script will process all DCR template files in the dcr-templates directory

param(
    [Parameter(Mandatory=$false)]
    [string]$ParametersFile = "parameters.json",
    
    [Parameter(Mandatory=$false)]
    [string]$TemplatesDirectory = "dcr-templates",
    
    [Parameter(Mandatory=$false)]
    [string]$SpecificDCR = ""
)

# Get the directory where this script is located
$ScriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Definition

# Build full paths
$FullParametersPath = Join-Path $ScriptDirectory $ParametersFile
$FullTemplatesPath = Join-Path $ScriptDirectory $TemplatesDirectory

Write-Host "Starting Azure Data Collection Rules deployment process..." -ForegroundColor Cyan
Write-Host "Script directory: $ScriptDirectory" -ForegroundColor Gray
Write-Host "Templates directory: $FullTemplatesPath" -ForegroundColor Gray

# Load parameters from JSON file
Write-Host "Loading parameters from: $FullParametersPath" -ForegroundColor Yellow
try {
    if (!(Test-Path $FullParametersPath)) {
        throw "Parameters file not found: $FullParametersPath"
    }
    $parameters = Get-Content $FullParametersPath | ConvertFrom-Json
    Write-Host "Parameters loaded successfully" -ForegroundColor Green
} catch {
    Write-Error "Failed to load parameters: $($_.Exception.Message)"
    exit 1
}

# Get all JSON template files from the templates directory
Write-Host "Scanning for DCR template files..." -ForegroundColor Yellow
try {
    if (!(Test-Path $FullTemplatesPath)) {
        throw "Templates directory not found: $FullTemplatesPath"
    }
    
    $templateFiles = Get-ChildItem -Path $FullTemplatesPath -Filter "*.json" | Where-Object { !$_.PSIsContainer }
    
    if ($SpecificDCR) {
        $templateFiles = $templateFiles | Where-Object { $_.BaseName -eq $SpecificDCR }
        if ($templateFiles.Count -eq 0) {
            throw "No template file found for DCR: $SpecificDCR"
        }
        Write-Host "Processing specific DCR: $SpecificDCR" -ForegroundColor Green
    } else {
        Write-Host "Found $($templateFiles.Count) DCR template files" -ForegroundColor Green
    }
    
    if ($templateFiles.Count -eq 0) {
        throw "No JSON template files found in: $FullTemplatesPath"
    }
    
} catch {
    Write-Error "Failed to scan template files: $($_.Exception.Message)"
    exit 1
}

# Extract parameters
$ResourceGroupName = $parameters.resourceGroupName
$WorkspaceName = $parameters.workspaceName
$DCRPrefix = $parameters.dcrPrefix
$DCRSuffix = $parameters.dcrSuffix
$Location = $parameters.location

Write-Host "Global Configuration:" -ForegroundColor White
Write-Host "  Resource Group: $ResourceGroupName" -ForegroundColor Gray
Write-Host "  Workspace: $WorkspaceName" -ForegroundColor Gray
Write-Host "  DCR Prefix: $DCRPrefix" -ForegroundColor Gray
if (![string]::IsNullOrWhiteSpace($DCRSuffix)) {
    Write-Host "  DCR Suffix: $DCRSuffix" -ForegroundColor Gray
}
Write-Host "  Location: $Location" -ForegroundColor Gray

# Install required modules
Write-Host "Checking and installing required PowerShell modules..." -ForegroundColor Yellow
try {
    $requiredModules = @("Az.OperationalInsights", "Az.Monitor", "Az.Resources")
    foreach ($module in $requiredModules) {
        if (!(Get-Module -ListAvailable $module)) {
            Install-Module -Name $module -Repository PSGallery -Force -AllowClobber -Scope CurrentUser
            Write-Host "$module module installed" -ForegroundColor Green
        } else {
            Write-Host "$module module already installed" -ForegroundColor Green
        }
    }
} catch {
    Write-Error "Failed to install modules: $($_.Exception.Message)"
    exit 1
}

# Login to Azure
Write-Host "Logging into Azure..." -ForegroundColor Yellow
try {
    $context = Get-AzContext
    if (!$context) {
        Connect-AzAccount
        Write-Host "Successfully logged into Azure" -ForegroundColor Green
    } else {
        Write-Host "Already logged into Azure as: $($context.Account.Id)" -ForegroundColor Green
    }
} catch {
    Write-Error "Failed to login to Azure: $($_.Exception.Message)"
    exit 1
}

# Verify workspace exists and get workspace resource ID
Write-Host "Verifying Log Analytics workspace..." -ForegroundColor Yellow
try {
    $workspace = Get-AzOperationalInsightsWorkspace -ResourceGroupName $ResourceGroupName -Name $WorkspaceName -ErrorAction Stop
    Write-Host "Workspace found: $($workspace.Name)" -ForegroundColor Green
    $workspaceResourceId = $workspace.ResourceId
    Write-Host "Workspace ID: $workspaceResourceId" -ForegroundColor Gray
} catch {
    Write-Error "Workspace not found: $($_.Exception.Message)"
    exit 1
}

# Initialize summary tracking
$summary = @{
    DCRsProcessed = 0
    DCRsCreated = 0
    DCRsExisted = 0
    DCRsUpdated = 0
    Errors = @()
}

# Process each DCR template file
Write-Host "`n" + "="*80 -ForegroundColor Cyan
Write-Host "PROCESSING DCR TEMPLATES" -ForegroundColor Cyan
Write-Host "="*80 -ForegroundColor Cyan

foreach ($templateFile in $templateFiles) {
    $summary.DCRsProcessed++
    
    Write-Host "`n--- Processing: $($templateFile.Name) ---" -ForegroundColor Yellow
    
    try {
        # Extract DCR name from filename (remove .json extension)
        $tableName = $templateFile.BaseName
        
        # Build DCR name using naming convention
        $DCRName = "${DCRPrefix}${tableName}-${Location}"
        if (![string]::IsNullOrWhiteSpace($DCRSuffix)) {
            $DCRName = "${DCRName}-${DCRSuffix}"
        }
        
        Write-Host "  Template: $($templateFile.Name)" -ForegroundColor White
        Write-Host "  DCR Name: $DCRName" -ForegroundColor White
        Write-Host "  Target Table: Microsoft-$tableName" -ForegroundColor White
        
        # Check if DCR already exists
        $dcrExists = $false
        try {
            $existingDCR = Get-AzDataCollectionRule -ResourceGroupName $ResourceGroupName -Name $DCRName -ErrorAction SilentlyContinue
            if ($existingDCR) {
                Write-Host "  ✓ DCR already exists - skipping creation" -ForegroundColor Yellow
                $dcrExists = $true
                $summary.DCRsExisted++
            }
        } catch {
            # DCR doesn't exist, will create
        }
        
        # Deploy DCR if it doesn't exist
        if (-not $dcrExists) {
            Write-Host "  Deploying DCR..." -ForegroundColor Cyan
            
            # Create deployment name
            $deploymentName = "dcr-deployment-$(Get-Date -Format 'yyyyMMdd-HHmmss')-$tableName"
            
            # Deploy using ARM template
            $deploymentResult = New-AzResourceGroupDeployment `
                -ResourceGroupName $ResourceGroupName `
                -Name $deploymentName `
                -TemplateFile $templateFile.FullName `
                -dataCollectionRuleName $DCRName `
                -location $Location `
                -workspaceResourceId $workspaceResourceId `
                -ErrorAction Stop
            
            if ($deploymentResult.ProvisioningState -eq "Succeeded") {
                Write-Host "  ✅ DCR deployed successfully!" -ForegroundColor Green
                $summary.DCRsCreated++
                
                # Display deployment outputs if available
                if ($deploymentResult.Outputs -and $deploymentResult.Outputs.dataCollectionRuleId) {
                    $dcrId = $deploymentResult.Outputs.dataCollectionRuleId.Value
                    Write-Host "  DCR Resource ID: $dcrId" -ForegroundColor Gray
                }
            } else {
                throw "Deployment failed with state: $($deploymentResult.ProvisioningState)"
            }
        }
        
        Write-Host "  ✅ Completed: $($templateFile.Name)" -ForegroundColor Green
        
    } catch {
        $errorMsg = "Error processing $($templateFile.Name): $($_.Exception.Message)"
        Write-Host "  ❌ $errorMsg" -ForegroundColor Red
        $summary.Errors += $errorMsg
    }
}

# Display final summary
Write-Host "`n" + "="*80 -ForegroundColor Cyan
Write-Host "EXECUTION SUMMARY" -ForegroundColor Cyan
Write-Host "="*80 -ForegroundColor Cyan

Write-Host "Data Collection Rules:" -ForegroundColor White
Write-Host "  Processed: $($summary.DCRsProcessed)" -ForegroundColor Gray
Write-Host "  Created: $($summary.DCRsCreated)" -ForegroundColor Green
Write-Host "  Already Existed: $($summary.DCRsExisted)" -ForegroundColor Yellow

if ($summary.Errors.Count -gt 0) {
    Write-Host "Errors:" -ForegroundColor Red
    foreach ($error in $summary.Errors) {
        Write-Host "  - $error" -ForegroundColor Red
    }
} else {
    Write-Host "Errors: None" -ForegroundColor Green
}

Write-Host "`nScript completed! 🎉" -ForegroundColor Cyan

# Usage examples:
# .\Create-NativeTableDCRs.ps1                                # Process all templates
# .\Create-NativeTableDCRs.ps1 -SpecificDCR "SecurityEvent"   # Process only SecurityEvent template
# .\Create-NativeTableDCRs.ps1 -ParametersFile "prod-params.json" # Use custom parameters file