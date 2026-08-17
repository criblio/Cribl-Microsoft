/**
 * PipelinePreviewSection - the READ-ONLY pipeline preview panel of the Integrate
 * arc (porting-plan Unit 17 UI). It renders, per approved log type, the exact
 * conf.yml a content-driven build would generate (the pipeline functions in
 * order) and the reduction rules WITH their reasons, plus the pack-level
 * route.yml. Generation is pure and lives in @soc/core; this component renders
 * the typed plan + emitted YAML the {@link derivePipelinePreview} projection
 * produces. It owns ZERO decision logic and ZERO IO.
 *
 * It is ADDITIVE and NON-GATING: it consumes the DCR Gap Analysis section's own
 * content-path gate (approved) plus its reports and the reviewer's effective
 * mappings, and mirrors what a build would emit. It reports no readiness and
 * never touches canDeploy / canDeployContentPath. When nothing is approved to
 * preview it shows the always-visible-disabled empty state with the next step.
 *
 * VALIDATOR HONESTY (task item 3): the panel runs the emitted YAML through the
 * core checkCriblYaml validator. A well-formed plan yields zero issues; when the
 * count is non-zero the panel surfaces the exact "Line N: ..." messages rather
 * than hiding them - the honest signal that generation produced something the
 * Cribl loader would reject.
 */

import { useMemo, useState } from "react";
import type {
  CefIdentityOverride,
  GapFieldMapping,
  GapReport,
  LogTypeFieldValues,
} from "@soc/core";
import { InfoTip } from "../../components/info-tip";
import {
  derivePipelinePreview,
  type EnrichmentField,
  type PipelineFunctionLine,
  type ReductionRuleView,
} from "./pipeline-preview-state";

export interface PipelinePreviewSectionProps {
  /** The selected Sentinel solution name (scopes naming + reduction lookup). */
  solutionName: string;
  /** The pack name from the Cribl Configuration section. */
  packName: string;
  /** Optional pack version (defaults to 1.0.0 in the planner). */
  version?: string;
  /** The Unit 18 gap reports (the typed input the preview projects). */
  reports: GapReport[];
  /** The reviewer's effective (edited) mappings keyed by logType. */
  mappingOverrides?: Readonly<Record<string, GapFieldMapping[]>>;
  /** Detected sample format keyed by logType (drives serde/timestamp). */
  sampleFormats?: Readonly<Record<string, string>>;
  /** Observed field values keyed by logType (drives route discrimination). */
  sampleFieldValues?: Readonly<Record<string, LogTypeFieldValues>>;
  /** User-added enrichment constants keyed by logType (merged by the caller). */
  enrichments?: Readonly<Record<string, readonly EnrichmentField[]>>;
  /** Corrected DeviceVendor/DeviceProduct keyed by logType. */
  identityOverrides?: Readonly<Record<string, CefIdentityOverride>>;
  /** Accepted route filters keyed by logType (replace that log type's filter). */
  routeFilterOverrides?: Readonly<Record<string, string>>;
  /**
   * Accept a suggested route filter. Absent = the suggestions render read-only,
   * which is what a caller that cannot persist the choice should do: an Accept
   * button whose result the build would not see is worse than no button.
   */
  onAcceptRouteFilter?: (logType: string, filter: string) => void;
  /**
   * Undo an accepted filter, returning that log type to its placeholder. Absent
   * = accepted filters render without an Undo control.
   */
  onUndoRouteFilter?: (logType: string) => void;
  /** The mapping-review content-path gate (every table approved, not stale). */
  approved: boolean;
}

/** The count summary line under a reduction rule group. */
function ruleKindLabel(kind: ReductionRuleView["kind"]): string {
  if (kind === "keep") return "KEEP";
  if (kind === "drop") return "DROP";
  return "SUPPRESS";
}

/** Render one function line: order, id, group, description. */
function FunctionRow({ fn }: { fn: PipelineFunctionLine }) {
  return (
    <li className="pipeline-preview-func">
      <span className="pipeline-preview-func-order">{fn.index}</span>
      <span className="pipeline-preview-func-id">{fn.id}</span>
      {fn.groupId !== undefined && (
        <span className="pipeline-preview-func-group">{fn.groupId}</span>
      )}
      {fn.description !== undefined && (
        <span className="pipeline-preview-func-desc">{fn.description}</span>
      )}
    </li>
  );
}

