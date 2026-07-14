# Azure vNet Flow Log Discovery & Cribl Destination Generator

This PowerShell automation tool discovers Azure Storage Accounts containing vNet Flow Logs and automatically generates Cribl Stream destination configurations for each discovered storage account.

## Overview

Azure vNet Flow Logs are stored in blob storage containers with the name `insights-logs-flowlogflowevent`. This tool:

1. **Scans** all Azure subscriptions accessible to your session
2. **Discovers** storage accounts containing vNet Flow Log containers
3. **Generates** ready-to-import Cribl Stream destination configurations
4. **Reminds** you to assign required permissions

## File Structure

```
vNetFlowLogDiscovery/
 Run-vNetFlowLogDiscovery.ps1 # Main entry point with interactive menu
 Discover-vNetFlowLogs.ps1 # Core discovery and generation engine
 azure-parameters.json # Azure AD authentication config (CONFIGURE THIS)
 CriblDestinationExample.json # Template for Cribl destinations
 cribl-destinations/ # Generated configurations (auto-created)
 Azure_vNet_FlowLogs_<StorageAccount>.json
 discovery-summary.json
 README.md # This documentation
```

## Configuration

### azure-parameters.json (REQUIRED)

Update this file with your Azure AD app registration details:

```json
{
 "tenantId": "your-tenant-id-guid",
 "clientId": "your-client-id-guid"
}
```

**Important:**
- `tenantId`: Your Azure AD tenant ID
- `clientId`: Your Azure App Registration client ID (used for Cribl authentication)
- The client secret is referenced via Cribl secret name (configured in `CriblDestinationExample.json`)

### CriblDestinationExample.json (Template)

This file serves as the template for all generated destinations. Key settings:
- `textSecret` and `clientTextSecret`: The name of the Cribl secret containing your Azure client secret (default: `Azure_vNet_Flowlogs_Secret`)
- `path`: The blob path pattern for vNet Flow Logs
- `schedule`: Collection schedule (default: every hour at 15 minutes past)
- `pipeline` and `breakerRulesets`: Cribl processing configuration

**To customize:** Edit this template before running discovery. All generated destinations will inherit these settings.

## Required Permissions

### For Running the Discovery Script

Your Azure account needs:
- **Reader** role on subscriptions (to list storage accounts)
- **Storage Account Contributor** or **Reader** role (to list containers)

### For Cribl Stream to Access vNet Flow Logs

Your App Registration must have:
- **Storage Blob Data Reader** role assigned to **each storage account** containing vNet Flow Logs

 **The script will remind you to assign these permissions after discovery**

## Usage

### Interactive Mode (Recommended)

```powershell
.\Run-vNetFlowLogDiscovery.ps1
```

This launches an interactive menu where you can:
1. Review your configuration
2. Confirm before running discovery
3. See progress as storage accounts are scanned

### Non-Interactive Mode

```powershell
.\Run-vNetFlowLogDiscovery.ps1 -NonInteractive
```

Runs discovery automatically without prompts (useful for automation).

### Direct Execution

```powershell
.\Discover-vNetFlowLogs.ps1
```

Runs the core discovery script directly.

## What Gets Generated

For each storage account with vNet Flow Logs, the script creates:

### Individual Destination Files

`cribl-destinations/Azure_vNet_FlowLogs_<StorageAccountName>.json`

Each file contains a complete Cribl Stream destination configuration based on `CriblDestinationExample.json` with:
- Storage account name
- Container name (`insights-logs-flowlogflowevent`)
- Azure AD authentication settings (tenant ID and client ID)
- Secret reference (e.g., `Azure_vNet_Flowlogs_Secret`) - inherited from template

### Discovery Summary

`cribl-destinations/discovery-summary.json`

Contains:
- Discovery timestamp
- List of all discovered storage accounts
- Subscription details
- Generated destination IDs
- Authentication configuration used

## Workflow

