# Discover Azure vNet Flow Logs and Generate Cribl Destinations
# This script scans Azure subscriptions for storage accounts containing vNet Flow Log containers
# and generates Cribl destination configurations for each discovered storage account

param(
    [Parameter(Mandatory=$false)]
    [string]$AzureParametersFile = "azure-parameters.json"
)

# Load configuration
$azureParamsPath = Join-Path $PSScriptRoot $AzureParametersFile
if (-not (Test-Path $azureParamsPath)) {
    Write-Host "❌ ERROR: $AzureParametersFile not found!" -ForegroundColor Red
    exit 1
}

$azParams = Get-Content $azureParamsPath | ConvertFrom-Json

# Load Cribl destination template
$templatePath = Join-Path $PSScriptRoot "CriblDestinationExample.json"
if (-not (Test-Path $templatePath)) {
    Write-Host "❌ ERROR: CriblDestinationExample.json template not found!" -ForegroundColor Red
    exit 1
}

$destinationTemplate = Get-Content $templatePath -Raw | ConvertFrom-Json

# Function to prompt user to authenticate
function Request-AzureAuthentication {
    param(
        [string]$TenantId,
        [string]$Reason
    )

    Write-Host "`n$Reason" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Would you like to authenticate now? (Y/N)" -ForegroundColor Cyan
    $response = Read-Host

    if ($response.ToUpper() -eq 'Y') {
        Write-Host "`n🔐 Authenticating to tenant: $TenantId..." -ForegroundColor Cyan
        try {
            Connect-AzAccount -TenantId $TenantId -ErrorAction Stop | Out-Null
            Write-Host "✅ Successfully authenticated!" -ForegroundColor Green
            return $true
        }
        catch {
            Write-Host "❌ Authentication failed: $($_.Exception.Message)" -ForegroundColor Red
            return $false
        }
    }
    else {
        Write-Host "`n❌ Authentication declined. Cannot proceed without authentication." -ForegroundColor Red
        return $false
    }
}

# Function to verify Azure connection and ensure correct tenant
function Ensure-AzureConnection {
    param(
        [string]$RequiredTenantId,
        [switch]$AllowPrompt
    )

    try {
        $context = Get-AzContext -ErrorAction SilentlyContinue

        if (-not $context) {
            Write-Host "  ℹ️  No active Azure session found." -ForegroundColor Yellow

            if ($AllowPrompt) {
                return Request-AzureAuthentication -TenantId $RequiredTenantId -Reason "You need to authenticate to Azure tenant: $RequiredTenantId"
            }
            else {
                Write-Host "  ❌ No Azure context found." -ForegroundColor Red
                Write-Host "  Please run: Connect-AzAccount -TenantId $RequiredTenantId" -ForegroundColor Yellow
                return $false
            }
        }

        # Check if we're in the correct tenant
        if ($context.Tenant.Id -ne $RequiredTenantId) {
            Write-Host "  ⚠️  Connected to wrong tenant!" -ForegroundColor Yellow
            Write-Host "     Current Tenant: $($context.Tenant.Id)" -ForegroundColor Gray
            Write-Host "     Required Tenant: $RequiredTenantId" -ForegroundColor Gray

            if ($AllowPrompt) {
                Write-Host ""
                return Request-AzureAuthentication -TenantId $RequiredTenantId -Reason "You need to switch to the correct tenant."
            }
            else {
                Write-Host ""
                Write-Host "  Please reconnect to the correct tenant:" -ForegroundColor Yellow
                Write-Host "  Connect-AzAccount -TenantId $RequiredTenantId" -ForegroundColor Cyan
                return $false
            }
        }

        # Test if the token is still valid
        try {
            $testResult = Get-AzSubscription -TenantId $RequiredTenantId -ErrorAction Stop -WarningAction SilentlyContinue | Select-Object -First 1
            Write-Host "  ✅ Azure connection verified (Tenant: $RequiredTenantId)" -ForegroundColor Green
            return $true
        }
        catch {
            Write-Host "  ⚠️  Azure session expired or invalid." -ForegroundColor Yellow

            if ($AllowPrompt) {
                return Request-AzureAuthentication -TenantId $RequiredTenantId -Reason "Your Azure session has expired."
            }
            else {
                Write-Host "  ❌ Azure session expired or invalid." -ForegroundColor Red
                Write-Host "  Please reconnect: Connect-AzAccount -TenantId $RequiredTenantId" -ForegroundColor Yellow
                return $false
            }
        }

    } catch {
        Write-Host "  ❌ Failed to verify Azure connection: $($_.Exception.Message)" -ForegroundColor Red
        return $false
    }
}

