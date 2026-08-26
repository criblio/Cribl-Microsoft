/**
 * CsvHeaderDialog - the headerless-CSV column-resolution dialog (porting-plan
 * Unit 12 UI, GUI-07). Rendered by the Sample Data section when an intaken
 * sample is detected as headerless positional CSV (see isHeaderlessCsvSample).
 *
 * THREE TABS for supplying the column names:
 *   (a) Header row  - upload a header file OR paste a header row (one column per
 *       line or comma-separated); both feed the pure parseHeaderFileText.
 *   (b) Feed config - paste a vendor OUTPUT config (Zscaler NSS, PAN-OS syslog
 *       profile, FortiGate, Cloudflare Logpush, CrowdStrike) into a textarea and
 *       recover the fields via the core parseFeedConfig.
 *   (c) Name columns - the interactive mapper (step 3 of the plan, "Gap 2"). Both
 *       tabs above assume the operator HAS an artifact; when they have neither
 *       there was no path at all. This one shows every column POSITION beside its
 *       REAL VALUES from the sample and lets them name it directly - naming `_7`
 *       is guesswork, naming the column that reads `192.168.0.2` is not.
 *
 * ALL THREE TABS RENDER INTO ONE LIVE PREVIEW (step 2 of the vendor
 * field-definition plan). The preview is the reason this dialog is safe to use
 * at all:
 *
 *   - Every position shows its name beside the REAL VALUE it takes from the
 *     first data row. Positional mapping is easy to get subtly wrong, and an
 *     off-by-one is invisible in a list of names but obvious next to values. The
 *     case that motivated it: PAN-OS CONFIG emits `1,2021/10/25 20:25:39,,CONFIG`
 *     with an EMPTY serial, so a definition written for the documented column
 *     order shifts every name after position 2 - and the shift is unmissable the
 *     moment `type` reads "" and `subtype` reads "CONFIG".
 *   - The UNMAPPED REMAINDER is listed and counted. A definition covering 12 of
 *     38 columns looks like it covers 12 of 38, instead of looking finished.
 *
 * It is LIVE: the names are re-derived from the visible text on every keystroke
 * (resolveDefinitionSource), so there is no "parse this" button whose result can
 * disagree with what the textarea now says. The active tab IS the definition -
 * what is on screen is what Apply applies.
 *
 * NOTHING HERE INVENTS A NAME. An unmapped position keeps its positional `_N`
 * name and is shown as unmapped, because a name guessed from a value's shape
 * would be confidently wrong and would survive silently into the destination
 * schema, whereas `_17` is visibly unfinished.
 *
 * WHAT THE PREVIEW PROMISES IS WHAT APPLY PRODUCES (2026-08-26). The names on
 * screen ARE the array handed to the core parser - one applicableHeaders call
 * feeds both - so a position shown as `_12 (unmapped)` lands as `_12`, the
 * sample stays recognisable as headerless, and a half-finished definition can
 * be picked up again from the chip. It used to diverge: the surplus values were
 * parked at `_extra_12`, which put three names for the same 26 positions on one
 * screen and quietly removed the way back to this dialog.
 *
 * A MISMATCH WARNING still appears when the header count differs from the CSV
 * column count, ALONGSIDE the coverage count rather than replaced by it: they
 * say different things (see FieldDefinitionPreview.mismatch). It states the one
 * clause its direction makes true. DUPLICATE NAMES are reported on the shared
 * preview too, so the pasted tabs inherit a check that used to exist only in
 * the mapper. SKIP leaves the sample with its positional _N names; APPLY
 * re-parses through the core parseCsvWithHeaders and re-keys the tagged sample
 * (handled by the section). Both actions advance the resolution queue - the
 * batch never stops after the first log type (the legacy silent-drop fix lives
 * in the section's queue).
 *
 * This component owns only transient per-item dialog state (which tab, the two
 * pasted texts, and the mapper's per-column drafts - the headers themselves are
 * DERIVED, never latched). The section remounts it per queue item (React key),
 * so that state resets between files. All decisions are the pure
 * csv-resolution-state and csv-column-mapping helpers; the only IO is reading an
 * uploaded header file via the browser File API (both shells).
 */

import { useMemo, useState } from "react";
import {
  PREVIEW_ROW_LIMIT,
  buildFieldPreview,
  coverageLine,
  mismatchLine,
  resolveDefinitionSource,
} from "./csv-resolution-state";
import type {
  CsvResolutionItem,
  DefinitionTab,
} from "./csv-resolution-state";
import { CsvColumnMapper } from "./csv-column-mapper";
import {
  EMPTY_COLUMN_DRAFTS,
  clearColumnDrafts,
  mapperDefinitionSource,
  setColumnDraft,
} from "./csv-column-mapping";
import type { ColumnDrafts } from "./csv-column-mapping";

