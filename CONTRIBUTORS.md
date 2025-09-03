# Contributing to Cribl-Microsoft

We appreciate your interest in contributing to the Cribl-Microsoft repository! This guide will help you understand how to contribute effectively to this project.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [How to Contribute](#how-to-contribute)
- [Contribution Guidelines](#contribution-guidelines)
- [Template Standards](#template-standards)
- [Testing Requirements](#testing-requirements)
- [Pull Request Process](#pull-request-process)
- [Issue Reporting](#issue-reporting)
- [Community Guidelines](#community-guidelines)

## Code of Conduct

By participating in this project, you agree to abide by our code of conduct. We expect all contributors to:

- Be respectful and inclusive
- Focus on constructive feedback
- Help create a welcoming environment for all skill levels
- Respect differing viewpoints and experiences

## Getting Started

### Prerequisites

Before contributing, ensure you have:

- A GitHub account
- Basic knowledge of Git and GitHub workflows
- Understanding of Microsoft Azure services
- Experience with Cribl Stream or Cribl Edge
- Familiarity with JSON and Azure Resource Manager (ARM) templates

### Development Environment

1. Fork the repository on GitHub
2. Clone your fork locally:
   ```bash
   git clone https://github.com/your-username/Cribl-Microsoft.git
   cd Cribl-Microsoft
   ```
3. Create a feature branch:
   ```bash
   git checkout -b feature/your-feature-name
   ```

## How to Contribute

### Types of Contributions

We welcome several types of contributions:

- **New Templates**: Azure deployment templates, Data Collection Rules, or configuration files
- **Documentation**: Improvements to README files, guides, or inline documentation
- **Bug Fixes**: Corrections to existing templates or configurations
- **Feature Enhancements**: Improvements to existing templates or new functionality
- **Examples**: Sample configurations or use case demonstrations
- **Architecture Diagrams**: Visual representations of integration patterns

### Contribution Areas

#### Azure Templates
- Data Collection Rules (DCR) for new Azure services
- Custom table definitions for Azure Sentinel
- PowerShell or CLI deployment scripts
- ARM templates for Azure resource provisioning

#### Documentation
- Usage guides and tutorials
- Best practices documentation
- Troubleshooting guides
- Architecture documentation

## Contribution Guidelines

### File Organization

When adding new content, follow the established directory structure:

```
Azure/
├── CustomDeploymentTemplates/
│   ├── DataCollectionRules/
│   │   ├── SentinelCustomTables/
│   │   └── SentinelNativeTables/
│   └── [YourNewCategory]/
└── Diagrams/
```

### Naming Conventions

- **Files**: Use descriptive, kebab-case names (e.g., `dcr-custom-security-log.json`)
- **Directories**: Use PascalCase for directory names (e.g., `CustomDeploymentTemplates`)
- **Variables**: Follow Azure naming conventions for resource names

### Documentation Requirements

Every contribution must include appropriate documentation:

1. **README Files**: Each new directory must contain a README.md explaining its purpose
2. **Inline Comments**: JSON templates should include comments where applicable
3. **Parameter Descriptions**: All configurable parameters must be documented
4. **Examples**: Provide usage examples for complex templates

## Template Standards

### JSON Templates

- Use proper JSON formatting with consistent indentation (2 spaces)
- Include parameter descriptions and default values where appropriate
- Use meaningful parameter names that clearly indicate their purpose
- Include validation rules for parameters when possible

### Azure DCR Templates

- Follow Azure Data Collection Rules schema requirements
- Include both endpoint and non-endpoint configurations where applicable
- Provide clear data transformation rules
- Document any custom KQL queries used

### Security Considerations

- Never include sensitive information (passwords, keys, connection strings)
- Use Azure Key Vault references for secrets
- Implement least-privilege access principles
- Document security implications in template descriptions

## Testing Requirements

### Validation Steps

Before submitting a contribution:

1. **Syntax Validation**: Ensure all JSON files are valid
2. **Template Testing**: Test templates in a non-production Azure environment
3. **Documentation Review**: Verify all documentation is accurate and complete
4. **Link Checking**: Ensure all internal and external links work correctly

### Test Environments

- Test templates in isolated Azure subscriptions
- Verify compatibility with supported Azure regions
- Test with different Cribl deployment scenarios
- Validate data flow from source to destination

## Pull Request Process

### Before Submitting

1. Ensure your branch is up to date with the main branch
2. Run all validation checks
3. Update documentation as needed
4. Add or update tests for your changes

### PR Description Template

Please include the following in your pull request description:

```markdown
## Summary
Brief description of the changes

## Type of Change
- [ ] New template/configuration
- [ ] Bug fix
- [ ] Documentation update
- [ ] Feature enhancement

## Testing
- [ ] Tested in Azure environment
- [ ] Documentation reviewed
- [ ] JSON syntax validated

## Checklist
- [ ] My code follows the project's style guidelines
- [ ] I have performed a self-review of my changes
- [ ] I have commented my code where necessary
- [ ] I have made corresponding changes to documentation
- [ ] My changes generate no new warnings
```

### Review Process

1. All pull requests require review from at least one maintainer
2. Reviews will focus on functionality, security, and documentation quality
3. Address all feedback before the PR can be merged
4. Once approved, a maintainer will merge your contribution

## Issue Reporting

### Bug Reports

When reporting bugs, please include:

- Clear description of the issue
- Steps to reproduce the problem
- Expected vs. actual behavior
- Environment details (Azure region, Cribl version, etc.)
- Relevant error messages or logs

### Feature Requests

For new features, provide:

- Clear description of the requested functionality
- Use case and business justification
- Proposed implementation approach (if applicable)
- Any relevant examples or references

### Issue Templates

Use the appropriate issue template when creating new issues:

- **Bug Report**: For reporting problems with existing templates
- **Feature Request**: For suggesting new functionality
- **Documentation**: For documentation improvements
- **Question**: For general questions about the project

## Community Guidelines

### Communication Channels

- **GitHub Issues**: Primary channel for bug reports and feature requests
- **Pull Requests**: For code contributions and technical discussions
- **Discussions**: For general questions and community interaction

### Best Practices

- Search existing issues before creating new ones
- Provide clear, detailed descriptions in all communications
- Be patient and respectful in all interactions
- Help others when possible

### Recognition

Contributors will be recognized through:

- Acknowledgment in release notes for significant contributions
- Contributor listings in project documentation
- GitHub contributor statistics

## Questions and Support

If you have questions about contributing:

1. Check the existing documentation and issues
2. Create a new issue with the "question" label
3. Reach out through GitHub discussions

Thank you for your interest in contributing to Cribl-Microsoft! Your contributions help make this project better for the entire community.
