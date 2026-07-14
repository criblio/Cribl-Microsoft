// Vendor Research Module
// Fetches, parses, and caches vendor log schemas from structured sources:
//   - OpenAPI / Swagger specs (CrowdStrike, Okta, Cloudflare, Microsoft Graph)
//   - Sentinel Data Connector JSON files (GitHub)
//   - Vendor-published JSON schema endpoints
//   - Static reference data for vendors without machine-readable schemas
//
// The registry maps vendor names to their schema sources. At pack build time
// the module fetches the relevant schemas, caches them locally, and returns
// a normalized field list the pack builder uses for pipeline generation.

import https from 'https';
import fs from 'fs';
import path from 'path';
import { IpcMain } from 'electron';
import { lookupDynamicEntry, DynamicRegistryEntry } from './registry-sync';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VendorField {
  name: string;
  type: string;
  description: string;
  required: boolean;
  example?: string;
  logType?: string;
}

// Maps a source field to its destination (DCR) field name.
// If destName differs from the source name, the pipeline generates a rename.
// If destType differs from source type, the pipeline generates a coerce.
export interface FieldMapping {
  sourceName: string;    // Field name as it arrives from the vendor
  sourceType: string;    // Data type in the source event
  destName: string;      // Field name in the DCR / Sentinel table
  destType: string;      // Data type expected by the DCR
  action: 'map' | 'drop' | 'enrich';  // map=transform, drop=remove, enrich=add new field
  description: string;
}

export interface VendorLogType {
  id: string;
  name: string;
  description: string;
  // Source-side fields: what arrives at Cribl from the vendor
  fields: VendorField[];
  // Source format (how events arrive)
  sourceFormat: 'json' | 'cef' | 'leef' | 'kv' | 'csv' | 'syslog' | 'xml' | 'ndjson';
  // Sourcetype pattern used in Cribl routing (e.g., "cloudflare:json")
  sourcetypePattern?: string;
  // Timestamp field name in the SOURCE data
  timestampField?: string;
  // Explicit source -> destination field mappings (when known)
  fieldMappings?: FieldMapping[];
  // Sentinel destination table name
  destTable?: string;
}

export interface VendorResearchResult {
  vendor: string;
  displayName: string;
  description: string;
  logTypes: VendorLogType[];
  sourceType: string;       // Suggested Cribl source type
  sourcePreset?: string;    // Vendor preset key for source-types.ts
  documentationUrl: string;
  fetchedAt: number;        // Unix timestamp
  fromCache: boolean;
}

type ParserType = 'openapi' | 'sentinel_connector' | 'json_schema' | 'static';

interface VendorRegistryEntry {
  vendor: string;
  displayName: string;
  description: string;
  sourceType: string;
  sourcePreset?: string;
  documentationUrl: string;
  schemas: Array<{
    url: string;
    parser: ParserType;
    // For OpenAPI: which paths/tags contain the log data models
    hints?: Record<string, string>;
  }>;
  // Static fallback if remote fetch fails
  staticLogTypes?: VendorLogType[];
}

// ---------------------------------------------------------------------------
// HTTPS Fetch (reusable)
// ---------------------------------------------------------------------------

