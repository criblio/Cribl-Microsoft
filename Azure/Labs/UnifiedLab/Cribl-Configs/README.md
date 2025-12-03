# Cribl Stream Configuration Files

Generated: 2025-12-03 00:42:12
Lab Mode: public
Resource Group: rg-jpederson-eastus-CriblLab
Location: eastus

## Directory Structure

```
Cribl-Configs/
    destinations/
        sentinel/    # DCR-based destinations for Microsoft Sentinel
        adx/         # Azure Data Explorer destinations
    sources/         # Azure data sources (Event Hubs, Storage Queues, Blob Collectors)
```

## Configuration Summary

### Destinations

**Sentinel (DCR-based):**
- See `destinations/sentinel/` for individual DCR destination configs
- These use Azure Monitor Data Collection Rules for ingestion
- Authentication: Azure AD (Client ID/Secret)

**Azure Data Explorer:**
- 1 ADX destination(s) configured
  - Table: CommonSecurityLog

### Sources

**Event Hubs:**
- 3 Event Hub source(s) configured
  - logs-hub
  - metrics-hub
  - events-hub

**Storage Queues:**
- 2 Storage Queue source(s) configured
  - blob-notifications
  - event-processing

**Storage Blob Collectors:**
- 1 Blob Collector source(s) configured
  - criblqueuesource

## Cribl Stream Workspace Secrets Required

The generated configurations use Cribl workspace secrets for sensitive credentials.

### Required Secrets

| Secret Name | Type | Used By |
|-------------|------|---------|
| `Azure_Client_Secret` | Text | ADX, Blob Sources |
| `Azure_EventHub_ConnectionString` | Text | Event Hub Sources |
| `Azure_Storage_AccountKey` | Text | Storage Queue Sources |
| `Azure_vNet_Flowlogs_Secret` | Text | Flow Logs Collection |

