# Manual Setup Guide - Azure Log Collection

This guide provides step-by-step instructions for manually configuring Azure diagnostic logging to Event Hubs without using the PowerShell automation scripts. Use this guide if you cannot run PowerShell scripts in your environment or prefer portal-based configuration.

## Table of Contents

1. [Overview](#overview)
2. [Prerequisites](#prerequisites)
3. [Phase 1: Create Event Hub Infrastructure](#phase-1-create-event-hub-infrastructure)
4. [Phase 2: Deploy Built-in Policy Initiative](#phase-2-deploy-built-in-policy-initiative)
5. [Phase 3: Deploy Community Policies (Extended Coverage)](#phase-3-deploy-community-policies-extended-coverage)
6. [Phase 4: Configure Activity Log](#phase-4-configure-activity-log)
7. [Phase 5: Configure Entra ID Logging](#phase-5-configure-entra-id-logging)
8. [Phase 6: Configure Defender for Cloud Export](#phase-6-configure-defender-for-cloud-export)
9. [Phase 7: Configure Defender XDR Streaming](#phase-7-configure-defender-xdr-streaming)
10. [Phase 8: Remediate Existing Resources](#phase-8-remediate-existing-resources)
11. [Phase 9: Configure Cribl Stream](#phase-9-configure-cribl-stream)
12. [Appendix: Policy Definition Downloads](#appendix-policy-definition-downloads)

---

## Overview

### What This Solution Accomplishes

This solution configures Azure to automatically stream diagnostic logs from your resources to Event Hubs, where Cribl Stream can ingest and process them. The complete setup provides:

| Component | Coverage | Method |
|-----------|----------|--------|
| Azure Resource Logs | 69 resource types | Built-in Policy Initiative |
| Extended Resources | 44 additional types | Community Policy Initiative |
| Activity Log | All subscriptions | Subscription Diagnostic Settings |
| Entra ID (Azure AD) | Tenant-wide | Tenant Diagnostic Settings |
| Defender for Cloud | Security alerts | Continuous Export |
| Defender XDR | Endpoint/Identity/Email | Streaming API |

### Architecture Overview

```
Azure Resources ──> Diagnostic Settings ──> Event Hub Namespace ──> Cribl Stream
                                                    │
                    Policy-based automation         │
                    (DeployIfNotExists)             │
                                                    v
                                            Processing & Routing
                                                    │
                                                    v
                                            Destinations (Splunk, S3, etc.)
```

---

## Prerequisites

### Required Azure Permissions

| Scope | Role | Purpose |
|-------|------|---------|
| Management Group | Policy Contributor | Create policy assignments |
| Management Group | User Access Administrator | Assign roles to managed identity |
| Event Hub Subscription | Contributor | Create Event Hub Namespaces |
| Entra ID | Global Administrator or Security Administrator | Configure Entra ID diagnostics |

### Information You Need

Before starting, gather the following:

- [ ] **Management Group ID**: Where policies will be assigned
- [ ] **Subscription ID**: Where Event Hub Namespaces will be created
- [ ] **Region(s)**: Where to deploy Event Hub infrastructure
- [ ] **Resource Group Name**: For Event Hub Namespace (create if needed)
- [ ] **Naming Convention**: Prefix for your Event Hub Namespaces

---

## Phase 1: Create Event Hub Infrastructure

### Step 1.1: Create Resource Group

1. Navigate to **Azure Portal** > **Resource Groups**
2. Click **+ Create**
3. Configure:
   - **Subscription**: Select your subscription
   - **Resource group**: `rg-cribl-logging` (or your naming convention)
   - **Region**: Your primary region (e.g., `East US`)
4. Click **Review + create** > **Create**

### Step 1.2: Create Event Hub Namespace

1. Navigate to **Azure Portal** > **Event Hubs**
2. Click **+ Create**
3. Configure **Basics** tab:
   - **Subscription**: Same as resource group
   - **Resource group**: `rg-cribl-logging`
   - **Namespace name**: `cribl-diag-{subscription-id-first-8-chars}` (e.g., `cribl-diag-a1b2c3d4`)
   - **Location**: Your primary region
   - **Pricing tier**: **Standard** (required for Kafka protocol)
   - **Throughput Units**: Start with 1 (adjust based on volume)
4. Configure **Advanced** tab:
   - **Enable Auto-Inflate**: Recommended for production
   - **Maximum Throughput Units**: 10-20 for auto-scale
5. Click **Review + create** > **Create**

### Step 1.3: Note the Authorization Rule

1. After deployment, go to your Event Hub Namespace
2. Navigate to **Settings** > **Shared access policies**
3. Click on **RootManageSharedAccessKey**
4. Copy the **Primary Connection String** (needed for Cribl configuration)
5. Note the **Resource ID** format:
   ```
   /subscriptions/{sub-id}/resourceGroups/{rg}/providers/Microsoft.EventHub/namespaces/{namespace}/authorizationRules/RootManageSharedAccessKey
   ```

### Multi-Region Deployment (Optional)

If you need data residency compliance, repeat Steps 1.2-1.3 for each region where you have resources. Use naming pattern:
- `cribl-diag-{subscription-id-first-8-chars}-{region}` (e.g., `cribl-diag-a1b2c3d4-eastus`)

---

## Phase 2: Deploy Built-in Policy Initiative

Microsoft provides a built-in policy initiative that covers 69 Azure resource types. This is the foundation of your logging coverage.

### Step 2.1: Navigate to Policy Assignments

1. Navigate to **Azure Portal** > **Policy**
2. Click **Assignments** in the left menu
3. Click **Assign initiative**

### Step 2.2: Select the Built-in Initiative

1. In the **Basics** tab:
   - **Scope**: Click the `...` button and select your **Management Group**
   - **Exclusions**: Leave empty (or exclude specific subscriptions if needed)

2. Click **Initiative definition** (the `...` button)
3. In the search box, type: `audit category group resource logging`
4. Select: **Enable audit category group resource logging to Event Hub**
   - Policy Set Definition ID: `1020d527-2764-4230-92cc-7035e4fcf8a7`
5. Click **Select**

6. Configure assignment details:
   - **Assignment name**: `Cribl-DiagSettings-Audit-Centralized`
   - **Description**: `Streams audit logs from 69 resource types to Event Hub for Cribl ingestion`
   - **Policy enforcement**: **Enabled**

### Step 2.3: Configure Parameters

In the **Parameters** tab:

| Parameter | Value |
|-----------|-------|
| **Effect** | `DeployIfNotExists` |
| **Event Hub Authorization Rule Id** | Paste your authorization rule resource ID from Step 1.3 |
| **Event Hub Name** | Leave **empty** (allows auto-creation per log category) |
| **Resource Location** | Leave **empty** for all regions, or specify a region |

### Step 2.4: Configure Remediation

In the **Remediation** tab:

1. Check **Create a remediation task**
2. **Policy to remediate**: Select the first policy in the list
3. Check **Create a Managed Identity**
4. **Type of Managed Identity**: **System assigned**
5. **System assigned identity location**: Same region as your Event Hub

### Step 2.5: Review and Create

1. Click **Review + create**
2. Review all settings
3. Click **Create**

### Step 2.6: Assign Required RBAC Roles to Managed Identity

After the assignment is created, you must assign roles to the managed identity:

1. Navigate to **Azure Portal** > **Policy** > **Assignments**
2. Find your assignment and click on it
3. Note the **Managed Identity** object ID

**Assign Monitoring Contributor at Management Group:**

1. Navigate to **Management Groups** > Select your management group
2. Click **Access control (IAM)**
3. Click **+ Add** > **Add role assignment**
4. Select role: **Monitoring Contributor**
5. Select **Managed identity**
6. Click **+ Select members**
7. Find and select the managed identity from your policy assignment
8. Click **Review + assign**

**Assign Azure Event Hubs Data Owner at Event Hub Namespace:**

1. Navigate to your Event Hub Namespace
2. Click **Access control (IAM)**
3. Click **+ Add** > **Add role assignment**
4. Select role: **Azure Event Hubs Data Owner**
5. Select **Managed identity**
6. Click **+ Select members**
7. Find and select the same managed identity
8. Click **Review + assign**

> **Important**: The "Azure Event Hubs Data Owner" role is required because the DeployIfNotExists policy needs `listkeys` permission to configure diagnostic settings. "Azure Event Hubs Data Sender" is NOT sufficient.

---

## Phase 3: Deploy Community Policies (Extended Coverage)

The built-in initiative covers 69 resource types, but many common resources (Storage, Firewall, Synapse, AVD) require additional policies from the Azure Community Policy repository.

### Option A: Download and Import Individual Policies

For each resource type you need, download the policy definition from GitHub and import it into Azure.

#### Step 3.1: Download Policy Definitions

Download policy JSON files from the Azure Community Policy repository:

**Base URL**: `https://github.com/Azure/Community-Policy/tree/main/policyDefinitions/Monitoring`

| Tier | Resource Type | Policy Path |
|------|---------------|-------------|
| **Storage** | Blob Services | `deploy-diagnostic-setting-for-storageAccount-blobServices-to-eventhub/` |
| **Storage** | File Services | `deploy-diagnostic-setting-for-storageAccount-fileServices-to-eventhub/` |
| **Storage** | Queue Services | `deploy-diagnostic-setting-for-storageAccount-queueServices-to-eventhub/` |
| **Storage** | Table Services | `deploy-diagnostic-setting-for-storageAccount-tableServices-to-eventhub/` |
| **Storage** | Storage Accounts | `deploy-diagnostic-setting-for-storageAccounts-to-eventhub/` |
| **Security** | Azure Firewall | `deploy-diagnostic-setting-for-azureFirewall-to-eventhub/` |
| **Security** | Network Security Groups | `deploy-diagnostic-setting-for-networkSecurityGroups-to-eventhub/` |
| **Data** | Synapse Workspaces | `deploy-diagnostic-setting-for-synapseWorkspaces-to-eventhub/` |
| **Data** | Data Factory | `deploy-diagnostic-setting-for-dataFactory-to-eventhub/` |
| **AVD** | Host Pools | `deploy-diagnostic-setting-for-hostPools-to-eventhub/` |
| **AVD** | Application Groups | `deploy-diagnostic-setting-for-applicationGroups-to-eventhub/` |

For each policy:
1. Navigate to the policy folder on GitHub
2. Click on `azurepolicy.json`
3. Click **Raw**
4. Save the file locally (e.g., `storage-blob-eventhub.json`)

#### Step 3.2: Import Policy Definition

For each downloaded policy:

1. Navigate to **Azure Portal** > **Policy** > **Definitions**
2. Click **+ Policy definition**
3. Configure:
   - **Definition location**: Select your **Management Group**
   - **Name**: `Cribl-{ResourceType}-DiagSettings-EH` (e.g., `Cribl-StorageBlob-DiagSettings-EH`)
   - **Description**: Copy from the policy JSON
   - **Category**: Select **Monitoring** (or create custom)
   - **Policy rule**: Paste the contents of the downloaded JSON file

4. **Important**: Modify the `location` parameter to allow all regions:
   - Find the `parameters` section in the policy
   - Look for `resourceLocation` or similar parameter
   - Remove any `allowedValues` restrictions, or set to allow your regions

5. Click **Save**

#### Step 3.3: Create Policy Initiative (Optional but Recommended)

To manage all community policies as a single unit:

1. Navigate to **Azure Portal** > **Policy** > **Definitions**
2. Click **+ Initiative definition**
3. Configure **Basics**:
   - **Definition location**: Your Management Group
   - **Name**: `Cribl-DiagSettings-EventHub-Community`
   - **Description**: `Community policies for extended diagnostic settings coverage`
   - **Category**: **Monitoring**

4. In **Policies** tab, add each imported policy definition

5. In **Initiative parameters** tab, create shared parameters:
   - `eventHubRuleId` (String): Event Hub Authorization Rule ID
   - `eventHubName` (String, default: empty): Event Hub name (leave empty for auto-create)
   - `effect` (String, default: DeployIfNotExists): Policy effect

6. In **Policy parameters** tab, map each policy's parameters to the initiative parameters

7. Click **Save**

#### Step 3.4: Assign the Initiative

1. Navigate to **Policy** > **Assignments**
2. Click **Assign initiative**
3. Select your custom initiative
4. Configure scope, parameters, and remediation (same as Phase 2)
5. Assign RBAC roles to the managed identity

### Option B: Manual Diagnostic Settings (Per-Resource)

If you prefer not to use policies, you can configure diagnostic settings on individual resources:

1. Navigate to any Azure resource (e.g., a Storage Account)
2. Go to **Monitoring** > **Diagnostic settings**
3. Click **+ Add diagnostic setting**
4. Configure:
   - **Diagnostic setting name**: `cribl-to-eventhub`
   - **Logs**: Select all relevant categories
   - **Destination**: Check **Stream to an event hub**
   - **Event hub namespace**: Select your namespace
   - **Event hub name**: Leave empty (auto-creates per category)
   - **Event hub policy name**: `RootManageSharedAccessKey`
5. Click **Save**

> **Note**: Option B requires manual configuration for each resource and does not auto-configure new resources.

---

## Phase 4: Configure Activity Log

The Activity Log captures control plane operations (ARM deployments, RBAC changes, etc.) and must be configured at the subscription level.

### Step 4.1: Configure via Diagnostic Settings

1. Navigate to **Azure Portal** > **Monitor** > **Activity log**
2. Click **Export Activity Logs** (or **Diagnostic settings**)
3. Select your subscription
4. Click **+ Add diagnostic setting**
5. Configure:
   - **Diagnostic setting name**: `cribl-activitylog-eventhub`
   - **Log categories**: Select all:
     - Administrative
     - Security
     - ServiceHealth
     - Alert
     - Recommendation
     - Policy
     - Autoscale
     - ResourceHealth
   - **Destination**: Check **Stream to an event hub**
   - **Subscription**: Select your Event Hub subscription
   - **Event hub namespace**: Select your namespace
   - **Event hub name**: Leave empty
   - **Event hub policy name**: `RootManageSharedAccessKey`
6. Click **Save**

### Step 4.2: Repeat for Each Subscription

If you have multiple subscriptions, repeat Step 4.1 for each one.

### Alternative: Use Built-in Policy

You can also use a built-in policy to automate Activity Log configuration:

1. Navigate to **Policy** > **Definitions**
2. Search for: `Configure Azure Activity logs to stream to specified Event Hub`
3. Policy ID: `4dabf6eb-0764-4049-82c1-c6d5d781e739`
4. Assign at Management Group scope with your Event Hub parameters

---

## Phase 5: Configure Entra ID Logging

Entra ID (formerly Azure AD) is a tenant-level service. Logs are configured once per tenant.

### Step 5.1: Navigate to Entra ID Diagnostic Settings

1. Navigate to **Azure Portal** > **Microsoft Entra ID** (or **Azure Active Directory**)
2. In the left menu, go to **Monitoring** > **Diagnostic settings**
3. Click **+ Add diagnostic setting**

### Step 5.2: Configure Log Categories

Select the categories based on your needs:

**Standard Profile (Recommended):**
- [x] AuditLogs
- [x] SignInLogs
- [x] NonInteractiveUserSignInLogs (optional - high volume)
- [x] ServicePrincipalSignInLogs
- [x] ManagedIdentitySignInLogs
- [x] ProvisioningLogs
- [x] RiskyUsers
- [x] UserRiskEvents
- [x] RiskyServicePrincipals
- [x] ServicePrincipalRiskEvents

**High Volume Profile (adds):**
- [x] NonInteractiveUserSignInLogs (5-10x more volume than interactive)

> **Warning**: NonInteractiveUserSignInLogs captures token refresh and background authentication. This can generate 5-10x more data than interactive sign-ins. Start with Standard profile.

### Step 5.3: Configure Destination

1. **Diagnostic setting name**: `cribl-entraid-eventhub`
2. **Destination**: Check **Stream to an event hub**
3. **Subscription**: Select your Event Hub subscription
4. **Event hub namespace**: Select your namespace
5. **Event hub name**: Leave empty
6. **Event hub policy name**: `RootManageSharedAccessKey`
7. Click **Save**

### Required Permissions

- **Global Administrator** or **Security Administrator** role in Entra ID

---

## Phase 6: Configure Defender for Cloud Export

Microsoft Defender for Cloud generates security alerts from enabled Defender plans. You can export these alerts to Event Hub.

> **Note**: This only exports alerts from Defender plans that are already enabled. It does not enable any paid Defender plans.

### Step 6.1: Navigate to Continuous Export

1. Navigate to **Azure Portal** > **Microsoft Defender for Cloud**
2. In the left menu, go to **Environment settings**
3. Select your subscription
4. Click **Continuous export**

### Step 6.2: Configure Export Settings

1. Select the **Event Hub** tab
2. Configure:
   - **Export enabled**: **On**
   - **Exported data types**:
     - [x] Security alerts
     - [x] Security recommendations (optional)
     - [x] Secure score (optional)
     - [x] Regulatory compliance (optional)
   - **Export frequency**: **Streaming updates**
   - **Export target**:
     - **Subscription**: Your Event Hub subscription
     - **Resource group**: Your Event Hub resource group
     - **Event hub namespace**: Your namespace
     - **Event hub name**: `defender-alerts` (or leave empty)
     - **Event hub policy name**: `RootManageSharedAccessKey`
3. Click **Save**

### Step 6.3: Repeat for Each Subscription

If you have multiple subscriptions with Defender plans, configure export for each one.

---

## Phase 7: Configure Defender XDR Streaming

Microsoft Defender XDR (formerly Microsoft 365 Defender) provides endpoint, identity, email, and cloud app telemetry. The Streaming API sends this data to Event Hub.

### Prerequisites

- Licensed for one or more Defender products:
  - Microsoft Defender for Endpoint
  - Microsoft Defender for Identity
  - Microsoft Defender for Office 365
  - Microsoft Defender for Cloud Apps
- **Security Administrator** role in Microsoft 365

### Step 7.1: Create Dedicated Event Hub Namespace (Recommended)

Defender XDR generates high-volume data. Consider a separate namespace:

1. Create Event Hub Namespace: `cribl-xdr-{subscription-id-first-8-chars}`
2. Use **Standard** or **Premium** tier
3. Configure higher throughput units (5-20 based on endpoint count)

### Step 7.2: Configure Streaming API

1. Navigate to **Microsoft Defender Portal** (security.microsoft.com)
2. Go to **Settings** > **Microsoft Defender XDR** > **Streaming API**
3. Click **+ Add**
4. Configure:
   - **Name**: `Cribl-EventHub-Export`
   - **Forward events to**: **Event Hub**
   - **Event Hub Resource ID**: Paste your namespace resource ID
   - **Event Hub Name**: Leave empty for auto-create, or specify `defender-xdr`
5. Select event types to stream:

**Tier 1 - Essential (Always Export):**
- [x] AlertInfo
- [x] AlertEvidence
- [x] DeviceProcessEvents
- [x] DeviceNetworkEvents
- [x] DeviceLogonEvents
- [x] IdentityLogonEvents
- [x] EmailEvents

**Tier 2 - Recommended (High Value):**
- [x] DeviceFileEvents
- [x] DeviceRegistryEvents
- [x] DeviceEvents
- [x] EmailAttachmentInfo
- [x] EmailUrlInfo
- [x] UrlClickEvents
- [x] IdentityDirectoryEvents
- [x] CloudAppEvents

**Tier 3 - Situational (Evaluate Volume):**
- [ ] DeviceImageLoadEvents (Caution: ~100+ GB/day per 1K endpoints)
- [ ] IdentityQueryEvents (Caution: High volume from normal AD operations)
- [ ] DeviceInfo
- [ ] DeviceNetworkInfo
- [ ] DeviceFileCertificateInfo
- [ ] EmailPostDeliveryEvents

6. Click **Submit**

### Volume Considerations

| Table | Typical Volume (per 1K endpoints) |
|-------|-----------------------------------|
| AlertInfo | Low (alerts only) |
| DeviceProcessEvents | 5-10 GB/day |
| DeviceNetworkEvents | 10-20 GB/day |
| DeviceImageLoadEvents | 100+ GB/day |
| EmailEvents | 1-5 GB/day |

---

## Phase 8: Remediate Existing Resources

Azure Policy with `DeployIfNotExists` effect automatically configures **new** resources. For **existing** resources, you must create remediation tasks.

### Step 8.1: View Non-Compliant Resources

1. Navigate to **Azure Portal** > **Policy**
2. Click **Compliance** in the left menu
3. Find your policy assignment
4. Click on it to see non-compliant resources

### Step 8.2: Create Remediation Task

1. Click **Create Remediation Task** (button at top)
2. Configure:
   - **Policy to remediate**: Select the specific policy within the initiative
   - **Scope**: Leave as default (all non-compliant resources)
   - **Locations**: All or specific regions
   - **Re-evaluate resource compliance before remediating**: Recommended
3. Click **Remediate**

### Step 8.3: Monitor Remediation Progress

1. Navigate to **Policy** > **Remediation**
2. Click on your remediation task
3. Monitor:
   - **Successful**: Resources now have diagnostic settings
   - **Failed**: Check error messages and permissions
   - **In progress**: Wait for completion

### Common Remediation Failures

| Error | Cause | Solution |
|-------|-------|----------|
| LinkedAuthorizationFailed | Managed identity missing permissions | Add Azure Event Hubs Data Owner role |
| ResourceNotFound | Event Hub namespace deleted | Recreate namespace, update assignment |
| InvalidAuthorizationRule | Wrong authorization rule | Verify RootManageSharedAccessKey exists |

---

## Phase 9: Configure Cribl Stream

After logs are flowing to Event Hubs, configure Cribl Stream to ingest them.

### Step 9.1: Get Connection Information

For each Event Hub Namespace:

1. Navigate to your Event Hub Namespace
2. Go to **Settings** > **Shared access policies**
3. Click **RootManageSharedAccessKey**
4. Copy **Connection string-primary key**

### Step 9.2: Create Cribl Event Hub Source

1. In Cribl Stream, go to **Data** > **Sources**
2. Click **+ Add Source**
3. Select **Azure Event Hub**
4. Configure:
   - **Input ID**: `azure-diag-{region}` (e.g., `azure-diag-eastus`)
   - **Brokers**: `{namespace}.servicebus.windows.net:9093`
   - **Topics**: `insights-logs-*` (or specific Event Hub names)
   - **Consumer Group**: `$Default` (or create a dedicated consumer group)
   - **Authentication**:
     - **SASL Mechanism**: PLAIN
     - **Username**: `$ConnectionString`
     - **Password**: Paste your connection string
   - **TLS**: Enabled

5. Click **Save**

### Step 9.3: Discover Auto-Created Event Hubs

After resources start sending logs, Event Hubs are auto-created with names like:
- `insights-logs-auditevent`
- `insights-logs-networksecuritygroupevent`
- `insights-logs-azurefirewallnetworkrule`
- `insights-logs-signinlogs`
- `insights-operational-logs`

To see all Event Hubs:
1. Navigate to your Event Hub Namespace
2. Go to **Entities** > **Event Hubs**
3. Note all the auto-created Event Hubs

### Step 9.4: Configure Multiple Sources (Optional)

For better organization, create separate Cribl sources for different log types:

| Source ID | Topic Pattern | Description |
|-----------|---------------|-------------|
| `azure-audit-logs` | `insights-logs-audit*` | Key Vault, SQL, etc. |
| `azure-network-logs` | `insights-logs-network*` | NSG, Firewall |
| `azure-activity-logs` | `insights-operational-logs` | Activity Log |
| `azure-entra-logs` | `insights-logs-signin*`, `insights-logs-audit*` | Entra ID |

---

## Appendix: Policy Definition Downloads

### Community Policy Repository

All community policies are available at:
**https://github.com/Azure/Community-Policy/tree/main/policyDefinitions/Monitoring**

### Complete List of Community Policies (44 Total)

#### Storage Tier (5 policies)
| Resource Type | Policy Folder |
|---------------|---------------|
| Blob Services | `deploy-diagnostic-setting-for-storageAccount-blobServices-to-eventhub/` |
| File Services | `deploy-diagnostic-setting-for-storageAccount-fileServices-to-eventhub/` |
| Queue Services | `deploy-diagnostic-setting-for-storageAccount-queueServices-to-eventhub/` |
| Table Services | `deploy-diagnostic-setting-for-storageAccount-tableServices-to-eventhub/` |
| Storage Accounts | `deploy-diagnostic-setting-for-storageAccounts-to-eventhub/` |

#### Security Tier (5 policies)
| Resource Type | Policy Folder |
|---------------|---------------|
| AKS Clusters | `deploy-diagnostic-setting-for-aks-to-eventhub/` |
| Azure Firewall | `deploy-diagnostic-setting-for-azureFirewall-to-eventhub/` |
| Network Security Groups | `deploy-diagnostic-setting-for-networkSecurityGroups-to-eventhub/` |
| Application Gateway | `deploy-diagnostic-setting-for-applicationGateway-to-eventhub/` |
| ExpressRoute Circuits | `deploy-diagnostic-setting-for-expressRouteCircuits-to-eventhub/` |

#### Data Tier (12 policies)
| Resource Type | Policy Folder |
|---------------|---------------|
| Cosmos DB | `deploy-diagnostic-setting-for-cosmosDb-to-eventhub/` |
| Data Factory | `deploy-diagnostic-setting-for-dataFactory-to-eventhub/` |
| MySQL Servers | `deploy-diagnostic-setting-for-mysql-to-eventhub/` |
| PostgreSQL Servers | `deploy-diagnostic-setting-for-postgresql-to-eventhub/` |
| MariaDB Servers | `deploy-diagnostic-setting-for-mariadb-to-eventhub/` |
| Synapse Workspaces | `deploy-diagnostic-setting-for-synapseWorkspaces-to-eventhub/` |
| Synapse SQL Pools | `deploy-diagnostic-setting-for-synapseSqlPools-to-eventhub/` |
| Synapse Spark Pools | `deploy-diagnostic-setting-for-synapseBigDataPools-to-eventhub/` |
| Databricks Workspaces | `deploy-diagnostic-setting-for-databricks-to-eventhub/` |
| Azure SQL Database | `deploy-diagnostic-setting-for-sqlDatabases-to-eventhub/` |
| SQL Managed Instance | `deploy-diagnostic-setting-for-sqlManagedInstances-to-eventhub/` |
| Stream Analytics | `deploy-diagnostic-setting-for-streamAnalytics-to-eventhub/` |

#### Compute Tier (7 policies)
| Resource Type | Policy Folder |
|---------------|---------------|
| App Service | `deploy-diagnostic-setting-for-appService-to-eventhub/` |
| Function App | `deploy-diagnostic-setting-for-functionApps-to-eventhub/` |
| Batch Account | `deploy-diagnostic-setting-for-batchAccounts-to-eventhub/` |
| Machine Learning | `deploy-diagnostic-setting-for-machineLearning-to-eventhub/` |
| Application Insights | `deploy-diagnostic-setting-for-applicationInsights-to-eventhub/` |
| Container Registry | `deploy-diagnostic-setting-for-containerRegistry-to-eventhub/` |
| Container Instances | `deploy-diagnostic-setting-for-containerInstances-to-eventhub/` |

#### Integration Tier (5 policies)
| Resource Type | Policy Folder |
|---------------|---------------|
| Logic Apps | `deploy-diagnostic-setting-for-logicApps-to-eventhub/` |
| Event Grid Topics | `deploy-diagnostic-setting-for-eventGridTopics-to-eventhub/` |
| Event Grid System Topics | `deploy-diagnostic-setting-for-eventGridSystemTopics-to-eventhub/` |
| Relay | `deploy-diagnostic-setting-for-relay-to-eventhub/` |
| Service Bus | `deploy-diagnostic-setting-for-serviceBus-to-eventhub/` |

#### Networking Tier (3 policies)
| Resource Type | Policy Folder |
|---------------|---------------|
| Load Balancer | `deploy-diagnostic-setting-for-loadBalancer-to-eventhub/` |
| Traffic Manager | `deploy-diagnostic-setting-for-trafficManager-to-eventhub/` |
| CDN Endpoint | `deploy-diagnostic-setting-for-cdnEndpoints-to-eventhub/` |

#### AVD Tier (4 policies)
| Resource Type | Policy Folder |
|---------------|---------------|
| Host Pools | `deploy-diagnostic-setting-for-hostPools-to-eventhub/` |
| Application Groups | `deploy-diagnostic-setting-for-applicationGroups-to-eventhub/` |
| Workspaces | `deploy-diagnostic-setting-for-desktopVirtualizationWorkspaces-to-eventhub/` |
| Scaling Plans | `deploy-diagnostic-setting-for-scalingPlans-to-eventhub/` |

#### Other Tier (3 policies)
| Resource Type | Policy Folder |
|---------------|---------------|
| Recovery Services Vaults | `deploy-diagnostic-setting-for-recoveryServicesVaults-to-eventhub/` |
| Healthcare APIs | `deploy-diagnostic-setting-for-healthcareApis-to-eventhub/` |
| Power BI Embedded | `deploy-diagnostic-setting-for-powerBiEmbedded-to-eventhub/` |

### Built-in Policy Initiative Reference

| Initiative | Policy Set Definition ID |
|------------|-------------------------|
| Enable audit category group resource logging to Event Hub | `1020d527-2764-4230-92cc-7035e4fcf8a7` |
| Enable allLogs category group resource logging to Event Hub | `85175a36-2f12-419a-96b4-18d5b0096531` |

### Built-in Policy References

| Policy | Policy Definition ID |
|--------|---------------------|
| Configure Azure Activity logs to stream to Event Hub | `4dabf6eb-0764-4049-82c1-c6d5d781e739` |

---

## Troubleshooting

### Common Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| No logs in Event Hub | Remediation not run | Create remediation task for existing resources |
| Remediation fails with LinkedAuthorizationFailed | Missing RBAC role | Add "Azure Event Hubs Data Owner" role to managed identity |
| Policy shows non-compliant but resource has diagnostic settings | Different diagnostic setting name | Check if settings match policy's profileName parameter |
| Event Hubs not auto-creating | Authorization rule missing Manage permission | Use RootManageSharedAccessKey or create rule with Manage permission |
| Entra ID logs not flowing | Permissions or config issue | Verify Global Admin configured settings correctly |

### Verification Checklist

- [ ] Event Hub Namespace created and accessible
- [ ] Policy assignment created with correct parameters
- [ ] Managed identity has Monitoring Contributor role at Management Group
- [ ] Managed identity has Azure Event Hubs Data Owner role at Event Hub Namespace
- [ ] Remediation task created and completed
- [ ] Event Hubs visible in namespace (auto-created after logs flow)
- [ ] Cribl source configured and receiving data

---

## Support and Resources

### Microsoft Documentation
- [Azure Policy Overview](https://docs.microsoft.com/azure/governance/policy/overview)
- [Diagnostic Settings](https://docs.microsoft.com/azure/azure-monitor/essentials/diagnostic-settings)
- [Event Hubs Documentation](https://docs.microsoft.com/azure/event-hubs/)
- [Built-in Policy Initiatives](https://github.com/Azure/azure-policy/tree/master/built-in-policies/policySetDefinitions/Monitoring)
- [Community Policy Repository](https://github.com/Azure/Community-Policy)

### Cribl Documentation
- [Azure Event Hub Source](https://docs.cribl.io/stream/sources-azure-event-hub/)

---

**Version:** 1.0.0
**Last Updated:** 2026-01
**Related:** [QUICK_START.md](QUICK_START.md) | [README.md](README.md) | [ARCHITECTURE_SUMMARY.md](ARCHITECTURE_SUMMARY.md)
