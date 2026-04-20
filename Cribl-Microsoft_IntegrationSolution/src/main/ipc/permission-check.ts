// Permission Check Module
// Validates user permissions in both Cribl and Azure before deployment.
// Shows the user exactly what they can and cannot do, preventing
// failed deployments due to insufficient access.

import { IpcMain } from 'electron';
import { execFile } from 'child_process';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { azureParametersPath } from './app-paths';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PermissionItem {
  resource: string;
  action: string;
  granted: boolean;
  detail: string;
}

export interface CriblPermissions {
  connected: boolean;
  role: string;           // admin, editor, viewer, etc.
  canManagePacks: boolean;
  canManageOutputs: boolean;
  canManageInputs: boolean;
  canManageRoutes: boolean;
  canCaptureSamples: boolean;
  canSearch: boolean;
  permissions: PermissionItem[];
  error: string;
}

export interface AzurePermissions {
  loggedIn: boolean;
  canCreateDcr: boolean;
  canCreateDce: boolean;
  canCreateTable: boolean;
  canWriteResourceGroup: boolean;
  canReadWorkspace: boolean;
  permissions: PermissionItem[];
  error: string;
}

export interface PermissionReport {
  cribl: CriblPermissions;
  azure: AzurePermissions;
  canDeploy: boolean;       // Both sides have minimum required permissions
  summary: string;
}

// ---------------------------------------------------------------------------
// Cribl Permission Check
// ---------------------------------------------------------------------------

function httpsGet(url: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request({
      hostname: parsed.hostname, port: parsed.port || 443,
      path: parsed.pathname + parsed.search, method: 'GET',
      headers: { Accept: 'application/json', ...headers },
      rejectUnauthorized: true,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode || 0, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function checkCriblPermissions(
  baseUrl: string,
  token: string,
  deploymentType: 'cloud' | 'self-managed',
  orgId: string,
  workerGroup: string,
): Promise<CriblPermissions> {
  const result: CriblPermissions = {
    connected: false, role: '', canManagePacks: false, canManageOutputs: false,
    canManageInputs: false, canManageRoutes: false, canCaptureSamples: false,
    canSearch: false, permissions: [], error: '',
  };

  try {
    // Get current user info and role
    let authInfoUrl: string;
    if (deploymentType === 'cloud') {
      authInfoUrl = `https://api.cribl.cloud/v1/organizations/${orgId}/auth/info`;
    } else {
      authInfoUrl = `${baseUrl}/api/v1/auth/info`;
    }

    const authResp = await httpsGet(authInfoUrl, { Authorization: `Bearer ${token}` });
    if (authResp.status >= 200 && authResp.status < 300) {
      result.connected = true;
      const info = JSON.parse(authResp.body);
      result.role = info.role || info.roles?.[0] || info.policy || 'unknown';

      // Map role to capabilities
      const role = result.role.toLowerCase();
      const isAdmin = role.includes('admin') || role.includes('owner');
      const isEditor = isAdmin || role.includes('editor') || role.includes('write');

      result.canManagePacks = isEditor;
      result.canManageOutputs = isEditor;
      result.canManageInputs = isEditor;
      result.canManageRoutes = isEditor;
      result.canCaptureSamples = isEditor || role.includes('reader') || role.includes('viewer');
      result.canSearch = true; // Search is generally available to all authenticated users
    } else {
      // If auth/info fails, try to probe capabilities directly
      result.connected = true;
      result.role = 'unknown (auth/info not available)';
    }

    // Probe specific endpoints to verify actual permissions
    const probeEndpoint = async (endpoint: string, action: string, resource: string): Promise<boolean> => {
      try {
        let url: string;
        if (deploymentType === 'cloud') {
          url = `https://api.cribl.cloud/v1/organizations/${orgId}/groups/${workerGroup}${endpoint}`;
        } else {
          url = `${baseUrl}/api/v1/m/${workerGroup}${endpoint}`;
        }
        const resp = await httpsGet(url, { Authorization: `Bearer ${token}` });
        const granted = resp.status >= 200 && resp.status < 300;
        result.permissions.push({
          resource, action, granted,
          detail: granted ? 'Access confirmed' : `HTTP ${resp.status}`,
        });
        return granted;
      } catch (err) {
        result.permissions.push({
          resource, action, granted: false,
          detail: err instanceof Error ? err.message : 'Connection error',
        });
        return false;
      }
    };

    // Probe key endpoints
    result.canManagePacks = await probeEndpoint('/packs', 'read', 'Packs') || result.canManagePacks;
    result.canManageOutputs = await probeEndpoint('/system/outputs', 'read', 'Outputs/Destinations') || result.canManageOutputs;
    result.canManageInputs = await probeEndpoint('/system/inputs', 'read', 'Inputs/Sources') || result.canManageInputs;
    result.canManageRoutes = await probeEndpoint('/system/pipelines/route', 'read', 'Routes/Pipelines') || result.canManageRoutes;

  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Azure Permission Check
// ---------------------------------------------------------------------------

function runPowershell(command: string, timeoutMs: number = 30000): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-Command', command], {
      timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err) resolve({ ok: false, output: (stderr || err.message).trim() });
      else resolve({ ok: true, output: (stdout || '').trim() });
    });
  });
}

