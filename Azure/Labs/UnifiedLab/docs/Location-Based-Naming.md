# Location-Based Naming Automation

## Overview

The Unified Azure Lab now **automatically generates location-based suffixes** for resource names based on the `location` field in `azure-parameters.json`. This eliminates the need to manually update naming suffixes when deploying to different Azure regions.

## How It Works

### 1. Configuration Simplification

Instead of manually setting location suffixes:

**OLD WAY (Manual)**:
```json
{
 "location": "westus2",
 "naming": {
 "vnet": {
 "prefix": "vnet-",
 "suffix": "-westus2" // Must manually update when changing regions
 },
 "logAnalyticsWorkspace": {
 "prefix": "law-",
 "suffix": "-westus2" // Easy to forget!
 }
 }
}
```

**NEW WAY (Automatic)**:
```json
{
 "location": "westus2",
 "naming": {
 "vnet": {
 "prefix": "vnet-",
 "suffix": "",
 "_suffixComment": "Auto-set to '-{location}' (e.g., -westus2)"
 },
 "logAnalyticsWorkspace": {
 "prefix": "law-",
 "suffix": "",
 "_suffixComment": "Auto-set to '-{location}'"
 }
 }
}
```

Just change the `location` field, and all naming suffixes update automatically!

### 2. Runtime Processing

When you run `Run-AzureUnifiedLab.ps1`, the script:

1. Loads `azure-parameters.json`
2. Calls `Update-NamingSuffixes` function
3. Automatically sets location-based suffixes
4. Displays confirmation: ` Naming suffixes updated for location: westus2`

### 3. Intelligent Updates

The `Update-NamingSuffixes` function:
- **Updates empty suffixes** with location
- **Updates location-looking suffixes** (e.g., `-eastus`, `westus2`) with current location
- **Preserves custom suffixes** (e.g., `cribl`, `prod`, `dev`)

## Resource Naming Rules

### Resources with Location Suffix (with hyphen)

These resources automatically get `-{location}` appended:

| Resource Type | Prefix | Example Name (eastus) |
|---------------|--------|----------------------|
| Virtual Network | `vnet-` | `vnet-cribllab-eastus` |
| Subnet | `snet-` | `snet-cribllab-eastus` |
| Network Security Group | `nsg-` | `nsg-cribllab-eastus` |
| VPN Gateway | `vpngw-` | `vpngw-cribllab-eastus` |
| Bastion | `bas-` | `bas-cribllab-eastus` |
| Public IP | `pip-` | `pip-cribllab-eastus` |
| Log Analytics Workspace | `law-` | `law-cribllab-eastus` |
| Network Watcher | `nw-` | `nw-cribllab-eastus` |
| Event Hub Namespace | `evhns-` | `evhns-cribllab-eastus` |

### Resources with Location Suffix (no hyphen)

**Azure Data Explorer (ADX) Cluster**:
- Prefix: `adx`
- Suffix: `{location}` (no hyphen)
- Example: `adxcriblabeastus`
- Reason: ADX cluster names only allow alphanumeric characters

### Resources with Custom Suffix

**Storage Account**:
- Prefix: `sa`
- Suffix: `cribl` (or your custom value)
- Example: `sacribleabcribl`
- Reason: Storage account naming is typically identifier-based, not location-based
- Note: No hyphens allowed (Azure restriction)

### Resources with No Suffix

These resources don't get location suffixes:
- **Event Hub**: Individual hubs within namespace (e.g., `evh-logs-hub`)
- **ADX Database**: Databases within cluster (e.g., `db-CriblLogs`)
- **Diagnostic Settings**: Settings are resource-specific (e.g., `diag-storage`)

## Deployment Examples

### Example 1: Deploy to East US

```json
{
 "location": "eastus",
 "baseObjectName": "cribllab"
}
```

