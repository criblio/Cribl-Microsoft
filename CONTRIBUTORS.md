# Contributing to Cribl-Microsoft

Thank you for your interest in contributing to the Cribl-Microsoft integration repository! This guide will help you contribute effectively to our Azure Data Collection Rules automation and templates.

## 📋 Table of Contents

- [What We're Building](#what-were-building)
- [How to Contribute](#how-to-contribute)
- [Contribution Guidelines](#contribution-guidelines)
- [Testing Requirements](#testing-requirements)
- [Pull Request Process](#pull-request-process)
- [Issue Reporting](#issue-reporting)

## 🎯 What We're Building

This repository provides tools for integrating Cribl Stream with Azure Log Analytics/Sentinel:

- **DCR-Automation**: PowerShell scripts that automate DCR creation
- **DCR-Templates**: Pre-built ARM templates for Sentinel native tables
- **Cribl Configurations**: Auto-generated destination configs for Cribl Stream
- **Future Content**: TBD

## 🤝 How to Contribute

### Types of Contributions Welcome

#### 1. DCR Automation Enhancements
- New features for the PowerShell automation
- Support for additional table types
- Performance improvements
- Bug fixes in schema retrieval or deployment

#### 2. Template Contributions
- ARM templates for new Azure tables
- Custom table schema definitions
- Improved column mappings
- Template optimizations

#### 3. Cribl Integration
- Destination configuration improvements
- Authentication enhancements
- Stream routing optimizations
- Documentation for Cribl setup

#### 4. Documentation
- Setup guides and tutorials
- Troubleshooting guides
- Architecture diagrams
- Video walkthroughs

### Getting Started

1. **Fork the repository**
   ```bash
   git clone https://github.com/your-username/Cribl-Microsoft.git
   cd Cribl-Microsoft
   ```

2. **Create a feature branch**
   ```bash
   git checkout -b feature/your-feature-name
   ```

3. **Make your changes following our guidelines**

4. **Test thoroughly in Azure**

5. **Submit a pull request**

## 📁 Contribution Guidelines

### Repository Structure

```
Azure/CustomDeploymentTemplates/
├── DCR-Automation/              # PowerShell automation scripts
│   ├── *.ps1                   # Core scripts
│   ├── *.json                  # Configuration files
│   ├── custom-table-schemas/   # Custom table definitions
│   └── generated-templates/    # Auto-generated (don't commit)
└── DCR-Templates/               # Static ARM templates
    └── SentinelNativeTables/
        ├── DataCollectionRules(DCE)/    # DCE-based templates
        └── DataCollectionRules(NoDCE)/  # Direct DCR templates
```

### Code Standards

#### PowerShell Scripts
```powershell
# Use clear function names
function New-LogAnalyticsCustomTable {
    param(
        [Parameter(Mandatory=$true)]
        [string]$TableName
    )
    # Include proper error handling
    try {
        # Implementation
    } catch {
        Write-Error "Failed to create table: $_"
    }
}
```

#### JSON Templates
```json
{
  "$schema": "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
  "contentVersion": "1.0.0.0",
  "parameters": {
    "parameterName": {
      "type": "string",
      "metadata": {
        "description": "Clear description of parameter"
      }
    }
  }
}
```

#### Configuration Files
- Never commit real credentials in `azure-parameters.json`
- Use placeholder values like `<YOUR-TENANT-ID-HERE>`
- Document all configuration options

### Documentation Requirements

Every contribution must include:

1. **Updated README**: If adding new features
2. **Inline Comments**: For complex logic
3. **Parameter Descriptions**: For all configurable options
4. **Usage Examples**: For new functionality

## 🧪 Testing Requirements

### Before Submitting

1. **Script Testing**
   - Test with both Direct and DCE-based DCRs
   - Verify custom table creation works
   - Ensure Cribl config export is accurate

2. **Template Validation**
   - Deploy templates in test environment
   - Verify schema completeness
   - Check parameter validation

3. **Integration Testing**
   - Confirm data flows to Log Analytics
   - Validate Cribl destination configs work
   - Test with different Azure regions

### Test Checklist
```markdown
- [ ] Scripts run without errors
- [ ] Templates deploy successfully
- [ ] Documentation is updated
- [ ] No sensitive data in commits
- [ ] Backward compatibility maintained
```

## 🔄 Pull Request Process

### PR Template

```markdown
## Summary
Brief description of changes

## Type of Change
- [ ] Bug fix
- [ ] New feature
- [ ] Documentation update
- [ ] Template addition
- [ ] Performance improvement

## Testing Done
- [ ] Tested in Azure environment
- [ ] Verified Cribl integration
- [ ] Documentation reviewed

## Checklist
- [ ] No real credentials in code
- [ ] Scripts follow style guidelines
- [ ] README updated if needed
- [ ] Tests pass successfully
```

### Review Process

1. All PRs require one maintainer review
2. Focus areas:
   - Security (no credentials)
   - Functionality
   - Documentation quality
   - Backward compatibility
3. Address feedback before merge

## 🐛 Issue Reporting

### Bug Reports Should Include
- Script/template that failed
- Error messages
- Azure region and subscription type
- PowerShell version
- Steps to reproduce

### Feature Requests Should Include
- Use case description
- Expected behavior
- Why it's valuable
- Proposed implementation (optional)

### Good Issue Example
```markdown
**Title**: DCR creation fails for tables with >300 columns

**Description**: 
When running Create-TableDCRs.ps1 for tables with more than 300 columns, 
the deployment times out.

**Environment**:
- PowerShell: 7.3.0
- Azure Region: East US
- Table: CustomLargeTable_CL

**Error**: 
"Deployment failed. Correlation ID: xxx-xxx-xxx"

**Expected**: 
Script should handle large tables or provide clear guidance
```

## 💡 Contribution Ideas

Looking for ways to contribute? Consider:

1. **Add support for new table types**
   - Microsoft 365 Defender tables
   - Azure Monitor metrics tables
   - Third-party security solutions

2. **Enhance automation features**
   - Batch processing improvements
   - Parallel deployment support
   - Rollback capabilities

3. **Improve Cribl integration**
   - Support for Cribl Cloud
   - Advanced routing rules
   - Performance tuning guides

4. **Create tutorials**
   - Video walkthroughs
   - Step-by-step guides
   - Troubleshooting scenarios

## 🙏 Recognition

Contributors are recognized through:
- GitHub contributor stats
- Acknowledgment in release notes
- Credit in documentation updates

## ❓ Questions?

- Check existing [issues](https://github.com/your-org/Cribl-Microsoft/issues)
- Review the [documentation](./Azure/CustomDeploymentTemplates/DCR-Automation/README.md)
- Create a new issue with the "question" label

---

Thank you for contributing to Cribl-Microsoft! Your contributions help organizations efficiently integrate Cribl Stream with Azure Log Analytics.
