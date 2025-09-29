---
slug: /sources-office-365-activity
description: Create and configure Azure App registration for use with O365 Cribl sources
title: Office 365 Activity App Registration
navTitle: Office 365 Activity App Registration
---

# Office 365 App Registration for Cribl Sources

Complete guide for creating and configuring Azure App Registration to integrate Office 365 services with Cribl Stream.

## 📋 Prerequisites

- Access to Azure Portal with permissions to create App Registrations
- Global Administrator or appropriate Entra ID role
- Exchange Administrator role (for Message Trace configuration)
- PowerShell with ExchangeOnlineManagement module (for Message Trace)

## 🚀 Initial App Registration Setup

### Step 1: Create App Registration

1. From the Azure Portal search for `EntraID` in the top search bar to select ![Entra ID](images/EntraID.png)
2. Select ![App Registration](images/AppRegistration.png) and then ![new registration](images/NewRegistration.png)
3. Name your app registration something specific to Cribl (e.g., `Cribl-Stream`) and leave default values in place, then click ![register](images/register.png)

### Step 2: Access API Permissions

4. From the app blade, expand ![manage](images/manage.png) and select ![api permissions](images/API_Permissions.png)
5. Click the ![Add a permission](images/add_permission.png) button and configure the required permissions based on the Office 365 source you plan to use

## 🔐 Permission Configuration by Source Type

### Office 365 Activity

**Required Permissions:**

![Office 365 Activity Permissions](images/Office365ActivityPermissions.png)

1. Find and select ![Office 365 Management API](images/Office365ManagementAPI.png)
2. Select ![application permissions](images/ApplicationPermission.png)
3. Select the above permissions and click ![add permission](images/add_permission.png)

### Office 365 Services

**Required Permissions:**

![Office 365 Service Permissions](images/Office365ServicePermissions.png)

1. Select ![Microsoft Graph API](images/GraphAPI.png)
2. Select ![application permissions](images/ApplicationPermission.png)
3. Find and select the permissions shown above in the Microsoft Graph section, then click ![add permission](images/add_permission.png)

### Office 365 Message Trace

**Required Permissions:**

![O365 Message Trace Permissions](images/Office365MessageTracePermissions.png)

> **Note:** This app permission follows a different assignment path.

1. From the API Permission blade click ![add permission](images/add_permission.png)
2. Click ![APIs my organization uses](images/apis_my_org_uses.png) and search for `Office 365 Exchange Online`
3. Select ![Office 365 Exchange Online API](images/Office365ExchangeOnlineAPI.png)
4. Select ![Application Permission](images/ApplicationPermission.png)
5. Search for and select the permission shown above
6. Click ![add permission](images/add_permission.png)

## ✅ Grant Admin Consent and Create Secret

### Grant Admin Consent

1. Before you leave the `API Permissions` blade, click ![grant admin consent](images/GrantAdminConsent.png) and then ![yes](images/yes.png)

### Configure App Secret

2. From the App registration manage blade select ![app secrets](images/appsecrets.png)
3. Click ![new secret](images/newSecret.png)
4. Add a description and expiration timeframe and click ![add](images/add.png), something like this ![cribl office secret](images/criblOfficeSecret.png)

> **⚠️ Important:** Take note of the secret value immediately. The secret is only exposed upon creation. This is what you capture for use in the Cribl UI.

## 🔧 Exchange Admin Portal Configuration

**Required for Office 365 Message Trace only**

### Create Role Group

1. Logon to https://admin.exchange.microsoft.com/
2. Expand ![EAC Roles](images/EAC_roles.png) and select ![EAC Admin Roles](images/EAC_AdminRoles.png)
3. Click ![EAC Add role group](images/EAC_AddRoleGroup.png)
4. Name your role group (e.g., `Cribl-O365MessageTrace`) and click ![EAC Next](images/next.png)
5. Search for and select ![EAC Message Tracking](images/EAC_MessageTracking.png) and ![EAC View-Only Recipients](images/EAC_ViewOnlyrecipients.png), then click ![EAC Next](images/next.png)
6. Click ![EAC Next](images/next.png) again and then ![EAC Add Group](images/EAC_AddGroup.png)

## 💻 PowerShell Configuration

**Required for Office 365 Message Trace only**

### Install and Connect

```powershell
Install-Module -Name ExchangeOnlineManagement -Force
Import-Module ExchangeOnlineManagement
Connect-ExchangeOnline
```

### Create Service Principal and Assign Role

```powershell
# Create service principal using the App Registration details
New-ServicePrincipal -DisplayName "<Name of the App>" -AppId <Application (client) ID> -ServiceId <Object ID>

# Add service principal to the role group
Add-RoleGroupMember -Identity "Cribl-O365MessageTrace" -Member <Application (Client) ID>
```

> **Note:** Ensure you use the Object ID of the Enterprise App Service Principal associated with your App Registration.

## 🎯 Best Practices

- **Unique Secrets**: Create a unique secret for each Cribl Office 365 source for better security and least privilege access
- **Secret Rotation**: Set appropriate expiration timeframes and establish a secret rotation schedule
- **Documentation**: Record the Application (client) ID and Tenant ID for Cribl configuration
- **Access Review**: Periodically review assigned permissions and remove unused ones

---

**Need help?** Refer to the [Cribl documentation](https://docs.cribl.io) for Office 365 source configuration details.