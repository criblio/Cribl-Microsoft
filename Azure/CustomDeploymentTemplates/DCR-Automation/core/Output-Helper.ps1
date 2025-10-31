# Output-Helper.ps1
# Provides consistent output control across DCR-Automation scripts
# Based on the Unified Lab approach for standardized verbosity management

# Global variables for output control - only initialize if not already set
# This prevents resetting logging configuration when Output-Helper is dot-sourced multiple times
if (-not (Get-Variable -Name DCRVerboseOutputEnabled -Scope Global -ErrorAction SilentlyContinue)) {
    $global:DCRVerboseOutputEnabled = $false
}
if (-not (Get-Variable -Name DCRLogFilePath -Scope Global -ErrorAction SilentlyContinue)) {
    $global:DCRLogFilePath = $null
}
if (-not (Get-Variable -Name DCRLogToFileEnabled -Scope Global -ErrorAction SilentlyContinue)) {
    $global:DCRLogToFileEnabled = $false
}

<#
.SYNOPSIS
 Sets the global verbose output setting
.PARAMETER Enabled
 Whether verbose output should be enabled
#>
function Set-DCRVerboseOutput {
    param([bool]$Enabled)
    $global:DCRVerboseOutputEnabled = $Enabled
}

<#
.SYNOPSIS
 Initializes logging to a file
.PARAMETER LogPath
 Full path to the log file
.PARAMETER Append
 Whether to append to existing log file (default: false, overwrites)
#>
function Initialize-DCRLogging {
    param(
        [Parameter(Mandatory=$true)]
        [string]$LogPath,

        [Parameter(Mandatory=$false)]
        [bool]$Append = $false
    )

    try {
        # Ensure directory exists
        $logDir = Split-Path -Path $LogPath -Parent
        if (-not (Test-Path $logDir)) {
            New-Item -ItemType Directory -Path $logDir -Force | Out-Null
        }

        # Initialize or clear log file
        if (-not $Append) {
            $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
            "==============================================================================" | Out-File -FilePath $LogPath -Encoding UTF8
            "Azure DCR Automation Log" | Out-File -FilePath $LogPath -Encoding UTF8 -Append
            "Started: $timestamp" | Out-File -FilePath $LogPath -Encoding UTF8 -Append
            "==============================================================================" | Out-File -FilePath $LogPath -Encoding UTF8 -Append
            "" | Out-File -FilePath $LogPath -Encoding UTF8 -Append
        }

        $global:DCRLogFilePath = $LogPath
        $global:DCRLogToFileEnabled = $true

        Write-Host "  Log file initialized: $LogPath" -ForegroundColor Cyan
    } catch {
        Write-Host "  Warning: Could not initialize log file: $($_.Exception.Message)" -ForegroundColor Yellow
        $global:DCRLogToFileEnabled = $false
    }
}

<#
.SYNOPSIS
 Writes a message to the log file
.PARAMETER Message
 The message to write
.PARAMETER Level
 Log level (INFO, SUCCESS, WARNING, ERROR, DEBUG, VERBOSE)
#>
function Write-ToLog {
    param(
        [Parameter(Mandatory=$true)]
        [string]$Message,

        [Parameter(Mandatory=$false)]
        [string]$Level = "INFO"
    )

    if (-not $global:DCRLogToFileEnabled -or [string]::IsNullOrEmpty($global:DCRLogFilePath)) {
        return
    }

    try {
        $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
        $logEntry = "[$timestamp] [$Level] $Message"
        $logEntry | Out-File -FilePath $global:DCRLogFilePath -Encoding UTF8 -Append
    } catch {
        # Silently fail if logging fails - don't interrupt execution
    }
}

<#
.SYNOPSIS
 Writes a message with level-based filtering
.PARAMETER Message
 The message to write
.PARAMETER Level
 Output level: Critical, Important, Info, Verbose, Debug
 - Critical: Always shown (errors, critical warnings)
 - Important: Always shown (major steps, success/failure)
 - Info: Shown by default (normal progress)
 - Verbose: Only shown with -Verbose flag (detailed progress)
 - Debug: Only shown with -Verbose flag (diagnostic info)
.PARAMETER Color
 Console color for the message
#>
function Write-DCRMessage {
    param(
        [Parameter(Mandatory=$true)]
        [string]$Message,

        [Parameter(Mandatory=$false)]
        [ValidateSet("Critical", "Important", "Info", "Verbose", "Debug")]
        [string]$Level = "Info",

        [Parameter(Mandatory=$false)]
        [ConsoleColor]$Color = [ConsoleColor]::White,

        [Parameter(Mandatory=$false)]
        [switch]$NoNewline
    )

    # Determine if message should be shown
    $shouldShow = $false

    switch ($Level) {
        "Critical" { $shouldShow = $true } # Always show critical messages
        "Important" { $shouldShow = $true } # Always show important messages
        "Info" { $shouldShow = $true } # Show info by default
        "Verbose" { $shouldShow = $global:DCRVerboseOutputEnabled }
        "Debug" { $shouldShow = $global:DCRVerboseOutputEnabled }
    }

    if ($shouldShow) {
        if ($NoNewline) {
            Write-Host $Message -ForegroundColor $Color -NoNewline
        } else {
            Write-Host $Message -ForegroundColor $Color
        }
    }
}

