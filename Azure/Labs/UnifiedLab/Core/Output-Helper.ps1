# Output-Helper.ps1
# Provides logging functionality for UnifiedLab modules

# Global variables for logging - only initialize if not already set
if (-not (Get-Variable -Name LabLogFilePath -Scope Global -ErrorAction SilentlyContinue)) {
    $global:LabLogFilePath = $null
}
if (-not (Get-Variable -Name LabLogToFileEnabled -Scope Global -ErrorAction SilentlyContinue)) {
    $global:LabLogToFileEnabled = $false
}
if (-not (Get-Variable -Name LabDebugEnabled -Scope Global -ErrorAction SilentlyContinue)) {
    $global:LabDebugEnabled = $false
}

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
function Initialize-LabLogging {
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
            "Azure Unified Lab Deployment Log" | Out-File -FilePath $LogPath -Encoding UTF8 -Append
            "Started: $timestamp" | Out-File -FilePath $LogPath -Encoding UTF8 -Append
            "Debug Logging: $debugStatus" | Out-File -FilePath $LogPath -Encoding UTF8 -Append
            "PowerShell Version: $($PSVersionTable.PSVersion)" | Out-File -FilePath $LogPath -Encoding UTF8 -Append
            "OS: $([System.Environment]::OSVersion.VersionString)" | Out-File -FilePath $LogPath -Encoding UTF8 -Append
            "User: $([System.Environment]::UserName)" | Out-File -FilePath $LogPath -Encoding UTF8 -Append
            "Machine: $([System.Environment]::MachineName)" | Out-File -FilePath $LogPath -Encoding UTF8 -Append
            "==============================================================================" | Out-File -FilePath $LogPath -Encoding UTF8 -Append
            "" | Out-File -FilePath $LogPath -Encoding UTF8 -Append
        }

        $global:LabLogFilePath = $LogPath
        $global:LabLogToFileEnabled = $true
        $global:LabDebugEnabled = $EnableDebug
    } catch {
        $global:LabLogToFileEnabled = $false
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

    if (-not $global:LabLogToFileEnabled -or [string]::IsNullOrEmpty($global:LabLogFilePath)) {
        return
    }

    # Skip DEBUG messages if debug logging is not enabled
    if ($Level -eq "DEBUG" -and -not $global:LabDebugEnabled) {
        return
    }

    try {
        $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss.fff"
        $logEntry = "[$timestamp] [$Level] $Message"
        $logEntry | Out-File -FilePath $global:LabLogFilePath -Encoding UTF8 -Append
    } catch {
        # Silently fail if logging fails
    }
}

<#
.SYNOPSIS
    Writes a debug message to the log file (only when debug logging is enabled)
.DESCRIPTION
    Convenience function for writing debug-level messages. These messages are only
    written to the log file when debug logging is enabled via -Debug flag or
    Initialize-LabLogging -EnableDebug $true
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

    if (-not $global:LabDebugEnabled) {
        return
    }

    $formattedMessage = if ($Context) { "[$Context] $Message" } else { $Message }
    Write-ToLog -Message $formattedMessage -Level "DEBUG"
}

<#
.SYNOPSIS
    Logs detailed parameter information for debugging
.PARAMETER Parameters
    Hashtable or PSCustomObject containing parameters to log
.PARAMETER Context
    Context identifier (e.g., function name)
.PARAMETER Exclude
    Array of parameter names to exclude from logging (e.g., secrets)
