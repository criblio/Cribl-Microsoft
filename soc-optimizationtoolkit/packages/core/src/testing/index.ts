/**
 * In-memory fakes for every port in src/ports/. For unit tests only; never
 * bind these in an app shell.
 */

export { FakeSecretsStore, REDACTED_SECRET_PLACEHOLDER } from './fake-secrets-store';
export { FakeUserContext, DEFAULT_FAKE_USER } from './fake-user-context';
export { FakeArtifactSink } from './fake-artifact-sink';
export type { SavedArtifact } from './fake-artifact-sink';
export { FakeJobStore } from './fake-job-store';
export { FakeAzureManagement } from './fake-azure-management';
export { FakeCriblClient } from './fake-cribl-client';
export { FakeLogger } from './fake-logger';
export { FakeTaggedSampleStore } from './fake-tagged-sample-store';
