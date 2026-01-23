# Output-Helper.ps1
# Provides logging and console output functionality for Azure Policy Initiative modules

# Global variables for logging - only initialize if not already set
if (-not (Get-Variable -Name PolicyLogFilePath -Scope Global -ErrorAction SilentlyContinue)) {
    $global:PolicyLogFilePath = $null
}
if (-not (Get-Variable -Name PolicyLogToFileEnabled -Scope Global -ErrorAction SilentlyContinue)) {
    $global:PolicyLogToFileEnabled = $false
}
if (-not (Get-Variable -Name PolicyDebugEnabled -Scope Global -ErrorAction SilentlyContinue)) {
    $global:PolicyDebugEnabled = $false
}
if (-not (Get-Variable -Name PolicyErrorCollection -Scope Global -ErrorAction SilentlyContinue)) {
    $global:PolicyErrorCollection = @()
}

#region Console Output Functions

<#
.SYNOPSIS
    Writes a step header to the console
.PARAMETER Message
    The step message to display
.PARAMETER Color
    The foreground color (default: Cyan)
#>
function Write-Step {
    param(
        [Parameter(Mandatory=$true)]
        [string]$Message,
        [string]$Color = "Cyan"
    )
    Write-Host "`n  $Message" -ForegroundColor $Color
}

<#
.SYNOPSIS
    Alias for Write-Step for backward compatibility
#>
function Write-StepHeader {
    param(
        [Parameter(Mandatory=$true)]
        [string]$Message,
        [string]$Color = "Cyan"
    )
    Write-Step -Message $Message -Color $Color
}

<#
.SYNOPSIS
    Writes a sub-step message to the console
.PARAMETER Message
    The sub-step message to display
.PARAMETER Color
    The foreground color (default: Gray)
#>
function Write-SubStep {
    param(
        [Parameter(Mandatory=$true)]
        [string]$Message,
        [string]$Color = "Gray"
    )
    Write-Host "    $Message" -ForegroundColor $Color
}

<#
.SYNOPSIS
    Writes a success message to the console
.PARAMETER Message
    The success message to display
#>
function Write-Success {
    param(
        [Parameter(Mandatory=$true)]
        [string]$Message
    )
    Write-Host "    [OK] $Message" -ForegroundColor Green
}

<#
.SYNOPSIS
    Writes a warning message to the console
.PARAMETER Message
    The warning message to display
.NOTES
    Named Write-WarningMsg to avoid conflict with PowerShell's built-in Write-Warning
#>
function Write-WarningMsg {
    param(
        [Parameter(Mandatory=$true)]
        [string]$Message
    )
    Write-Host "    [!] $Message" -ForegroundColor Yellow
}

<#
.SYNOPSIS
    Writes an error message to the console
.PARAMETER Message
    The error message to display
#>
function Write-ErrorMsg {
    param(
        [Parameter(Mandatory=$true)]
        [string]$Message
    )
    Write-Host "    [X] $Message" -ForegroundColor Red
}

<#
.SYNOPSIS
    Writes an informational message to the console
.PARAMETER Message
    The info message to display
#>
function Write-Info {
    param(
        [Parameter(Mandatory=$true)]
        [string]$Message
    )
    Write-Host "    [i] $Message" -ForegroundColor White
}

#endregion Console Output Functions

#region File Logging Functions

<#
.SYNOPSIS
    Initializes logging to a file
.PARAMETER LogPath
    Full path to the log file
.PARAMETER Append
    Whether to append to existing log file (default: false, overwrites)
.PARAMETER EnableDebug
    Whether to enable debug-level logging (default: false)
#>
function Initialize-PolicyLogging {
    param(
        [Parameter(Mandatory=$true)]
        [string]$LogPath,

        [Parameter(Mandatory=$false)]
        [bool]$Append = $false,

        [Parameter(Mandatory=$false)]
        [bool]$EnableDebug = $false
    )

    try {
        $logDir = Split-Path -Path $LogPath -Parent
        if (-not (Test-Path $logDir)) {
            New-Item -ItemType Directory -Path $logDir -Force | Out-Null
        }

        if (-not $Append) {
            $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
            $debugStatus = if ($EnableDebug) { "ENABLED" } else { "DISABLED" }
            "==============================================================================" | Out-File -FilePath $LogPath -Encoding UTF8
            "Azure Policy Initiative Deployment Log" | Out-File -FilePath $LogPath -Encoding UTF8 -Append
            "Started: $timestamp" | Out-File -FilePath $LogPath -Encoding UTF8 -Append
            "Debug Logging: $debugStatus" | Out-File -FilePath $LogPath -Encoding UTF8 -Append
            "PowerShell Version: $($PSVersionTable.PSVersion)" | Out-File -FilePath $LogPath -Encoding UTF8 -Append
            "OS: $([System.Environment]::OSVersion.VersionString)" | Out-File -FilePath $LogPath -Encoding UTF8 -Append
            "User: $([System.Environment]::UserName)" | Out-File -FilePath $LogPath -Encoding UTF8 -Append
            "Machine: $([System.Environment]::MachineName)" | Out-File -FilePath $LogPath -Encoding UTF8 -Append
            "==============================================================================" | Out-File -FilePath $LogPath -Encoding UTF8 -Append
            "" | Out-File -FilePath $LogPath -Encoding UTF8 -Append
        }

        $global:PolicyLogFilePath = $LogPath
        $global:PolicyLogToFileEnabled = $true
        $global:PolicyDebugEnabled = $EnableDebug
        $global:PolicyErrorCollection = @()

        return $true
    } catch {
        $global:PolicyLogToFileEnabled = $false
        return $false
    }
}

