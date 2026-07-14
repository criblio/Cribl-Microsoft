/**
 * CsvHeaderDialog - the headerless-CSV column-resolution dialog (porting-plan
 * Unit 12 UI, GUI-07). Rendered by the Sample Data section when an intaken
 * sample is detected as headerless positional CSV (see isHeaderlessCsvSample).
 *
 * TWO TABS for supplying the column names:
 *   (a) Header row  - upload a header file OR paste a header row (one column per
 *       line or comma-separated); both feed the pure parseHeaderFileText.
 *   (b) Feed config - paste a vendor OUTPUT config (Zscaler NSS, PAN-OS syslog
 *       profile, FortiGate, Cloudflare Logpush, CrowdStrike) into a textarea and
 *       recover the fields via the core parseFeedConfig.
 *
 * Once headers are resolved it shows a PREVIEW ZIP (each header aligned to the
 * first data row's value) and a MISMATCH WARNING when the header count differs
 * from the CSV column count. SKIP leaves the sample with its positional _N
 * names; APPLY re-parses through the core parseCsvWithHeaders and re-keys the
 * tagged sample (handled by the section). Both actions advance the resolution
 * queue - the batch never stops after the first file (the legacy silent-drop
 * fix lives in the section's queue).
 *
 * This component owns only transient per-item dialog state (which tab, the
 * pasted text, the resolved headers). The section remounts it per queue item
 * (React key), so that state resets between files. All decisions are the pure
 * csv-resolution-state helpers + the core parseFeedConfig; the only IO is
 * reading an uploaded header file via the browser File API (both shells).
 */

import { useState } from "react";
import { parseFeedConfig } from "@soc/core";
import {
  deriveMismatch,
  parseHeaderFileText,
  previewZip,
} from "./csv-resolution-state";
import type { CsvResolutionItem } from "./csv-resolution-state";

type HeaderTab = "row" | "config";

const PREVIEW_LIMIT = 15;

export interface CsvHeaderDialogProps {
  /** The headerless-CSV sample currently being resolved. */
  item: CsvResolutionItem;
  /** 1-based position in the resolution queue, for the "file N of M" caption. */
  position: { current: number; total: number };
  /** Apply the resolved headers (the section re-parses + re-keys the sample). */
  onApply: (headers: string[]) => void;
  /** Skip this file, keeping its positional _N names; advances the queue. */
  onSkip: () => void;
  /** True while the section persists an apply/skip - buttons disable. */
  busy?: boolean;
}