**Generated Resource Names**:
- VNet: `vnet-cribllab-eastus`
- VPN Gateway: `vpngw-cribllab-eastus`
- Log Analytics: `law-cribllab-eastus`
- Event Hub Namespace: `evhns-cribllab-eastus`
- ADX Cluster: `adxcriblabeastus`
- Storage Account: `sacribleabcribl`

### Example 2: Deploy to West Europe

```json
{
 "location": "westeurope",
 "baseObjectName": "cribllab"
}
```

**Generated Resource Names**:
- VNet: `vnet-cribllab-westeurope`
- VPN Gateway: `vpngw-cribllab-westeurope`
- Log Analytics: `law-cribllab-westeurope`
- Event Hub Namespace: `evhns-cribllab-westeurope`
- ADX Cluster: `adxcriblabwesteurope`
- Storage Account: `sacribleabcribl` (same - not location-based)

### Example 3: Deploy to UK South

```json
{
 "location": "uksouth",
 "baseObjectName": "cribllab"
}
```

**Generated Resource Names**:
- VNet: `vnet-cribllab-uksouth`
- VPN Gateway: `vpngw-cribllab-uksouth`
- Log Analytics: `law-cribllab-uksouth`
- Event Hub Namespace: `evhns-cribllab-uksouth`
- ADX Cluster: `adxcriblabuksouth`
- Storage Account: `sacribleabcribl` (same)

## Custom Suffix Override

If you want to use a **custom suffix** instead of location, just set it in the config:

```json
{
 "location": "eastus",
 "naming": {
 "vnet": {
 "prefix": "vnet-",
 "suffix": "-prod" // Custom suffix - won't be overwritten
 }
 }
}
```

Result: `vnet-cribllab-prod` (uses `-prod` instead of `-eastus`)

The script only updates suffixes that are:
- Empty (`""`)
- Look like Azure regions (e.g., `eastus`, `-westus2`)

It **preserves** custom suffixes like:
- `-prod`
- `-dev`
- `-test`
- `-staging`
- `cribl`
- Any other non-location identifier

## Supported Azure Regions

The auto-detection recognizes these Azure regions:

### United States
- `eastus`, `eastus2`
- `westus`, `westus2`, `westus3`
- `centralus`, `northcentralus`, `southcentralus`

### Europe
- `northeurope`, `westeurope`
- `uksouth`, `ukwest`
- `francecentral`
- `germanywestcentral`
- `norwayeast`
- `switzerlandnorth`

### Asia Pacific
- `southeastasia`, `eastasia`
- `australiaeast`, `australiasoutheast`
- `japaneast`, `japanwest`
- `koreacentral`
- `centralindia`

### Other Regions
- `uaenorth`
- `brazilsouth`
- `southafricanorth`

