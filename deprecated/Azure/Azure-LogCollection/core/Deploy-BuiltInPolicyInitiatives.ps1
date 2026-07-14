# Azure Policy Deployment Engine - Built-in Initiative Assignment
# This script assigns Microsoft's built-in diagnostic settings policy initiatives
# to send logs to Event Hub for Cribl Stream ingestion
#
# Deployment Modes:
# - CENTRALIZED: Single policy assignment for all resources, logs to one Event Hub Namespace
# - MULTI-REGION: Per-region policy assignments with resourceSelectors to filter by location
#
# Built-in Initiatives Used:
# - allLogs: "Enable allLogs category group resource logging for supported resources to Event Hub"
# - audit: "Enable audit category group resource logging for supported resources to Event Hub"

[CmdletBinding()]
param(
    [Parameter(Mandatory=$false)]
    [ValidateSet("AllLogs", "Audit")]
    [string]$LoggingMode = "AllLogs",

    [Parameter(Mandatory=$false)]
    [ValidateSet("Centralized", "MultiRegion")]
    [string]$DeploymentMode = "Centralized",

    [Parameter(Mandatory=$false)]
    [switch]$ValidateOnly,

    [Parameter(Mandatory=$false)]
    [switch]$ShowStatus,

    [Parameter(Mandatory=$false)]
    [switch]$RemoveAssignments,

    [Parameter(Mandatory=$false)]
    [switch]$Remediate,

    [Parameter(Mandatory=$false)]
    [string[]]$SpecificRegions,

    # Override parameters - these take precedence over azure-parameters.json
    [Parameter(Mandatory=$false)]
    [Nullable[bool]]$UseExistingNamespaces = $null,

    [Parameter(Mandatory=$false)]
    [string]$CentralizedNamespaceOverride = "",

    [Parameter(Mandatory=$false)]
    [hashtable]$RegionNamespacesOverride = @{}
)

# Script variables
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ScriptStartTime = Get-Date
$ScriptPath = Split-Path -Parent $MyInvocation.MyCommand.Path

# Import logging helper
$OutputHelperPath = Join-Path $ScriptPath "Output-Helper.ps1"
if (Test-Path $OutputHelperPath) {
    . $OutputHelperPath
}

# Built-in Policy Initiative IDs
# IMPORTANT: These are the Event Hub-specific initiatives (not Log Analytics or AMA)
# Reference: https://www.azadvertizer.net/azpolicyinitiativesadvertizer_all.html
$BuiltInInitiatives = @{
    "AllLogs" = @{
        DisplayName = "Enable allLogs category group resource logging for supported resources to Event Hub"
        PolicySetDefinitionId = "/providers/Microsoft.Authorization/policySetDefinitions/85175a36-2f12-419a-96b4-18d5b0096531"
        Description = "Comprehensive logging - captures ALL log categories for 140 resource types"
        ResourceTypes = "140"
        LogVolume = "High (comprehensive)"
        UseCase = "Full visibility, troubleshooting, compliance, SOC operations"
    }
    "Audit" = @{
        DisplayName = "Enable audit category group resource logging for supported resources to Event Hub"
        PolicySetDefinitionId = "/providers/Microsoft.Authorization/policySetDefinitions/1020d527-2764-4230-92cc-7035e4fcf8a7"
        Description = "Audit-focused logging - captures audit/security logs for 69 resource types"
        ResourceTypes = "69"
        LogVolume = "Moderate (audit-focused)"
        UseCase = "Security monitoring, compliance auditing, change tracking"
    }
}

# Load configuration
$azureParamsFile = Join-Path $ScriptPath "azure-parameters.json"

if (-not (Test-Path $azureParamsFile)) {
    Write-Error "azure-parameters.json not found at: $azureParamsFile"
    exit 1
}

try {
    $azureParams = Get-Content $azureParamsFile | ConvertFrom-Json
} catch {
    Write-Error "Failed to parse azure-parameters.json: $_"
    exit 1
}

# Initialize summary
$summary = @{
    AssignmentsCreated = 0
    AssignmentsExisted = 0
    AssignmentsFailed = 0
    AssignmentsRemoved = 0
    RoleAssignmentsCreated = 0
    RegionsProcessed = 0
    RegionsSkipped = 0
    RemediationTasksCreated = 0
    RemediationTasksFailed = 0
}

#region Helper Functions

function Write-StepHeader {
    param([string]$Message)
    Write-Host "`n$('='*80)" -ForegroundColor Cyan
    Write-Host "  $Message" -ForegroundColor Cyan
    Write-Host "$('='*80)" -ForegroundColor Cyan
}

function Write-SubStep {
    param([string]$Message, [string]$Color = "White")
    Write-Host "    $Message" -ForegroundColor $Color
}

function Connect-ToAzure {
    Write-StepHeader "Connecting to Azure"

    try {
        $context = Get-AzContext
        if (-not $context) {
            Write-SubStep "No active Azure context found. Please run Connect-AzAccount first." "Red"
            exit 1
        }

        Write-SubStep "Connected to Azure" "Green"
        Write-SubStep "Account: $($context.Account.Id)" "Gray"
        Write-SubStep "Subscription: $($context.Subscription.Name)" "Gray"

        return $true
    } catch {
        Write-SubStep "Failed to connect to Azure: $_" "Red"
        return $false
    }
}

function Get-SubscriptionIdShort {
    # First 8 characters of subscription ID for globally unique naming
    return $azureParams.eventHubSubscriptionId.Substring(0, 8).ToLower()
}

function Get-InventoryRegions {
    <#
    .SYNOPSIS
        Loads regions from the inventory file for Multi-Region deployments.
    #>
    $inventoryFile = Join-Path $ScriptPath "region-inventory" "inventory-latest.json"

    if (-not (Test-Path $inventoryFile)) {
        Write-Host "`n  ERROR: No inventory found!" -ForegroundColor Red
        Write-Host "  Run inventory first: .\Run-AzureLogCollection.ps1 -NonInteractive -Mode Inventory" -ForegroundColor Yellow
        return @()
    }

    try {
        $inventory = Get-Content $inventoryFile -Raw | ConvertFrom-Json
        if (-not $inventory.Regions -or $inventory.Regions.Count -eq 0) {
            Write-Host "`n  ERROR: Inventory file contains no regions!" -ForegroundColor Red
            return @()
        }

        # Convert to format expected by deployment logic
        return @($inventory.Regions | ForEach-Object {
            @{
                location = $_.Location
                enabled = $true
                resourceCount = $_.ResourceCount
            }
        })
    } catch {
        Write-Host "`n  ERROR: Failed to read inventory file: $_" -ForegroundColor Red
        return @()
    }
}

