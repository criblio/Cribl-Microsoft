/**
 * Port interfaces: the only seam between shared code and the two app shells.
 * Each shell (Cribl App Platform cloud shell, local Node host) binds its own
 * adapters; domain code and UI depend exclusively on these types.
 * In-memory fakes for every port live in src/testing/.
 */

export type { HttpMethod, PortHttpResponse } from './http';
export type { SecretsStore, SecretSetOptions } from './secrets-store';
export type { UserContext, UserIdentity } from './user-context';
export type { ArtifactSink } from './artifact-sink';
export type { JobStore, JobRecord, JobStep, JobStatus } from './job-store';
export type {
  AzureManagement,
  AzureManagementRequest,
  AzureManagementUrlRequest,
} from './azure-management';
export type { CriblClient, CriblRequest, CriblGroupSummary } from './cribl-client';
export type { TaggedSampleStore } from './tagged-sample-store';
export type {
  Logger,
  LogLevel,
  LogContext,
  LogContextValue,
  LogEntry,
} from './logger';
export { redactedLength } from './logger';