For the complete list of Azure regions, see: [Azure Regions](https://azure.microsoft.com/en-us/explore/global-infrastructure/geographies/)

## Migration from Manual Suffixes

If you have an existing `azure-parameters.json` with hardcoded location suffixes:

### Option 1: Clean Slate (Recommended)
1. Set all location-based suffixes to empty string `""`
2. Run the script - suffixes will auto-populate

### Option 2: Keep Existing (No Changes)
1. Keep your existing suffixes
2. The script will update them only if they look like locations
3. Custom suffixes are preserved

### Option 3: Mix and Match
1. Set some suffixes to `""` (auto-update)
2. Keep others as custom values (preserve)
3. Best of both worlds!

## Troubleshooting

### Problem: Suffix not updating

**Symptom**: Location changed but suffix still shows old region

**Cause**: You may have a custom suffix that doesn't match location pattern

**Solution**:
```json
{
 "naming": {
 "vnet": {
 "prefix": "vnet-",
 "suffix": "" // Set to empty to enable auto-update
 }
 }
}
```

### Problem: Wrong suffix format

**Symptom**: ADX cluster name has hyphen (e.g., `adxcribllab-eastus`)

**Cause**: Manual suffix override

**Solution**: ADX requires no hyphens. Set suffix to `""` for auto-update:
```json
{
 "naming": {
 "adxCluster": {
 "prefix": "adx",
 "suffix": "" // Will become "eastus" (no hyphen)
 }
 }
}
```

### Problem: Storage account suffix includes location

**Symptom**: Storage account name too long or includes location

**Cause**: Storage accounts typically use custom identifiers, not locations

**Solution**: Keep storage account suffix as custom identifier:
```json
{
 "naming": {
 "storageAccount": {
 "prefix": "sa",
 "suffix": "cribl" // Custom identifier, not location
 }
 }
}
```

## Implementation Details

### Code Location

**Naming-Engine.ps1**: [Core/Naming-Engine.ps1](../Core/Naming-Engine.ps1)

Key functions:
- `Get-LocationSuffix`: Converts location to `-{location}` format
- `Update-NamingSuffixes`: Updates all naming suffixes based on location

**Run-AzureUnifiedLab.ps1**: [Run-AzureUnifiedLab.ps1](../Run-AzureUnifiedLab.ps1)

Location-based naming is applied immediately after loading configuration:
```powershell
# Load configuration
$azureParams = Get-Content $azureParamsPath -Raw | ConvertFrom-Json

# Apply location-based suffixes
$azureParams = Update-NamingSuffixes -AzureParams $azureParams

# Continue with deployment...
```

### Logic Flow

```
1. Load azure-parameters.json
 ↓
2. Extract location field (e.g., "westus2")
 ↓
3. For each resource type:
 Check if suffix is empty OR looks like location
 YES: Update suffix to current location
 NO: Preserve existing custom suffix
 ↓
4. Special handling:
 ADX: Location without hyphen (alphanumeric only)
 Storage: Keep custom suffix (not location-based)
 Event Hub/DB: No suffix (child resources)
 ↓
5. Continue with deployment using updated naming
```

## Benefits

### 1. **Easier Multi-Region Deployments**
Change one field (`location`) and all resource names update automatically.

### 2. **Fewer Configuration Errors**
No more forgetting to update naming suffixes when changing regions.

### 3. **Consistent Naming**
All resources in a region automatically share the same location suffix.

### 4. **Flexible Customization**
Still supports custom suffixes when needed (e.g., `-prod`, `-dev`).

### 5. **Backward Compatible**
Existing configurations with hardcoded suffixes continue to work.

## Best Practices

1. **Use Empty Suffixes for Location-Based Resources**
 - Set suffix to `""` for VNet, NSG, Log Analytics, etc.
 - Let the script auto-populate based on location

2. **Use Custom Suffixes for Environment Identifiers**
 - Use `-prod`, `-dev`, `-test` for environment differentiation
 - These are preserved and not overwritten

3. **Document Custom Suffixes**
 - Add `_suffixComment` fields to explain custom choices
 - Helps team understand naming decisions

4. **Test in New Region Before Production**
 - Deploy to test region first
 - Verify resource names are correct
 - Then deploy to production region

5. **Storage Account Naming Strategy**
 - Keep storage suffix as custom identifier (e.g., `cribl`)
 - Storage names must be globally unique anyway
 - Location suffix doesn't help with uniqueness

## Related Documentation

- [Azure Resource Naming Conventions](https://learn.microsoft.com/en-us/azure/cloud-adoption-framework/ready/azure-best-practices/resource-naming)
- [Azure Resource Naming Restrictions](https://learn.microsoft.com/en-us/azure/azure-resource-manager/management/resource-name-rules)
- [Naming-Engine.ps1 Source Code](../Core/Naming-Engine.ps1)

## Changelog

### Version 1.0 (2025-10-25)
- Initial implementation of location-based naming automation
- Auto-detection of 20+ Azure regions
- Intelligent suffix update logic (empty vs. location vs. custom)
- Special handling for ADX (no hyphens) and Storage (custom identifiers)
- Comprehensive documentation and examples
