# Network Architecture Diagrams for Azure Private Link with Cribl

Visual reference guide for Azure Private Link architecture with on-premises Cribl Stream workers.

## Table of Contents
- [Complete End-to-End Architecture](#complete-end-to-end-architecture)
- [DNS Resolution Flows](#dns-resolution-flows)
- [Data Ingestion Flow](#data-ingestion-flow)
- [Component Relationships](#component-relationships)
- [Alternative Architectures](#alternative-architectures)

---

## Complete End-to-End Architecture

### Full Private Link Topology

```

 ON-PREMISES NETWORK 
 (Corporate Data Center) 
 
 
 Cribl Stream Environment 
 
 
 Cribl Worker Cribl Worker Cribl Worker 
 Node 1 Node 2 Node 3 
 
 192.168.1.10 192.168.1.11 192.168.1.12 
 
 
 
 
 DNS Query 
 
 
 
 
 DNS Infrastructure 
 
 Option A: Active Directory DNS 
 
 AD DNS Server (dc01.corp.local) 
 - Conditional Forwarders configured 
 - Forwards Azure DNS queries to 
 168.63.129.16 (Azure DNS) 
 
 
 Option B: Azure Private DNS Resolver 
 
 Conditional Forwarder 
 - Points to Azure DNS Resolver 
 (10.0.2.4 in Azure VNet) 
 
 
 
 
 Network Gateway 
 OR 
 ExpressRoute VPN Gateway 
 Connection (Site-to-Site) 
 (Preferred) 
 
 
 

 
 Microsoft Backbone 
 Private Connection 
 

 AZURE VIRTUAL NETWORK 
 (Hub VNet: 10.0.0.0/16) 
 
 
 Gateway Subnet (10.0.0.0/27) 
 
 VNet Gateway Receives traffic from on-prem 
 (ExpressRoute Routes to private endpoints 
 or VPN) 
 
 
 
 
 DNS Resolver Subnet (10.0.2.0/28) - Optional 
 
 Azure Private DNS Resolver 
 - Inbound Endpoint: 10.0.2.4 
 - Resolves private DNS zones 
 - Used by on-prem DNS forwarding 
 
 
 
 
 Private Endpoint Subnet (10.0.1.0/24) 
 
 
 Private Endpoint 
 - Name: pe-ampls-cribl-onprem 
 - Private IP: 10.0.1.5 
 - NIC: pe-ampls-cribl-onprem-nic 
 - Connected to: AMPLS 
 
 Network Security Group Rules: 
 - Inbound: Allow 443 from 192.168.1.0/24 
 - Outbound: Allow to Azure Monitor 
 
 
 
 
 Private DNS Zones (Auto-created) 
 
 privatelink.monitor.azure.com 
 A Record: dce-cribl-private → 10.0.1.5 
 
 
 privatelink.oms.opinsights.azure.com 
 A Record: <workspace-id> → 10.0.1.5 
 
 
 privatelink.ods.opinsights.azure.com 
 A Record: <workspace-id> → 10.0.1.5 
 
 

 
 Private Connection
 (No Internet Traversal)
 

 AZURE MONITOR SERVICES 
 (Regional Deployment) 
 
 
 Azure Monitor Private Link Scope (AMPLS) 
 Resource Name: ampls-cribl-onprem 
 
 Associated Resources: 
 
 1. Log Analytics Workspace 
 - Name: law-cribl-prod 
 - Network Access: Private only 
 
 
 2. Data Collection Endpoint (DCE) 
 - Name: dce-cribl-private 
 - Public Access: Disabled 
 - Endpoint: dce-cribl-private 
 .eastus-1.ingest.private 
 .monitor.azure.com 
 
 
 
 
 Data Collection Rules (DCRs) 
 
 
 DCR: dcr-cribl-FirewallLogs_CL 
 - Associated DCE: dce-cribl-private 
 - Target Table: FirewallLogs_CL 
 - Stream: Custom-FirewallLogs_CL 
 - Transformation: source | extend ... 
 
 
 
 DCR: dcr-cribl-Syslog 
 - Associated DCE: dce-cribl-private 
 - Target Table: Syslog 
 - Stream: Microsoft-Syslog 
 
 
 [Additional DCRs for other tables...] 
 
 
 
 Log Analytics Workspace 
 Resource Name: law-cribl-prod 
 
 Tables: 
 - FirewallLogs_CL (Custom) 
 - Syslog (Native) 
 - SecurityEvent (Native) 
 - [Other custom and native tables...] 
 
 Network Access: 
 - Public Network Access: Disabled 
 - Private Link Access: Enabled via AMPLS 
 

```

---

## DNS Resolution Flows

### Option 1: Active Directory DNS Resolution

```

 DNS RESOLUTION FLOW: ON-PREMISES AD DNS TO AZURE PRIVATE ENDPOINT 


Step 1: Cribl Worker DNS Query

 Cribl Worker Node (192.168.1.10) 
 
 Query: dce-cribl-private.eastus-1.ingest.private 
 .monitor.azure.com 
 
 DNS Server: 192.168.1.2 (AD DNS) 

 
 1. DNS Query
 

 Active Directory DNS Server (dc01.corp.local) 
 IP: 192.168.1.2 
 
 Conditional Forwarders Configured: 
 
 Zone: privatelink.monitor.azure.com 
 Forwarder: 168.63.129.16 (Azure DNS) 
 
 
 Zone: eastus-1.ingest.private.monitor 
 .azure.com 
 Forwarder: 168.63.129.16 (Azure DNS) 
 
 
 Decision: Forward query to Azure DNS 

 
 2. Forwarded Query
 (Via ExpressRoute/VPN)
 

 Azure Recursive DNS (168.63.129.16) 
 Special Azure Platform DNS Resolver 
 
 Lookup Process: 
 1. Check Private DNS Zones linked to VNet 
 2. Find zone: privatelink.monitor.azure.com 
 3. Locate A record: dce-cribl-private 
 
 Result Found: 
 dce-cribl-private.eastus-1.ingest.private.monitor.azure.com
 → A Record: 10.0.1.5 (Private Endpoint IP) 

 
 3. DNS Response
 (Private IP returned)
 

 Active Directory DNS Server (dc01.corp.local) 
 
 Receives response from Azure DNS: 
 Answer: 10.0.1.5 
 
 Caches response (TTL: 3600 seconds) 

 
 4. Final Answer
 

 Cribl Worker Node (192.168.1.10) 
 
 Received DNS Answer: 
 dce-cribl-private.eastus-1.ingest.private.monitor.azure.com
 → 10.0.1.5 
 
 Next Step: Initiate HTTPS connection to 10.0.1.5:443 



 RESULT: DNS resolves to PRIVATE IP (10.0.1.5) 
 Traffic will flow via ExpressRoute/VPN, NOT public internet 

```

### Option 2: Azure Private DNS Resolver

```

 DNS RESOLUTION FLOW: AZURE PRIVATE DNS RESOLVER 


Step 1: Cribl Worker DNS Query

 Cribl Worker Node (192.168.1.10) 
 
 Query: dce-cribl-private.eastus-1.ingest.private 
 .monitor.azure.com 
 
 DNS Server: 192.168.1.2 (On-Prem DNS) 

 
 1. DNS Query
 

 On-Premises DNS Server 
 IP: 192.168.1.2 
 
 Conditional Forwarders: 
 
 Zone: privatelink.monitor.azure.com 
 Forwarder: 10.0.2.4 
 (Azure DNS Resolver in Azure) 
 
 
 Zone: *.ingest.private.monitor.azure.com 
 Forwarder: 10.0.2.4 
 

 
 2. Forward to Azure DNS Resolver
 (Via ExpressRoute/VPN)
 

 Azure Private DNS Resolver 
 Inbound Endpoint: 10.0.2.4 
 Location: VNet (10.0.2.0/28 subnet) 
 
 Configuration: 
 - Receives DNS queries from on-premises 
 - Has access to Private DNS Zones 
 - Integrated with VNet 
 
 Lookup Process: 
 1. Query received for privatelink.monitor.azure.com domain 
 2. Check linked Private DNS Zones 
 3. Find matching zone 

 
 3. Query Private DNS Zone
 

 Azure Private DNS Zone 
 Zone: privatelink.monitor.azure.com 
 Linked to: vnet-hub (10.0.0.0/16) 
 
 Records: 
 
 A Record: 
 Name: dce-cribl-private.eastus-1.ingest 
 IP: 10.0.1.5 
 TTL: 3600 
 
 
 Record auto-created by Private Endpoint 

 
 4. Return Private IP
 

 Azure Private DNS Resolver 
 
 Answer: 10.0.1.5 
 Forwards response back to on-premises DNS 

 
 5. DNS Response
 (Via ExpressRoute/VPN)
 

 On-Premises DNS Server 
 
 Receives: 10.0.1.5 
 Caches response 

 
 6. Final Answer
 

 Cribl Worker Node (192.168.1.10) 
 
 DNS Resolution Complete: 
 dce-cribl-private.eastus-1.ingest.private.monitor.azure.com
 → 10.0.1.5 
 
 Initiates HTTPS connection to private endpoint 



 ADVANTAGE: Centralized DNS management in Azure 
 All Private DNS zones managed in Azure, forwarded to on-prem 

```

---

## Data Ingestion Flow

### Complete Data Path: Cribl to Log Analytics via Private Link

```

 STEP 1: LOG COLLECTION AND PROCESSING 



 Log Source (e.g., Firewall, Server, Application) 
 Sends logs to Cribl via Syslog, HTTP, S3, etc. 

 
 Raw Logs
 

 Cribl Stream Worker Node 
 
 Pipeline Processing: 
 1. Parse logs (Regex, JSON, etc.) 
 2. Enrich data (GeoIP, lookups) 
 3. Transform to match DCR schema 
 4. Add required columns 
 5. Format for Azure Logs Ingestion API 
 
 Output Destination: Microsoft Sentinel 
 - Destination Name: FirewallLogs_CL 
 - Authentication: OAuth 2.0 (Client Credentials) 

 
 Processed, Schema-Compliant JSON
 

 STEP 2: AUTHENTICATION 



 Cribl Destination Configuration 
 
 Authentication Parameters: 
 - Client ID: abc123... 
 - Tenant ID: xyz789... 
 - Client Secret: (from Cribl Secrets) 
 - Auth Endpoint: login.microsoftonline.com 

 
 OAuth Token Request
 

 Azure Active Directory (Public Endpoint) 
 https://login.microsoftonline.com/<tenant-id>/oauth2/ 
 
 Validates credentials 
 Issues access token (JWT) 
 Scope: https://monitor.azure.com/.default 

 
 Access Token (Valid 1 hour)
 

 Cribl Worker (Cached Token) 
 Token includes: 
 - Role: Monitoring Metrics Publisher 
 - Scope: DCR access 

 

 STEP 3: DNS RESOLUTION (PRIVATE LINK) 



 DNS Query for DCE Ingestion Endpoint 
 Query: dce-cribl-private.eastus-1.ingest.private 
 .monitor.azure.com 
 
 Resolution Path: 
 1. Query on-prem/Azure DNS 
 2. Conditional forwarder routes to Azure 
 3. Azure Private DNS Zone returns private IP 
 
 Result: 10.0.1.5 (Private Endpoint IP) 

 

 STEP 4: NETWORK ROUTING 



 On-Premises Network Routing 
 
 Destination: 10.0.1.5 (Azure Private IP) 
 Route: Via ExpressRoute/VPN Gateway 
 Protocol: HTTPS (TCP 443) 
 
 Packet Flow: 
 192.168.1.10 → Corporate Gateway → ExpressRoute → 
 Azure VNet Gateway → Private Endpoint Subnet 

 
 Encrypted HTTPS Traffic
 Over Microsoft Backbone
 

 Azure Virtual Network 
 Private Endpoint (10.0.1.5) 
 
 Network Interface: pe-ampls-cribl-onprem-nic 
 NSG Rules Applied: 
 - Allow 443 from 192.168.1.0/24 
 - Allow to Azure Monitor services 

 

 STEP 5: DATA INGESTION 



 HTTPS POST Request 
 Endpoint: https://dce-cribl-private.eastus-1.ingest 
 .private.monitor.azure.com/dataCollectionRules/ 
 dcr-1234.../streams/Custom-FirewallLogs_CL 
 
 Headers: 
 - Authorization: Bearer <access-token> 
 - Content-Type: application/json 
 - x-ms-client-request-id: <guid> 
 
 Body: JSON array of log events 

 
 

 Data Collection Endpoint (DCE) 
 Name: dce-cribl-private 
 Network Access: Private Link only 
 
 Processing: 
 1. Validates access token (AAD integration) 
 2. Checks DCR permissions 
 3. Validates request format 
 4. Routes to associated DCR 

 
 

 Data Collection Rule (DCR) 
 Name: dcr-cribl-FirewallLogs_CL 
 Immutable ID: dcr-1234567890abcdef... 
 
 Configuration: 
 - Stream: Custom-FirewallLogs_CL 
 - Schema Validation: Enabled 
 - Transformation: KQL query (optional) 
 - Target: FirewallLogs_CL table 
 
 Processing Steps: 
 1. Schema validation (column names, types) 
 2. Apply KQL transformation if configured 
 3. Add metadata (TimeGenerated, _ResourceId) 
 4. Route to Log Analytics Workspace 

 
 

 Log Analytics Workspace 
 Name: law-cribl-prod 
 Network Access: Private Link only 
 
 Data Storage: 
 - Table: FirewallLogs_CL 
 - Retention: 90 days (configurable) 
 - Indexing: All columns indexed 
 
 Data now queryable via KQL in: 
 - Azure Portal (Logs blade) 
 - Microsoft Sentinel 
 - Azure Monitor Workbooks 
 - API / PowerShell / Azure CLI 



 STEP 6: QUERY AND ANALYSIS 



 KQL Query Example 
 
 FirewallLogs_CL 
 | where TimeGenerated > ago(1h) 
 | where Action == "Deny" 
 | summarize Count = count() by SourceIP 
 | order by Count desc 
 | take 10 
 
 Results: Top 10 blocked source IPs in last hour 



 COMPLETE FLOW SUMMARY 
 
 Logs collected and processed by Cribl 
 OAuth authentication with Azure AD 
 DNS resolves DCE endpoint to private IP 
 Traffic routed via ExpressRoute/VPN (private network) 
 Data posted to DCE via Private Endpoint 
 DCR validates schema and transforms data 
 Data stored in Log Analytics workspace 
 Available for querying and analysis in Sentinel 
 
 NO PUBLIC INTERNET TRAVERSAL FOR DATA INGESTION 

```

---

## Component Relationships

### Azure Monitor Private Link Resources

```

 AZURE SUBSCRIPTION 
 
 
 Resource Group: rg-monitoring-private 
 
 
 Azure Monitor Private Link Scope (AMPLS) 
 Name: ampls-cribl-onprem 
 Region: East US 
 Access Mode: PrivateOnly 
 
 Scoped Resources: 
 
 1. Log Analytics Workspace 
 - Type: Microsoft.OperationalIn... 
 - Resource ID: /subscriptions/... 
 - Connection State: Approved 
 
 
 2. Data Collection Endpoint 
 - Type: Microsoft.Insights/data... 
 - Resource ID: /subscriptions/... 
 - Connection State: Approved 
 
 
 Private Endpoint Connections: 
 
 pe-ampls-cribl-onprem 
 - Status: Approved 
 - Private IP: 10.0.1.5 
 - VNet: vnet-hub 
 
 
 
 Links to 
 
 
 Log Analytics Workspace 
 Name: law-cribl-prod 
 Workspace ID: abc123... 
 Region: East US 
 
 Network Isolation: 
 - Public Network Access: Disabled 
 - Query Access: Private Link only 
 - Ingestion Access: Private Link only 
 
 Tables: 
 - FirewallLogs_CL (Custom) 
 - Syslog (Native) 
 - SecurityEvent (Native) 
 
 
 
 Data Collection Endpoint (DCE) 
 Name: dce-cribl-private 
 Region: East US 
 
 Configuration: 
 - Public Network Access: Disabled 
 - Ingestion Endpoint: 
 dce-cribl-private.eastus-1.ingest 
 .private.monitor.azure.com 
 
 Associated DCRs: 5 
 
 
 Used by 
 
 
 Data Collection Rules (DCRs) 
 
 
 dcr-cribl-FirewallLogs_CL 
 - DCE: dce-cribl-private 
 - Table: FirewallLogs_CL 
 - Stream: Custom-FirewallLogs_CL 
 
 
 dcr-cribl-Syslog 
 - DCE: dce-cribl-private 
 - Table: Syslog 
 - Stream: Microsoft-Syslog 
 
 [Additional DCRs...] 
 
 
 
 
 Resource Group: rg-network-hub 
 
 
 Virtual Network: vnet-hub 
 Address Space: 10.0.0.0/16 
 
 Subnets: 
 - GatewaySubnet: 10.0.0.0/27 
 - subnet-private-endpoints: 10.0.1.0/24 
 - subnet-dns-resolver: 10.0.2.0/28 
 
 
 Contains 
 
 
 Private Endpoint 
 Name: pe-ampls-cribl-onprem 
 Subnet: subnet-private-endpoints 
 Private IP: 10.0.1.5 
 
 Network Interface: pe-ampls-...-nic 
 NSG: nsg-private-endpoints 
 
 Connection: 
 - Resource Type: Microsoft.Insights/ 
 privateLinkScopes 
 - Resource: ampls-cribl-onprem 
 - Sub-resource: azuremonitor 
 
 
 
 Private DNS Zones (Linked to vnet-hub) 
 
 - privatelink.monitor.azure.com 
 - privatelink.oms.opinsights.azure.com 
 - privatelink.ods.opinsights.azure.com 
 - privatelink.agentsvc.azure-automation.net 
 
 A Records auto-created by Private Endpoint 
 
 



 AZURE ACTIVE DIRECTORY (AAD) 
 
 
 App Registration: cribl-sentinel-connector 
 Application ID: abc123... 
 Tenant ID: xyz789... 
 
 Certificates & Secrets: 
 - Client Secret: [Created for Cribl] 
 
 API Permissions: 
 - None required (DCR-level permissions) 
 
 Assigned RBAC Roles: 
 
 Role: Monitoring Metrics Publisher 
 Scope: Each DCR individually 
 - dcr-cribl-FirewallLogs_CL 
 - dcr-cribl-Syslog 
 - [Other DCRs...] 
 
 

```

---

## Alternative Architectures

### Architecture 1: Single DCE for All Tables (Recommended)

```

 Cribl Worker Nodes (On-Premises) 
 
 Worker 1 Worker 2 Worker 3 
 
 Multiple Multiple Multiple 
 Sentinal Sentinal Sentinal 
 Dests Dests Dests 
 
 
 
 
 All workers use same DCE 
 

 
 Private Link
 

 Azure - Single DCE Architecture 
 
 
 Data Collection Endpoint 
 dce-cribl-private 
 (Single ingestion point) 
 
 
 Multiple DCRs associated 
 
 
 
 
 
 DCR DCR DCR DCR 
 FW DCR Sec ... App 
 Logs Syslog Event Logs 
 
 
 
 
 
 
 Log Analytics Workspace 
 - FirewallLogs_CL 
 - Syslog 
 - SecurityEvent 
 - ApplicationLogs_CL 
 


Advantages:
 Simpler DNS configuration (one FQDN)
 Single Private Endpoint required
 Easier certificate management
 Cost-effective (one DCE charge)
 Recommended for most deployments
```

### Architecture 2: Multi-DCE for Separation

```

 Cribl Worker Nodes (On-Premises) 
 
 Production Workers Test Workers 
 
 Worker 1 Test Worker 
 (Prod) 
 
 
 

 
 DCE 1 DCE 2
 (Production) (Non-Prod)
 

 Azure - Multi-DCE Architecture 
 
 
 DCE 1 (Prod) DCE 2 (Non-Prod) 
 dce-cribl-prod dce-cribl-test 
 
 
 
 
 
 DCR DCR DCR DCR 
 Prod Prod Test Test 
 FW Syslog FW App 
 
 
 
 
 
 Workspace Workspace 
 (Production) (Non-Prod) 
 


Use Cases:
- Separate production and non-production environments
- Different compliance requirements
- Isolated cost tracking
- Environment-specific access control

Considerations:
 Higher complexity (multiple DNS records)
 Additional Private Endpoints required
 Higher cost (multiple DCEs)
 More granular cost allocation
 Stronger environment isolation
```

### Architecture 3: Hub-Spoke with Centralized Private Link

```

 On-Premises 
 
 Cribl 
 Workers 
 

 
 ExpressRoute/VPN
 

 Azure Hub VNet (Centralized Connectivity) 
 Address Space: 10.0.0.0/16 
 
 
 Private Endpoint Subnet 
 10.0.1.0/24 
 
 Private Endpoint (AMPLS) 
 IP: 10.0.1.5 
 
 
 
 
 Azure Private DNS Zones 
 - Linked to Hub VNet 
 - Peered Spoke VNets can resolve 
 
 
 VNet Peering 

 
 
 Spoke VNet 1 Spoke VNet 2 
 (Workspace Region 1) (Workspace Region 2) 
 
 
 Log Analytics Log Analytics 
 Workspace 1 Workspace 2 
 (Connected to AMPLS) (Connected to AMPLS) 
 
 
 
 DCE 1 DCE 2 
 (Connected to AMPLS) (Connected to AMPLS) 
 
 

Benefits:
 Single Private Endpoint for all workspaces
 Centralized DNS management
 Multi-region support
 Simplified network governance
 Cost-effective at scale

Ideal for:
- Multi-region deployments
- Organizations with hub-spoke network topology
- Centralized network teams
- Multiple Log Analytics workspaces
```

---

## Network Flow Decision Tree

```

 START: Cribl Worker Needs to Send Logs to Azure 

 
 
 
 Is Private Link NO
 Configured? > Use Public Endpoint
 (Not covered here)
 YES
 
 
 DNS Query for 
 DCE Ingestion Endpoint 
 
 
 
 
 Which DNS Option? 
 
 
 
 
 
 
 AD DNS Azure DNS 
 Resolver 
 
 
 
 
 
 
 DNS Resolves to Private IP
 Private or Public IP? 
 
 
 
 Route via 
 ExpressRoute/VPN 
 
 
 
 
 Private Endpoint 
 in Azure VNet 
 
 
 
 
 AMPLS 
 (Azure Monitor 
 Private Link 
 Scope) 
 
 
 
 
 
 
 DCE Workspace 
 (Private) (Private) 
 
 
 
 
 DCR 
 Validates 
 & Routes 
 
 
 
 
 Log 
 Analytics 
 Table 
 


 KEY DECISION POINTS 
 
 1. Private Link Configured? 
 - Determines if traffic can use private path 
 
 2. DNS Resolution Result? 
 - Private IP: Traffic flows via ExpressRoute/VPN 
 - Public IP: Troubleshoot DNS configuration 
 
 3. Network Routing? 
 - Must have layer 3 connectivity from on-prem to Azure 
 - ExpressRoute: Preferred (dedicated, reliable) 
 - VPN: Alternative (encrypted over internet) 
 
 4. Authentication? 
 - OAuth token from Azure AD (public endpoint OK) 
 - Token used to authenticate to private DCE 

```

---

## Troubleshooting Flow Diagram

```

 PROBLEM: Cribl Cannot Send Data to Azure via Private Link 

 
 
 
 Test DNS Resolution 
 nslookup <dce-fqdn> 
 
 
 
 
 
 
 Returns Returns 
 Private Public IP 
 IP or Fails 
 
 
 
 
 FIX DNS: 
 - Check cond. 
 forwarders 
 - Verify Private 
 DNS zones 
 - Link zones to 
 VNet 
 
 
 

 Test Network 
 Connectivity 
 nc -zv <private-ip> 443

 
 
 
 
 
Success Fails 
 
 
 
 
 FIX NETWORK: 
 - Verify 
 ExpressRoute/ 
 VPN status 
 - Check routing 
 - Verify NSG 
 rules 
 - Check firewall 
 
 
 

 Test Authentication 
 Get OAuth token 

 
 
 
 
 
Token 401 
OK Error 
 
 
 
 
 FIX AUTH: 
 - Verify Client 
 ID/Secret 
 - Check RBAC 
 on DCR 
 - Verify 
 Monitoring 
 Metrics 
 Publisher role 
 
 
 

 Test Data Ingestion 
 Send test event 

 
 
 
 
 
200 400 
OK Error 
 
 
 
 
 FIX SCHEMA: 
 - Check DCR 
 schema 
 - Verify Cribl 
 output format 
 - Match column 
 names/types 
 
 
 

 Verify Data in LAW 
 KQL Query table 

 
 
 
 
 
Data No Data
Found 
 
 
 
 
 CHECK: 
 - DCR 
 transformation 
 - Table exists 
 - Ingestion 
 latency 
 (wait 5 min) 
 
 
 

 SUCCESS! 
 Private Link working 



 COMMON ISSUES AND FIXES 
 
 DNS returns public IP: 
 → Check conditional forwarders point to 168.63.129.16 
 → Verify Private DNS zones linked to VNet 
 → Clear DNS cache 
 
 Connection timeout: 
 → Verify ExpressRoute/VPN connectivity 
 → Check NSG rules allow 443 from on-prem 
 → Verify route tables 
 
 401 Authentication error: 
 → Verify Client ID and Secret correct 
 → Check "Monitoring Metrics Publisher" role on DCR 
 → Ensure token not expired 
 
 400 Bad Request: 
 → Schema mismatch - check Cribl pipeline output 
 → Verify column names match DCR schema exactly 
 → Check data types match 

```

---

## Conclusion

These diagrams provide comprehensive visual references for understanding and implementing Azure Private Link connectivity for Cribl Stream. Use them alongside the main documentation for complete configuration guidance.

**For detailed step-by-step instructions**, refer to:
- [Private-Link-Configuration-for-Cribl.md](Private-Link-Configuration-for-Cribl.md)

**For questions or issues**:
- Cribl Community Slack: [#azure-everything](https://cribl-community.slack.com/archives/C089V3GCFV0)
- Tool Maintainer: James Pederson - jpederson@cribl.io

---

**Last Updated**: 2025-01-24
**Version**: 1.0
