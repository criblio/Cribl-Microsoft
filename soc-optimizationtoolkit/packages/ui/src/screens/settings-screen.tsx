/**
 * SettingsScreen - the shared settings surface both shells mount as a frame
 * route. Sections:
 *
 *   - Platform: shell-provided info rows (shell name, versions, endpoints,
 *     connection summary) via a props bag - the screen renders whatever the
 *     shell can honestly report.
 *   - Operating mode: the current mode (shared MODE_LABELS, so it can never
 *     disagree with the frame's chip) and Reconfigure. The Reconfigure
 *     contract is the legacy one: the shell writes an EMPTY mode record
 *     (EMPTY_MODE_RECORD) and reloads, landing the user back in ModeSelect;
 *     connections and their configs are kept.
 *   - Advanced: the validate-before-save raw-JSON editor (pattern mined from
 *     the legacy ConfigEditor) over the ONE JSON-editable surface that exists
 *     today - the active connection profile's non-secret config - validated
 *     through validateConfigJson (parseAzureConfig underneath) before save.
 *     Optional: the local shell's config is file-managed and read-only here,
 *     so it passes no editor and the section explains why.
 */

import { useEffect, useState } from "react";
import type { AppMode, AzureConfig } from "@soc/core";
import { MODE_LABELS } from "../frame/frame-state";
import { validateConfigJson } from "./config-json";
import { InfoTip } from "../components/info-tip";

/** One label/value row in the platform info section. */
export interface PlatformInfoRow {
  label: string;
  value: string;
  /** Optional hover/focus explainer rendered as an InfoTip. */
  tip?: string;
}

/** The optional raw-JSON editor wiring (present only where a surface exists). */
export interface SettingsConfigEditor {
  /** Header label, e.g. the active connection's name. */
  label: string;
  /** The current canonical JSON (pretty-printed) for the editable surface. */
  json: string;
  /** Persist a validated config. The shell owns storage semantics. */
  onSave: (config: AzureConfig) => void | Promise<void>;
}

export interface SettingsScreenProps {
  /** Which shell is hosting (e.g. "Cribl.Cloud app platform"). */
  shellName: string;
  /** Whatever the shell can honestly report: versions, ids, endpoints. */
  platformRows: readonly PlatformInfoRow[];
  /** Free-text note under the platform rows (constraints, file locations). */
  platformNote?: string;
  /** The active mode; null renders as "not set". */
  mode: AppMode | null;
  /**
   * Clear the persisted mode (write EMPTY_MODE_RECORD) and reload back into
   * mode selection. The shell owns both the write and the reload.
   */
  onReconfigure: () => void | Promise<void>;
  /** The raw-JSON editor, where a JSON-editable surface exists. */
  configEditor?: SettingsConfigEditor;
}

export function SettingsScreen(props: SettingsScreenProps) {
  const {
    shellName,
    platformRows,
    platformNote,
    mode,
    onReconfigure,
    configEditor,
  } = props;
  const [reconfiguring, setReconfiguring] = useState(false);

  const reconfigure = async () => {
    setReconfiguring(true);
    try {
      await onReconfigure();
    } finally {
      setReconfiguring(false);
    }
  };

  return (
    <section className="panel">
      <h2 className="panel-title">Settings</h2>

      <div className="settings-section">
        <div className="settings-section-title">Platform</div>
        <div className="settings-card">
          <div className="settings-row">
            <span className="settings-row-label">Shell</span>
            <span className="settings-row-value">{shellName}</span>
          </div>
          {platformRows.map((row) => (
            <div className="settings-row" key={row.label}>
              <span className="settings-row-label">
                {row.label}
                {row.tip !== undefined && <InfoTip text={row.tip} />}
              </span>
              <span className="settings-row-value">{row.value}</span>
            </div>
          ))}
        </div>
        {platformNote !== undefined && (
          <p className="panel-desc settings-note">{platformNote}</p>
        )}
      </div>

      <div className="settings-section">
        <div className="settings-section-title">Operating mode</div>
        <div className="settings-card">
          <div className="settings-row">
            <span className="settings-row-label">
              Current mode
              <InfoTip
                text={
                  "The mode is the one source of truth for what this app may touch.\n" +
                  "Full: live Azure and Cribl.\n" +
                  "Azure Only / Cribl Only: one live side, artifacts for the other.\n" +
                  "Air-Gapped: artifacts only, no live connections."
                }
              />
            </span>
            <span className="settings-row-value">
              {mode === null ? "not set" : MODE_LABELS[mode]}
            </span>
          </div>
          <div className="settings-row">
            <span className="settings-row-label">
              Reconfigure connections and mode
            </span>
            <button
              className="run-button"
              disabled={reconfiguring}
              onClick={() => void reconfigure()}
            >
              Reconfigure
            </button>
          </div>
        </div>
        <p className="panel-desc settings-note">
          Reconfigure clears the saved mode and reloads into mode selection.
          Connections and their configurations are kept.
        </p>
      </div>

      <div className="settings-section">
        <div className="settings-section-title">Advanced</div>
        {configEditor !== undefined ? (
          <ConfigJsonEditor
            label={configEditor.label}
            json={configEditor.json}
            onSave={configEditor.onSave}
          />
        ) : (
          <p className="panel-desc settings-note">
            No JSON-editable configuration surface exists in this shell: the
            connection config is file-managed. See the platform note above for
            where to change it.
          </p>
        )}
      </div>
    </section>
  );
}

