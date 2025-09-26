# Cribl Sentinel Destination Configuration Generator

## Overview
This feature automatically generates ready-to-use Cribl Stream destination configuration files for Microsoft Sentinel integration. Each DCR gets its own JSON configuration file that can be directly imported into Cribl Stream.

## Files Involved

### Core Files
- **`dst-cribl-template.json`** - Template for Cribl Sentinel destination configuration
- **`azure-parameters.json`** - Azure resources and authentication (tenantId, clientId, clientSecret)
- **`cribl-parameters.json`** - Cribl-specific naming conventions (IDprefix, IDsuffix)
- **`Generate-CriblDestinations.ps1`** - Script to generate individual destination configs

### Generated Output Structure
```
cribl-dcr-configs/
├── cribl-dcr-config.json          # DCR summary (existing)
└── destinations/                   # NEW: Cribl destination configs
    ├── azure_sentinel_commonsecuritylog_dest.json
    ├── azure_sentinel_securityevent_dest.json
    ├── azure_sentinel_syslog_dest.json
    ├── azure_sentinel_windowsevent_dest.json
    ├── azure_sentinel_cloudflare_dest.json
    ├── destinations-summary.json
    └── destinations-metadata.json
```

## Setup Instructions

### 1. Configure Azure Authentication
Edit `azure-parameters.json` with your Azure AD details:

```json
{
  "resourceGroupName": "your-rg",
  "workspaceName": "your-workspace",
  "location": "eastus",
  "tenantId": "YOUR-ACTUAL-TENANT-ID",
  "clientId": "YOUR-APP-REGISTRATION-CLIENT-ID",
  "clientSecret": "YOUR-APP-CLIENT-SECRET",
  ...
}
```

### 2. Configure Cribl Naming (Optional)
Edit `cribl-parameters.json` to customize destination naming:

```json
{
  "IDprefix": "azure_sentinel_",
  "IDsuffix": "_dest"
}
```

This will create destination IDs like: `azure_sentinel_syslog_dest`

### 3. Apply the Auto-Generation Patch (Optional)
To enable automatic generation during DCR deployment:

```powershell
.\Patch-AutoGenerateCriblDest.ps1
```

### 4. Run DCR Deployment
Deploy your DCRs as usual:

```powershell
.\Run-DCRAutomation.ps1 -Mode DirectBoth
```

