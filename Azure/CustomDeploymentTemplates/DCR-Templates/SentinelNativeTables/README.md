# Sentinel Native Tables - DCR Templates

Pre-built Azure Resource Manager (ARM) templates for creating Data Collection Rules (DCRs) for Microsoft Sentinel native tables. These templates include complete schema definitions for all supported native tables.

## Directory Structure

```
SentinelNativeTables/
 DataCollectionRules(DCE)/ # Templates requiring Data Collection Endpoints
 [50 table templates] # DCE-based DCRs for advanced routing
 DataCollectionRules(NoDCE)/ # Direct DCR templates
 [50 table templates] # Simple, cost-effective Direct DCRs
```

## Template Types

### Direct DCRs (`DataCollectionRules(NoDCE)/`)
- **Type**: `"kind": "Direct"`
- **Use Case**: Simple data ingestion directly to Log Analytics
- **Cost**: Lower (no DCE charges)
- **Complexity**: Simple deployment
- **Name Limit**: 30 characters

### DCE-based DCRs (`DataCollectionRules(DCE)/`)
- **Type**: Requires Data Collection Endpoint
- **Use Case**: Advanced routing, private endpoints
- **Cost**: Higher (DCE + DCR charges)
- **Complexity**: Requires DCE creation first
- **Name Limit**: 64 characters

## Available Templates

### Core Security Tables
- `CommonSecurityLog.json` - CEF/Syslog security events
- `SecurityEvent.json` - Windows security events
- `Syslog.json` - Linux/Unix syslog data
- `WindowsEvent.json` - Windows event logs
- `Event.json` - Legacy Windows events

### Azure Native Tables
- `AzureActivity.json` - Azure resource activity logs
- `AzureDiagnostics.json` - Azure resource diagnostics
- `AzureAssessmentRecommendation.json` - Azure assessments

### Microsoft Defender Tables
- `DeviceEvents.json` - Defender for Endpoint events
- `DeviceFileEvents.json` - File activity events
- `DeviceTvmSecureConfigurationAssessmentKB.json` - TVM assessments
- `DeviceTvmSoftwareVulnerabilitiesKB.json` - Vulnerability data

### Cloud Provider Tables
- `AWSCloudTrail.json` - AWS audit logs
- `AWSCloudWatch.json` - AWS metrics and logs
- `AWSGuardDuty.json` - AWS threat detection
- `AWSVPCFlow.json` - AWS network flow logs
- `GCPAuditLogs.json` - Google Cloud audit logs
- `GoogleCloudSCC.json` - Google Security Command Center

### ASIM (Advanced Security Information Model) Tables
- `ASimAuthenticationEventLogs.json` - Normalized authentication events
- `ASimNetworkSessionLogs.json` - Normalized network sessions
- `ASimProcessEventLogs.json` - Normalized process events
- `ASimDnsActivityLogs.json` - Normalized DNS queries
- `ASimFileEventLogs.json` - Normalized file events
- And more ASIM normalized tables...

### Assessment & Recommendation Tables
- `ADAssessmentRecommendation.json` - Active Directory assessments
- `SQLAssessmentRecommendation.json` - SQL Server assessments
- `ExchangeAssessmentRecommendation.json` - Exchange assessments
- `WindowsServerAssessmentRecommendation.json` - Windows Server assessments
- And more assessment tables...

### Update Management Tables
- `UCClient.json` - Update Compliance client data
- `UCUpdateAlert.json` - Update alerts
- `UCServiceUpdateStatus.json` - Service update status
- And more UC tables...

## Deployment Guide

### Prerequisites
- Azure subscription with appropriate permissions
- Log Analytics workspace created
- For DCE templates: Data Collection Endpoint created

### Option 1: Azure Portal
1. Navigate to Azure Portal → "Deploy a custom template"
2. Click "Build your own template in the editor"
3. Copy the content from your chosen template
4. Click Save
5. Fill in parameters:
 - `dataCollectionRuleName`: Your DCR name
 - `location`: Azure region (must match workspace)
 - `workspaceResourceId`: Full resource ID of workspace
 - `endpointResourceId`: DCE resource ID (DCE templates only)
