REQUESTER'S COPY - DO NOT SEND THIS FILE. It holds the requests for 2 tenants, so it names every tenant's ids; send each tenant's administrators only that tenant's own file.

# App registration change requests for Cribl SOC Optimization Toolkit: 2 tenants

One request per connection follows (one for a tenant with no connection
yet), each complete on its own. Each belongs to the administrators of the
tenant it names: a registration, its consent and its roles in one tenant
grant nothing in another.

- aaaaaaaa-1111-4111-8111-111111111111
- bbbbbbbb-2222-4222-8222-222222222222 (no connection yet)

---

Change request: create Entra app registration for Cribl SOC Optimization Toolkit in tenant aaaaaaaa-1111-4111-8111-111111111111  

Requesting application: Cribl SOC Optimization Toolkit  
Service principal (client id): 11111111-1111-4111-8111-111111111111  
Tenant id: aaaaaaaa-1111-4111-8111-111111111111  

What is requested  
-----------------  
1. Create a single-tenant Entra app registration (daemon / confidential  
   client) in tenant aaaaaaaa-1111-4111-8111-111111111111.  
   Sign-in audience this directory only, no redirect URI, no interactive  
   user sign-in.  
2. Create a client secret on that app registration.  
3. Grant the Microsoft Graph API permissions listed below and ADMIN-CONSENT  
   them.  
4. Assign the Azure RBAC roles listed below to this app's service principal.  
5. Securely share the tenant id, application (client) id, and the client  
   secret with the requester (use a secrets manager or vault, not email or  
   chat) - see Hand back below.  

Steps 3 and 4 are usually different approvers. Every permission below says  
what needs it and what stops working without it, so each can be granted or  
refused on its own - a partial grant leaves a working app with fewer  
features, never a broken one.  

Everything here is for this one tenant. A registration, its consent and its  
role assignments in one tenant grant nothing in any other, so each tenant  
gets its own request.  

Justification  
-------------  
Cribl SOC Optimization Toolkit authenticates to Azure Resource Manager as a confidential client  
using the OAuth2 client_credentials grant to deploy Data Collection Rules  
and read Microsoft Sentinel content. It runs headless (no interactive user  
sign-in), so it needs its own app registration and client secret rather  
than delegated user permissions.  

Microsoft Graph API permissions (admin consent required)  
--------------------------------------------------------  
Add these as APPLICATION permissions - not delegated, because the app runs  
with no signed-in user - then grant admin consent in tenant  
aaaaaaaa-1111-4111-8111-111111111111.  
Until consent is granted the permission is listed on the registration but  
has no effect.  

- Application.Read.All  [feature]  
    Scope:          tenant-wide (consented on the app registration)  
    Needed for:     Pick the Cribl ingestion identity by name  
    Why:            Granting Cribl access to a Data Collection Rule requires  
                    the ingestion service principal's OBJECT id, which is NOT  
                    the application (client) id shown on its overview page -  
                    confusing the two is the single most common failure in  
                    this step. The app lists the tenant's service principals  
                    (GET /v1.0/servicePrincipals, id/appId/displayName only)  
                    so the operator picks the right identity from a named list  
                    instead of pasting an id. Directory.Read.All also  
                    satisfies this call but reads the entire directory;  
                    Application.Read.All is the least-privilege choice.  
    If not granted: The picker is replaced by a plain text box for the object  
                    id, which the operator must look up themselves. Nothing  
                    else is affected.  
    Where:          Entra ID > App registrations > this app > API permissions  
                    > Grant admin consent.  
- LicenseAssignment.Read.All  [feature]  
    Scope:          tenant-wide (consented on the app registration)  
    Needed for:     Show how much of the E5 data allowance is granted  
    Why:            Microsoft 365 E5-family licences grant free Sentinel  
                    ingestion of 5 MB per licensed seat per day, so the  
                    granted figure is a seat count times 5 MB. The app reads  
                    the tenant's license SKUs and their seat counts (GET  
                    /v1.0/subscribedSkus: SKU id, part number, purchased and  
                    assigned seats) - not who holds them.  
                    Organization.Read.All and Directory.Read.All also satisfy  
                    this call but read far more of the directory;  
                    LicenseAssignment.Read.All is the least-privilege choice.  
    If not granted: Used and over-allowance figures still come from the  
                    workspace; the granted figure shows as at least the  
                    largest benefit Microsoft applied on one day, and headroom  
                    is not shown.  
    Where:          Entra ID > App registrations > this app > API permissions  
                    > Grant admin consent.  