function Get-EnabledRegions {
    # Now returns regions from inventory instead of config file
    $regions = Get-InventoryRegions

    # Filter to specific regions if provided
    if ($SpecificRegions -and $SpecificRegions.Count -gt 0) {
        $regions = $regions | Where-Object { $SpecificRegions -contains $_.location }
    }

    return $regions
}

function Get-RegionsToProcess {
    param([string]$Mode)

    if ($Mode -eq "Centralized") {
        # Return only the centralized region for assignment location
        # Include namespaceName for custom namespace support
        return @(@{
            location = $azureParams.centralizedRegion
            enabled = $true
            namespaceName = if ($azureParams.centralizedNamespace) { $azureParams.centralizedNamespace } else { "" }
        })
    } else {
        # Return regions from inventory (not config file)
        return Get-EnabledRegions
    }
}

function Get-EffectiveUseExisting {
    # Override parameter takes precedence over config file
    if ($null -ne $UseExistingNamespaces) {
        return $UseExistingNamespaces
    }
    return ($azureParams.useExistingNamespaces -eq $true)
}

function Get-NamespaceName {
    param(
        [string]$Region,
        [string]$Mode
    )

    $useExisting = Get-EffectiveUseExisting

    if ($Mode -eq "Centralized") {
        # Check override parameter first
        if (-not [string]::IsNullOrWhiteSpace($CentralizedNamespaceOverride)) {
            return $CentralizedNamespaceOverride
        }
        # Check config file if using existing namespaces
        if ($useExisting -and -not [string]::IsNullOrWhiteSpace($azureParams.centralizedNamespace)) {
            return $azureParams.centralizedNamespace
        }
    } else {
        # Multi-region mode
        # Check override parameter first
        if ($RegionNamespacesOverride.ContainsKey($Region)) {
            $overrideName = $RegionNamespacesOverride[$Region]
            if (-not [string]::IsNullOrWhiteSpace($overrideName)) {
                return $overrideName
            }
        }
        # Note: Regions now come from inventory, not config file
        # Custom namespace names for existing namespaces must be passed via override parameter
    }

    # Fall back to auto-generated naming pattern
    $subIdShort = Get-SubscriptionIdShort

    if ($Mode -eq "Centralized") {
        # Single namespace: cribl-diag-a1b2c3d4
        return "$($azureParams.eventHubNamespacePrefix)-$subIdShort"
    } else {
        # Per-region namespace: cribl-diag-a1b2c3d4-eastus
        return "$($azureParams.eventHubNamespacePrefix)-$subIdShort-$Region"
    }
}

function Get-AssignmentName {
    <#
    .SYNOPSIS
        Generates a policy assignment name that fits within Azure's 24-character limit.
    .DESCRIPTION
        Azure policy assignment names at management group scope have a maximum length of 24 characters.
        This function generates abbreviated names:
        - Centralized: Cribl-AL-Central or Cribl-AU-Central (16 chars)
        - MultiRegion: Cribl-AL-{region} or Cribl-AU-{region} (truncates region if needed)
    #>
    param(
        [string]$LogMode,
        [string]$Region,
        [string]$DepMode
    )

    # Use 2-letter abbreviation for log mode
    $modeAbbrev = switch ($LogMode) {
        "AllLogs" { "AL" }
        "Audit" { "AU" }
        default { $LogMode.Substring(0, 2).ToUpper() }
    }

    if ($DepMode -eq "Centralized") {
        # Centralized: Cribl-AL-Central (16 chars)
        return "Cribl-$modeAbbrev-Central"
    } else {
        # MultiRegion: Cribl-AL-{region}
        # Max length is 24 chars, prefix is "Cribl-XX-" (9 chars), leaving 15 for region
        $maxRegionLength = 15
        $truncatedRegion = if ($Region.Length -gt $maxRegionLength) {
            $Region.Substring(0, $maxRegionLength)
        } else {
            $Region
        }
        return "Cribl-$modeAbbrev-$truncatedRegion"
    }
}

function Get-EventHubAuthorizationRuleId {
    param(
        [string]$Region,
        [string]$Mode
    )

    $namespaceName = Get-NamespaceName -Region $Region -Mode $Mode
    return "/subscriptions/$($azureParams.eventHubSubscriptionId)/resourceGroups/$($azureParams.eventHubResourceGroup)/providers/Microsoft.EventHub/namespaces/$namespaceName/authorizationRules/RootManageSharedAccessKey"
}

