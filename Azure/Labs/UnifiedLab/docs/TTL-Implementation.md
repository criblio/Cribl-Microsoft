# Time to Live (TTL) Implementation

## Overview

The Unified Azure Lab now supports **Time to Live (TTL)** functionality to automatically track lab expiration and enable automated cleanup via Azure Function Apps. This prevents forgotten labs from accumulating costs.

## Architecture

### Phase 1: Tagging Infrastructure (COMPLETED)
- Resource Groups are tagged with TTL metadata during deployment
- Tags include expiration time, warning time, and user email
- Users can extend lab life by updating tags in Azure Portal

### Phase 2: Automated Cleanup (PENDING)
- Azure Function App scans subscription for expired labs
- Sends warning emails 24 hours before deletion
- Automatically deletes Resource Groups after expiration

## Configuration

### azure-parameters.json

TTL is configured at the root level of `azure-parameters.json`:

```json
{
 "timeToLive": {
 "enabled": false,
 "_enabledComment": "When true, tags resource group with expiration time for automated cleanup",
 "hours": 72,
 "_hoursComment": "Lab will be automatically deleted after this many hours (default: 72 = 3 days)",
 "userEmail": "<YOUR-EMAIL-HERE>",
 "_userEmailComment": "Email address to receive TTL warnings 24 hours before deletion",
 "warningHours": 24,
 "_warningHoursComment": "Send warning email this many hours before deletion (default: 24)"
 }
}
```

### Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `enabled` | boolean | `false` | Master switch for TTL functionality |
| `hours` | number | `72` | Lab lifetime in hours (72 hours = 3 days) |
| `userEmail` | string | Required | Email to receive deletion warnings |
| `warningHours` | number | `24` | Hours before deletion to send warning |

## Resource Group Tags

When TTL is enabled, the following tags are applied to the Resource Group:

### Base Tags (Always Applied)
```powershell
Environment = "Lab"
ManagedBy = "UnifiedAzureLab"
CreatedDate = "2025-10-25T14:30:00Z" # UTC timestamp
```

### TTL Tags (When Enabled)
```powershell
TTL_Enabled = "true"
TTL_ExpirationTime = "2025-10-28T14:30:00Z" # CreatedDate + hours
TTL_WarningTime = "2025-10-27T14:30:00Z" # ExpirationTime - warningHours
TTL_UserEmail = "user@example.com"
TTL_Hours = "72"
```

## Deployment Behavior

### New Resource Group Creation

When creating a new Resource Group with TTL enabled:

```
 Creating Resource Group: UnifiedLab-RG
⏰ TTL Enabled: Lab will expire in 72 hours
 Expiration: 2025-10-28 14:30:00 UTC
 Warning Email: user@example.com
 Resource Group created successfully!
 Warning email will be sent 24 hours before deletion
 To extend TTL: Update the 'TTL_ExpirationTime' tag on the Resource Group
```

### Existing Resource Group

When TTL is enabled and the Resource Group already exists:

**Scenario 1: No TTL Tags Present**
```
 Resource Group 'UnifiedLab-RG' already exists
⏰ Adding TTL tags to existing Resource Group...
 TTL tags added: Lab will expire in 72 hours
 Expiration: 2025-10-28 14:30:00 UTC
```

**Scenario 2: TTL Already Configured**
```
 Resource Group 'UnifiedLab-RG' already exists
 TTL already configured on this Resource Group
 Current Expiration: 2025-10-28T14:30:00Z
 To extend: Update 'TTL_ExpirationTime' tag in Azure Portal
```

## Menu Display

The configuration summary in the interactive menu displays TTL status:

### TTL Enabled
```
⏰ Time to Live (TTL):
 Status: ENABLED
 Duration: 72 hours (3 days)
 Email: user@example.com
 Warning: 24 hours before deletion
 Resource Group will be auto-deleted after TTL expires
 Warning email sent 24 hours before deletion
 Extend TTL: Update 'TTL_ExpirationTime' tag in Azure Portal
```

### TTL Disabled
```
⏰ Time to Live (TTL): DISABLED
 Enable in azure-parameters.json to auto-delete lab after expiration
```

## Extending Lab Lifetime

Users can extend their lab's lifetime without redeployment:

### Method 1: Azure Portal (Recommended)
1. Navigate to your Resource Group in Azure Portal
2. Click **Tags** in the left navigation
3. Find the `TTL_ExpirationTime` tag
4. Update the value to a new UTC timestamp (format: `YYYY-MM-DDTHH:mm:ssZ`)
5. Click **Save**

Example: To extend by 24 hours, add 24 hours to the current timestamp:
- Current: `2025-10-28T14:30:00Z`
- New: `2025-10-29T14:30:00Z`

### Method 2: Azure CLI
```bash
# Get current tags
az group show --name UnifiedLab-RG --query tags

# Calculate new expiration (add 24 hours)
NEW_EXPIRATION="2025-10-29T14:30:00Z"

# Update tag
az group update --name UnifiedLab-RG \
 --set tags.TTL_ExpirationTime=$NEW_EXPIRATION
```