#>
function Write-DebugParameters {
    param(
        [Parameter(Mandatory=$true)]
        $Parameters,

        [Parameter(Mandatory=$true)]
        [string]$Context,

        [Parameter(Mandatory=$false)]
        [string[]]$Exclude = @("sharedKey", "clientSecret", "password", "secret", "key", "token", "credential")
    )

    if (-not $global:LabDebugEnabled) {
        return
    }

    Write-DebugLog -Message "Parameters:" -Context $Context

    $props = if ($Parameters -is [hashtable]) {
        $Parameters.GetEnumerator()
    } elseif ($Parameters -is [PSCustomObject]) {
        $Parameters.PSObject.Properties
    } else {
        return
    }

    foreach ($prop in $props) {
        $name = if ($prop -is [System.Collections.DictionaryEntry]) { $prop.Key } else { $prop.Name }
        $value = if ($prop -is [System.Collections.DictionaryEntry]) { $prop.Value } else { $prop.Value }

        # Mask sensitive parameters
        $isSensitive = $false
        foreach ($excludePattern in $Exclude) {
            if ($name -like "*$excludePattern*") {
                $isSensitive = $true
                break
            }
        }

        if ($isSensitive) {
            Write-DebugLog -Message "  $name = ********" -Context $Context
        } elseif ($null -eq $value) {
            Write-DebugLog -Message "  $name = <null>" -Context $Context
        } elseif ($value -is [array]) {
            Write-DebugLog -Message "  $name = [$($value.Count) items]: $($value -join ', ')" -Context $Context
        } elseif ($value -is [hashtable] -or $value -is [PSCustomObject]) {
            Write-DebugLog -Message "  $name = <complex object>" -Context $Context
        } else {
            Write-DebugLog -Message "  $name = $value" -Context $Context
        }
    }
}

<#
.SYNOPSIS
    Logs the start of a function or operation with timing
.PARAMETER Operation
    Name of the operation starting
.PARAMETER Context
    Optional additional context
.OUTPUTS
    Returns a stopwatch object for timing
#>
function Start-DebugOperation {
    param(
        [Parameter(Mandatory=$true)]
        [string]$Operation,

        [Parameter(Mandatory=$false)]
        [string]$Context = ""
    )

    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()

    if ($global:LabDebugEnabled) {
        $msg = "ENTER: $Operation"
        if ($Context) { $msg += " ($Context)" }
        Write-DebugLog -Message $msg -Context "TIMING"
    }

    return $stopwatch
}

<#
.SYNOPSIS
    Logs the end of a function or operation with elapsed time
.PARAMETER Operation
    Name of the operation ending
.PARAMETER Stopwatch
    Stopwatch object from Start-DebugOperation
.PARAMETER Success
    Whether the operation succeeded
#>
function Stop-DebugOperation {
    param(
        [Parameter(Mandatory=$true)]
        [string]$Operation,

        [Parameter(Mandatory=$true)]
        [System.Diagnostics.Stopwatch]$Stopwatch,

        [Parameter(Mandatory=$false)]
        [bool]$Success = $true
    )

    $Stopwatch.Stop()

    if ($global:LabDebugEnabled) {
        $status = if ($Success) { "SUCCESS" } else { "FAILED" }
        $elapsed = $Stopwatch.Elapsed
        $timeStr = if ($elapsed.TotalMinutes -ge 1) {
            "{0:N2} minutes" -f $elapsed.TotalMinutes
        } elseif ($elapsed.TotalSeconds -ge 1) {
            "{0:N2} seconds" -f $elapsed.TotalSeconds
        } else {
            "{0:N0} ms" -f $elapsed.TotalMilliseconds
        }
        Write-DebugLog -Message "EXIT: $Operation - $status (Elapsed: $timeStr)" -Context "TIMING"
    }
}

<#
.SYNOPSIS
    Logs Azure resource information for debugging
.PARAMETER ResourceType
    Type of Azure resource (e.g., VNet, NSG, StorageAccount)
.PARAMETER ResourceName
    Name of the resource
.PARAMETER ResourceId
    Azure Resource ID (optional)
.PARAMETER Properties
    Hashtable of additional properties to log
.PARAMETER Context
    Optional context identifier (e.g., function name)