<#
.SYNOPSIS
    Writes a message to the log file
.PARAMETER Message
    The message to write
.PARAMETER Level
    Log level (INFO, SUCCESS, WARNING, ERROR, DEBUG)
#>
function Write-ToLog {
    param(
        [Parameter(Mandatory=$true)]
        [string]$Message,

        [Parameter(Mandatory=$false)]
        [ValidateSet("INFO", "SUCCESS", "WARNING", "ERROR", "DEBUG")]
        [string]$Level = "INFO"
    )

    if (-not $global:PolicyLogToFileEnabled -or [string]::IsNullOrEmpty($global:PolicyLogFilePath)) {
        return
    }

    # Skip DEBUG messages if debug logging is not enabled
    if ($Level -eq "DEBUG" -and -not $global:PolicyDebugEnabled) {
        return
    }

    try {
        $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss.fff"
        $logEntry = "[$timestamp] [$Level] $Message"
        $logEntry | Out-File -FilePath $global:PolicyLogFilePath -Encoding UTF8 -Append
    } catch {
        # Silently fail if logging fails
    }
}

<#
.SYNOPSIS
    Writes a debug message to the log file (only when debug logging is enabled)
.PARAMETER Message
    The debug message to write
.PARAMETER Context
    Optional context identifier (e.g., function name, module name)
#>
function Write-DebugLog {
    param(
        [Parameter(Mandatory=$true)]
        [string]$Message,

        [Parameter(Mandatory=$false)]
        [string]$Context = ""
    )

    if (-not $global:PolicyDebugEnabled) {
        return
    }

    $formattedMessage = if ($Context) { "[$Context] $Message" } else { $Message }
    Write-ToLog -Message $formattedMessage -Level "DEBUG"
}

<#
.SYNOPSIS
    Logs exception details and collects errors for summary
.PARAMETER Exception
    The exception object to log (can be $_ from catch block)
.PARAMETER Context
    Context where the exception occurred
.PARAMETER Operation
    Description of the operation that failed
.PARAMETER AdditionalInfo
    Hashtable of additional contextual information to log
#>
function Write-ErrorLog {
    param(
        [Parameter(Mandatory=$true)]
        $Exception,

        [Parameter(Mandatory=$false)]
        [string]$Context = "",

        [Parameter(Mandatory=$false)]
        [string]$Operation = "",

        [Parameter(Mandatory=$false)]
        [hashtable]$AdditionalInfo = @{}
    )

    # Extract exception details
    $exceptionObj = if ($Exception -is [System.Management.Automation.ErrorRecord]) {
        $Exception.Exception
    } elseif ($Exception -is [System.Exception]) {
        $Exception
    } else {
        $null
    }

    $errorMessage = if ($exceptionObj) { $exceptionObj.Message } else { $Exception.ToString() }
    $errorType = if ($exceptionObj) { $exceptionObj.GetType().Name } else { "Unknown" }

    # Log to file
    Write-ToLog -Message "ERROR in $Context`: $Operation" -Level "ERROR"
    Write-ToLog -Message "  Type: $errorType" -Level "ERROR"
    Write-ToLog -Message "  Message: $errorMessage" -Level "ERROR"

    foreach ($key in $AdditionalInfo.Keys) {
        Write-ToLog -Message "  $key`: $($AdditionalInfo[$key])" -Level "ERROR"
    }

    # Log stack trace if debug enabled
    if ($global:PolicyDebugEnabled -and $exceptionObj -and $exceptionObj.StackTrace) {
        $stackLines = $exceptionObj.StackTrace -split "`n" | Select-Object -First 5
        foreach ($line in $stackLines) {
            Write-ToLog -Message "  STACK: $($line.Trim())" -Level "DEBUG"
        }
    }

    # Collect error for summary
    $global:PolicyErrorCollection += [PSCustomObject]@{
        Timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
        Context = $Context
        Operation = $Operation
        ErrorType = $errorType
        Message = $errorMessage
        AdditionalInfo = $AdditionalInfo
    }
}

<#
.SYNOPSIS
    Gets the collected errors
.OUTPUTS
    Array of error objects collected during execution
#>
function Get-CollectedErrors {
    return $global:PolicyErrorCollection
}