Azure RBAC roles (setup path: existing) - core  
----------------------------------------------  
Assign each role to the service principal for Cribl SOC Optimization Toolkit (client id:  
11111111-1111-4111-8111-111111111111) at the scope given.  

[core] roles are what this setup path needs to function at all.  

- Reader  [core]  
    Scope:          /subscriptions/33333333-3333-4333-8333-333333333333  
    Needed for:     Discovery and gap analysis  
    Why:            Discover subscriptions, resource groups, workspaces, and  
                    existing DCRs before deploying.  
    If not granted: The app cannot find your workspace or read the DCRs  
                    already deployed, so every screen that starts from your  
                    environment is empty and gap analysis has nothing to  
                    compare against.  
- Monitoring Contributor  [core]  
    Scope:          /subscriptions/33333333-3333-4333-8333-333333333333/resourceGroups/rg-sentinel  
    Needed for:     Deploy Data Collection Rules  
    Why:            Create and update Data Collection Rules in the workspace  
                    resource group.  
    If not granted: The app can still generate the DCR ARM template for  
                    someone else to deploy, but cannot deploy it itself - no  
                    data path is created.  
- Log Analytics Contributor  [core]  
    Scope:          /subscriptions/33333333-3333-4333-8333-333333333333/resourceGroups/rg-sentinel  
    Needed for:     Create custom tables  
    Why:            Create custom Log Analytics tables and configure the  
                    workspace for ingestion.  
    If not granted: Onboarding a source to a table that does not exist yet  
                    fails; existing native tables can still be targeted.  

Azure RBAC roles (setup path: existing) - feature  
-------------------------------------------------  
Assign these to the same service principal. [feature] roles each unlock  
one named capability and can be refused independently.  

- Microsoft Sentinel Contributor  [feature]  
    Scope:          /subscriptions/33333333-3333-4333-8333-333333333333/resourceGroups/rg-sentinel  
    Needed for:     Install Microsoft Sentinel content  
    Why:            Installing analytic rules and workbooks, and onboarding a  
                    workspace to Sentinel, WRITE Microsoft.SecurityInsights  
                    resources. Log Analytics Contributor grants read across  
                    the subscription but no Microsoft.SecurityInsights write,  
                    so without this role the install fails on the first rule.  
    If not granted: Content cannot be installed from the app. It can still be  
                    generated as an ARM template to hand to someone who can  
                    deploy it; DCR deployment, table creation, and gap  
                    analysis are unaffected.  
- RBAC Administrator  [feature]  
    Scope:          /subscriptions/33333333-3333-4333-8333-333333333333/resourceGroups/rg-sentinel  
    Needed for:     Grant Cribl access to each deployed DCR  
    Why:            Data only flows through a Data Collection Rule if the  
                    sending identity holds Monitoring Metrics Publisher ON  
                    THAT RULE, and creating a role assignment is itself a  
                    privileged action that Contributor does not include.  
                    Attach the condition below so this grant cannot be used to  
                    assign anything else.  
    If not granted: DCRs still deploy, but no data reaches them until someone  
                    with role-assignment rights grants Cribl's identity  
                    Monitoring Metrics Publisher on each one. The app  
                    generates a change request for exactly that grant.  
    Condition:      Constrain roles and principal types: only Monitoring  
                    Metrics Publisher, only to service principals.  
    Where:          Azure portal, not the CLI - the condition above cannot be  
                    set from the CLI.  
- Azure Event Hubs Data Owner  [feature]  
    Scope:          the Event Hub namespace that holds the rule  
    Needed for:     Read an Event Hub rule's connection string  
    Why:            Creating the Cribl Event Hub source with the listKeys  
                    credential, and deploying the Defender continuous export,  
                    read the connection string of a namespace shared access  
                    rule (POST .../authorizationRules/{rule}/listKeys). That  
                    is an /action, which Reader does not grant: Reader passes  
                    every Event Hub rule check in Validate while listKeys  
                    still returns 403. A custom role with only  
                    authorizationRules/listKeys/action and  
                    authorizationRules/read on the namespace is narrower  
                    still.  
    If not granted: Paste the connection string into the source instead, or  
                    use the Entra ID credential; the Defender export cannot be  
                    deployed from the app. Validate and discovery are  
                    unaffected.  