function Test-EventHubNamespaceExists {
    param(
        [string]$Region,
        [string]$Mode
    )

    $namespaceName = Get-NamespaceName -Region $Region -Mode $Mode

    try {
        $namespace = Get-AzEventHubNamespace `
            -ResourceGroupName $azureParams.eventHubResourceGroup `
            -Name $namespaceName `
            -ErrorAction SilentlyContinue

        return ($null -ne $namespace)
    } catch {
        return $false
    }
}

function Get-OrCreateManagedIdentity {
    <#
    .SYNOPSIS
        Gets or creates the user-assigned managed identity for policy assignments.
    .DESCRIPTION
        Creates a shared user-assigned managed identity that will be used by all
        policy assignments in this solution. This eliminates the need to wait for
        identity propagation after each policy assignment.
    #>

    $identityName = "cribl-diag-policy-identity"
    $resourceGroup = $azureParams.eventHubResourceGroup
    $subscriptionId = $azureParams.eventHubSubscriptionId
    $location = $azureParams.centralizedRegion

    Write-SubStep "Checking for managed identity: $identityName" "Cyan"

    # Set subscription context
    try {
        Set-AzContext -SubscriptionId $subscriptionId -ErrorAction Stop | Out-Null
    } catch {
        $errorMsg = "Failed to set subscription context for managed identity: $_"
        Write-ToLog -Message $errorMsg -Level "ERROR"
        throw $errorMsg
    }

    # Check if identity already exists
    try {
        $existingIdentity = Get-AzUserAssignedIdentity -ResourceGroupName $resourceGroup -Name $identityName -ErrorAction SilentlyContinue

        if ($existingIdentity) {
            Write-SubStep "  Found existing managed identity" "Green"
            Write-SubStep "  Principal ID: $($existingIdentity.PrincipalId)" "Gray"
            return $existingIdentity
        }
    } catch {
        # Identity doesn't exist, will create it
    }

    # Create the identity
    Write-SubStep "  Creating user-assigned managed identity..." "Cyan"
    try {
        $newIdentity = New-AzUserAssignedIdentity `
            -ResourceGroupName $resourceGroup `
            -Name $identityName `
            -Location $location `
            -ErrorAction Stop

        Write-SubStep "  Created managed identity successfully" "Green"
        Write-SubStep "  Principal ID: $($newIdentity.PrincipalId)" "Gray"
        Write-SubStep "  Resource ID: $($newIdentity.Id)" "Gray"
        Write-ToLog -Message "Created user-assigned managed identity: $identityName (PrincipalId: $($newIdentity.PrincipalId))" -Level "SUCCESS"

        # Wait briefly for Azure AD propagation
        Write-SubStep "  Waiting for Azure AD propagation (15 seconds)..." "Gray"
        Start-Sleep -Seconds 15

        return $newIdentity

    } catch {
        $errorMsg = "Failed to create managed identity '$identityName': $_"
        Write-ToLog -Message $errorMsg -Level "ERROR"
        throw $errorMsg
    }
}

function Initialize-ManagedIdentityRoles {
    <#
    .SYNOPSIS
        Ensures the managed identity has the required RBAC roles.
    .DESCRIPTION
        Assigns Monitoring Contributor (at management group scope) and
        Azure Event Hubs Data Owner (at Event Hub namespace scope) roles
        to the managed identity if not already assigned.
    #>
    param(
        [Parameter(Mandatory=$true)]
        [string]$PrincipalId
    )

    Write-SubStep "Ensuring RBAC roles for managed identity..." "Cyan"

    $mgScope = "/providers/Microsoft.Management/managementGroups/$($azureParams.managementGroupId)"
    $rolesAssigned = 0
    $rolesFailed = 0

    # Role 1: Monitoring Contributor at management group scope
    Write-SubStep "  Checking Monitoring Contributor role..." "Gray"
    try {
        $existingRole = Get-AzRoleAssignment -ObjectId $PrincipalId -Scope $mgScope -RoleDefinitionName "Monitoring Contributor" -ErrorAction SilentlyContinue

        if ($existingRole) {
            Write-SubStep "  Monitoring Contributor: Already assigned" "Green"
        } else {
            New-AzRoleAssignment -ObjectId $PrincipalId -Scope $mgScope -RoleDefinitionName "Monitoring Contributor" -ErrorAction Stop | Out-Null
            Write-SubStep "  Monitoring Contributor: Assigned" "Green"
            Write-ToLog -Message "Assigned Monitoring Contributor role at $mgScope" -Level "SUCCESS"
            $rolesAssigned++
        }
    } catch {
        $errorMsg = "Failed to assign Monitoring Contributor role: $_"
        Write-ToLog -Message $errorMsg -Level "ERROR"
        $rolesFailed++
    }

    # Role 2: Azure Event Hubs Data Owner at Event Hub namespace scope
    # Data Owner is required because DeployIfNotExists policies need listkeys permission
    # Get the namespace name for centralized mode
    $namespaceName = Get-NamespaceName -Region $azureParams.centralizedRegion -Mode "Centralized"
    $ehScope = "/subscriptions/$($azureParams.eventHubSubscriptionId)/resourceGroups/$($azureParams.eventHubResourceGroup)/providers/Microsoft.EventHub/namespaces/$namespaceName"

    Write-SubStep "  Checking Event Hubs Data Owner role..." "Gray"
    try {
        $existingEhRole = Get-AzRoleAssignment -ObjectId $PrincipalId -Scope $ehScope -RoleDefinitionName "Azure Event Hubs Data Owner" -ErrorAction SilentlyContinue

        if ($existingEhRole) {
            Write-SubStep "  Event Hubs Data Owner: Already assigned" "Green"
        } else {
            New-AzRoleAssignment -ObjectId $PrincipalId -Scope $ehScope -RoleDefinitionName "Azure Event Hubs Data Owner" -ErrorAction Stop | Out-Null
            Write-SubStep "  Event Hubs Data Owner: Assigned" "Green"
            Write-ToLog -Message "Assigned Event Hubs Data Owner role at $ehScope" -Level "SUCCESS"
            $rolesAssigned++
        }
    } catch {
        $errorMsg = "Failed to assign Event Hubs Data Owner role: $_"
        Write-ToLog -Message $errorMsg -Level "ERROR"
        $rolesFailed++
    }

    # Check for failures
    if ($rolesFailed -gt 0) {
        $errorMsg = "Failed to assign $rolesFailed RBAC role(s). Policy remediation will fail without proper permissions."
        Write-ToLog -Message $errorMsg -Level "ERROR"
        throw $errorMsg
    }

    if ($rolesAssigned -gt 0) {
        Write-SubStep "  Waiting for role assignment propagation (10 seconds)..." "Gray"
        Start-Sleep -Seconds 10
    }

    Write-SubStep "  RBAC roles verified" "Green"
}

function Start-PolicyRemediation {
    <#
    .SYNOPSIS
        Creates and starts a remediation task for a policy assignment.
    .DESCRIPTION
        Triggers remediation for existing non-compliant resources. New resources
        are automatically remediated by DeployIfNotExists, but existing resources
        require an explicit remediation task.
    .PARAMETER AssignmentName
        The name of the policy assignment to remediate.
    .PARAMETER Scope
        The scope at which the assignment was created.
    .PARAMETER LogMode
        The logging mode (AllLogs or Audit) for naming the remediation task.
    .PARAMETER Region
        The region for naming the remediation task.
    #>
    param(
        [Parameter(Mandatory=$true)]
        [string]$AssignmentName,
        [Parameter(Mandatory=$true)]
        [string]$Scope,
        [Parameter(Mandatory=$false)]
        [string]$LogMode = "",
        [Parameter(Mandatory=$false)]
        [string]$Region = ""
    )

    # Build remediation task name
    $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $remediationName = "Remediate-$AssignmentName-$timestamp"

    # Get the full policy assignment ID
    $assignmentId = "$Scope/providers/Microsoft.Authorization/policyAssignments/$AssignmentName"

    Write-SubStep "Creating remediation task: $remediationName" "Cyan"
    Write-SubStep "  Assignment: $AssignmentName" "Gray"
    Write-SubStep "  Scope: $Scope" "Gray"

    try {
        # Check if there are non-compliant resources first
        # Note: Compliance data may not be immediately available after assignment creation

        # Create the remediation task
        $remediation = Start-AzPolicyRemediation `
            -Name $remediationName `
            -PolicyAssignmentId $assignmentId `
            -Scope $Scope `
            -ResourceDiscoveryMode ReEvaluateCompliance `
            -ErrorAction Stop

        Write-SubStep "  Remediation task created successfully" "Green"
        Write-SubStep "  Status: $($remediation.ProvisioningState)" "Gray"
        Write-ToLog -Message "Created remediation task: $remediationName for assignment $AssignmentName" -Level "SUCCESS"

        $script:summary.RemediationTasksCreated++
        return $remediation

    } catch {
        # Check if the error is because there are no non-compliant resources
        if ($_.Exception.Message -match "no resources to remediate" -or $_.Exception.Message -match "PolicyAssignmentNotFound") {
            Write-SubStep "  No non-compliant resources found (or compliance not yet evaluated)" "Yellow"
            Write-SubStep "  Remediation will happen automatically for new resources" "Gray"
            Write-ToLog -Message "Remediation skipped for $AssignmentName - no non-compliant resources or compliance not evaluated" -Level "INFO"
            return $null
        }

        Write-SubStep "  Failed to create remediation task: $_" "Red"
        Write-ToLog -Message "Failed to create remediation task for $AssignmentName : $_" -Level "ERROR"
        $script:summary.RemediationTasksFailed++
        return $null
    }
}