/** Tab order and labels - one entry per input path. */
const TABS: ReadonlyArray<{ id: DefinitionTab; label: string }> = [
  { id: "row", label: "Header row" },
  { id: "config", label: "Paste feed config" },
  { id: "map", label: "Name columns" },
];

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
  /**
   * A column order already KNOWN for this sample's vendor and log type, from
   * the remembered-definitions store (vendor-field-definition plan, decision 2:
   * "a known vendor PRE-FILLS the dialog and the operator confirms"). It seeds
   * the header-row box, so the live preview renders it against real values
   * immediately - which is the ONLY reason pre-filling is safe: a bundled order
   * wrong for their firmware stops making sense on screen before anything is
   * applied. Absent when nothing is known; the app never invents one.
   *
   * The seed is ORDINARY TEXT in the textarea, not latched state, so it derives
   * through exactly the same path as a paste and the operator can edit or clear
   * it. `notice` says where it came from and, for an order of theirs that
   * replaced a bundled one, what it replaced (decision 3: they are told).
   */
  prefill?: { columns: readonly string[]; notice: string };
  /**
   * Drop the operator's STORED column order for this vendor + log type, so the
   * bundled one answers again (useVendorColumnOrder.forget).
   *
   * THE OTHER HALF OF DECISION 3. The notice tells the operator their saved
   * order REPLACED the vendor's - and until 2026-08-26 that was all it did.
   * `forget` was written, documented as "the way back from a mistaken paste",
   * and wired to nothing anywhere in the app: the dialog announced a decision
   * the operator could not undo, and re-pasting the bundled order by hand would
   * not have undone it either, because a stored order that MATCHES the bundled
   * one is still a stored order.
   *
   * Passed ONLY when there is a stored order to drop. Forgetting a bundled
   * pre-fill is a no-op dressed as a control, so the button is simply absent
   * then rather than present and inert.
   */
  onForgetSavedOrder?: () => void;
}

