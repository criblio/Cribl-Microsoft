# Cribl Stream Configuration Files

Generated: 2025-12-18 15:25:58
Lab Mode: public
Resource Group: rg-jpederson-WindowsEventSchemaLab
Location: eastus

## Directory Structure

`
Cribl-Configs/
    destinations/
        sentinel/    # DCR-based destinations for Microsoft Sentinel
        adx/         # Azure Data Explorer destinations
    sources/         # Azure data sources (Event Hubs, Storage Queues, Blob Collectors)
`

## Configuration Summary

### Destinations

- ADX Destinations: 0

### Sources

- Event Hub Sources: 0
- Storage Queue Sources: 0
- Storage Blob Sources: 0

## Required Cribl Workspace Secrets

| Secret Name | Type | Used By |
|-------------|------|---------|
| Azure_Client_Secret | Text | ADX Destinations |
| Azure_EventHub_ConnectionString | Text | Event Hub Sources |
| Azure_Blob_Queue_Secret | Text | Blob Queue Source (Event Grid pattern) |
| Azure_Blob_Collector_Secret | Text | Blob Collector Source (scheduled polling) |
| Azure_vNet_Flowlogs_Secret | Text | Flow Logs Collection |
