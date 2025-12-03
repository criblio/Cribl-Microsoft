# Cribl-Integration.ps1
# Generates Cribl Stream configurations for Unified Azure Lab resources

# Function to generate Log Analytics Workspace collector configuration
function Generate-WorkspaceCollector {
 param(
 [Parameter(Mandatory=$true)]
 [object]$Workspace,

 [Parameter(Mandatory=$true)]
 [PSCustomObject]$AzureParams
 )

 $config = @{
 type = "azure_log_analytics"
 id = "workspace-collector-$($AzureParams.baseObjectName)"
 disabled = $false
 workspaceId = $Workspace.CustomerId.Guid
 workspaceName = $Workspace.Name
 authentication = @{
 type = "servicePrincipal"
 tenantId = $AzureParams.authentication.tenantId
 clientId = $AzureParams.authentication.clientId
 clientSecret = "`${C.secrets.azureClientSecret}"
 }
 queries = @(
 @{
 name = "SecurityEvents"
 query = "SecurityEvent | where TimeGenerated > ago(5m)"
 schedule = "*/5 * * * *"
 },
 @{
 name = "AzureActivity"
 query = "AzureActivity | where TimeGenerated > ago(5m)"
 schedule = "*/5 * * * *"
 },
 @{
 name = "SigninLogs"
 query = "SigninLogs | where TimeGenerated > ago(5m)"
 schedule = "*/5 * * * *"
 },
 @{
 name = "AuditLogs"
 query = "AuditLogs | where TimeGenerated > ago(5m)"
 schedule = "*/5 * * * *"
 }
 )
 }

 return $config
}

# Function to generate Blob Storage collector configuration
function Generate-BlobCollector {
 param(
 [Parameter(Mandatory=$true)]
 [object]$StorageAccount,

 [Parameter(Mandatory=$true)]
 [PSCustomObject]$AzureParams,

 [Parameter(Mandatory=$true)]
 [string]$ResourceGroupName
 )

 # Get storage account key
 $storageKey = (Get-AzStorageAccountKey -ResourceGroupName $ResourceGroupName -Name $StorageAccount.StorageAccountName)[0].Value

 $config = @{
 type = "azure_blob"
 id = "blob-collector-$($AzureParams.baseObjectName)"
 disabled = $false
 storageAccount = $StorageAccount.StorageAccountName
 authentication = @{
 type = "sharedKey"
 accountKey = "`${C.secrets.azureStorageKey}"
 }
 containers = @(
 @{
 name = "logs"
 pathExpression = "*.json"
 recursive = $true
 maxBatchSize = 1048576
 },
 @{
 name = "insights-logs-flowlogs"
 pathExpression = "**/*.json"
 recursive = $true
 maxBatchSize = 1048576
 parser = "json"
 },
 @{
 name = "eventhub-capture"
 pathExpression = "**/*.avro"
 recursive = $true
 maxBatchSize = 1048576
 parser = "avro"
 },
 @{
 name = "adx-ingestion"
 pathExpression = "*.json"
 recursive = $true
 maxBatchSize = 1048576
 }
 )
 }

 return $config
}

# Function to generate Event Hub source configuration
function Generate-EventHubSource {
 param(
 [Parameter(Mandatory=$true)]
 [object]$Namespace,

 [Parameter(Mandatory=$true)]
 [PSCustomObject]$AzureParams,

 [Parameter(Mandatory=$true)]
 [string]$ResourceGroupName
 )

 # Get connection strings for each hub
 $hubs = @()

 foreach ($hubKey in $AzureParams.analytics.eventHub.hubs.PSObject.Properties.Name) {
 $hubConfig = $AzureParams.analytics.eventHub.hubs.$hubKey
 $hubName = $hubConfig.name

 # Get shared access policy connection string
 $authRule = Get-AzEventHubAuthorizationRule `
 -ResourceGroupName $ResourceGroupName `
 -Namespace $Namespace.Name `
 -EventHub $hubName `
 -ErrorAction SilentlyContinue | Select-Object -First 1

 if ($null -eq $authRule) {
 # Try namespace-level policy
 $authRule = Get-AzEventHubAuthorizationRule `
 -ResourceGroupName $ResourceGroupName `
 -Namespace $Namespace.Name `
 -ErrorAction SilentlyContinue | Select-Object -First 1
 }

 $hubEntry = @{
 name = $hubName
 eventHub = $hubName
 namespace = $Namespace.Name
 consumerGroup = "cribl"
 connectionString = if ($authRule) { "`${C.secrets.eventHub_$($hubName)_connectionString}" } else { "CONFIGURE_MANUALLY" }
 checkpointStorage = @{
 type = "azureBlob"
 storageAccount = "`${C.secrets.checkpointStorageAccount}"
 containerName = "cribl-checkpoints"
 }
 }

 $hubs += $hubEntry
 }

 $config = @{
 type = "azure_event_hub"
 id = "eventhub-source-$($AzureParams.baseObjectName)"
 disabled = $false
 hubs = $hubs
 }

 return $config
}

