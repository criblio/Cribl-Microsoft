# 🚀 DCR Automation Quick Start

## Prerequisites
- PowerShell 5.1+ with Azure PowerShell modules
- Azure subscription with appropriate permissions
- Log Analytics Workspace already created

## 1️⃣ Configure Azure Settings

Edit `azure-parameters.json` with your Azure details:

```json
{
  "resourceGroupName": "your-rg-name",
  "workspaceName": "your-workspace-name",
  "location": "eastus",
  "dcrPrefix": "dcr-",
  "dcrSuffix": "",
  "dceResourceGroupName": "your-rg-name",
  "dcePrefix": "dce-",
  "dceSuffix": "",
  "tenantId": "your-tenant-id",
  "clientId": "your-app-client-id",
  "clientSecret": "your-app-secret"
}
```

**Note:** The `tenantId`, `clientId`, and `clientSecret` are for Cribl Stream destination creation.

## 2️⃣ Review and Update Table Lists

**Native Tables** (`NativeTableList.json`):
```json
[
    "CommonSecurityLog",
    "SecurityEvent",
    "Syslog",
    "WindowsEvent"
]
```

**Custom Tables** (`CustomTableList.json`):
```json
[
    "CloudFlare_CL",
    "MyCustomApp_CL"
]
```

## 3️⃣ Connect to Azure

```powershell
Connect-AzAccount
Set-AzContext -Subscription "Your-Subscription-Name"  # If multiple subscriptions
```

## 4️⃣ View Available Commands

```powershell
.\Run-DCRAutomation.ps1
```

This displays:
- Current configuration status
- Available deployment modes
- All command options

## 5️⃣ Common Commands

### Test First (Recommended)
```powershell
# Generate templates without deploying
.\Run-DCRAutomation.ps1 -Mode TemplateOnly -DCRMode Direct
```

### Deploy Direct DCRs (Simple & Cost-Effective)
```powershell
# Native tables only
.\Run-DCRAutomation.ps1 -Mode DirectNative

# Custom tables only
.\Run-DCRAutomation.ps1 -Mode DirectCustom

# Both native and custom
.\Run-DCRAutomation.ps1 -Mode DirectBoth
```

### Deploy DCE-based DCRs (Private End-Points)
```powershell
# Native tables with DCE
.\Run-DCRAutomation.ps1 -Mode DCENative

# Custom tables with DCE
.\Run-DCRAutomation.ps1 -Mode DCECustom

# Both with DCE
.\Run-DCRAutomation.ps1 -Mode DCEBoth
```

### Cribl Configuration Management
```powershell
# Collect config from existing DCRs
.\Run-DCRAutomation.ps1 -Mode CollectCribl

# Validate Cribl configuration
.\Run-DCRAutomation.ps1 -Mode ValidateCribl
```

## 6️⃣ Cribl Integration

After deployment, Cribl configuration is **automatically exported** to:
`cribl-dcr-configs\cribl-dcr-config.json`

To generate individual Cribl destination configs:
```powershell
.\Generate-CriblDestinations.ps1
```

## 📝 Key Notes

- **Direct DCRs**: 30-character name limit (auto-abbreviated)
- **DCE-based DCRs**: 64-character name limit
- **Custom tables**: Need schema files in `custom-table-schemas\` if not in Azure
- **Default behavior**: Automatically exports Cribl config after deployment

## ❓ Help

For detailed documentation, see:
- `README.md` - Full documentation
- `CRIBL_DESTINATIONS_README.md` - Cribl destination configuration

## 🔧 Quick Troubleshooting

| Issue | Solution |
|-------|----------|
| "Table not found" | Check table name spelling in list files |
| "DCR name too long" | Script auto-abbreviates, check output |
| "Authentication failed" | Run `Connect-AzAccount` |
| "Custom table missing" | Create schema in `custom-table-schemas\` |

---

**Start here:** `.\Run-DCRAutomation.ps1` to see all options and current configuration
