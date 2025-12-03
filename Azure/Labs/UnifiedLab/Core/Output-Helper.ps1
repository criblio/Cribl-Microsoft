# Output-Helper.ps1
# Provides logging functionality for UnifiedLab modules

# Global variables for logging - only initialize if not already set
if (-not (Get-Variable -Name LabLogFilePath -Scope Global -ErrorAction SilentlyContinue)) {
    $global:LabLogFilePath = $null
}
if (-not (Get-Variable -Name LabLogToFileEnabled -Scope Global -ErrorAction SilentlyContinue)) {
    $global:LabLogToFileEnabled = $false
}

<#
.SYNOPSIS
    Initializes logging to a file
.PARAMETER LogPath
    Full path to the log file
.PARAMETER Append
    Whether to append to existing log file (default: false, overwrites)
#>
function Initialize-LabLogging {
    param(
        [Parameter(Mandatory=$true)]
        [string]$LogPath,

        [Parameter(Mandatory=$false)]
        [bool]$Append = $false
    )

    try {
        $logDir = Split-Path -Path $LogPath -Parent
        if (-not (Test-Path $logDir)) {
            New-Item -ItemType Directory -Path $logDir -Force | Out-Null
        }

        if (-not $Append) {
            $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
            "==============================================================================" | Out-File -FilePath $LogPath -Encoding UTF8
            "Azure Unified Lab Deployment Log" | Out-File -FilePath $LogPath -Encoding UTF8 -Append
            "Started: $timestamp" | Out-File -FilePath $LogPath -Encoding UTF8 -Append
            "==============================================================================" | Out-File -FilePath $LogPath -Encoding UTF8 -Append
            "" | Out-File -FilePath $LogPath -Encoding UTF8 -Append
        }

        $global:LabLogFilePath = $LogPath
        $global:LabLogToFileEnabled = $true
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
    Log level (INFO, SUCCESS, WARNING, ERROR)
#>
function Write-ToLog {
    param(
        [Parameter(Mandatory=$true)]
        [string]$Message,

        [Parameter(Mandatory=$false)]
        [string]$Level = "INFO"
    )

    if (-not $global:LabLogToFileEnabled -or [string]::IsNullOrEmpty($global:LabLogFilePath)) {
        return
    }

    try {
        $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
        $logEntry = "[$timestamp] [$Level] $Message"
        $logEntry | Out-File -FilePath $global:LabLogFilePath -Encoding UTF8 -Append
    } catch {
        # Silently fail if logging fails
    }
}