function New-PolicyAssignment {
    param(
        [string]$LogMode,
        [string]$Region,
        [string]$DepMode
    )

    $initiative = $BuiltInInitiatives[$LogMode]
    $assignmentName = Get-AssignmentName -LogMode $LogMode -Region $Region -DepMode $DepMode
    $scope = "/providers/Microsoft.Management/managementGroups/$($azureParams.managementGroupId)"
    $eventHubAuthRuleId = Get-EventHubAuthorizationRuleId -Region $Region -Mode $DepMode
    $namespaceName = Get-NamespaceName -Region $Region -Mode $DepMode

    # Display assignment info
    if ($DepMode -eq "Centralized") {
        Write-Host "`n  Centralized Assignment" -ForegroundColor White
        Write-SubStep "All resources across all regions will send logs to:" "Gray"
    } else {
        Write-Host "`n  Region: $Region" -ForegroundColor White
        Write-SubStep "Resources in $Region will send logs to:" "Gray"
    }
    Write-SubStep "Assignment: $assignmentName" "Gray"
    Write-SubStep "Event Hub: $namespaceName" "Gray"

    # Verify Event Hub Namespace exists
    if (-not $ValidateOnly) {
        # Switch to Event Hub subscription to check namespace
        $originalContext = Get-AzContext
        Set-AzContext -SubscriptionId $azureParams.eventHubSubscriptionId -ErrorAction SilentlyContinue | Out-Null

        if (-not (Test-EventHubNamespaceExists -Region $Region -Mode $DepMode)) {
            Write-SubStep "Event Hub Namespace not found. Run 'Deploy Event Hub Namespaces' first." "Red"
            $script:summary.RegionsSkipped++

            # Switch back to original context
            Set-AzContext -SubscriptionId $originalContext.Subscription.Id -ErrorAction SilentlyContinue | Out-Null
            return $null
        }

        # Switch back to original context
        Set-AzContext -SubscriptionId $originalContext.Subscription.Id -ErrorAction SilentlyContinue | Out-Null
    }

    if ($ValidateOnly) {
        Write-SubStep "VALIDATION: Would create assignment '$assignmentName'" "Yellow"
        Write-SubStep "  Scope: $scope" "Gray"
        if ($DepMode -eq "MultiRegion") {
            Write-SubStep "  Resource Selector: resourceLocation in [$Region]" "Gray"
        }
        Write-SubStep "  Event Hub Auth Rule: $eventHubAuthRuleId" "Gray"
        $script:summary.AssignmentsCreated++
        $script:summary.RegionsProcessed++
        return $null
    }

    # Check if assignment already exists
    try {
        $existingAssignment = Get-AzPolicyAssignment -Name $assignmentName -Scope $scope -ErrorAction SilentlyContinue
        if ($existingAssignment) {
            Write-SubStep "Assignment already exists: $assignmentName" "Yellow"
            Write-ToLog -Message "Assignment already exists: $assignmentName (Scope: $scope)" -Level "INFO"

            # Check if role assignments exist for this assignment's managed identity
            # This handles the case where a previous deployment created the assignment but failed before creating roles
            $hasIdentity = $false
            $principalId = $null

            if ($existingAssignment.PSObject.Properties.Name -contains 'Identity' -and $null -ne $existingAssignment.Identity) {
                $identity = $existingAssignment.Identity
                if ($identity.PSObject.Properties.Name -contains 'PrincipalId' -and -not [string]::IsNullOrEmpty($identity.PrincipalId)) {
                    $hasIdentity = $true
                    $principalId = $identity.PrincipalId
                }
            }

            if ($hasIdentity) {
                Write-SubStep "Checking role assignments for existing assignment..." "Gray"
                Write-ToLog -Message "Checking role assignments for managed identity: $principalId" -Level "INFO"

                # Check and create Monitoring Contributor role
                $mgScope = "/providers/Microsoft.Management/managementGroups/$($azureParams.managementGroupId)"
                try {
                    $existingRole = Get-AzRoleAssignment -ObjectId $principalId -Scope $mgScope -RoleDefinitionName "Monitoring Contributor" -ErrorAction SilentlyContinue
                    if (-not $existingRole) {
                        New-AzRoleAssignment -ObjectId $principalId -Scope $mgScope -RoleDefinitionName "Monitoring Contributor" -ErrorAction SilentlyContinue | Out-Null
                        Write-SubStep "  Created missing: Monitoring Contributor (Management Group)" "Green"
                        Write-ToLog -Message "Created role assignment: Monitoring Contributor at $mgScope" -Level "SUCCESS"
                        $script:summary.RoleAssignmentsCreated++
                    } else {
                        Write-SubStep "  Existing: Monitoring Contributor (Management Group)" "Gray"
                    }
                } catch {
                    Write-SubStep "  Warning: Could not verify/assign Monitoring Contributor: $_" "Yellow"
                }

                # Check and create Event Hubs Data Owner role (needed for listkeys permission)
                $ehScope = "/subscriptions/$($azureParams.eventHubSubscriptionId)/resourceGroups/$($azureParams.eventHubResourceGroup)/providers/Microsoft.EventHub/namespaces/$namespaceName"
                try {
                    $existingEhRole = Get-AzRoleAssignment -ObjectId $principalId -Scope $ehScope -RoleDefinitionName "Azure Event Hubs Data Owner" -ErrorAction SilentlyContinue
                    if (-not $existingEhRole) {
                        New-AzRoleAssignment -ObjectId $principalId -Scope $ehScope -RoleDefinitionName "Azure Event Hubs Data Owner" -ErrorAction SilentlyContinue | Out-Null
                        Write-SubStep "  Created missing: Event Hubs Data Owner ($namespaceName)" "Green"
                        Write-ToLog -Message "Created role assignment: Event Hubs Data Owner at $ehScope" -Level "SUCCESS"
                        $script:summary.RoleAssignmentsCreated++
                    } else {
                        Write-SubStep "  Existing: Event Hubs Data Owner ($namespaceName)" "Gray"
                    }
                } catch {
                    Write-SubStep "  Warning: Could not verify/assign Event Hubs Data Owner: $_" "Yellow"
                }
            } else {
                Write-SubStep "No managed identity on existing assignment - cannot verify roles" "Yellow"
                Write-ToLog -Message "Existing assignment has no managed identity - cannot verify role assignments" -Level "WARNING"
            }

            $script:summary.AssignmentsExisted++
            $script:summary.RegionsProcessed++
            return $existingAssignment
        }
    } catch {
        # Assignment doesn't exist, continue
    }

    try {
        # Get the built-in policy set definition
        Write-SubStep "Retrieving built-in initiative..." "Gray"
        $policySetDef = Get-AzPolicySetDefinition -Id $initiative.PolicySetDefinitionId

        if (-not $policySetDef) {
            Write-SubStep "Failed to find built-in initiative" "Red"
            $script:summary.AssignmentsFailed++
            $script:summary.RegionsProcessed++
            return $null
        }

        # Build parameter object
        # Note: resourceLocation parameter is metadata about EH location, NOT a filter
        # Get the diagnostic setting name from config (defaults to setbycriblpolicy if not specified)
        $diagSettingName = if ($azureParams.diagnosticSettingName) { $azureParams.diagnosticSettingName } else { "setbycriblpolicy" }

        # Query the initiative to get required parameters dynamically
        Write-SubStep "Checking initiative parameters..." "Gray"
        $initiativeParams = $policySetDef.Parameter
        $requiredParamNames = @()
        # Get parameter names - handle both hashtable (.Keys) and PSCustomObject (.PSObject.Properties.Name)
        $paramNames = @()
        if ($initiativeParams) {
            if ($initiativeParams -is [hashtable]) {
                $paramNames = $initiativeParams.Keys
            } elseif ($initiativeParams.PSObject.Properties) {
                $paramNames = $initiativeParams.PSObject.Properties.Name
            }
            foreach ($paramName in $paramNames) {
                $param = $initiativeParams.$paramName
                # Check if parameter has no default value (making it required)
                if ($param -and ($param.PSObject.Properties.Name -notcontains 'defaultValue' -or $null -eq $param.defaultValue)) {
                    $requiredParamNames += $paramName
                }
            }
        }

        # Build assignment parameters - only include parameters that exist in the policy definition
        $assignmentParams = @{}

        # Add core parameters if they exist in the policy
        if ($paramNames -contains 'eventHubAuthorizationRuleId') {
            $assignmentParams.eventHubAuthorizationRuleId = $eventHubAuthRuleId
        }
        if ($paramNames -contains 'eventHubName') {
            $assignmentParams.eventHubName = ""  # Empty for auto-creation of insights-logs-* Event Hubs
        }
        if ($paramNames -contains 'effect') {
            $assignmentParams.effect = "DeployIfNotExists"
        }
        if ($paramNames -contains 'resourceLocation') {
            $assignmentParams.resourceLocation = $Region
        }

        # Add diagnostic setting name parameter if policy supports it
        # Different policy versions use different parameter names
        if ($paramNames -contains 'profileName') {
            $assignmentParams.profileName = $diagSettingName
        }
        if ($paramNames -contains 'diagnosticSettingName') {
            $assignmentParams.diagnosticSettingName = $diagSettingName
        }

        # Defensive fallback: Add dcrResourceId parameter if the initiative requires it
        # The correct Event Hub initiatives (85175a36/1020d527) should NOT require this parameter
        if ($paramNames -contains 'dcrResourceId') {
            $assignmentParams.dcrResourceId = ""
            Write-SubStep "  WARNING: Initiative requires dcrResourceId - verify correct initiative ID is configured" "Yellow"
        }

        Write-SubStep "  Using $($assignmentParams.Count) parameters: $($assignmentParams.Keys -join ', ')" "Gray"

        # Determine display name and description based on mode
        if ($DepMode -eq "Centralized") {
            $displayName = "Cribl Built-in Diagnostic Settings - $LogMode - Centralized"
            $description = "Assigns Microsoft's built-in '$($initiative.DisplayName)' for all resources. Logs sent to centralized Event Hub in $Region for Cribl Stream."
        } else {
            $displayName = "Cribl Built-in Diagnostic Settings - $LogMode - $Region"
            $description = "Assigns Microsoft's built-in '$($initiative.DisplayName)' for resources in $Region region. Logs sent to regional Event Hub for Cribl Stream."
        }

        # Build resource selectors for MultiRegion mode
        # This is the key difference - resourceSelectors filter which resources the policy applies to
        $resourceSelectors = $null
        if ($DepMode -eq "MultiRegion") {
            Write-SubStep "Adding resourceSelector to filter by location: $Region" "Cyan"
            $resourceSelectors = @(
                @{
                    name = "ResourcesIn$($Region.Replace('-',''))"
                    selectors = @(
                        @{
                            kind = "resourceLocation"
                            "in" = @($Region)
                        }
                    )
                }
            )
        }

        # Create the policy assignment with user-assigned managed identity
        Write-SubStep "Creating policy assignment..." "Cyan"
        Write-SubStep "Diagnostic Setting Name: $diagSettingName" "Gray"

        # Build assignment parameters with user-assigned managed identity
        $assignmentSplat = @{
            Name = $assignmentName
            DisplayName = $displayName
            Description = $description
            PolicySetDefinition = $policySetDef
            Scope = $scope
            Location = $Region
            PolicyParameterObject = $assignmentParams
            IdentityType = "UserAssigned"
            IdentityId = $script:managedIdentity.Id
            ErrorAction = "Stop"
        }

        # Add resource selectors if in MultiRegion mode
        if ($resourceSelectors) {
            $assignmentSplat.ResourceSelector = $resourceSelectors
        }

        $assignment = New-AzPolicyAssignment @assignmentSplat

        # Only reach this point if assignment was created successfully
        Write-SubStep "Created assignment: $assignmentName" "Green"
        Write-SubStep "Using shared managed identity (RBAC roles pre-configured)" "Gray"
        Write-ToLog -Message "Created policy assignment: $assignmentName (Scope: $scope, Mode: $DepMode, Region: $Region)" -Level "SUCCESS"

        if ($DepMode -eq "MultiRegion") {
            Write-SubStep "  With resourceSelector filtering for: $Region" "Green"
            Write-ToLog -Message "  ResourceSelector: resourceLocation in [$Region]" -Level "INFO"
        }

        Write-ToLog -Message "Assignment completed: $assignmentName" -Level "SUCCESS"
        $script:summary.AssignmentsCreated++
        $script:summary.RegionsProcessed++
        return $assignment

    } catch {
        Write-SubStep "Failed to create assignment: $_" "Red"

        # Log detailed error information
        if (Get-Command Write-ErrorLog -ErrorAction SilentlyContinue) {
            Write-ErrorLog -Exception $_ -Context "New-PolicyAssignment" -Operation "Create policy assignment '$assignmentName'" -AdditionalInfo @{
                AssignmentName = $assignmentName
                Scope = $scope
                Region = $Region
                LogMode = $LogMode
                DeploymentMode = $DepMode
                EventHubAuthRuleId = $eventHubAuthRuleId
                DiagnosticSettingName = $diagSettingName
            }
        }

        $script:summary.AssignmentsFailed++
        $script:summary.RegionsProcessed++
        return $null
    }
}

