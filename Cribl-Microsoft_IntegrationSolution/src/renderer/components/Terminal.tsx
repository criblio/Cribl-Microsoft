import { useState, useEffect, useRef } from 'react';
import { PsOutputEvent, PsExitEvent } from '../types';

interface TerminalProps {
  expanded: boolean;
  onToggle: () => void;
}

interface OutputLine {
  id: string;
  stream: 'stdout' | 'stderr' | 'system';
  text: string;
  timestamp: number;
}

const styles = {
  container: {
    display: 'flex',
    flexDirection: 'column' as const,
    height: '100%',
    background: '#0d0d1a',
  } as React.CSSProperties,
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '6px 12px',
    background: 'var(--bg-secondary)',
    borderBottom: '1px solid var(--border-color)',
    cursor: 'pointer',
    userSelect: 'none' as const,
    flexShrink: 0,
    height: '36px',
  } as React.CSSProperties,
  headerLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    fontSize: '12px',
    color: 'var(--text-secondary)',
    fontFamily: 'var(--font-mono)',
  } as React.CSSProperties,
  headerActions: {
    display: 'flex',
    gap: '8px',
  } as React.CSSProperties,
  headerBtn: {
    background: 'none',
    border: 'none',
    color: 'var(--text-muted)',
    fontSize: '11px',
    padding: '2px 6px',
    cursor: 'pointer',
    fontFamily: 'var(--font-mono)',
  } as React.CSSProperties,
  output: {
    flex: 1,
    overflow: 'auto',
    padding: '8px 12px',
    fontFamily: 'var(--font-mono)',
    fontSize: '12px',
    lineHeight: '1.6',
    whiteSpace: 'pre-wrap' as const,
    wordBreak: 'break-all' as const,
  } as React.CSSProperties,
  lineStdout: {
    color: '#c0c0c0',
  } as React.CSSProperties,
  lineStderr: {
    color: 'var(--accent-red)',
  } as React.CSSProperties,
  lineSystem: {
    color: 'var(--accent-blue)',
    fontStyle: 'italic' as const,
  } as React.CSSProperties,
  statusDot: (running: boolean) => ({
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    background: running ? 'var(--accent-green)' : 'var(--text-muted)',
    flexShrink: 0,
  } as React.CSSProperties),
};

let globalLines: OutputLine[] = [];
let globalListeners: Set<() => void> = new Set();

function notifyListeners() {
  globalListeners.forEach((fn) => fn());
}

export function appendTerminalOutput(line: OutputLine) {
  globalLines = [...globalLines, line];
  if (globalLines.length > 5000) {
    globalLines = globalLines.slice(-4000);
  }
  notifyListeners();
}

export function clearTerminal() {
  globalLines = [];
  notifyListeners();
}

function Terminal({ expanded, onToggle }: TerminalProps) {
  const [lines, setLines] = useState<OutputLine[]>(globalLines);
  const [isRunning, setIsRunning] = useState(false);
  const outputRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const listener = () => setLines([...globalLines]);
    globalListeners.add(listener);
    return () => { globalListeners.delete(listener); };
  }, []);

  useEffect(() => {
    if (!window.api) return;

    const removeOutput = window.api.powershell.onOutput((event: PsOutputEvent) => {
      setIsRunning(true);
      appendTerminalOutput({
        id: event.id,
        stream: event.stream,
        text: event.data,
        timestamp: Date.now(),
      });
    });

    const removeExit = window.api.powershell.onExit((event: PsExitEvent) => {
      setIsRunning(false);
      appendTerminalOutput({
        id: event.id,
        stream: 'system',
        text: `-- Process exited with code ${event.code} --\n`,
        timestamp: Date.now(),
      });
    });

    // Listen for startup log messages (Sentinel repo, Elastic repo, etc.)
    const removeStartupLog = (window.api as any).onStartupLog?.((log: { message: string; level: string; timestamp: number }) => {
      appendTerminalOutput({
        id: `startup-${log.timestamp}`,
        stream: log.level === 'error' ? 'stderr' : 'system',
        text: `[startup] ${log.message}\n`,
        timestamp: log.timestamp,
      });
    });

    return () => {
      removeOutput();
      removeExit();
      removeStartupLog?.();
    };
  }, []);

  useEffect(() => {
    if (outputRef.current && expanded) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [lines, expanded]);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    const text = lines.map((l) => l.text).join('');
    navigator.clipboard.writeText(text);
  };

  const handleClear = (e: React.MouseEvent) => {
    e.stopPropagation();
    clearTerminal();
  };

  const getLineStyle = (stream: string) => {
    if (stream === 'stderr') return styles.lineStderr;
    if (stream === 'system') return styles.lineSystem;
    return styles.lineStdout;
  };

  return (
    <div style={styles.container}>
      <div style={styles.header} onClick={onToggle}>
        <div style={styles.headerLeft}>
          <div style={styles.statusDot(isRunning)} />
          <span>TERMINAL</span>
          <span style={{ color: 'var(--text-muted)' }}>
            {isRunning ? 'Running...' : 'Ready'}
          </span>
        </div>
        {expanded && (
          <div style={styles.headerActions}>
            <button style={styles.headerBtn} onClick={handleCopy} title="Copy output">
              COPY
            </button>
            <button style={styles.headerBtn} onClick={handleClear} title="Clear output">
              CLEAR
            </button>
          </div>
        )}
      </div>
      {expanded && (
        <div ref={outputRef} style={styles.output}>
          {lines.length === 0 && (
            <span style={{ color: 'var(--text-muted)' }}>
              Terminal output will appear here when a script is executed.
            </span>
          )}
          {lines.map((line, i) => (
            <span key={i} style={getLineStyle(line.stream)}>
              {line.text}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export default Terminal;
