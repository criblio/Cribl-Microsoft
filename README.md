# Cribl-Microsoft

A comprehensive repository for Cribl integration artifacts with Microsoft Azure and related Microsoft ecosystem technologies. This repository provides templates, configurations, and resources to streamline data ingestion, processing, and analysis workflows between Cribl and Microsoft services.

## Overview

This repository serves as a centralized hub for organizations looking to integrate Cribl with Microsoft Azure services, including Azure Sentinel, Log Analytics workspaces, and various Azure data services. The artifacts contained here help accelerate deployment and configuration of Cribl in Microsoft environments.

## Repository Structure

### Azure Directory
Contains Microsoft Azure-specific integration artifacts:

- **CustomDeploymentTemplates/**: Ready-to-use deployment templates for various Azure services
  - **DataCollectionRules/**: Azure Data Collection Rules (DCR) templates
    - **SentinelCustomTables/**: Templates for custom tables in Azure Sentinel
    - **SentinelNativeTables/**: Templates for native Azure Sentinel tables
      - Support for both Data Collection Endpoint (DCE) and non-DCE configurations
      - Comprehensive coverage of Azure native tables including Security Events, Common Security Log, Azure Activity, and more

- **Diagrams/**: Architecture and integration diagrams (planned)

## Key Features

- **Azure Sentinel Integration**: Pre-configured templates for seamless data ingestion into Azure Sentinel
- **Data Collection Rules**: Comprehensive DCR templates for various Azure native and custom tables
- **Flexible Deployment Options**: Support for both DCE and non-DCE configurations
- **Multi-Service Support**: Templates covering a wide range of Azure services and log types
- **Security-Focused**: Templates optimized for security monitoring and compliance use cases

## Supported Azure Services

The repository includes templates and configurations for:

- Azure Sentinel (Microsoft Sentinel)
- Azure Log Analytics
- Azure Security Center
- Azure Active Directory
- Azure Activity Logs
- Azure Diagnostics
- Microsoft Defender services
- Cloud security posture management
- And many more Azure native services

## Getting Started

1. Clone this repository to your local environment
2. Navigate to the appropriate directory for your use case (e.g., `Azure/CustomDeploymentTemplates/`)
3. Select the appropriate template based on your deployment requirements
4. Customize the template parameters as needed for your environment
5. Deploy using Azure CLI, PowerShell, or Azure Portal

## Prerequisites

- Active Azure subscription
- Appropriate permissions for Azure resource deployment
- Cribl Stream or Cribl Edge instance
- Understanding of Azure Data Collection Rules (for DCR templates)

## Contributing

We welcome contributions from the community! Please see our [Contributors Guide](CONTRIBUTORS.md) for information on how to contribute to this project.

## Support

For issues related to these templates and configurations:
- Check existing GitHub issues
- Create a new issue with detailed information about your problem
- Include relevant Azure service information and error messages

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Disclaimer

The templates and configurations in this repository are provided as-is and should be thoroughly tested in non-production environments before deployment to production systems.
