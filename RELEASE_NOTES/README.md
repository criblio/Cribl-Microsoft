# Release Notes

All releases for the Cribl-Microsoft integration repository are documented here. Each release includes details about new features, improvements, bug fixes, and known issues.

## Releases

| Version | Release Date | Highlights |
|---------|--------------|------------|
| [v1.0.2](v1.0.2.md) | 2024/09/19 | Schema processing fixes, Cribl export authentication, MMA table support |
| [v1.0.1](v1.0.1.md) | 2024/09/18 | Interactive menu interface, table collision fix, enhanced error handling |
| [v1.0.0](v1.0.0.md) | 2025/09/12 | Initial release - DCR Automation, DCR ARM templates, Cribl integration |

## Release Types

- **Major (X.0.0)**: Breaking changes or significant new features
- **Minor (1.X.0)**: New features, non-breaking changes
- **Patch (1.0.X)**: Bug fixes, documentation updates

## Latest Release

### [Version 1.0.2](v1.0.2.md) - Schema Processing & Cribl Export Fixes
**Released:** September 19, 2024

This patch release addresses critical schema processing issues and enhances Cribl integration:

#### Critical Bug Fixes
- **Schema Processing for MMA Legacy Tables**: Fixed nested schema property access (`.schema.columns` vs `.columns`)
- **Cribl Export Authentication**: Fixed ClientId quoting in destination configurations
- **Azure Authentication Handling**: Improved context detection and token refresh logic
- **PowerShell Syntax Fixes**: Resolved emoji encoding and parameter block issues

#### Key Improvements
- **Enhanced Table Type Detection**: Automatic support for both DCR-based and MMA legacy tables
- **Schema Flattening Logic**: Added backward compatibility for different table structures
- **Better Error Handling**: Improved debugging and diagnostic information
- **Documentation Updates**: Updated migration guide to reflect automatic capabilities

#### For Existing Users
No action required - fixes are backward compatible and automatically handle different table types:
```powershell
# Schema processing now works with all table types
.\Run-DCRAutomation.ps1
# Select option [4] for Custom Tables

# Cribl configs now have proper authentication formatting
# Check cribl-dcr-configs/destinations/ for updated files
```

See the [full release notes](v1.0.2.md) for complete technical details.

---

### [Version 1.0.1](v1.0.1.md) - Interactive Menu & Table Collision Fix
**Released:** September 18, 2024

Introduced interactive menu system and fixed critical table name collision issues.

---

### [Version 1.0.0](v1.0.0.md) - Initial Release
**Released:** September 12, 2025

The initial release provides comprehensive automation tools and templates for integrating Cribl Stream with Azure Log Analytics and Microsoft Sentinel, including:
- PowerShell automation for DCR creation
- 50 pre-built ARM templates
- Automatic Cribl configuration generation
- Support for both native and custom tables

## Installation

See the [Quick Start Guide](../Azure/CustomDeploymentTemplates/DCR-Automation/QUICK_START.md) for installation and setup instructions.

## Upgrade Guide

### Upgrading to Latest Version (1.0.2)
1. **Backup your configuration files** (azure-parameters.json, operation-parameters.json)
2. **Pull the latest changes** from the repository
3. **Test schema processing** with your existing tables (automatic compatibility)
4. **Re-export Cribl configurations** to get properly formatted authentication
5. **Verify table type detection** works correctly with your custom tables

### Upgrading from 1.0.0 to 1.0.1
1. **Backup your configuration files** (azure-parameters.json, operation-parameters.json)
2. **Pull the latest changes** from the repository
3. **Review your custom table names** for potential conflicts with native tables
4. **Test the new menu interface** before updating automation scripts
5. **Update automation scripts** to use `-NonInteractive` flag if needed

## Support

For issues or questions about any release, please use the GitHub Issues section.

## Version History Summary

| Version | Type | Key Changes |
|---------|------|-------------|
| 1.0.2 | Patch | Schema processing fixes, Cribl auth, MMA table support |
| 1.0.1 | Patch | Interactive menu, bug fixes, improved UX |
| 1.0.0 | Major | Initial release with full feature set |