#>
function Write-DebugResource {
    param(
        [Parameter(Mandatory=$true)]
        [string]$ResourceType,

        [Parameter(Mandatory=$true)]
        [string]$ResourceName,

        [Parameter(Mandatory=$false)]
        [string]$ResourceId = "",

        [Parameter(Mandatory=$false)]
        [hashtable]$Properties = @{},

        [Parameter(Mandatory=$false)]
        [string]$Context = ""
    )

    if (-not $global:LabDebugEnabled) {
        return
    }

    $logContext = if ($Context) { $Context } else { "RESOURCE" }
    Write-DebugLog -Message "Resource: $ResourceType" -Context $logContext
    Write-DebugLog -Message "  Name: $ResourceName" -Context $logContext
    if ($ResourceId) {
        Write-DebugLog -Message "  ResourceId: $ResourceId" -Context $logContext
    }
    foreach ($key in $Properties.Keys) {
        Write-DebugLog -Message "  $key`: $($Properties[$key])" -Context $logContext
    }
}

<#
.SYNOPSIS
    Logs Azure API call information for debugging
.PARAMETER Cmdlet
    Name of the Azure cmdlet being called
.PARAMETER Parameters
    Parameters being passed to the cmdlet
.PARAMETER Context
    Optional context identifier (e.g., function name)
#>
function Write-DebugAzureCall {
    param(
        [Parameter(Mandatory=$true)]
        [string]$Cmdlet,

        [Parameter(Mandatory=$false)]
        [hashtable]$Parameters = @{},

        [Parameter(Mandatory=$false)]
        [string]$Context = ""
    )

    if (-not $global:LabDebugEnabled) {
        return
    }

    $logContext = if ($Context) { $Context } else { "AZURE" }
    Write-DebugLog -Message "Azure API Call: $Cmdlet" -Context $logContext
    foreach ($key in $Parameters.Keys) {
        $value = $Parameters[$key]
        # Mask sensitive parameters
        if ($key -match "secret|password|key|token|credential") {
            Write-DebugLog -Message "  -$key = ********" -Context $logContext
        } elseif ($null -eq $value) {
            Write-DebugLog -Message "  -$key = <null>" -Context $logContext
        } else {
            Write-DebugLog -Message "  -$key = $value" -Context $logContext
        }
    }
}

<#
.SYNOPSIS
    Logs exception details for debugging
.PARAMETER Exception
    The exception object to log
.PARAMETER Context
    Context where the exception occurred
.PARAMETER AdditionalInfo
    Hashtable of additional contextual information to log
#>
function Write-DebugException {
    param(
        [Parameter(Mandatory=$true)]
        [System.Exception]$Exception,

        [Parameter(Mandatory=$false)]
        [string]$Context = "",

        [Parameter(Mandatory=$false)]
        [hashtable]$AdditionalInfo = @{}
    )

    if (-not $global:LabDebugEnabled) {
        return
    }

    Write-DebugLog -Message "Exception Type: $($Exception.GetType().FullName)" -Context $Context
    Write-DebugLog -Message "Exception Message: $($Exception.Message)" -Context $Context

    if ($AdditionalInfo.Count -gt 0) {
        Write-DebugLog -Message "Additional Info:" -Context $Context
        foreach ($key in $AdditionalInfo.Keys) {
            Write-DebugLog -Message "  $key`: $($AdditionalInfo[$key])" -Context $Context
        }
    }

    if ($Exception.InnerException) {
        Write-DebugLog -Message "Inner Exception: $($Exception.InnerException.Message)" -Context $Context
    }

    if ($Exception.StackTrace) {
        $stackLines = $Exception.StackTrace -split "`n" | Select-Object -First 5
        foreach ($line in $stackLines) {
            Write-DebugLog -Message "  $($line.Trim())" -Context "STACK"
        }
    }
}

<#
.SYNOPSIS
    Checks if debug logging is enabled
.OUTPUTS
    Boolean indicating if debug logging is enabled
#>
function Test-DebugLogging {
    return $global:LabDebugEnabled -eq $true
}
