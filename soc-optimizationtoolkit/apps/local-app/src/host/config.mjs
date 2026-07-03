// Config loader for the local host. The host reads ONE file,
// config/local-config.json (gitignored; copy config/local-config.example.json
// to create it), validates presence and shape, and fails fast with actionable
// errors naming the exact field and file.
//
// SECURITY POSTURE: azure.clientSecret and cribl.authToken live ONLY in this
// file. The host reads them at startup and uses them server-side; they are
// never returned by any HTTP endpoint (GET /api/config exposes non-secret
// fields only).

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isPlainObject } from './http-util.mjs';

/** Absolute path of the apps/local-app directory. */
export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The one config file the host reads (gitignored). */
export const CONFIG_PATH = path.join(APP_ROOT, 'config', 'local-config.json');

/** The committed template users copy to CONFIG_PATH. */
export const EXAMPLE_CONFIG_PATH = path.join(APP_ROOT, 'config', 'local-config.example.json');

/** On-disk state (secrets.json, jobs.json). Gitignored. */
export const DATA_DIR = path.join(APP_ROOT, 'data');

/** Vite build output of the shared UI, served at "/". */
export const WEB_ROOT = path.join(APP_ROOT, 'dist', 'web');

/**
 * @typedef {object} AzureSection
 * @property {string} tenantId Entra tenant (directory) ID.
 * @property {string} clientId App registration (client) ID.
 * @property {string} clientSecret Client secret. NEVER exposed over HTTP.
 * @property {string} subscriptionId Target subscription ID.
 * @property {string} resourceGroup Target resource group name.
 * @property {string} workspaceName Target Log Analytics workspace name.
 */

/**
 * @typedef {object} CriblSection
 * @property {string} leaderUrl On-prem leader base (https://host:9000) or a
 *   Cribl.Cloud workspace URL.
 * @property {string} authToken Static bearer token (on-prem login token or
 *   cloud token). NEVER exposed over HTTP.
 * @property {boolean} rejectUnauthorized TLS verification for LEADER calls
 *   only; set false for self-signed on-prem leader certificates.
 */

/**
 * @typedef {object} LocalConfig
 * @property {number} port Localhost port the host listens on.
 * @property {AzureSection} azure
 * @property {CriblSection} cribl
 */

const AZURE_FIELDS = ['tenantId', 'clientId', 'clientSecret', 'subscriptionId', 'resourceGroup', 'workspaceName'];

// Fields that are allowed to be empty at startup but will make specific
// endpoints fail with actionable errors when exercised.
const RUNTIME_REQUIRED = [
  ['azure.tenantId', (c) => c.azure.tenantId, 'POST /api/azure/request'],
  ['azure.clientId', (c) => c.azure.clientId, 'POST /api/azure/request'],
  ['azure.clientSecret', (c) => c.azure.clientSecret, 'POST /api/azure/request'],
  ['cribl.leaderUrl', (c) => c.cribl.leaderUrl, 'POST /api/cribl/request'],
  ['cribl.authToken', (c) => c.cribl.authToken, 'POST /api/cribl/request'],
];

/**
 * Load and validate config/local-config.json.
 *
 * Throws an Error whose message names every invalid field and the file it
 * lives in. Empty strings are accepted at load time (so the UI, secrets,
 * and jobs endpoints work before Azure/Cribl are configured) but reported
 * as warnings naming the endpoints that will fail.
 *
 * @returns {Promise<{ config: LocalConfig, warnings: string[] }>}
 */
export async function loadLocalConfig() {
  let raw;
  try {
    raw = await readFile(CONFIG_PATH, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      throw new Error(
        `Config file not found: ${CONFIG_PATH}\n` +
          `Copy ${EXAMPLE_CONFIG_PATH} to that path and fill in your values ` +
          '(local-config.json is gitignored; it holds your Azure client secret and Cribl token).'
      );
    }
    throw new Error(`Failed to read ${CONFIG_PATH}: ${err.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `${CONFIG_PATH} is not valid JSON: ${err.message}\n` +
        `Fix the file or start over from ${EXAMPLE_CONFIG_PATH}.`
    );
  }

  /** @type {string[]} */
  const errors = [];
  if (!isPlainObject(parsed)) {
    errors.push('the top-level value must be a JSON object');
  } else {
    if (typeof parsed.port !== 'number' || !Number.isInteger(parsed.port) || parsed.port < 1 || parsed.port > 65535) {
      errors.push('"port" must be an integer between 1 and 65535');
    }
    if (!isPlainObject(parsed.azure)) {
      errors.push('"azure" must be an object with tenantId, clientId, clientSecret, subscriptionId, resourceGroup, workspaceName');
    } else {
      for (const field of AZURE_FIELDS) {
        if (typeof parsed.azure[field] !== 'string') {
          errors.push(`"azure.${field}" must be a string (use "" when not yet known)`);
        }
      }
    }
    if (!isPlainObject(parsed.cribl)) {
      errors.push('"cribl" must be an object with leaderUrl, authToken, rejectUnauthorized');
    } else {
      if (typeof parsed.cribl.leaderUrl !== 'string') {
        errors.push('"cribl.leaderUrl" must be a string, e.g. "https://localhost:9000"');
      } else if (parsed.cribl.leaderUrl !== '' && !/^https?:\/\//i.test(parsed.cribl.leaderUrl)) {
        errors.push('"cribl.leaderUrl" must start with http:// or https://');
      }
      if (typeof parsed.cribl.authToken !== 'string') {
        errors.push('"cribl.authToken" must be a string (a static bearer token; use "" when not yet known)');
      }
      if (typeof parsed.cribl.rejectUnauthorized !== 'boolean') {
        errors.push('"cribl.rejectUnauthorized" must be true or false (false only for self-signed on-prem leader certificates)');
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `Invalid config in ${CONFIG_PATH}:\n` +
        errors.map((e) => `  - ${e}`).join('\n') +
        `\nSee ${EXAMPLE_CONFIG_PATH} for the expected shape.`
    );
  }

  /** @type {LocalConfig} */
  const config = {
    port: parsed.port,
    azure: {
      tenantId: parsed.azure.tenantId,
      clientId: parsed.azure.clientId,
      clientSecret: parsed.azure.clientSecret,
      subscriptionId: parsed.azure.subscriptionId,
      resourceGroup: parsed.azure.resourceGroup,
      workspaceName: parsed.azure.workspaceName,
    },
    cribl: {
      leaderUrl: parsed.cribl.leaderUrl.replace(/\/+$/, ''),
      authToken: parsed.cribl.authToken,
      rejectUnauthorized: parsed.cribl.rejectUnauthorized,
    },
  };

  const warnings = [];
  for (const [name, read, endpoint] of RUNTIME_REQUIRED) {
    if (read(config) === '') {
      warnings.push(`${name} is empty in ${CONFIG_PATH} - ${endpoint} will fail until it is set`);
    }
  }

  return { config, warnings };
}