/** Render one reduction rule with its reason. */
function ReductionRuleRow({ rule }: { rule: ReductionRuleView }) {
  return (
    <div className={`pipeline-preview-rule pipeline-preview-rule-${rule.kind}`}>
      <div className="pipeline-preview-rule-head">
        <span className={`pipeline-preview-rule-badge rule-kind-${rule.kind}`}>
          {ruleKindLabel(rule.kind)}
        </span>
        <span className="pipeline-preview-rule-desc">{rule.description}</span>
        {rule.kind === "suppress" && (
          <span className="pipeline-preview-rule-supp">
            max {rule.maxEvents}/{rule.windowSec}s
          </span>
        )}
      </div>
      <div className="pipeline-preview-rule-reason">{rule.reason}</div>
      <code className="pipeline-preview-rule-filter">{rule.filter}</code>
    </div>
  );
}

export function PipelinePreviewSection({
  solutionName,
  packName,
  version,
  reports,
  mappingOverrides,
  sampleFormats,
  sampleFieldValues,
  enrichments,
  identityOverrides,
  routeFilterOverrides,
  onAcceptRouteFilter,
  onUndoRouteFilter,
  approved,
}: PipelinePreviewSectionProps) {
  const view = useMemo(
    () =>
      derivePipelinePreview({
        solutionName,
        packName,
        ...(version !== undefined ? { version } : {}),
        reports,
        ...(mappingOverrides !== undefined ? { mappingOverrides } : {}),
        ...(sampleFormats !== undefined ? { sampleFormats } : {}),
        ...(sampleFieldValues !== undefined ? { sampleFieldValues } : {}),
        ...(enrichments !== undefined ? { enrichments } : {}),
        ...(identityOverrides !== undefined ? { identityOverrides } : {}),
        ...(routeFilterOverrides !== undefined ? { routeFilterOverrides } : {}),
        approved,
      }),
    [
      solutionName,
      packName,
      version,
      reports,
      mappingOverrides,
      sampleFormats,
      sampleFieldValues,
      enrichments,
      identityOverrides,
      routeFilterOverrides,
      approved,
    ],
  );

  // Only overrides for log types the CURRENT plan still has. An override left
  // behind by a solution the operator has since changed is not something they
  // accepted here, and offering Undo for a log type that is not on screen
  // would be a control with no visible effect.
  const acceptedFilters = useMemo(() => {
    const entries = Object.entries(routeFilterOverrides ?? {});
    if (entries.length === 0) return entries;
    const present = new Set(view.tables.map((t) => t.logType));
    return entries.filter(([logType]) => present.has(logType));
  }, [routeFilterOverrides, view.tables]);

  // Placeholdered log types the derivation found NOTHING for - no candidate
  // field is constant within them and distinct across their siblings, so there
  // is nothing to suggest and no amount of accepting will conjure one. Measured
  // on Zscaler: 5 of 10. Their only remedy used to be editing route.yml in the
  // Cribl UI after install, which means leaving the app mid-flow to finish the
  // pack it just built.
  const unsuggested = useMemo(() => {
    const suggested = new Set(view.routeFilterSuggestions.map((s) => s.logType));
    return view.placeholderLogTypes.filter((lt) => !suggested.has(lt));
  }, [view.placeholderLogTypes, view.routeFilterSuggestions]);

  // Draft text per log type. Deliberately NOT lifted to the caller: a filter
  // being typed is not a decision yet, and the plan must not re-derive on every
  // keystroke. Only Apply crosses into routeFilterOverrides.
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({});

  if (!view.available) {
    return (
      <div className="pipeline-preview pipeline-preview-empty">
        <p className="field-hint">{view.emptyReason}</p>
      </div>
    );
  }

  return (
    <div className="pipeline-preview">
      <p className="panel-desc">
        The exact Cribl pipeline a content-driven build would generate from the
        approved mappings, one pipeline per log type. Read-only: generation runs
        in the toolkit core; nothing here is deployed until you build and install
        the pack.
      </p>

      {/* Honest validator signal (task item 3). */}
      {view.valid ? (
        <div className="pipeline-preview-valid pipeline-preview-valid-ok">
          Cribl YAML validation passed - every generated conf.yml and route.yml
          is accepted by the Cribl loader.
          <InfoTip text="Each generated YAML file is checked against the Cribl loader's known acceptance rules (no multiline/quoted descriptions, no tabs, filter: not condition:, unquoted field names). Zero issues means the generated pack would load cleanly." />
        </div>
      ) : (
        <div className="pipeline-preview-valid pipeline-preview-valid-bad">
          <strong>
            Cribl YAML validation found {view.totalYamlIssues} issue(s).
          </strong>{" "}
          This should not happen for well-formed input; the exact messages are
          shown with each file below.
        </div>
      )}

      {/*
        Valid YAML is not a working pack. Every route is final, so only the
        first match-all receives events - the rest are silently handled by ITS
        pipeline, with the wrong renames. Without this the green banner above
        is the last word, and the loss only shows up as detections that never
        fire. Measured on Zscaler (7 of 10 log types dead) but generic: it hits
        any vendor whose log types share a schema and differ by field value.
      */}
      {/*
        A placeholder is a TASK, not a defect: the route, pipeline, lookup and
        sample all exist and start working the moment a filter is written. It
        is phrased as work outstanding rather than as a failure, because the
        alternatives the generator rejected were worse - a match-all would have
        run these events through another log type's pipeline, and dropping the
        log type would have removed a path a SOC needs.
      */}
      {view.placeholderLogTypes.length > 0 && (
        <div className="pipeline-preview-valid pipeline-preview-valid-bad">
          <strong>
            {view.placeholderLogTypes.length} log type
            {view.placeholderLogTypes.length === 1 ? "" : "s"}{" "}
            {view.placeholderLogTypes.length === 1 ? "needs" : "need"} a route
            filter before {view.placeholderLogTypes.length === 1 ? "it" : "they"}{" "}
            can receive events.
          </strong>{" "}
          Nothing in these samples separates{" "}
          {view.placeholderLogTypes.join(", ")} from the others, so the pack
          ships them with a placeholder filter that matches nothing. Everything
          else for them is built - pipelines, reduction rules, lookups and
          samples - so replacing each filter in route.yml with an expression
          that identifies that log type is all that is left. Until then those
          events are not routed by this pack; they are NOT being processed by
          another log type&apos;s pipeline, which is what a catch-all would do.
          <InfoTip text="Route filters are derived from fields unique to each log type, then from field values that are constant within one log type and absent from the others. When neither separates them, the generator emits a filter comparing against __UNSET__ - a field no vendor sends - so the route is inert rather than stealing its siblings' events. Edit the filter in the pack's route.yml (Routes tab) and the route starts working; no rebuild is needed." />
        </div>
      )}

      {/*
        The derivation often DID work out a filter and withheld it because the
        samples were too thin to bet a route on. Showing it costs nothing and
        saves the operator rediscovering what the generator already found -
        they know the vendor that three sample events do not describe.

        Never applied AUTOMATICALLY, which is not the same as never applied.
        The generator will not bet a route on three events; the operator can,
        because they know the vendor. Accept is that act, and it writes the
        filter into the same derivation the build reads - so a filter shown
        here and accepted cannot be dropped on the way to route.yml.
      */}
      {view.routeFilterSuggestions.length > 0 && (
        <div className="pipeline-preview-suggestions">
          <span className="field-label">
            Suggested filters, from too few events to apply automatically
            <InfoTip text="These are structurally valid discriminators - a field constant within the log type and different in every sibling that carries it - found in samples too small to trust. A filter that fits three events can be precise on the sample and wrong on live traffic, so the generator will not apply one on its own; it shows you what it found. Accept the ones you recognise as how this vendor labels its log types and they go into the pack's route.yml; leave the rest and edit route.yml by hand. Adding more sample events and re-analyzing applies them without asking." />
          </span>
          {view.routeFilterSuggestions.map((s) => (
            <div className="pipeline-preview-suggestion-row" key={s.logType}>
              <code className="code-chip">{s.logType}</code>
              <code className="pipeline-preview-suggestion-filter">{s.filter}</code>
              {onAcceptRouteFilter !== undefined && (
                <button
                  type="button"
                  className="pipeline-preview-suggestion-accept"
                  onClick={() => onAcceptRouteFilter(s.logType, s.filter)}
                >
                  Accept
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {/*
        The log types with no candidate at all. Accept cannot help them - there
        is nothing to accept - so the only thing that finishes the pack is a
        filter the operator writes. It goes through the SAME override channel
        as an accepted suggestion, so it reaches route.yml by the path that is
        already pinned, and the pack ships complete instead of needing an edit
        in the Cribl UI after install.
      */}
      {unsuggested.length > 0 && onAcceptRouteFilter !== undefined && (
        <div className="pipeline-preview-suggestions">
          <span className="field-label">
            Write a filter for the rest
            <InfoTip text="Nothing in these samples is shaped like a discriminator for these log types - no field is constant within one and different across the others - so there is nothing to suggest. Write an expression that identifies the log type, the same JavaScript Cribl route filters use (for example: event_type === 'dns'). It goes into the pack's route.yml exactly as typed. Leave any of them blank and that log type ships with a placeholder filter you can still edit in Cribl's Routes tab later." />
          </span>
          {unsuggested.map((logType) => {
            const draft = drafts[logType] ?? "";
            const apply = () => {
              const filter = draft.trim();
              if (filter === "") return;
              onAcceptRouteFilter(logType, filter);
            };
            return (
              <div className="pipeline-preview-suggestion-row" key={logType}>
                <code className="code-chip">{logType}</code>
                <input
                  className="pipeline-preview-filter-input"
                  type="text"
                  value={draft}
                  aria-label={`Route filter for ${logType}`}
                  placeholder="event_type === 'dns'"
                  onChange={(e) => {
                    const { value } = e.target;
                    setDrafts((prev) => ({ ...prev, [logType]: value }));
                  }}
                  // Enter applies, because this is a one-field form and
                  // reaching for the mouse to commit one expression is friction
                  // the operator pays once per log type.
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      apply();
                    }
                  }}
                />
                <button
                  type="button"
                  className="pipeline-preview-suggestion-accept"
                  // A blank filter would be applied verbatim and match nothing -
                  // the same inert route the placeholder already is, but without
                  // the banner saying so.
                  disabled={draft.trim() === ""}
                  onClick={apply}
                >
                  Apply
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/*
        Accepted filters leave routeFilterSuggestions (the log type is no longer
        placeholdered), so without this they would vanish with no trace of what
        was applied - the operator could not tell an accepted filter from one
        the generator derived on its own, nor undo it. Listed separately rather
        than left in the suggestions block, because these two ask nothing and
        everything of the reader respectively.
      */}
      {acceptedFilters.length > 0 && (
        <div className="pipeline-preview-suggestions">
          <span className="field-label">
            Route filters you accepted
            <InfoTip text="These filters came from sample evidence the generator judged too thin to apply on its own, and you accepted them. They are in the plan and will be written to the pack's route.yml exactly as shown. Undo returns the log type to a placeholder filter that matches nothing, which is where it started." />
          </span>
          {acceptedFilters.map(([logType, filter]) => (
            <div className="pipeline-preview-suggestion-row" key={logType}>
              <code className="code-chip">{logType}</code>
              <code className="pipeline-preview-suggestion-filter">{filter}</code>
              {onUndoRouteFilter !== undefined && (
                <button
                  type="button"
                  className="pipeline-preview-suggestion-accept"
                  onClick={() => onUndoRouteFilter(logType)}
                >
                  Undo
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {view.unreachableLogTypes.length > 0 && (
        <div className="pipeline-preview-valid pipeline-preview-valid-bad">
          <strong>
            {view.unreachableLogTypes.length} log type
            {view.unreachableLogTypes.length === 1 ? "" : "s"} cannot receive
            events.
          </strong>{" "}
          Nothing in these samples separates {view.unreachableLogTypes.join(", ")}{" "}
          from the others, so their routes match everything and only the first
          such route runs. Their events are not dropped - they are processed by
          that route&apos;s pipeline instead, so they reach Sentinel with the
          wrong field mapping. Give these log types a distinguishing filter in
          route.yml after the build, or drop the ones you do not need.
          <InfoTip text="Route filters are derived from fields unique to each log type. Log types that share a schema and differ only by a field VALUE - an action of ALLOWED vs BLOCKED, a type of TRAFFIC vs THREAT - cannot be separated that way, so they fall back to match-all. Cribl marks the resulting routes with its own unreachable-route warning." />
        </div>
      )}

      {view.tables.map((table) => (
        <div key={table.logType} className="pipeline-preview-card">
          <div className="pipeline-preview-card-head">
            <span className="pipeline-preview-logtype">{table.logType}</span>
            <span className="pipeline-preview-table">{table.tableName}</span>
            <span className="pipeline-preview-dest">{table.destinationId}</span>
            <span className="pipeline-preview-format">{table.sourceFormat}</span>
          </div>

          <div className="pipeline-preview-meta">
            <span>
              Pipeline: <code className="code-chip">{table.pipelineName}</code>
            </span>
            <span>
              Stream: <code className="code-chip">{table.streamName}</code>
            </span>
            <span>{table.fieldCount} field(s)</span>
            {table.routeCondition !== "true" && (
              <span>
                Route filter:{" "}
                <code className="code-chip">{table.routeCondition}</code>
              </span>
            )}
          </div>

          {/* Readable ordered function list. */}
          <div className="pipeline-preview-funcs">
            <div className="pipeline-preview-subhead">
              Pipeline functions (in order)
              <InfoTip text="The Cribl functions this pipeline runs, top to bottom: extraction (parse _raw), field renames/coercions, overflow collection, and cleanup. The full conf.yml is shown below." />
            </div>
            <ol className="pipeline-preview-func-list">
              {table.functions.map((fn) => (
                <FunctionRow key={`${fn.index}-${fn.id}`} fn={fn} />
              ))}
            </ol>
          </div>

          {/* Reduction rules with reasons. */}
          <div className="pipeline-preview-rules">
            <div className="pipeline-preview-subhead">
              Reduction rules
              <InfoTip text="Pre-built volume-reduction rules matched for this table/vendor: KEEP rules protect security-relevant events, DROP rules remove no-analytics-value noise, and SUPPRESS rules aggregate high-volume events. Each carries the reason it exists. Filters address RAW vendor field names and run before any rename." />
            </div>
            {table.hasReductionRules ? (
              <div className="pipeline-preview-rule-list">
                {table.reductionRules.map((rule) => (
                  <ReductionRuleRow key={rule.id} rule={rule} />
                ))}
              </div>
            ) : (
              <p className="field-hint">
                No pre-built reduction rules matched this table or vendor. The
                reduction pipeline is a no-op scaffold with guidance comments;
                the transform pipeline still applies.
              </p>
            )}
          </div>

          {/* The verbatim generated conf.yml. */}
          <details className="pipeline-preview-conf">
            <summary>Transform conf.yml ({table.pipelineName})</summary>
            <pre className="result pipeline-preview-yaml">
              {table.transformConf}
            </pre>
          </details>
          <details className="pipeline-preview-conf">
            <summary>
              Reduction conf.yml ({table.reductionPipelineId})
            </summary>
            <pre className="result pipeline-preview-yaml">
              {table.reductionConf}
            </pre>
          </details>

          {table.yamlIssues.length > 0 && (
            <pre className="result pipeline-preview-issues">
              {table.yamlIssues.join("\n")}
            </pre>
          )}
        </div>
      ))}

      {/* Pack-level route.yml. */}
      <div className="pipeline-preview-card">
        <div className="pipeline-preview-subhead">
          Routes (route.yml)
          <InfoTip text="Each log type gets a pair of routes: a Reduction + Transform route (enabled when reduction rules exist) and a Transform-only route (disabled when a reduction route exists). To skip reduction, disable the reduction route and enable the passthrough route." />
        </div>
        <details className="pipeline-preview-conf" open>
          <summary>route.yml</summary>
          <pre className="result pipeline-preview-yaml">{view.routeYml}</pre>
        </details>
        {view.routeYmlIssues.length > 0 && (
          <pre className="result pipeline-preview-issues">
            {view.routeYmlIssues.join("\n")}
          </pre>
        )}
      </div>
    </div>
  );
}
