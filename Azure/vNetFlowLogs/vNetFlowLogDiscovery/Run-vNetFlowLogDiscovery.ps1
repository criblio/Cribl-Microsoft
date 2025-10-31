# vNet Flow Log Discovery and Cribl Destination Generator
# This script discovers Azure Storage Accounts containing vNet Flow Logs and generates Cribl destination configurations

param(
 [Parameter(Mandatory=$false)]
 [switch]$NonInteractive
)

# Get script directory
$ScriptPath = Join-Path $PSScriptRoot "Discover-vNetFlowLogs.ps1"

# Function to validate azure-parameters.json configuration
function Test-AzureParametersConfiguration {
 $azureParamsFile = Join-Path $PSScriptRoot "azure-parameters.json"

 if (-not (Test-Path $azureParamsFile)) {
 Write-Host "`n ERROR: azure-parameters.json file not found!" -ForegroundColor Red
 Write-Host " Please ensure the file exists in the script directory." -ForegroundColor Yellow
 return $false
 }

 try {
 $azParams = Get-Content $azureParamsFile | ConvertFrom-Json
 } catch {
 Write-Host "`n ERROR: azure-parameters.json is not valid JSON!" -ForegroundColor Red
 Write-Host " Error: $($_.Exception.Message)" -ForegroundColor Yellow
 return $false
 }

 # Define required fields and their default placeholder values
 $requiredFields = @{
 "tenantId" = @("<YOUR-TENANT-ID-HERE>", "your-tenant-id", "")
 "clientId" = @("<YOUR-CLIENT-ID-HERE>", "your-app-client-id", "your-client-id", "")
 }

 $missingFields = @()
 $defaultFields = @()

 foreach ($field in $requiredFields.Keys) {
 $value = $azParams.$field

 if (-not $value -or [string]::IsNullOrWhiteSpace($value)) {
 $missingFields += $field
 } elseif ($requiredFields[$field] -contains $value) {
 $defaultFields += $field
 }
 }

 if ($missingFields.Count -gt 0 -or $defaultFields.Count -gt 0) {
 Write-Host "`n CONFIGURATION REQUIRED" -ForegroundColor Yellow
 Write-Host "$('='*60)" -ForegroundColor Yellow
 Write-Host "The azure-parameters.json file needs to be updated before proceeding." -ForegroundColor White
 Write-Host ""

 if ($missingFields.Count -gt 0) {
 Write-Host " Missing required fields:" -ForegroundColor Red
 foreach ($field in $missingFields) {
 Write-Host " - $field" -ForegroundColor Red
 }
 Write-Host ""
 }

 if ($defaultFields.Count -gt 0) {
 Write-Host " Fields still have default/placeholder values:" -ForegroundColor Yellow
 foreach ($field in $defaultFields) {
 $currentValue = $azParams.$field
 Write-Host " - $field`: '$currentValue'" -ForegroundColor Yellow
 }
 Write-Host ""
 }

 Write-Host " Please update the following fields in azure-parameters.json:" -ForegroundColor Cyan
 Write-Host " • tenantId: Your Azure tenant ID (GUID)" -ForegroundColor Gray
 Write-Host " • clientId: Your Azure app registration client ID (GUID)" -ForegroundColor Gray
 Write-Host ""
 Write-Host " Note: Client secret will be set to '<replace me>' in Cribl destinations for manual configuration." -ForegroundColor DarkGray
 Write-Host "$('='*60)" -ForegroundColor Yellow

 return $false
 }

 return $true
}

# Function to wait for configuration update
function Wait-ForConfigurationUpdate {
 Write-Host "`n CONFIGURATION UPDATE REQUIRED" -ForegroundColor Cyan
 Write-Host "$('-'*50)" -ForegroundColor Gray
 Write-Host "Please edit the azure-parameters.json file with your Azure details." -ForegroundColor White
 Write-Host ""
 Write-Host "You can:" -ForegroundColor Yellow
 Write-Host "1. Open azure-parameters.json in your preferred editor" -ForegroundColor Gray
 Write-Host "2. Update the required fields listed above" -ForegroundColor Gray
 Write-Host "3. Save the file" -ForegroundColor Gray
 Write-Host "4. Return here and press Enter to continue" -ForegroundColor Gray
 Write-Host ""

 do {
 $continue = Read-Host "Press Enter after updating azure-parameters.json (or 'q' to quit)"

 if ($continue.ToLower() -eq 'q') {
 Write-Host "`nExiting... Please update azure-parameters.json and run the script again." -ForegroundColor Yellow
 exit 0
 }

 Write-Host "`n Checking configuration..." -ForegroundColor Cyan

 if (Test-AzureParametersConfiguration) {
 Write-Host " Configuration validated successfully!" -ForegroundColor Green
 Write-Host ""
 Start-Sleep -Seconds 1
 return $true
 } else {
 Write-Host "`n Configuration still needs updates. Please check the fields above." -ForegroundColor Red
 Write-Host ""
 }

 } while ($true)
}

