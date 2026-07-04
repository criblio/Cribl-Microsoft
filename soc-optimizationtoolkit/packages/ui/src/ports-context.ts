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
  CriblClient,
  JobStore,
  Logger,
  SecretsStore,
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