The destination configs will be automatically generated in `cribl-dcr-configs\destinations\`

## Manual Generation

If you need to regenerate the Cribl configs manually:

```powershell
.\Generate-CriblDestinations.ps1
```

Options:
- `-ShowConfig` - Display generated configs in console
- `-OutputDirectory` - Change output location (default: cribl-dcr-configs)
- `-AzureParametersFile` - Use different Azure parameters file
- `-CriblParametersFile` - Use different Cribl parameters file

## Using the Generated Configs in Cribl Stream

### Method 1: Import Individual Destinations
1. Open one of the generated JSON files (e.g., `azure_sentinel_syslog_dest.json`)
2. Copy the entire JSON content
3. In Cribl Stream:
   - Navigate to **Destinations** → **Microsoft Sentinel**
   - Click **Add Destination** → **Import from JSON**
   - Paste the JSON content
   - Click **Save**

### Method 2: Bulk Import via Git
1. Commit the `destinations` folder to your Cribl Stream git repository
2. Place files in: `groups/[your-group]/cribl/outputs/`
3. Deploy changes through Cribl Stream

## Configuration Details

### Parameter Sources
- **Authentication** (tenantId, clientId, clientSecret): From `azure-parameters.json`
- **Naming Convention** (IDprefix, IDsuffix): From `cribl-parameters.json`
- **DCR Details** (immutableId, streamName, endpoint): From deployed DCRs

### Destination ID Format
Each destination gets a unique ID based on the table name:
- Pattern: `[IDprefix][tablename][IDsuffix]`
- Example: `azure_sentinel_securityevent_dest`

### Generated Fields
Each config includes:
- **id**: Unique destination identifier
- **dceEndpoint**: DCE ingestion URL
- **dcrID**: DCR Immutable ID
- **streamName**: Input stream name (e.g., Custom-SecurityEvent)
- **client_id**: From azure-parameters.json
- **secret**: From azure-parameters.json
- **loginUrl**: Built using tenantId from azure-parameters.json
- **url**: Full API endpoint for data ingestion

## Example Generated Config

```json
{
  "id": "azure_sentinel_securityevent_dest",
  "systemFields": [],
  "streamtags": [],
  "keepAlive": true,
  "concurrency": 5,
  "maxPayloadSizeKB": 1000,
  "maxPayloadEvents": 0,
  "compress": true,
  "rejectUnauthorized": true,
  "timeoutSec": 30,
  "flushPeriodSec": 1,
  "useRoundRobinDns": false,
  "failedRequestLoggingMode": "none",
  "safeHeaders": [],
  "responseRetrySettings": [],
  "timeoutRetrySettings": {
    "timeoutRetry": false
  },
  "responseHonorRetryAfterHeader": false,
  "onBackpressure": "drop",
  "scope": "https://monitor.azure.com/.default",
  "endpointURLConfiguration": "ID",
  "type": "sentinel",
  "dceEndpoint": "https://eastus.ingest.monitor.azure.com",
  "dcrID": "dcr-abc123def456...",
  "streamName": "Custom-SecurityEvent",
  "client_id": "your-client-id-here",
  "secret": "your-secret-here",
  "loginUrl": "https://login.microsoftonline.com/your-tenant-id/oauth2/v2.0/token",
  "url": "https://eastus.ingest.monitor.azure.com/dataCollectionRules/dcr-abc123.../streams/Custom-SecurityEvent?api-version=2021-11-01-preview"
}
```

## Troubleshooting

### Missing Authentication
If configs have placeholder values (`'replaceme'`):
1. Check `azure-parameters.json` has actual values for tenantId, clientId, clientSecret
2. Re-run: `.\Generate-CriblDestinations.ps1`

### Missing Stream or Table Names
If configs are missing stream/table names:
1. Run: `.\Run-DCRAutomation.ps1 -Mode CollectCribl`
2. Then regenerate: `.\Generate-CriblDestinations.ps1`

### Authentication Issues
- Ensure Azure AD App Registration has "Monitoring Metrics Publisher" role on DCRs
- Verify tenant ID is correct in azure-parameters.json
- Check client secret hasn't expired

### Skipped Configurations
Configs are skipped when:
- DCR is missing immutable ID
- Stream name is not available
- Ingestion endpoint needs manual configuration

Check `destinations-summary.json` for details on skipped configs.

## Security Notes

⚠️ **Important**: The `azure-parameters.json` file contains sensitive credentials. 
- Never commit this file with actual secrets to version control
- Consider using environment variables or Azure Key Vault
- In Cribl Stream, use secret management for the client secret
- Add `azure-parameters.json` to `.gitignore`

## File Separation Logic

The configuration is split across two files for better security and organization:

- **`azure-parameters.json`**: Contains all Azure-specific settings including sensitive authentication details. This file should be protected and not committed to version control with real values.

- **`cribl-parameters.json`**: Contains only Cribl-specific naming conventions. This file is safe to commit to version control as it contains no sensitive information.

## Next Steps

After generating configs:
1. Review generated files in `cribl-dcr-configs\destinations\`
2. Import destinations into Cribl Stream
3. Create Routes to send appropriate data to each destination
4. Test with sample data
5. Monitor ingestion in Azure Log Analytics

## Support

For issues or questions:
- Check `destinations-metadata.json` for generation details
- Review `destinations-summary.json` for list of generated configs
- Review DCR status: `.\Run-DCRAutomation.ps1 -Mode ValidateCribl`
- Verify template: `dst-cribl-template.json` has all required fields
- Ensure `azure-parameters.json` has authentication configured