function Remove-PolicyAssignment {
    param(
        [string]$LogMode,
        [string]$Region,
        [string]$DepMode
    )

    $assignmentName = Get-AssignmentName -LogMode $LogMode -Region $Region -DepMode $DepMode
    $scope = "/providers/Microsoft.Management/managementGroups/$($azureParams.managementGroupId)"

    if ($DepMode -eq "Centralized") {
        Write-Host "`n  Centralized Assignment" -ForegroundColor White
    } else {
        Write-Host "`n  Region: $Region" -ForegroundColor White
    }
    Write-SubStep "Assignment: $assignmentName" "Gray"

    if ($ValidateOnly) {
        Write-SubStep "VALIDATION: Would remove assignment '$assignmentName'" "Yellow"
        return
    }

    try {
        $existing = Get-AzPolicyAssignment -Name $assignmentName -Scope $scope -ErrorAction SilentlyContinue

        if ($existing) {
            Remove-AzPolicyAssignment -Name $assignmentName -Scope $scope -Force
            Write-SubStep "Removed assignment: $assignmentName" "Green"
            $script:summary.AssignmentsRemoved++
        } else {
            Write-SubStep "Assignment not found: $assignmentName" "Yellow"
        }
    } catch {
        Write-SubStep "Failed to remove assignment: $_" "Red"
    }
}