### Method 3: PowerShell
```powershell
# Get Resource Group
$rg = Get-AzResourceGroup -Name "UnifiedLab-RG"

# Update expiration tag
$rg.Tags["TTL_ExpirationTime"] = "2025-10-29T14:30:00Z"

# Apply changes
Set-AzResourceGroup -Name "UnifiedLab-RG" -Tag $rg.Tags
```

## Implementation Files

### 1. azure-parameters.json
**Location**: `Azure/dev/LabAutomation/UnifiedLab/prod/azure-parameters.json`
**Purpose**: TTL configuration storage
**Modified**: Added `timeToLive` section at root level

### 2. Deploy-Infrastructure.ps1
**Location**: `Azure/dev/LabAutomation/UnifiedLab/prod/Deploy-Infrastructure.ps1`
**Purpose**: Apply TTL tags during Resource Group creation
**Modified**: Complete rewrite of `Ensure-ResourceGroup` function
**Key Changes**:
- Calculates expiration and warning times
- Applies TTL tags to new Resource Groups
- Updates existing Resource Groups with TTL tags
- Displays TTL information during deployment
- Detects existing TTL configuration

### 3. Menu-Framework.ps1
**Location**: `Azure/dev/LabAutomation/UnifiedLab/Core/Menu-Framework.ps1`
**Purpose**: Display TTL status in interactive menu
**Modified**: Updated `Show-ConfigurationSummary` function
**Key Changes**:
- Shows TTL enabled/disabled status
- Displays duration, email, and warning settings
- Provides guidance on extending TTL
- Color-coded warnings

## Future: Azure Function App Cleanup

### Planned Functionality

The Function App will run on a timer trigger (every hour) and perform these actions:

1. **Scan for TTL-Enabled Resource Groups**
 ```powershell
 Get-AzResourceGroup | Where-Object {
 $_.Tags["TTL_Enabled"] -eq "true"
 }
 ```

2. **Send Warning Emails**
 - Check if current time > TTL_WarningTime
 - Send email via SendGrid/Azure Communication Services
 - Include current expiration time and extension instructions

3. **Delete Expired Labs**
 - Check if current time > TTL_ExpirationTime
 - Remove Resource Group and all contained resources
 - Send confirmation email to user

### Email Templates

**Warning Email (24 hours before deletion)**
```
Subject: [Action Required] Your Azure Lab Expires in 24 Hours

Dear Lab User,

Your Azure lab environment will be automatically deleted in 24 hours:

Lab Details:
- Resource Group: UnifiedLab-RG
- Expiration: 2025-10-28 14:30:00 UTC
- Time Remaining: 24 hours

To extend your lab's lifetime:
1. Go to Azure Portal → Resource Groups → UnifiedLab-RG → Tags
2. Update the 'TTL_ExpirationTime' tag to a new timestamp
3. Save changes

Example: To extend by 24 hours, change:
 2025-10-28T14:30:00Z → 2025-10-29T14:30:00Z

Need Help? Contact: support@example.com
```

**Deletion Confirmation Email**
```
Subject: Your Azure Lab Has Been Deleted

Dear Lab User,

Your Azure lab environment has been automatically deleted as scheduled:

Lab Details:
- Resource Group: UnifiedLab-RG
- Deletion Time: 2025-10-28 14:30:00 UTC
- Total Runtime: 72 hours (3 days)

All resources in this Resource Group have been removed.

To create a new lab, run the Unified Lab deployment script.

Questions? Contact: support@example.com
```

## Cost Savings

### Example Scenarios

**Scenario 1: Forgotten Sentinel Lab**
- Monthly Cost: $40-60/month
- Without TTL: Runs indefinitely, costs $480-720/year
- With TTL (3-day limit): Auto-deleted after 3 days, prevents waste

**Scenario 2: Forgotten ADX Lab**
- Monthly Cost: ~$300/month
- Without TTL: Runs indefinitely, costs $3,600/year
- With TTL (3-day limit): Auto-deleted, saves $3,580+

**Scenario 3: Multiple Forgotten Labs**
- 10 forgotten labs averaging $50/month each
- Annual waste: $6,000
- TTL prevents: Automatic cleanup after configured hours

## Best Practices

1. **Enable TTL for All Labs**: Set `enabled: true` in azure-parameters.json
2. **Appropriate Durations**:
 - Quick tests: 24-48 hours
 - Learning/training: 72 hours (3 days)
 - Active development: 168 hours (7 days)
3. **Valid Email**: Ensure `userEmail` is monitored for warnings
4. **Calendar Reminders**: Set personal reminders before expiration
5. **Tag Monitoring**: Check Resource Group tags periodically
6. **Extend Early**: Update tags before warning period for peace of mind

## Security Considerations

1. **Email Privacy**: User emails stored in Resource Group tags (subscription-level access only)
2. **Automated Deletion**: Only targets Resource Groups with `TTL_Enabled = "true"`
3. **No Accidental Deletion**: Function App will validate all criteria before deletion
4. **Audit Trail**: Azure Activity Log records all tag updates and deletions
5. **Recovery**: Deleted Resource Groups cannot be recovered (by design)