# Function to display the main menu
function Show-MainMenu {
 Clear-Host
 Write-Host "`n$('='*70)" -ForegroundColor Cyan
 Write-Host " AZURE vNET FLOW LOG DISCOVERY & CRIBL DESTINATION GENERATOR" -ForegroundColor White
 Write-Host "$('='*70)" -ForegroundColor Cyan

 # Display current configuration (validated)
 $azParams = Get-Content (Join-Path $PSScriptRoot "azure-parameters.json") | ConvertFrom-Json
 Write-Host "`n Current Configuration:" -ForegroundColor Cyan
 Write-Host " Tenant ID: $($azParams.tenantId)" -ForegroundColor Gray
 Write-Host " Client ID: $($azParams.clientId)" -ForegroundColor Gray

 Write-Host "`n OPTIONS:" -ForegroundColor Yellow
 Write-Host ""
 Write-Host " [1] Discover vNet Flow Logs and Generate Cribl Destinations" -ForegroundColor Green
 Write-Host " Scan all subscriptions for vNet Flow Log storage containers" -ForegroundColor Gray
 Write-Host " Generate Cribl destination configurations" -ForegroundColor Gray
 Write-Host " $('-'*66)" -ForegroundColor DarkGray
 Write-Host " [Q] Quit" -ForegroundColor Red
 Write-Host "$('='*70)" -ForegroundColor Cyan
}

# Function to confirm discovery
function Confirm-Discovery {
 Write-Host "`n DISCOVERY CONFIRMATION" -ForegroundColor Yellow
 Write-Host "$('-'*40)" -ForegroundColor Gray
 Write-Host "This will:" -ForegroundColor White
 Write-Host " • Scan all Azure subscriptions" -ForegroundColor Gray
 Write-Host " • Discover storage accounts with vNet Flow Logs" -ForegroundColor Gray
 Write-Host " • Generate Cribl destination configurations" -ForegroundColor Gray
 Write-Host "$('-'*40)" -ForegroundColor Gray

 $confirm = Read-Host "`nProceed with discovery? (Y/N)"
 return $confirm.ToUpper() -eq 'Y'
}

# Function to wait for user to continue
function Wait-ForUser {
 Write-Host "`nPress any key to continue..." -ForegroundColor Yellow
 $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
}

# Main script logic
if ($NonInteractive) {
 # Non-interactive mode - execute and exit
 if (-not (Test-AzureParametersConfiguration)) {
 Write-Host "`n Configuration validation failed in non-interactive mode!" -ForegroundColor Red
 Write-Host "Please update azure-parameters.json with valid values before running in non-interactive mode." -ForegroundColor Yellow
 exit 1
 }

 Write-Host "`n Starting vNet Flow Log Discovery..." -ForegroundColor Green
 & $ScriptPath
} else {
 # Interactive menu mode
 $continue = $true

 # Validate configuration before showing menu
 Write-Host "`n Validating azure-parameters.json configuration..." -ForegroundColor Cyan
 if (-not (Test-AzureParametersConfiguration)) {
 # Configuration needs updates - wait for user to fix it
 if (-not (Wait-ForConfigurationUpdate)) {
 Write-Host "`nExiting due to configuration issues." -ForegroundColor Red
 exit 1
 }
 } else {
 Write-Host " Configuration validated successfully!" -ForegroundColor Green
 Start-Sleep -Seconds 1
 }

 while ($continue) {
 Show-MainMenu
 $choice = Read-Host "`nSelect an option"

 switch ($choice.ToUpper()) {
 "1" {
 if (Confirm-Discovery) {
 Write-Host "`n Starting vNet Flow Log Discovery..." -ForegroundColor Green
 & $ScriptPath
 Write-Host "`n Discovery complete!" -ForegroundColor Green
 } else {
 Write-Host "`nDiscovery cancelled." -ForegroundColor Yellow
 }
 Wait-ForUser
 }
 "Q" {
 Write-Host "`n Exiting vNet Flow Log Discovery Tool. Goodbye!" -ForegroundColor Cyan
 $continue = $false
 }
 default {
 Write-Host "`n Invalid choice. Please select 1 or Q to quit." -ForegroundColor Red
 Start-Sleep -Seconds 2
 }
 }
 }
}

Write-Host "`n vNet Flow Log Discovery Complete!" -ForegroundColor Green
Write-Host ""
