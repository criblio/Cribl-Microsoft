# Deploy-TTLCleanupFunction.ps1
# Deploys an Azure Logic App (Consumption) that monitors and deletes its own resource group based on TTL tags

param(
    [Parameter(Mandatory=$true)]
    [PSCustomObject]$AzureParams,

    [Parameter(Mandatory=$true)]
    [PSCustomObject]$OperationParams,

    [Parameter(Mandatory=$true)]
    [string]$ResourceGroupName,

    [Parameter(Mandatory=$true)]
    [string]$Location,

    [Parameter(Mandatory=$true)]
    [hashtable]$ResourceNames
)

$ttlResourceGroupName = $ResourceGroupName
$subscriptionId = $AzureParams.subscriptionId
$logicAppName = "la-ttl-cleanup-$($AzureParams.baseObjectName)"

# Check if Logic App already exists
$existingLogicApp = Get-AzResource -ResourceGroupName $ttlResourceGroupName -Name $logicAppName -ResourceType "Microsoft.Logic/workflows" -ErrorAction SilentlyContinue

if ($null -eq $existingLogicApp) {
    try {
        $workflowDefinition = @{
            "`$schema" = "https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#"
            contentVersion = "1.0.0.0"
            parameters = @{}
            triggers = @{
                Recurrence = @{
                    type = "Recurrence"
                    recurrence = @{
                        frequency = "Hour"
                        interval = 1
                    }
                }
            }
            actions = @{
                Get_Resource_Group = @{
                    type = "Http"
                    runAfter = @{}
                    inputs = @{
                        method = "GET"
                        uri = "https://management.azure.com/subscriptions/$subscriptionId/resourceGroups/$ttlResourceGroupName`?api-version=2021-04-01"
                        authentication = @{
                            type = "ManagedServiceIdentity"
                        }
                    }
                }
                Parse_Resource_Group = @{
                    type = "ParseJson"
                    runAfter = @{
                        Get_Resource_Group = @("Succeeded")
                    }
                    inputs = @{
                        content = "@body('Get_Resource_Group')"
                        schema = @{
                            type = "object"
                            properties = @{
                                tags = @{
                                    type = "object"
                                    properties = @{
                                        TTL_Enabled = @{ type = "string" }
                                        TTL_ExpirationTime = @{ type = "string" }
                                    }
                                }
                            }
                        }
                    }
                }
                Check_TTL_Enabled = @{
                    type = "If"
                    runAfter = @{
                        Parse_Resource_Group = @("Succeeded")
                    }
                    expression = @{
                        and = @(
                            @{
                                equals = @(
                                    "@body('Parse_Resource_Group')?['tags']?['TTL_Enabled']"
                                    "true"
                                )
                            }
                        )
                    }
                    actions = @{
                        Check_Expiration = @{
                            type = "If"
                            runAfter = @{}
                            expression = @{
                                and = @(
                                    @{
                                        less = @(
                                            "@body('Parse_Resource_Group')?['tags']?['TTL_ExpirationTime']"
                                            "@utcNow()"
                                        )
                                    }
                                )
                            }
                            actions = @{
                                Delete_Resource_Group = @{
                                    type = "Http"
                                    runAfter = @{}
                                    inputs = @{
                                        method = "DELETE"
                                        uri = "https://management.azure.com/subscriptions/$subscriptionId/resourceGroups/$ttlResourceGroupName`?api-version=2021-04-01"
                                        authentication = @{
                                            type = "ManagedServiceIdentity"
                                        }
                                    }
                                }
                            }
                            else = @{
                                actions = @{}
                            }
                        }
                    }
                    else = @{
                        actions = @{}
                    }
                }
            }
            outputs = @{}
        }

        $armTemplate = @{
            "`$schema" = "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#"
            contentVersion = "1.0.0.0"
            parameters = @{}
            resources = @(
                @{
                    type = "Microsoft.Logic/workflows"
                    apiVersion = "2019-05-01"
                    name = $logicAppName
                    location = $Location
                    identity = @{
                        type = "SystemAssigned"
                    }
                    properties = @{
                        state = "Enabled"
                        definition = $workflowDefinition
                    }
                    tags = @{
                        Purpose = "TTL Cleanup"
                        TargetResourceGroup = $ttlResourceGroupName
                        CreatedBy = "UnifiedLab Deployment"
                    }
                }
            )
        }

        $tempFile = Join-Path $env:TEMP "ttl-logicapp-template-$(Get-Random).json"
        $armTemplate | ConvertTo-Json -Depth 50 | Out-File -FilePath $tempFile -Encoding UTF8

        New-AzResourceGroupDeployment `
            -ResourceGroupName $ttlResourceGroupName `
            -TemplateFile $tempFile `
            -Name "ttl-cleanup-logicapp-$(Get-Date -Format 'yyyyMMddHHmmss')" `
            -ErrorAction Stop | Out-Null

        Remove-Item -Path $tempFile -Force -ErrorAction SilentlyContinue

        Write-ToLog -Message "TTL Logic App created: $logicAppName" -Level "SUCCESS"
    } catch {
        Write-ToLog -Message "Failed to create TTL Logic App: $($_.Exception.Message)" -Level "ERROR"
        throw
    }
}