# Function to discover vNet Flow Log storage accounts
function Find-vNetFlowLogStorageAccounts {
    param(
        [string]$TenantId
    )

    Write-Host "`n🔍 Discovering vNet Flow Log Storage Accounts..." -ForegroundColor Cyan
    Write-Host "$('='*70)" -ForegroundColor Cyan

    # Get all subscriptions in the specified tenant
    $subscriptions = Get-AzSubscription -TenantId $TenantId -WarningAction SilentlyContinue
    Write-Host "`n📋 Found $($subscriptions.Count) subscription(s) to scan in tenant $TenantId" -ForegroundColor Yellow

    $discoveredAccounts = @()
    $containerName = "insights-logs-flowlogflowevent"

    foreach ($sub in $subscriptions) {
        Write-Host "`n📦 Scanning subscription: $($sub.Name) ($($sub.Id))" -ForegroundColor Cyan

        # Set subscription context
        Set-AzContext -SubscriptionId $sub.Id -WarningAction SilentlyContinue | Out-Null

        # Get all storage accounts in subscription
        $storageAccounts = Get-AzStorageAccount -WarningAction SilentlyContinue

        if ($storageAccounts.Count -eq 0) {
            Write-Host "   ℹ️  No storage accounts found in this subscription" -ForegroundColor DarkGray
            continue
        }

        Write-Host "   Found $($storageAccounts.Count) storage account(s) to check" -ForegroundColor Gray

        foreach ($storageAccount in $storageAccounts) {
            Write-Host "   Checking: $($storageAccount.StorageAccountName)..." -ForegroundColor Gray -NoNewline

            try {
                # Get storage account context
                $ctx = $storageAccount.Context

                # Check if the vNet Flow Log container exists
                $container = Get-AzStorageContainer -Name $containerName -Context $ctx -ErrorAction SilentlyContinue

                if ($container) {
                    Write-Host " ✅ Found vNet Flow Logs!" -ForegroundColor Green

                    $discoveredAccounts += [PSCustomObject]@{
                        SubscriptionId = $sub.Id
                        SubscriptionName = $sub.Name
                        StorageAccountName = $storageAccount.StorageAccountName
                        ResourceGroupName = $storageAccount.ResourceGroupName
                        Location = $storageAccount.Location
                        ContainerName = $containerName
                    }
                } else {
                    Write-Host " ⏭️  No Flow Logs" -ForegroundColor DarkGray
                }
            }
            catch {
                Write-Host " ⚠️  Error checking: $($_.Exception.Message)" -ForegroundColor Yellow
            }
        }
    }

    return $discoveredAccounts
}

# Function to generate Cribl destination configuration
function New-CriblDestination {
    param(
        [PSCustomObject]$StorageAccount,
        [PSCustomObject]$Template,
        [string]$TenantId,
        [string]$ClientId
    )

    # Clone the template
    $destination = $Template | ConvertTo-Json -Depth 100 | ConvertFrom-Json

    # Generate a unique ID for the destination
    $destinationId = "Azure_vNet_FlowLogs_$($StorageAccount.StorageAccountName)"

    # Update destination properties
    $destination.id = $destinationId

    # Update collector configuration
    $destination.collector.conf.storageAccountName = $StorageAccount.StorageAccountName
    $destination.collector.conf.containerName = $StorageAccount.ContainerName
    $destination.collector.conf.tenantId = $TenantId
    $destination.collector.conf.clientId = $ClientId

    # Note: textSecret and clientTextSecret are preserved from the template
    # They reference the Cribl secret name (e.g., "Azure_vNet_Flowlogs_Secret")
    # Do not overwrite these values - they come from CriblDestinationExample.json

    return $destination
}