# Function to generate Storage Queue source configuration
function Generate-QueueSource {
 param(
 [Parameter(Mandatory=$true)]
 [object]$StorageAccount,

 [Parameter(Mandatory=$true)]
 [PSCustomObject]$AzureParams,

 [Parameter(Mandatory=$true)]
 [string]$ResourceGroupName
 )

 # Get storage account key
 $storageKey = (Get-AzStorageAccountKey -ResourceGroupName $ResourceGroupName -Name $StorageAccount.StorageAccountName)[0].Value

 $queues = @()

 foreach ($queueKey in $AzureParams.storage.queues.PSObject.Properties.Name) {
 $queueConfig = $AzureParams.storage.queues.$queueKey

 $queueEntry = @{
 name = $queueConfig.name
 queueName = $queueConfig.name
 storageAccount = $StorageAccount.StorageAccountName
 connectionString = "`${C.secrets.azureStorageConnectionString}"
 visibilityTimeout = 30
 maxMessages = 32
 deleteAfterRead = $true
 }

 $queues += $queueEntry
 }

 $config = @{
 type = "azure_queue"
 id = "queue-source-$($AzureParams.baseObjectName)"
 disabled = $false
 queues = $queues
 }

 return $config
}

# Function to generate Flow Log collector configuration
function Generate-FlowLogCollector {
 param(
 [Parameter(Mandatory=$true)]
 [object]$StorageAccount,

 [Parameter(Mandatory=$true)]
 [PSCustomObject]$AzureParams,

 [Parameter(Mandatory=$true)]
 [string]$ResourceGroupName
 )

 # Get storage account key
 $storageKey = (Get-AzStorageAccountKey -ResourceGroupName $ResourceGroupName -Name $StorageAccount.StorageAccountName)[0].Value

 $config = @{
 type = "azure_blob"
 id = "flowlog-collector-$($AzureParams.baseObjectName)"
 disabled = $false
 storageAccount = $StorageAccount.StorageAccountName
 authentication = @{
 type = "sharedKey"
 accountKey = "`${C.secrets.azureStorageKey}"
 }
 containers = @(
 @{
 name = "insights-logs-flowlogs"
 pathExpression = "resourceId=/**/*.json"
 recursive = $true
 maxBatchSize = 1048576
 parser = "json"
 parserSettings = @{
 flatten = $true
 flattenPrefix = ""
 extractRecords = $true
 recordPath = "records"
 }
 }
 )
 description = "VNet Flow Logs collector - Automatically discovers and ingests flow logs from all VNets"
 }

 return $config
}

# Function to generate ADX destination configuration
function Generate-ADXDestination {
 param(
 [Parameter(Mandatory=$true)]
 [object]$Cluster,

 [Parameter(Mandatory=$true)]
 [object]$Database,

 [Parameter(Mandatory=$true)]
 [PSCustomObject]$AzureParams
 )

 $config = @{
 type = "azure_data_explorer"
 id = "adx-destination-$($AzureParams.baseObjectName)"
 disabled = $false
 clusterUri = $Cluster.Uri
 database = $Database.Name
 authentication = @{
 type = "servicePrincipal"
 tenantId = $AzureParams.authentication.tenantId
 clientId = $AzureParams.authentication.clientId
 clientSecret = "`${C.secrets.azureClientSecret}"
 }
 tableMappings = @(
 @{
 sourcePath = "logs.*"
 destinationTable = "CriblLogs"
 format = "json"
 },
 @{
 sourcePath = "flowlogs.*"
 destinationTable = "FlowLogs"
 format = "json"
 },
 @{
 sourcePath = "metrics.*"
 destinationTable = "EventHubMetrics"
 format = "json"
 }
 )
 ingestionSettings = @{
 batchSize = 1000
 batchTimeout = 60
 compression = "gzip"
 }
 }

 return $config
}