1. **Configure azure-parameters.json**
 - Add your tenant ID
 - Add your client ID

2. **Run the discovery tool**
 ```powershell
 .\Run-vNetFlowLogDiscovery.ps1
 ```

 ** Interactive Authentication:**
 - The script will automatically detect if you need to authenticate
 - It will prompt you to sign in to the correct tenant if needed
 - Alternatively, you can authenticate manually beforehand:
 ```powershell
 Connect-AzAccount -TenantId <your-tenant-id>
 ```

3. **Review discovered storage accounts**
 - The script will list all storage accounts with vNet Flow Logs
 - Check the console output for details

4. **Assign Storage Blob Data Reader permissions**
 - For EACH storage account discovered
 - Assign the role to your App Registration
 - See "Assigning Permissions" section below

5. **Configure Cribl secret**
 - The generated destinations reference a Cribl secret (e.g., `Azure_vNet_Flowlogs_Secret`)
 - Create this secret in Cribl Stream with your Azure App Registration client secret
 - The secret name is defined in `CriblDestinationExample.json` template

6. **Import to Cribl Stream**
 - Import the destination configurations
 - Test connectivity

## Assigning Permissions

For each storage account discovered, you need to assign the **Storage Blob Data Reader** role:

### Via Azure Portal

1. Navigate to the Storage Account
2. Click **Access Control (IAM)**
3. Click **Add role assignment**
4. Select **Storage Blob Data Reader**
5. Click **Next**
6. Select **User, group, or service principal**
7. Click **+ Select members**
8. Search for your App Registration by name or client ID
9. Click **Select**
10. Click **Review + assign**

### Via Azure CLI

```bash
az role assignment create \
 --role "Storage Blob Data Reader" \
 --assignee <your-client-id> \
 --scope /subscriptions/<subscription-id>/resourceGroups/<rg-name>/providers/Microsoft.Storage/storageAccounts/<storage-account-name>
```

### Via PowerShell

```powershell
New-AzRoleAssignment `
 -ApplicationId "<your-client-id>" `
 -RoleDefinitionName "Storage Blob Data Reader" `
 -Scope "/subscriptions/<subscription-id>/resourceGroups/<rg-name>/providers/Microsoft.Storage/storageAccounts/<storage-account-name>"
```

## Example Output

```
 Discovering vNet Flow Log Storage Accounts...
======================================================================

 Found 3 subscription(s) to scan

 Scanning subscription: Production (12345678-1234-1234-1234-123456789abc)
 Found 5 storage account(s) to check
 Checking: stprodvnetlogs001... Found vNet Flow Logs!
 Checking: stprodgeneral001... ⏭ No Flow Logs

======================================================================
 DISCOVERY SUMMARY
======================================================================

 Found 2 storage account(s) with vNet Flow Logs

 stprodvnetlogs001
 Subscription: Production
 Resource Group: rg-networking-prod
 Location: eastus

 stdevvnetlogs001
 Subscription: Development
 Resource Group: rg-networking-dev
 Location: westus2

 Generating Cribl Destination Configurations...
======================================================================

 Generating destination for: stprodvnetlogs001
 Saved: Azure_vNet_FlowLogs_stprodvnetlogs001.json

 Generating destination for: stdevvnetlogs001
 Saved: Azure_vNet_FlowLogs_stdevvnetlogs001.json

======================================================================
 CRIBL DESTINATION GENERATION COMPLETE
======================================================================

 IMPORTANT - REQUIRED PERMISSIONS
======================================================================

Before using these Cribl destinations, ensure your App Registration has:

 'Storage Blob Data Reader' role
 assigned to EACH storage account listed above