# Main execution
Write-Host "`n$('='*70)" -ForegroundColor Cyan
Write-Host "  AZURE vNET FLOW LOG DISCOVERY & CRIBL DESTINATION GENERATOR" -ForegroundColor White
Write-Host "$('='*70)" -ForegroundColor Cyan

# Verify Azure connection to the correct tenant
Write-Host "`n🔐 Verifying Azure connection to tenant $($azParams.tenantId)..." -ForegroundColor Cyan
if (-not (Ensure-AzureConnection -RequiredTenantId $azParams.tenantId -AllowPrompt)) {
    Write-Host "`n❌ Cannot proceed without authentication." -ForegroundColor Red
    exit 1
}

# Discover storage accounts with vNet Flow Logs
$discoveredAccounts = Find-vNetFlowLogStorageAccounts -TenantId $azParams.tenantId

# Display summary
Write-Host "`n$('='*70)" -ForegroundColor Cyan
Write-Host "📊 DISCOVERY SUMMARY" -ForegroundColor White
Write-Host "$('='*70)" -ForegroundColor Cyan

if ($discoveredAccounts.Count -eq 0) {
    Write-Host "`n⚠️  No storage accounts with vNet Flow Logs were found." -ForegroundColor Yellow
    Write-Host "   Container searched: insights-logs-flowlogflowevent" -ForegroundColor Gray
    exit 0
}

Write-Host "`n✅ Found $($discoveredAccounts.Count) storage account(s) with vNet Flow Logs" -ForegroundColor Green
Write-Host ""

foreach ($account in $discoveredAccounts) {
    Write-Host "   📦 $($account.StorageAccountName)" -ForegroundColor Cyan
    Write-Host "      Subscription: $($account.SubscriptionName)" -ForegroundColor Gray
    Write-Host "      Resource Group: $($account.ResourceGroupName)" -ForegroundColor Gray
    Write-Host "      Location: $($account.Location)" -ForegroundColor Gray
    Write-Host ""
}

# Generate Cribl destinations
Write-Host "`n🔧 Generating Cribl Destination Configurations..." -ForegroundColor Cyan
Write-Host "$('='*70)" -ForegroundColor Cyan

# Create output directory
$outputDir = Join-Path $PSScriptRoot "cribl-destinations"
if (-not (Test-Path $outputDir)) {
    New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
}

$generatedDestinations = @()

foreach ($account in $discoveredAccounts) {
    Write-Host "`n📝 Generating destination for: $($account.StorageAccountName)" -ForegroundColor Cyan

    # Generate destination configuration
    $destination = New-CriblDestination `
        -StorageAccount $account `
        -Template $destinationTemplate `
        -TenantId $azParams.tenantId `
        -ClientId $azParams.clientId

    # Save destination to file
    $filename = "Azure_vNet_FlowLogs_$($account.StorageAccountName).json"
    $filepath = Join-Path $outputDir $filename

    $destination | ConvertTo-Json -Depth 100 | Set-Content -Path $filepath -Force

    Write-Host "   ✅ Saved: $filename" -ForegroundColor Green

    $generatedDestinations += [PSCustomObject]@{
        StorageAccount = $account.StorageAccountName
        DestinationId = $destination.id
        FilePath = $filepath
        SubscriptionName = $account.SubscriptionName
    }
}