# Function to save configuration to JSON file
function Save-CriblConfiguration {
 param(
 [Parameter(Mandatory=$true)]
 [hashtable]$Config,

 [Parameter(Mandatory=$true)]
 [string]$OutputPath,

 [Parameter(Mandatory=$true)]
 [string]$FileName
 )

 try {
 # Ensure output directory exists
 if (-not (Test-Path $OutputPath)) {
 New-Item -Path $OutputPath -ItemType Directory -Force | Out-Null
 }

 $filePath = Join-Path $OutputPath $FileName

 # Convert to JSON with proper formatting
 $json = $Config | ConvertTo-Json -Depth 10

 # Save to file
 $json | Out-File -FilePath $filePath -Encoding utf8 -Force

 Write-LabSuccess "Saved: $FileName"

 return $filePath

 } catch {
 Write-LabError "Failed to save: $FileName"
 Write-LabError "$($_.Exception.Message)"
 return $null
 }
}

# Function to generate all Cribl configurations
function Export-CriblConfigurations {
 param(
 [Parameter(Mandatory=$true)]
 [PSCustomObject]$AzureParams,

 [Parameter(Mandatory=$true)]
 [string]$ResourceGroupName,

 [Parameter(Mandatory=$true)]
 [hashtable]$ResourceNames,

 [Parameter(Mandatory=$true)]
 [string]$OutputPath
 )

 Write-Host "`n$('=' * 80)" -ForegroundColor Cyan
 Write-Host "GENERATING CRIBL STREAM CONFIGURATIONS" -ForegroundColor White
 Write-Host "$('=' * 80)" -ForegroundColor Cyan

 $generatedConfigs = @()

 # Log Analytics Workspace
 $workspace = Get-AzOperationalInsightsWorkspace -ResourceGroupName $ResourceGroupName -Name $ResourceNames.LogAnalytics -ErrorAction SilentlyContinue
 if ($null -ne $workspace) {
 Write-Host "`n Generating Log Analytics Workspace collector..." -ForegroundColor Yellow
 $workspaceConfig = Generate-WorkspaceCollector -Workspace $workspace -AzureParams $AzureParams
 $path = Save-CriblConfiguration -Config $workspaceConfig -OutputPath $OutputPath -FileName "workspace-collector.json"
 if ($path) { $generatedConfigs += $path }
 }

 # Storage Account
 $storageAccount = Get-AzStorageAccount -ResourceGroupName $ResourceGroupName -Name $ResourceNames.StorageAccount -ErrorAction SilentlyContinue
 if ($null -ne $storageAccount) {
 Write-Host "`n Generating Blob Storage collector..." -ForegroundColor Yellow
 $blobConfig = Generate-BlobCollector -StorageAccount $storageAccount -AzureParams $AzureParams -ResourceGroupName $ResourceGroupName
 $path = Save-CriblConfiguration -Config $blobConfig -OutputPath $OutputPath -FileName "blob-collector.json"
 if ($path) { $generatedConfigs += $path }

 Write-Host "`n Generating Flow Log collector..." -ForegroundColor Yellow
 $flowLogConfig = Generate-FlowLogCollector -StorageAccount $storageAccount -AzureParams $AzureParams -ResourceGroupName $ResourceGroupName
 $path = Save-CriblConfiguration -Config $flowLogConfig -OutputPath $OutputPath -FileName "flowlog-collector.json"
 if ($path) { $generatedConfigs += $path }

 Write-Host "`n Generating Storage Queue source..." -ForegroundColor Yellow
 $queueConfig = Generate-QueueSource -StorageAccount $storageAccount -AzureParams $AzureParams -ResourceGroupName $ResourceGroupName
 $path = Save-CriblConfiguration -Config $queueConfig -OutputPath $OutputPath -FileName "queue-source.json"
 if ($path) { $generatedConfigs += $path }
 }

 # Event Hub Namespace
 $namespace = Get-AzEventHubNamespace -ResourceGroupName $ResourceGroupName -Name $ResourceNames.EventHubNamespace -ErrorAction SilentlyContinue
 if ($null -ne $namespace) {
 Write-Host "`n Generating Event Hub source..." -ForegroundColor Yellow
 $eventHubConfig = Generate-EventHubSource -Namespace $namespace -AzureParams $AzureParams -ResourceGroupName $ResourceGroupName
 $path = Save-CriblConfiguration -Config $eventHubConfig -OutputPath $OutputPath -FileName "eventhub-source.json"
 if ($path) { $generatedConfigs += $path }
 }

 # ADX Cluster
 $cluster = Get-AzKustoCluster -ResourceGroupName $ResourceGroupName -Name $ResourceNames.ADXCluster -ErrorAction SilentlyContinue
 if ($null -ne $cluster) {
 $database = Get-AzKustoDatabase -ResourceGroupName $ResourceGroupName -ClusterName $cluster.Name -ErrorAction SilentlyContinue | Select-Object -First 1

 if ($null -ne $database) {
 Write-Host "`n Generating ADX destination..." -ForegroundColor Yellow
 $adxConfig = Generate-ADXDestination -Cluster $cluster -Database $database -AzureParams $AzureParams
 $path = Save-CriblConfiguration -Config $adxConfig -OutputPath $OutputPath -FileName "adx-destination.json"
 if ($path) { $generatedConfigs += $path }
 }
 }

 # Generate master configuration file
 Write-Host "`n Generating master configuration..." -ForegroundColor Yellow

 $masterConfig = @{
 labName = "UnifiedAzureLab"
 baseObjectName = $AzureParams.baseObjectName
 resourceGroup = $ResourceGroupName
 location = $AzureParams.location
 generatedAt = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ssZ")
 configurations = $generatedConfigs | ForEach-Object { Split-Path $_ -Leaf }
 secrets = @{
 required = @(
 @{
 name = "azureClientSecret"
 description = "Azure AD Service Principal Client Secret"
 },
 @{
 name = "azureStorageKey"
 description = "Azure Storage Account Access Key"
 },
 @{
 name = "azureStorageConnectionString"
 description = "Azure Storage Account Connection String"
 }
 )
 optional = @(
 @{
 name = "checkpointStorageAccount"
 description = "Storage account for Event Hub checkpoints (defaults to main storage)"
 }
 )
 }
 instructions = @{
 steps = @(
 "1. Import configuration files into Cribl Stream",
 "2. Configure secrets in Cribl Stream > Settings > Secrets",
 "3. Update authentication settings (Tenant ID, Client ID)",
 "4. Enable desired sources and destinations",
 "5. Test connectivity and data flow"
 )
 }
 }

 $path = Save-CriblConfiguration -Config $masterConfig -OutputPath $OutputPath -FileName "cribl-master-config.json"
 if ($path) { $generatedConfigs += $path }

 Write-Host "`n$('=' * 80)" -ForegroundColor Green
 Write-Host "CRIBL CONFIGURATION GENERATION COMPLETE" -ForegroundColor White
 Write-Host "$('=' * 80)" -ForegroundColor Green
 Write-Host "`n Generated $($generatedConfigs.Count) configuration files" -ForegroundColor Green
 Write-LabInfo "Output directory: $OutputPath"

 Write-Host "`n Next Steps:" -ForegroundColor Yellow
 Write-LabVerbose " 1. Review generated configurations in: $OutputPath"
 Write-LabVerbose " 2. Import configurations into Cribl Stream"
 Write-LabVerbose " 3. Configure secrets (Client Secret, Storage Keys)"
 Write-LabVerbose " 4. Test connectivity to Azure resources"

 return $generatedConfigs
}

