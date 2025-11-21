# Cribl-Microsoft Integration

Enterprise-grade automation toolkit for integrating Cribl Stream with Microsoft Azure services. This repository provides production-ready PowerShell automation for data collection, infrastructure provisioning, and configuration management.

## Repository Contents

### Core Automation Tools

#### [DCR-Automation](Azure/CustomDeploymentTemplates/DCR-Automation/)
**PowerShell automation for Azure Data Collection Rules**
- Automated DCR creation for 50+ native Azure tables and custom tables
- Automatic Cribl Stream destination configuration export
- Supports Direct DCRs (30-char limit) and DCE-based DCRs (64-char limit)
- Interactive menu interface with non-interactive CI/CD mode
- Name abbreviation intelligence for Azure limits
- [Quick Start Guide](Azure/CustomDeploymentTemplates/DCR-Automation/QUICK_START.md)

#### [DCR-Templates](Azure/CustomDeploymentTemplates/DCR-Templates/)
**Pre-built ARM templates for manual deployment**
- 100+ ready-to-deploy ARM templates for Sentinel native tables
- DCE and non-DCE configurations
- SecurityEvent, CommonSecurityLog, DeviceEvents, ASim tables, and more

### Lab Environments

#### [Azure Flow Log Lab](Azure/Labs/AzureFlowLogLab/)
**Standalone lab for Azure Flow Log infrastructure**
- VNet with dual-level flow logging (vNet-level + subnet-level)
- VPN Gateway for site-to-site VPN connectivity
- Test VM deployment with auto-shutdown schedules
- Automatic Cribl collector configuration generation

### Additional Resources

#### [Lookups](Lookups/)
**Lookup tables and enrichment data for Cribl Stream**
- Static lookup tables for data enrichment
- Dynamic lookups with Active Directory integration (Python-based LDAP)
- Reference data for log processing workflows

## Quick Start

### DCR Automation (Azure Log Analytics)
```powershell
cd Azure/CustomDeploymentTemplates/DCR-Automation
.\Run-DCRAutomation.ps1
```
See [DCR-Automation Quick Start](Azure/CustomDeploymentTemplates/DCR-Automation/QUICK_START.md)

### Manual Template Deployment
Browse templates in `Azure/CustomDeploymentTemplates/DCR-Templates/`

### Azure Flow Log Lab
```powershell
cd Azure/Labs/AzureFlowLogLab
.\Run-AzureFlowLogLab.ps1
```

## Prerequisites

- Azure subscription with Log Analytics workspace
- PowerShell 5.1+ with Azure modules (Az.Accounts, Az.Resources, Az.OperationalInsights)
- Cribl Stream instance (4.14+ for Direct DCRs)
- Azure AD app registration (for Cribl authentication)

## Key Features

- **Automated DCR Creation**: PowerShell scripts handle complex DCR deployments
- **Cribl Integration**: Auto-generates Cribl Stream source and destination configurations
- **Template Library**: Pre-built ARM templates for common scenarios
- **Multi-Mode Support**: Direct DCRs (simple) or DCE-based (advanced routing)
- **Lab Environments**: Complete testing environments deployable in hours
- **Menu-Driven Interfaces**: Interactive menus with non-interactive CI/CD modes
- **Configuration-Driven**: JSON-based configuration files separate from code

## Architecture Patterns

All major components follow consistent design patterns:

1. **Interactive Menu Pattern**: `Run-*.ps1` main entry points with menu interfaces
2. **Configuration-Driven Design**: Separate `azure-parameters.json` and `operation-parameters.json` files
3. **Template-Based Generation**: Automated generation of ARM templates and Cribl configurations
4. **Modular Script Design**: Helper functions and reusable components
5. **Documentation-First Approach**: Comprehensive README, Quick Start, and Architecture guides

## Documentation

### Automation Guides
- [DCR-Automation README](Azure/CustomDeploymentTemplates/DCR-Automation/README.md) - Detailed DCR automation

### Configuration Guides
- [Cribl Destinations Guide](Azure/CustomDeploymentTemplates/DCR-Automation/CRIBL_DESTINATIONS_README.md) - Cribl configuration details
- [Custom Tables Guide](Azure/CustomDeploymentTemplates/DCR-Automation/custom-table-schemas/README.md) - Creating custom table schemas
- [Active Directory Lookups Guide](Lookups/DynamicLookups/ActiveDirectory/README.md) - Dynamic AD lookup integration

### Knowledge Articles
- [Azure Monitor Migration](KnowledgeArticles/AzureMonitorMigration/Cribl_Azure_Monitor_to_Sentinel_Migration.md) - Migration guidance
- [Private Link Configuration](KnowledgeArticles/PrivateLinkConfiguration/Private-Link-Configuration-for-Cribl.md) - Detailed Private Link setup
- [O365 App Registration](KnowledgeArticles/O365AppRegistrationForCribl/O365-AppRegistration_for_Cribl.md) - Office 365 app setup

### Project Documentation
- [CLAUDE.md](CLAUDE.md) - Comprehensive project guidance and architecture (for AI assistants)
- [PROJECT_REVIEW_2025-10-27.md](PROJECT_REVIEW_2025-10-27.md) - Detailed project review

## Technology Stack

**PowerShell:** 5.1+
- Az.Accounts, Az.Resources, Az.OperationalInsights, Az.EventHub, Az.Monitor

**Infrastructure-as-Code:**
- ARM Templates (Azure)

**Cloud Platform:**
- Microsoft Azure

**Integrations:**
- Cribl Stream 4.14+
- Microsoft Sentinel
- Azure Log Analytics
- Azure Event Hub
- Azure Data Explorer
- Active Directory (LDAP)

## Security Considerations

- Azure AD credentials managed via app registrations
- Role-based access control (RBAC) for all cloud resources
- Secure credential storage recommendations in documentation
- Never commit real credentials to version control
- Support for Cribl secrets management

## Git Workflow

**The `main` branch is protected** - all changes must come through pull requests.

### Branch Naming Convention
- `feature/` - New features or enhancements
- `fix/` - Bug fixes
- `docs/` - Documentation updates
- `refactor/` - Code refactoring
- `test/` - Test additions or updates

### Commit Message Guidelines
- Use present tense verbs ("Add" not "Added")
- Keep first line under 50 characters
- Be descriptive and specific

## Contributing

See [CONTRIBUTORS.md](CONTRIBUTORS.md) for contribution guidelines.

Before submitting changes:
1. Test with both Direct and DCE-based configurations (for Azure DCR changes)
2. Verify configuration files are valid JSON
3. Deploy in test environment first
4. Update documentation for new features
5. Follow existing architecture patterns

## License

MIT License - see [LICENSE](LICENSE) file.

## Support

- **Documentation**: Start with Quick Start guides for each component
- **Issues**: Create an issue in the repository
- **Questions**: Check component-specific README files for troubleshooting sections

---

**Getting Started?**
- For Azure Log Analytics ingestion: [DCR-Automation Quick Start](Azure/CustomDeploymentTemplates/DCR-Automation/QUICK_START.md)
- For lab environments: [Azure Flow Log Lab](Azure/Labs/AzureFlowLogLab/)