- Security Admin  [feature]  
    Scope:          /subscriptions/33333333-3333-4333-8333-333333333333/resourceGroups/rg-sentinel  
                    (the default; the role is needed on whichever resource  
                    group you deploy CriblDefenderExport into in the Defender  
                    section)  
    Needed for:     Deploy the Defender for Cloud continuous export  
    Why:            The export is a Microsoft.Security/automations resource  
                    (CriblDefenderExport) the app creates in the resource  
                    group chosen in the Defender section; creating it needs  
                    automations/write, which neither Reader nor the Monitoring  
                    and Log Analytics roles include.  
    If not granted: The export cannot be deployed from the app; the How-to  
                    gives the portal steps for someone who holds the role.  
                    Reading which Defender plans are on is unaffected.  

Hand back (tenant aaaaaaaa-1111-4111-8111-111111111111)  
-------------------------------------------------------  
Return these values to the requester through a secrets manager or vault -  
never email or chat:  

Tenant id:               aaaaaaaa-1111-4111-8111-111111111111  
Application (client) id: 11111111-1111-4111-8111-111111111111  
Client secret:           the secret VALUE from step 2 (not its secret id)  
Secret expiry:           the expiry date chosen in step 2  

The requester enters them into the connection for this tenant. The secret  
is stored encrypted and write-only, and is never displayed again.  

Specifics  
---------  
App registration name:   Cribl SOC Optimization Toolkit  
Sign-in audience:        single tenant (this directory only)  
Redirect URI:            none (daemon / confidential client)  
Credential:              client secret  
Tenant id:               aaaaaaaa-1111-4111-8111-111111111111  
Application (client) id: 11111111-1111-4111-8111-111111111111 (if already created)  
Setup path:              existing  
Subscription:            33333333-3333-4333-8333-333333333333  
Resource group:          rg-sentinel  

Why (authentication flow)  
-------------------------  
```mermaid
flowchart LR
browser["Cribl app (browser) - app: Cribl SOC Optimization Toolkit"]
proxy["Cribl proxy (server-side) - injects client secret from write-only KV"]
entra["Entra token endpoint - login.microsoftonline.com - tenant aaaaaaaa-1111-4111-8111-111111111111 - client 11111111-1111-4111-8111-111111111111"]
arm["Azure Resource Manager - management.azure.com"]
browser -->|HTTPS call, no secret in the browser| proxy
proxy -->|POST client_credentials, secret injected server-side| entra
entra -->|access token (bearer)| arm
```

---

Change request: create Entra app registration for Cribl SOC Optimization Toolkit in tenant bbbbbbbb-2222-4222-8222-222222222222  

Requesting application: Cribl SOC Optimization Toolkit  
Service principal (client id): `<client id>`  
Tenant id: bbbbbbbb-2222-4222-8222-222222222222  

What is requested  
-----------------  
1. Create a single-tenant Entra app registration (daemon / confidential  
   client) in tenant bbbbbbbb-2222-4222-8222-222222222222.  
   Sign-in audience this directory only, no redirect URI, no interactive  
   user sign-in.  
2. Create a client secret on that app registration.  
3. Grant the Microsoft Graph API permissions listed below and ADMIN-CONSENT  
   them.  
4. Assign the Azure RBAC roles listed below to this app's service principal.  
5. Securely share the tenant id, application (client) id, and the client  
   secret with the requester (use a secrets manager or vault, not email or  
   chat) - see Hand back below.  

Steps 3 and 4 are usually different approvers. Every permission below says  
what needs it and what stops working without it, so each can be granted or  
refused on its own - a partial grant leaves a working app with fewer  
features, never a broken one.  

Everything here is for this one tenant. A registration, its consent and its  
role assignments in one tenant grant nothing in any other, so each tenant  
gets its own request.  

Justification  
-------------  
Cribl SOC Optimization Toolkit authenticates to Azure Resource Manager as a confidential client  
using the OAuth2 client_credentials grant to deploy Data Collection Rules  
and read Microsoft Sentinel content. It runs headless (no interactive user  
sign-in), so it needs its own app registration and client secret rather  
than delegated user permissions.  

