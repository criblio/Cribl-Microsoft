# Test-CriblConnection.ps1
# PowerShell script to test Cribl Search API connection with Client Credentials
# 
# Usage:
#   1. Update the configuration variables below or pass as parameters
#   2. Run: .\Test-CriblConnection.ps1
#   3. Review output for any issues

param(
    [string]$CriblInstance = "YOUR_INSTANCE.cribl.cloud",
    [string]$ClientId = "YOUR_CLIENT_ID",
    [string]$ClientSecret = "YOUR_CLIENT_SECRET",
    [string]$Dataset = "YOUR_DATASET",
    [switch]$Verbose
)

# Colors for output
$colors = @{
    Success = "Green"
    Error = "Red"
    Warning = "Yellow"
    Info = "Cyan"
    Detail = "Gray"
}

function Write-Status {
    param(
        [string]$Message,
        [string]$Type = "Info",
        [switch]$NoNewline
    )
    
    $prefix = switch ($Type) {
        "Success" { "✓ " }
        "Error" { "✗ " }
        "Warning" { "⚠ " }
        "Info" { "→ " }
        "Detail" { "  " }
    }
    
    if ($NoNewline) {
        Write-Host "$prefix$Message" -ForegroundColor $colors[$Type] -NoNewline
    } else {
        Write-Host "$prefix$Message" -ForegroundColor $colors[$Type]
    }
}

