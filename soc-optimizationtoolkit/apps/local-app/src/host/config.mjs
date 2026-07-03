// Config loader for the local host. The host reads ONE file,
// config/local-config.json (gitignored; copy config/local-config.example.json
// to create it), validates presence and shape, and fails fast with actionable
// errors naming the exact field and file.
//
// SECURITY POSTURE: azure.clientSecret and the cribl.auth credentials
// (clientSecret / password / token) live ONLY in this file. The host reads
// them at startup and uses them server-side; they are never returned by any
// HTTP endpoint (GET /api/config exposes non-secret fields only).

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
 * @typedef {object} CriblCloudAuth Cribl.Cloud OAuth client credentials
 *   (Cribl.Cloud UI: Organization > API Credentials). The host mints and
 *   refreshes bearer tokens itself via login.cribl.cloud.
 * @property {'cloud'} type
 * @property {string} clientId
 * @property {string} clientSecret NEVER exposed over HTTP.
 */

/**
 * @typedef {object} CriblOnpremAuth Self-managed leader username/password.
 *   The host logs in via {leaderUrl}/api/v1/auth/login and re-logs-in once on
 *   a leader 401. Not available against Cribl.Cloud leaders.
 * @property {'onprem'} type
 * @property {string} username
 * @property {string} password NEVER exposed over HTTP.
 */

/**
 * @typedef {object} CriblTokenAuth Static hand-minted bearer token. The host
 *   cannot refresh it; expiry surfaces as leader 401s.
 * @property {'token'} type
 * @property {string} token NEVER exposed over HTTP.
 */

/** @typedef {CriblCloudAuth | CriblOnpremAuth | CriblTokenAuth} CriblAuth */

/**
 * @typedef {object} CriblSection
 * @property {string} leaderUrl Leader base URL WITHOUT the /api/v1 suffix -
 *   Cribl.Cloud workspace host (https://main-{orgId}.cribl.cloud) or on-prem
 *   leader (https://host:9000).
 * @property {CriblAuth} auth How the host authenticates to the leader.
 * @property {boolean} rejectUnauthorized TLS verification for LEADER calls
 *   only (including the on-prem login); set false for self-signed on-prem
 *   leader certificates. The Cribl.Cloud token mint always verifies TLS.
 */

/**
 * @typedef {object} LocalConfig
 * @property {number} port Localhost port the host listens on.
 * @property {AzureSection} azure
 * @property {CriblSection} cribl
 */

const AZURE_FIELDS = ['tenantId', 'clientId', 'clientSecret', 'subscriptionId', 'resourceGroup', 'workspaceName'];

// Required string fields per cribl.auth.type, with the hint appended to the
// wrong-type validation error. Empty strings are allowed at startup and
// produce runtime warnings instead.
const CRIBL_AUTH_FIELDS = {
  cloud: [
    ['clientId', 'Cribl.Cloud org API credential client id (Cribl.Cloud UI: Organization > API Credentials)'],
    ['clientSecret', 'Cribl.Cloud org API credential client secret'],
  ],
  onprem: [
    ['username', 'leader username'],
    ['password', 'leader password'],
  ],
  token: [['token', 'static bearer token']],
};

const CRIBL_AUTH_SHAPES =
  '{ "type": "cloud", "clientId": "...", "clientSecret": "..." } or ' +
  '{ "type": "onprem", "username": "...", "password": "..." } or ' +
  '{ "type": "token", "token": "..." }';

