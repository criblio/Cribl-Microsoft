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

import { useMemo } from "react";
import type { GapFieldMapping, GapReport } from "@soc/core";
import { InfoTip } from "../../components/info-tip";
import {
  derivePipelinePreview,
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
        approved,
      }),
    [
      solutionName,
      packName,
      version,
      reports,
      mappingOverrides,
      sampleFormats,
      approved,
    ],
  );

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
              Pipeline: <code>{table.pipelineName}</code>
            </span>
            <span>
              Stream: <code>{table.streamName}</code>
            </span>
            <span>{table.fieldCount} field(s)</span>
            {table.routeCondition !== "true" && (
              <span>
                Route filter: <code>{table.routeCondition}</code>
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