function Get-CriblBearerToken {
    param(
        [string]$Instance,
        [string]$ClientId,
        [string]$ClientSecret
    )
    
    $tokenUrl = "https://$Instance/api/v1/auth/token"
    $tokenBody = @{
        grant_type = "client_credentials"
        client_id = $ClientId
        client_secret = $ClientSecret
        audience = "https://$Instance"
    } | ConvertTo-Json
    
    try {
        $response = Invoke-RestMethod `
            -Uri $tokenUrl `
            -Method Post `
            -Body $tokenBody `
            -ContentType "application/json" `
            -ErrorAction Stop
        
        return @{
            Success = $true
            Token = $response.access_token
            ExpiresIn = $response.expires_in
            TokenType = $response.token_type
        }
    }
    catch {
        return @{
            Success = $false
            Error = $_
        }
    }
}

function Test-CriblApi {
    param(
        [string]$Endpoint,
        [string]$BearerToken,
        [string]$Method = "GET",
        [object]$Body = $null,
        [string]$Description
    )
    
    $uri = "https://$CriblInstance$Endpoint"
    $headers = @{
        "Authorization" = "Bearer $BearerToken"
        "Content-Type" = "application/json"
    }
    
    Write-Status "Testing: $Description" -Type "Info"
    if ($Verbose) {
        Write-Status "URL: $uri" -Type "Detail"
    }
    
    try {
        $params = @{
            Uri = $uri
            Headers = $headers
            Method = $Method
            ErrorAction = "Stop"
        }
        
        if ($Body) {
            $params.Body = ($Body | ConvertTo-Json -Depth 10)
            if ($Verbose) {
                Write-Status "Body: $($params.Body)" -Type "Detail"
            }
        }
        
        $response = Invoke-RestMethod @params
        Write-Status "Success!" -Type "Success"
        
        return @{
            Success = $true
            Response = $response
        }
    }
    catch {
        Write-Status "Failed: $_" -Type "Error"
        if ($Verbose -and $_.Exception.Response) {
            try {
                $reader = [System.IO.StreamReader]::new($_.Exception.Response.GetResponseStream())
                $errorDetail = $reader.ReadToEnd()
                Write-Status "Error details: $errorDetail" -Type "Detail"
            }
            catch {
                # Ignore errors reading error details
            }
        }
        return @{
            Success = $false
            Error = $_
        }
    }
}

# Main script
Clear-Host
Write-Host "========================================" -ForegroundColor $colors.Info
Write-Host " Cribl Search API Connection Test" -ForegroundColor $colors.Info
Write-Host " (Client Credentials Authentication)" -ForegroundColor $colors.Info
Write-Host "========================================" -ForegroundColor $colors.Info
Write-Host ""

# Display configuration
Write-Host "Configuration:" -ForegroundColor $colors.Info
Write-Status "Instance: $CriblInstance" -Type "Detail"
Write-Status "Client ID: $($ClientId.Substring(0, [Math]::Min(10, $ClientId.Length)))..." -Type "Detail"
Write-Status "Client Secret: ****" -Type "Detail"
Write-Status "Dataset: $Dataset" -Type "Detail"
Write-Host ""

# Test 1: Get Bearer Token
Write-Host "Test 1: Authentication (Client Credentials)" -ForegroundColor $colors.Warning
Write-Status "Exchanging credentials for bearer token..." -Type "Info"

$tokenResult = Get-CriblBearerToken -Instance $CriblInstance -ClientId $ClientId -ClientSecret $ClientSecret

if ($tokenResult.Success) {
    Write-Status "Bearer token obtained successfully!" -Type "Success"
    Write-Status "Token type: $($tokenResult.TokenType)" -Type "Detail"
    Write-Status "Expires in: $($tokenResult.ExpiresIn) seconds" -Type "Detail"
    Write-Status "Token preview: $($tokenResult.Token.Substring(0, [Math]::Min(20, $tokenResult.Token.Length)))..." -Type "Detail"
    $bearerToken = $tokenResult.Token
} else {
    Write-Status "Authentication failed!" -Type "Error"
    Write-Status "Error: $($tokenResult.Error)" -Type "Detail"
    Write-Status "Check your Client ID and Client Secret" -Type "Warning"
    Write-Host ""
    Write-Status "Common issues:" -Type "Info"
    Write-Status "- Incorrect Client ID or Secret" -Type "Detail"
    Write-Status "- Credentials not activated" -Type "Detail"
    Write-Status "- Insufficient permissions" -Type "Detail"
    Write-Status "- Wrong instance URL" -Type "Detail"
    exit 1
}
Write-Host ""

# Test 2: Basic API connectivity
Write-Host "Test 2: API Connectivity" -ForegroundColor $colors.Warning
$sysInfo = Test-CriblApi -Endpoint "/api/v1/system/info" -BearerToken $bearerToken -Description "System information"

if ($sysInfo.Success) {
    Write-Status "Cribl version: $($sysInfo.Response.version)" -Type "Detail"
    if ($sysInfo.Response.instanceId) {
        Write-Status "Instance ID: $($sysInfo.Response.instanceId)" -Type "Detail"
    }
} else {
    Write-Status "Cannot access API with the bearer token" -Type "Error"
    Write-Status "The token was obtained but API calls are failing" -Type "Warning"
    exit 1
}
Write-Host ""

# Test 3: Search API access
Write-Host "Test 3: Search API Access" -ForegroundColor $colors.Warning
$searchInfo = Test-CriblApi -Endpoint "/api/v1/search/datasets" -BearerToken $bearerToken -Description "List datasets"

if ($searchInfo.Success) {
    $datasetCount = $searchInfo.Response.items.Count
    Write-Status "Found $datasetCount dataset(s)" -Type "Detail"
    
    if ($Verbose -and $datasetCount -gt 0) {
        Write-Status "Available datasets:" -Type "Detail"
        foreach ($ds in $searchInfo.Response.items) {
            Write-Status "- $($ds.id)" -Type "Detail"
        }
    }
    
    # Check if specified dataset exists
    $datasetExists = $searchInfo.Response.items.id -contains $Dataset
    if ($datasetExists) {
        Write-Status "Dataset '$Dataset' found" -Type "Success"
    } else {
        Write-Status "Dataset '$Dataset' not found!" -Type "Warning"
        if ($searchInfo.Response.items.Count -gt 0) {
            Write-Status "Available datasets: $($searchInfo.Response.items.id -join ', ')" -Type "Detail"
        }
    }
} else {
    Write-Status "Search API not accessible" -Type "Error"
    Write-Status "Check that your credentials have Search permissions" -Type "Warning"
}
Write-Host ""

# Test 4: Create a test search job
Write-Host "Test 4: Search Job Creation" -ForegroundColor $colors.Warning

$searchQuery = @{
    query = "dataset=`"$Dataset`" | head 10"
    earliest = "-1h"
    latest = "now"
}

$jobResult = Test-CriblApi `
    -Endpoint "/api/v1/search/jobs" `
    -BearerToken $bearerToken `
    -Method "POST" `
    -Body $searchQuery `
    -Description "Create search job"

if ($jobResult.Success) {
    $jobId = $jobResult.Response.id
    Write-Status "Job ID: $jobId" -Type "Detail"
    
    # Wait for job completion
    Write-Status "Waiting for job completion..." -Type "Info" -NoNewline
    
    $maxAttempts = 30
    $attempt = 0
    $jobComplete = $false
    
    while ($attempt -lt $maxAttempts -and -not $jobComplete) {
        Start-Sleep -Seconds 2
        Write-Host "." -NoNewline
        
        $statusResult = Test-CriblApi `
            -Endpoint "/api/v1/search/jobs/$jobId" `
            -BearerToken $bearerToken `
            -Description "Check job status" `
            -Method "GET"
        
        if ($statusResult.Success) {
            $status = $statusResult.Response.status
            if ($status -eq "finished") {
                $jobComplete = $true
                Write-Host ""
                Write-Status "Job completed successfully!" -Type "Success"
                
                # Get results
                Write-Status "Fetching results..." -Type "Info"
                $resultsEndpoint = "/api/v1/search/jobs/$jobId/results"
                $results = Test-CriblApi `
                    -Endpoint $resultsEndpoint `
                    -BearerToken $bearerToken `
                    -Description "Fetch results"
                
                if ($results.Success) {
                    $resultCount = $results.Response.results.Count
                    Write-Status "Retrieved $resultCount result(s)" -Type "Success"
                    
                    if ($Verbose -and $resultCount -gt 0) {
                        Write-Status "Sample result:" -Type "Detail"
                        $results.Response.results[0] | ConvertTo-Json -Depth 3 | Write-Host -ForegroundColor $colors.Detail
                    }
                }
            }
            elseif ($status -eq "failed" -or $status -eq "cancelled") {
                Write-Host ""
                Write-Status "Job $status" -Type "Error"
                if ($statusResult.Response.error) {
                    Write-Status "Error: $($statusResult.Response.error)" -Type "Detail"
                }
                break
            }
        }
        $attempt++
    }
    
    if (-not $jobComplete -and $attempt -eq $maxAttempts) {
        Write-Host ""
        Write-Status "Job did not complete within timeout" -Type "Warning"
    }
}
Write-Host ""

