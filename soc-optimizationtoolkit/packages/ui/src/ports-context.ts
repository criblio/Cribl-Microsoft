/**
 * PortsContext: the React context every @soc/ui screen consumes for IO.
 * The hosting shell (cribl-app iframe or local-app browser UI) constructs
 * its port adapters and the ACTIVE non-secret AzureConfig, then wraps the
 * screens in PortsProvider. Screens never fetch or touch storage directly -
 * all IO flows through the six @soc/core ports carried here.
 *
 * No JSX in this module (plain createElement) so it stays a .ts file and the
 * context/hook/provider live together as one seam.
 */

import { createContext, createElement, useContext, useMemo } from "react";
import type { ReactElement, ReactNode } from "react";
import type {
  ArtifactSink,
  AzureConfig,
  AzureManagement,
  ContentCache,
  CriblClient,
  GithubPatManager,
  InstalledPack,
  JobStore,
  Logger,
  PackBuildRecord,
  PackScaffoldInput,
  SecretsStore,
  SentinelContent,
  TaggedSampleStore,
  UserContext,
} from "@soc/core";

/**
 * A persisted pack build (porting-plan Unit 19, GUI-19): the small
 * {@link PackBuildRecord} descriptor PLUS the pack DEFINITION needed to
 * regenerate the identical .crbl on demand. The 2026-07-04 decision is that
 * cloud NEVER persists archive bytes in KV (size limits) - it stores the
 * definition and regenerates deterministically (assemblePack is Date-free; the
 * builtAtMs input keeps a rebuild byte-stable). Local MAY additionally cache the
 * bytes; {@link cachedCrblBase64} is that optional cache, and the pure
 * regenerate-vs-cached choice lives in the pack-inventory state module.
 */
export interface StoredPack {
  /** The lightweight, list-renderable build record (KV/local-store shaped). */
  record: PackBuildRecord;
  /** The pack definition for deterministic regeneration of the .crbl bytes. */
  definition: PackScaffoldInput;
  /**
   * OPTIONAL cached .crbl bytes, base64. Cloud NEVER sets this (KV size);
   * local may, trading disk for a skipped regenerate.
   */
  cachedCrblBase64?: string;
}

/**
 * Persistence for pack build records (porting-plan Unit 19, ENG-09). Not a
 * @soc/core port - a shell-provided store the pack inventory screen reads and
 * writes (cloud = KV entries, local = the Node host store). Keyed by the build
 * record id.
 */
export interface PackRecordStore {
  /** All stored packs (the screen sorts/derives; order here is unspecified). */
  list(): Promise<StoredPack[]>;
  /** One stored pack by build record id, or null when absent. */
  get(id: string): Promise<StoredPack | null>;
  /** Upsert one stored pack (replace by record id). */
  put(pack: StoredPack): Promise<void>;
  /** Remove one stored pack by build record id (idempotent). */
  delete(id: string): Promise<void>;
}

/** The installed packs on one worker group, from the live packs API. */
export interface DeployedGroupPacks {
  group: string;
  packs: InstalledPack[];
}

/**
 * Pack install + deployed-status client (porting-plan Unit 19, ENG-07/28).
 * The shell adapter binds the @soc/core install DECISION LOGIC (two-step PUT
 * ?filename= then POST source, duplicate-conflict delete-and-retry, the
 * returned-randomized-filename rule) and reads deployed status from the packs
 * API - never from local storage.
 */
export interface PackInstallClient {
  /**
   * The installed packs on each of the given worker groups, from each group's
   * live packs list (the deployed-status TRUTH the badges derive from).
   */
  listDeployed(groups: readonly string[]): Promise<DeployedGroupPacks[]>;
  /**
   * Install a built pack's .crbl bytes into a worker group and resolve the
   * installed pack summary. Runs the two-step upload + conflict retry inside.
   */
  install(group: string, fileName: string, crbl: Uint8Array): Promise<InstalledPack>;
}

/**
 * The @soc/core port instances a shell binds. Structurally compatible
 * with the shells' adapter factories (e.g. the cloud shell's CloudPorts) and
 * with usecase port bundles like OnboardTablePorts.
 */
