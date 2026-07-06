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
  JobStore,
  Logger,
  SecretsStore,
  SentinelContent,
  TaggedSampleStore,
  UserContext,
} from "@soc/core";

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