# Test 5: PowerBI specific checks
Write-Host "Test 5: PowerBI Compatibility Checks" -ForegroundColor $colors.Warning

# Check TLS version
Write-Status "Checking TLS support..." -Type "Info"
$tlsVersions = [Net.ServicePointManager]::SecurityProtocol
Write-Status "TLS versions: $tlsVersions" -Type "Detail"

if ($tlsVersions -match "Tls12|Tls13") {
    Write-Status "TLS 1.2+ supported" -Type "Success"
} else {
    Write-Status "TLS 1.2 not enabled. PowerBI may have issues." -Type "Warning"
    Write-Status "Enable with: [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12" -Type "Detail"
}

# Check response times
if ($jobResult.Success) {
    Write-Status "Measuring API response time..." -Type "Info"
    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    
    $testResult = Test-CriblApi -Endpoint "/api/v1/system/info" -BearerToken $bearerToken -Description "Response time test"
    
    $stopwatch.Stop()
    $responseTime = $stopwatch.ElapsedMilliseconds
    
    Write-Status "Response time: ${responseTime}ms" -Type "Detail"
    
    if ($responseTime -lt 1000) {
        Write-Status "Good response time" -Type "Success"
    } elseif ($responseTime -lt 5000) {
        Write-Status "Acceptable response time" -Type "Warning"
    } else {
        Write-Status "Slow response time - may cause PowerBI timeouts" -Type "Warning"
    }
}

Write-Host ""
Write-Host "========================================" -ForegroundColor $colors.Info
Write-Host " Test Summary" -ForegroundColor $colors.Info
Write-Host "========================================" -ForegroundColor $colors.Info

# Generate PowerBI connection string
if ($sysInfo.Success -and $searchInfo.Success) {
    Write-Host ""
    Write-Host "PowerBI Configuration Values:" -ForegroundColor $colors.Success
    Write-Host ""
    Write-Host "Instance:      $CriblInstance" -ForegroundColor $colors.Detail
    Write-Host "Client ID:     $ClientId" -ForegroundColor $colors.Detail
    Write-Host "Client Secret: $ClientSecret" -ForegroundColor $colors.Detail
    Write-Host "Dataset:       $Dataset" -ForegroundColor $colors.Detail
    Write-Host ""
    Write-Host "Copy these values into your PowerBI query!" -ForegroundColor $colors.Info
    
    # Generate sample M query snippet
    $mQuerySnippet = @"

Sample Power Query M snippet:
================================
let
    CriblInstance = "$CriblInstance",
    ClientId = "$ClientId",
    ClientSecret = "$ClientSecret",
    Dataset = "$Dataset",
    
    // Get Bearer Token
    TokenResponse = Json.Document(
        Web.Contents(
            "https://" & CriblInstance & "/api/v1/auth/token",
            [
                Headers = [#"Content-Type" = "application/json"],
                Content = Text.ToBinary(Json.FromValue([
                    grant_type = "client_credentials",
                    client_id = ClientId,
                    client_secret = ClientSecret,
                    audience = "https://" & CriblInstance
                ]))
            ]
        )
    ),
    
    BearerToken = TokenResponse[access_token],
    
    Source = Json.Document(
        Web.Contents(
            "https://" & CriblInstance & "/api/v1/search/jobs",
            [
                Headers = [
                    #"Authorization" = "Bearer " & BearerToken,
                    #"Content-Type" = "application/json"
                ],
                Content = Text.ToBinary("{
                    ""query"": ""dataset='" & Dataset & "' | head 100"",
                    ""earliest"": ""-1h"",
                    ""latest"": ""now""
                }")
            ]
        )
    )
in
    Source
================================
"@
    
    if ($Verbose) {
        Write-Host $mQuerySnippet -ForegroundColor $colors.Detail
    }
    
    Write-Host ""
    Write-Status "Ready for PowerBI integration!" -Type "Success"
} else {
    Write-Status "Fix the issues above before proceeding with PowerBI setup" -Type "Error"
}

Write-Host ""
Write-Host "Test complete. Press any key to exit..." -ForegroundColor $colors.Info
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")