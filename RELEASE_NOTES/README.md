# Release Notes

All releases for the Cribl-Microsoft integration repository are documented here. This repository contains multiple components that are versioned separately based on their functionality and development lifecycle.

## Component Structure

This repository contains the following components with independent versioning:

### 🔷 DCR Automation Tools
**Location:** `Azure/CustomDeploymentTemplates/DCR-Automation/`
**Purpose:** PowerShell automation for Azure Data Collection Rules creation and Cribl integration
**Current Version:** [v1.0.2](DCR-Automation/v1.0.2.md)

### 🔶 Lookups
**Location:** `Lookups/`
**Purpose:** Static and dynamic lookup functionality for data enrichment
**Current Version:** [v1.0.0](Lookups/v1.0.0.md)

### 📚 Knowledge Articles
**Location:** `KnowledgeArticles/`
**Purpose:** Documentation, migration guides, and best practices
**Versioned with:** Repository releases

## Component Releases

### DCR Automation Tools

| Version | Release Date | Highlights |
|---------|--------------|------------|
| [v1.0.2](DCR-Automation/v1.0.2.md) | 2024/09/19 | Schema processing fixes, Cribl export authentication, MMA table support |
| [v1.0.1](DCR-Automation/v1.0.1.md) | 2024/09/18 | Interactive menu interface, table collision fix, enhanced error handling |
| [v1.0.0](DCR-Automation/v1.0.0.md) | 2024/09/12 | Initial release - DCR Automation, ARM templates, Cribl integration |

### Lookups

| Version | Release Date | Highlights |
|---------|--------------|------------|
| [v1.0.0](Lookups/v1.0.0.md) | 2024/09/19 | Active Directory lookup integration, static and dynamic lookup support |

## Latest Releases

### 🔷 DCR Automation Tools - [Version 1.0.2](DCR-Automation/v1.0.2.md)
**Released:** September 19, 2024

Critical bug fixes for schema processing and Cribl export functionality:

#### Key Fixes
- **Schema Processing for MMA Legacy Tables**: Fixed nested schema property access
- **Cribl Export Authentication**: Fixed ClientId quoting in destination configurations
- **Azure Authentication Handling**: Improved context detection and token refresh logic
- **PowerShell Syntax Fixes**: Resolved emoji encoding and parameter block issues

#### For Existing Users
Backward compatible fixes that automatically handle different table types.

---

### 🔶 Lookups - [Version 1.0.0](Lookups/v1.0.0.md)
**Released:** September 19, 2024

Initial release of lookup functionality with Active Directory integration:

#### Key Features
- **Active Directory Lookup Integration**: Enhanced user context for security analytics (by Stacy Simmons)
- **Static Lookups**: File-based lookup tables for data enrichment
- **Dynamic Lookups**: Real-time lookup capabilities with caching
- **Flexible Configuration**: Support for various lookup sources and formats

#### For New Users
Independent component that can be used alongside DCR automation or standalone.

## Release Types

- **Major (X.0.0)**: Breaking changes or significant new features
- **Minor (1.X.0)**: New features, non-breaking changes
- **Patch (1.0.X)**: Bug fixes, documentation updates

## Installation & Setup

### DCR Automation Tools
See the [DCR Automation Quick Start Guide](../Azure/CustomDeploymentTemplates/DCR-Automation/QUICK_START.md) for installation and setup instructions.

### Lookups
See the [Lookups Documentation](../Lookups/README.md) for setup and configuration instructions.

## Upgrade Guides

### DCR Automation Tools
#### Upgrading to v1.0.2
1. **Backup your configuration files** (azure-parameters.json, operation-parameters.json)
2. **Pull the latest changes** from the repository
3. **Test schema processing** with your existing tables (automatic compatibility)
4. **Re-export Cribl configurations** to get properly formatted authentication
5. **Verify table type detection** works correctly with your custom tables

#### Upgrading from v1.0.0 to v1.0.1
1. **Backup your configuration files**
2. **Pull the latest changes** from the repository
3. **Review your custom table names** for potential conflicts with native tables
4. **Test the new menu interface** before updating automation scripts
5. **Update automation scripts** to use `-NonInteractive` flag if needed

### Lookups
#### New Installation (v1.0.0)
1. **Review the Lookups documentation** for setup requirements
2. **Configure lookup sources** according to your environment
3. **Test lookup functionality** before production deployment
4. **Integrate with existing Cribl pipelines** as needed

## Support

For component-specific issues:

### DCR Automation Tools
- **General Issues**: [GitHub Issues](https://github.com/criblio/Cribl-Microsoft/issues)
- **Technical Support**: James Pederson jpederson@cribl.io
- **Community**: [Cribl Slack](https://cribl.io/community)

### Lookups
- **Lookup Issues**: [GitHub Issues](https://github.com/criblio/Cribl-Microsoft/issues)
- **AD Lookup Support**: Stacy Simmons (contributor contact via GitHub)
- **Community**: [Cribl Slack](https://cribl.io/community)

## Component Version History

### DCR Automation Tools
| Version | Type | Key Changes |
|---------|------|-------------|
| 1.0.2 | Patch | Schema processing fixes, Cribl auth, MMA table support |
| 1.0.1 | Patch | Interactive menu, bug fixes, improved UX |
| 1.0.0 | Major | Initial release with full feature set |

### Lookups
| Version | Type | Key Changes |
|---------|------|-------------|
| 1.0.0 | Major | Initial release with AD lookup, static/dynamic lookup support |

---

**Note:** Each component in this repository is developed and versioned independently. Choose the components and versions that best fit your integration needs.