# Create summary JSON
$summary = @{
    GeneratedAt = (Get-Date -Format "yyyy-MM-dd HH:mm:ss")
    TenantId = $azParams.tenantId
    ClientId = $azParams.clientId
    DiscoveredCount = $discoveredAccounts.Count
    StorageAccounts = @($discoveredAccounts | ForEach-Object {
        @{
            SubscriptionName = $_.SubscriptionName
            SubscriptionId = $_.SubscriptionId
            StorageAccountName = $_.StorageAccountName
            ResourceGroupName = $_.ResourceGroupName
            Location = $_.Location
            ContainerName = $_.ContainerName
        }
    })
    Destinations = @($generatedDestinations | ForEach-Object {
        @{
            StorageAccount = $_.StorageAccount
            DestinationId = $_.DestinationId
            SubscriptionName = $_.SubscriptionName
        }
    })
}

$summaryPath = Join-Path $outputDir "discovery-summary.json"
$summary | ConvertTo-Json -Depth 100 | Set-Content -Path $summaryPath -Force

# Final summary
Write-Host "`n$('='*70)" -ForegroundColor Green
Write-Host "✅ CRIBL DESTINATION GENERATION COMPLETE" -ForegroundColor White
Write-Host "$('='*70)" -ForegroundColor Green

Write-Host "`n📦 Generated Files:" -ForegroundColor Cyan
Write-Host "   Output Directory: $outputDir" -ForegroundColor Gray
Write-Host "   Destination Files: $($generatedDestinations.Count)" -ForegroundColor Gray
Write-Host "   Summary File: discovery-summary.json" -ForegroundColor Gray

Write-Host "`n📋 Generated Destinations:" -ForegroundColor Cyan
foreach ($dest in $generatedDestinations) {
    Write-Host "   ✅ $($dest.DestinationId)" -ForegroundColor Green
    Write-Host "      Storage Account: $($dest.StorageAccount)" -ForegroundColor Gray
    Write-Host "      Subscription: $($dest.SubscriptionName)" -ForegroundColor Gray
}

Write-Host "`n⚠️  IMPORTANT - REQUIRED PERMISSIONS" -ForegroundColor Yellow
Write-Host "$('='*70)" -ForegroundColor Yellow
Write-Host ""
Write-Host "Before using these Cribl destinations, ensure your App Registration has:" -ForegroundColor White
Write-Host ""
Write-Host "  🔑 'Storage Blob Data Reader' role" -ForegroundColor Cyan
Write-Host "     assigned to EACH storage account listed above" -ForegroundColor Gray
Write-Host ""
Write-Host "Without this permission, Cribl will not be able to read the vNet Flow Logs." -ForegroundColor Yellow
Write-Host ""
Write-Host "To assign this role:" -ForegroundColor White
Write-Host "  1. Navigate to each Storage Account in the Azure Portal" -ForegroundColor Gray
Write-Host "  2. Go to 'Access Control (IAM)'" -ForegroundColor Gray
Write-Host "  3. Click 'Add role assignment'" -ForegroundColor Gray
Write-Host "  4. Select 'Storage Blob Data Reader' role" -ForegroundColor Gray
Write-Host "  5. Assign it to your App Registration (Client ID: $($azParams.clientId))" -ForegroundColor Gray
Write-Host "$('='*70)" -ForegroundColor Yellow

Write-Host "`n📝 Next Steps:" -ForegroundColor Cyan
Write-Host "  1. Create the Cribl secret referenced in destinations (e.g., '$($destinationTemplate.collector.conf.textSecret)')" -ForegroundColor Gray
Write-Host "     with your Azure App Registration client secret" -ForegroundColor Gray
Write-Host "  2. Import the destination configurations into Cribl Stream" -ForegroundColor Gray
Write-Host "  3. Verify the Storage Blob Data Reader permissions are assigned" -ForegroundColor Gray
Write-Host "  4. Test the destinations in Cribl Stream" -ForegroundColor Gray

Write-Host "`n✨ Discovery and generation complete!" -ForegroundColor Green
Write-Host ""