Microsoft Graph API permissions (admin consent required)  
--------------------------------------------------------  
Add these as APPLICATION permissions - not delegated, because the app runs  
with no signed-in user - then grant admin consent in tenant  
bbbbbbbb-2222-4222-8222-222222222222.  
Until consent is granted the permission is listed on the registration but  
has no effect.  

- Application.Read.All  [feature]  
    Scope:          tenant-wide (consented on the app registration)  
    Needed for:     Pick the Cribl ingestion identity by name  
    Why:            Granting Cribl access to a Data Collection Rule requires  
                    the ingestion service principal's OBJECT id, which is NOT  
                    the application (client) id shown on its overview page -  
                    confusing the two is the single most common failure in  
                    this step. The app lists the tenant's service principals  
                    (GET /v1.0/servicePrincipals, id/appId/displayName only)  
                    so the operator picks the right identity from a named list  
                    instead of pasting an id. Directory.Read.All also  
                    satisfies this call but reads the entire directory;  
                    Application.Read.All is the least-privilege choice.  
    If not granted: The picker is replaced by a plain text box for the object  
                    id, which the operator must look up themselves. Nothing  
                    else is affected.  
    Where:          Entra ID > App registrations > this app > API permissions  
                    > Grant admin consent.  
- LicenseAssignment.Read.All  [feature]  
    Scope:          tenant-wide (consented on the app registration)  
    Needed for:     Show how much of the E5 data allowance is granted  
    Why:            Microsoft 365 E5-family licences grant free Sentinel  
                    ingestion of 5 MB per licensed seat per day, so the  
                    granted figure is a seat count times 5 MB. The app reads  
                    the tenant's license SKUs and their seat counts (GET  
                    /v1.0/subscribedSkus: SKU id, part number, purchased and  
                    assigned seats) - not who holds them.  
                    Organization.Read.All and Directory.Read.All also satisfy  
                    this call but read far more of the directory;  
                    LicenseAssignment.Read.All is the least-privilege choice.  
    If not granted: Used and over-allowance figures still come from the  
                    workspace; the granted figure shows as at least the  
                    largest benefit Microsoft applied on one day, and headroom  
                    is not shown.  
    Where:          Entra ID > App registrations > this app > API permissions  
                    > Grant admin consent.  

Azure RBAC roles (setup path: existing) - core  
----------------------------------------------  
Assign each role to the service principal for Cribl SOC Optimization Toolkit (client id:  
`<client id>`) at the scope given.  

[core] roles are what this setup path needs to function at all.  

- Reader  [core]  
    Scope:          /subscriptions/`<subscription id>`  
    Needed for:     Discovery and gap analysis  
    Why:            Discover subscriptions, resource groups, workspaces, and  
                    existing DCRs before deploying.  
    If not granted: The app cannot find your workspace or read the DCRs  
                    already deployed, so every screen that starts from your  
                    environment is empty and gap analysis has nothing to  
                    compare against.  
- Monitoring Contributor  [core]  
    Scope:          /subscriptions/`<subscription id>`/resourceGroups/`<resource group>`  
    Needed for:     Deploy Data Collection Rules  
    Why:            Create and update Data Collection Rules in the workspace  
                    resource group.  
    If not granted: The app can still generate the DCR ARM template for  
                    someone else to deploy, but cannot deploy it itself - no  
                    data path is created.  
- Log Analytics Contributor  [core]  
    Scope:          /subscriptions/`<subscription id>`/resourceGroups/`<resource group>`  
    Needed for:     Create custom tables  
    Why:            Create custom Log Analytics tables and configure the  
                    workspace for ingestion.  
    If not granted: Onboarding a source to a table that does not exist yet  
                    fails; existing native tables can still be targeted.  

Azure RBAC roles (setup path: existing) - feature  
-------------------------------------------------  
Assign these to the same service principal. [feature] roles each unlock  
one named capability and can be refused independently.  

- Microsoft Sentinel Contributor  [feature]  
    Scope:          /subscriptions/`<subscription id>`/resourceGroups/`<resource group>`  
    Needed for:     Install Microsoft Sentinel content  
    Why:            Installing analytic rules and workbooks, and onboarding a  
                    workspace to Sentinel, WRITE Microsoft.SecurityInsights  
                    resources. Log Analytics Contributor grants read across  
                    the subscription but no Microsoft.SecurityInsights write,  
                    so without this role the install fails on the first rule.  
    If not granted: Content cannot be installed from the app. It can still be  
                    generated as an ARM template to hand to someone who can  
                    deploy it; DCR deployment, table creation, and gap  
                    analysis are unaffected.  