/**
 * Load and validate config/local-config.json.
 *
 * Throws an Error whose message names every invalid field and the file it
 * lives in. Empty strings are accepted at load time (so the UI, secrets,
 * and jobs endpoints work before Azure/Cribl are configured) but reported
 * as warnings naming the endpoints that will fail.
 *
 * BACK-COMPAT: the legacy flat `cribl.authToken` string is still accepted
 * and treated as auth { type: "token" }, with a deprecation warning in the
 * startup log.
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
          '(local-config.json is gitignored; it holds your Azure client secret and Cribl credentials).'
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
  /** @type {string[]} */
  const warnings = [];
  /** @type {CriblAuth | null} */
  let criblAuth = null;

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
      errors.push('"cribl" must be an object with leaderUrl, auth, rejectUnauthorized');
    } else {
      if (typeof parsed.cribl.leaderUrl !== 'string') {
        errors.push(
          '"cribl.leaderUrl" must be a string, e.g. "https://main-{orgId}.cribl.cloud" or "https://leader.example.com:9000"'
        );
      } else if (parsed.cribl.leaderUrl !== '' && !/^https?:\/\//i.test(parsed.cribl.leaderUrl)) {
        errors.push('"cribl.leaderUrl" must start with http:// or https://');
      } else if (/\/api\/v1\/*$/i.test(parsed.cribl.leaderUrl)) {
        errors.push(
          '"cribl.leaderUrl" must not end with /api/v1 - the host appends /api/v1 to every leader call itself; use the bare leader base URL'
        );
      }
      if (typeof parsed.cribl.rejectUnauthorized !== 'boolean') {
        errors.push('"cribl.rejectUnauthorized" must be true or false (false only for self-signed on-prem leader certificates)');
      }
      criblAuth = validateCriblAuth(parsed.cribl, errors, warnings);
    }
  }

  if (errors.length > 0 || criblAuth === null) {
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
      auth: criblAuth,
      rejectUnauthorized: parsed.cribl.rejectUnauthorized,
    },
  };

  // Fields that are allowed to be empty at startup but will make specific
  // endpoints fail with actionable errors when exercised.
  const runtimeRequired = [
    ['azure.tenantId', config.azure.tenantId, 'POST /api/azure/request'],
    ['azure.clientId', config.azure.clientId, 'POST /api/azure/request'],
    ['azure.clientSecret', config.azure.clientSecret, 'POST /api/azure/request'],
    ['cribl.leaderUrl', config.cribl.leaderUrl, 'POST /api/cribl/request'],
  ];
  for (const [field] of CRIBL_AUTH_FIELDS[config.cribl.auth.type]) {
    runtimeRequired.push([`cribl.auth.${field}`, config.cribl.auth[field], 'POST /api/cribl/request']);
  }
  for (const [name, value, endpoint] of runtimeRequired) {
    if (value === '') {
      warnings.push(`${name} is empty in ${CONFIG_PATH} - ${endpoint} will fail until it is set`);
    }
  }

  return { config, warnings };
}

/**
 * Validate the cribl.auth block (with legacy flat authToken back-compat)
 * and return the normalized CriblAuth, or null when invalid (with the
 * problems pushed onto `errors`).
 *
 * @param {Record<string, unknown>} cribl Parsed "cribl" object.
 * @param {string[]} errors
 * @param {string[]} warnings
 * @returns {CriblAuth | null}
 */
function validateCriblAuth(cribl, errors, warnings) {
  const rawAuth = cribl.auth;
  const legacyToken = cribl.authToken;

  if (rawAuth === undefined) {
    if (typeof legacyToken === 'string') {
      // Legacy flat shape: treat as a static token with a deprecation note
      // in the startup log.
      warnings.push(
        `cribl.authToken is DEPRECATED - replace it with "auth": { "type": "token", "token": "..." } in ${CONFIG_PATH}, ` +
          `or switch to type "cloud"/"onprem" so the host mints tokens itself (see ${EXAMPLE_CONFIG_PATH})`
      );
      return { type: 'token', token: legacyToken };
    }
    errors.push(`"cribl.auth" must be an object: ${CRIBL_AUTH_SHAPES}`);
    return null;
  }

  if (!isPlainObject(rawAuth)) {
    errors.push(`"cribl.auth" must be an object: ${CRIBL_AUTH_SHAPES}`);
    return null;
  }

  const type = rawAuth.type;
  if (type !== 'cloud' && type !== 'onprem' && type !== 'token') {
    errors.push(
      '"cribl.auth.type" must be "cloud" (Cribl.Cloud org API credentials), ' +
        '"onprem" (leader username/password), or "token" (static bearer token)'
    );
    return null;
  }

  if (typeof legacyToken === 'string' && legacyToken !== '') {
    warnings.push(`cribl.authToken is ignored because cribl.auth is set - remove it from ${CONFIG_PATH}`);
  }

  /** @type {Record<string, string>} */
  const fields = {};
  let valid = true;
  for (const [field, hint] of CRIBL_AUTH_FIELDS[type]) {
    if (typeof rawAuth[field] !== 'string') {
      errors.push(`"cribl.auth.${field}" must be a string - ${hint} (use "" when not yet known)`);
      valid = false;
    } else {
      fields[field] = rawAuth[field];
    }
  }
  if (!valid) {
    return null;
  }
  return /** @type {CriblAuth} */ ({ type, ...fields });
}