## Troubleshooting

### TTL Tags Not Applied
**Problem**: Resource Group created without TTL tags
**Solution**:
1. Verify `timeToLive.enabled = true` in azure-parameters.json
2. Check for PowerShell errors during deployment
3. Manually apply tags using Azure Portal or CLI

### Warning Email Not Received
**Problem**: No email sent at warning time
**Solution**: (Function App not yet implemented)
1. Verify email address in `TTL_UserEmail` tag
2. Check Function App logs for errors
3. Verify SendGrid/Communication Services configuration

### Lab Deleted Too Early
**Problem**: Lab deleted before expected expiration
**Solution**:
1. Check `TTL_ExpirationTime` tag value
2. Verify timezone (all times are UTC)
3. Review Azure Activity Log for deletion event

### Cannot Extend TTL
**Problem**: Tag update fails in Azure Portal
**Solution**:
1. Verify you have Contributor/Owner role on Resource Group
2. Check tag value format: `YYYY-MM-DDTHH:mm:ssZ`
3. Ensure timestamp is in future
4. Use UTC timezone

## Migration Guide

### Enabling TTL on Existing Deployments

If you have existing labs without TTL:

1. **Update Configuration**
 ```json
 "timeToLive": {
 "enabled": true,
 "hours": 72,
 "userEmail": "your-email@example.com",
 "warningHours": 24
 }
 ```

2. **Redeploy Infrastructure** (tags will be added to existing RG)
 ```powershell
 .\Run-AzureUnifiedLab.ps1
 # Choose any lab option - infrastructure ensures RG tags
 ```

3. **Or Manually Apply Tags** (Azure Portal)
 - Navigate to Resource Group → Tags
 - Add all TTL tags manually (see "Resource Group Tags" section)

### Disabling TTL

To disable TTL without deleting Resource Group:

1. **Update Configuration**
 ```json
 "timeToLive": {
 "enabled": false
 }
 ```

2. **Remove Tags** (Azure Portal or CLI)
 ```powershell
 $rg = Get-AzResourceGroup -Name "UnifiedLab-RG"
 $rg.Tags.Remove("TTL_Enabled")
 $rg.Tags.Remove("TTL_ExpirationTime")
 $rg.Tags.Remove("TTL_WarningTime")
 $rg.Tags.Remove("TTL_UserEmail")
 $rg.Tags.Remove("TTL_Hours")
 Set-AzResourceGroup -Name "UnifiedLab-RG" -Tag $rg.Tags
 ```

## Testing

### Test TTL Tagging

```powershell
# 1. Enable TTL in azure-parameters.json
# 2. Deploy any lab
.\Run-AzureUnifiedLab.ps1

# 3. Verify tags
$rg = Get-AzResourceGroup -Name "UnifiedLab-RG"
$rg.Tags | Format-Table

# Expected output:
# Name Value
# ---- -----
# Environment Lab
# ManagedBy UnifiedAzureLab
# CreatedDate 2025-10-25T14:30:00Z
# TTL_Enabled true
# TTL_ExpirationTime 2025-10-28T14:30:00Z
# TTL_WarningTime 2025-10-27T14:30:00Z
# TTL_UserEmail user@example.com
# TTL_Hours 72
```

### Test TTL Extension

```powershell
# 1. Get current expiration
$rg = Get-AzResourceGroup -Name "UnifiedLab-RG"
$currentExpiration = $rg.Tags["TTL_ExpirationTime"]
Write-Host "Current: $currentExpiration"

# 2. Calculate new expiration (+24 hours)
$newExpiration = ([DateTime]::Parse($currentExpiration)).AddHours(24).ToString("yyyy-MM-ddTHH:mm:ssZ")
Write-Host "New: $newExpiration"

# 3. Update tag
$rg.Tags["TTL_ExpirationTime"] = $newExpiration
Set-AzResourceGroup -Name "UnifiedLab-RG" -Tag $rg.Tags

# 4. Verify update
(Get-AzResourceGroup -Name "UnifiedLab-RG").Tags["TTL_ExpirationTime"]
```

## Related Documentation

- [Azure Resource Group Tagging Best Practices](https://learn.microsoft.com/en-us/azure/azure-resource-manager/management/tag-resources)
- [Azure Function App Timer Triggers](https://learn.microsoft.com/en-us/azure/azure-functions/functions-bindings-timer)
- [Azure Communication Services Email](https://learn.microsoft.com/en-us/azure/communication-services/concepts/email/email-overview)

## Changelog

### Version 1.0 (2025-10-25)
- Initial TTL implementation
- Resource Group tagging in Deploy-Infrastructure.ps1
- Menu display in Menu-Framework.ps1
- Configuration in azure-parameters.json
- Documentation created

### Upcoming (Version 1.1)
- Azure Function App cleanup automation
- Email notification system
- PowerShell module for TTL management
- Extended monitoring and reporting
