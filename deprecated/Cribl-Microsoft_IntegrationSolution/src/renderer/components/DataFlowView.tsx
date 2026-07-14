// DataFlowView - Visual pipeline showing data transformation across 4 stages:
//   1. Source (raw vendor data)
//   2. After Route (filtered/classified)
//   3. After Pack Pipeline (transformed)
//   4. Destination (Sentinel table)
//
// Each stage shows a sample event with animated flow indicators.
// Users can capture a live sample from each stage.

import { useState, useEffect, useRef, useCallback } from 'react';

interface StageData {
  events: Array<Record<string, unknown>>;
  loading: boolean;
  error: string;
  lastCapture: number;
}

interface DataFlowProps {
  workerGroup: string;
  sourceId?: string;           // If empty, shows a source selector
  packPipeline?: string;      // Pipeline name in the pack
  destTable?: string;          // Sentinel table name for destination query
  criblConnected: boolean;
  azureConnected: boolean;
}

const STAGES = ['Source', 'Sentinel'] as const;
type Stage = typeof STAGES[number];

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const s = {
  container: {
    display: 'flex', flexDirection: 'column' as const, gap: '0',
    background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
    borderRadius: 'var(--radius)', overflow: 'hidden',
  } as React.CSSProperties,
  header: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '10px 16px', borderBottom: '1px solid var(--border-color)',
  } as React.CSSProperties,
  title: { fontSize: '13px', fontWeight: 700 } as React.CSSProperties,
  controls: { display: 'flex', gap: '8px', alignItems: 'center' } as React.CSSProperties,
  autoLabel: { fontSize: '10px', color: 'var(--text-muted)' } as React.CSSProperties,

  // Flow stages
  flow: {
    display: 'flex', alignItems: 'stretch', minHeight: '320px',
    overflow: 'hidden',
  } as React.CSSProperties,
  stage: (active: boolean, hasData: boolean) => ({
    flex: 1, display: 'flex', flexDirection: 'column' as const,
    borderRight: '1px solid var(--border-color)',
    background: active ? 'rgba(79, 195, 247, 0.03)' : 'transparent',
    position: 'relative' as const,
    minWidth: 0,
  } as React.CSSProperties),
  stageHeader: (color: string) => ({
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '8px 12px', borderBottom: `2px solid ${color}`,
    background: 'var(--bg-primary)',
  } as React.CSSProperties),
  stageLabel: {
    fontSize: '11px', fontWeight: 700, textTransform: 'uppercase' as const,
    letterSpacing: '0.5px',
  } as React.CSSProperties,
  stageCount: {
    fontSize: '10px', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)',
  } as React.CSSProperties,
  stageBody: {
    flex: 1, overflow: 'auto', padding: '8px', fontSize: '10px',
    fontFamily: 'var(--font-mono)', lineHeight: 1.5,
  } as React.CSSProperties,
  stageFooter: {
    padding: '6px 8px', borderTop: '1px solid var(--border-color)',
    display: 'flex', justifyContent: 'center',
  } as React.CSSProperties,
  captureBtn: {
    fontSize: '10px', padding: '3px 10px', cursor: 'pointer',
  } as React.CSSProperties,

  // Flow arrows between stages
  arrow: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    width: '32px', flexShrink: 0, position: 'relative' as const,
  } as React.CSSProperties,
  arrowLine: (active: boolean) => ({
    width: '100%', height: '2px',
    background: active
      ? 'linear-gradient(90deg, var(--accent-blue), var(--accent-green))'
      : 'var(--border-color)',
    position: 'relative' as const,
  } as React.CSSProperties),
  arrowDot: (active: boolean) => ({
    width: '6px', height: '6px', borderRadius: '50%',
    background: active ? 'var(--accent-green)' : 'var(--border-color)',
    position: 'absolute' as const,
    right: '-3px', top: '-2px',
    animation: active ? 'flowPulse 1.5s ease-in-out infinite' : 'none',
  } as React.CSSProperties),

  // Event display
  eventCard: (idx: number, isNew: boolean) => ({
    padding: '6px 8px', marginBottom: '4px',
    borderRadius: '3px', wordBreak: 'break-all' as const,
    background: isNew ? 'rgba(79, 195, 247, 0.08)' : 'var(--bg-input)',
    border: `1px solid ${isNew ? 'rgba(79, 195, 247, 0.2)' : 'var(--border-color)'}`,
    opacity: isNew ? 1 : 0.8,
    transition: 'opacity 0.5s, background 0.5s',
    maxHeight: '80px', overflow: 'hidden',
  } as React.CSSProperties),
  fieldName: { color: 'var(--accent-blue)', fontWeight: 600 } as React.CSSProperties,
  fieldValue: { color: 'var(--text-secondary)' } as React.CSSProperties,
  statusText: {
    fontSize: '10px', color: 'var(--text-muted)', padding: '20px',
    textAlign: 'center' as const, fontStyle: 'italic' as const,
  } as React.CSSProperties,
  errorText: {
    fontSize: '10px', color: 'var(--accent-red)', padding: '8px',
  } as React.CSSProperties,
  loadingDots: {
    fontSize: '10px', color: 'var(--text-muted)', padding: '20px',
    textAlign: 'center' as const,
  } as React.CSSProperties,
};

