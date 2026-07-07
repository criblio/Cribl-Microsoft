/**
 * RepositoriesScreen - the GitHub PAT settings page (porting-plan Unit 14 UI;
 * ENG-30, GUI, legacy RepoSetup.tsx). The successor to the legacy Repositories
 * page, rebuilt for the two shells and the LAZY-FETCH workflow:
 *
 *   - The 13-step PAT walkthrough TEXT is kept (create a fine-grained token,
 *     public-read only; classic tokens work too).
 *   - The save-then-unstick stale-error sequence is preserved as reactive state
 *     (pat-form-state reducer): a rejected token's error sticks, then unsticks
 *     on the next edit.
 *   - Status is hasPat (never the token) plus a REACHABILITY + PAT-valid check
 *     ("GitHub connected, N solutions available"), NOT "downloaded N files".
 *   - Copy states the PAT's purpose and minimal scope; on cloud a PAT is
 *     effectively required (shared egress IP).
 *
 * All decision logic is the pure pat-form-state module and the @soc/core PAT
 * policy; this component only renders and drives IO through ports.githubPat /
 * ports.content (ZERO direct fetch here).
 */

import { useCallback, useEffect, useReducer, useState } from "react";
import { patPolicyFor } from "@soc/core";
import type { ContentPlatform } from "@soc/core";
import { usePorts } from "../../ports-context";
import {
  derivePatFormView,
  deriveReachabilityStatus,
  initialPatFormState,
  patFormReducer,
} from "./pat-form-state";

export interface RepositoriesScreenProps {
  /** Which shell is asking - governs whether a PAT is required (cloud) or advised (local). */
  platform: ContentPlatform;
}

// The 13-step PAT creation walkthrough, kept from the legacy RepoSetup page
// (fine-grained token; public-read only). Rendered as an ordered list so the
// numbering is the "13 steps"; the final paste action follows separately.
const PAT_WALKTHROUGH_STEPS: readonly string[] = [
  "Log in to github.com.",
  "Click your profile picture in the top-right corner.",
  "Select Settings from the dropdown menu.",
  "In the left sidebar, scroll down and click Developer settings.",
  "Click Personal access tokens.",
  "Click Fine-grained tokens.",
  "Click Generate new token.",
  'Token name: anything memorable (e.g. "Cribl Sentinel Toolkit").',
  "Expiration: your organization's policy (90 days is common).",
  "Resource owner: your personal account (no org access needed).",
  'Repository access: select "Public Repositories (read-only)" - this is all that is required.',
  "Permissions: leave the defaults (read-only access to public content).",
  "Click Generate token, then copy the token (it starts with github_pat_...).",
];

