/**
 * SampleIntakeSection - the Integrate page's Sample Data section body
 * (porting-plan Unit 11 UI, ENG-14/15/18; GUI-06 upload/paste/tag portions -
 * the browse modal arrives in Unit 16). Slots into the single-page Integrate
 * arc where the Sample Data coming-soon placeholder used to render.
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
 * The store is keyed by log type with replace-by-logType semantics, so tagging
 * the same log type twice overwrites it (one chip per log type). The pure
 * decisions (chip derivation, dedupe, rename re-key, validation) live in
 * sample-intake-state.ts; this component only renders and drives store IO.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { TaggedSample, TaggedSampleStore } from "@soc/core";
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

export interface SampleIntakeSectionProps {
  /** The tagged-sample store this section reads and writes. */
  store: TaggedSampleStore;
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
}

export function SampleIntakeSection({
  store,
  onSamplesChange,
  onRenameLogType,
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

  const fileInputRef = useRef<HTMLInputElement | null>(null);

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
      for (const file of Array.from(files)) {
        try {
          const content = await file.text();
          const sample = tagFileContent(content, file.name);
          await store.upsert(sample);
          next = upsertSample(next, sample);
        } catch (err) {
          problems.push(`${file.name}: ${String(err)}`);
        }
      }
      commit(next);
      if (problems.length > 0) {
        setUploadError(problems.join("\n"));
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

      {/* Upload */}
      <div className="sample-intake-input">
        <span className="field-label">Upload sample files</span>
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
        />
        <span className="field-hint">
          One or more files. The log type is auto-detected from each filename and
          content; rename it on the chip afterwards.
        </span>
        {uploadError !== "" && <pre className="result">{uploadError}</pre>}
      </div>

      {/* Paste */}
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
        <div className="panel-controls">
          <button
            className="run-button"
            onClick={() => void addFromPaste()}
            disabled={busy}
          >
            Add sample
          </button>
          {pasteError !== "" && <span className="field-hint">{pasteError}</span>}
        </div>
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
    </div>
  );
}