function Show-AssignmentStatus {
    Write-StepHeader "Policy Assignment Status"

    $scope = "/providers/Microsoft.Management/managementGroups/$($azureParams.managementGroupId)"
    $subIdShort = Get-SubscriptionIdShort

    Write-Host "`n  Management Group: $($azureParams.managementGroupId)" -ForegroundColor Cyan
    Write-Host "  Scope: $scope" -ForegroundColor Gray

    foreach ($logMode in @("AllLogs", "Audit")) {
        $initiative = $BuiltInInitiatives[$logMode]

        Write-Host "`n  $logMode Logging Initiative" -ForegroundColor Cyan
        Write-Host "  $($initiative.Description)" -ForegroundColor Gray

        # Check Centralized assignment
        Write-Host "`n    CENTRALIZED MODE:" -ForegroundColor Yellow
        $centralAssignmentName = Get-AssignmentName -LogMode $logMode -Region $azureParams.centralizedRegion -DepMode "Centralized"

        try {
            $assignment = Get-AzPolicyAssignment -Name $centralAssignmentName -Scope $scope -ErrorAction SilentlyContinue

            if ($assignment) {
                Write-SubStep "  $centralAssignmentName - ASSIGNED" "Green"
                Write-SubStep "    Target namespace: $($azureParams.eventHubNamespacePrefix)-$subIdShort" "Gray"

                if ($assignment.Identity) {
                    Write-SubStep "    Managed Identity: $($assignment.Identity.PrincipalId)" "Gray"
                }
            } else {
                Write-SubStep "  $centralAssignmentName - NOT ASSIGNED" "DarkGray"
            }
        } catch {
            Write-SubStep "  $centralAssignmentName - NOT ASSIGNED" "DarkGray"
        }

        # Check Multi-Region assignments (from inventory)
        Write-Host "`n    MULTI-REGION MODE (from inventory):" -ForegroundColor Yellow
        $inventoryRegions = Get-InventoryRegions

        if ($inventoryRegions.Count -eq 0) {
            Write-SubStep "  No inventory found - run Inventory mode first" "Yellow"
        } else {
            foreach ($regionConfig in $inventoryRegions) {
                $region = $regionConfig.location
                $assignmentName = Get-AssignmentName -LogMode $logMode -Region $region -DepMode "MultiRegion"

                try {
                    $assignment = Get-AzPolicyAssignment -Name $assignmentName -Scope $scope -ErrorAction SilentlyContinue

                    if ($assignment) {
                        Write-SubStep "  $assignmentName - ASSIGNED" "Green"
                        Write-SubStep "    Target namespace: $($azureParams.eventHubNamespacePrefix)-$subIdShort-$region" "Gray"
                        Write-SubStep "    Resource Selector: resourceLocation in [$region]" "Gray"

                        # Check compliance
                        try {
                            $compliance = Get-AzPolicyState `
                                -ManagementGroupName $azureParams.managementGroupId `
                                -Filter "PolicyAssignmentName eq '$assignmentName'" `
                                -Top 100 `
                                -ErrorAction SilentlyContinue

                            if ($compliance) {
                                $compliant = ($compliance | Where-Object { $_.ComplianceState -eq "Compliant" } | Measure-Object).Count
                                $nonCompliant = ($compliance | Where-Object { $_.ComplianceState -eq "NonCompliant" } | Measure-Object).Count
                                Write-SubStep "    Compliance: $compliant compliant, $nonCompliant non-compliant" "$(if ($nonCompliant -gt 0) { 'Yellow' } else { 'Green' })"
                            }
                        } catch {
                            Write-SubStep "    Compliance: (pending evaluation)" "Gray"
                        }
                    } else {
                        Write-SubStep "  $assignmentName - NOT ASSIGNED" "DarkGray"
                    }
                } catch {
                    Write-SubStep "  $assignmentName - NOT ASSIGNED" "DarkGray"
                }
            }
        }
    }
}