<#
.SYNOPSIS
    Writes collected errors to console in a formatted summary
#>
function Write-ErrorSummary {
    $errors = Get-CollectedErrors

    if ($errors.Count -eq 0) {
        return
    }

    Write-Host "`n$('='*80)" -ForegroundColor Red
    Write-Host "  ERROR SUMMARY - $($errors.Count) error(s) occurred" -ForegroundColor Red
    Write-Host "$('='*80)" -ForegroundColor Red

    $i = 1
    foreach ($err in $errors) {
        Write-Host "`n  [$i] $($err.Context): $($err.Operation)" -ForegroundColor Yellow
        Write-Host "      Type: $($err.ErrorType)" -ForegroundColor Gray
        Write-Host "      Message: $($err.Message)" -ForegroundColor White

        if ($err.AdditionalInfo -and $err.AdditionalInfo.Count -gt 0) {
            foreach ($key in $err.AdditionalInfo.Keys) {
                Write-Host "      $key`: $($err.AdditionalInfo[$key])" -ForegroundColor DarkGray
            }
        }
        $i++
    }

    Write-Host "`n$('='*80)" -ForegroundColor Red

    # Point to log file if available
    if ($global:PolicyLogToFileEnabled -and $global:PolicyLogFilePath) {
        Write-Host "  Full details available in log file:" -ForegroundColor Cyan
        Write-Host "    $($global:PolicyLogFilePath)" -ForegroundColor Gray
    }
}

<#
.SYNOPSIS
    Gets the current log file path
.OUTPUTS
    Path to the current log file or $null if logging is not enabled
#>
function Get-LogFilePath {
    if ($global:PolicyLogToFileEnabled) {
        return $global:PolicyLogFilePath
    }
    return $null
}

<#
.SYNOPSIS
    Executes a script block with automatic retry for transient Azure errors.
.DESCRIPTION
    Wraps Azure API calls with retry logic to handle transient network errors,
    timeouts, and temporary service unavailability.
.PARAMETER ScriptBlock
    The script block to execute.
.PARAMETER MaxRetries
    Maximum number of retry attempts (default: 3).
.PARAMETER RetryDelaySeconds
    Seconds to wait between retries (default: 5).
.PARAMETER OperationName
    Friendly name of the operation for error messages.
.EXAMPLE
    $result = Invoke-WithRetry -ScriptBlock { Get-AzPolicyAssignment -Scope $scope } -OperationName "Get policy assignments"
#>
function Invoke-WithRetry {
    param(
        [Parameter(Mandatory=$true)]
        [scriptblock]$ScriptBlock,

        [Parameter(Mandatory=$false)]
        [int]$MaxRetries = 3,

        [Parameter(Mandatory=$false)]
        [int]$RetryDelaySeconds = 5,

        [Parameter(Mandatory=$false)]
        [string]$OperationName = "Azure operation"
    )

    $attempt = 0
    $lastError = $null

    while ($attempt -lt $MaxRetries) {
        $attempt++
        try {
            $result = & $ScriptBlock
            return $result
        }
        catch {
            $lastError = $_
            $errorMessage = $_.Exception.Message

            # Check if this is a transient/retryable error
            $isTransient = $errorMessage -match "error occurred while sending the request" -or
                           $errorMessage -match "connection was closed" -or
                           $errorMessage -match "operation timed out" -or
                           $errorMessage -match "service unavailable" -or
                           $errorMessage -match "too many requests" -or
                           $errorMessage -match "503" -or
                           $errorMessage -match "429"

            if ($isTransient -and $attempt -lt $MaxRetries) {
                Write-Host "    Transient error on attempt $attempt/$MaxRetries. Retrying in $RetryDelaySeconds seconds..." -ForegroundColor Yellow
                Write-ToLog -Message "Retry $attempt/$MaxRetries for '$OperationName': $errorMessage" -Level "WARN"
                Start-Sleep -Seconds $RetryDelaySeconds
            }
            else {
                # Not retryable or max retries reached
                throw $lastError
            }
        }
    }

    # Should not reach here, but just in case
    throw $lastError
}

<#
.SYNOPSIS
    Finalizes logging and writes summary
#>
function Complete-PolicyLogging {
    if ($global:PolicyLogToFileEnabled -and $global:PolicyLogFilePath) {
        $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
        "" | Out-File -FilePath $global:PolicyLogFilePath -Encoding UTF8 -Append
        "==============================================================================" | Out-File -FilePath $global:PolicyLogFilePath -Encoding UTF8 -Append
        "Deployment Completed: $timestamp" | Out-File -FilePath $global:PolicyLogFilePath -Encoding UTF8 -Append
        "Total Errors: $($global:PolicyErrorCollection.Count)" | Out-File -FilePath $global:PolicyLogFilePath -Encoding UTF8 -Append
        "==============================================================================" | Out-File -FilePath $global:PolicyLogFilePath -Encoding UTF8 -Append
    }
}