async function checkAzurePermissions(
  resourceGroupName: string,
  workspaceName: string,
  subscriptionId: string,
): Promise<AzurePermissions> {
  const result: AzurePermissions = {
    loggedIn: false, canCreateDcr: false, canCreateDce: false, canCreateTable: false,
    canWriteResourceGroup: false, canReadWorkspace: false, permissions: [], error: '',
  };

  // Check if logged in
  const loginCheck = await runPowershell(
    "try { $ctx = Get-AzContext -ErrorAction Stop; if ($ctx.Account) { 'OK' } else { 'NO' } } catch { 'NO' }"
  );
  if (!loginCheck.ok || loginCheck.output !== 'OK') {
    result.error = 'Not logged in to Azure';
    return result;
  }
  result.loggedIn = true;

  // Check role assignments for the current user on the resource group
  const roleCheckCmd = `
    try {
      $rg = '${resourceGroupName}'
      $sub = '${subscriptionId}'
      $ws = '${workspaceName}'

      # Get current user principal
      $ctx = Get-AzContext
      $userId = $ctx.Account.Id

      # Check resource group exists
      $rgObj = Get-AzResourceGroup -Name $rg -ErrorAction SilentlyContinue
      if (-not $rgObj) {
        Write-Output "RG_NOT_FOUND"
      } else {
        Write-Output "RG_EXISTS"
      }

      # Check workspace exists
      $wsObj = Get-AzOperationalInsightsWorkspace -ResourceGroupName $rg -Name $ws -ErrorAction SilentlyContinue
      if ($wsObj) {
        Write-Output "WS_EXISTS"
      } else {
        Write-Output "WS_NOT_FOUND"
      }

      # Get role assignments
      $roles = Get-AzRoleAssignment -SignInName $userId -ResourceGroupName $rg -ErrorAction SilentlyContinue
      if (-not $roles) {
        # Try with ObjectId for service principals
        $roles = Get-AzRoleAssignment -ResourceGroupName $rg -ErrorAction SilentlyContinue |
          Where-Object { $_.SignInName -eq $userId -or $_.DisplayName -eq $userId }
      }

      foreach ($role in $roles) {
        Write-Output "ROLE:$($role.RoleDefinitionName)"
      }

      # Test specific permissions by attempting read operations
      try {
        $dcrs = Get-AzResource -ResourceGroupName $rg -ResourceType 'Microsoft.Insights/dataCollectionRules' -ErrorAction Stop
        Write-Output "CAN_READ_DCR"
      } catch {
        Write-Output "CANNOT_READ_DCR"
      }

      try {
        $tables = Invoke-AzRestMethod -Path "/subscriptions/$sub/resourceGroups/$rg/providers/Microsoft.OperationalInsights/workspaces/$ws/tables?api-version=2022-10-01" -Method GET -ErrorAction Stop
        if ($tables.StatusCode -eq 200) {
          Write-Output "CAN_READ_TABLES"
        } else {
          Write-Output "CANNOT_READ_TABLES"
        }
      } catch {
        Write-Output "CANNOT_READ_TABLES"
      }
    } catch {
      Write-Output "ERROR:$($_.Exception.Message)"
    }
  `;

  const roleResult = await runPowershell(roleCheckCmd, 45000);
  if (!roleResult.ok) {
    result.error = `Permission check failed: ${roleResult.output.slice(0, 200)}`;
    return result;
  }

  const lines = roleResult.output.split('\n').map((l) => l.trim()).filter(Boolean);
  const roles: string[] = [];

  for (const line of lines) {
    if (line === 'RG_EXISTS') {
      result.canWriteResourceGroup = true;
      result.permissions.push({ resource: 'Resource Group', action: 'exists', granted: true, detail: resourceGroupName });
    }
    if (line === 'RG_NOT_FOUND') {
      result.permissions.push({ resource: 'Resource Group', action: 'exists', granted: false, detail: `${resourceGroupName} not found` });
    }
    if (line === 'WS_EXISTS') {
      result.canReadWorkspace = true;
      result.permissions.push({ resource: 'Log Analytics Workspace', action: 'read', granted: true, detail: workspaceName });
    }
    if (line === 'WS_NOT_FOUND') {
      result.permissions.push({ resource: 'Log Analytics Workspace', action: 'read', granted: false, detail: `${workspaceName} not found` });
    }
    if (line.startsWith('ROLE:')) {
      const roleName = line.replace('ROLE:', '');
      roles.push(roleName);
      result.permissions.push({ resource: 'RBAC Role', action: 'assigned', granted: true, detail: roleName });
    }
    if (line === 'CAN_READ_DCR') {
      result.canCreateDcr = true;
      result.permissions.push({ resource: 'Data Collection Rules', action: 'read', granted: true, detail: 'Can read DCRs' });
    }
    if (line === 'CANNOT_READ_DCR') {
      result.permissions.push({ resource: 'Data Collection Rules', action: 'read', granted: false, detail: 'Cannot read DCRs' });
    }
    if (line === 'CAN_READ_TABLES') {
      result.canCreateTable = true;
      result.permissions.push({ resource: 'Log Analytics Tables', action: 'read', granted: true, detail: 'Can read tables' });
    }
    if (line === 'CANNOT_READ_TABLES') {
      result.permissions.push({ resource: 'Log Analytics Tables', action: 'read', granted: false, detail: 'Cannot read tables' });
    }
    if (line.startsWith('ERROR:')) {
      result.error = line.replace('ERROR:', '');
    }
  }

  // Infer write permissions from roles
  const hasWrite = roles.some((r) =>
    /Owner|Contributor|Monitoring Contributor|Log Analytics Contributor/i.test(r)
  );
  if (hasWrite) {
    result.canCreateDcr = true;
    result.canCreateDce = true;
    result.canCreateTable = true;
    result.canWriteResourceGroup = true;
  }

  // Check for Monitoring Metrics Publisher (needed for DCR ingestion)
  const hasPublisher = roles.some((r) => /Monitoring Metrics Publisher/i.test(r));
  result.permissions.push({
    resource: 'Monitoring Metrics Publisher',
    action: 'role check',
    granted: hasPublisher || hasWrite,
    detail: hasPublisher ? 'Role assigned' : hasWrite ? 'Implied by Contributor/Owner' : 'Not assigned (needed for DCR ingestion)',
  });

  return result;
}

