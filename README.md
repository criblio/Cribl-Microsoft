# Cribl-Microsoft Integration

Automation tools and templates for integrating Cribl Stream with Microsoft Azure Log Analytics and Sentinel.

## 📁 Repository Contents

### [DCR-Automation](Azure/CustomDeploymentTemplates/DCR-Automation/) 
**PowerShell automation for Azure Data Collection Rules**
- Automated DCR creation for native and custom tables
- Automatic Cribl Stream configuration export
- Supports both Direct and DCE-based deployments
- [Quick Start Guide](Azure/CustomDeploymentTemplates/DCR-Automation/QUICK_START.md)

### [DCR-Templates](Azure/CustomDeploymentTemplates/DCR-Templates/)
**Pre-built ARM templates for manual deployment**
- Templates for Sentinel native tables
- DCE and non-DCE configurations
- Ready-to-deploy JSON templates

### [Lookups](Lookups/)
**Lookup tables and enrichment data for Cribl Stream**
- Static lookup tables for data enrichment
- Dynamic lookups including Active Directory integration
- Reference data for log processing workflows

## 🚀 Quick Start

### For Automated Deployment
```powershell
cd Azure/CustomDeploymentTemplates/DCR-Automation
.\Run-DCRAutomation.ps1
```
See [DCR-Automation Quick Start](Azure/CustomDeploymentTemplates/DCR-Automation/QUICK_START.md)

### For Manual Templates
Browse templates in `Azure/CustomDeploymentTemplates/DCR-Templates/`

## 📋 Prerequisites

- Azure subscription with Log Analytics workspace
- PowerShell with Azure modules (for automation)
- Cribl Stream instance
- Azure AD app registration (for Cribl authentication)

## 🔗 Key Features

- **Automated DCR Creation**: PowerShell scripts handle complex DCR deployments
- **Cribl Integration**: Auto-generates Cribl Stream destination configurations
- **Template Library**: Pre-built templates for common scenarios
- **Multi-Mode Support**: Direct DCRs (simple) or DCE-based (advanced routing)

## 📚 Documentation

- [DCR-Automation README](Azure/CustomDeploymentTemplates/DCR-Automation/README.md) - Detailed automation documentation
- [Cribl Destinations Guide](Azure/CustomDeploymentTemplates/DCR-Automation/CRIBL_DESTINATIONS_README.md) - Cribl configuration details
- [Custom Tables Guide](Azure/CustomDeploymentTemplates/DCR-Automation/custom-table-schemas/README.md) - Creating custom table schemas
- [Static Lookups Guide](Lookups/StaticLookups/README.md) - Static lookup table reference
- [Active Directory Lookups Guide](Lookups/DynamicLookups/ActiveDirectory/README.md) - Dynamic AD lookup integration

## 🤝 Contributing

See [CONTRIBUTORS.md](CONTRIBUTORS.md) for contribution guidelines.

## 📄 License

MIT License - see [LICENSE](LICENSE) file.

## 📝 Release Notes

See [RELEASE_NOTES](RELEASE_NOTES/) for version history and updates.

---

**Need help?** Start with the [Quick Start Guide](Azure/CustomDeploymentTemplates/DCR-Automation/QUICK_START.md) or create an issue.