function httpsFetch(url: string, timeoutMs: number = 15000): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options: https.RequestOptions = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Cribl-Microsoft-Integration/1.0',
        'Accept': 'application/json, */*',
      },
      timeout: timeoutMs,
    };

    const req = https.request(options, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        httpsFetch(res.headers.location, timeoutMs).then(resolve).catch(reject);
        return;
      }
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data);
        } else {
          reject(new Error(`HTTP ${res.statusCode} from ${parsed.hostname}${parsed.pathname}`));
        }
      });
    });

    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout fetching ${url}`)); });
    req.on('error', reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

// Parse an OpenAPI 3.x / Swagger 2.x spec and extract response schemas
// as VendorLogType entries. Uses hints to find the right paths.
function parseOpenApiSpec(
  spec: Record<string, unknown>,
  hints: Record<string, string>,
): VendorLogType[] {
  const logTypes: VendorLogType[] = [];

  // Resolve $ref pointers in the spec
  function resolveRef(ref: string): Record<string, unknown> | null {
    // "#/components/schemas/HttpRequestLog" -> components.schemas.HttpRequestLog
    const parts = ref.replace('#/', '').split('/');
    let current: unknown = spec;
    for (const part of parts) {
      if (current && typeof current === 'object') {
        current = (current as Record<string, unknown>)[part];
      } else {
        return null;
      }
    }
    return (current && typeof current === 'object') ? current as Record<string, unknown> : null;
  }

  // Extract fields from a schema object (handles $ref, properties, allOf)
  function extractFields(schema: Record<string, unknown>, logType: string): VendorField[] {
    const fields: VendorField[] = [];

    // Handle $ref
    if (schema['$ref'] && typeof schema['$ref'] === 'string') {
      const resolved = resolveRef(schema['$ref']);
      if (resolved) return extractFields(resolved, logType);
      return fields;
    }

    // Handle allOf (merge all schemas)
    if (Array.isArray(schema.allOf)) {
      for (const sub of schema.allOf) {
        if (sub && typeof sub === 'object') {
          fields.push(...extractFields(sub as Record<string, unknown>, logType));
        }
      }
      return fields;
    }

    // Handle properties
    const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
    const required = new Set(Array.isArray(schema.required) ? schema.required as string[] : []);

    if (properties) {
      for (const [name, prop] of Object.entries(properties)) {
        let type = 'string';
        if (prop['$ref'] && typeof prop['$ref'] === 'string') {
          // Nested object reference
          type = 'dynamic';
        } else {
          type = mapOpenApiType(
            (prop.type as string) || 'string',
            (prop.format as string) || '',
          );
        }

        fields.push({
          name,
          type,
          description: (prop.description as string) || '',
          required: required.has(name),
          example: prop.example !== undefined ? String(prop.example) : undefined,
          logType,
        });
      }
    }

    // Handle items (for array types)
    if (schema.type === 'array' && schema.items && typeof schema.items === 'object') {
      fields.push(...extractFields(schema.items as Record<string, unknown>, logType));
    }

    return fields;
  }

  // Find schemas via hints or enumerate all
  const components = spec.components as Record<string, unknown> | undefined;
  const definitions = spec.definitions as Record<string, Record<string, unknown>> | undefined;
  const schemas = (components?.schemas || definitions || {}) as Record<string, Record<string, unknown>>;

  if (hints && Object.keys(hints).length > 0) {
    // Use hints to pick specific schemas
    for (const [logTypeId, schemaName] of Object.entries(hints)) {
      const schema = schemas[schemaName];
      if (schema) {
        const fields = extractFields(schema, logTypeId);
        if (fields.length > 0) {
          logTypes.push({
            id: logTypeId,
            name: schemaName,
            description: (schema.description as string) || `${schemaName} log events`,
            fields,
          });
        }
      }
    }
  } else {
    // No hints -- enumerate all schemas that look like log/event models
    const logKeywords = /log|event|alert|incident|detection|finding|record|audit|activity/i;
    for (const [schemaName, schema] of Object.entries(schemas)) {
      if (!logKeywords.test(schemaName)) continue;
      if (!schema.properties && !schema.allOf) continue;

      const fields = extractFields(schema, schemaName);
      if (fields.length > 2) {
        logTypes.push({
          id: schemaName.replace(/[^a-zA-Z0-9]/g, '_'),
          name: schemaName,
          description: (schema.description as string) || `${schemaName} events`,
          fields,
        });
      }
    }
  }

  return logTypes;
}

function mapOpenApiType(type: string, format: string): string {
  const t = type.toLowerCase();
  const f = format.toLowerCase();
  if (f === 'date-time' || f === 'date' || f === 'time') return 'datetime';
  if (t === 'integer' || t === 'int32') return 'int';
  if (t === 'number' || f === 'float' || f === 'double') return 'real';
  if (t === 'boolean') return 'boolean';
  if (t === 'object') return 'dynamic';
  if (t === 'array') return 'dynamic';
  return 'string';
}

// Parse a Sentinel Data Connector JSON and extract log type definitions.
// This wraps the schema extraction from github.ts into VendorLogType format.
function parseSentinelConnector(
  connector: Record<string, unknown>,
): VendorLogType[] {
  const logTypes: VendorLogType[] = [];

  // Extract tables with columns
  if (Array.isArray(connector.tables)) {
    for (const table of connector.tables) {
      const t = table as Record<string, unknown>;
      if (!t.name) continue;
      const columns = Array.isArray(t.columns) ? t.columns as Array<Record<string, string>> : [];
      logTypes.push({
        id: (t.name as string).replace(/[^a-zA-Z0-9_]/g, '_'),
        name: t.name as string,
        description: (t.description as string) || `${t.name} table`,
        fields: columns.map((c) => ({
          name: c.name || c.columnName || '',
          type: normalizeType(c.type || c.columnType || 'string'),
          description: c.description || '',
          required: false,
        })).filter((f) => f.name),
      });
    }
  }

  // ARM template resources with streamDeclarations
  if (Array.isArray(connector.resources)) {
    for (const resource of connector.resources) {
      const r = resource as Record<string, unknown>;
      const props = r.properties as Record<string, unknown> | undefined;
      if (!props?.streamDeclarations) continue;
      const streams = props.streamDeclarations as Record<string, { columns?: Array<Record<string, string>> }>;
      for (const [streamName, streamDef] of Object.entries(streams)) {
        if (!Array.isArray(streamDef.columns)) continue;
        const tableName = streamName.replace(/^Custom-/, '');
        logTypes.push({
          id: tableName.replace(/[^a-zA-Z0-9_]/g, '_'),
          name: tableName,
          description: `${tableName} stream`,
          fields: streamDef.columns.map((c) => ({
            name: c.name,
            type: normalizeType(c.type || 'string'),
            description: '',
            required: false,
          })).filter((f) => f.name),
        });
      }
    }
  }

  // dataTypes array (minimal -- just table names, no columns)
  if (logTypes.length === 0 && Array.isArray(connector.dataTypes)) {
    for (const dt of connector.dataTypes) {
      const d = dt as Record<string, unknown>;
      if (d.name) {
        logTypes.push({
          id: (d.name as string).replace(/[^a-zA-Z0-9_]/g, '_'),
          name: d.name as string,
          description: `${d.name} data type`,
          fields: [],
        });
      }
    }
  }

  return logTypes;
}

// Parse a JSON Schema document into field definitions
function parseJsonSchema(schema: Record<string, unknown>): VendorLogType[] {
  const logTypes: VendorLogType[] = [];
  const title = (schema.title as string) || 'Unknown';
  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
  const required = new Set(Array.isArray(schema.required) ? schema.required as string[] : []);

  if (properties) {
    const fields: VendorField[] = [];
    for (const [name, prop] of Object.entries(properties)) {
      fields.push({
        name,
        type: normalizeType((prop.type as string) || 'string'),
        description: (prop.description as string) || '',
        required: required.has(name),
        example: prop.example !== undefined ? String(prop.example) : undefined,
      });
    }
    if (fields.length > 0) {
      logTypes.push({
        id: title.replace(/[^a-zA-Z0-9_]/g, '_'),
        name: title,
        description: (schema.description as string) || `${title} schema`,
        fields,
      });
    }
  }

  return logTypes;
}

function normalizeType(type: string): string {
  const map: Record<string, string> = {
    string: 'string', str: 'string',
    int: 'int', integer: 'int', int32: 'int',
    long: 'long', int64: 'long', bigint: 'long',
    real: 'real', double: 'real', float: 'real', number: 'real', decimal: 'real',
    bool: 'boolean', boolean: 'boolean',
    datetime: 'datetime', timestamp: 'datetime', date: 'datetime', 'date-time': 'datetime',
    dynamic: 'dynamic', object: 'dynamic', json: 'dynamic', array: 'dynamic',
    guid: 'string', uuid: 'string',
  };
  return map[type.toLowerCase()] || 'string';
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

function getCacheDir(): string {
  const appData = process.env.APPDATA || process.env.HOME || '';
  const cacheDir = path.join(appData, '.cribl-microsoft', 'vendor-cache');
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }
  return cacheDir;
}

function getCachePath(vendor: string): string {
  return path.join(getCacheDir(), `${vendor.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function readCache(vendor: string): VendorResearchResult | null {
  const cachePath = getCachePath(vendor);
  if (!fs.existsSync(cachePath)) return null;
  try {
    const raw = fs.readFileSync(cachePath, 'utf-8');
    const cached = JSON.parse(raw) as VendorResearchResult;
    if (Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return { ...cached, fromCache: true };
    }
  } catch {
    // Corrupt cache, ignore
  }
  return null;
}

function writeCache(result: VendorResearchResult): void {
  try {
    const cachePath = getCachePath(result.vendor);
    fs.writeFileSync(cachePath, JSON.stringify(result, null, 2));
  } catch {
    // Non-fatal
  }
}

// ---------------------------------------------------------------------------
// Vendor Registry
// ---------------------------------------------------------------------------

const VENDOR_REGISTRY: VendorRegistryEntry[] = [
  {
    vendor: 'cloudflare',
    displayName: 'Cloudflare',
    description: 'Cloudflare CDN, WAF, DNS, and Zero Trust logs via Logpush',
    sourceType: 'rest_collector',
    sourcePreset: 'cloudflare',
    documentationUrl: 'https://developers.cloudflare.com/logs/reference/log-fields/',
    schemas: [
      {
        url: 'https://raw.githubusercontent.com/Azure/Azure-Sentinel/master/Solutions/Cloudflare/Data%20Connectors/CloudflareDataConnector.json',
        parser: 'sentinel_connector',
      },
    ],
    staticLogTypes: [
      {
        id: 'http_requests',
        name: 'HTTP Requests',
        description: 'Cloudflare HTTP request logs from the http_requests Logpush dataset',
        sourceFormat: 'json',
        sourcetypePattern: 'cloudflare:json',
        timestampField: 'EdgeStartTimestamp',
        destTable: 'CloudflareV2_CL',
        fieldMappings: [
          // Cloudflare source fields pass through as-is (same names in DCR)
          // Only these fields need special handling:
          { sourceName: 'EdgeStartTimestamp', sourceType: 'string', destName: 'TimeGenerated', destType: 'datetime', action: 'map', description: 'Map Cloudflare timestamp to Sentinel TimeGenerated' },
          { sourceName: 'FraudAttack', sourceType: 'string', destName: 'FraudAttack', destType: 'string', action: 'drop', description: 'Not in DCR schema' },
          { sourceName: 'JSDetectionPassed', sourceType: 'boolean', destName: 'JSDetectionPassed', destType: 'boolean', action: 'drop', description: 'Not in DCR schema' },
          { sourceName: 'OriginResponseTime', sourceType: 'int', destName: 'OriginResponseTime', destType: 'int', action: 'drop', description: 'Not in DCR schema' },
          { sourceName: 'VerifiedBotCategory', sourceType: 'string', destName: 'VerifiedBotCategory', destType: 'string', action: 'drop', description: 'Not in DCR schema' },
        ],
        fields: [
          { name: 'CacheCacheStatus', type: 'string', description: 'Cache status (hit, miss, expired, etc.)', required: false },
          { name: 'CacheResponseBytes', type: 'int', description: 'Number of bytes returned from cache', required: false },
          { name: 'CacheResponseStatus', type: 'int', description: 'HTTP status returned by cache', required: false },
          { name: 'ClientASN', type: 'int', description: 'Client AS number', required: false },
          { name: 'ClientCountry', type: 'string', description: 'Country of client IP (ISO 3166-1 alpha-2)', required: false },
          { name: 'ClientDeviceType', type: 'string', description: 'Client device type (desktop, mobile, etc.)', required: false },
          { name: 'ClientIP', type: 'string', description: 'Client IP address', required: true },
          { name: 'ClientIPClass', type: 'string', description: 'Client IP class (clean, threat, crawler, etc.)', required: false },
          { name: 'ClientRequestBytes', type: 'int', description: 'Number of bytes in client request', required: false },
          { name: 'ClientRequestHost', type: 'string', description: 'Host requested by client', required: true },
          { name: 'ClientRequestMethod', type: 'string', description: 'HTTP method of client request', required: true },
          { name: 'ClientRequestPath', type: 'string', description: 'URI path requested by client', required: false },
          { name: 'ClientRequestProtocol', type: 'string', description: 'HTTP protocol of client request', required: false },
          { name: 'ClientRequestReferer', type: 'string', description: 'HTTP Referer header value', required: false },
          { name: 'ClientRequestURI', type: 'string', description: 'Full URI of client request', required: true },
          { name: 'ClientRequestUserAgent', type: 'string', description: 'User-Agent header from client', required: false },
          { name: 'ClientSSLCipher', type: 'string', description: 'Client SSL cipher', required: false },
          { name: 'ClientSSLProtocol', type: 'string', description: 'Client SSL protocol version', required: false },
          { name: 'ClientSrcPort', type: 'int', description: 'Client source port', required: false },
          { name: 'EdgeColoCode', type: 'string', description: 'IATA airport code of Cloudflare data center', required: false },
          { name: 'EdgeColoID', type: 'int', description: 'Cloudflare data center ID', required: false },
          { name: 'EdgeEndTimestamp', type: 'datetime', description: 'Timestamp when edge finished processing', required: false },
          { name: 'EdgePathingOp', type: 'string', description: 'Edge pathing operation (wl, ban, chl)', required: false },
          { name: 'EdgePathingSrc', type: 'string', description: 'Edge pathing source (macro, user, filter)', required: false },
          { name: 'EdgePathingStatus', type: 'string', description: 'Edge pathing status (nr, unknown, etc.)', required: false },
          { name: 'EdgeRateLimitAction', type: 'string', description: 'Rate limiting action taken', required: false },
          { name: 'EdgeRateLimitID', type: 'int', description: 'Rate limiting rule ID', required: false },
          { name: 'EdgeRequestHost', type: 'string', description: 'Host header on edge request to origin', required: false },
          { name: 'EdgeResponseBytes', type: 'int', description: 'Number of bytes returned by edge to client', required: false },
          { name: 'EdgeResponseCompressionRatio', type: 'real', description: 'Edge response compression ratio', required: false },
          { name: 'EdgeResponseContentType', type: 'string', description: 'Edge response Content-Type header', required: false },
          { name: 'EdgeResponseStatus', type: 'int', description: 'HTTP status code returned to client', required: true },
          { name: 'EdgeServerIP', type: 'string', description: 'IP of Cloudflare server', required: false },
          { name: 'EdgeStartTimestamp', type: 'datetime', description: 'Timestamp when edge received request', required: true },
          { name: 'OriginIP', type: 'string', description: 'Origin server IP', required: false },
          { name: 'OriginResponseHTTPExpires', type: 'string', description: 'Value of origin Expires header', required: false },
          { name: 'OriginResponseHTTPLastModified', type: 'string', description: 'Value of origin Last-Modified header', required: false },
          { name: 'OriginResponseStatus', type: 'int', description: 'HTTP status from origin', required: false },
          { name: 'OriginSSLProtocol', type: 'string', description: 'SSL protocol used to connect to origin', required: false },
          { name: 'ParentRayID', type: 'string', description: 'Ray ID of parent request (for subrequests)', required: false },
          { name: 'RayID', type: 'string', description: 'Cloudflare Ray ID for this request', required: true },
          { name: 'SecurityLevel', type: 'string', description: 'Security level applied', required: false },
          { name: 'WAFAction', type: 'string', description: 'WAF action taken (allow, log, simulate, block)', required: false },
          { name: 'WAFFlags', type: 'string', description: 'WAF flags', required: false },
          { name: 'WAFMatchedVar', type: 'string', description: 'WAF matched variable (body, header, etc.)', required: false },
          { name: 'WAFProfile', type: 'string', description: 'WAF profile (low, med, high)', required: false },
          { name: 'WAFRuleID', type: 'string', description: 'WAF rule ID that triggered', required: false },
          { name: 'WAFRuleMessage', type: 'string', description: 'WAF rule descriptive message', required: false },
          { name: 'WorkerCPUTime', type: 'int', description: 'CPU time used by Cloudflare Worker (microseconds)', required: false },
          { name: 'WorkerStatus', type: 'string', description: 'Cloudflare Worker status (ok, exception, etc.)', required: false },
          { name: 'WorkerSubrequest', type: 'boolean', description: 'Whether this was a Worker subrequest', required: false },
          { name: 'WorkerSubrequestCount', type: 'int', description: 'Number of Worker subrequests', required: false },
          { name: 'ZoneID', type: 'int', description: 'Cloudflare zone ID', required: false },
          { name: 'ZoneName', type: 'string', description: 'Cloudflare zone name (domain)', required: false },
        ],
      },
      {
        id: 'firewall_events',
        name: 'Firewall / WAF Events',
        description: 'Cloudflare WAF and firewall event logs',
        sourceFormat: 'json',
        sourcetypePattern: 'cloudflare:waf',
        timestampField: 'Datetime',
        destTable: 'CloudflareV2_CL',
        fieldMappings: [
          { sourceName: 'Datetime', sourceType: 'string', destName: 'TimeGenerated', destType: 'datetime', action: 'map', description: 'Map WAF timestamp to Sentinel TimeGenerated' },
        ],
        fields: [
          { name: 'Action', type: 'string', description: 'Firewall action (allow, log, block, challenge, jschallenge, managedChallenge)', required: true },
          { name: 'ClientASN', type: 'int', description: 'Client AS number', required: false },
          { name: 'ClientASNDescription', type: 'string', description: 'Client AS name', required: false },
          { name: 'ClientCountry', type: 'string', description: 'Client country code', required: false },
          { name: 'ClientIP', type: 'string', description: 'Client IP address', required: true },
          { name: 'ClientIPClass', type: 'string', description: 'Client IP classification', required: false },
          { name: 'ClientRefererHost', type: 'string', description: 'Referer host', required: false },
          { name: 'ClientRefererPath', type: 'string', description: 'Referer path', required: false },
          { name: 'ClientRefererQuery', type: 'string', description: 'Referer query string', required: false },
          { name: 'ClientRefererScheme', type: 'string', description: 'Referer scheme', required: false },
          { name: 'ClientRequestHost', type: 'string', description: 'Requested host', required: true },
          { name: 'ClientRequestMethod', type: 'string', description: 'HTTP method', required: true },
          { name: 'ClientRequestPath', type: 'string', description: 'URI path', required: false },
          { name: 'ClientRequestProtocol', type: 'string', description: 'HTTP protocol version', required: false },
          { name: 'ClientRequestQuery', type: 'string', description: 'Query string', required: false },
          { name: 'ClientRequestScheme', type: 'string', description: 'Request scheme (http/https)', required: false },
          { name: 'ClientRequestUserAgent', type: 'string', description: 'User-Agent header', required: false },
          { name: 'Datetime', type: 'datetime', description: 'Event timestamp', required: true },
          { name: 'EdgeColoCode', type: 'string', description: 'IATA code of Cloudflare data center', required: false },
          { name: 'EdgeResponseStatus', type: 'int', description: 'HTTP status returned to client', required: false },
          { name: 'Kind', type: 'string', description: 'Rule kind (firewall, managed, rateLimit, etc.)', required: false },
          { name: 'MatchIndex', type: 'int', description: 'Match index in rule evaluation', required: false },
          { name: 'Metadata', type: 'dynamic', description: 'Additional metadata as key-value pairs', required: false },
          { name: 'OriginResponseStatus', type: 'int', description: 'HTTP status from origin', required: false },
          { name: 'OriginatorRayID', type: 'string', description: 'Ray ID of the originator request', required: false },
          { name: 'RayID', type: 'string', description: 'Cloudflare Ray ID', required: true },
          { name: 'RuleID', type: 'string', description: 'Rule ID that matched', required: false },
          { name: 'Source', type: 'string', description: 'Source of the event (firewallrules, sanitycheck, etc.)', required: false },
        ],
      },
      {
        id: 'dns_logs',
        name: 'DNS Logs',
        description: 'Cloudflare authoritative DNS query logs',
        sourceFormat: 'json',
        sourcetypePattern: 'cloudflare:dns:zones',
        timestampField: 'Timestamp',
        destTable: 'CloudflareV2_CL',
        fieldMappings: [
          { sourceName: 'Timestamp', sourceType: 'string', destName: 'Datetime', destType: 'datetime', action: 'map', description: 'DNS uses Timestamp, DCR expects Datetime' },
          { sourceName: 'Timestamp', sourceType: 'string', destName: 'TimeGenerated', destType: 'datetime', action: 'map', description: 'Map to Sentinel TimeGenerated' },
          { sourceName: 'ResponseCode', sourceType: 'int', destName: 'RCode', destType: 'int', action: 'map', description: 'DNS ResponseCode maps to RCode in DCR' },
          { sourceName: 'QueryType', sourceType: 'int', destName: 'QueryTypeName', destType: 'string', action: 'enrich', description: 'Derive human-readable query type name from numeric QueryType' },
        ],
        fields: [
          { name: 'ColoCode', type: 'string', description: 'IATA code of Cloudflare data center', required: false },
          { name: 'EDNSSubnet', type: 'string', description: 'EDNS Client Subnet', required: false },
          { name: 'EDNSSubnetLength', type: 'int', description: 'EDNS subnet prefix length', required: false },
          { name: 'QueryName', type: 'string', description: 'DNS query name (FQDN)', required: true },
          { name: 'QueryType', type: 'int', description: 'DNS query type code (1=A, 28=AAAA, etc.)', required: true },
          { name: 'ResponseCached', type: 'boolean', description: 'Whether response was served from cache', required: false },
          { name: 'ResponseCode', type: 'int', description: 'DNS response code (0=NOERROR, 3=NXDOMAIN)', required: true },
          { name: 'SourceIP', type: 'string', description: 'IP of the DNS resolver', required: true },
          { name: 'Timestamp', type: 'datetime', description: 'Query timestamp', required: true },
        ],
      },
    ],
  },
  {
    vendor: 'crowdstrike',
    displayName: 'CrowdStrike Falcon',
    description: 'CrowdStrike Falcon Data Replicator (FDR) endpoint telemetry - 10 custom Sentinel tables',
    sourceType: 'rest_collector',
    sourcePreset: 'crowdstrike',
    documentationUrl: 'https://falcon.crowdstrike.com/documentation/page/d88d9ed6/streaming-api-event-dictionary',
    schemas: [
      {
        url: 'https://raw.githubusercontent.com/Azure/Azure-Sentinel/master/Solutions/CrowdStrike%20Falcon%20Endpoint%20Protection/Data%20Connectors/CrowdStrikeS3FDR_ccp/DataConnectorDefinition.json',
        parser: 'sentinel_connector',
      },
    ],
    staticLogTypes: [
      {
        id: 'process_events',
        name: 'Process_Events',
        description: 'Process creation, termination, injection, module loads',
        destTable: 'CrowdStrike_Process_Events_CL',
        sourceFormat: 'json',
        sourcetypePattern: 'crowdstrike:fdr:process',
        timestampField: 'timestamp',
        fields: [
          { name: 'event_simpleName', type: 'string', description: 'Event type name', required: true },
          { name: 'aid', type: 'string', description: 'Agent/sensor ID', required: true },
          { name: 'timestamp', type: 'string', description: 'Event timestamp (epoch ms)', required: true },
          { name: 'aip', type: 'string', description: 'Agent external IP', required: false },
          { name: 'CommandLine', type: 'string', description: 'Process command line', required: false },
          { name: 'ImageFileName', type: 'string', description: 'Process image file', required: false },
          { name: 'SHA256HashData', type: 'string', description: 'SHA256 hash', required: false },
          { name: 'MD5HashData', type: 'string', description: 'MD5 hash', required: false },
          { name: 'ParentBaseFileName', type: 'string', description: 'Parent process name', required: false },
          { name: 'TargetProcessId', type: 'string', description: 'Target process ID', required: false },
          { name: 'UserSid', type: 'string', description: 'User SID', required: false },
        ],
      },
      {
        id: 'network_events',
        name: 'Network_Events',
        description: 'Network connections, listens, binds, firewall rules',
        destTable: 'CrowdStrike_Network_Events_CL',
        sourceFormat: 'json',
        sourcetypePattern: 'crowdstrike:fdr:network',
        timestampField: 'timestamp',
        fields: [
          { name: 'event_simpleName', type: 'string', description: 'Event type name', required: true },
          { name: 'aid', type: 'string', description: 'Agent/sensor ID', required: true },
          { name: 'timestamp', type: 'string', description: 'Event timestamp (epoch ms)', required: true },
          { name: 'RemoteAddressIP4', type: 'string', description: 'Remote IPv4 address', required: false },
          { name: 'RemotePort', type: 'string', description: 'Remote port', required: false },
          { name: 'LocalAddressIP4', type: 'string', description: 'Local IPv4 address', required: false },
          { name: 'LocalPort', type: 'string', description: 'Local port', required: false },
          { name: 'Protocol', type: 'string', description: 'Network protocol', required: false },
          { name: 'ConnectionDirection', type: 'string', description: 'Connection direction', required: false },
        ],
      },
      {
        id: 'dns_events',
        name: 'DNS_Events',
        description: 'DNS requests and suspicious DNS activity',
        destTable: 'CrowdStrike_DNS_Events_CL',
        sourceFormat: 'json',
        sourcetypePattern: 'crowdstrike:fdr:dns',
        timestampField: 'timestamp',
        fields: [
          { name: 'event_simpleName', type: 'string', description: 'Event type name', required: true },
          { name: 'aid', type: 'string', description: 'Agent/sensor ID', required: true },
          { name: 'timestamp', type: 'string', description: 'Event timestamp (epoch ms)', required: true },
          { name: 'DomainName', type: 'string', description: 'Queried domain name', required: false },
          { name: 'RequestType', type: 'string', description: 'DNS request type', required: false },
          { name: 'IP4Records', type: 'string', description: 'IPv4 answer records', required: false },
        ],
      },
      {
        id: 'file_events',
        name: 'File_Events',
        description: 'File writes, renames, deletes, directory creates',
        destTable: 'CrowdStrike_File_Events_CL',
        sourceFormat: 'json',
        sourcetypePattern: 'crowdstrike:fdr:file',
        timestampField: 'timestamp',
        fields: [
          { name: 'event_simpleName', type: 'string', description: 'Event type name', required: true },
          { name: 'aid', type: 'string', description: 'Agent/sensor ID', required: true },
          { name: 'timestamp', type: 'string', description: 'Event timestamp (epoch ms)', required: true },
          { name: 'TargetFileName', type: 'string', description: 'Target file name', required: false },
          { name: 'SHA256HashData', type: 'string', description: 'SHA256 hash', required: false },
          { name: 'Size', type: 'string', description: 'File size', required: false },
        ],
      },
      {
        id: 'auth_events',
        name: 'Auth_Events',
        description: 'User logon, logoff, and authentication failures',
        destTable: 'CrowdStrike_Auth_Events_CL',
        sourceFormat: 'json',
        sourcetypePattern: 'crowdstrike:fdr:auth',
        timestampField: 'timestamp',
        fields: [
          { name: 'event_simpleName', type: 'string', description: 'Event type name', required: true },
          { name: 'aid', type: 'string', description: 'Agent/sensor ID', required: true },
          { name: 'timestamp', type: 'string', description: 'Event timestamp (epoch ms)', required: true },
          { name: 'UserName', type: 'string', description: 'User name', required: false },
          { name: 'LogonType', type: 'string', description: 'Logon type', required: false },
          { name: 'LogonTime', type: 'string', description: 'Logon time', required: false },
        ],
      },
      {
        id: 'registry_events',
        name: 'Registry_Events',
        description: 'Registry key and value modifications',
        destTable: 'CrowdStrike_Registry_Events_CL',
        sourceFormat: 'json',
        sourcetypePattern: 'crowdstrike:fdr:registry',
        timestampField: 'timestamp',
        fields: [
          { name: 'event_simpleName', type: 'string', description: 'Event type name', required: true },
          { name: 'aid', type: 'string', description: 'Agent/sensor ID', required: true },
          { name: 'timestamp', type: 'string', description: 'Event timestamp (epoch ms)', required: true },
          { name: 'RegObjectName', type: 'string', description: 'Registry object name', required: false },
          { name: 'RegValueName', type: 'string', description: 'Registry value name', required: false },
          { name: 'RegStringValue', type: 'string', description: 'Registry string value', required: false },
        ],
      },
      {
        id: 'audit_events',
        name: 'Audit_Events',
        description: 'Sensor heartbeat, config state, firewall, volume, system events',
        destTable: 'CrowdStrike_Audit_Events_CL',
        sourceFormat: 'json',
        sourcetypePattern: 'crowdstrike:fdr:audit',
        timestampField: 'timestamp',
        fields: [
          { name: 'event_simpleName', type: 'string', description: 'Event type name', required: true },
          { name: 'aid', type: 'string', description: 'Agent/sensor ID', required: true },
          { name: 'timestamp', type: 'string', description: 'Event timestamp (epoch ms)', required: true },
          { name: 'ConfigBuild', type: 'string', description: 'Config build version', required: false },
          { name: 'ConfigStateHash', type: 'string', description: 'Config state hash', required: false },
        ],
      },
      {
        id: 'user_events',
        name: 'User_Events',
        description: 'User account creation, deletion, group membership',
        destTable: 'CrowdStrike_User_Events_CL',
        sourceFormat: 'json',
        sourcetypePattern: 'crowdstrike:fdr:user',
        timestampField: 'timestamp',
        fields: [
          { name: 'event_simpleName', type: 'string', description: 'Event type name', required: true },
          { name: 'aid', type: 'string', description: 'Agent/sensor ID', required: true },
          { name: 'timestamp', type: 'string', description: 'Event timestamp (epoch ms)', required: true },
          { name: 'UserRid', type: 'string', description: 'User RID', required: false },
          { name: 'GroupRid', type: 'string', description: 'Group RID', required: false },
        ],
      },
      {
        id: 'additional_events',
        name: 'Additional_Events',
        description: 'Drivers, services, scheduled tasks, injections, SMB, firewall, misc',
        destTable: 'CrowdStrike_Additional_Events_CL',
        sourceFormat: 'json',
        sourcetypePattern: 'crowdstrike:fdr:additional',
        timestampField: 'timestamp',
        fields: [
          { name: 'event_simpleName', type: 'string', description: 'Event type name', required: true },
          { name: 'aid', type: 'string', description: 'Agent/sensor ID', required: true },
          { name: 'timestamp', type: 'string', description: 'Event timestamp (epoch ms)', required: true },
          { name: 'UserName', type: 'string', description: 'User name', required: false },
          { name: 'event_platform', type: 'string', description: 'Platform (Win/Mac/Lin)', required: false },
        ],
      },
      {
        id: 'secondary_data',
        name: 'Secondary_Data',
        description: 'Host metadata, OS version, system capacity',
        destTable: 'CrowdStrike_Secondary_Data_CL',
        sourceFormat: 'json',
        sourcetypePattern: 'crowdstrike:fdr:secondary',
        timestampField: 'AgentLocalTime',
        fields: [
          { name: 'ComputerName', type: 'string', description: 'Computer name', required: false },
          { name: 'AgentVersion', type: 'string', description: 'Falcon agent version', required: false },
          { name: 'SystemManufacturer', type: 'string', description: 'System manufacturer', required: false },
          { name: 'SystemProductName', type: 'string', description: 'System product name', required: false },
          { name: 'City', type: 'string', description: 'Host city', required: false },
          { name: 'Country', type: 'string', description: 'Host country', required: false },
        ],
      },
    ],
  },
  {
    vendor: 'paloalto',
    displayName: 'Palo Alto Networks',
    description: 'Palo Alto NGFW traffic, threat, URL filtering, and system logs via syslog',
    sourceType: 'syslog',
    sourcePreset: 'paloalto',
    documentationUrl: 'https://docs.paloaltonetworks.com/pan-os/11-0/pan-os-admin/monitoring/use-syslog-for-monitoring/syslog-field-descriptions',
    schemas: [
      {
        url: 'https://raw.githubusercontent.com/Azure/Azure-Sentinel/master/Solutions/PaloAlto-PAN-OS/Data%20Connectors/PaloAltoNetworks.json',
        parser: 'sentinel_connector',
      },
    ],
    staticLogTypes: [
      {
        id: 'traffic',
        name: 'Traffic Logs',
        description: 'Palo Alto firewall traffic session logs (PAN-OS syslog/CSV format)',
        sourceFormat: 'csv',
        sourcetypePattern: 'pan:traffic',
        timestampField: 'receive_time',
        destTable: 'CommonSecurityLog',
        // PAN-OS traffic logs arrive as CSV fields in syslog. These are the SOURCE field names.
        fieldMappings: [
          { sourceName: 'receive_time', sourceType: 'string', destName: 'TimeGenerated', destType: 'datetime', action: 'map', description: 'Syslog receive time to TimeGenerated' },
          { sourceName: 'src', sourceType: 'string', destName: 'SourceIP', destType: 'string', action: 'map', description: 'Source address' },
          { sourceName: 'dst', sourceType: 'string', destName: 'DestinationIP', destType: 'string', action: 'map', description: 'Destination address' },
          { sourceName: 'sport', sourceType: 'string', destName: 'SourcePort', destType: 'int', action: 'map', description: 'Source port' },
          { sourceName: 'dport', sourceType: 'string', destName: 'DestinationPort', destType: 'int', action: 'map', description: 'Destination port' },
          { sourceName: 'proto', sourceType: 'string', destName: 'Protocol', destType: 'string', action: 'map', description: 'Protocol number/name' },
          { sourceName: 'action', sourceType: 'string', destName: 'DeviceAction', destType: 'string', action: 'map', description: 'allow, deny, drop, reset' },
          { sourceName: 'app', sourceType: 'string', destName: 'ApplicationProtocol', destType: 'string', action: 'map', description: 'Application identified by App-ID' },
          { sourceName: 'rule', sourceType: 'string', destName: 'DeviceCustomString1', destType: 'string', action: 'map', description: 'Security rule name' },
          { sourceName: 'from', sourceType: 'string', destName: 'SourceZone', destType: 'string', action: 'map', description: 'Source security zone' },
          { sourceName: 'to', sourceType: 'string', destName: 'DestinationZone', destType: 'string', action: 'map', description: 'Destination security zone' },
          { sourceName: 'srcuser', sourceType: 'string', destName: 'SourceUserName', destType: 'string', action: 'map', description: 'Source user' },
          { sourceName: 'dstuser', sourceType: 'string', destName: 'DestinationUserName', destType: 'string', action: 'map', description: 'Destination user' },
          { sourceName: 'bytes_sent', sourceType: 'string', destName: 'SentBytes', destType: 'long', action: 'map', description: 'Bytes sent' },
          { sourceName: 'bytes_received', sourceType: 'string', destName: 'ReceivedBytes', destType: 'long', action: 'map', description: 'Bytes received' },
          { sourceName: 'elapsed', sourceType: 'string', destName: 'Duration', destType: 'int', action: 'map', description: 'Session duration' },
          { sourceName: 'serial', sourceType: 'string', destName: 'DeviceName', destType: 'string', action: 'map', description: 'Firewall serial number' },
          { sourceName: 'subtype', sourceType: 'string', destName: 'Activity', destType: 'string', action: 'map', description: 'Log subtype (start, end, drop, deny)' },
          { sourceName: 'severity', sourceType: 'string', destName: 'LogSeverity', destType: 'string', action: 'map', description: 'Log severity' },
        ],
        fields: [
          // SOURCE fields: what actually arrives in PAN-OS syslog
          { name: 'receive_time', type: 'string', description: 'Time the log was received by the firewall', required: true },
          { name: 'serial', type: 'string', description: 'Firewall serial number', required: true },
          { name: 'type', type: 'string', description: 'Log type (TRAFFIC)', required: true },
          { name: 'subtype', type: 'string', description: 'Log subtype (start, end, drop, deny)', required: true },
          { name: 'src', type: 'string', description: 'Source IP address', required: true },
          { name: 'dst', type: 'string', description: 'Destination IP address', required: true },
          { name: 'natsrc', type: 'string', description: 'NAT source IP', required: false },
          { name: 'natdst', type: 'string', description: 'NAT destination IP', required: false },
          { name: 'rule', type: 'string', description: 'Security rule name that matched', required: false },
          { name: 'srcuser', type: 'string', description: 'Source user', required: false },
          { name: 'dstuser', type: 'string', description: 'Destination user', required: false },
          { name: 'app', type: 'string', description: 'Application identified by App-ID', required: false },
          { name: 'from', type: 'string', description: 'Source zone', required: false },
          { name: 'to', type: 'string', description: 'Destination zone', required: false },
          { name: 'sport', type: 'string', description: 'Source port', required: false },
          { name: 'dport', type: 'string', description: 'Destination port', required: true },
          { name: 'proto', type: 'string', description: 'IP protocol (tcp, udp, icmp)', required: false },
          { name: 'action', type: 'string', description: 'Action taken (allow, deny, drop, reset-both)', required: true },
          { name: 'bytes_sent', type: 'string', description: 'Bytes sent from client to server', required: false },
          { name: 'bytes_received', type: 'string', description: 'Bytes sent from server to client', required: false },
          { name: 'packets_sent', type: 'string', description: 'Packets client to server', required: false },
          { name: 'packets_received', type: 'string', description: 'Packets server to client', required: false },
          { name: 'elapsed', type: 'string', description: 'Session duration in seconds', required: false },
          { name: 'category', type: 'string', description: 'URL category', required: false },
          { name: 'severity', type: 'string', description: 'Severity (informational, low, medium, high, critical)', required: false },
          { name: 'sessionid', type: 'string', description: 'Session ID', required: false },
          { name: 'repeatcnt', type: 'string', description: 'Repeat count', required: false },
          { name: 'device_name', type: 'string', description: 'Firewall hostname', required: false },
          { name: 'vsys', type: 'string', description: 'Virtual system name', required: false },
          { name: 'inbound_if', type: 'string', description: 'Ingress interface', required: false },
          { name: 'outbound_if', type: 'string', description: 'Egress interface', required: false },
        ],
      },
      {
        id: 'threat',
        name: 'Threat Logs',
        description: 'Palo Alto firewall threat/IPS/AV/URL filtering logs (PAN-OS syslog)',
        sourceFormat: 'csv',
        sourcetypePattern: 'pan:threat',
        timestampField: 'receive_time',
        destTable: 'CommonSecurityLog',
        fieldMappings: [
          { sourceName: 'receive_time', sourceType: 'string', destName: 'TimeGenerated', destType: 'datetime', action: 'map', description: 'Timestamp' },
          { sourceName: 'src', sourceType: 'string', destName: 'SourceIP', destType: 'string', action: 'map', description: 'Source address' },
          { sourceName: 'dst', sourceType: 'string', destName: 'DestinationIP', destType: 'string', action: 'map', description: 'Destination address' },
          { sourceName: 'dport', sourceType: 'string', destName: 'DestinationPort', destType: 'int', action: 'map', description: 'Destination port' },
          { sourceName: 'action', sourceType: 'string', destName: 'DeviceAction', destType: 'string', action: 'map', description: 'Action taken' },
          { sourceName: 'threatid', sourceType: 'string', destName: 'DeviceEventClassID', destType: 'string', action: 'map', description: 'Threat ID' },
          { sourceName: 'severity', sourceType: 'string', destName: 'LogSeverity', destType: 'string', action: 'map', description: 'Severity' },
          { sourceName: 'misc', sourceType: 'string', destName: 'RequestURL', destType: 'string', action: 'map', description: 'URL or file name' },
          { sourceName: 'srcuser', sourceType: 'string', destName: 'SourceUserName', destType: 'string', action: 'map', description: 'Source user' },
          { sourceName: 'thr_category', sourceType: 'string', destName: 'ThreatCategory', destType: 'string', action: 'map', description: 'Threat category' },
        ],
        fields: [
          // SOURCE fields: PAN-OS native syslog field names
          { name: 'receive_time', type: 'string', description: 'Time log was received', required: true },
          { name: 'serial', type: 'string', description: 'Firewall serial number', required: true },
          { name: 'type', type: 'string', description: 'Log type (THREAT)', required: true },
          { name: 'subtype', type: 'string', description: 'Subtype (virus, spyware, vulnerability, url, wildfire)', required: true },
          { name: 'src', type: 'string', description: 'Source IP', required: true },
          { name: 'dst', type: 'string', description: 'Destination IP', required: true },
          { name: 'sport', type: 'string', description: 'Source port', required: false },
          { name: 'dport', type: 'string', description: 'Destination port', required: true },
          { name: 'proto', type: 'string', description: 'Protocol', required: false },
          { name: 'action', type: 'string', description: 'Action (alert, allow, deny, drop, reset)', required: true },
          { name: 'misc', type: 'string', description: 'URL or file name for threat', required: false },
          { name: 'threatid', type: 'string', description: 'Threat ID / signature ID', required: true },
          { name: 'severity', type: 'string', description: 'Severity level', required: true },
          { name: 'direction', type: 'string', description: 'Direction (client-to-server, server-to-client)', required: false },
          { name: 'srcuser', type: 'string', description: 'Source user', required: false },
          { name: 'app', type: 'string', description: 'Application identified', required: false },
          { name: 'from', type: 'string', description: 'Source zone', required: false },
          { name: 'to', type: 'string', description: 'Destination zone', required: false },
          { name: 'rule', type: 'string', description: 'Security rule name', required: false },
          { name: 'thr_category', type: 'string', description: 'Threat category', required: false },
          { name: 'device_name', type: 'string', description: 'Firewall hostname', required: false },
          { name: 'filedigest', type: 'string', description: 'File hash (SHA256)', required: false },
          { name: 'cloud', type: 'string', description: 'WildFire cloud URL', required: false },
        ],
      },
    ],
  },
  {
    vendor: 'okta',
    displayName: 'Okta',
    description: 'Okta identity and access management system log events',
    sourceType: 'rest_collector',
    sourcePreset: 'okta',
    documentationUrl: 'https://developer.okta.com/docs/reference/api/system-log/',
    schemas: [
      {
        url: 'https://raw.githubusercontent.com/Azure/Azure-Sentinel/master/Solutions/Okta%20Single%20Sign-On/Data%20Connectors/OktaNativePollerConnector.json',
        parser: 'sentinel_connector',
      },
    ],
    staticLogTypes: [
      {
        id: 'system_log',
        name: 'System Log',
        description: 'Okta System Log API events (authentication, admin, lifecycle)',
        sourceFormat: 'json',
        timestampField: 'published',
        fields: [
          { name: 'uuid', type: 'string', description: 'Unique event ID', required: true },
          { name: 'published', type: 'datetime', description: 'Event timestamp', required: true },
          { name: 'eventType', type: 'string', description: 'Event type (e.g., user.session.start)', required: true },
          { name: 'severity', type: 'string', description: 'Severity (DEBUG, INFO, WARN, ERROR)', required: true },
          { name: 'displayMessage', type: 'string', description: 'Human-readable event description', required: false },
          { name: 'outcome', type: 'dynamic', description: 'Outcome object (result, reason)', required: false },
          { name: 'actor', type: 'dynamic', description: 'Actor who performed the action', required: false },
          { name: 'target', type: 'dynamic', description: 'Target(s) of the action', required: false },
          { name: 'client', type: 'dynamic', description: 'Client context (IP, user agent, geo)', required: false },
          { name: 'authenticationContext', type: 'dynamic', description: 'Authentication context', required: false },
          { name: 'securityContext', type: 'dynamic', description: 'Security context (threat indicators)', required: false },
          { name: 'debugContext', type: 'dynamic', description: 'Debug context with additional details', required: false },
          { name: 'transaction', type: 'dynamic', description: 'Transaction context', required: false },
          { name: 'request', type: 'dynamic', description: 'Request details (IP chain)', required: false },
        ],
      },
    ],
  },
  {
    vendor: 'fortinet',
    displayName: 'Fortinet FortiGate',
    description: 'FortiGate NGFW traffic, UTM, event, and system logs via syslog',
    sourceType: 'syslog',
    sourcePreset: 'fortinet',
    documentationUrl: 'https://docs.fortinet.com/document/fortigate/7.4.0/fortios-log-message-reference',
    schemas: [
      {
        url: 'https://raw.githubusercontent.com/Azure/Azure-Sentinel/master/Solutions/Fortinet%20FortiGate/Data%20Connectors/Connector_Fortinet.json',
        parser: 'sentinel_connector',
      },
    ],
    staticLogTypes: [
      {
        id: 'traffic',
        name: 'Traffic Logs',
        description: 'FortiGate firewall session logs (key=value syslog)',
        sourceFormat: 'kv',
        sourcetypePattern: 'fgt_traffic',
        timestampField: 'date',
        fields: [
          { name: 'srcip', type: 'string', description: 'Source IP', required: true },
          { name: 'dstip', type: 'string', description: 'Destination IP', required: true },
          { name: 'srcport', type: 'int', description: 'Source port', required: false },
          { name: 'dstport', type: 'int', description: 'Destination port', required: true },
          { name: 'action', type: 'string', description: 'Action (accept, deny, close, etc.)', required: true },
          { name: 'proto', type: 'int', description: 'Protocol number', required: false },
          { name: 'service', type: 'string', description: 'Service name', required: false },
          { name: 'policyid', type: 'int', description: 'Policy ID', required: false },
          { name: 'sentbyte', type: 'long', description: 'Bytes sent', required: false },
          { name: 'rcvdbyte', type: 'long', description: 'Bytes received', required: false },
          { name: 'duration', type: 'int', description: 'Session duration (seconds)', required: false },
          { name: 'srcintf', type: 'string', description: 'Source interface', required: false },
          { name: 'dstintf', type: 'string', description: 'Destination interface', required: false },
          { name: 'user', type: 'string', description: 'Authenticated user', required: false },
          { name: 'app', type: 'string', description: 'Application name', required: false },
          { name: 'appcat', type: 'string', description: 'Application category', required: false },
        ],
      },
      {
        id: 'utm',
        name: 'UTM Logs',
        description: 'FortiGate UTM security events (IPS, AV, web filter, DLP) (key=value syslog)',
        sourceFormat: 'kv',
        sourcetypePattern: 'fgt_utm',
        timestampField: 'date',
        fields: [
          { name: 'type', type: 'string', description: 'Log type (utm)', required: true },
          { name: 'subtype', type: 'string', description: 'UTM subtype (ips, virus, webfilter, dlp, etc.)', required: true },
          { name: 'action', type: 'string', description: 'Action taken', required: true },
          { name: 'srcip', type: 'string', description: 'Source IP', required: true },
          { name: 'dstip', type: 'string', description: 'Destination IP', required: true },
          { name: 'attack', type: 'string', description: 'Attack name/signature', required: false },
          { name: 'severity', type: 'string', description: 'Severity level', required: false },
          { name: 'url', type: 'string', description: 'URL involved', required: false },
          { name: 'msg', type: 'string', description: 'Log message', required: false },
          { name: 'hostname', type: 'string', description: 'Hostname', required: false },
        ],
      },
    ],
  },
  {
    vendor: 'microsoft_graph',
    displayName: 'Microsoft Graph Security',
    description: 'Microsoft Graph API security alerts, incidents, and sign-in logs',
    sourceType: 'rest_collector',
    sourcePreset: 'microsoft_graph',
    documentationUrl: 'https://learn.microsoft.com/en-us/graph/api/resources/security-api-overview',
    schemas: [],
    staticLogTypes: [
      {
        id: 'sign_in_logs',
        name: 'Sign-In Logs',
        description: 'Azure AD / Entra ID sign-in activity logs',
        sourceFormat: 'json',
        timestampField: 'createdDateTime',
        fields: [
          { name: 'id', type: 'string', description: 'Unique sign-in ID', required: true },
          { name: 'createdDateTime', type: 'datetime', description: 'Sign-in timestamp', required: true },
          { name: 'userDisplayName', type: 'string', description: 'User display name', required: false },
          { name: 'userPrincipalName', type: 'string', description: 'User UPN', required: true },
          { name: 'userId', type: 'string', description: 'User object ID', required: false },
          { name: 'appDisplayName', type: 'string', description: 'Application name', required: false },
          { name: 'appId', type: 'string', description: 'Application ID', required: false },
          { name: 'ipAddress', type: 'string', description: 'Client IP address', required: false },
          { name: 'clientAppUsed', type: 'string', description: 'Client app used', required: false },
          { name: 'conditionalAccessStatus', type: 'string', description: 'Conditional Access result', required: false },
          { name: 'isInteractive', type: 'boolean', description: 'Whether sign-in was interactive', required: false },
          { name: 'riskDetail', type: 'string', description: 'Risk detail', required: false },
          { name: 'riskLevelAggregated', type: 'string', description: 'Aggregated risk level', required: false },
          { name: 'riskState', type: 'string', description: 'Risk state', required: false },
          { name: 'status', type: 'dynamic', description: 'Sign-in status (errorCode, failureReason)', required: false },
          { name: 'location', type: 'dynamic', description: 'Sign-in location (city, state, country)', required: false },
          { name: 'deviceDetail', type: 'dynamic', description: 'Device details (OS, browser, etc.)', required: false },
        ],
      },
      {
        id: 'security_alerts',
        name: 'Security Alerts',
        description: 'Microsoft 365 Defender security alerts',
        sourceFormat: 'json',
        timestampField: 'createdDateTime',
        fields: [
          { name: 'id', type: 'string', description: 'Alert ID', required: true },
          { name: 'title', type: 'string', description: 'Alert title', required: true },
          { name: 'description', type: 'string', description: 'Alert description', required: false },
          { name: 'severity', type: 'string', description: 'Alert severity', required: true },
          { name: 'status', type: 'string', description: 'Alert status', required: false },
          { name: 'category', type: 'string', description: 'Alert category', required: false },
          { name: 'createdDateTime', type: 'datetime', description: 'Alert creation time', required: true },
          { name: 'lastUpdateDateTime', type: 'datetime', description: 'Last update time', required: false },
          { name: 'assignedTo', type: 'string', description: 'Assigned analyst', required: false },
          { name: 'classification', type: 'string', description: 'Alert classification', required: false },
          { name: 'determination', type: 'string', description: 'Alert determination', required: false },
          { name: 'detectionSource', type: 'string', description: 'Detection source', required: false },
          { name: 'serviceSource', type: 'string', description: 'Service source', required: false },
          { name: 'evidence', type: 'dynamic', description: 'Alert evidence collection', required: false },
          { name: 'mitreTechniques', type: 'dynamic', description: 'MITRE ATT&CK techniques', required: false },
        ],
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Research Engine
// ---------------------------------------------------------------------------

async function researchVendor(entry: VendorRegistryEntry): Promise<VendorResearchResult> {
  const logTypes: VendorLogType[] = [];

  // Try fetching each schema source
  for (const schema of entry.schemas) {
    try {
      const raw = await httpsFetch(schema.url);
      const parsed = JSON.parse(raw);

      let fetched: VendorLogType[] = [];
      switch (schema.parser) {
        case 'openapi':
          fetched = parseOpenApiSpec(parsed, schema.hints || {});
          break;
        case 'sentinel_connector':
          fetched = parseSentinelConnector(parsed);
          break;
        case 'json_schema':
          fetched = parseJsonSchema(parsed);
          break;
      }

      // Merge fetched log types (avoid duplicates by id)
      for (const lt of fetched) {
        if (!logTypes.some((existing) => existing.id === lt.id)) {
          logTypes.push(lt);
        }
      }
    } catch {
      // Fetch or parse failed -- will fall back to static
    }
  }

  // If remote fetch produced no results (or fewer than static), merge with static fallback
  if (entry.staticLogTypes) {
    for (const staticLt of entry.staticLogTypes) {
      const existing = logTypes.find((lt) => lt.id === staticLt.id);
      if (!existing) {
        // Not fetched at all -- use static
        logTypes.push(staticLt);
      } else if (existing.fields.length < staticLt.fields.length) {
        // Fetched version has fewer fields -- augment with static
        const existingNames = new Set(existing.fields.map((f) => f.name));
        for (const field of staticLt.fields) {
          if (!existingNames.has(field.name)) {
            existing.fields.push(field);
          }
        }
        // Copy over sourcetypePattern and timestampField if missing
        if (!existing.sourcetypePattern && staticLt.sourcetypePattern) {
          existing.sourcetypePattern = staticLt.sourcetypePattern;
        }
        if (!existing.timestampField && staticLt.timestampField) {
          existing.timestampField = staticLt.timestampField;
        }
      }
    }
  }

  return {
    vendor: entry.vendor,
    displayName: entry.displayName,
    description: entry.description,
    logTypes,
    sourceType: entry.sourceType,
    sourcePreset: entry.sourcePreset,
    documentationUrl: entry.documentationUrl,
    fetchedAt: Date.now(),
    fromCache: false,
  };
}

// Convert a dynamic registry entry (from GitHub scan) into a VendorResearchResult.
function dynamicEntryToResult(dynEntry: DynamicRegistryEntry): VendorResearchResult {
  return {
    vendor: dynEntry.vendor,
    displayName: dynEntry.displayName,
    description: `${dynEntry.displayName} - discovered from Sentinel Content Hub (${dynEntry.logTypes.length} log types)`,
    logTypes: dynEntry.logTypes.map((lt) => ({
      id: lt.id,
      name: lt.name,
      description: lt.description,
      fields: lt.fields.map((f) => ({
        name: f.name,
        type: f.type,
        description: f.description,
        required: false,
      })),
    })),
    sourceType: 'rest_collector', // Default; user can change
    documentationUrl: `https://github.com/Azure/Azure-Sentinel/tree/master/${dynEntry.solutionPath}`,
    fetchedAt: dynEntry.lastSynced,
    fromCache: true,
  };
}

// Public entry point: research a vendor by name.
// Priority: static vendor cache -> static registry fetch -> dynamic registry from GitHub scan
export async function performVendorResearch(vendorName: string): Promise<VendorResearchResult | null> {
  const lower = vendorName.toLowerCase().replace(/[^a-z0-9]/g, '');

  // 1. Find matching curated static registry entry
  const entry = VENDOR_REGISTRY.find((e) => {
    const entryKey = e.vendor.toLowerCase().replace(/[^a-z0-9]/g, '');
    const entryDisplay = e.displayName.toLowerCase().replace(/[^a-z0-9]/g, '');
    return lower.includes(entryKey) || entryKey.includes(lower) ||
           lower.includes(entryDisplay) || entryDisplay.includes(lower);
  });

  if (entry) {
    // Check cache
    const cached = readCache(entry.vendor);
    if (cached) return cached;

    // Fetch and cache
    const result = await researchVendor(entry);
    writeCache(result);
    return result;
  }

  // 2. No static entry -- check the dynamic registry (populated by GitHub scan)
  const dynEntry = lookupDynamicEntry(vendorName);
  if (dynEntry && dynEntry.logTypes.length > 0) {
    return dynamicEntryToResult(dynEntry);
  }

  // 3. Auto-resolve from local Sentinel repo DCR/connector JSON files
  try {
    const autoResult = await resolveFromSentinelRepo(vendorName);
    if (autoResult) return autoResult;
  } catch { /* non-fatal */ }

  return null;
}

// ---------------------------------------------------------------------------
// Sentinel Repo Auto-Resolver
// ---------------------------------------------------------------------------
// Reads the local Azure-Sentinel clone to automatically extract table names,
// column schemas, and routing rules from DCR JSON and table definition files.
// This eliminates the need for manual vendor registry entries.

async function resolveFromSentinelRepo(solutionName: string): Promise<VendorResearchResult | null> {
  let sentinelRepo: typeof import('./sentinel-repo') | null = null;
  try { sentinelRepo = await import('./sentinel-repo'); } catch { return null; }
  if (!sentinelRepo.isRepoReady()) return null;

  // Find matching solution directory -- try exact, then fuzzy word overlap
  const solutions = sentinelRepo.listSolutions();
  const lower = solutionName.toLowerCase().replace(/[^a-z0-9]/g, '');
  const lowerWords = solutionName.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/).filter(Boolean);

  let match = solutions.find((s) => {
    const solKey = s.name.toLowerCase().replace(/[^a-z0-9]/g, '');
    return solKey === lower || solKey.includes(lower) || lower.includes(solKey);
  });
  // Fuzzy: find solution where all query words appear in the solution name
  if (!match && lowerWords.length > 0) {
    match = solutions.find((s) => {
      const solLower = s.name.toLowerCase();
      return lowerWords.every((w) => solLower.includes(w));
    });
  }
  // Partial: find solution that shares the longest common substring
  if (!match) {
    match = solutions.find((s) => {
      const solKey = s.name.toLowerCase().replace(/[^a-z0-9]/g, '');
      // Check if any 6+ char substring matches
      for (let len = Math.min(lower.length, solKey.length); len >= 6; len--) {
        for (let i = 0; i <= lower.length - len; i++) {
          if (solKey.includes(lower.substring(i, i + len))) return true;
        }
      }
      return false;
    });
  }
  if (!match) return null;

  // Find Data Connectors directory
  const connDir = sentinelRepo.findDataConnectorsDir(match.name);
  if (!connDir) return null;

  // Read all JSON files in the Data Connectors tree
  const connectorFiles = sentinelRepo.listConnectorFiles(match.name);
  if (connectorFiles.length === 0) return null;

  const logTypes: VendorLogType[] = [];
  const tablesFound = new Set<string>();

  for (const file of connectorFiles) {
    const content = sentinelRepo.readRepoFile(file.path);
    if (!content) continue;

    let parsed: any;
    try { parsed = JSON.parse(content); } catch { continue; }

    // Extract tables from DCR JSON (dataFlows[].outputStream or streams[])
    if (parsed.properties?.dataFlows || parsed.dataFlows) {
      const dataFlows = parsed.properties?.dataFlows || parsed.dataFlows || [];
      for (const flow of dataFlows) {
        const stream = flow.outputStream || '';
        const tableName = stream.replace(/^Custom-/, '');
        if (!tableName || tablesFound.has(tableName)) continue;
        tablesFound.add(tableName);

        // Extract columns from transformKql or the table schema
        const columns: VendorField[] = [];
        const kql = flow.transformKql || '';

        // Extract event_simpleName routing from KQL "where event_simpleName in (...)"
        const eventNamesMatch = kql.match(/event_simpleName\s+in\s*\(\s*'([^)]+)'\s*\)/);
        let sourcetypeHint = '';
        if (eventNamesMatch) {
          const names = eventNamesMatch[1].split("','").map((n: string) => n.trim().replace(/'/g, ''));
          sourcetypeHint = names.slice(0, 3).join(', ') + (names.length > 3 ? '...' : '');
        }

        // Extract column names from project-rename and extend statements
        const renameMatches = kql.matchAll(/(\w+)\s*=\s*\[?'?(\w+)'?\]?/g);
        for (const m of renameMatches) {
          if (m[1] && !['source', 'iff', 'isnotempty', 'now', 'todatetime', 'tolong', 'todouble', 'toint', 'tobool', 'todynamic'].includes(m[1])) {
            columns.push({ name: m[1], type: 'string', description: '', required: false });
          }
        }

        // Derive a friendly log type name from table name
        // CrowdStrike_Process_Events_CL -> Process_Events
        const logTypeName = tableName
          .replace(/_CL$/, '')
          .replace(/^[A-Za-z]+_/, ''); // Remove vendor prefix

        logTypes.push({
          id: tableName.toLowerCase().replace(/[^a-z0-9]/g, '_'),
          name: logTypeName || tableName,
          description: `Events routed to ${tableName}${sourcetypeHint ? ` (${sourcetypeHint})` : ''}`,
          destTable: tableName,
          sourceFormat: 'json',
          sourcetypePattern: sourcetypeHint ? undefined : undefined,
          timestampField: 'timestamp',
          fields: columns.length > 0 ? columns : [
            { name: 'event_simpleName', type: 'string', description: 'Event type', required: true },
            { name: 'aid', type: 'string', description: 'Agent ID', required: true },
            { name: 'timestamp', type: 'string', description: 'Event timestamp', required: true },
          ],
        });
      }
    }

    // Extract tables from old-style connector JSON (dataTypes / lastDataReceivedQuery)
    if (parsed.dataTypes && Array.isArray(parsed.dataTypes)) {
      for (const dt of parsed.dataTypes) {
        const tableName = dt.name;
        if (!tableName || tablesFound.has(tableName)) continue;
        tablesFound.add(tableName);
        logTypes.push({
          id: tableName.toLowerCase().replace(/[^a-z0-9]/g, '_'),
          name: tableName,
          description: `Events ingested to ${tableName}`,
          destTable: tableName,
          sourceFormat: 'json',
          timestampField: 'TimeGenerated',
          fields: [
            { name: 'TimeGenerated', type: 'datetime', description: 'Event time', required: true },
          ],
        });
      }
    }

    // Extract tables from table definition files (*_CL.json)
    if (file.name.endsWith('_CL.json') && parsed.properties?.schema?.tableDefinition?.columns) {
      const tableName = file.name.replace('.json', '');
      if (tablesFound.has(tableName)) {
        // Update existing logType with proper column schema
        const existing = logTypes.find((lt) => lt.destTable === tableName);
        if (existing) {
          existing.fields = parsed.properties.schema.tableDefinition.columns.map((col: any) => ({
            name: col.name,
            type: col.type || 'string',
            description: col.description || '',
            required: col.name === 'TimeGenerated',
          }));
        }
      } else {
        tablesFound.add(tableName);
        const logTypeName = tableName.replace(/_CL$/, '').replace(/^[A-Za-z]+_/, '');
        logTypes.push({
          id: tableName.toLowerCase().replace(/[^a-z0-9]/g, '_'),
          name: logTypeName || tableName,
          description: `Custom table ${tableName}`,
          destTable: tableName,
          sourceFormat: 'json',
          timestampField: 'TimeGenerated',
          fields: parsed.properties.schema.tableDefinition.columns.map((col: any) => ({
            name: col.name,
            type: col.type || 'string',
            description: col.description || '',
            required: col.name === 'TimeGenerated',
          })),
        });
      }
    }
  }

  // Enrich with KQL-parsed routing and schema data
  try {
    const { getTableRoutingForSolution } = await import('./kql-parser');
    const routing = await getTableRoutingForSolution(match.name);
    if (routing.length > 0) {
      for (const route of routing) {
        const existing = logTypes.find((lt) =>
          lt.destTable?.toLowerCase() === route.tableName.toLowerCase()
        );
        if (existing) {
          // Enrich existing logType with KQL-derived data
          if (route.columns.length > existing.fields.length) {
            existing.fields = route.columns.map((c) => ({
              name: c.name, type: c.type, description: '', required: c.name === 'TimeGenerated',
            }));
          }
        } else if (route.tableName) {
          // Add new logType from KQL routing
          const logTypeName = route.tableName.replace(/_CL$/, '').replace(/^[A-Za-z]+_/, '');
          logTypes.push({
            id: route.tableName.toLowerCase().replace(/[^a-z0-9]/g, '_'),
            name: logTypeName || route.tableName,
            description: `Events routed to ${route.tableName} (${route.eventSimpleNames.length} event types)`,
            destTable: route.tableName,
            sourceFormat: 'json',
            timestampField: 'timestamp',
            fields: route.columns.map((c) => ({
              name: c.name, type: c.type, description: '', required: c.name === 'TimeGenerated',
            })),
          });
          tablesFound.add(route.tableName);
        }
      }
    }
  } catch { /* KQL parsing is non-fatal */ }

  if (logTypes.length === 0) return null;

  return {
    vendor: match.name.toLowerCase().replace(/[^a-z0-9]/g, '_'),
    displayName: match.name,
    description: `Auto-resolved from Sentinel Content Hub: ${logTypes.length} table(s)`,
    logTypes,
    sourceType: 'rest_collector',
    documentationUrl: `https://github.com/Azure/Azure-Sentinel/tree/master/${match.path}`,
    fetchedAt: Date.now(),
    fromCache: false,
  };
}

// List all vendors in the registry (for UI dropdown)
export function listRegisteredVendors(): Array<{
  vendor: string;
  displayName: string;
  description: string;
  sourceType: string;
}> {
  return VENDOR_REGISTRY.map((e) => ({
    vendor: e.vendor,
    displayName: e.displayName,
    description: e.description,
    sourceType: e.sourceType,
  }));
}

// ---------------------------------------------------------------------------
// IPC Handlers
// ---------------------------------------------------------------------------

export function registerVendorResearchHandlers(ipcMain: IpcMain) {
  // List all registered vendors
  ipcMain.handle('vendor:list', async () => {
    return listRegisteredVendors();
  });

  // Perform research on a vendor -- returns full schema data
  ipcMain.handle('vendor:research', async (_event, { vendorName }: { vendorName: string }) => {
    return performVendorResearch(vendorName);
  });

  // Clear vendor cache (force re-fetch)
  ipcMain.handle('vendor:clear-cache', async (_event, { vendorName }: { vendorName: string }) => {
    const cachePath = getCachePath(vendorName);
    if (fs.existsSync(cachePath)) {
      fs.unlinkSync(cachePath);
    }
  });
}