6. Review and Create

### Option 2: Azure CLI
```bash
# For Direct DCR (no DCE)
az deployment group create \
 --resource-group "your-rg" \
 --template-file "DataCollectionRules(NoDCE)/SecurityEvent.json" \
 --parameters \
 dataCollectionRuleName="dcr-security-events" \
 workspaceResourceId="/subscriptions/.../workspaces/your-workspace"

# For DCE-based DCR
az deployment group create \
 --resource-group "your-rg" \
 --template-file "DataCollectionRules(DCE)/SecurityEvent.json" \
 --parameters \
 dataCollectionRuleName="dcr-security-events" \
 workspaceResourceId="/subscriptions/.../workspaces/your-workspace" \
 endpointResourceId="/subscriptions/.../dataCollectionEndpoints/your-dce"
```

### Option 3: PowerShell
```powershell
# For Direct DCR
New-AzResourceGroupDeployment `
 -ResourceGroupName "your-rg" `
 -TemplateFile "DataCollectionRules(NoDCE)/SecurityEvent.json" `
 -dataCollectionRuleName "dcr-security-events" `
 -workspaceResourceId "/subscriptions/.../workspaces/your-workspace"

# For DCE-based DCR
New-AzResourceGroupDeployment `
 -ResourceGroupName "your-rg" `
 -TemplateFile "DataCollectionRules(DCE)/SecurityEvent.json" `
 -dataCollectionRuleName "dcr-security-events" `
 -workspaceResourceId "/subscriptions/.../workspaces/your-workspace" `
 -endpointResourceId "/subscriptions/.../dataCollectionEndpoints/your-dce"
```

## Template Parameters

### Common Parameters (All Templates)
| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| dataCollectionRuleName | string | Name for the DCR | "dcr-security-events" |
| location | string | Azure region | "eastus" |
| workspaceResourceId | string | Full resource ID of Log Analytics workspace | "/subscriptions/..." |

### Additional for DCE Templates
| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| endpointResourceId | string | Full resource ID of DCE | "/subscriptions/..." |

## Template Structure

Each template contains:
- **Stream Declarations**: Column definitions with names and types
- **Destinations**: Target Log Analytics workspace
- **Data Flows**: Routing from input stream to output table
- **Transform KQL**: Set to "source" (no transformation)

Example stream naming:
- Input: `Custom-{TableName}` (e.g., "Custom-SecurityEvent")
- Output: `Microsoft-{TableName}` (e.g., "Microsoft-SecurityEvent")

## Choosing Between DCE and Direct

### Use Direct DCRs When:
- Simple ingestion requirements
- Cost optimization is important
- No need for private endpoints
- Single destination workspace

### Use DCE-based DCRs When:
- Need private link/endpoints
- Advanced routing required
- Multiple destinations
- Enhanced security requirements

## Important Notes

1. **Name Length Limits**: Direct DCRs limited to 30 characters
2. **Region Matching**: DCR location must match workspace location
3. **Schema Immutability**: Column definitions cannot be changed after creation
4. **DCE Requirement**: DCE must exist before deploying DCE-based templates
5. **Cost Implications**: DCEs incur additional charges

## Related Resources

For automated deployment with dynamic schema retrieval:
- See [DCR-Automation](../../DCR-Automation/) for PowerShell automation
- Supports both template types
- Automatically retrieves current schemas from Azure
- Generates Cribl Stream configurations

## Additional Information

- [Azure Monitor DCR Documentation](https://docs.microsoft.com/azure/azure-monitor/essentials/data-collection-rule)
- [Sentinel Tables Reference](https://docs.microsoft.com/azure/sentinel/data-source-schema)
- [DCE Overview](https://docs.microsoft.com/azure/azure-monitor/essentials/data-collection-endpoint)

---

**Note**: These templates contain static schemas. For dynamic schema retrieval and automated deployment, use the [DCR-Automation](../../DCR-Automation/) PowerShell solution.