# Get the Logic App's Managed Identity Principal ID
$logicApp = Get-AzResource -ResourceGroupName $ttlResourceGroupName -Name $logicAppName -ResourceType "Microsoft.Logic/workflows" -ErrorAction Stop
$principalId = $null

$logicAppDetails = Get-AzResource -ResourceId $logicApp.ResourceId -ExpandProperties -ErrorAction SilentlyContinue
if ($logicAppDetails.Identity) {
    $principalId = $logicAppDetails.Identity.PrincipalId
} else {
    $token = (Get-AzAccessToken -ResourceUrl "https://management.azure.com").Token
    $headers = @{ Authorization = "Bearer $token" }
    $uri = "https://management.azure.com/subscriptions/$subscriptionId/resourceGroups/$ttlResourceGroupName/providers/Microsoft.Logic/workflows/$logicAppName`?api-version=2019-05-01"

    try {
        $response = Invoke-RestMethod -Uri $uri -Headers $headers -Method Get
        $principalId = $response.identity.principalId
    } catch {
        Write-ToLog -Message "Could not retrieve Principal ID: $($_.Exception.Message)" -Level "WARNING"
    }
}

# Assign Contributor role to the Logic App's Managed Identity
$roleAssigned = $false
if ($principalId) {
    $scope = "/subscriptions/$subscriptionId/resourceGroups/$ttlResourceGroupName"
    $maxRetries = 5
    $retryCount = 0
    $retryDelay = 15

    while (-not $roleAssigned -and $retryCount -lt $maxRetries) {
        $retryCount++

        try {
            # Check if role already assigned
            $existingAssignment = Get-AzRoleAssignment `
                -ObjectId $principalId `
                -RoleDefinitionName "Contributor" `
                -Scope $scope `
                -ErrorAction SilentlyContinue

            if ($null -ne $existingAssignment) {
                Write-ToLog -Message "TTL Logic App Contributor role already assigned" -Level "SUCCESS"
                $roleAssigned = $true
                break
            }

            # Wait for identity propagation before first attempt
            if ($retryCount -eq 1) {
                Start-Sleep -Seconds $retryDelay
            }

            New-AzRoleAssignment `
                -ObjectId $principalId `
                -RoleDefinitionName "Contributor" `
                -Scope $scope `
                -ErrorAction Stop | Out-Null

            Write-ToLog -Message "TTL Logic App Contributor role assigned" -Level "SUCCESS"
            $roleAssigned = $true

        } catch {
            $errorMsg = $_.Exception.Message

            if ($errorMsg -like "*PrincipalNotFound*" -or $errorMsg -like "*does not exist*") {
                Write-ToLog -Message "Waiting for managed identity propagation (attempt $retryCount/$maxRetries)..." -Level "INFO"
                Start-Sleep -Seconds ($retryDelay * $retryCount)
            } elseif ($errorMsg -like "*Conflict*" -or $errorMsg -like "*already exists*") {
                Write-ToLog -Message "TTL Logic App Contributor role already assigned" -Level "SUCCESS"
                $roleAssigned = $true
            } else {
                Write-ToLog -Message "Role assignment attempt $retryCount failed: $errorMsg" -Level "WARNING"
                if ($retryCount -lt $maxRetries) {
                    Start-Sleep -Seconds $retryDelay
                }
            }
        }
    }

    if (-not $roleAssigned) {
        Write-ToLog -Message "Failed to assign Contributor role after $maxRetries attempts. Manual assignment required." -Level "ERROR"
    }
} else {
    Write-ToLog -Message "Could not get Principal ID - role assignment skipped" -Level "WARNING"
}

return @{
    LogicAppName = $logicAppName
    TargetResourceGroup = $ttlResourceGroupName
    PrincipalId = $principalId
    RoleAssigned = $roleAssigned
    Status = if ($roleAssigned) { "Success" } else { "PartialSuccess" }
}