const STAGE_COLORS: Record<Stage, string> = {
  Source: 'var(--accent-purple)',
  Sentinel: 'var(--accent-orange)',
};

// ---------------------------------------------------------------------------
// Compact event renderer -- show first 5 fields
// ---------------------------------------------------------------------------

function EventPreview({ event, isNew }: { event: Record<string, unknown>; isNew: boolean }) {
  const entries = Object.entries(event).filter(
    ([k]) => !k.startsWith('__') && !k.startsWith('cribl_') && k !== '_raw'
  ).slice(0, 6);

  return (
    <div style={s.eventCard(0, isNew)}>
      {entries.map(([key, value]) => (
        <div key={key}>
          <span style={s.fieldName}>{key}</span>
          <span style={s.fieldValue}>: {typeof value === 'object' ? JSON.stringify(value) : String(value ?? '')}</span>
        </div>
      ))}
      {Object.keys(event).length > 6 && (
        <div style={{ color: 'var(--text-muted)' }}>+{Object.keys(event).length - 6} more fields</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface HealthStatus {
  sourceHealth: 'ok' | 'warn' | 'error' | 'unknown';
  sourceDetail: string;
  destHealth: 'ok' | 'warn' | 'error' | 'unknown';
  destDetail: string;
  throughput: string;
}

const healthDot = (status: 'ok' | 'warn' | 'error' | 'unknown'): React.CSSProperties => ({
  width: '8px', height: '8px', borderRadius: '50%', flexShrink: 0,
  background: status === 'ok' ? 'var(--accent-green)' :
              status === 'warn' ? 'var(--accent-orange)' :
              status === 'error' ? 'var(--accent-red)' : 'var(--text-muted)',
});

const healthBar: React.CSSProperties = {
  display: 'flex', gap: '16px', padding: '6px 16px',
  borderBottom: '1px solid var(--border-color)', fontSize: '10px',
  background: 'var(--bg-primary)', alignItems: 'center',
};

const healthItem: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--text-secondary)',
};

const throughputBar: React.CSSProperties = {
  marginLeft: 'auto', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)',
};

function DataFlowView({
  workerGroup, sourceId: sourceIdProp, packPipeline, destTable,
  criblConnected, azureConnected,
}: DataFlowProps) {
  const [stages, setStages] = useState<Record<Stage, StageData>>({
    Source: { events: [], loading: false, error: '', lastCapture: 0 },
    Sentinel: { events: [], loading: false, error: '', lastCapture: 0 },
  });
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [newEvents, setNewEvents] = useState<Record<Stage, boolean>>({
    Source: false, Sentinel: false,
  });
  const [health, setHealth] = useState<HealthStatus>({
    sourceHealth: 'unknown', sourceDetail: '',
    destHealth: 'unknown', destDetail: '',
    throughput: '',
  });
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Source selector state -- used when sourceIdProp is not provided
  const [availableSources, setAvailableSources] = useState<Array<{ id: string; type: string; disabled: boolean }>>([]);
  const [selectedSource, setSelectedSource] = useState('');
  const [sourcesLoading, setSourcesLoading] = useState(false);
  const sourceId = sourceIdProp || selectedSource;

  // Load available sources when no sourceId prop and connected
  useEffect(() => {
    if (sourceIdProp || !window.api || !criblConnected || !workerGroup) return;
    const load = async () => {
      setSourcesLoading(true);
      try {
        const result = await window.api.auth.criblSources(workerGroup);
        if (result.success) {
          setAvailableSources(result.sources);
          // Auto-select first enabled source
          const enabled = result.sources.filter((s: any) => !s.disabled);
          if (enabled.length > 0 && !selectedSource) {
            setSelectedSource(enabled[0].id);
          }
        }
      } catch { /* skip */ }
      setSourcesLoading(false);
    };
    load();
  }, [sourceIdProp, criblConnected, workerGroup]);

  // Check health status of source and destination
  useEffect(() => {
    if (!window.api || !criblConnected) return;
    const checkHealth = async () => {
      const newHealth: HealthStatus = {
        sourceHealth: 'unknown', sourceDetail: '',
        destHealth: 'unknown', destDetail: '',
        throughput: '',
      };
      // Check source health via sources list
      try {
        const srcResult = await window.api.auth.criblSources(workerGroup);
        if (srcResult.success) {
          const src = srcResult.sources.find((s) => s.id === sourceId);
          if (src) {
            newHealth.sourceHealth = src.disabled ? 'warn' : 'ok';
            newHealth.sourceDetail = src.disabled ? 'Source is disabled' : `Active (${src.type})`;
          } else {
            newHealth.sourceHealth = 'error';
            newHealth.sourceDetail = 'Source not found';
          }
        }
      } catch { /* skip */ }
      // Check destination health via destinations list
      try {
        const destResult = await window.api.auth.criblListDestinations(workerGroup);
        if (destResult.success) {
          const hasErrors = destResult.destinations.length === 0;
          newHealth.destHealth = hasErrors ? 'warn' : 'ok';
          newHealth.destDetail = hasErrors ? 'No destinations configured' : `${destResult.destinations.length} destination(s)`;
        }
      } catch { /* skip */ }
      setHealth(newHealth);
    };
    checkHealth();
    const healthInterval = setInterval(checkHealth, 60000);
    return () => clearInterval(healthInterval);
  }, [criblConnected, workerGroup, sourceId]);

  const updateStage = useCallback((stage: Stage, update: Partial<StageData>) => {
    setStages((prev) => ({ ...prev, [stage]: { ...prev[stage], ...update } }));
  }, []);

  // Capture from source
  const captureSource = useCallback(async () => {
    if (!window.api || !criblConnected || !sourceId) return;
    updateStage('Source', { loading: true, error: '' });
    try {
      const result = await window.api.auth.criblCapture(workerGroup, sourceId, 5, 10000);
      if (result.success && result.events.length > 0) {
        updateStage('Source', { events: result.events.slice(0, 5), loading: false, lastCapture: Date.now() });
        setNewEvents((p) => ({ ...p, Source: true }));
        setTimeout(() => setNewEvents((p) => ({ ...p, Source: false })), 2000);
      } else {
        updateStage('Source', { loading: false, error: result.error || 'No events' });
      }
    } catch (err) {
      updateStage('Source', { loading: false, error: err instanceof Error ? err.message : 'Failed' });
    }
  }, [criblConnected, workerGroup, sourceId, updateStage]);

  // Query destination Sentinel table
  const captureSentinel = useCallback(async () => {
    if (!window.api || !azureConnected || !destTable) {
      updateStage('Sentinel', { loading: false, error: !destTable ? 'No destination table configured' : 'Azure not connected' });
      return;
    }
    updateStage('Sentinel', { loading: true, error: '' });
    try {
      const query = `${destTable} | take 5 | order by TimeGenerated desc`;
      const result = await window.api.auth.azureQuery(query, 'PT1H');
      if (result.success && result.rows.length > 0) {
        updateStage('Sentinel', { events: result.rows.slice(0, 5), loading: false, lastCapture: Date.now() });
        setNewEvents((p) => ({ ...p, Sentinel: true }));
        setTimeout(() => setNewEvents((p) => ({ ...p, Sentinel: false })), 2000);
      } else {
        updateStage('Sentinel', { loading: false, error: result.error || 'No data in table' });
      }
    } catch (err) {
      updateStage('Sentinel', { loading: false, error: err instanceof Error ? err.message : 'Failed' });
    }
  }, [azureConnected, destTable, updateStage]);

  // Capture all stages in sequence
  const captureAll = useCallback(async () => {
    await captureSource();
    await new Promise((r) => setTimeout(r, 500));
    await captureSentinel();
  }, [captureSource, captureSentinel]);

  // Auto-refresh
  useEffect(() => {
    if (autoRefresh) {
      captureAll();
      intervalRef.current = setInterval(captureAll, 30000);
    } else if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [autoRefresh, captureAll]);

  const captureFns: Record<Stage, () => void> = {
    Source: captureSource,
    Sentinel: captureSentinel,
  };

  const isFlowing = Object.values(stages).every((st) => st.events.length > 0);

  return (
    <div style={s.container}>
      <style>{`
        @keyframes flowPulse {
          0%, 100% { opacity: 0.4; transform: scale(1); }
          50% { opacity: 1; transform: scale(1.5); }
        }
      `}</style>

      <div style={s.header}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flex: 1, minWidth: 0 }}>
          <div style={s.title}>Data Flow:</div>
          {/* Source selector when no sourceId prop */}
          {!sourceIdProp ? (
            <select
              style={{
                fontSize: '12px', padding: '3px 8px', background: 'var(--bg-input)',
                border: '1px solid var(--border-color)', borderRadius: '4px',
                color: 'var(--text-primary)', maxWidth: '220px',
              }}
              value={selectedSource}
              onChange={(e) => setSelectedSource(e.target.value)}
              disabled={sourcesLoading}
            >
              <option value="">
                {sourcesLoading ? 'Loading sources...' : availableSources.length === 0 ? 'No sources found' : '-- Select source --'}
              </option>
              {availableSources.filter((src) => !src.disabled).map((src) => (
                <option key={src.id} value={src.id}>{src.id} ({src.type})</option>
              ))}
            </select>
          ) : (
            <span style={{ fontSize: '13px', fontWeight: 600 }}>{sourceId}</span>
          )}
          {destTable && (
            <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>-&gt; {destTable}</span>
          )}
        </div>
        <div style={s.controls}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer' }}>
            <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />
            <span style={s.autoLabel}>Auto-refresh (30s)</span>
          </label>
          <button className="btn-primary" style={s.captureBtn} onClick={captureAll} disabled={!sourceId}>
            Capture All
          </button>
        </div>
      </div>

      {/* Health status bar */}
      <div style={healthBar}>
        <div style={healthItem}>
          <div style={healthDot(health.sourceHealth)} />
          <span>Source: {health.sourceDetail || 'Checking...'}</span>
        </div>
        <div style={healthItem}>
          <div style={healthDot(health.destHealth)} />
          <span>Destination: {health.destDetail || 'Checking...'}</span>
        </div>
        {health.throughput && <div style={throughputBar}>{health.throughput}</div>}
      </div>

      <div style={s.flow}>
        {STAGES.map((stage, idx) => (
          <div key={stage} style={{ display: 'flex', alignItems: 'stretch', flex: 1 }}>
            {/* Stage column */}
            <div style={s.stage(newEvents[stage], stages[stage].events.length > 0)}>
              <div style={s.stageHeader(STAGE_COLORS[stage])}>
                <span style={{ ...s.stageLabel, color: STAGE_COLORS[stage] }}>{stage}</span>
                <span style={s.stageCount}>
                  {stages[stage].events.length > 0 ? `${stages[stage].events.length} events` : ''}
                </span>
              </div>

              <div style={s.stageBody}>
                {stages[stage].loading && (
                  <div style={s.loadingDots}>Capturing...</div>
                )}
                {stages[stage].error && !stages[stage].loading && (
                  <div style={s.errorText}>{stages[stage].error}</div>
                )}
                {!stages[stage].loading && stages[stage].events.length === 0 && !stages[stage].error && (
                  <div style={s.statusText}>
                    {stage === 'Source' && !criblConnected ? 'Connect to Cribl to capture' :
                     stage === 'Sentinel' && !azureConnected ? 'Connect to Azure to query' :
                     'Click capture below'}
                  </div>
                )}
                {stages[stage].events.map((event, i) => (
                  <EventPreview key={i} event={event} isNew={newEvents[stage]} />
                ))}
              </div>

              <div style={s.stageFooter}>
                <button
                  className="btn-secondary"
                  style={s.captureBtn}
                  onClick={captureFns[stage]}
                  disabled={stages[stage].loading ||
                    (stage === 'Source' && !criblConnected) ||
                    (stage === 'Sentinel' && !azureConnected)}
                >
                  Capture
                </button>
              </div>
            </div>

            {/* Arrow between stages */}
            {idx < STAGES.length - 1 && (
              <div style={s.arrow}>
                <div style={s.arrowLine(isFlowing)}>
                  <div style={s.arrowDot(isFlowing)} />
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export default DataFlowView;
