// Driven ports — interfaces the core OWNS; adapters implement them outside the core.
// One destination (Microsoft Sentinel), many pluggable sources.
// See docs/adr/0008-sentinel-destination-pluggable-sources.md.
// These are minimal seeds; the real shapes are filled in across Phases 1-10.

export interface ProgressEvent {
  readonly phase: string;
  readonly message: string;
}

/** Streams progress to whichever frontend is driving (GUI / CLI / service). */
export interface ProgressSink {
  report(event: ProgressEvent): void;
}

// --- destination: Microsoft Sentinel (singular) ---

/** Sentinel/Azure control plane: auth, session, workspace. */
export interface SentinelClient {
  getWorkspaceId(): Promise<string>;
}

/** Deploys ingestion to Sentinel (Data Collection Rules). */
export interface DcrDeployer {
  /** Deploy a Direct DCR by name; returns its resource id. */
  deployDirect(name: string): Promise<{ id: string }>;
}

// --- source: pluggable (AWS, Event Hub, vNet Flow, O365, ...) ---

/** Configures a data source for Cribl collection and emits its Cribl source config. */
export interface SourceConnector {
  describe(): { readonly type: string };
}

// --- pipe ---

/** Cribl Stream control plane (the pipe between source and Sentinel). */
export interface CriblClient {
  listDestinations(): Promise<readonly string[]>;
  /** Create a Cribl destination that forwards to a Sentinel DCR; returns its id. */
  createSentinelDestination(args: { name: string; dcrId: string }): Promise<{ id: string }>;
}

// --- onboarding usecase IO (the walking-skeleton thread) ---

export interface OnboardInput {
  /** Native Sentinel table to land in, e.g. 'CommonSecurityLog'. */
  readonly sourceTable: string;
  /** Azure region, e.g. 'eastus'. */
  readonly location: string;
  /** DCR name prefix; defaults to 'dcr'. */
  readonly dcrPrefix?: string;
}

export interface OnboardResult {
  readonly sourceType: string;
  readonly dcrName: string;
  readonly dcrId: string;
  readonly criblDestinationId: string;
}
