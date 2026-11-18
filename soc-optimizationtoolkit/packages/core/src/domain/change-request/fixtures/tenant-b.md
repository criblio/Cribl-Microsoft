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
5. Optionally, assign the Entra ID directory role listed below to this app's  
   service principal.  
6. Securely share the tenant id, application (client) id, and the client  
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
    Scope:          /subscriptions/`<subscription id>`/resourceGroups/`<resource group>`/providers/Microsoft.OperationalInsights/workspaces/`<workspace name>`  
    Needed for:     Create custom tables  
    Why:            Create custom Log Analytics tables in the workspace. Asked  
                    on the workspace itself, not its resource group, where the  
                    role would also reach every other resource there. A custom  
                    role with only  
                    Microsoft.OperationalInsights/workspaces/read,  
                    Microsoft.OperationalInsights/workspaces/tables/read,  
                    Microsoft.OperationalInsights/workspaces/tables/write on  
                    the workspace is narrower still.  
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
    Scope:          the Event Hub namespace that holds the rule (skip if a  
                    role above already covers it)  
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
- Monitoring Contributor  [feature]  
    Scope:          the Azure Monitor Private Link Scope, which may sit in  
                    another resource group or subscription (skip if a role  
                    above already covers it)  
    Needed for:     Associate a new DCE with an Azure Monitor Private Link  
                    Scope  
    Why:            When the workspace accepts data only over private link,  
                    onboarding associates each new DCE with the private link  
                    scope (PUT  
                    .../privateLinkScopes/{scope}/scopedResources/{name}), a  
                    write on the scope itself. The scope may sit in another  
                    resource group or subscription.  
    If not granted: The DCE still deploys, but a private-only workspace cannot  
                    be reached through it until someone associates it with the  
                    scope.  
- Monitoring Reader  [feature]  
    Scope:          the DCE, which a DCR may name in another resource group or  
                    subscription (skip if a role above already covers it)  
    Needed for:     Show the ingestion endpoint of a DCE-based DCR  
    Why:            The deployment preview reads the Data Collection Endpoint  
                    a DCR names (GET on its resource id) to show where Cribl  
                    sends data. A DCR may name a DCE in another resource group  
                    or subscription.  
    If not granted: The preview cannot show that DCR's endpoint. Deploying is  
                    unaffected.  
- Reader  [feature]  
    Scope:          the Event Hub namespace (skip if a role above already  
                    covers it)  
    Needed for:     Read an Event Hub namespace, its rules and consumer groups  
    Why:            Validate, Create Cribl source and the Defender export read  
                    the namespace, its shared access rules and its consumer  
                    groups. The namespace may sit in another resource group or  
                    subscription, which subscription Reader does not reach.  
    If not granted: Those reads show as could not be read for that namespace.  
                    Nothing is changed in Azure.  
- Reader  [feature]  
    Scope:          /providers/Microsoft.Management/managementGroups/`<management group id>`  
                    (the highest management group the customer will grant, not  
                    the Tenant Root Group)  
    Needed for:     Read policy and the management group tree  
    Why:            Validate's policy checks and the Logging Map read policy  
                    assignments, exemptions, definitions and remediations, and  
                    the management group tree, at your management group.  
                    Reader there covers all of them; Management Group Reader  
                    alone misses remediations and the tree. It reaches every  
                    subscription beneath the group. A custom role with only  
                    Microsoft.Authorization/policyAssignments/read,  
                    Microsoft.Authorization/policyDefinitions/read,  
                    Microsoft.Authorization/policyExemptions/read,  
                    Microsoft.Management/managementGroups/descendants/read,  
                    Microsoft.Management/managementGroups/read,  
                    Microsoft.PolicyInsights/remediations/read at the  
                    management group is narrower still.  
    If not granted: Validate's policy checks read as could not be read, and  
                    the Logging Map lists subscriptions without the management  
                    group tree.  
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

Entra ID directory roles (optional)  
-----------------------------------  
Granted by an Entra administrator in Roles and administrators - not admin  
consent and not Azure IAM. These are privileged roles: read each Why  
before granting. [unverified] means Microsoft documents no  
narrower role for the call and none was measured; refusing costs only the  
one check named.  

- Security Administrator  [feature, unverified]  
    Scope:          tenant-wide (an Entra ID directory role, not consent or  
                    IAM)  
    Needed for:     Check the Entra ID diagnostic settings  
    Why:            Security Administrator is a privileged Entra directory  
                    role: it can change security policy and Conditional Access  
                    across the whole tenant. It is asked for only so  
                    Validate's optional Entra ID diagnostic settings check can  
                    read GET /providers/microsoft.aadiam/diagnosticSettings,  
                    for which Microsoft documents no read-only role. We  
                    recommend refusing it unless that check is needed.  
    If not granted: Validate's Entra ID diagnostic settings check reads as  
                    could not be read. Nothing else is affected.  
    Where:          Entra ID > Roles and administrators > this role > Add  
                    assignments, for this app's service principal.  

Cribl side (stated, not requested)  
----------------------------------  
What the app holds in Cribl, so this request shows both halves.  
Cribl-side least privilege: App user, plus the Organization  
administrator's install-time approval of the app's policies.yml. That  
approval covers every worker group in scope. There is no Azure step for  
it, and nothing on the Cribl side to grant through this ticket.  

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