/**
 * AuaGate - the acceptable-use agreement shown BEFORE anything else when no
 * AcceptanceRecord exists. Scroll-to-bottom enables Accept; a body short
 * enough to render without a scrollbar counts as reviewed (the legacy gate
 * could soft-lock on tall windows because only scroll events set its flag).
 *
 * WHO RENDERS IT WHEN is not this component's decision: shells call
 * resolveFramePhase (frame-state.ts), whose loading contract guarantees an
 * already-accepted user never sees this gate flash while their persisted
 * record loads.
 *
 * The agreement text is REWRITTEN for this platform (dual-shell browser app;
 * no Electron, no PowerShell session, no DPAPI). It keeps the legacy AUA's
 * scope and tone: what the tool touches when connected, that provisioned
 * resources cost real money, the operator's responsibility, and the absence
 * of warranty.
 */

import { useEffect, useRef, useState } from "react";
import type { UIEvent } from "react";
import { isScrolledToBottom } from "./frame-state";

export interface AuaGateProps {
  /**
   * Called once when the user accepts. The SHELL mints the AcceptanceRecord
   * (it owns the clock) and persists it; a persistence failure should still
   * let the session proceed and simply re-prompt on the next launch.
   */
  onAccept: () => void | Promise<void>;
}

export function AuaGate({ onAccept }: AuaGateProps) {
  const [reviewed, setReviewed] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  // Unscrollable content is already fully visible: count it as reviewed on
  // mount so Accept is reachable without a scrollbar.
  useEffect(() => {
    const el = bodyRef.current;
    if (
      el !== null &&
      isScrolledToBottom(el.scrollTop, el.clientHeight, el.scrollHeight)
    ) {
      setReviewed(true);
    }
  }, []);

  const handleScroll = (event: UIEvent<HTMLDivElement>) => {
    const el = event.currentTarget;
    if (isScrolledToBottom(el.scrollTop, el.clientHeight, el.scrollHeight)) {
      setReviewed(true);
    }
  };

  const accept = async () => {
    setAccepting(true);
    try {
      await onAccept();
    } finally {
      setAccepting(false);
    }
  };

  return (
    <div className="gate-screen">
      <div className="gate-card">
        <h1 className="gate-title">Acceptable Use Agreement</h1>
        <p className="gate-sub">
          Please review the terms below before using the SOC Optimization
          Toolkit.
        </p>

        <div className="aua-body" ref={bodyRef} onScroll={handleScroll}>
          <p className="aua-heading">
            SOC Optimization Toolkit for Cribl Stream and Microsoft Sentinel
          </p>
          <p>
            This toolkit helps security engineers integrate Cribl Stream with
            Microsoft Sentinel and Log Analytics. It runs either as a
            Cribl.Cloud application or against a local Cribl leader, and
            operates in one of several modes depending on the connections you
            grant it.
          </p>

          <p className="aua-heading">
            What this tool does when granted connections:
          </p>
          <ul>
            <li>
              <strong>Azure (when connected):</strong> creates and modifies
              REAL Azure resources - Data Collection Rules and Endpoints,
              Log Analytics custom tables, role assignments, and (on the lab
              paths) resource groups and workspaces - using the service
              principal credentials you provide. Every operation runs with
              that identity&apos;s permissions, and resources it creates can
              incur real, recurring costs on your subscription until you
              delete them.
            </li>
            <li>
              <strong>Cribl (when connected):</strong> creates destinations,
              uploads packs, edits routes, and commits and deploys
              configuration to worker groups. A deploy changes what your
              production pipelines do with live data the moment it lands.
            </li>
          </ul>

          <p className="aua-heading">Air-gapped mode - no live changes:</p>
          <p>
            In <strong>Air-Gapped</strong> mode neither connection is live.
            The tool only generates downloadable artifacts - Cribl packs, ARM
            request bodies, destination configurations, and instructions -
            for you to review and apply manually. Choose this mode when every
            change must pass your own review before it touches a system.
          </p>

          <p className="aua-heading">Credentials:</p>
          <p>
            Secrets you enter (Azure client secrets, tokens) are stored
            write-only in the hosting shell&apos;s secret store: once saved
            they cannot be read back or displayed, only replaced. Non-secret
            configuration (tenant, subscription, workspace names) is stored in
            plain form so it can be shown and edited.
          </p>

          <p className="aua-heading">Your responsibility:</p>
          <p>
            You are responsible for reviewing every change before it is
            applied, for the cost of any Azure resources created, for the
            behavior of any Cribl configuration deployed, and for compliance
            with your organization&apos;s change-control and security
            policies. The tool reports what it did honestly - read those
            reports.
          </p>

          <p className="aua-footer-note">
            This software is provided as-is, without warranty of any kind,
            express or implied. Use it at your own risk. By accepting, you
            acknowledge that you understand what this tool can create and
            change, and that you accept responsibility for the resources and
            configurations it produces on your behalf.
          </p>
        </div>

        <div className="gate-actions">
          <span className="gate-hint">
            {reviewed
              ? "You have reviewed the agreement."
              : "Scroll to the bottom to continue."}
          </span>
          <button
            className="run-button gate-accept"
            disabled={!reviewed || accepting}
            onClick={() => void accept()}
          >
            I Accept
          </button>
        </div>
      </div>
    </div>
  );
}
