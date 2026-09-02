/**
 * useCapabilityAudit - the app-level permission audit
 * (capability-model-plan step 2).
 *
 * Owns the AUDIT LIFECYCLE for the running app: it loads the cached result,
 * decides whether to re-measure, and hands back the capabilities plus the
 * connection facts the domain needs to resolve anything unmeasured. Step 3's nav
 * annotation is the intended consumer; the preflight panel already uses it to
 * show the audit's age and offer a manual re-check.
 *
 * WHY THE EFFECT USES THE `launch` TRIGGER FOR MORE THAN LAUNCH. Two of the
 * plan's three re-audit events - connection switch and scope commit - already
 * change the audit key, so the effect re-fires and `launch` correctly declines
 * only when a cached set matches. That also means switching BACK to a connection
 * audited earlier reuses its result instead of paying for it again. The third
 * event, secret re-entry, leaves the key untouched and must be reported by the
 * shell through {@link CapabilityAuditState.audit}.
 *
 * The shell owns the clock: `now` is injected, never read here, matching the
 * CapabilitySet contract that the audit timestamp comes from outside core.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  capabilityAuditKey,
  describeCapabilityAudit,
  emptyCapabilitySet,
  runCapabilityAudit,
} from "@soc/core";
import type {
  AuditTrigger,
  AzureConfig,
  AzurePreflightTarget,
  CapabilityAuditView,
  CapabilityContext,
  CapabilitySet,
  CriblShellMode,
  SetupPath,
} from "@soc/core";
import type { UiPorts } from "../ports-context";
import { deriveCapabilityContext } from "./capability-audit-state";

/** What the hosting shell must tell the audit. */
export interface CapabilityAuditOptions {
  /**
   * The port bundle. Passed explicitly rather than read from PortsContext
   * because the audit is an APP-level concern and neither shell has a single
   * provider high enough to cover the frame - each screen wraps its own. A
   * caller already inside a provider passes `usePorts().ports`.
   */
  ports: UiPorts;
  /** The active connection's non-secret config - identity plus target scope. */
  config: AzureConfig;
  /**
   * Whether `config` can be TRUSTED yet. Defaults to true.
   *
   * Both shells load their connection store asynchronously, so for the first
   * moments after mount `config` is the empty one. Auditing then is not merely
   * wasted - it is actively harmful, because the audit key derived from an empty
   * config is a DIFFERENT key, and the result gets cached under it. The next
   * audit, with the real config, finds no match and re-measures; and on the
   * following launch the unhydrated audit overwrites the cache again before the
   * hydrated one can use it. The cache never hits, so launch conservation - the
   * entire point of caching - never engages.
   *
   * Observed live 2026-08-06 before this existed: three audits per page load,
   * every one of them reporting "no cached audit for this connection".
   */
  ready?: boolean;
  /**
   * Which shell is hosting. Decides how the Cribl side is measured - the cloud
   * probe is granted-by-platform, the local one is genuinely probed.
   */
  criblShellMode: CriblShellMode;
  /** The setup path, which selects which Azure actions are checked. */
  setupPath: SetupPath;
  /** The worker group the Cribl probes target. */
  workerGroup?: string;
  /**
   * Whether a Cribl connection exists at all. Shell-supplied because the two
   * shells know it differently; it decides `unreachable` vs `unknown` on the
   * Cribl side.
   */
  criblReachable: boolean;
  /** The shell's clock. Called when an audit is stamped and when age is shown. */
  now: () => string;
}

/** What the hook exposes. */
export interface CapabilityAuditState {
  /** The measured capabilities for THIS connection. Never another's. */
  capabilities: CapabilitySet;
  /** Connection facts for resolving unmeasured capabilities. */
  context: CapabilityContext;
  /** The connection identity the audit was measured against. */
  key: string;
  /** Status, age line, and whether the cached verdicts may be rendered. */
  view: CapabilityAuditView;
  /** True while an audit is in flight. */
  running: boolean;
  /** Re-audit now, at the operator's request. */
  refresh: () => void;
  /**
   * Report an event that should re-audit. The shell calls this with
   * `secret-entry`, the one trigger the key cannot reveal.
   */
  audit: (trigger: AuditTrigger) => void;
}