export interface UiPorts {
  secrets: SecretsStore;
  azure: AzureManagement;
  cribl: CriblClient;
  jobs: JobStore;
  user: UserContext;
  artifacts: ArtifactSink;
  /**
   * Tagged-sample persistence (porting-plan Unit 11): the Integrate page's
   * Sample Data section reads and writes tagged samples through this store
   * (cloud = KV entries, local = the Node host store). Keyed by log type with
   * replace-by-logType semantics.
   */
  samples: TaggedSampleStore;
  /**
   * OPTIONAL lazy Sentinel content accessor (porting-plan Unit 14). The
   * solution browser reads solutions and per-solution connector files through
   * it; both shells bind a real adapter over the proxied/host GitHub path.
   * Optional so shells/tests that never open the content flow still satisfy
   * the bundle; screens that need it degrade gracefully when it is absent.
   */
  content?: SentinelContent;
  /**
   * OPTIONAL parsed-content cache keyed by solution+commit (porting-plan Unit
   * 14). Paired with {@link content}; the browser caches a solution's parsed
   * result so it is fetched at most once per upstream commit.
   */
  contentCache?: ContentCache;
  /**
   * OPTIONAL GitHub PAT lifecycle manager (porting-plan Unit 14). The
   * Repositories settings page validates-then-stores a PAT through it and reads
   * back only hasPat + login (never the token).
   */
  githubPat?: GithubPatManager;
  /**
   * OPTIONAL diagnostics sink (porting-plan Unit 3). Carrying it in the
   * ports bundle means every usecase invoked with the bundle logs for free
   * (OnboardTablePorts.logger is picked up structurally); screens may also
   * log sparingly through it. Absent logger = no-op, zero behavior change.
   */
  logger?: Logger;
  /**
   * OPTIONAL pack build-record store (porting-plan Unit 19, ENG-09). The pack
   * inventory screen lists, downloads (via regeneration), and deletes build
   * records through it. Optional so shells/tests that never open the pack
   * surface still satisfy the bundle; the screen shows an honest empty state
   * when it is absent.
   */
  packs?: PackRecordStore;
  /**
   * OPTIONAL pack install + deployed-status client (porting-plan Unit 19,
   * ENG-07/28). Paired with {@link packs}: the inventory screen installs a
   * built pack into a worker group and derives DEPLOYED badges from the live
   * packs API through it.
   */
  packInstall?: PackInstallClient;
  /**
   * OPTIONAL shell-injected GUID minter for role-assignment names (porting-plan
   * Unit 8, ENG-37 runtime half). The shell OWNS id conventions: @soc/core never
   * mints an id, so the assign-dcr-role usecase takes the name provider from
   * here (both shells bind crypto.randomUUID). Absent = the role-assignment step
   * stays visible-but-disabled with the reason (a shell wiring gap, not a
   * runtime state); every other screen is unaffected.
   */
  mintAssignmentName?: () => string;
}

/** What PortsContext carries: the ports plus the active connection config. */
export interface PortsContextValue {
  ports: UiPorts;
  /**
   * The ACTIVE connection's non-secret Azure config (subscription, resource
   * group, workspace, tenant/client ids). Secrets are never part of this -
   * the platform's encrypted storage is write-only, so secrets only ever
   * travel as transient user input within a single interaction.
   */
  config: AzureConfig;
}

/**
 * The raw context. Prefer {@link usePorts} in screens and {@link
 * PortsProvider} in shells; the context itself is exported for tests and
 * shells that need a custom provider arrangement.
 */
export const PortsContext = createContext<PortsContextValue | null>(null);

/** Props for {@link PortsProvider}. */
export interface PortsProviderProps {
  ports: UiPorts;
  config: AzureConfig;
  children: ReactNode;
}

/**
 * Convenience provider: memoizes the context value so consumers only
 * re-render when the ports bundle or the active config actually changes.
 */
export function PortsProvider(props: PortsProviderProps): ReactElement {
  const { ports, config, children } = props;
  const value = useMemo(() => ({ ports, config }), [ports, config]);
  return createElement(PortsContext.Provider, { value }, children);
}

/**
 * Read the ports and active config. Throws when rendered outside a
 * PortsProvider - a wiring bug in the hosting shell, not a runtime state.
 */
export function usePorts(): PortsContextValue {
  const value = useContext(PortsContext);
  if (value === null) {
    throw new Error(
      "usePorts must be rendered inside a PortsProvider (the hosting shell wires ports and config)",
    );
  }
  return value;
}