Without this permission, Cribl will not be able to read the vNet Flow Logs.
```

## Customizing the Template

The `CriblDestinationExample.json` file serves as the template for all generated destinations.

**Key behavior:** If you modify this template, all future destination generations will automatically use the updated template structure.

Common customizations:
- Schedule settings (`cronSchedule`)
- Time ranges (`earliest`, `latest`)
- Batch sizes (`maxBatchSize`)
- Pipeline configurations
- Breakpoint rulesets

## Troubleshooting

### "No Azure context found" or "Connected to wrong tenant!"

**The script handles this automatically!**

When you run the discovery tool, it will:
1. Detect if you're not authenticated or connected to the wrong tenant
2. Prompt you: "Would you like to authenticate now? (Y/N)"
3. If you choose **Y**, it will automatically run `Connect-AzAccount -TenantId <configured-tenant-id>`
4. Open your browser for authentication
5. Continue with discovery once authenticated

**Manual Authentication (Optional):**
If you prefer to authenticate beforehand:
```powershell
Connect-AzAccount -TenantId <your-tenant-id>
```

**Switching Tenants:**
If already connected to the wrong tenant:
```powershell
# Disconnect first
Disconnect-AzAccount

# The script will then prompt you to authenticate to the correct tenant
# Or authenticate manually:
Connect-AzAccount -TenantId <your-tenant-id-from-config>
```

### "No storage accounts with vNet Flow Logs were found"

**Possible causes:**
- vNet Flow Logs are not enabled in your Azure environment
- Storage accounts use a different container name
- Your account doesn't have permission to list containers

**Solution:** Verify vNet Flow Logs are configured and enabled in your Azure environment.

### Generated destinations don't work in Cribl

**Check:**
1. Did you create the Cribl secret referenced in the destinations (e.g., `Azure_vNet_Flowlogs_Secret`)?
2. Does the Cribl secret contain the correct Azure App Registration client secret?
3. Did you assign **Storage Blob Data Reader** role to the App Registration on each storage account?
4. Is the App Registration enabled and not expired?
5. Are the tenant ID and client ID correct in the destination files?

## Notes

- The script scans **all subscriptions** your Azure account can access in the specified tenant
- Discovery is read-only and makes no changes to Azure resources
- Generated destination IDs follow the pattern: `Azure_vNet_FlowLogs_<StorageAccountName>`
- The container name `insights-logs-flowlogflowevent` is the Azure default for vNet Flow Logs
- Secret references (not actual secrets) are included - configure the secret in Cribl Stream
- All destinations inherit settings from `CriblDestinationExample.json` template

## Integration with Cribl Stream

The generated destination configurations are designed to work with Cribl Stream's Azure Blob Storage collector. Each destination:

1. **Connects** to the storage account using Azure AD authentication (clientId + secret reference)
2. **Reads** from the `insights-logs-flowlogflowevent` container
3. **Processes** vNet Flow Log data using the configured pipeline
4. **Applies** any specified breakpoint rulesets

### Setting Up in Cribl Stream

1. **Create the secret** referenced in destinations (default: `Azure_vNet_Flowlogs_Secret`):
 - In Cribl Stream, go to **Settings → Secrets**
 - Create a new secret with the name from your template
 - Set the value to your Azure App Registration client secret

2. **Import destinations**:
 - Go to **Data → Sources → Add Source → Azure Blob Storage**
 - Import the generated JSON files
 - Or manually create sources using the configuration values

3. **Verify prerequisites**:
 - Pipeline exists: `Azure_vNet_FlowLogs_PreProcessing`
 - Breaker ruleset exists: `Azure_vNet_FlowLogs`
 - If not, create or update the template before regenerating

## Additional Resources

- [Azure vNet Flow Logs Documentation](https://docs.microsoft.com/azure/network-watcher/network-watcher-nsg-flow-logging-overview)
- [Cribl Azure Blob Storage Collector](https://docs.cribl.io/stream/sources-azure-blob/)
- [Azure Storage Blob Data Reader Role](https://docs.microsoft.com/azure/role-based-access-control/built-in-roles#storage-blob-data-reader)

---

**Version:** 1.0.0
**Last Updated:** 2025-10-08