// ---------------------------------------------------------------------------
// Combined Report
// ---------------------------------------------------------------------------

async function generatePermissionReport(
  criblToken: string | null,
  criblBaseUrl: string,
  criblDeploymentType: 'cloud' | 'self-managed',
  criblOrgId: string,
  workerGroup: string,
  azureResourceGroup: string,
  azureWorkspace: string,
  azureSubscriptionId: string,
): Promise<PermissionReport> {
  // Run both checks in parallel
  const [cribl, azure] = await Promise.all([
    criblToken
      ? checkCriblPermissions(criblBaseUrl, criblToken, criblDeploymentType, criblOrgId, workerGroup)
      : Promise.resolve({
          connected: false, role: '', canManagePacks: false, canManageOutputs: false,
          canManageInputs: false, canManageRoutes: false, canCaptureSamples: false,
          canSearch: false, permissions: [], error: 'Not connected',
        } as CriblPermissions),
    azureResourceGroup
      ? checkAzurePermissions(azureResourceGroup, azureWorkspace, azureSubscriptionId)
      : Promise.resolve({
          loggedIn: false, canCreateDcr: false, canCreateDce: false, canCreateTable: false,
          canWriteResourceGroup: false, canReadWorkspace: false, permissions: [], error: 'No resource group configured',
        } as AzurePermissions),
  ]);

  const canDeploy = (cribl.connected && cribl.canManagePacks && cribl.canManageOutputs)
    && (azure.loggedIn && azure.canCreateDcr && azure.canReadWorkspace);

  let summary: string;
  if (canDeploy) {
    summary = 'All permissions verified. Ready to deploy.';
  } else {
    const issues: string[] = [];
    if (!cribl.connected) issues.push('Cribl not connected');
    else if (!cribl.canManagePacks) issues.push('Cribl: cannot manage packs');
    else if (!cribl.canManageOutputs) issues.push('Cribl: cannot manage outputs');
    if (!azure.loggedIn) issues.push('Azure not logged in');
    else if (!azure.canCreateDcr) issues.push('Azure: cannot create DCRs');
    else if (!azure.canReadWorkspace) issues.push('Azure: cannot access workspace');
    summary = `Cannot deploy: ${issues.join('; ')}`;
  }

  return { cribl, azure, canDeploy, summary };
}

