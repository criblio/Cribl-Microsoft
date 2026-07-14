// Source Type Knowledge Base
// Defines Cribl Stream input/source configurations for each collection method.
// Each source type includes required fields, optional fields, default values,
// and vendor-specific presets so the pack builder can generate a complete
// inputs.yml with minimal user input.

export interface SourceField {
  name: string;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'select' | 'password' | 'multiline';
  required: boolean;
  default?: string | number | boolean;
  placeholder?: string;
  description: string;
  options?: Array<{ value: string; label: string }>;
  group?: string;  // UI grouping (e.g., "Connection", "Authentication", "Advanced")
}

export interface DiscoveryConfig {
  enabled: boolean;
  description: string;
  fields: SourceField[];
}

export interface SourceTypeDefinition {
  id: string;
  name: string;
  description: string;
  criblType: string;  // The Cribl Stream input type identifier
  category: 'push' | 'pull' | 'stream';
  fields: SourceField[];
  discovery?: DiscoveryConfig;
  // Static YAML properties that are always included
  staticConfig: Record<string, unknown>;
  // Vendor presets: pre-filled configurations for known vendors
  vendorPresets?: Record<string, VendorPreset>;
}

export interface VendorPreset {
  label: string;
  description: string;
  fieldDefaults: Record<string, string | number | boolean>;
  discoveryDefaults?: Record<string, string | number | boolean>;
}

export interface SourceConfig {
  sourceType: string;        // ID from SourceTypeDefinition
  vendorPreset?: string;     // Optional vendor preset key
  fields: Record<string, string | number | boolean>;
  discoveryFields?: Record<string, string | number | boolean>;
}

// ---------------------------------------------------------------------------
// Source Type: Syslog (TCP/UDP)
// ---------------------------------------------------------------------------

const syslog: SourceTypeDefinition = {
  id: 'syslog',
  name: 'Syslog',
  description: 'Receive syslog messages over TCP or UDP. Simplest source type -- just configure port and protocol.',
  criblType: 'syslog',
  category: 'push',
  fields: [
    {
      name: 'host',
      label: 'Listen Address',
      type: 'string',
      required: false,
      default: '0.0.0.0',
      description: 'IP address to listen on. 0.0.0.0 listens on all interfaces.',
      group: 'Connection',
    },
    {
      name: 'port',
      label: 'Port',
      type: 'number',
      required: true,
      default: 514,
      description: 'Port to listen on for syslog messages.',
      group: 'Connection',
    },
    {
      name: 'protocol',
      label: 'Protocol',
      type: 'select',
      required: true,
      default: 'tcp',
      description: 'Transport protocol.',
      options: [
        { value: 'tcp', label: 'TCP' },
        { value: 'udp', label: 'UDP' },
        { value: 'tls', label: 'TLS (encrypted TCP)' },
      ],
      group: 'Connection',
    },
    {
      name: 'maxConnections',
      label: 'Max Connections',
      type: 'number',
      required: false,
      default: 1000,
      description: 'Maximum concurrent TCP connections.',
      group: 'Advanced',
    },
    {
      name: 'enableProxyHeader',
      label: 'Enable PROXY Protocol',
      type: 'boolean',
      required: false,
      default: false,
      description: 'Enable HAProxy PROXY protocol to preserve original client IP.',
      group: 'Advanced',
    },
  ],
  staticConfig: {
    disabled: false,
    sendToRoutes: true,
    pqEnabled: false,
  },
  vendorPresets: {
    paloalto: {
      label: 'Palo Alto Networks',
      description: 'Palo Alto firewall syslog (CEF/LEEF format, typically TCP 514)',
      fieldDefaults: { port: 6514, protocol: 'tcp' },
    },
    fortinet: {
      label: 'Fortinet FortiGate',
      description: 'FortiGate syslog (key=value format, typically UDP 514)',
      fieldDefaults: { port: 514, protocol: 'udp' },
    },
    cisco_asa: {
      label: 'Cisco ASA',
      description: 'Cisco ASA syslog (typically UDP 514)',
      fieldDefaults: { port: 514, protocol: 'udp' },
    },
    cef_generic: {
      label: 'Generic CEF Source',
      description: 'Any CEF-format syslog source',
      fieldDefaults: { port: 514, protocol: 'tcp' },
    },
    linux_syslog: {
      label: 'Linux Syslog (rsyslog/syslog-ng)',
      description: 'Linux hosts forwarding syslog via rsyslog or syslog-ng',
      fieldDefaults: { port: 514, protocol: 'tcp' },
    },
  },
};

// ---------------------------------------------------------------------------
// Source Type: REST Collector (Pull-based API)
// ---------------------------------------------------------------------------

