/**
 * SampleIntakeSection - the Integrate page's Sample Data section body
 * (porting-plan Unit 11 UI, ENG-14/15/18; GUI-06 upload/paste/tag). Slots into
 * the single-page Integrate arc where the Sample Data coming-soon placeholder
 * used to render.
 *
 * SAMPLES COME FROM THE OPERATOR (ADR 0003, 2026-08-18). The Browse Samples
 * modal that used to sit beside Upload/Paste is gone: it picked repo files by
 * scoring their FILENAMES against vendor keywords without ever opening them, so
 * it handed over many files per vendor with no way to tell which fitted the
 * selected solution. What replaces it is not a better picker - it is telling the
 * operator WHICH log types their solution needs (see LogTypeRecommendation) and
 * letting them provide those from their own environment.
 *
 * What it does, all through the TaggedSampleStore port (no direct IO here):
 *   - UPLOAD one or more files (browser File API - works in BOTH shells, no
 *     upload endpoint) and/or PASTE a sample with a log-type name.
 *   - Detect the format ALWAYS FROM THE CONTENT (Cribl capture events unwrap to
 *     their inner _raw first-class) - never a declared format. All parsing is
 *     @soc/core parseSampleContent behind the pure sample-intake-state helpers.
 *   - Show one CHIP per tagged sample: detected format + event/field counts +
 *     the guessed timestamp field, with an expandable field table (name +
 *     inferred type + example) and a raw preview.
 *   - RENAME a log type, which RE-KEYS the tagged-sample store entry AND, via
 *     the onRenameLogType contract, any downstream edits keyed by that log type
 *     (Unit 18 mapping edits) - fixing the legacy orphaning bug.
 *   - REMOVE a tagged sample.
 *
 * UNIT 12 EXTENSION (ENG-16/17, GUI-07): when an intaken sample is detected as
 * headerless positional CSV (isHeaderlessCsvSample), the CsvHeaderDialog opens
 * unasked. Across a MULTI-FILE batch, EVERY headerless CSV is QUEUED for its own
 * turn (the legacy renderer dropped the rest of the batch after the first -
 * fixed and pinned in csv-resolution-state). Applying re-parses the sample via
 * the core parseCsvWithHeaders and re-keys its TaggedSample; skipping keeps the
 * positional _N names. All queue/preview/mismatch decisions are the pure
 * csv-resolution-state helpers.
 *
 * THE CHIP'S OWN OFFER ASKS A DIFFERENT QUESTION - firstUnnamedColumn, not
 * isHeaderlessCsvSample. Volunteering the dialog is for a sample that arrived
 * with no header row at all; the chip button is for one with ANY column still
 * unnamed, which is what a partial definition leaves. The two were the same
 * predicate, so applying a definition that covered most of the columns took the
 * button and its hint away with the job unfinished.
 *
 * SAMPLES ALSO ARRIVE FROM SIBLING PANELS, and until 2026-08-25 they arrived
 * WITHOUT that offer. The capture panel and the Lake panel sit ABOVE this
 * section in IntegrateScreen and write to the SAME store, but the resolution
 * queue is state in here, so nothing they commit could ever reach it: a Lake
 * fetch of a headerless feed landed silently and the operator was never asked to
 * name its columns ("fetching samples from Cribl Lake seems to work but when I
 * click add samples it doesn't give me the preview to modify them"). The
 * arrivalEvent prop is the seam that closes it - see its doc below.
 *
 * COLUMN ORDERS ARE REMEMBERED (vendor-field-definition plan, Gap 3): before the
 * dialog opens, this section reads any order already known for the sample's
 * VENDOR + LOG TYPE and hands it over as the dialog's pre-fill, so a feed named
 * once is not asked about again - and a known vendor arrives pre-filled for the
 * operator to CONFIRM against real values rather than to supply from scratch.
 * On apply the order is remembered, EXCEPT when it is the bundled one the
 * operator merely confirmed. The vendor is named by the curated
 * detectVendorIdentity from the selected solution - the solution names the
 * vendor, it never keys the order. Every decision is @soc/core
 * vendor-field-definitions; the load/save loop is useVendorColumnOrder.
 *
 * AND THE PROVENANCE IS VISIBLE AFTERWARDS (2026-08-26). The notice reached the
 * dialog and stopped there, so once the dialog closed a sample named from a
 * bundled dictionary, one named from the operator's own stored order, and one
 * typed by hand from real values looked identical on the chip - a later reader
 * could not tell whether anyone had ever confirmed those names against values.
 * SampleChipColumnOrder renders the same core sentence on the chip, and only
 * when the sample's fields actually match the order it describes. The dialog
 * also gained the control the notice implied: `forget`, documented as the way
 * back from a mistaken paste, had been written and wired to nothing.
 *
 * The store is keyed by log type with replace-by-logType semantics, so tagging
 * the same log type twice overwrites it (one chip per log type). The pure
 * decisions (chip derivation, dedupe, rename re-key, validation) live in
 * sample-intake-state.ts; this component only renders and drives store IO.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { detectVendorIdentity } from "@soc/core";
import type { ContentCache, TaggedSample, TaggedSampleStore } from "@soc/core";
import {
  chipFromTagged,
  dedupeByLogType,
  fieldRows,
  normalizeLogType,
  rawPreviewLines,
  removeByLogType,
  renameInList,
  tagFileContent,
  tagSampleFromContent,
  upsertSample,
  validateLogType,
  validateRename,
} from "./sample-intake-state";
import { CsvHeaderDialog } from "./csv-header-dialog";
import {
  advanceQueue,
  buildResolutionQueue,
  columnOrderMatchesSample,
  currentItem,
  firstUnnamedColumn,
  isHeaderlessCsvSample,
  isQueueDone,
  queuePosition,
  resolveHeaders,
  singleItemQueue,
} from "./csv-resolution-state";
import type { CsvResolutionQueue } from "./csv-resolution-state";
import { useVendorColumnOrder } from "./use-vendor-column-order";

/**
 * One batch of samples a SIBLING panel just wrote to the store, announced to
 * this section so it can react once (see SampleIntakeSectionProps.arrivalEvent).
 */
