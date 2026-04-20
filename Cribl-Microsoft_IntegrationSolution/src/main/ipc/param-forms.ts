// Parameter Form Definitions
// Describes each configuration file's fields so the renderer can build
// an interactive form instead of requiring users to edit JSON by hand.
//
// Each form definition maps to a JSON config file in the repo.

import { IpcMain } from 'electron';
import fs from 'fs';
import path from 'path';
import { configDir as appConfigDir } from './app-paths';

export interface ParamField {
  key: string;           // Dot-notation path in JSON (e.g., "deployment.createDCE")
  label: string;
  type: 'text' | 'password' | 'number' | 'boolean' | 'select';
  description: string;
  group: string;
  required: boolean;
  placeholder?: string;
  default?: string | number | boolean;
  options?: Array<{ value: string; label: string }>;
  sensitive?: boolean;   // If true, mask in UI
}

export interface ParamFormDefinition {
  id: string;
  name: string;
  description: string;
  configPath: string;    // Filename in app data config dir
  fields: ParamField[];
}

// ---------------------------------------------------------------------------
// Azure Parameters Form
// ---------------------------------------------------------------------------

const azureParametersForm: ParamFormDefinition = {
  id: 'azure-parameters',
  name: 'Azure Settings',
  description: 'Azure subscription, resource group, workspace, and authentication configuration for DCR deployment.',
  configPath: 'azure-parameters.json',
  fields: [
    { key: 'subscriptionId', label: 'Subscription ID', type: 'text', description: 'Azure subscription ID for resource deployment.', group: 'Azure Resources', required: true, placeholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx' },
    { key: 'resourceGroupName', label: 'Resource Group', type: 'text', description: 'Azure resource group where DCRs, DCEs, and custom tables are created.', group: 'Azure Resources', required: true, placeholder: 'rg-myproject-sentinel' },
    { key: 'workspaceName', label: 'Log Analytics Workspace', type: 'text', description: 'Name of the Log Analytics workspace for Sentinel.', group: 'Azure Resources', required: true, placeholder: 'law-myworkspace-eastus' },
    { key: 'location', label: 'Azure Region', type: 'select', description: 'Azure region for resource deployment.', group: 'Azure Resources', required: true, default: 'eastus', options: [
      { value: 'eastus', label: 'East US' }, { value: 'eastus2', label: 'East US 2' },
      { value: 'westus', label: 'West US' }, { value: 'westus2', label: 'West US 2' },
      { value: 'westus3', label: 'West US 3' }, { value: 'centralus', label: 'Central US' },
      { value: 'northcentralus', label: 'North Central US' }, { value: 'southcentralus', label: 'South Central US' },
      { value: 'westeurope', label: 'West Europe' }, { value: 'northeurope', label: 'North Europe' },
      { value: 'uksouth', label: 'UK South' }, { value: 'ukwest', label: 'UK West' },
      { value: 'australiaeast', label: 'Australia East' }, { value: 'australiasoutheast', label: 'Australia Southeast' },
      { value: 'japaneast', label: 'Japan East' }, { value: 'southeastasia', label: 'Southeast Asia' },
      { value: 'canadacentral', label: 'Canada Central' }, { value: 'brazilsouth', label: 'Brazil South' },
    ]},
    { key: 'tenantId', label: 'Tenant ID', type: 'text', description: 'Azure AD / Entra ID tenant ID for OAuth authentication.', group: 'Authentication', required: true, placeholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx' },
    { key: 'clientId', label: 'Client ID (App ID)', type: 'text', description: 'Azure AD application (client) ID used by Cribl Stream for DCR ingestion.', group: 'Authentication', required: true, placeholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx' },
    { key: 'dcrPrefix', label: 'DCR Name Prefix', type: 'text', description: 'Prefix for DCR names (e.g., "dcr-" produces "dcr-TableName-region").', group: 'Naming', required: false, default: 'dcr-' },
    { key: 'dcrSuffix', label: 'DCR Name Suffix', type: 'text', description: 'Suffix appended to DCR names.', group: 'Naming', required: false, default: '' },
    { key: 'dcePrefix', label: 'DCE Name Prefix', type: 'text', description: 'Prefix for Data Collection Endpoint names (only used when DCE mode is enabled).', group: 'Naming', required: false, default: 'dce-' },
    { key: 'dceSuffix', label: 'DCE Name Suffix', type: 'text', description: 'Suffix appended to DCE names.', group: 'Naming', required: false, default: '' },
    { key: 'ownerTag', label: 'Owner Tag', type: 'text', description: 'Tag applied to all created resources for tracking ownership and cost allocation.', group: 'Naming', required: false, placeholder: 'user@company.com' },
  ],
};

// ---------------------------------------------------------------------------
// Operation Parameters Form
// ---------------------------------------------------------------------------

const operationParametersForm: ParamFormDefinition = {
  id: 'operation-parameters',
  name: 'Operation Settings',
  description: 'Controls how DCR automation runs: deployment mode, template management, custom table handling, and Private Link.',
  configPath: 'operation-parameters.json',
  fields: [
    // Deployment
    { key: 'deployment.createDCE', label: 'Create DCE (Data Collection Endpoint)', type: 'boolean', description: 'When enabled, creates DCE-based DCRs (64-char name limit). When disabled, creates Direct DCRs (30-char limit, requires Cribl 4.14+).', group: 'Deployment', required: false, default: false },
    { key: 'deployment.skipExistingDCRs', label: 'Skip Existing DCRs', type: 'boolean', description: 'Skip DCR creation if a DCR with the same name already exists.', group: 'Deployment', required: false, default: true },
    { key: 'deployment.skipExistingDCEs', label: 'Skip Existing DCEs', type: 'boolean', description: 'Skip DCE creation if a DCE already exists (only applies when DCE mode is enabled).', group: 'Deployment', required: false, default: true },
    { key: 'deployment.deploymentTimeout', label: 'Deployment Timeout (sec)', type: 'number', description: 'Maximum time in seconds to wait for each ARM template deployment.', group: 'Deployment', required: false, default: 600 },
    // Script Behavior
    { key: 'scriptBehavior.templateOnly', label: 'Template Only (No Deploy)', type: 'boolean', description: 'Generate ARM templates without deploying them. Templates are saved for manual deployment.', group: 'Script Behavior', required: false, default: false },
    { key: 'scriptBehavior.verboseOutput', label: 'Verbose Output', type: 'boolean', description: 'Show detailed progress during script execution.', group: 'Script Behavior', required: false, default: true },
    { key: 'scriptBehavior.validateTablesOnly', label: 'Validate Tables Only', type: 'boolean', description: 'Only validate table schemas without generating templates or deploying.', group: 'Script Behavior', required: false, default: false },
    { key: 'scriptBehavior.skipKnownIssues', label: 'Skip Known Issues', type: 'boolean', description: 'Skip tables with known schema issues instead of failing.', group: 'Script Behavior', required: false, default: false },
    // Template Management
    { key: 'templateManagement.cleanupOldTemplates', label: 'Cleanup Old Templates', type: 'boolean', description: 'Remove old timestamped templates (preserves *-latest.json files).', group: 'Template Management', required: false, default: true },
    { key: 'templateManagement.keepTemplateVersions', label: 'Keep Template Versions', type: 'number', description: 'Number of timestamped backup templates to keep per table.', group: 'Template Management', required: false, default: 1 },
    // Custom Tables
    { key: 'customTableSettings.enabled', label: 'Enable Custom Tables', type: 'boolean', description: 'Process custom tables (tables with _CL suffix). Requires schema files in the schemas directory.', group: 'Custom Tables', required: false, default: false },
    { key: 'customTableSettings.autoCreateTables', label: 'Auto-Create Tables', type: 'boolean', description: 'Automatically create custom tables in Log Analytics if they do not exist and schema files are found.', group: 'Custom Tables', required: false, default: true },
    { key: 'customTableSettings.defaultRetentionDays', label: 'Default Retention (days)', type: 'number', description: 'Default interactive retention period for new custom tables.', group: 'Custom Tables', required: false, default: 30 },
    { key: 'customTableSettings.defaultTotalRetentionDays', label: 'Total Retention (days)', type: 'number', description: 'Default total retention including archive for new custom tables.', group: 'Custom Tables', required: false, default: 90 },
    { key: 'customTableSettings.autoMigrateExistingTables', label: 'Auto-Migrate Existing Tables', type: 'boolean', description: 'Automatically migrate existing custom tables from classic to DCR-based ingestion.', group: 'Custom Tables', required: false, default: true },
    // Private Link
    { key: 'privateLink.enabled', label: 'Enable Private Link', type: 'boolean', description: 'Enable Azure Private Link configuration for Data Collection Endpoints.', group: 'Private Link', required: false, default: false },
    { key: 'privateLink.dcePublicNetworkAccess', label: 'DCE Public Network Access', type: 'select', description: 'Controls public network access for DCEs.', group: 'Private Link', required: false, default: 'Enabled', options: [
      { value: 'Enabled', label: 'Enabled (allow public access)' },
      { value: 'Disabled', label: 'Disabled (Private Link only)' },
    ]},
    { key: 'privateLink.amplsResourceId', label: 'AMPLS Resource ID', type: 'text', description: 'Full Azure resource ID of the Azure Monitor Private Link Scope. Required when Private Link is enabled.', group: 'Private Link', required: false, placeholder: '/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.Insights/privateLinkScopes/{name}' },
  ],
};

// ---------------------------------------------------------------------------
// Cribl Parameters Form (if exists)
// ---------------------------------------------------------------------------

const criblParametersForm: ParamFormDefinition = {
  id: 'cribl-parameters',
  name: 'Cribl Settings',
  description: 'Cribl Stream connection settings for destination configuration export.',
  configPath: 'cribl-parameters.json',
  fields: [
    { key: 'criblUrl', label: 'Cribl Stream URL', type: 'text', description: 'Base URL of your Cribl Stream leader node.', group: 'Connection', required: false, placeholder: 'https://cribl.company.com:9000' },
    { key: 'criblAuthToken', label: 'Cribl Auth Token', type: 'password', description: 'API auth token for Cribl Stream.', group: 'Connection', required: false, sensitive: true },
    { key: 'workerGroup', label: 'Worker Group', type: 'text', description: 'Cribl Stream worker group to deploy destinations to.', group: 'Connection', required: false, default: 'default', placeholder: 'default' },
    { key: 'destinationPrefix', label: 'Destination ID Prefix', type: 'text', description: 'Prefix for generated Cribl destination IDs.', group: 'Naming', required: false, default: 'MS-Sentinel-' },
    { key: 'destinationSuffix', label: 'Destination ID Suffix', type: 'text', description: 'Suffix for generated Cribl destination IDs.', group: 'Naming', required: false, default: '-dest' },
  ],
};

// ---------------------------------------------------------------------------
// Exported Registry
// ---------------------------------------------------------------------------

export const PARAM_FORMS: ParamFormDefinition[] = [
  azureParametersForm,
  operationParametersForm,
  criblParametersForm,
];

// ---------------------------------------------------------------------------
// Helpers for reading/writing nested JSON keys
// ---------------------------------------------------------------------------

// Get a value from a nested object by dot-notation key
export function getNestedValue(obj: Record<string, unknown>, key: string): unknown {
  const parts = key.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

// Set a value in a nested object by dot-notation key
export function setNestedValue(obj: Record<string, unknown>, key: string, value: unknown): void {
  const parts = key.split('.');
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!(parts[i] in current) || current[parts[i]] === null || typeof current[parts[i]] !== 'object') {
      current[parts[i]] = {};
    }
    current = current[parts[i]] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
}

// ---------------------------------------------------------------------------
// IPC Handlers
// ---------------------------------------------------------------------------

function getConfigPath(configFile: string): string {
  return path.join(appConfigDir(), configFile);
}

export function registerParamFormHandlers(ipcMain: IpcMain) {
  // List all available parameter forms
  ipcMain.handle('params:list', async () => {
    return PARAM_FORMS.map((form) => ({
      ...form,
      exists: fs.existsSync(getConfigPath(form.configPath)),
    }));
  });

  // Get a form definition with current values populated
  ipcMain.handle('params:get', async (_event, { formId }: { formId: string }) => {
    const form = PARAM_FORMS.find((f) => f.id === formId);
    if (!form) throw new Error(`Form not found: ${formId}`);

    const fullPath = getConfigPath(form.configPath);
    let data: Record<string, unknown> = {};

    if (fs.existsSync(fullPath)) {
      try {
        const raw = fs.readFileSync(fullPath, 'utf-8');
        // Strip _comments before parsing (or keep them for round-trip)
        data = JSON.parse(raw);
      } catch { /* use empty */ }
    }

    // Build field values from current config
    const values: Record<string, unknown> = {};
    for (const field of form.fields) {
      const val = getNestedValue(data, field.key);
      values[field.key] = val !== undefined ? val : (field.default ?? '');
    }

    return { form, values };
  });

  // Save form values to the config file
  ipcMain.handle('params:save', async (_event, { formId, values }: { formId: string; values: Record<string, unknown> }) => {
    const form = PARAM_FORMS.find((f) => f.id === formId);
    if (!form) throw new Error(`Form not found: ${formId}`);

    const fullPath = getConfigPath(form.configPath);

    // Read existing file to preserve _comments and unmanaged fields
    let data: Record<string, unknown> = {};
    if (fs.existsSync(fullPath)) {
      try { data = JSON.parse(fs.readFileSync(fullPath, 'utf-8')); } catch { /* fresh */ }
    }

    // Apply form values
    for (const field of form.fields) {
      if (field.key in values) {
        let val = values[field.key];
        // Coerce types
        if (field.type === 'number' && typeof val === 'string') val = Number(val) || 0;
        if (field.type === 'boolean' && typeof val === 'string') val = val === 'true';
        setNestedValue(data, field.key, val);
      }
    }

    // Ensure directory exists
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    fs.writeFileSync(fullPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
    return { success: true, path: fullPath };
  });
}