export function CsvHeaderDialog({
  item,
  position,
  onApply,
  onSkip,
  busy = false,
}: CsvHeaderDialogProps) {
  const [tab, setTab] = useState<HeaderTab>("row");
  const [headerRowText, setHeaderRowText] = useState("");
  const [feedConfigText, setFeedConfigText] = useState("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [sourceLabel, setSourceLabel] = useState("");
  const [readError, setReadError] = useState("");

  const applyHeaderRow = (text: string) => {
    const parsed = parseHeaderFileText(text);
    setHeaders(parsed);
    setSourceLabel(
      parsed.length > 0
        ? `Header row (${parsed.length} columns)`
        : "No column names found - check the header row.",
    );
  };

  const onHeaderFile = async (file: File) => {
    setReadError("");
    try {
      const content = await file.text();
      setHeaderRowText(content);
      applyHeaderRow(content);
    } catch (err) {
      setReadError(String(err));
    }
  };

  const parseConfig = () => {
    const result = parseFeedConfig(feedConfigText);
    setHeaders(result.fields);
    setSourceLabel(
      result.fields.length > 0
        ? `${result.vendor} ${result.feedType} (${result.fields.length} fields)`
        : "No fields detected - check the config format.",
    );
  };

  const mismatch = deriveMismatch(headers.length, item.columnCount);
  const firstRow = item.firstRows[0] ?? "";
  const preview =
    headers.length > 0 ? previewZip(headers, firstRow, PREVIEW_LIMIT) : [];
  const overflow = Math.max(0, headers.length - PREVIEW_LIMIT);
  const hasHeaders = headers.length > 0;

  return (
    <div
      className="csv-dialog-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Resolve headerless CSV columns"
    >
      <div className="csv-dialog">
        <div className="csv-dialog-title">
          Headerless CSV detected ({item.columnCount} columns)
        </div>
        <p className="field-hint">
          {item.sourceName} has no header row. Provide field names so its columns
          map to the destination schema, or skip to keep positional names (_0,
          _1, ...).
          {position.total > 1
            ? ` Resolving file ${position.current} of ${position.total}.`
            : ""}
        </p>

        {/* Tabs */}
        <div className="csv-dialog-tabs" role="tablist">
          {(["row", "config"] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              className={
                tab === t ? "csv-dialog-tab csv-dialog-tab-active" : "csv-dialog-tab"
              }
              onClick={() => setTab(t)}
            >
              {t === "row" ? "Header row" : "Paste feed config"}
            </button>
          ))}
        </div>

        {/* Tab (a): header file / header row */}
        {tab === "row" && (
          <div className="csv-dialog-tabbody">
            <span className="field-hint">
              Upload a header file, or paste the header row below - one column per
              line or comma-separated.
            </span>
            <input
              type="file"
              className="sample-file-input"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file !== undefined) {
                  void onHeaderFile(file);
                }
                e.target.value = "";
              }}
              disabled={busy}
            />
            <textarea
              className="sample-paste"
              value={headerRowText}
              onChange={(e) => setHeaderRowText(e.target.value)}
              placeholder={"time,src,dst,action,app\n\nor one column per line"}
              spellCheck={false}
              rows={3}
              disabled={busy}
            />
            <div className="panel-controls">
              <button
                type="button"
                className="run-button"
                onClick={() => applyHeaderRow(headerRowText)}
                disabled={busy || headerRowText.trim() === ""}
              >
                Use header row
              </button>
            </div>
            {readError !== "" && (
              <span className="field-hint">
                Could not read the header file: {readError}
              </span>
            )}
          </div>
        )}

        {/* Tab (b): paste feed config */}
        {tab === "config" && (
          <div className="csv-dialog-tabbody">
            <span className="field-hint">
              Paste a vendor output feed configuration (Zscaler NSS format string,
              PAN-OS syslog profile, FortiGate, Cloudflare Logpush, CrowdStrike).
            </span>
            <textarea
              className="sample-paste"
              value={feedConfigText}
              onChange={(e) => setFeedConfigText(e.target.value)}
              placeholder={
                "Example Zscaler NSS format:\n%s{datetime},%s{cloudname},%s{host},%d{action},...\n\nor a field list:\ndatetime,cloudname,host,action,..."
              }
              spellCheck={false}
              rows={4}
              disabled={busy}
            />
            <div className="panel-controls">
              <button
                type="button"
                className="run-button"
                onClick={parseConfig}
                disabled={busy || feedConfigText.trim() === ""}
              >
                Parse config
              </button>
            </div>
          </div>
        )}

        {/* Resolved-header status + mismatch warning */}
        {sourceLabel !== "" && (
          <div
            className={
              hasHeaders
                ? "csv-dialog-status csv-dialog-status-ok"
                : "csv-dialog-status csv-dialog-status-warn"
            }
          >
            <span>{sourceLabel}</span>
            {mismatch.mismatch && (
              <span className="csv-dialog-mismatch">
                Header count {mismatch.headerCount} differs from CSV columns{" "}
                {mismatch.columnCount}. Surplus values spill to _extra_N; extra
                headers stay unmapped. Apply anyway or correct the header set.
              </span>
            )}
          </div>
        )}

        {/* Preview zip: header -> first-row value */}
        {preview.length > 0 && (
          <div className="csv-preview-wrap">
            <span className="field-label">
              Preview (first row with headers applied)
            </span>
            <div className="csv-preview">
              {preview.map((row, i) => (
                <div className="csv-preview-row" key={`${row.header}-${i}`}>
                  <span className="csv-preview-header">
                    {row.header}
                    {row.skipped ? " (skipped)" : ""}
                  </span>
                  <span className="csv-preview-value">
                    {row.hasValue ? row.value : "(no value)"}
                  </span>
                </div>
              ))}
              {overflow > 0 && (
                <div className="csv-preview-more">
                  ...and {overflow} more field{overflow === 1 ? "" : "s"}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="csv-dialog-actions">
          <span className="field-hint">
            {hasHeaders
              ? `${headers.length} header${headers.length === 1 ? "" : "s"} ready to apply`
              : "Upload a header file, paste a header row, or parse a feed config."}
          </span>
          <div className="panel-controls">
            <button
              type="button"
              className="run-button"
              onClick={onSkip}
              disabled={busy}
            >
              Skip
            </button>
            <button
              type="button"
              className="next-action-button"
              onClick={() => onApply(headers)}
              disabled={busy || !hasHeaders}
            >
              Apply headers
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
