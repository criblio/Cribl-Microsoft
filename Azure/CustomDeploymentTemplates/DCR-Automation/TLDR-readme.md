# TLDR - Unified DCR Solution (DCE or Direct + Template-Only)

## What This Does
**Single script** that creates either **DCE-based** or **Direct** Azure Data Collection Rules based on configuration. **Plus template-only mode** for CI/CD pipelines! Switch between modes without changing scripts!

## 🎯 Key Benefits
- ✅ **One Script, Three Modes**: Handle DCE-based, Direct, and Template-Only
- ✅ **Template-Only Mode**: Generate ARM templates without deployment
- ✅ **Intelligent Naming**: Auto-abbreviation for Azure naming limits
- ✅ **Configuration Control**: Switch modes via `operation-parameters.json`
- ✅ **Cost Flexibility**: Choose cost-effective Direct or feature-rich DCE-based
- ✅ **CI/CD Ready**: Perfect for automated deployment pipelines

## ⚡ Quick Commands

```powershell
# 1. Basic deployment (uses operation-parameters.json settings)
.\Create-NativeTableDCRs.ps1

# 2. Template generation only (no deployment) - PERFECT FOR CI/CD
.\Create-NativeTableDCRs.ps1 -TemplateOnly

# 3. Force Direct DCRs (30-char limit, cost-effective)
.\Create-NativeTableDCRs.ps1 -CreateDCE:$false

# 4. Force DCE-based DCRs (64-char limit, advanced features)
.\Create-NativeTableDCRs.ps1 -CreateDCE

# 5. Single table deployment
.\Create-NativeTableDCRs.ps1 -SpecificDCR "SecurityEvent"
```

## 🎯 3 Modes Comparison

| Mode | Setting | Purpose | Name Limit | Cost |
|------|---------|---------|------------|------|
| **Template-Only** | `"templateOnly": true` | CI/CD, template review | N/A | None |
| **Direct DCRs** | `"createDCE": false` | Cost-effective ingestion | 30 chars (auto-abbreviated) | Lower |
| **DCE-based DCRs** | `"createDCE": true` | Advanced features | 64 chars | Higher |

## ⚙️ Quick Configuration

### operation-parameters.json (Main Control)
```json
{
  "scriptBehavior": {
    "templateOnly": false     // Set to true for template-only mode
  },
  "deployment": {
    "createDCE": false        // false=Direct DCRs, true=DCE-based DCRs
  }
}
```

### azure-parameters.json (Naming)
```json
{
  "resourceGroupName": "rg-jpederson-eastus",
  "workspaceName": "la-jpederson-00",
  "dcrPrefix": "dcr-jp-",              // Keep short for Direct DCRs (30-char limit)
  "location": "eastus"
}
```

## 📊 Intelligent Naming (Auto-Abbreviation)

Script automatically handles Azure naming limits:

| Original | Mode | Result | Length | Status |
|----------|------|---------|---------|--------|
| `dcr-jp-CommonSecurityLog-eastus` | Direct | `dcr-jp-CSL-eastus` | 18 chars | ✅ Auto-abbreviated |
| `dcr-jp-SecurityEvent-eastus` | Direct | No change | 29 chars | ✅ Fits |
| `dcr-jp-CommonSecurityLog-eastus` | DCE | No change | 35 chars | ✅ Fits (64-char limit) |

**Abbreviation Rules:**
- `CommonSecurityLog` → `CSL`
- `SecurityEvent` → `SecEvt`
- `WindowsEvent` → `WinEvt`
- `DeviceEvents` → `DevEvt`
- Generic tables → First 6 characters

## 📝 What Each Mode Does

### Template-Only Mode (`-TemplateOnly`)
✅ Connects to Azure  
✅ Retrieves real table schemas  
✅ Generates ARM templates with actual column definitions  
✅ **NEW**: Hardcodes stream names (Custom-{Table}, Microsoft-{Table})
✅ Embeds columns directly in template (no parameters needed)
✅ Validates templates  
✅ Saves to `generated-templates/` directory  
❌ Does NOT deploy resources  

**Perfect for:** CI/CD pipelines, template review, staged deployments
**Enhanced:** Templates are now fully standalone with hardcoded stream names

### Direct DCRs (`-CreateDCE:$false`)
✅ Creates DCR only  
✅ 30-character name limit (auto-abbreviated)  
✅ Lower cost  
✅ Simple architecture: Data → Log Analytics  

**Perfect for:** Basic data ingestion, cost optimization

### DCE-based DCRs (`-CreateDCE`)
✅ Creates DCR + DCE  
✅ 64-character name limit  
✅ Advanced features  
❌ Higher cost  
✅ Architecture: Data → DCE → Log Analytics  

**Perfect for:** Advanced scenarios requiring DCE features

## 📁 Output Files

```
generated-templates/
├── CommonSecurityLog-latest.json         # Use for deployments
├── CommonSecurityLog-20250906-143022.json # Timestamped backup
├── SecurityEvent-latest.json
└── SecurityEvent-20250906-143022.json
```

**🆕 Enhanced Templates Include:**
- ✅ Hardcoded stream names (no ARM variables)
- ✅ Embedded column definitions from Azure
- ✅ Default parameter values for easy deployment
- ✅ Fully standalone - just need workspace ID

## 🚀 Example Workflows

### Development (Template-Only)
```powershell
# 1. Generate templates for review
.\Create-NativeTableDCRs.ps1 -TemplateOnly

# 2. Review templates in generated-templates/
# 3. Deploy single table for testing
.\Create-NativeTableDCRs.ps1 -SpecificDCR "CommonSecurityLog"

# 4. Deploy all tables
.\Create-NativeTableDCRs.ps1
```

### CI/CD Pipeline
```yaml
# Stage 1: Generate Templates
- script: .\Create-NativeTableDCRs.ps1 -TemplateOnly

# Stage 2: Review Templates (manual gate)

# Stage 3: Deploy Templates
- task: AzureResourceManagerTemplateDeployment
  inputs:
    templateLocation: 'Linked artifact'
    csmFile: 'generated-templates/$(tableName)-latest.json'
```

### Production (Direct Deployment)
```powershell
# Set mode in operation-parameters.json
"createDCE": false  # or true for DCE-based

# Deploy
.\Create-NativeTableDCRs.ps1
```

## 🚨 Manual Deployment

If script recommends manual deployment:

1. **Azure Portal** → "Deploy a custom template"
2. **Copy content** from `*-latest.json` files  
3. **Fill parameters**: DCR name, location, workspace ID
4. **Deploy**

## 🔧 Quick Fixes

| Problem | Solution |
|---------|---------|
| DCR name too long | Script auto-abbreviates ✅ |
| Table not found | Check TableList.json spelling |
| Auth error | Run `Connect-AzAccount` |
| Want templates only | Use `-TemplateOnly` |
| Switch DCR mode | Change `createDCE` in operation-parameters.json |
| Need real schemas | Template-only mode gets real schemas from Azure ✅ |

## 🎉 Bottom Line

**Template-Only**: Generate templates with real Azure schemas → Review → Deploy manually/CI-CD  
**Direct DCRs**: Cost-effective, 30-char limit, auto-abbreviated names  
**DCE-based DCRs**: Advanced features, 64-char limit, higher cost  

**Perfect for teams that need:**
- 💰 Cost control (Direct DCRs)
- 🏗️ Advanced features (DCE-based DCRs)  
- 🚀 CI/CD integration (Template-only mode)
- 📋 Template review workflows

Choose your mode, run the script, get your DCRs! 🚀