export interface SampleArrivalEvent {
  /**
   * Bumped ONCE per commit by the parent. It is what makes this an event rather
   * than a state: the section remembers the last nonce it acted on, so a
   * re-render carrying the same batch does nothing.
   */
  nonce: number;
  /** The samples that batch wrote, in acquisition order. */
  samples: readonly TaggedSample[];
}

export interface SampleIntakeSectionProps {
  /** The tagged-sample store this section reads and writes. */
  store: TaggedSampleStore;
  /**
   * The selected Sentinel solution's name, used ONLY to name the vendor a
   * column order belongs to (via the curated detectVendorIdentity). The order
   * itself is keyed to VENDOR + LOG TYPE, never to the solution - a PAN-OS
   * TRAFFIC column order is true whichever solution is selected. With no
   * solution, or an un-curated one, no vendor can be named and nothing is
   * remembered: absent is absent.
   */
  solutionName?: string;
  /**
   * Where remembered column orders live (ports.contentCache). Undefined in a
   * shell that binds no cache - the dialog then still pre-fills from the
   * BUNDLED orders and simply remembers nothing.
   */
  definitionCache?: ContentCache;
  /**
   * Report the current tagged-sample list after every change (initial load,
   * add, rename, remove) so the page can derive samplesProvided for the
   * integrate-arc (Samples pill + Sample Data completion). Called with a fresh
   * array each time.
   */
  onSamplesChange?: (samples: TaggedSample[]) => void;
  /**
   * Rename contract, invoked AFTER the store entry is re-keyed: downstream
   * consumers (Unit 18 mapping edits) re-key their own state keyed by log type
   * here. This is what fixes the legacy orphaning bug end to end - the section
   * re-keys the sample, the callback re-keys everything else.
   */
  onRenameLogType?: (from: string, to: string) => void;
  /**
   * Samples that landed in the store through a SIBLING acquisition panel - the
   * capture panel or the Lake panel - rather than through the paste/upload
   * controls in here.
   *
   * WHY THE PROP EXISTS. Paste and upload own the whole path from "a sample was
   * tagged" to "the operator is asked to name its positional columns", because
   * the resolution queue is state in this component. The acquisition panels are
   * SIBLINGS rendered above this section, so they can reach the store and not
   * the queue: they committed headerless CSV and offered nothing, which is the
   * live defect this closes. The parent cannot fix that by lifting the queue -
   * the dialog belongs beside the chips it edits - so it announces the arrival
   * instead and this section does what upload already does with a batch.
   *
   * WHY AN EVENT RATHER THAN A LIST. Handed the current sample list, this
   * section would have to guess which entries are new, and every unrelated
   * refresh of that list would look like an arrival - re-opening the dialog on
   * a refresh is worse than never opening it. A nonce plus its payload,
   * consumed once against a remembered nonce, is the shape this screen already
   * uses for exactly this (MappingReviewSection's renameEvent and
   * dropUnneededEvent), so it is reused rather than reinvented.
   */
  arrivalEvent?: SampleArrivalEvent;
}