const restCollector: SourceTypeDefinition = {
  id: 'rest_collector',
  name: 'REST Collector',
  description: 'Poll a REST API endpoint on a schedule. Supports pagination, authentication, and optional discovery of endpoints.',
  criblType: 'rest',
  category: 'pull',
  fields: [
    {
      name: 'collectUrl',
      label: 'Collection URL',
      type: 'string',
      required: true,
      placeholder: 'https://api.vendor.com/v2/logs',
      description: 'URL to poll for log data. Supports Cribl expressions for dynamic URL construction.',
      group: 'Collection',
    },
    {
      name: 'collectMethod',
      label: 'HTTP Method',
      type: 'select',
      required: true,
      default: 'get',
      description: 'HTTP method for the collection request.',
      options: [
        { value: 'get', label: 'GET' },
        { value: 'post', label: 'POST' },
      ],
      group: 'Collection',
    },
    {
      name: 'collectRequestBody',
      label: 'Request Body',
      type: 'multiline',
      required: false,
      placeholder: '{"query": "...", "startTime": "..."}',
      description: 'Request body for POST requests. Supports Cribl expressions.',
      group: 'Collection',
    },
    {
      name: 'collectRequestHeaders',
      label: 'Request Headers',
      type: 'multiline',
      required: false,
      placeholder: 'Content-Type: application/json',
      description: 'Additional HTTP headers (one per line: Header: Value).',
      group: 'Collection',
    },
    {
      name: 'schedule',
      label: 'Collection Schedule',
      type: 'string',
      required: true,
      default: '*/5 * * * *',
      placeholder: '*/5 * * * *',
      description: 'Cron expression for collection interval (default: every 5 minutes).',
      group: 'Collection',
    },
    {
      name: 'authentication',
      label: 'Authentication Type',
      type: 'select',
      required: true,
      default: 'none',
      description: 'Authentication method for the API.',
      options: [
        { value: 'none', label: 'None' },
        { value: 'basic', label: 'Basic Auth (username/password)' },
        { value: 'token', label: 'Bearer Token' },
        { value: 'oauth', label: 'OAuth 2.0 Client Credentials' },
        { value: 'api_key', label: 'API Key (header)' },
      ],
      group: 'Authentication',
    },
    {
      name: 'username',
      label: 'Username',
      type: 'string',
      required: false,
      description: 'Username for Basic Auth.',
      group: 'Authentication',
    },
    {
      name: 'password',
      label: 'Password / Secret',
      type: 'password',
      required: false,
      description: 'Password, API key, or client secret.',
      group: 'Authentication',
    },
    {
      name: 'token',
      label: 'Bearer Token',
      type: 'password',
      required: false,
      description: 'Bearer token for token-based authentication.',
      group: 'Authentication',
    },
    {
      name: 'oauthTokenUrl',
      label: 'OAuth Token URL',
      type: 'string',
      required: false,
      placeholder: 'https://auth.vendor.com/oauth/token',
      description: 'OAuth 2.0 token endpoint URL.',
      group: 'Authentication',
    },
    {
      name: 'oauthClientId',
      label: 'OAuth Client ID',
      type: 'string',
      required: false,
      description: 'OAuth 2.0 client ID.',
      group: 'Authentication',
    },
    {
      name: 'oauthClientSecret',
      label: 'OAuth Client Secret',
      type: 'password',
      required: false,
      description: 'OAuth 2.0 client secret.',
      group: 'Authentication',
    },
    {
      name: 'oauthScope',
      label: 'OAuth Scope',
      type: 'string',
      required: false,
      description: 'OAuth 2.0 scope(s), space-separated.',
      group: 'Authentication',
    },
    {
      name: 'apiKeyHeader',
      label: 'API Key Header Name',
      type: 'string',
      required: false,
      default: 'X-API-Key',
      description: 'Header name for API key authentication.',
      group: 'Authentication',
    },
    {
      name: 'pagination',
      label: 'Pagination Type',
      type: 'select',
      required: false,
      default: 'none',
      description: 'How the API paginates results.',
      options: [
        { value: 'none', label: 'None (single request)' },
        { value: 'next_url', label: 'Next URL in response' },
        { value: 'offset', label: 'Offset / Limit' },
        { value: 'cursor', label: 'Cursor-based' },
        { value: 'link_header', label: 'Link header (RFC 5988)' },
      ],
      group: 'Pagination',
    },
    {
      name: 'paginationNextField',
      label: 'Next Page Field',
      type: 'string',
      required: false,
      placeholder: 'nextPageToken',
      description: 'JSON field containing the next page URL or cursor value.',
      group: 'Pagination',
    },
    {
      name: 'paginationMaxPages',
      label: 'Max Pages per Collection',
      type: 'number',
      required: false,
      default: 100,
      description: 'Maximum pages to fetch per collection cycle (safety limit).',
      group: 'Pagination',
    },
    {
      name: 'timeout',
      label: 'Request Timeout (sec)',
      type: 'number',
      required: false,
      default: 30,
      description: 'HTTP request timeout in seconds.',
      group: 'Advanced',
    },
    {
      name: 'rejectUnauthorized',
      label: 'Verify TLS Certificate',
      type: 'boolean',
      required: false,
      default: true,
      description: 'Verify the server TLS certificate. Disable for self-signed certs.',
      group: 'Advanced',
    },
  ],
  discovery: {
    enabled: true,
    description: 'Some REST APIs require a discovery phase to enumerate available log types, tenants, or endpoints before collection.',
    fields: [
      {
        name: 'discoverUrl',
        label: 'Discovery URL',
        type: 'string',
        required: false,
        placeholder: 'https://api.vendor.com/v2/log-types',
        description: 'URL that returns a list of available log sources or endpoints.',
        group: 'Discovery',
      },
      {
        name: 'discoverMethod',
        label: 'Discovery HTTP Method',
        type: 'select',
        required: false,
        default: 'get',
        options: [
          { value: 'get', label: 'GET' },
          { value: 'post', label: 'POST' },
        ],
        description: 'HTTP method for the discovery request.',
        group: 'Discovery',
      },
      {
        name: 'discoverRequestBody',
        label: 'Discovery Request Body',
        type: 'multiline',
        required: false,
        description: 'Request body for POST discovery requests.',
        group: 'Discovery',
      },
      {
        name: 'discoverDataField',
        label: 'Discovery Results Field',
        type: 'string',
        required: false,
        placeholder: 'data.items',
        description: 'Dot-notation path to the array of discovered items in the response.',
        group: 'Discovery',
      },
      {
        name: 'discoverItemIdField',
        label: 'Item ID Field',
        type: 'string',
        required: false,
        placeholder: 'id',
        description: 'Field within each discovered item to use as the unique identifier.',
        group: 'Discovery',
      },
    ],
  },
  staticConfig: {
    disabled: false,
    sendToRoutes: true,
    pqEnabled: true,
  },
  vendorPresets: {
    cloudflare: {
      label: 'Cloudflare Logpush (REST)',
      description: 'Cloudflare Logpush API for HTTP, WAF, and DNS logs',
      fieldDefaults: {
        collectUrl: 'https://api.cloudflare.com/client/v4/zones/${zoneId}/logs/received',
        collectMethod: 'get',
        authentication: 'api_key',
        apiKeyHeader: 'Authorization',
        schedule: '*/1 * * * *',
        pagination: 'none',
      },
      discoveryDefaults: {
        discoverUrl: 'https://api.cloudflare.com/client/v4/zones',
        discoverDataField: 'result',
        discoverItemIdField: 'id',
      },
    },
    crowdstrike: {
      label: 'CrowdStrike Falcon',
      description: 'CrowdStrike Falcon SIEM Connector / Event Streams API',
      fieldDefaults: {
        collectUrl: 'https://api.crowdstrike.com/sensors/entities/datafeed/v2',
        collectMethod: 'get',
        authentication: 'oauth',
        oauthTokenUrl: 'https://api.crowdstrike.com/oauth2/token',
        oauthScope: 'read',
        schedule: '*/1 * * * *',
        pagination: 'offset',
      },
      discoveryDefaults: {
        discoverUrl: 'https://api.crowdstrike.com/sensors/entities/datafeed/v2',
        discoverMethod: 'get',
        discoverDataField: 'resources',
        discoverItemIdField: 'feedId',
      },
    },
    microsoft_graph: {
      label: 'Microsoft Graph Security API',
      description: 'Microsoft Graph API for security alerts, incidents, and sign-in logs',
      fieldDefaults: {
        collectUrl: 'https://graph.microsoft.com/v1.0/security/alerts_v2',
        collectMethod: 'get',
        authentication: 'oauth',
        oauthTokenUrl: 'https://login.microsoftonline.com/<TENANT_ID>/oauth2/v2.0/token',
        oauthScope: 'https://graph.microsoft.com/.default',
        schedule: '*/5 * * * *',
        pagination: 'next_url',
        paginationNextField: '@odata.nextLink',
      },
    },
    okta: {
      label: 'Okta System Log',
      description: 'Okta System Log API for authentication and admin events',
      fieldDefaults: {
        collectUrl: 'https://<DOMAIN>.okta.com/api/v1/logs',
        collectMethod: 'get',
        authentication: 'api_key',
        apiKeyHeader: 'Authorization',
        schedule: '*/2 * * * *',
        pagination: 'link_header',
      },
    },
    qualys: {
      label: 'Qualys Vulnerability Management',
      description: 'Qualys API for vulnerability scan results and host detection',
      fieldDefaults: {
        collectUrl: 'https://qualysapi.qualys.com/api/2.0/fo/asset/host/vm/detection/',
        collectMethod: 'post',
        authentication: 'basic',
        schedule: '0 */6 * * *',
        pagination: 'next_url',
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Source Type: HTTP (Push-based webhook/HEC)
// ---------------------------------------------------------------------------

const httpSource: SourceTypeDefinition = {
  id: 'http',
  name: 'HTTP / Webhook',
  description: 'Receive events via HTTP POST. Supports Splunk HEC format, generic JSON, and webhook payloads.',
  criblType: 'http',
  category: 'push',
  fields: [
    {
      name: 'host',
      label: 'Listen Address',
      type: 'string',
      required: false,
      default: '0.0.0.0',
      description: 'IP address to listen on.',
      group: 'Connection',
    },
    {
      name: 'port',
      label: 'Port',
      type: 'number',
      required: true,
      default: 8088,
      description: 'Port to listen on for HTTP events.',
      group: 'Connection',
    },
    {
      name: 'tls',
      label: 'Enable TLS',
      type: 'boolean',
      required: false,
      default: false,
      description: 'Enable TLS encryption.',
      group: 'Connection',
    },
    {
      name: 'authType',
      label: 'Authentication',
      type: 'select',
      required: false,
      default: 'none',
      description: 'Authentication method for incoming requests.',
      options: [
        { value: 'none', label: 'None' },
        { value: 'token', label: 'Auth Token (Splunk HEC style)' },
        { value: 'basic', label: 'Basic Auth' },
      ],
      group: 'Authentication',
    },
    {
      name: 'authToken',
      label: 'Auth Token',
      type: 'password',
      required: false,
      description: 'Token for Splunk HEC-style auth (Authorization: Splunk <token>).',
      group: 'Authentication',
    },
    {
      name: 'maxActiveReq',
      label: 'Max Active Requests',
      type: 'number',
      required: false,
      default: 256,
      description: 'Maximum concurrent active requests.',
      group: 'Advanced',
    },
    {
      name: 'activityLogSampleRate',
      label: 'Activity Log Sample Rate',
      type: 'number',
      required: false,
      default: 100,
      description: 'Sample 1 in N requests for activity logging.',
      group: 'Advanced',
    },
  ],
  staticConfig: {
    disabled: false,
    sendToRoutes: true,
    pqEnabled: false,
  },
  vendorPresets: {
    splunk_hec: {
      label: 'Splunk HEC Compatible',
      description: 'Accept events from Splunk Universal Forwarders or HEC-compatible senders',
      fieldDefaults: { port: 8088, authType: 'token' },
    },
    generic_webhook: {
      label: 'Generic Webhook',
      description: 'Receive webhooks from any service (GitHub, PagerDuty, etc.)',
      fieldDefaults: { port: 8080, authType: 'none' },
    },
  },
};

// ---------------------------------------------------------------------------
// Source Type: Azure Event Hub
// ---------------------------------------------------------------------------

const azureEventHub: SourceTypeDefinition = {
  id: 'azure_event_hub',
  name: 'Azure Event Hub',
  description: 'Consume events from Azure Event Hubs. Used for Azure Activity Logs, Diagnostic Logs, and any Azure service that exports to Event Hub.',
  criblType: 'azure_event_hub',
  category: 'stream',
  fields: [
    {
      name: 'connectionString',
      label: 'Event Hub Connection String',
      type: 'password',
      required: true,
      placeholder: 'Endpoint=sb://<namespace>.servicebus.windows.net/;SharedAccessKeyName=...',
      description: 'Event Hub namespace connection string with Listen permission.',
      group: 'Connection',
    },
    {
      name: 'eventHubName',
      label: 'Event Hub Name',
      type: 'string',
      required: true,
      placeholder: 'insights-logs-audit',
      description: 'Name of the specific Event Hub to consume from.',
      group: 'Connection',
    },
    {
      name: 'consumerGroup',
      label: 'Consumer Group',
      type: 'string',
      required: false,
      default: '$Default',
      description: 'Event Hub consumer group. Use a dedicated group for Cribl to avoid conflicts.',
      group: 'Connection',
    },
    {
      name: 'storageAccountConnectionString',
      label: 'Storage Account Connection String',
      type: 'password',
      required: false,
      placeholder: 'DefaultEndpointsProtocol=https;AccountName=...;AccountKey=...',
      description: 'Azure Storage account for checkpointing (tracking read position).',
      group: 'Checkpoint',
    },
    {
      name: 'storageContainerName',
      label: 'Checkpoint Container Name',
      type: 'string',
      required: false,
      default: 'cribl-checkpoints',
      description: 'Blob container name for storing checkpoint data.',
      group: 'Checkpoint',
    },
    {
      name: 'initialOffset',
      label: 'Initial Offset',
      type: 'select',
      required: false,
      default: 'latest',
      description: 'Where to start reading if no checkpoint exists.',
      options: [
        { value: 'latest', label: 'Latest (new events only)' },
        { value: 'earliest', label: 'Earliest (all available events)' },
      ],
      group: 'Advanced',
    },
    {
      name: 'maxBatchSize',
      label: 'Max Batch Size',
      type: 'number',
      required: false,
      default: 300,
      description: 'Maximum events per batch.',
      group: 'Advanced',
    },
  ],
  staticConfig: {
    disabled: false,
    sendToRoutes: true,
    pqEnabled: true,
  },
  vendorPresets: {
    azure_activity: {
      label: 'Azure Activity Logs',
      description: 'Azure subscription activity logs via Event Hub',
      fieldDefaults: { eventHubName: 'insights-activity-logs', consumerGroup: 'cribl' },
    },
    azure_ad: {
      label: 'Azure AD / Entra ID Logs',
      description: 'Azure AD sign-in and audit logs via Event Hub',
      fieldDefaults: { eventHubName: 'insights-logs-auditlogs', consumerGroup: 'cribl' },
    },
    azure_diagnostics: {
      label: 'Azure Diagnostics',
      description: 'Azure resource diagnostic logs via Event Hub',
      fieldDefaults: { eventHubName: 'insights-logs-diagnostics', consumerGroup: 'cribl' },
    },
    azure_nsg: {
      label: 'Azure NSG Flow Logs',
      description: 'Network Security Group flow logs via Event Hub',
      fieldDefaults: { eventHubName: 'insights-logs-networksecuritygroupflowevent', consumerGroup: 'cribl' },
    },
  },
};

// ---------------------------------------------------------------------------
// Source Type: Azure Blob Storage
// ---------------------------------------------------------------------------

const azureBlob: SourceTypeDefinition = {
  id: 'azure_blob',
  name: 'Azure Blob Storage',
  description: 'Collect log files from Azure Blob Storage containers. Supports scheduled polling or event-driven collection via Event Grid.',
  criblType: 'azure_blob',
  category: 'pull',
  fields: [
    {
      name: 'connectionString',
      label: 'Storage Account Connection String',
      type: 'password',
      required: true,
      placeholder: 'DefaultEndpointsProtocol=https;AccountName=...;AccountKey=...',
      description: 'Azure Storage account connection string.',
      group: 'Connection',
    },
    {
      name: 'containerName',
      label: 'Container Name',
      type: 'string',
      required: true,
      placeholder: 'logs',
      description: 'Blob container to collect from.',
      group: 'Connection',
    },
    {
      name: 'path',
      label: 'Blob Path Prefix',
      type: 'string',
      required: false,
      placeholder: 'insights-logs/',
      description: 'Only collect blobs matching this prefix.',
      group: 'Collection',
    },
    {
      name: 'schedule',
      label: 'Collection Schedule',
      type: 'string',
      required: false,
      default: '*/5 * * * *',
      description: 'Cron expression for polling interval.',
      group: 'Collection',
    },
    {
      name: 'recursiveSearch',
      label: 'Recursive Search',
      type: 'boolean',
      required: false,
      default: true,
      description: 'Search for blobs in subdirectories.',
      group: 'Collection',
    },
    {
      name: 'deleteAfterCollect',
      label: 'Delete After Collection',
      type: 'boolean',
      required: false,
      default: false,
      description: 'Delete blobs after successful collection.',
      group: 'Advanced',
    },
  ],
  staticConfig: {
    disabled: false,
    sendToRoutes: true,
    pqEnabled: true,
  },
  vendorPresets: {
    azure_flow_logs: {
      label: 'Azure vNet Flow Logs',
      description: 'vNet/NSG flow logs stored in blob storage',
      fieldDefaults: { path: 'insights-logs-flowlogflowevent/', recursiveSearch: true },
    },
  },
};

// ---------------------------------------------------------------------------
// Source Type: Kafka
// ---------------------------------------------------------------------------

const kafka: SourceTypeDefinition = {
  id: 'kafka',
  name: 'Kafka',
  description: 'Consume events from Apache Kafka or Confluent Cloud topics.',
  criblType: 'kafka',
  category: 'stream',
  fields: [
    {
      name: 'brokers',
      label: 'Broker(s)',
      type: 'string',
      required: true,
      placeholder: 'broker1:9092,broker2:9092',
      description: 'Comma-separated list of Kafka broker addresses.',
      group: 'Connection',
    },
    {
      name: 'topic',
      label: 'Topic',
      type: 'string',
      required: true,
      placeholder: 'security-logs',
      description: 'Kafka topic to consume from.',
      group: 'Connection',
    },
    {
      name: 'groupId',
      label: 'Consumer Group ID',
      type: 'string',
      required: true,
      default: 'cribl',
      description: 'Kafka consumer group identifier.',
      group: 'Connection',
    },
    {
      name: 'authType',
      label: 'Authentication',
      type: 'select',
      required: false,
      default: 'none',
      description: 'Kafka authentication mechanism.',
      options: [
        { value: 'none', label: 'None (plaintext)' },
        { value: 'sasl_plain', label: 'SASL/PLAIN' },
        { value: 'sasl_scram', label: 'SASL/SCRAM' },
        { value: 'sasl_ssl', label: 'SASL/SSL' },
      ],
      group: 'Authentication',
    },
    {
      name: 'saslUsername',
      label: 'SASL Username',
      type: 'string',
      required: false,
      description: 'SASL username.',
      group: 'Authentication',
    },
    {
      name: 'saslPassword',
      label: 'SASL Password',
      type: 'password',
      required: false,
      description: 'SASL password.',
      group: 'Authentication',
    },
    {
      name: 'fromBeginning',
      label: 'Start from Beginning',
      type: 'boolean',
      required: false,
      default: false,
      description: 'Start reading from the beginning of the topic (otherwise latest).',
      group: 'Advanced',
    },
  ],
  staticConfig: {
    disabled: false,
    sendToRoutes: true,
    pqEnabled: true,
  },
  vendorPresets: {
    confluent_cloud: {
      label: 'Confluent Cloud',
      description: 'Confluent Cloud managed Kafka',
      fieldDefaults: { authType: 'sasl_plain' },
    },
  },
};

// ---------------------------------------------------------------------------
// Source Type: Office 365 Activity API
// ---------------------------------------------------------------------------

const office365: SourceTypeDefinition = {
  id: 'office365',
  name: 'Office 365 Activity',
  description: 'Collect Office 365 Management Activity API logs. Requires Azure AD app registration with Office 365 Management API permissions.',
  criblType: 'office365_mgmt',
  category: 'pull',
  fields: [
    {
      name: 'tenantId',
      label: 'Tenant ID',
      type: 'string',
      required: true,
      placeholder: '<YOUR-TENANT-ID>',
      description: 'Azure AD tenant ID.',
      group: 'Authentication',
    },
    {
      name: 'clientId',
      label: 'Client ID (App ID)',
      type: 'string',
      required: true,
      placeholder: '<YOUR-CLIENT-ID>',
      description: 'Azure AD application (client) ID.',
      group: 'Authentication',
    },
    {
      name: 'clientSecret',
      label: 'Client Secret',
      type: 'password',
      required: true,
      description: 'Azure AD application client secret.',
      group: 'Authentication',
    },
    {
      name: 'contentTypes',
      label: 'Content Types',
      type: 'string',
      required: true,
      default: 'Audit.AzureActiveDirectory,Audit.Exchange,Audit.SharePoint,Audit.General,DLP.All',
      description: 'Comma-separated list of O365 content types to collect.',
      group: 'Collection',
    },
    {
      name: 'schedule',
      label: 'Collection Schedule',
      type: 'string',
      required: false,
      default: '*/5 * * * *',
      description: 'Cron expression for collection interval.',
      group: 'Collection',
    },
  ],
  discovery: {
    enabled: true,
    description: 'O365 Management API uses a subscription model. The discovery phase creates/verifies content type subscriptions before collection begins.',
    fields: [
      {
        name: 'autoSubscribe',
        label: 'Auto-Subscribe to Content Types',
        type: 'boolean',
        required: false,
        default: true,
        description: 'Automatically create subscriptions for the selected content types.',
        group: 'Discovery',
      },
    ],
  },
  staticConfig: {
    disabled: false,
    sendToRoutes: true,
    pqEnabled: true,
  },
};

// ---------------------------------------------------------------------------
// Source Type: S3 (AWS)
// ---------------------------------------------------------------------------

const s3: SourceTypeDefinition = {
  id: 's3',
  name: 'AWS S3',
  description: 'Collect log files from AWS S3 buckets. Supports SQS-based notification for real-time collection.',
  criblType: 's3',
  category: 'pull',
  fields: [
    {
      name: 'bucket',
      label: 'S3 Bucket Name',
      type: 'string',
      required: true,
      placeholder: 'my-log-bucket',
      description: 'S3 bucket name to collect from.',
      group: 'Connection',
    },
    {
      name: 'region',
      label: 'AWS Region',
      type: 'string',
      required: true,
      default: 'us-east-1',
      description: 'AWS region where the S3 bucket is located.',
      group: 'Connection',
    },
    {
      name: 'path',
      label: 'Key Prefix',
      type: 'string',
      required: false,
      placeholder: 'AWSLogs/',
      description: 'Only collect objects matching this key prefix.',
      group: 'Collection',
    },
    {
      name: 'authentication',
      label: 'Authentication',
      type: 'select',
      required: true,
      default: 'auto',
      description: 'AWS authentication method.',
      options: [
        { value: 'auto', label: 'Auto (IAM role / env vars)' },
        { value: 'keys', label: 'Access Key / Secret Key' },
        { value: 'assume_role', label: 'Assume Role' },
      ],
      group: 'Authentication',
    },
    {
      name: 'awsAccessKeyId',
      label: 'AWS Access Key ID',
      type: 'string',
      required: false,
      description: 'AWS access key (for key-based auth).',
      group: 'Authentication',
    },
    {
      name: 'awsSecretAccessKey',
      label: 'AWS Secret Access Key',
      type: 'password',
      required: false,
      description: 'AWS secret key (for key-based auth).',
      group: 'Authentication',
    },
    {
      name: 'sqsQueueUrl',
      label: 'SQS Queue URL',
      type: 'string',
      required: false,
      placeholder: 'https://sqs.us-east-1.amazonaws.com/123456789/my-queue',
      description: 'SQS queue URL for event-driven collection (instead of polling).',
      group: 'Collection',
    },
    {
      name: 'schedule',
      label: 'Collection Schedule',
      type: 'string',
      required: false,
      default: '*/5 * * * *',
      description: 'Cron expression for polling (ignored if SQS is configured).',
      group: 'Collection',
    },
  ],
  staticConfig: {
    disabled: false,
    sendToRoutes: true,
    pqEnabled: true,
  },
  vendorPresets: {
    aws_cloudtrail: {
      label: 'AWS CloudTrail',
      description: 'CloudTrail logs in S3',
      fieldDefaults: { path: 'AWSLogs/', region: 'us-east-1' },
    },
    aws_vpc_flow: {
      label: 'AWS VPC Flow Logs',
      description: 'VPC flow logs in S3',
      fieldDefaults: { path: 'AWSLogs/', region: 'us-east-1' },
    },
    aws_guardduty: {
      label: 'AWS GuardDuty Findings',
      description: 'GuardDuty findings exported to S3',
      fieldDefaults: { path: 'AWSLogs/', region: 'us-east-1' },
    },
  },
};

// ---------------------------------------------------------------------------
// Source Type: Windows Event Forwarding (WEF)
// ---------------------------------------------------------------------------

const windowsEvents: SourceTypeDefinition = {
  id: 'windows_event',
  name: 'Windows Event Logs',
  description: 'Collect Windows Event Logs locally or via Windows Event Forwarding (WEF). Requires Cribl Edge agent on Windows hosts.',
  criblType: 'windows_event_logs',
  category: 'pull',
  fields: [
    {
      name: 'channels',
      label: 'Event Channels',
      type: 'string',
      required: true,
      default: 'Security,System,Application',
      description: 'Comma-separated list of Windows event channels to collect.',
      group: 'Collection',
    },
    {
      name: 'eventFilter',
      label: 'Event Filter (XPath)',
      type: 'multiline',
      required: false,
      placeholder: '*[System[(Level=1 or Level=2 or Level=3)]]',
      description: 'Optional XPath filter to limit collected events.',
      group: 'Collection',
    },
    {
      name: 'readExisting',
      label: 'Read Existing Events',
      type: 'boolean',
      required: false,
      default: false,
      description: 'Read existing events when starting (otherwise start from current position).',
      group: 'Advanced',
    },
  ],
  staticConfig: {
    disabled: false,
    sendToRoutes: true,
  },
  vendorPresets: {
    security_focused: {
      label: 'Security-Focused Collection',
      description: 'Security, Sysmon, PowerShell, and Defender channels',
      fieldDefaults: {
        channels: 'Security,Microsoft-Windows-Sysmon/Operational,Microsoft-Windows-PowerShell/Operational,Microsoft-Windows-Windows Defender/Operational',
      },
    },
    all_channels: {
      label: 'All Major Channels',
      description: 'All standard Windows event channels',
      fieldDefaults: {
        channels: 'Security,System,Application,Setup,Microsoft-Windows-Sysmon/Operational,Microsoft-Windows-PowerShell/Operational',
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Exported Registry
// ---------------------------------------------------------------------------

export const SOURCE_TYPES: Record<string, SourceTypeDefinition> = {
  syslog,
  rest_collector: restCollector,
  http: httpSource,
  azure_event_hub: azureEventHub,
  azure_blob: azureBlob,
  kafka,
  office365,
  s3,
  windows_event: windowsEvents,
};

// Map vendor/solution names to their most common source type
export const VENDOR_SOURCE_HINTS: Record<string, { sourceType: string; preset?: string }> = {
  cloudflare: { sourceType: 'rest_collector', preset: 'cloudflare' },
  crowdstrike: { sourceType: 'rest_collector', preset: 'crowdstrike' },
  'palo alto': { sourceType: 'syslog', preset: 'paloalto' },
  paloalto: { sourceType: 'syslog', preset: 'paloalto' },
  fortinet: { sourceType: 'syslog', preset: 'fortinet' },
  fortigate: { sourceType: 'syslog', preset: 'fortinet' },
  cisco: { sourceType: 'syslog', preset: 'cisco_asa' },
  okta: { sourceType: 'rest_collector', preset: 'okta' },
  qualys: { sourceType: 'rest_collector', preset: 'qualys' },
  office365: { sourceType: 'office365' },
  'office 365': { sourceType: 'office365' },
  microsoft365: { sourceType: 'office365' },
  'azure activity': { sourceType: 'azure_event_hub', preset: 'azure_activity' },
  'azure ad': { sourceType: 'azure_event_hub', preset: 'azure_ad' },
  'entra id': { sourceType: 'azure_event_hub', preset: 'azure_ad' },
  'azure diagnostics': { sourceType: 'azure_event_hub', preset: 'azure_diagnostics' },
  'aws cloudtrail': { sourceType: 's3', preset: 'aws_cloudtrail' },
  'aws vpc': { sourceType: 's3', preset: 'aws_vpc_flow' },
  guardduty: { sourceType: 's3', preset: 'aws_guardduty' },
  windows: { sourceType: 'windows_event', preset: 'security_focused' },
  syslog: { sourceType: 'syslog', preset: 'linux_syslog' },
};

// Suggest a source type based on vendor/solution name
export function suggestSourceType(
  solutionName: string,
  tableName: string,
): { sourceType: string; preset?: string } | null {
  const combined = `${solutionName} ${tableName}`.toLowerCase();
  for (const [keyword, hint] of Object.entries(VENDOR_SOURCE_HINTS)) {
    if (combined.includes(keyword.toLowerCase())) {
      return hint;
    }
  }
  return null;
}

// Generate inputs.yml YAML content from a source configuration
export function generateInputsYml(
  inputId: string,
  config: SourceConfig,
): string {
  const typeDef = SOURCE_TYPES[config.sourceType];
  if (!typeDef) {
    return `# Unknown source type: ${config.sourceType}\ninputs: {}\n`;
  }

  // Merge: static defaults -> vendor preset defaults -> user-provided fields
  const merged: Record<string, unknown> = { ...typeDef.staticConfig };
  merged['type'] = typeDef.criblType;

  // Apply vendor preset defaults
  if (config.vendorPreset && typeDef.vendorPresets?.[config.vendorPreset]) {
    const preset = typeDef.vendorPresets[config.vendorPreset];
    for (const [k, v] of Object.entries(preset.fieldDefaults)) {
      merged[k] = v;
    }
  }

  // Apply field defaults from the type definition
  for (const field of typeDef.fields) {
    if (field.default !== undefined && !(field.name in merged)) {
      merged[field.name] = field.default;
    }
  }

  // Apply user-provided field values (override everything)
  for (const [k, v] of Object.entries(config.fields)) {
    if (v !== '' && v !== undefined) {
      merged[k] = v;
    }
  }

  // Build discovery section if applicable
  let discoverySection = '';
  if (typeDef.discovery?.enabled && config.discoveryFields) {
    const discoverFields: Record<string, unknown> = {};
    if (config.vendorPreset && typeDef.vendorPresets?.[config.vendorPreset]?.discoveryDefaults) {
      Object.assign(discoverFields, typeDef.vendorPresets[config.vendorPreset].discoveryDefaults);
    }
    Object.assign(discoverFields, config.discoveryFields);

    if (Object.keys(discoverFields).length > 0) {
      discoverySection = '\n    # Discovery configuration\n';
      for (const [k, v] of Object.entries(discoverFields)) {
        discoverySection += `    ${k}: ${formatYamlValue(v)}\n`;
      }
    }
  }

  // Build the YAML output
  const lines: string[] = [
    `# ${typeDef.name} Input Configuration`,
    `# Source Type: ${typeDef.description}`,
    '#',
    '# Generated by Cribl-Microsoft Integration Solution',
    '# Update placeholder values (<YOUR-...>) before deploying.',
    '',
    'inputs:',
    `  ${inputId}:`,
  ];

  // Sort fields: type first, then required, then optional
  const fieldOrder = ['type', 'disabled', 'sendToRoutes', 'pqEnabled'];
  const sortedKeys = Object.keys(merged).sort((a, b) => {
    const aIdx = fieldOrder.indexOf(a);
    const bIdx = fieldOrder.indexOf(b);
    if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
    if (aIdx !== -1) return -1;
    if (bIdx !== -1) return 1;
    return 0;
  });

  for (const key of sortedKeys) {
    lines.push(`    ${key}: ${formatYamlValue(merged[key])}`);
  }

  if (discoverySection) {
    lines.push(discoverySection);
  }

  lines.push('');
  return lines.join('\n');
}

function formatYamlValue(value: unknown): string {
  if (typeof value === 'string') {
    // Quote strings that contain special chars or look like placeholders
    if (
      value.includes(':') || value.includes('#') || value.includes('{') ||
      value.includes('$') || value.includes('<') || value.includes("'") ||
      value.includes('"') || value.startsWith('*') || value === '' ||
      value === 'true' || value === 'false'
    ) {
      return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    }
    return value;
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return '\n' + value.map((v) => `      - ${formatYamlValue(v)}`).join('\n');
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value);
    if (entries.length === 0) return '{}';
    return '\n' + entries.map(([k, v]) => `      ${k}: ${formatYamlValue(v)}`).join('\n');
  }
  return String(value);
}