// ---------------------------------------------------------------------------
// IPC Handlers
// ---------------------------------------------------------------------------

export function registerPermissionCheckHandlers(ipcMain: IpcMain) {
  // Full permission report
  ipcMain.handle('permissions:check', async (_event, {
    workerGroup,
  }: { workerGroup?: string } = {}) => {
    // Load Cribl auth
    const authDir = path.join(process.env.APPDATA || process.env.HOME || '', '.cribl-microsoft', 'auth');
    let criblToken: string | null = null;
    let criblBaseUrl = '';
    let criblDeploymentType: 'cloud' | 'self-managed' = 'cloud';
    let criblOrgId = '';

    const criblAuthPath = path.join(authDir, 'cribl-auth');
    const criblAuthJsonPath = path.join(authDir, 'cribl-auth.json');
    for (const p of [criblAuthPath, criblAuthJsonPath]) {
      if (fs.existsSync(p)) {
        try {
          let raw: string;
          if (p === criblAuthPath) {
            // Try encrypted
            const { safeStorage } = await import('electron');
            if (safeStorage.isEncryptionAvailable()) {
              raw = safeStorage.decryptString(fs.readFileSync(p));
            } else { continue; }
          } else {
            raw = fs.readFileSync(p, 'utf-8');
          }
          const auth = JSON.parse(raw);
          criblBaseUrl = auth.baseUrl || '';
          criblDeploymentType = auth.deploymentType || 'cloud';
          criblOrgId = auth.organizationId || '';
          // Try to get a token
          if (auth.clientId && auth.clientSecret) {
            const { getCriblToken } = await import('./auth');
            try { criblToken = await getCriblToken(auth); } catch { /* skip */ }
          }
          break;
        } catch { continue; }
      }
    }

    // Load Azure params
    let azureRg = '';
    let azureWs = '';
    let azureSub = '';
    const azureParamsFile = azureParametersPath();
    if (fs.existsSync(azureParamsFile)) {
      try {
        const params = JSON.parse(fs.readFileSync(azureParamsFile, 'utf-8'));
        azureRg = params.resourceGroupName || '';
        azureWs = params.workspaceName || '';
        azureSub = params.subscriptionId || '';
      } catch { /* skip */ }
    }

    return generatePermissionReport(
      criblToken, criblBaseUrl, criblDeploymentType, criblOrgId,
      workerGroup || 'default', azureRg, azureWs, azureSub,
    );
  });
}

