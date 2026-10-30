# Contributing to Cribl-Microsoft

Status: Living - the contributor guide; corrected to match the repository.

Thank you for your interest in contributing to the Cribl-Microsoft integration repository! This guide will help you contribute effectively to the SOC Optimization Toolkit and the DCR templates.

## Table of Contents

- [What We're Building](#what-were-building)
- [Branching Policy](#branching-policy)
- [How to Contribute](#how-to-contribute)
- [Contribution Guidelines](#contribution-guidelines)
- [Testing Requirements](#testing-requirements)
- [Pull Request Process](#pull-request-process)
- [Issue Reporting](#issue-reporting)

## What We're Building

This repository provides tools for integrating Cribl Stream with Azure Log Analytics/Sentinel:

- **SOC Optimization Toolkit** (`soc-optimizationtoolkit/`) - the active
  deliverable: a Cribl.Cloud app built as npm workspaces - `packages/core`
  (pure domain logic), `packages/ui` (React screens) and `apps/cribl-app` (the
  Cribl.Cloud shell and its adapters). Work is tracked on
  `soc-optimizationtoolkit/docs/board.md`.
- **DCR-Templates** (`Azure/CustomDeploymentTemplates/DCR-Templates/`) -
  pre-built ARM templates for Sentinel native tables; the manual path.
- **`deprecated/`** - the PowerShell DCR-Automation, the Electron GUI and the v1
  toolkit. Frozen since 2026-07-13: it receives no further development and is
  closed to contributions (see `deprecated/README.md`).

## Branching Policy

### Protected Branches

**The `main` branch is protected and requires:**
- **NO direct commits** - all changes must come through pull requests
- At least one reviewer approval before merging
- All status checks must pass
- Branch must be up to date with main before merging

### Branching Best Practices

#### Branch Naming Convention

Use descriptive branch names with the following prefixes:

- `feature/` - New features or enhancements
 - Example: `feature/add-custom-table-support`
- `fix/` - Bug fixes
 - Example: `fix/dcr-deployment-timeout`
- `docs/` - Documentation updates
 - Example: `docs/update-setup-guide`
- `refactor/` - Code refactoring without functional changes
 - Example: `refactor/improve-error-handling`
- `test/` - Test additions or updates
 - Example: `test/add-integration-tests`

#### Workflow Requirements

1. **Never work directly on main**
 ```bash
 # NEVER DO THIS
 git checkout main
 git add .
 git commit -m "My changes"
 git push # This will be rejected!
 ```

2. **Always create a feature branch**
 ```bash
 # ALWAYS DO THIS
 git checkout main
 git pull origin main # Get latest changes
 git checkout -b feature/your-feature-name
 # Make your changes
 git add .
 git commit -m "Descriptive commit message"
 git push origin feature/your-feature-name
 # Then create a Pull Request on GitHub
 ```

3. **Keep your branch up to date**
 ```bash
 # Regularly sync with main
 git checkout main
 git pull origin main
 git checkout your-branch
 git merge main # or git rebase main
 ```

4. **One feature per branch**
 - Keep branches focused on a single feature or fix
 - Create separate branches for unrelated changes
 - Delete branches after merging

#### Commit Message Guidelines

- Use clear, descriptive commit messages
- Start with a verb in present tense
- Keep the first line under 50 characters
- Add detailed description if needed

```bash
# Good examples
git commit -m "Add support for custom table schemas"
git commit -m "Fix timeout issue in DCR deployment"
git commit -m "Update README with troubleshooting guide"

# Bad examples
git commit -m "Fixed stuff"
git commit -m "Updates"
git commit -m "WIP"
```

## How to Contribute

### Types of Contributions Welcome

#### 1. SOC Optimization Toolkit
- Core domain logic (`packages/core`) - pure, with no IO or React
- UI screens (`packages/ui`)
- Cribl app adapters and shipped config (`apps/cribl-app`)
- Bug fixes - file a card on the board first (see `soc-optimizationtoolkit/docs/documenting-work.md`)

The PowerShell DCR-Automation is deprecated; enhancements to it are no longer
accepted.

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
 # Fork via GitHub UI first, then:
 git clone https://github.com/your-username/Cribl-Microsoft.git
 cd Cribl-Microsoft
 ```

2. **Add upstream remote**
 ```bash
 git remote add upstream https://github.com/criblio/Cribl-Microsoft.git  # update after the repository move
 git fetch upstream
 ```

3. **Create a feature branch from main**
 ```bash
 # IMPORTANT: Always branch from latest main
 git checkout main
 git pull upstream main
 git checkout -b feature/your-feature-name
 ```

4. **Make your changes following our guidelines**
 ```bash
 # Make changes
 git add .
 git commit -m "Clear description of changes"
 ```

5. **Push to your fork**
 ```bash
 git push origin feature/your-feature-name
 ```

6. **Run the checks** in [Testing Requirements](#testing-requirements)

7. **Submit a pull request**
 - Go to GitHub and create a PR from your branch to `main`
 - Use the [PR template](#pr-template) below
 - Wait for review and address feedback

## Contribution Guidelines

### Repository Structure

```
soc-optimizationtoolkit/ # The active toolkit (npm workspaces)
 packages/core/ # Pure domain logic and port interfaces
 packages/ui/ # React screens
 apps/cribl-app/ # Cribl.Cloud shell, adapters, release/
 docs/ # board.json, backlog.md, adr/
Azure/CustomDeploymentTemplates/
 DCR-Templates/ # Static ARM templates
 SentinelNativeTables/
 DataCollectionRules(DCE)/ # DCE-based templates
 DataCollectionRules(NoDCE)/ # Direct DCR templates
KnowledgeArticles/ # Integration knowledge base articles
deprecated/ # Frozen: PowerShell automation, Electron GUI, v1 toolkit
```

### Code Standards

#### TypeScript (toolkit)
- Keep `packages/core` pure: no IO, no React; reach Azure, Cribl and GitHub
  through a port the shell implements
- Read the workspace's `CONTEXT.md` before changing it, and
  `soc-optimizationtoolkit/docs/adr/` for decisions already made
- `npm run lint` (oxlint) and `npm run typecheck` must pass
- No emojis in code, comments, output or docs

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

## Testing Requirements

### Before Submitting

1. **Toolkit changes** - from `soc-optimizationtoolkit/` (Node 22, the version CI uses):
 ```bash
 npm install
 npm run lint
 npm run typecheck
 npm test
 npm run build
 npm run check-docs
 npm run check-board
 ```
 CI (`.github/workflows/soc-toolkit-ci.yml`) also runs `check-release`,
 `check-listings`, `check-classnames`, `check-schema-asset` and
 `check-board-freshness` on every PR that touches `soc-optimizationtoolkit/`.

2. **Template Validation** (DCR-Templates changes only)
 - Deploy templates in test environment
 - Verify schema completeness
 - Check parameter validation

3. **Integration Testing** (DCR-Templates changes only)
 - Confirm data flows to Log Analytics
 - Validate Cribl destination configs work
 - Test with different Azure regions

### Test Checklist
```markdown
- [ ] Toolkit checks pass (lint, typecheck, test, build, check-docs, check-board)
- [ ] Templates deploy successfully (template changes)
- [ ] Documentation is updated
- [ ] No sensitive data in commits
- [ ] Backward compatibility maintained
```

## Pull Request Process

### Before Creating a PR

**Ensure you:**
- Created your changes in a feature branch (NOT main)
- Tested your changes thoroughly
- Updated documentation if needed
- Followed the coding standards
- Rebased or merged latest main into your branch
- Resolved any conflicts

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
- [ ] Code follows style guidelines
- [ ] README updated if needed
- [ ] Tests pass successfully
```

### Review Process

1. **All PRs require:**
 - At least one maintainer review and approval
 - All CI/CD checks to pass
 - No merge conflicts with main
 - Up-to-date with latest main branch

2. **Review focus areas:**
 - Security (no credentials or sensitive data)
 - Functionality and testing
 - Documentation quality
 - Backward compatibility
 - Adherence to branching policies

3. **After approval:**
 - Maintainer will merge using "Squash and merge" or "Merge commit"
 - Your feature branch will be automatically deleted after merge
 - Changes will be reflected in main branch

### Why These Policies?

- **Protect production code**: Main branch should always be stable
- **Enable collaboration**: Multiple people can review and improve code
- **Maintain history**: Clear record of what changed and why
- **Prevent accidents**: No accidental commits to production
- **Quality assurance**: All code is reviewed before merging

## Issue Reporting

### Bug Reports Should Include
- Script/template that failed
- Error messages
- Azure region and subscription type
- App version (toolkit) or template name (DCR-Templates)
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

## Contribution Ideas

Looking for ways to contribute? Consider:

1. **Add support for new table types**
 - Microsoft 365 Defender tables
 - Azure Monitor metrics tables
 - Third-party security solutions

2. **Pick up open toolkit work**
 - See `soc-optimizationtoolkit/docs/board.md` and `docs/backlog.md`

3. **Improve Cribl integration**
 - Advanced routing rules
 - Performance tuning guides

4. **Create tutorials**
 - Video walkthroughs
 - Step-by-step guides
 - Troubleshooting scenarios

## Recognition

Contributors are recognized through:
- GitHub contributor stats
- Acknowledgment in release notes
- Credit in documentation updates

## Questions?

- Check existing [issues](https://github.com/criblio/Cribl-Microsoft/issues) (update after the repository move)
- Review the documentation: [README](./README.md), [QUICK_START](./QUICK_START.md) and the [toolkit README](./soc-optimizationtoolkit/README.md)
- Create a new issue with the "question" label

---

Thank you for contributing to Cribl-Microsoft! Your contributions help organizations efficiently integrate Cribl Stream with Azure Log Analytics.
