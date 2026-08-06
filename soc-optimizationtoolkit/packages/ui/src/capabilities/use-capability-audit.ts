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
  AzurePreflightTarget,
  CapabilityAuditView,
  CapabilityContext,
  CapabilitySet,
  CriblShellMode,
  SetupPath,
} from "@soc/core";
import { usePorts } from "../ports-context";
import { deriveCapabilityContext } from "./capability-audit-state";

/** What the hosting shell must tell the audit. */
export interface CapabilityAuditOptions {
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
  const { ports, config } = usePorts();
  const { criblShellMode, setupPath, workerGroup = "", criblReachable, now } = options;

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
  useEffect(() => {
    audit("launch");
  }, [audit]);

  const context = deriveCapabilityContext(config, criblReachable);
  const view = describeCapabilityAudit(capabilities, key, nowRef.current());

  const refresh = useCallback(() => audit("manual"), [audit]);

  return { capabilities, context, key, view, running, refresh, audit };
}