export function SampleIntakeSection({
  store,
  solutionName = "",
  definitionCache,
  onSamplesChange,
  onRenameLogType,
  arrivalEvent,
}: SampleIntakeSectionProps) {
  const [samples, setSamples] = useState<TaggedSample[] | null>(null);
  const [loadError, setLoadError] = useState("");

  const [pasteText, setPasteText] = useState("");
  const [pasteLogType, setPasteLogType] = useState("");
  const [pasteError, setPasteError] = useState("");

  const [uploadError, setUploadError] = useState("");
  const [busy, setBusy] = useState(false);

  const [renaming, setRenaming] = useState<{ from: string; value: string } | null>(
    null,
  );
  const [renameError, setRenameError] = useState("");

  // CSV header-resolution queue (Unit 12): non-null while the dialog is open.
  // A multi-file batch queues EVERY headerless CSV; the per-chip affordance
  // opens a single-item queue. null = no dialog.
  const [csvQueue, setCsvQueue] = useState<CsvResolutionQueue | null>(null);
  // Bumped when the operator FORGETS a saved column order, purely to re-key the
  // dialog. The dialog seeds its header box once at mount (deliberately - a
  // late load must not overwrite typing), so the only honest way to show the
  // bundled order that now answers is to give it a fresh dialog. Discarding
  // what was typed is the point: forgetting is the way back from a mistaken
  // paste, and the paste is what is being taken back.
  const [prefillEpoch, setPrefillEpoch] = useState(0);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // The item the dialog is (about to be) resolving, and the remembered column
  // order for ITS vendor + log type. The vendor comes from ONE place - the
  // curated detectVendorIdentity - which is what lets the store key on a
  // canonical name rather than on whatever the solution happened to be called.
  const csvItem = csvQueue === null ? null : currentItem(csvQueue);
  const vendor = useMemo(
    () => detectVendorIdentity(solutionName)?.vendor ?? "",
    [solutionName],
  );
  const columnOrder = useVendorColumnOrder(
    definitionCache,
    vendor,
    csvItem?.logType ?? "",
  );
  // Destructured so the apply callback depends on the STABLE persister rather
  // than on the state object, which is rebuilt every render.
  const { remember: rememberColumnOrder, forget: forgetColumnOrder } =
    columnOrder;

  const forgetSavedOrder = useCallback(() => {
    forgetColumnOrder();
    setPrefillEpoch((epoch) => epoch + 1);
  }, [forgetColumnOrder]);

  // Keep the reporter callback in a ref so the load effect does not re-run when
  // the parent passes a fresh callback identity each render.
  const reportRef = useRef(onSamplesChange);
  reportRef.current = onSamplesChange;

  // Commit a new list to state and report it upward in one place.
  const commit = useCallback((next: TaggedSample[]) => {
    setSamples(next);
    reportRef.current?.(next);
  }, []);

  // Load the store once on mount (and when the store identity changes - e.g. a
  // connection switch remounts with a fresh adapter).
  const load = useCallback(async () => {
    setSamples(null);
    setLoadError("");
    try {
      const list = await store.list();
      commit(dedupeByLogType(list));
    } catch (err) {
      setLoadError(String(err));
    }
  }, [store, commit]);

  useEffect(() => {
    void load();
  }, [load]);

  // ---- Arrival from a sibling acquisition panel (the Lake/capture seam) ----
  // Seeded with the CURRENT nonce, not with -1: this section is remounted by
  // key when the solution changes, and an event already consumed before that
  // remount must not re-open its dialog on the way back.
  const lastArrivalNonce = useRef<number>(arrivalEvent?.nonce ?? -1);
  useEffect(() => {
    if (arrivalEvent === undefined) {
      return;
    }
    if (arrivalEvent.nonce === lastArrivalNonce.current) {
      return;
    }
    lastArrivalNonce.current = arrivalEvent.nonce;
    // RE-READ THE STORE FIRST. This section holds its own copy of the list and
    // a sibling just wrote behind its back, so that copy is now short by
    // exactly the arrivals. Leaving it short would not merely hide chips: the
    // next write from in here - applying resolved headers, a rename, a remove -
    // rebuilds the reported list from this copy, so it would report the
    // arrivals away again while they sat in the store.
    void load();
    // Then offer resolution for the headerless arrivals, ONE TURN EACH, which
    // is the batch behaviour a multi-file upload has had since Unit 12. A batch
    // with nothing headerless in it builds a queue that is already done, and
    // opens nothing.
    const queue = buildResolutionQueue(arrivalEvent.samples);
    if (!isQueueDone(queue)) {
      setCsvQueue(queue);
    }
  }, [arrivalEvent, load]);

  // Persist an upserted sample and reflect it in the list.
  const persistUpsert = useCallback(
    async (sample: TaggedSample) => {
      await store.upsert(sample);
      commit(upsertSample(samples ?? [], sample));
    },
    [store, samples, commit],
  );

  const addFromPaste = useCallback(async () => {
    const reason = validateLogType(pasteLogType);
    if (reason !== null) {
      setPasteError(reason);
      return;
    }
    if (pasteText.trim() === "") {
      setPasteError("Paste at least one event.");
      return;
    }
    setBusy(true);
    setPasteError("");
    try {
      const sample = tagSampleFromContent(
        normalizeLogType(pasteLogType),
        pasteText,
        "pasted",
      );
      await persistUpsert(sample);
      setPasteText("");
      setPasteLogType("");
      // Headerless positional CSV: offer header resolution for this sample.
      if (isHeaderlessCsvSample(sample)) {
        setCsvQueue(singleItemQueue(sample));
      }
    } catch (err) {
      setPasteError(String(err));
    } finally {
      setBusy(false);
    }
  }, [pasteLogType, pasteText, persistUpsert]);

  const addFromFiles = useCallback(
    async (files: FileList) => {
      setBusy(true);
      setUploadError("");
      const problems: string[] = [];
      // Fold upserts so multiple files auto-detecting the SAME log type replace
      // rather than duplicate (dedupe-by-logType).
      let next = samples ?? [];
      // Track every sample tagged in THIS batch so the CSV resolver can queue
      // ALL headerless CSVs (the legacy silent-drop fix), not just the first.
      const added: TaggedSample[] = [];
      for (const file of Array.from(files)) {
        try {
          const content = await file.text();
          const sample = tagFileContent(content, file.name);
          await store.upsert(sample);
          next = upsertSample(next, sample);
          added.push(sample);
        } catch (err) {
          problems.push(`${file.name}: ${String(err)}`);
        }
      }
      commit(next);
      if (problems.length > 0) {
        setUploadError(problems.join("\n"));
      }
      // Queue every headerless CSV in the batch for its own resolution turn.
      const queue = buildResolutionQueue(added);
      if (!isQueueDone(queue)) {
        setCsvQueue(queue);
      }
      setBusy(false);
      // Reset the input so re-selecting the same file re-fires onChange.
      if (fileInputRef.current !== null) {
        fileInputRef.current.value = "";
      }
    },
    [samples, store, commit],
  );

  const removeSample = useCallback(
    async (logType: string) => {
      setBusy(true);
      try {
        await store.remove(logType);
        commit(removeByLogType(samples ?? [], logType));
      } catch (err) {
        setLoadError(String(err));
      } finally {
        setBusy(false);
      }
    },
    [store, samples, commit],
  );

  const commitRename = useCallback(async () => {
    if (renaming === null) {
      return;
    }
    const current = samples ?? [];
    const check = validateRename(current, renaming.from, renaming.value);
    if (!check.ok) {
      setRenameError(check.reason);
      return;
    }
    const from = renaming.from;
    const to = normalizeLogType(renaming.value);
    const original = current.find((s) => s.logType === from);
    if (original === undefined) {
      setRenaming(null);
      return;
    }
    setBusy(true);
    setRenameError("");
    try {
      // Re-key the store entry: write the renamed sample, then drop the old
      // key. A colliding target is overwritten (one chip per log type).
      await store.upsert({ ...original, logType: to });
      if (from !== to) {
        await store.remove(from);
      }
      commit(renameInList(current, from, to));
      // Re-key downstream edits keyed by log type (the orphaning-bug fix).
      onRenameLogType?.(from, to);
      setRenaming(null);
    } catch (err) {
      setRenameError(String(err));
    } finally {
      setBusy(false);
    }
  }, [renaming, samples, store, commit, onRenameLogType]);

  // Advance the CSV resolution queue after an apply or a skip; close when done.
  const advanceCsvQueue = useCallback(() => {
    setCsvQueue((current) => {
      if (current === null) {
        return null;
      }
      const next = advanceQueue(current);
      return isQueueDone(next) ? null : next;
    });
  }, []);

  // Apply resolved headers to the current queued item: re-parse via the core
  // parseCsvWithHeaders (in resolveHeaders) and upsert the re-keyed sample,
  // REPLACING its positional-named chip; then advance the queue.
  const applyCsvHeaders = useCallback(
    async (headers: string[]) => {
      if (csvQueue === null) {
        return;
      }
      const item = currentItem(csvQueue);
      if (item === null) {
        setCsvQueue(null);
        return;
      }
      setBusy(true);
      try {
        const resolved = resolveHeaders(item, headers);
        await store.upsert(resolved);
        commit(upsertSample(samples ?? [], resolved));
        // REMEMBER the order for this vendor + log type, so the same feed
        // acquired next week is not asked again. A bundled order the operator
        // merely confirmed stores nothing - remember() refuses it, because the
        // app supplied those names and assent is not knowledge. Persisting is
        // fire-and-forget: a failed write must never fail the apply.
        rememberColumnOrder(headers);
      } catch (err) {
        setUploadError(`Header resolution failed: ${String(err)}`);
      } finally {
        setBusy(false);
      }
      advanceCsvQueue();
    },
    [csvQueue, store, samples, commit, advanceCsvQueue, rememberColumnOrder],
  );

  return (
    <div className="sample-intake">
      <p className="panel-desc">
        Provide representative events per log type. Paste a sample and name its
        log type, or upload one or more files. The format is detected from the
        content - Cribl capture events are unwrapped to their inner _raw - and
        the discovered fields drive the gap analysis and pipeline generation.
        Samples are optional for the native-table deploy below; they enrich the
        content-driven flow.
      </p>

      {/* Paste + name + upload: one intake block (paste on the left, the log-type
          name and the Add Sample / Upload Files actions grouped), matching the
          reference's Sample Data layout. The native file input stays in the DOM
          (works in both shells) but is visually hidden and driven by the ghost
          Upload Files button, so both actions read as buttons. */}
      <div className="sample-intake-input">
        <span className="field-label">Paste a sample</span>
        <textarea
          className="sample-paste"
          value={pasteText}
          onChange={(e) => setPasteText(e.target.value)}
          placeholder="Paste one or more events (JSON, NDJSON, CEF, LEEF, CSV, key=value, syslog, or a Cribl capture)..."
          spellCheck={false}
          rows={5}
          disabled={busy}
        />
        <label className="field">
          <span className="field-label">Log type name</span>
          <input
            type="text"
            value={pasteLogType}
            onChange={(e) => setPasteLogType(e.target.value)}
            placeholder="e.g. Traffic, DNS, Audit"
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
          />
        </label>
        {/* The native file input is driven by the visible Browse button; the
            .sample-file-input class owns its display:none (no inline styles). */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="sample-file-input"
          onChange={(e) => {
            if (e.target.files !== null && e.target.files.length > 0) {
              void addFromFiles(e.target.files);
            }
          }}
          disabled={busy}
          tabIndex={-1}
          aria-hidden="true"
        />
        <div className="panel-controls">
          <button
            className="next-action-button"
            onClick={() => void addFromPaste()}
            disabled={busy}
          >
            Add Sample
          </button>
          <button
            className="run-button"
            onClick={() => fileInputRef.current?.click()}
            disabled={busy}
          >
            Upload Files
          </button>
          {pasteError !== "" && <span className="field-hint">{pasteError}</span>}
        </div>
        <span className="field-hint">
          Upload one or more files instead of pasting: the log type is
          auto-detected from each filename and content; rename it on the chip
          afterwards.
        </span>
        {uploadError !== "" && <pre className="result">{uploadError}</pre>}
      </div>

      {/* Tagged sample chips */}
      {loadError !== "" && (
        <div className="sample-intake-input">
          <pre className="result">Could not load samples: {loadError}</pre>
          <button className="run-button" onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}
      {samples === null && loadError === "" && (
        <p className="field-hint">Loading tagged samples...</p>
      )}
      {samples !== null && samples.length === 0 && (
        <p className="field-hint">
          No samples tagged yet. Upload or paste one above.
        </p>
      )}
      {samples !== null && samples.length > 0 && (
        <div className="sample-chip-list">
          {samples.map((sample) => {
            const chip = chipFromTagged(sample);
            const rows = fieldRows(sample.parsed);
            const preview = rawPreviewLines(sample);
            const isRenaming = renaming?.from === sample.logType;
            // "Are any columns still unnamed?", NOT "did this arrive with no
            // header row?". The second question is right for volunteering the
            // dialog on intake and wrong for the chip: it needs a MAJORITY of
            // positional fields, so applying a definition that covered most of
            // the columns removed the affordance to finish the rest.
            // "" when every column has a name. Naming the FIRST one that does
            // not lets the hint point at a column really in this sample rather
            // than illustrating with a `_0` that may already be named.
            const firstUnnamed = firstUnnamedColumn(sample);
            return (
              <div className="sample-chip" key={sample.logType}>
                <div className="sample-chip-head">
                  <span className="sample-chip-format">
                    {chip.format.toUpperCase()}
                  </span>
                  {isRenaming ? (
                    <span className="sample-chip-rename">
                      <input
                        type="text"
                        value={renaming.value}
                        onChange={(e) =>
                          setRenaming({
                            from: sample.logType,
                            value: e.target.value,
                          })
                        }
                        autoComplete="off"
                        spellCheck={false}
                        aria-label="New log type name"
                      />
                      <button
                        className="run-button"
                        onClick={() => void commitRename()}
                        disabled={busy}
                      >
                        Save
                      </button>
                      <button
                        className="run-button"
                        onClick={() => {
                          setRenaming(null);
                          setRenameError("");
                        }}
                        disabled={busy}
                      >
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <span className="sample-chip-name">{sample.logType}</span>
                  )}
                  <span className="sample-chip-counts">
                    {chip.eventCount} event{chip.eventCount === 1 ? "" : "s"},{" "}
                    {chip.fieldCount} field{chip.fieldCount === 1 ? "" : "s"}
                    {chip.timestampField !== undefined
                      ? `, time: ${chip.timestampField}`
                      : ""}
                  </span>
                  {!isRenaming && (
                    <span className="sample-chip-actions">
                      {firstUnnamed !== "" && (
                        <button
                          className="run-button"
                          onClick={() =>
                            setCsvQueue(singleItemQueue(sample))
                          }
                          disabled={busy}
                          title="Name the positional CSV columns"
                        >
                          Name columns
                        </button>
                      )}
                      <button
                        className="run-button"
                        onClick={() => {
                          setRenaming({
                            from: sample.logType,
                            value: sample.logType,
                          });
                          setRenameError("");
                        }}
                        disabled={busy}
                      >
                        Rename
                      </button>
                      <button
                        className="run-button"
                        onClick={() => void removeSample(sample.logType)}
                        disabled={busy}
                      >
                        Remove
                      </button>
                    </span>
                  )}
                </div>
                {firstUnnamed !== "" && !isRenaming && (
                  <p className="field-hint">
                    Some columns are still unnamed ({firstUnnamed} and so on).
                    Name them so the gap analysis can match them to the
                    destination schema.
                  </p>
                )}
                {/* WHERE THESE COLUMN NAMES CAME FROM. Without it, a sample
                    named from a bundled vendor dictionary, one named from the
                    operator's own remembered order, and one typed by hand from
                    real values are indistinguishable afterwards - so a later
                    reader seeing `receive_time / src / dst` cannot tell whether
                    anyone ever confirmed those names against values, which is
                    exactly the off-by-one the preview surface exists to expose.
                    core describeColumnOrder returns plain text for precisely
                    this second caller. */}
                {!isRenaming && (
                  <SampleChipColumnOrder
                    cache={definitionCache}
                    vendor={vendor}
                    sample={sample}
                  />
                )}
                {isRenaming && renameError !== "" && (
                  <p className="field-hint">{renameError}</p>
                )}
                {sample.parsed.errors.length > 0 && (
                  <p className="field-hint">
                    Parse notes: {sample.parsed.errors.join("; ")}
                  </p>
                )}
                <details className="sample-chip-detail">
                  <summary>
                    Fields ({rows.length}) and raw preview
                  </summary>
                  <div className="sample-field-table-wrap">
                    <table className="sample-field-table">
                      <thead>
                        <tr>
                          <th>Field</th>
                          <th>Type</th>
                          <th>Example</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((row) => (
                          <tr key={row.name}>
                            <td>{row.name}</td>
                            <td>{row.type}</td>
                            <td className="sample-field-example">
                              {row.example}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {preview.length > 0 && (
                    <pre className="result sample-raw-preview">
                      {preview.join("\n")}
                    </pre>
                  )}
                </details>
              </div>
            );
          })}
        </div>
      )}

      {/* CSV header-resolution dialog (Unit 12). Keyed by queue index so each
          queued file gets a fresh dialog (transient tab/paste state resets).
          HELD BACK until the remembered column order for this item's vendor +
          log type has been read: the dialog seeds its header box ONCE at mount,
          so opening before the read lands would show an empty box and then be
          unable to fill it without overwriting whatever the operator had
          started typing. The wait is one KV read, and only when a cache is
          bound and the scope can be named. */}
      {csvQueue !== null &&
        !columnOrder.loading &&
        csvItem !== null && (
          <CsvHeaderDialog
            key={`${csvQueue.index}-${prefillEpoch}`}
            item={csvItem}
            position={queuePosition(csvQueue)}
            onApply={(headers) => void applyCsvHeaders(headers)}
            onSkip={advanceCsvQueue}
            busy={busy}
            {...(columnOrder.resolved === null
              ? {}
              : {
                  prefill: {
                    columns: columnOrder.resolved.columns,
                    notice: columnOrder.notice,
                  },
                })}
            {...(columnOrder.resolved?.source === "operator"
              ? // Only a STORED order can be forgotten. Offering the control for
                // a bundled pre-fill would be a button that does nothing: with
                // nothing stored, the bundled order is already what answers.
                { onForgetSavedOrder: forgetSavedOrder }
              : {})}
          />
        )}
    </div>
  );
}

/**
 * The provenance line on one chip: where this sample's column names came from.
 *
 * ITS OWN COMPONENT because it needs a hook per sample - the remembered order is
 * scoped to VENDOR + LOG TYPE, and the chips are a list. The section's own
 * useVendorColumnOrder is scoped to the queued item and cannot answer for a chip
 * that is not in the dialog.
 *
 * IT STAYS SILENT UNLESS IT MATCHES. A remembered or bundled order exists for a
 * scope whether or not THIS sample was ever named from it, so
 * columnOrderMatchesSample checks that the sample really carries those names
 * before attributing them. Captioning a hand-typed sample with somebody else's
 * provenance would be the same failure as inventing a column name - a confident
 * wrong answer where an honest silence was available.
 */
function SampleChipColumnOrder({
  cache,
  vendor,
  sample,
}: {
  cache: ContentCache | undefined;
  vendor: string;
  sample: TaggedSample;
}) {
  const { resolved, notice, loading } = useVendorColumnOrder(
    cache,
    vendor,
    sample.logType,
  );
  if (
    loading ||
    resolved === null ||
    notice === "" ||
    !columnOrderMatchesSample(resolved.columns, sample)
  ) {
    return null;
  }
  return (
    <p className="field-hint sample-chip-provenance">Column names: {notice}</p>
  );
}