function Show-DeploymentSummary {
    Write-StepHeader "DEPLOYMENT SUMMARY"

    $duration = (Get-Date) - $ScriptStartTime
    $initiative = $BuiltInInitiatives[$LoggingMode]

    Write-Host "`n  Deployment Mode: $DeploymentMode" -ForegroundColor Cyan
    Write-Host "  Logging Mode: $LoggingMode" -ForegroundColor Cyan
    Write-Host "  Initiative: $($initiative.DisplayName)" -ForegroundColor Gray

    if ($DeploymentMode -eq "Centralized") {
        Write-Host "`n  Single assignment for all resources" -ForegroundColor Gray
        Write-Host "  All logs sent to: $($azureParams.centralizedRegion)" -ForegroundColor Gray
    } else {
        Write-Host "`n  Per-region assignments with resourceSelectors" -ForegroundColor Gray
        Write-Host "  Logs stay in their source region" -ForegroundColor Gray
    }

    Write-Host "`n  Policy Assignments:" -ForegroundColor Cyan
    Write-Host "    Created: $($summary.AssignmentsCreated)" -ForegroundColor Green
    Write-Host "    Already existed: $($summary.AssignmentsExisted)" -ForegroundColor Yellow
    Write-Host "    Failed: $($summary.AssignmentsFailed)" -ForegroundColor $(if ($summary.AssignmentsFailed -gt 0) { "Red" } else { "Gray" })
    Write-Host "    Removed: $($summary.AssignmentsRemoved)" -ForegroundColor $(if ($summary.AssignmentsRemoved -gt 0) { "Cyan" } else { "Gray" })

    Write-Host "`n  Role Assignments Created: $($summary.RoleAssignmentsCreated)" -ForegroundColor Cyan

    Write-Host "`n  Regions:" -ForegroundColor Cyan
    Write-Host "    Processed: $($summary.RegionsProcessed)" -ForegroundColor White
    Write-Host "    Skipped (no namespace): $($summary.RegionsSkipped)" -ForegroundColor $(if ($summary.RegionsSkipped -gt 0) { "Yellow" } else { "Gray" })

    if ($summary.RemediationTasksCreated -gt 0 -or $summary.RemediationTasksFailed -gt 0) {
        Write-Host "`n  Remediation Tasks:" -ForegroundColor Cyan
        Write-Host "    Created: $($summary.RemediationTasksCreated)" -ForegroundColor Green
        Write-Host "    Failed: $($summary.RemediationTasksFailed)" -ForegroundColor $(if ($summary.RemediationTasksFailed -gt 0) { "Red" } else { "Gray" })
    }

    Write-Host "`n  Duration: $($duration.ToString('mm\:ss'))" -ForegroundColor Gray

    if ($ValidateOnly) {
        Write-Host "`n  VALIDATION MODE - No resources were deployed" -ForegroundColor Yellow
    } elseif ($RemoveAssignments) {
        Write-Host "`n  Assignment removal complete!" -ForegroundColor Cyan
    } else {
        Write-Host "`n  Policy assignments deployed!" -ForegroundColor Green

        if ($Remediate) {
            Write-Host "`n  NEXT STEPS:" -ForegroundColor Yellow
            Write-Host "    1. Monitor remediation task progress in Azure Portal" -ForegroundColor White
            Write-Host "    2. Monitor Event Hubs for incoming diagnostic logs" -ForegroundColor White
            Write-Host "    3. Configure Cribl Stream Event Hub sources (see cribl-configs/)" -ForegroundColor White
        } else {
            Write-Host "`n  NEXT STEPS:" -ForegroundColor Yellow
            Write-Host "    1. Wait 15-30 minutes for initial compliance evaluation" -ForegroundColor White
            Write-Host "    2. Run with -Remediate to create remediation tasks for existing resources" -ForegroundColor White
            Write-Host "    3. Monitor Event Hubs for incoming diagnostic logs" -ForegroundColor White
            Write-Host "    4. Configure Cribl Stream Event Hub sources (see cribl-configs/)" -ForegroundColor White
        }
    }

    # Display error summary if there were failures
    if ($summary.AssignmentsFailed -gt 0 -and (Get-Command Write-ErrorSummary -ErrorAction SilentlyContinue)) {
        Write-ErrorSummary
    }

    # Show log file location if logging is enabled
    if (Get-Command Get-LogFilePath -ErrorAction SilentlyContinue) {
        $logPath = Get-LogFilePath
        if ($logPath) {
            Write-Host "`n  Log file: $logPath" -ForegroundColor DarkGray
        }
    }

    # Finalize logging
    if (Get-Command Complete-PolicyLogging -ErrorAction SilentlyContinue) {
        Complete-PolicyLogging
    }
}