- RBAC Administrator  [feature]  
    Scope:          /subscriptions/`<subscription id>`/resourceGroups/`<resource group>`  
    Needed for:     Grant Cribl access to each deployed DCR  
    Why:            Data only flows through a Data Collection Rule if the  
                    sending identity holds Monitoring Metrics Publisher ON  
                    THAT RULE, and creating a role assignment is itself a  
                    privileged action that Contributor does not include.  
                    Attach the condition below so this grant cannot be used to  
                    assign anything else.  
    If not granted: DCRs still deploy, but no data reaches them until someone  
                    with role-assignment rights grants Cribl's identity  
                    Monitoring Metrics Publisher on each one. The app  
                    generates a change request for exactly that grant.  
    Condition:      Constrain roles and principal types: only Monitoring  
                    Metrics Publisher, only to service principals.  
    Where:          Azure portal, not the CLI - the condition above cannot be  
                    set from the CLI.  
- Azure Event Hubs Data Owner  [feature]  
    Scope:          the Event Hub namespace that holds the rule  
    Needed for:     Read an Event Hub rule's connection string  
    Why:            Creating the Cribl Event Hub source with the listKeys  
                    credential, and deploying the Defender continuous export,  
                    read the connection string of a namespace shared access  
                    rule (POST .../authorizationRules/{rule}/listKeys). That  
                    is an /action, which Reader does not grant: Reader passes  
                    every Event Hub rule check in Validate while listKeys  
                    still returns 403. A custom role with only  
                    authorizationRules/listKeys/action and  
                    authorizationRules/read on the namespace is narrower  
                    still.  
    If not granted: Paste the connection string into the source instead, or  
                    use the Entra ID credential; the Defender export cannot be  
                    deployed from the app. Validate and discovery are  
                    unaffected.  
- Security Admin  [feature]  
    Scope:          /subscriptions/`<subscription id>`/resourceGroups/`<resource group>`  
                    (the default; the role is needed on whichever resource  
                    group you deploy CriblDefenderExport into in the Defender  
                    section)  
    Needed for:     Deploy the Defender for Cloud continuous export  
    Why:            The export is a Microsoft.Security/automations resource  
                    (CriblDefenderExport) the app creates in the resource  
                    group chosen in the Defender section; creating it needs  
                    automations/write, which neither Reader nor the Monitoring  
                    and Log Analytics roles include.  
    If not granted: The export cannot be deployed from the app; the How-to  
                    gives the portal steps for someone who holds the role.  
                    Reading which Defender plans are on is unaffected.  

Hand back (tenant bbbbbbbb-2222-4222-8222-222222222222)  
-------------------------------------------------------  
Return these values to the requester through a secrets manager or vault -  
never email or chat:  

Tenant id:               bbbbbbbb-2222-4222-8222-222222222222  
Application (client) id: `<client id>`  
Client secret:           the secret VALUE from step 2 (not its secret id)  
Secret expiry:           the expiry date chosen in step 2  

The requester enters them into the connection for this tenant. The secret  
is stored encrypted and write-only, and is never displayed again.  

Specifics  
---------  
App registration name:   Cribl SOC Optimization Toolkit  
Sign-in audience:        single tenant (this directory only)  
Redirect URI:            none (daemon / confidential client)  
Credential:              client secret  
Tenant id:               bbbbbbbb-2222-4222-8222-222222222222  
Application (client) id: `<client id>` (if already created)  
Setup path:              existing  
Subscription:            `<subscription id>`  
Resource group:          `<resource group>`  

Why (authentication flow)  
-------------------------  
```mermaid
flowchart LR
browser["Cribl app (browser) - app: Cribl SOC Optimization Toolkit"]
proxy["Cribl proxy (server-side) - injects client secret from write-only KV"]
entra["Entra token endpoint - login.microsoftonline.com - tenant bbbbbbbb-2222-4222-8222-222222222222 - client &lt;client id&gt;"]
arm["Azure Resource Manager - management.azure.com"]
browser -->|HTTPS call, no secret in the browser| proxy
proxy -->|POST client_credentials, secret injected server-side| entra
entra -->|access token (bearer)| arm
```