export function RepositoriesScreen({ platform }: RepositoriesScreenProps) {
  const { ports } = usePorts();
  const githubPat = ports.githubPat;
  const content = ports.content;

  const policy = patPolicyFor(platform);
  const [form, dispatch] = useReducer(patFormReducer, undefined, initialPatFormState);
  const view = derivePatFormView(form);

  const [walkthroughOpen, setWalkthroughOpen] = useState(false);
  const [solutionCount, setSolutionCount] = useState<number | null>(null);
  const [reachError, setReachError] = useState("");
  const [checking, setChecking] = useState(false);

  // Load the stored status once on mount (hasPat + login; never the token).
  useEffect(() => {
    if (githubPat === undefined) {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const status = await githubPat.status();
        if (!cancelled) {
          dispatch({ type: "hydrate", status });
        }
      } catch {
        // A failed status read leaves the form in its no-PAT default; the
        // reachability check surfaces any real connectivity problem.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [githubPat]);

  const save = useCallback(async () => {
    if (githubPat === undefined) {
      return;
    }
    dispatch({ type: "submit-start" });
    try {
      const status = await githubPat.validateAndStore(form.value);
      dispatch({ type: "submit-result", status });
    } catch (err) {
      dispatch({ type: "submit-error", message: String(err) });
    }
  }, [githubPat, form.value]);

  const clear = useCallback(async () => {
    if (githubPat === undefined) {
      return;
    }
    dispatch({ type: "clear-start" });
    try {
      await githubPat.clear();
      dispatch({ type: "clear-result" });
      setSolutionCount(null);
    } catch (err) {
      dispatch({ type: "clear-error", message: String(err) });
    }
  }, [githubPat]);

  // Reachability + PAT-valid check: read the lightweight index count on demand
  // (NEVER a bulk mirror). One commit-resolve + one contents call.
  const checkConnection = useCallback(async () => {
    if (content === undefined) {
      return;
    }
    setChecking(true);
    setReachError("");
    try {
      await content.getCommitSha();
      const list = await content.listSolutions();
      setSolutionCount(list.length);
    } catch (err) {
      setSolutionCount(null);
      setReachError(String(err));
    } finally {
      setChecking(false);
    }
  }, [content]);

  if (githubPat === undefined) {
    return (
      <div className="panel">
        <h2 className="panel-title">Repositories</h2>
        <p className="panel-desc">
          GitHub content management is not available in this build. A shell that
          binds the content ports (the Cribl.Cloud app or the local host)
          exposes the PAT settings here.
        </p>
      </div>
    );
  }

  const reachability = deriveReachabilityStatus({
    platform,
    hasPat: view.hasPat,
    solutionCount,
    error: reachError,
  });

  const patBadgeClass = view.hasPat
    ? "numbered-section-badge-complete"
    : "numbered-section-badge-current";
  const connBadgeClass =
    solutionCount !== null
      ? "numbered-section-badge-complete"
      : "numbered-section-badge-current";

  return (
    <div className="repositories-screen">
      <section className="numbered-section">
        <div className="numbered-section-head">
          <span className={`numbered-section-badge ${patBadgeClass}`}>1</span>
          <h2 className="numbered-section-title">
            GitHub personal access token
          </h2>
        </div>
        <p className="panel-desc">{policy.rationale}</p>
        <p className="panel-desc">{policy.scopeGuidance}</p>
        {policy.required && !view.hasPat && (
          <p className="connection-notice">
            A token is required on this hosted app before you can browse
            solutions or fetch content.
          </p>
        )}
        {view.hasPat && (
          <div className="status-bar status-bar-ready">
            <span className="status-bar-dot" aria-hidden="true" />
            <span className="status-bar-text">
              GitHub token saved
              {view.login !== "" ? ` (${view.login})` : ""}
            </span>
            {view.canClear && (
              <button
                className="run-button status-bar-action"
                onClick={() => void clear()}
              >
                Clear token
              </button>
            )}
          </div>
        )}
        <div className="form-grid">
          <label className="field">
            <span className="field-label">
              {view.hasPat
                ? "Replace token (leave blank to keep the current one)"
                : "GitHub personal access token"}
            </span>
            <input
              type="password"
              value={form.value}
              onChange={(e) => dispatch({ type: "edit", value: e.target.value })}
              autoComplete="new-password"
              spellCheck={false}
              placeholder={
                view.hasPat ? "stored - enter a new token to replace" : "github_pat_... or ghp_..."
              }
            />
            {view.formatHint !== "" && (
              <span className="field-hint">{view.formatHint}</span>
            )}
            <span className="field-hint">
              The token is validated against GitHub, then stored encrypted and
              write-only - it is never shown again and never reaches the browser.
            </span>
          </label>
        </div>
        <div className="panel-controls">
          <button
            className="next-action-button"
            onClick={() => void save()}
            disabled={!view.canSubmit}
          >
            {view.busy ? "Validating..." : view.submitLabel}
          </button>
          {view.canClear && !view.hasPat && (
            <button className="run-button" onClick={() => void clear()}>
              Clear token
            </button>
          )}
        </div>
        {view.error !== "" && <pre className="result">{view.error}</pre>}
        <div className="panel-controls">
          <button
            className="run-button"
            onClick={() => setWalkthroughOpen((open) => !open)}
          >
            {walkthroughOpen ? "Hide" : "Show"} instructions for creating a token
          </button>
        </div>
        {walkthroughOpen && (
          <div className="discovery-result">
            <span className="field-label">
              Create a fine-grained personal access token
            </span>
            <ol className="setup-steps">
              {PAT_WALKTHROUGH_STEPS.map((step, index) => (
                <li key={index}>{step}</li>
              ))}
            </ol>
            <p className="panel-desc">
              Paste it into the field above and click {view.submitLabel}. Classic
              tokens (ghp_...) also work - only public_repo scope is needed. The
              token is never written to disk in plaintext.
            </p>
          </div>
        )}
      </section>

      <section className="numbered-section">
        <div className="numbered-section-head">
          <span className={`numbered-section-badge ${connBadgeClass}`}>2</span>
          <h2 className="numbered-section-title">Sentinel content</h2>
        </div>
        <p className="panel-desc">
          Fetches Solution definitions and analytic content from GitHub over the
          REST API - no git install or clone. The count is a live reachability +
          token check, not a bulk mirror.
        </p>
        <div className={`reachability reachability-${reachability.tone}`}>
          <span className="reachability-dot" aria-hidden="true" />
          <div>
            <span className="reachability-label">{reachability.label}</span>
            <p className="panel-desc">{reachability.detail}</p>
          </div>
        </div>
        <div className="panel-controls">
          <button
            className="next-action-button"
            onClick={() => void checkConnection()}
            disabled={checking || content === undefined}
          >
            {checking ? "Checking..." : "Refresh"}
          </button>
        </div>
      </section>
    </div>
  );
}