<#
.SYNOPSIS
 Writes a section header (always shown)
#>
function Write-DCRHeader {
    param(
        [Parameter(Mandatory=$true)]
        [string]$Message,

        [Parameter(Mandatory=$false)]
        [ConsoleColor]$Color = [ConsoleColor]::Cyan,

        [Parameter(Mandatory=$false)]
        [string]$SeparatorChar = "=",

        [Parameter(Mandatory=$false)]
        [int]$Width = 80
    )

    # Write to log file
    Write-ToLog -Message "" -Level "INFO"
    Write-ToLog -Message ($SeparatorChar * $Width) -Level "INFO"
    Write-ToLog -Message $Message -Level "HEADER"
    Write-ToLog -Message ($SeparatorChar * $Width) -Level "INFO"

    Write-Host "`n$($SeparatorChar * $Width)" -ForegroundColor $Color
    Write-Host $Message -ForegroundColor $Color
    Write-Host "$($SeparatorChar * $Width)" -ForegroundColor $Color
}

<#
.SYNOPSIS
 Writes a sub-section header (always shown)
#>
function Write-DCRSubHeader {
    param(
        [Parameter(Mandatory=$true)]
        [string]$Message,

        [Parameter(Mandatory=$false)]
        [ConsoleColor]$Color = [ConsoleColor]::Yellow
    )

    # Write to log file
    Write-ToLog -Message "" -Level "INFO"
    Write-ToLog -Message $Message -Level "SUBHEADER"

    Write-Host "`n$Message" -ForegroundColor $Color
}

<#
.SYNOPSIS
 Writes a success message (always shown)
#>
function Write-DCRSuccess {
    param(
        [Parameter(Mandatory=$true)]
        [string]$Message
    )

    Write-Host " $Message" -ForegroundColor Cyan
    Write-ToLog -Message $Message -Level "SUCCESS"
}

<#
.SYNOPSIS
 Writes an error message (always shown)
#>
function Write-DCRError {
    param(
        [Parameter(Mandatory=$true)]
        [string]$Message
    )

    Write-Host " $Message" -ForegroundColor Red
    Write-ToLog -Message $Message -Level "ERROR"
}

<#
.SYNOPSIS
 Writes a warning message (always shown)
#>
function Write-DCRWarning {
    param(
        [Parameter(Mandatory=$true)]
        [string]$Message
    )

    Write-Host " $Message" -ForegroundColor Yellow
    Write-ToLog -Message $Message -Level "WARNING"
}

<#
.SYNOPSIS
 Writes an info message (always shown)
#>
function Write-DCRInfo {
    param(
        [Parameter(Mandatory=$false)]
        [AllowEmptyString()]
        [string]$Message = "",

        [Parameter(Mandatory=$false)]
        [ConsoleColor]$Color = [ConsoleColor]::Green
    )

    if ($Message) {
        Write-Host "   $Message" -ForegroundColor $Color
        Write-ToLog -Message $Message -Level "INFO"
    }
}

<#
.SYNOPSIS
 Writes a verbose detail message (only shown with -Verbose)
#>
function Write-DCRVerbose {
    param(
        [Parameter(Mandatory=$true)]
        [string]$Message,

        [Parameter(Mandatory=$false)]
        [ConsoleColor]$Color = [ConsoleColor]::Gray
    )

    # Always write to log file
    Write-ToLog -Message $Message -Level "VERBOSE"

    # Only show in console if verbose is enabled
    if ($global:DCRVerboseOutputEnabled) {
        Write-Host "   $Message" -ForegroundColor $Color
    }
}

<#
.SYNOPSIS
 Writes a progress indicator (always shown for major steps, verbose for minor)
#>
function Write-DCRProgress {
    param(
        [Parameter(Mandatory=$true)]
        [string]$Message,

        [Parameter(Mandatory=$false)]
        [bool]$Minor = $false,

        [Parameter(Mandatory=$false)]
        [ConsoleColor]$Color = [ConsoleColor]::White
    )

    # Always write to log file
    $logLevel = if ($Minor) { "DEBUG" } else { "PROGRESS" }
    Write-ToLog -Message $Message -Level $logLevel

    # Only show minor progress if verbose is enabled
    if ($Minor -and -not $global:DCRVerboseOutputEnabled) {
        return
    }

    $indent = if ($Minor) { "     " } else { "  " }
    Write-Host "$indent$Message" -ForegroundColor $Color
}

<#
.SYNOPSIS
 Writes a status line (property: value format) - only shown with -Verbose
#>
function Write-DCRStatus {
    param(
        [Parameter(Mandatory=$true)]
        [string]$Property,

        [Parameter(Mandatory=$true)]
        [string]$Value,

        [Parameter(Mandatory=$false)]
        [ConsoleColor]$PropertyColor = [ConsoleColor]::Gray,

        [Parameter(Mandatory=$false)]
        [ConsoleColor]$ValueColor = [ConsoleColor]::White
    )

    # Always write to log file
    Write-ToLog -Message "${Property}: ${Value}" -Level "STATUS"

    # Only show in console if verbose is enabled
    if ($global:DCRVerboseOutputEnabled) {
        Write-Host "   $Property`: " -ForegroundColor $PropertyColor -NoNewline
        Write-Host $Value -ForegroundColor $ValueColor
    }
}

# Export functions (for when this is used as a module)



