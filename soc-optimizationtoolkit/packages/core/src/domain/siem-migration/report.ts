/**
 * SIEM Migration report generator (porting-plan Unit 26): the styled HTML
 * report, ported verbatim from the legacy siem-migration.ts (lines 731-838)
 * with the Unit-26 corrections: PURE string generation (the shell delivers
 * it as a client-side Blob/ArtifactSink download in BOTH shells - the
 * legacy wrote to ~/Downloads from the Electron main process) and the
 * generation date INJECTED (core never reads a clock). The catalog's
 * "Markdown" label was wrong - the implementation always was HTML.
 *
 * Pure: no IO, no fetch, no React, no Date/crypto.
 */

import type { MigrationPlan } from "./models";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The report's download file name. */
export function migrationReportFileName(
  plan: MigrationPlan,
  dateIso: string,
): string {
  return `siem-migration-report-${plan.platform}-${dateIso.split("T")[0]}.html`;
}

/**
 * Generate the styled HTML report. `dateIso` is the shell-minted generation
 * timestamp (ISO 8601); only its date part renders.
 */
export function generateMigrationReport(
  plan: MigrationPlan,
  dateIso: string,
): string {
  const mapped = plan.dataSources.filter((ds) => ds.sentinelSolution);
  const unmapped = plan.dataSources.filter((ds) => !ds.sentinelSolution);
  const sourcesWithRules = plan.dataSources.filter(
    (ds) => ds.sentinelAnalyticRules.length > 0,
  );
  const date = dateIso.split("T")[0];
  const platform = plan.platform === "splunk" ? "Splunk" : "IBM QRadar";

  const sevColor = (s: string) =>
    s === "High" ? "#ef5350" : s === "Medium" ? "#ffa726" : s === "Low" ? "#4fc3f7" : "#999";
  const confColor = (c: string) =>
    c === "high" ? "#66bb6a" : c === "medium" ? "#4fc3f7" : c === "low" ? "#ffa726" : "#888";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>SIEM Migration Report - ${esc(platform)} - ${date}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0d1117; color: #c9d1d9; margin: 0; padding: 24px; line-height: 1.5; }
  h1 { color: #58a6ff; font-size: 24px; border-bottom: 1px solid #30363d; padding-bottom: 8px; }
  h2 { color: #c9d1d9; font-size: 18px; margin-top: 32px; border-bottom: 1px solid #21262d; padding-bottom: 6px; }
  h3 { color: #8b949e; font-size: 14px; margin-top: 20px; }
  .meta { color: #8b949e; font-size: 13px; margin-bottom: 24px; }
  .meta span { margin-right: 24px; }
  .stats { display: flex; gap: 16px; flex-wrap: wrap; margin: 16px 0; }
  .stat { background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 12px 20px; text-align: center; min-width: 100px; }
  .stat .num { font-size: 28px; font-weight: 700; }
  .stat .label { font-size: 11px; color: #8b949e; text-transform: uppercase; letter-spacing: 0.5px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; margin: 12px 0; }
  th { background: #161b22; color: #8b949e; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; padding: 8px 12px; text-align: left; border-bottom: 1px solid #30363d; }
  td { padding: 6px 12px; border-bottom: 1px solid #21262d; }
  tr:hover { background: rgba(88, 166, 255, 0.04); }
  .badge { display: inline-block; font-size: 10px; font-weight: 700; padding: 2px 8px; border-radius: 10px; }
  .steps { counter-reset: step; list-style: none; padding: 0; }
  .steps li { counter-increment: step; padding: 8px 0 8px 36px; position: relative; color: #c9d1d9; font-size: 14px; }
  .steps li::before { content: counter(step); position: absolute; left: 0; width: 24px; height: 24px; border-radius: 50%; background: #1f6feb; color: #fff; font-size: 12px; font-weight: 700; display: flex; align-items: center; justify-content: center; }
  .unmapped { background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 12px 16px; font-size: 12px; font-family: monospace; max-height: 300px; overflow: auto; }
  .unmapped div { padding: 2px 0; color: #8b949e; }
  .footer { margin-top: 32px; padding-top: 16px; border-top: 1px solid #21262d; font-size: 11px; color: #484f58; }
</style>
</head>
<body>
<h1>SIEM Migration Report</h1>
<div class="meta">
  <span>Source SIEM: <strong>${esc(platform)}</strong></span>
  <span>Export: <strong>${esc(plan.fileName)}</strong></span>
  <span>Generated: <strong>${date}</strong></span>
</div>

<div class="stats">
  <div class="stat"><div class="num" style="color:#c9d1d9">${plan.totalRules}</div><div class="label">Detection Rules</div></div>
  <div class="stat"><div class="num" style="color:#c9d1d9">${plan.dataSources.length}</div><div class="label">Data Sources</div></div>
  <div class="stat"><div class="num" style="color:#66bb6a">${mapped.length}</div><div class="label">Mapped</div></div>
  <div class="stat"><div class="num" style="color:${unmapped.length > 0 ? "#ffa726" : "#8b949e"}">${unmapped.length}</div><div class="label">Unmapped</div></div>
  <div class="stat"><div class="num" style="color:#4fc3f7">${plan.totalSentinelRules}</div><div class="label">Sentinel Rules</div></div>
</div>

<h2>Data Sources</h2>
<table>
<thead><tr><th>Data Source</th><th>Rules</th><th>Sentinel Solution</th><th>Confidence</th><th>Table</th><th>Identifiers</th></tr></thead>
<tbody>
${plan.dataSources
  .map(
    (ds) => `<tr>
  <td style="font-weight:600">${esc(ds.name)}</td>
  <td>${ds.ruleCount}</td>
  <td>${esc(ds.sentinelSolution || "(unmapped)")}</td>
  <td><span class="badge" style="background:${confColor(ds.confidence)}22;color:${confColor(ds.confidence)}">${ds.confidence}</span></td>
  <td style="font-family:monospace;font-size:11px">${esc(ds.sentinelTable || "--")}</td>
  <td style="font-size:11px;color:#8b949e">${esc(ds.platformIdentifiers.slice(0, 3).join(", "))}${ds.platformIdentifiers.length > 3 ? " +" + (ds.platformIdentifiers.length - 3) : ""}</td>
</tr>`,
  )
  .join("\n")}
</tbody>
</table>

${
  sourcesWithRules.length > 0
    ? `
<h2>Matched Sentinel Analytics Rules</h2>
${sourcesWithRules
  .map(
    (ds) => `
<h3>${esc(ds.sentinelSolution)} (${ds.sentinelAnalyticRules.length} rules)</h3>
<table>
<thead><tr><th>Rule Name</th><th>Severity</th><th>Tactics</th></tr></thead>
<tbody>
${ds.sentinelAnalyticRules
  .map(
    (r) => `<tr>
  <td>${esc(r.name)}</td>
  <td><span class="badge" style="background:${sevColor(r.severity)}22;color:${sevColor(r.severity)}">${esc(r.severity)}</span></td>
  <td style="font-size:11px;color:#8b949e">${esc(r.tactics.join(", ") || "--")}</td>
</tr>`,
  )
  .join("\n")}
</tbody>
</table>
`,
  )
  .join("\n")}
`
    : ""
}

${
  plan.unmappedRules.length > 0
    ? `
<h2>Unmapped Rules (${plan.unmappedRules.length})</h2>
<div class="unmapped">
${plan.unmappedRules
  .slice(0, 100)
  .map(
    (r) =>
      `<div><strong>${esc(r.name)}</strong>: ${esc(r.dataSources.join(", ") || "no data source identified")}</div>`,
  )
  .join("\n")}
${plan.unmappedRules.length > 100 ? `<div>... and ${plan.unmappedRules.length - 100} more</div>` : ""}
</div>
`
    : ""
}

<h2>Next Steps</h2>
<ol class="steps">
  <li>Review the identified data sources and confirm the Sentinel solution mappings</li>
  <li>For each mapped data source, open Sentinel Integration and run the guided flow (samples, gap analysis, deploy)</li>
  <li>Upload the exported rules to the Microsoft SIEM Migration tool (security.microsoft.com)</li>
  <li>Deploy the Cribl packs and Sentinel analytics rules in parallel</li>
  <li>Validate data flow end-to-end for each data source</li>
</ol>

<div class="footer">Generated by Cribl SOC Optimization Toolkit</div>
</body>
</html>`;
}
