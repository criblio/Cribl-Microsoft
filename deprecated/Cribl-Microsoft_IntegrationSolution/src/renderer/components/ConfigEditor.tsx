import { useState, useEffect } from 'react';

interface ConfigEditorProps {
  configPath: string;
  label: string;
  onSaved?: () => void;
}

const styles = {
  container: {
    background: 'var(--bg-secondary)',
    border: '1px solid var(--border-color)',
    borderRadius: 'var(--radius)',
    overflow: 'hidden',
  } as React.CSSProperties,
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '10px 14px',
    borderBottom: '1px solid var(--border-color)',
    cursor: 'pointer',
    userSelect: 'none' as const,
  } as React.CSSProperties,
  title: {
    fontSize: '12px',
    fontWeight: 600,
    color: 'var(--text-secondary)',
    fontFamily: 'var(--font-mono)',
  } as React.CSSProperties,
  body: {
    padding: '12px',
  } as React.CSSProperties,
  textarea: {
    width: '100%',
    minHeight: '200px',
    fontFamily: 'var(--font-mono)',
    fontSize: '12px',
    background: 'var(--bg-input)',
    border: '1px solid var(--border-color)',
    borderRadius: 'var(--radius)',
    color: 'var(--text-primary)',
    padding: '10px',
    resize: 'vertical' as const,
    outline: 'none',
    lineHeight: '1.5',
  } as React.CSSProperties,
  actions: {
    display: 'flex',
    gap: '8px',
    marginTop: '8px',
    justifyContent: 'flex-end',
  } as React.CSSProperties,
  error: {
    color: 'var(--accent-red)',
    fontSize: '12px',
    marginTop: '6px',
  } as React.CSSProperties,
  status: {
    fontSize: '11px',
    color: 'var(--accent-green)',
    marginTop: '6px',
  } as React.CSSProperties,
};

function ConfigEditor({ configPath, label, onSaved }: ConfigEditorProps) {
  const [content, setContent] = useState('');
  const [originalContent, setOriginalContent] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    loadConfig();
  }, [configPath]);

  async function loadConfig() {
    if (!window.api) return;
    setLoading(true);
    setError('');
    try {
      const data = await window.api.config.read(configPath);
      const formatted = JSON.stringify(data, null, 2);
      setContent(formatted);
      setOriginalContent(formatted);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setContent('');
    } finally {
      setLoading(false);
    }
  }

  async function saveConfig() {
    if (!window.api) return;
    setError('');
    setSaved(false);
    try {
      const parsed = JSON.parse(content);
      await window.api.config.write(configPath, parsed);
      setOriginalContent(content);
      setSaved(true);
      onSaved?.();
      setTimeout(() => setSaved(false), 3000);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setError(`Save failed: ${message}`);
    }
  }

  const hasChanges = content !== originalContent;

  return (
    <div style={styles.container}>
      <div style={styles.header} onClick={() => setExpanded(!expanded)}>
        <span style={styles.title}>
          {expanded ? '[-]' : '[+]'} {label}
        </span>
        {hasChanges && (
          <span style={{ fontSize: '11px', color: 'var(--accent-orange)' }}>Modified</span>
        )}
      </div>
      {expanded && (
        <div style={styles.body}>
          {loading ? (
            <div style={{ color: 'var(--text-muted)', fontSize: '12px' }}>Loading...</div>
          ) : (
            <>
              <textarea
                style={styles.textarea}
                value={content}
                onChange={(e) => { setContent(e.target.value); setError(''); }}
                spellCheck={false}
              />
              {error && <div style={styles.error}>{error}</div>}
              {saved && <div style={styles.status}>Configuration saved.</div>}
              <div style={styles.actions}>
                <button
                  className="btn-secondary"
                  onClick={loadConfig}
                  disabled={!hasChanges}
                >
                  Revert
                </button>
                <button
                  className="btn-primary"
                  onClick={saveConfig}
                  disabled={!hasChanges}
                >
                  Save
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default ConfigEditor;