#endregion

#region Main Execution

# Handle status check
if ($ShowStatus) {
    if (-not (Connect-ToAzure)) { exit 1 }
    Show-AssignmentStatus
    exit 0
}

# Connect to Azure
if (-not (Connect-ToAzure)) {
    exit 1
}

# Get regions to process based on deployment mode
$regionsToProcess = Get-RegionsToProcess -Mode $DeploymentMode

if ($regionsToProcess.Count -eq 0) {
    Write-Host "`n  ERROR: No regions to process!" -ForegroundColor Red
    if ($DeploymentMode -eq "MultiRegion") {
        Write-Host "  Please set 'enabled: true' for at least one region in azure-parameters.json" -ForegroundColor Yellow
    }
    exit 1
}

Write-Host "`n  Deployment Mode: $DeploymentMode" -ForegroundColor Cyan
Write-Host "  Logging Mode: $LoggingMode" -ForegroundColor Cyan
if ($DeploymentMode -eq "Centralized") {
    Write-Host "  Centralized Region: $($azureParams.centralizedRegion)" -ForegroundColor Cyan
} else {
    Write-Host "  Regions to process: $($regionsToProcess.location -join ', ')" -ForegroundColor Cyan
}

# Handle removal
if ($RemoveAssignments) {
    Write-StepHeader "Removing Policy Assignments - $DeploymentMode / $LoggingMode"

    foreach ($regionConfig in $regionsToProcess) {
        Remove-PolicyAssignment -LogMode $LoggingMode -Region $regionConfig.location -DepMode $DeploymentMode
    }

    Show-DeploymentSummary
    exit 0
}

# ============================================================================
# Initialize Managed Identity for Policy Assignments
# ============================================================================
Write-StepHeader "Initializing Managed Identity"
Write-SubStep "User-assigned managed identity is used for all policy assignments" "Gray"
Write-SubStep "This eliminates identity propagation delays and simplifies RBAC management" "Gray"

try {
    # Get or create the managed identity
    $script:managedIdentity = Get-OrCreateManagedIdentity

    # Ensure RBAC roles are assigned
    Initialize-ManagedIdentityRoles -PrincipalId $script:managedIdentity.PrincipalId

    Write-SubStep "Managed identity ready for policy assignments" "Green"

} catch {
    Write-ToLog -Message "Failed to initialize managed identity: $_" -Level "ERROR"
    Write-Host "`n  ERROR: Cannot proceed without managed identity." -ForegroundColor Red
    Write-Host "  Please check the logs above and resolve the issue." -ForegroundColor Red
    exit 1
}

# Deploy assignments
Write-StepHeader "Deploying Policy Assignments - $DeploymentMode / $LoggingMode"

$initiative = $BuiltInInitiatives[$LoggingMode]
Write-Host "`n  Initiative: $($initiative.DisplayName)" -ForegroundColor Cyan
Write-Host "  Coverage: $($initiative.ResourceTypes) resource types" -ForegroundColor Gray

if ($DeploymentMode -eq "Centralized") {
    Write-Host "`n  Mode: CENTRALIZED" -ForegroundColor Yellow
    Write-Host "  - Single policy assignment applies to ALL resources" -ForegroundColor Gray
    Write-Host "  - All logs sent to Event Hub in $($azureParams.centralizedRegion)" -ForegroundColor Gray
    Write-Host "  - Cross-region egress charges may apply" -ForegroundColor Gray
} else {
    Write-Host "`n  Mode: MULTI-REGION" -ForegroundColor Yellow
    Write-Host "  - Per-region policy assignments with resourceSelectors" -ForegroundColor Gray
    Write-Host "  - Logs stay in their source region (no cross-region egress)" -ForegroundColor Gray
    Write-Host "  - Data residency compliance maintained" -ForegroundColor Gray
}

foreach ($regionConfig in $regionsToProcess) {
    New-PolicyAssignment -LogMode $LoggingMode -Region $regionConfig.location -DepMode $DeploymentMode
}

# Create remediation tasks if requested
if ($Remediate -and $summary.AssignmentsCreated -gt 0) {
    Write-StepHeader "Creating Remediation Tasks"
    Write-SubStep "Remediation tasks apply policies to existing non-compliant resources" "Gray"
    Write-SubStep "New resources are automatically remediated by DeployIfNotExists" "Gray"

    foreach ($regionConfig in $regionsToProcess) {
        $assignmentName = Get-AssignmentName -LogMode $LoggingMode -Region $regionConfig.location -DepMode $DeploymentMode
        $scope = "/providers/Microsoft.Management/managementGroups/$($azureParams.managementGroupId)"

        Start-PolicyRemediation -AssignmentName $assignmentName -Scope $scope -LogMode $LoggingMode -Region $regionConfig.location
    }
} elseif ($Remediate) {
    Write-SubStep "No new assignments created - skipping remediation" "Gray"
}

# Show summary
Show-DeploymentSummary

#endregion
