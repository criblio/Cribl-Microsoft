# Azure Private Link Configuration for Cribl Stream

This directory contains comprehensive documentation for enabling Azure Private Link connectivity between on-premises Cribl Stream worker nodes and Azure Log Analytics/Sentinel.

## Documentation Files

### [Private-Link-Configuration-for-Cribl.md](Private-Link-Configuration-for-Cribl.md)
**Main documentation** - Complete step-by-step guide covering:
- Azure Private Link Scope (AMPLS) setup
- Data Collection Endpoint (DCE) configuration with Private Link
- Private Endpoint creation and DNS integration
- DNS resolution options:
 - Active Directory DNS configuration
 - Azure Private DNS Resolver deployment
- DCR Automation tool integration
- Cribl Stream destination configuration
- Testing and troubleshooting procedures
- Network security best practices

### [Network-Architecture-Diagrams.md](Network-Architecture-Diagrams.md)
**Architecture reference** - Visual documentation including:
- Complete network topology diagrams
- DNS resolution flow diagrams
- Data ingestion flow with Private Link
- Component relationship diagrams
- Alternative architecture patterns

## Quick Navigation

| Topic | Section Link |
|-------|-------------|
| **Getting Started** | [Prerequisites](Private-Link-Configuration-for-Cribl.md#prerequisites) |
| **Azure Setup** | [Step-by-Step Configuration](Private-Link-Configuration-for-Cribl.md#step-by-step-configuration) |
| **DNS with AD** | [Active Directory DNS](Private-Link-Configuration-for-Cribl.md#option-1-active-directory-dns-on-premises-dns-servers) |
| **DNS with Azure** | [Azure Private DNS Resolver](Private-Link-Configuration-for-Cribl.md#option-2-azure-private-dns-resolver) |
| **DCR Automation** | [Run DCR Automation](Private-Link-Configuration-for-Cribl.md#step-7-run-dcr-automation-with-private-link) |
| **Cribl Config** | [Configure Cribl Stream](Private-Link-Configuration-for-Cribl.md#step-8-configure-cribl-stream-destination) |
| **Troubleshooting** | [Troubleshooting Guide](Private-Link-Configuration-for-Cribl.md#troubleshooting-guide) |
| **Architecture** | [Network Architecture](Network-Architecture-Diagrams.md) |

## What This Enables

This configuration allows you to:

 **Secure Data Path**: Send logs from on-premises Cribl workers to Azure over private connections (ExpressRoute/VPN)
 **Compliance**: Meet regulatory requirements for data sovereignty and network isolation
 **No Public Exposure**: Eliminate public endpoint access to Log Analytics and DCEs
 **Enterprise Integration**: Integrate with existing AD DNS or use Azure DNS services
 **DCR/DCE Support**: Full compatibility with Azure Data Collection Rules architecture
 **Automated Deployment**: Use DCR Automation tool for consistent, repeatable deployments

## Use Cases

**Ideal for:**
- Financial services and healthcare organizations with strict compliance requirements
- Government agencies requiring data sovereignty
- Enterprise environments with established private connectivity (ExpressRoute/VPN)
- Organizations with policies prohibiting public internet data transfer
- Multi-region deployments needing centralized monitoring

**Not required for:**
- Cloud-native deployments where Cribl runs in Azure
- Organizations comfortable with public endpoint ingestion over TLS
- Simple dev/test environments without compliance requirements

## Architecture Overview

```

 On-Premises Network 
 
 
 
 Cribl > DNS Server 
 Worker Query (AD or Azure 
 Node DNS Resolver) 
 
 
 
 Resolve DCE FQDN 
 to Private IP 
 
 Returns: 10.x.x.x 
 
 ExpressRoute/VPN 

 
 

 Azure Virtual Network 
 
 
 Private Endpoint (10.x.x.x) 
 - Subnet: subnet-private-endpoints 
 - Connects to: Azure Monitor Private Link Scope 
 
 
 

 
 Private Connection
 

 Azure Monitor Services 
 
 
 Data Collection > Log Analytics 
 Endpoint (DCE) Workspace 
 - Private access - Custom Tables 
 - DCR associations - Native Tables 
 
 
 
 Azure Monitor Private Link Scope (AMPLS) 
 - Contains: Workspace + DCE 
 - Enables: Private connectivity 
 

```

## Implementation Timeline

**Typical deployment**: 1-2 days for experienced Azure administrators

| Phase | Duration | Tasks |
|-------|----------|-------|
| **Planning** | 2-4 hours | Review requirements, gather credentials, identify tables |
| **Azure Setup** | 3-4 hours | Create AMPLS, DCE, Private Endpoints, configure DNS |
| **DCR Creation** | 1-2 hours | Run DCR Automation tool, review outputs |
| **Cribl Config** | 1-2 hours | Create destinations, update pipelines |
| **Testing** | 2-4 hours | Validate connectivity, DNS resolution, data flow |
| **Monitoring** | Ongoing | Monitor ingestion, troubleshoot issues |

## Prerequisites Checklist

Before starting, ensure you have:

- [ ] Azure subscription with permissions to create resources
- [ ] Log Analytics workspace (existing or new)
- [ ] Virtual Network with subnet for Private Endpoints
- [ ] ExpressRoute or Site-to-Site VPN from on-premises to Azure
- [ ] DNS infrastructure (Active Directory DNS or Azure DNS Resolver)
- [ ] Cribl Stream 4.14+ installed on-premises
- [ ] Azure App Registration with client secret
- [ ] PowerShell 5.1+ with Az modules installed
- [ ] DCR Automation tool cloned from GitHub

## Related Documentation

### In This Repository
- [DCR Automation Quick Start](../../Azure/CustomDeploymentTemplates/DCR-Automation/QUICK_START.md)
- [Azure Monitor Migration Guide](../AzureMonitorMigration/Cribl_Azure_Monitor_to_Sentinel_Migration.md)
- [O365 App Registration Guide](../O365AppRegistrationForCribl/O365-AppRegistration_for_Cribl.md)

### External Resources
- [Azure Private Link Overview](https://learn.microsoft.com/en-us/azure/azure-monitor/logs/private-link-security)
- [Data Collection Rules](https://learn.microsoft.com/en-us/azure/azure-monitor/essentials/data-collection-rule-overview)
- [Cribl Sentinel Destination](https://docs.cribl.io/stream/destinations-sentinel/)

## Support

### Issues and Questions
- **DCR Automation Tool**: [GitHub Issues](https://github.com/criblio/Cribl-Microsoft/issues)
- **Cribl Community**: [Slack #azure-everything](https://cribl-community.slack.com/archives/C089V3GCFV0)

### Contact
- **Tool Maintainer**: James Pederson - jpederson@cribl.io
- **Architecture Support**: Cribl Solutions Architects

---

**Last Updated**: 2025-01-24
**Maintained By**: Cribl Solutions Engineering