# ============================================================================
# STANDALONE EXECUTION BLOCK
# This block runs only when the script is executed directly (not dot-sourced)
# ============================================================================

# Check if script is being dot-sourced or run directly
$isStandalone = $MyInvocation.InvocationName -ne '.' -and $MyInvocation.Line -notmatch '^\s*\.\s+'

if ($isStandalone) {
 param(
 [Parameter(Mandatory=$false)]
 [PSCustomObject]$AzureParams,

 [Parameter(Mandatory=$false)]
 [string]$ResourceGroupName,

 [Parameter(Mandatory=$false)]
 [hashtable]$ResourceNames,

 [Parameter(Mandatory=$false)]
 [switch]$SkipWait
 )

 # Script root directory
 $scriptRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
 $corePath = Join-Path $scriptRoot "Core"

 # Load parameters if not provided
 if ($null -eq $AzureParams) {
 Write-LabVerbose "`n Loading azure-parameters.json..."
 $azureParamsPath = Join-Path $scriptRoot "azure-parameters.json"

 if (-not (Test-Path $azureParamsPath)) {
 Write-LabError "ERROR: azure-parameters.json not found at: $azureParamsPath"
 exit 1
 }

 $AzureParams = Get-Content -Path $azureParamsPath -Raw | ConvertFrom-Json
 }

 # Get Resource Group name
 if ([string]::IsNullOrEmpty($ResourceGroupName)) {
 $ResourceGroupName = $AzureParams.resourceGroupName
 }

 Write-Host "`n$('='*80)" -ForegroundColor Cyan
 Write-Host "CRIBL STREAM CONFIGURATION GENERATOR" -ForegroundColor White
 Write-Host "$('='*80)" -ForegroundColor Cyan

 Write-Host "`n Configuration Settings:" -ForegroundColor Yellow
 Write-LabVerbose " Resource Group: $ResourceGroupName"
 Write-LabVerbose " Base Name: $($AzureParams.baseObjectName)"
 Write-LabVerbose " Location: $($AzureParams.location)"

 # Verify resource group exists
 Write-Host "`n Verifying Resource Group..." -ForegroundColor Yellow
 $rg = Get-AzResourceGroup -Name $ResourceGroupName -ErrorAction SilentlyContinue
 if ($null -eq $rg) {
 Write-LabError "ERROR: Resource Group '$ResourceGroupName' not found"
 Write-Host " Please deploy the lab infrastructure first" -ForegroundColor Yellow
 exit 1
 }
 Write-LabSuccess "Resource Group verified"

 # Load Naming Engine to get resource names
 Write-Host "`n Loading resource names..." -ForegroundColor Yellow
 $namingEngineScript = Join-Path $corePath "Naming-Engine.ps1"
 if (-not (Test-Path $namingEngineScript)) {
 Write-LabError "ERROR: Naming-Engine.ps1 not found"
 exit 1
 }

 . $namingEngineScript

 if ($null -eq $ResourceNames) {
 $ResourceNames = Get-ResourceNames -AzureParams $AzureParams
 }

 Write-LabSuccess "Resource names loaded"

 # Check what resources are deployed
 Write-Host "`n Discovering deployed resources..." -ForegroundColor Yellow

 $deployedResources = @{
 LogAnalytics = $null
 StorageAccount = $null
 EventHubNamespace = $null
 ADXCluster = $null
 }

 # Check Log Analytics Workspace
 $workspace = Get-AzOperationalInsightsWorkspace -ResourceGroupName $ResourceGroupName -Name $ResourceNames.LogAnalytics -ErrorAction SilentlyContinue
 if ($null -ne $workspace) {
 Write-LabSuccess "Found: Log Analytics Workspace"
 $deployedResources.LogAnalytics = $workspace
 } else {
 Write-LabVerbose "Not found: Log Analytics Workspace"
 }

 # Check Storage Account
 $storageAccount = Get-AzStorageAccount -ResourceGroupName $ResourceGroupName -Name $ResourceNames.StorageAccount -ErrorAction SilentlyContinue
 if ($null -ne $storageAccount) {
 Write-LabSuccess "Found: Storage Account"
 $deployedResources.StorageAccount = $storageAccount
 } else {
 Write-LabVerbose "Not found: Storage Account"
 }

 # Check Event Hub Namespace
 $namespace = Get-AzEventHubNamespace -ResourceGroupName $ResourceGroupName -Name $ResourceNames.EventHubNamespace -ErrorAction SilentlyContinue
 if ($null -ne $namespace) {
 Write-LabSuccess "Found: Event Hub Namespace"
 $deployedResources.EventHubNamespace = $namespace
 } else {
 Write-LabVerbose "Not found: Event Hub Namespace"
 }

 # Check ADX Cluster
 $cluster = Get-AzKustoCluster -ResourceGroupName $ResourceGroupName -Name $ResourceNames.ADXCluster -ErrorAction SilentlyContinue
 if ($null -ne $cluster) {
 Write-LabSuccess "Found: ADX Cluster"
 $deployedResources.ADXCluster = $cluster
 } else {
 Write-LabVerbose "Not found: ADX Cluster"
 }

 # Count deployed resources
 $deployedCount = ($deployedResources.Values | Where-Object { $null -ne $_ }).Count

 if ($deployedCount -eq 0) {
 Write-Host "`n WARNING: No Azure resources found!" -ForegroundColor Yellow
 Write-Host " Please deploy lab infrastructure before generating Cribl configurations" -ForegroundColor Yellow
 exit 1
 }

 Write-Host "`n Total deployed resources: $deployedCount" -ForegroundColor Cyan

 # Flow log waiting mechanism (if storage account exists and not skipping wait)
 if ($null -ne $deployedResources.StorageAccount -and -not $SkipWait) {
 Write-Host "`n Checking for VNet Flow Logs..." -ForegroundColor Yellow

 $storageKey = (Get-AzStorageAccountKey -ResourceGroupName $ResourceGroupName -Name $storageAccount.StorageAccountName)[0].Value
 $storageContext = New-AzStorageContext -StorageAccountName $storageAccount.StorageAccountName -StorageAccountKey $storageKey
 $containerName = "insights-logs-flowlogflowevent"

 $container = Get-AzStorageContainer -Name $containerName -Context $storageContext -ErrorAction SilentlyContinue

 if ($null -eq $container) {
 Write-Host " Flow log container not found" -ForegroundColor Yellow
 Write-LabInfo "NOTICE: Flow logs typically take 5-10 minutes to start after infrastructure deployment"
 Write-LabVerbose " You can:"
 Write-LabVerbose " 1. Wait and re-run this script later"
 Write-LabVerbose " 2. Continue now (configs will be generated without flow log path discovery)"

 $response = Read-Host "`n Continue without flow logs? (Y/N) [Y]"
 if ($response -eq "N" -or $response -eq "n") {
 Write-Host "`n Exiting - re-run this script after flow logs are available" -ForegroundColor Yellow
 exit 0
 }
 } else {
 Write-LabSuccess "Flow log container found"
 }
 }

 # Set output directory
 $outputPath = Join-Path $scriptRoot "cribl-configurations"

 # Generate all configurations
 Write-Host ""
 $generatedConfigs = Export-CriblConfigurations `
 -AzureParams $AzureParams `
 -ResourceGroupName $ResourceGroupName `
 -ResourceNames $ResourceNames `
 -OutputPath $outputPath

 # Display summary
 Write-Host "`n$('='*80)" -ForegroundColor Cyan
 Write-Host "GENERATION COMPLETE" -ForegroundColor White
 Write-Host "$('='*80)" -ForegroundColor Cyan

 Write-Host "`n Generated Configurations:" -ForegroundColor Green
 foreach ($config in $generatedConfigs) {
 $fileName = Split-Path $config -Leaf
 Write-Host " $fileName" -ForegroundColor White
 }

 Write-Host "`n Output Directory:" -ForegroundColor Cyan
 Write-Host " $outputPath" -ForegroundColor White

 Write-Host "`n Next Steps:" -ForegroundColor Yellow
 Write-LabVerbose " 1. Review the generated configuration files"
 Write-LabVerbose " 2. Import configurations into Cribl Stream"
 Write-LabVerbose " 3. Configure secrets in Cribl Stream (Settings > Secrets):"
 Write-LabVerbose "- azureClientSecret: Azure AD Service Principal Secret"
 Write-LabVerbose "- azureStorageKey: Storage Account Access Key"
 Write-LabVerbose "- azureStorageConnectionString: Storage Connection String"
 Write-LabVerbose " 4. Update authentication settings (Tenant ID, Client ID)"
 Write-LabVerbose " 5. Enable desired sources and destinations"
 Write-LabVerbose " 6. Test connectivity and data flow"

 Write-Host "`n Documentation:" -ForegroundColor Cyan
 Write-LabVerbose "Cribl Stream Docs: https://docs.cribl.io/stream/"
 Write-LabVerbose "Azure Integration: https://docs.cribl.io/stream/sources-azure-event-hub/"

 Write-Host ""
} else {
 # Functions are available via dot-sourcing
 # No Export-ModuleMember needed for .ps1 script files
}