export function useCapabilityAudit(
  options: CapabilityAuditOptions,
): CapabilityAuditState {
  const {
    ports,
    config,
    ready = true,
    criblShellMode,
    setupPath,
    workerGroup = "",
    criblReachable,
    now,
  } = options;

  const [capabilities, setCapabilities] = useState<CapabilitySet>(emptyCapabilitySet());
  const [running, setRunning] = useState(false);

  // The clock lives in a ref so a caller passing an inline `() => ...` cannot
  // change the audit callback's identity on every render and re-trigger itself.
  const nowRef = useRef(now);
  nowRef.current = now;

  // Guards a state write after unmount when an audit is still in flight.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const target: AzurePreflightTarget = useMemo(
    () => ({
      subscriptionId: config.subscriptionId,
      resourceGroup: config.resourceGroup,
      workspaceName: config.workspaceName,
    }),
    [config.subscriptionId, config.resourceGroup, config.workspaceName],
  );

  const key = useMemo(
    () =>
      capabilityAuditKey({
        tenantId: config.tenantId,
        clientId: config.clientId,
        subscriptionId: target.subscriptionId,
        resourceGroup: target.resourceGroup,
        workspaceName: target.workspaceName,
        setupPath,
        criblWorkerGroup: workerGroup,
      }),
    [config.tenantId, config.clientId, target, setupPath, workerGroup],
  );

  const audit = useCallback(
    (trigger: AuditTrigger) => {
      setRunning(true);
      // runCapabilityAudit never rejects, so there is no error branch to render -
      // a failed audit comes back as fewer verdicts, which the domain already
      // renders honestly as unknown.
      void runCapabilityAudit(
        {
          azure: ports.azure,
          cribl: ports.cribl,
          ...(ports.contentCache !== undefined ? { cache: ports.contentCache } : {}),
          ...(ports.logger !== undefined ? { logger: ports.logger } : {}),
        },
        {
          trigger,
          setupPath,
          azure: target,
          identity: { tenantId: config.tenantId, clientId: config.clientId },
          cribl: { mode: criblShellMode, workerGroup },
          nowIso: nowRef.current(),
        },
      ).then((result) => {
        if (!mountedRef.current) {
          return;
        }
        setCapabilities(result.set);
        setRunning(false);
      });
    },
    [
      ports,
      setupPath,
      target,
      config.tenantId,
      config.clientId,
      criblShellMode,
      workerGroup,
    ],
  );

  // Re-runs whenever the audited connection changes, which covers connection
  // switch and scope commit. `launch` is the right trigger for all of them: it
  // is the passive moment that may legitimately use a cached answer.
  //
  // Gated on `ready` so a not-yet-hydrated config never gets audited, and never
  // caches a result under the empty config's key.
  useEffect(() => {
    if (!ready) {
      return;
    }
    audit("launch");
  }, [audit, ready]);

  // MEMOIZED BECAUSE THIS OBJECT IS NOW A CONTEXT VALUE (D-3). The shell puts
  // it on PortsProvider, whose own memo has it in the dep list, so a fresh
  // identity every render would defeat that memo and re-render every screen
  // under the provider on every shell render. It was rebuilt per render before
  // D-3 and nothing noticed, because a prop reaching one screen is cheap in a
  // way a context value is not.
  //
  // The deps are the WHOLE input: deriveCapabilityContext reads `tenantId` and
  // `clientId` off the config and nothing else, so keying on the config OBJECT
  // would be both wider than needed and unreliable - `getActiveConfig` returns a
  // fresh EMPTY_AZURE_CONFIG clone on every call when no profile is active, so
  // an object-identity dep would never hold in exactly the disconnected state
  // the app opens in.
  //
  // The suppression is NARROW and it buys the dep list above: exhaustive-deps
  // wants the whole `config` object, which is precisely the dep that would
  // never hold. What makes the trade safe is a property of the shipped code
  // today - `deriveCapabilityContext` (capability-audit-state.ts) calls only
  // `hasAzureIdentity`, which reads exactly `tenantId` and `clientId`. Nothing
  // enforces that, so a third field read there makes this dep list wrong, and
  // the pin in use-capability-audit.dom.test.tsx would NOT catch it - it varies
  // the config's identity, not its contents.
  const context = useMemo(
    () => deriveCapabilityContext(config, criblReachable),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [config.tenantId, config.clientId, criblReachable],
  );
  const view = describeCapabilityAudit(capabilities, key, nowRef.current());

  const refresh = useCallback(() => audit("manual"), [audit]);

  return { capabilities, context, key, view, running, refresh, audit };
}