/**
 * The validate-before-save raw-JSON editor (legacy ConfigEditor pattern):
 * collapsed by default, Modified marker while the text diverges, Revert
 * restores the canonical JSON, Save validates through validateConfigJson and
 * refuses anything that is not a JSON object - surfacing what the tolerant
 * codec would drop or coerce as warnings instead of losing it silently.
 */
function ConfigJsonEditor({ label, json, onSave }: SettingsConfigEditor) {
  const [expanded, setExpanded] = useState(false);
  const [text, setText] = useState(json);
  const [error, setError] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  // Adopt external changes to the canonical JSON (a save landing, a form
  // edit elsewhere, a connection switch): the editor always restarts from
  // what is actually stored. `saved` is deliberately NOT cleared here - a
  // successful save updates the stored JSON, and its confirmation must
  // survive that very update.
  useEffect(() => {
    setText(json);
    setError("");
  }, [json]);

  const hasChanges = text !== json;

  const save = async () => {
    setError("");
    setSaved(false);
    setWarnings([]);
    const result = validateConfigJson(text);
    if (!result.ok) {
      setError(`Save refused: ${result.error}`);
      return;
    }
    setSaving(true);
    try {
      await onSave(result.config);
      setWarnings(result.warnings);
      setSaved(true);
    } catch (err) {
      setError(`Save failed: ${String(err)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="settings-card config-editor">
      <button
        className="config-editor-header"
        onClick={() => setExpanded((open) => !open)}
      >
        <span className="config-editor-title">
          {expanded ? "[-]" : "[+]"} {label}
        </span>
        {hasChanges && <span className="config-editor-modified">Modified</span>}
      </button>
      {expanded && (
        <div className="config-editor-body">
          <p className="panel-desc">
            Non-secret fields only - a pasted secret is refused from storage
            and reported below. Save validates the JSON first: anything that
            is not a JSON object is rejected, unknown keys are dropped with a
            warning, and the stored result is shown back in canonical form.
          </p>
          <textarea
            className="config-editor-textarea"
            value={text}
            spellCheck={false}
            onChange={(event) => {
              setText(event.target.value);
              setError("");
              setSaved(false);
            }}
          />
          {error !== "" && <p className="config-editor-error">{error}</p>}
          {saved && (
            <p className="config-editor-saved">Configuration saved.</p>
          )}
          {warnings.map((warning) => (
            <p className="config-editor-warning" key={warning}>
              {warning}
            </p>
          ))}
          <div className="config-editor-actions">
            <button
              className="run-button"
              disabled={!hasChanges || saving}
              onClick={() => {
                setText(json);
                setError("");
                setWarnings([]);
                setSaved(false);
              }}
            >
              Revert
            </button>
            <button
              className="run-button"
              disabled={!hasChanges || saving}
              onClick={() => void save()}
            >
              Save
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