export function CsvHeaderDialog({
  item,
  position,
  onApply,
  onSkip,
  busy = false,
  prefill,
  onForgetSavedOrder,
}: CsvHeaderDialogProps) {
  const [tab, setTab] = useState<DefinitionTab>("row");
  // Seeded ONCE, at mount: the section holds the dialog back until the stored
  // order has been read, and remounts it per queue item, so a late load can
  // never overwrite what the operator has since typed.
  const [headerRowText, setHeaderRowText] = useState(() =>
    prefill === undefined ? "" : prefill.columns.join("\n"),
  );
  const [feedConfigText, setFeedConfigText] = useState("");
  const [readError, setReadError] = useState("");
  // The mapper's per-column names, keyed by position and SPARSE: an absent key
  // is a position nobody has named, which is the resting state for most of them.
  const [drafts, setDrafts] = useState<ColumnDrafts>(EMPTY_COLUMN_DRAFTS);

  // The definition is DERIVED from what is visible, not stored. All three inputs
  // are kept (so switching tabs does not destroy a paste or a half-finished
  // mapping) but only the active tab's is in force - see resolveDefinitionSource
  // for why latching was wrong. The mapper derives the same shape from its
  // drafts, so the preview below never branches on which tab supplied the names.
  const source = useMemo(
    () =>
      tab === "map"
        ? mapperDefinitionSource(item, drafts)
        : resolveDefinitionSource(tab, headerRowText, feedConfigText),
    [tab, item, drafts, headerRowText, feedConfigText],
  );
  const preview = useMemo(
    () => buildFieldPreview(source.headers, item, PREVIEW_ROW_LIMIT),
    [source.headers, item],
  );

  const onHeaderFile = async (file: File) => {
    setReadError("");
    try {
      // The file only fills the textarea; the derivation above does the rest,
      // so an uploaded header row and a typed one take the identical path.
      setHeaderRowText(await file.text());
    } catch (err) {
      setReadError(String(err));
    }
  };

  const hasHeaders = source.headers.length > 0;
  const { mismatch } = preview;

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
        {/* "log type N of M", never "file N of M". The queue holds TAGGED
            SAMPLES, one per log type, and a queued one may have arrived as an
            upload, a paste, or a Lake dataset - the case that motivated the
            arrival seam in the first place, whose sourceName is `lake:AUTH`.
            Nothing about that is a file, and the caption used to say so. */}
        <p className="field-hint">
          {item.sourceName} has no header row. Name its columns so they map to
          the destination schema, or skip to keep positional names (_0, _1,
          ...).
          {position.total > 1
            ? ` Naming log type ${position.current} of ${position.total}.`
            : ""}
        </p>

        {/* Where a pre-filled order came from, and what it replaced. Kept above
            the tabs, next to the sentence explaining the dialog, because it is
            about the WHOLE definition rather than about whichever tab is open -
            and because an override must be visible without hunting for it.
            The button beside it is the UNDO for what the sentence announces:
            a notice saying "yours replaced the vendor's" with no way back is
            half a decision. */}
        {prefill !== undefined && prefill.notice !== "" && (
          <p className="field-hint csv-dialog-prefill">
            {prefill.notice}
            {onForgetSavedOrder !== undefined && (
              <button
                type="button"
                className="run-button csv-dialog-forget"
                onClick={onForgetSavedOrder}
                disabled={busy}
                title="Drop the saved column order for this vendor and log type, and start again from the bundled one"
              >
                Forget my saved order
              </button>
            )}
          </p>
        )}

        {/* Tabs */}
        <div className="csv-dialog-tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              className={
                tab === t.id
                  ? "csv-dialog-tab csv-dialog-tab-active"
                  : "csv-dialog-tab"
              }
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Tab (a): header file / header row. No "use this" button - the
            preview below updates as the text changes. */}
        {tab === "row" && (
          <div className="csv-dialog-tabbody">
            <span className="field-hint">
              Upload a header file, or paste the header row below - one column per
              line or comma-separated. The preview updates as you type.
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
            {readError !== "" && (
              <span className="field-hint">
                Could not read the header file: {readError}
              </span>
            )}
          </div>
        )}

        {/* Tab (b): paste feed config - same live derivation, same preview. */}
        {tab === "config" && (
          <div className="csv-dialog-tabbody">
            <span className="field-hint">
              Paste a vendor output feed configuration (Zscaler NSS format string,
              PAN-OS syslog profile, FortiGate, Cloudflare Logpush, CrowdStrike).
              The preview updates as you paste.
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
          </div>
        )}

        {/* Tab (c): the interactive mapper - one row per POSITION, its real
            values, and a box to name it. Feeds the same preview via the same
            derived DefinitionSource; nothing here guesses a name. */}
        {tab === "map" && (
          <CsvColumnMapper
            item={item}
            drafts={drafts}
            onDraftChange={(index, text) =>
              setDrafts((current) => setColumnDraft(current, index, text))
            }
            onClearAll={() => setDrafts(clearColumnDrafts())}
            busy={busy}
          />
        )}

        {/* What the active tab recognized + the mismatch warning. */}
        {source.label !== "" && (
          <div
            className={
              hasHeaders
                ? "csv-dialog-status csv-dialog-status-ok"
                : "csv-dialog-status csv-dialog-status-warn"
            }
          >
            <span>{source.label}</span>
            {/* One clause, the one that applies. A mismatch has a DIRECTION -
                too few names or too many - and the warning used to state both
                consequences for every mismatch, so half of it was always
                describing something that was not happening. */}
            {mismatch.mismatch && (
              <span className="csv-dialog-mismatch">
                {mismatchLine(mismatch)}
              </span>
            )}
          </div>
        )}

        {/* The live preview: every position, its name, and its real value. */}
        <div className="csv-preview-wrap">
          <span className="field-label">
            Preview (first row, names applied)
          </span>
          <span className="csv-preview-coverage">{coverageLine(preview)}</span>
          <div className="csv-preview">
            {preview.rows.map((row) => (
              <div
                className={
                  row.unmapped
                    ? "csv-preview-row csv-preview-row-unmapped"
                    : "csv-preview-row"
                }
                key={row.position}
              >
                <span className="csv-preview-header">
                  {row.header}
                  {row.skipped ? " (skipped)" : ""}
                  {row.unmapped ? " (unmapped)" : ""}
                </span>
                <span className="csv-preview-value">
                  {row.hasValue ? row.value : "(no value)"}
                </span>
              </div>
            ))}
            {preview.hiddenCount > 0 && (
              <div className="csv-preview-more">
                ...and {preview.hiddenCount} more position
                {preview.hiddenCount === 1 ? "" : "s"} not shown
              </div>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="csv-dialog-actions">
          <span className="field-hint">
            {hasHeaders
              ? // COUNT THE COVERAGE, not the array. The mapper hands up one
                // entry per column with positional names parked at the ones
                // nobody named, so `headers.length` would report a 6-of-38
                // mapping as "38 names ready" - the precise false reassurance
                // the preview exists to prevent.
                `${preview.mappedCount} name${preview.mappedCount === 1 ? "" : "s"} ready to apply`
              : "Upload a header file, paste a header row or a feed config, or name the columns yourself."}
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
              onClick={() => onApply(source.headers)}
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
