// DataFlow Page - Full-width pipeline monitoring view
// Shows all active streaming sources with Source and Sentinel captures.
// Correlates source events with Sentinel table data to verify ingestion.

import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ActiveSource {
  id: string;
  type: string;
  description: string;
}

interface StageData {
  events: Array<Record<string, unknown>>;
  loading: boolean;
  error: string;
  lastCapture: number;
  eventCount: number;
}

interface SourceFlow {
  source: ActiveSource;
  stages: {
    source: StageData;
    sentinel: StageData;
  };
  health: 'ok' | 'warn' | 'error' | 'unknown';
  expanded: boolean;
}

const EMPTY_STAGE: StageData = { events: [], loading: false, error: '', lastCapture: 0, eventCount: 0 };

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const s = {
  page: {
    display: 'flex', flexDirection: 'column' as const, height: '100%', overflow: 'hidden',
  } as React.CSSProperties,
  topBar: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '12px 20px', borderBottom: '1px solid var(--border-color)',
    background: 'var(--bg-secondary)', flexShrink: 0,
  } as React.CSSProperties,
  title: { fontSize: '16px', fontWeight: 700 } as React.CSSProperties,
  subtitle: { fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' } as React.CSSProperties,
  controls: { display: 'flex', gap: '10px', alignItems: 'center' } as React.CSSProperties,
  statusBar: {
    display: 'flex', gap: '20px', padding: '6px 20px',
    borderBottom: '1px solid var(--border-color)',
    fontSize: '11px', background: 'var(--bg-primary)', flexShrink: 0,
  } as React.CSSProperties,
  statusItem: {
    display: 'flex', alignItems: 'center', gap: '6px',
  } as React.CSSProperties,
  dot: (status: string) => ({
    width: '7px', height: '7px', borderRadius: '50%', flexShrink: 0,
    background: status === 'ok' ? 'var(--accent-green)' :
                status === 'warn' ? 'var(--accent-orange)' :
                status === 'error' ? 'var(--accent-red)' : 'var(--text-muted)',
  } as React.CSSProperties),
  body: {
    flex: 1, overflow: 'auto', padding: '12px 20px',
  } as React.CSSProperties,
  // Source flow row
  flowRow: (health: string, expanded: boolean) => ({
    background: 'var(--bg-secondary)',
    border: `1px solid ${health === 'error' ? 'rgba(239, 83, 80, 0.3)' : 'var(--border-color)'}`,
    borderRadius: 'var(--radius)', marginBottom: '8px',
    borderLeft: `3px solid ${health === 'ok' ? 'var(--accent-green)' : health === 'error' ? 'var(--accent-red)' : health === 'warn' ? 'var(--accent-orange)' : 'var(--border-color)'}`,
  } as React.CSSProperties),
  flowHeader: {
    display: 'flex', alignItems: 'center', padding: '10px 14px',
    cursor: 'pointer', gap: '12px',
  } as React.CSSProperties,
  sourceName: { fontSize: '13px', fontWeight: 600, minWidth: '180px' } as React.CSSProperties,
  sourceType: {
    fontSize: '10px', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)',
    padding: '2px 8px', background: 'var(--bg-input)', borderRadius: '10px',
  } as React.CSSProperties,
  // Mini stage indicators in the collapsed row
  stageIndicators: {
    display: 'flex', gap: '4px', flex: 1, justifyContent: 'center', alignItems: 'center',
  } as React.CSSProperties,
  miniStage: (hasData: boolean, hasError: boolean) => ({
    width: '60px', height: '6px', borderRadius: '3px',
    background: hasError ? 'var(--accent-red)' : hasData ? 'var(--accent-green)' : 'var(--bg-input)',
    transition: 'background 0.5s',
  } as React.CSSProperties),
  miniArrow: {
    color: 'var(--text-muted)', fontSize: '10px',
  } as React.CSSProperties,
  captureBtn: {
    fontSize: '10px', padding: '4px 12px', marginLeft: 'auto', flexShrink: 0,
  } as React.CSSProperties,
  // Expanded stage view
  stagesRow: {
    display: 'flex', borderTop: '1px solid var(--border-color)',
    minHeight: '200px',
  } as React.CSSProperties,
  stageCol: (color: string) => ({
    flex: 1, display: 'flex', flexDirection: 'column' as const,
    borderRight: '1px solid var(--border-color)',
    minWidth: 0,
  } as React.CSSProperties),
  stageHead: (color: string) => ({
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '6px 10px', borderBottom: `2px solid ${color}`,
    fontSize: '10px', fontWeight: 700, textTransform: 'uppercase' as const,
    letterSpacing: '0.5px', color,
  } as React.CSSProperties),
  stageCount: {
    fontSize: '9px', fontFamily: 'var(--font-mono)', color: 'var(--text-muted)',
    fontWeight: 400,
  } as React.CSSProperties,
  stageBody: {
    flex: 1, overflow: 'auto', padding: '6px', fontSize: '10px',
    fontFamily: 'var(--font-mono)', lineHeight: 1.4,
  } as React.CSSProperties,
  eventCard: (isNew: boolean) => ({
    padding: '5px 7px', marginBottom: '3px', borderRadius: '3px',
    background: isNew ? 'rgba(79, 195, 247, 0.08)' : 'var(--bg-input)',
    border: `1px solid ${isNew ? 'rgba(79, 195, 247, 0.2)' : 'var(--border-color)'}`,
    maxHeight: '60px', overflow: 'hidden', wordBreak: 'break-all' as const,
  } as React.CSSProperties),
  fieldName: { color: 'var(--accent-blue)', fontWeight: 600 } as React.CSSProperties,
  fieldValue: { color: 'var(--text-secondary)' } as React.CSSProperties,
  arrowCol: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    width: '24px', flexShrink: 0,
  } as React.CSSProperties,
  arrowDot: (active: boolean) => ({
    width: '6px', height: '6px', borderRadius: '50%',
    background: active ? 'var(--accent-green)' : 'var(--border-color)',
    animation: active ? 'flowPulse 1.5s ease-in-out infinite' : 'none',
  } as React.CSSProperties),
  emptyState: {
    padding: '40px', textAlign: 'center' as const, color: 'var(--text-muted)',
  } as React.CSSProperties,
  emptyTitle: { fontSize: '14px', fontWeight: 600, marginBottom: '8px', color: 'var(--text-secondary)' } as React.CSSProperties,
};

const STAGE_COLORS = {
  source: 'var(--accent-purple)',
  sentinel: 'var(--accent-orange)',
};

// ---------------------------------------------------------------------------
// Compact event render
// ---------------------------------------------------------------------------

function MiniEvent({ event, isNew, onClick, selected }: {
  event: Record<string, unknown>; isNew: boolean; onClick?: () => void; selected?: boolean;
}) {
  const entries = Object.entries(event)
    .filter(([k]) => !k.startsWith('__') && !k.startsWith('cribl_') && k !== '_routed')
    .slice(0, 4);
  return (
    <div
      style={{
        ...s.eventCard(isNew),
        cursor: onClick ? 'pointer' : 'default',
        borderColor: selected ? 'var(--accent-blue)' : undefined,
        borderWidth: selected ? '2px' : undefined,
      }}
      onClick={onClick}
    >
      {entries.map(([k, v]) => (
        <div key={k}>
          <span style={s.fieldName}>{k}</span>
          <span style={s.fieldValue}>: {typeof v === 'object' ? JSON.stringify(v) : String(v ?? '')}</span>
        </div>
      ))}
    </div>
  );
}

// Full event detail view -- shows all fields for a selected event
function EventDetail({ sourceEvent, sentinelEvent }: {
  sourceEvent: Record<string, unknown> | null;
  sentinelEvent: Record<string, unknown> | null;
}) {
  if (!sourceEvent && !sentinelEvent) return null;

  const detailStyle: React.CSSProperties = {
    background: 'var(--bg-primary)', border: '1px solid var(--border-color)',
    borderRadius: 'var(--radius)', padding: '12px', marginTop: '8px',
    fontSize: '11px', fontFamily: 'var(--font-mono)', maxHeight: '400px', overflow: 'auto',
  };
  const colStyle: React.CSSProperties = { flex: 1, minWidth: 0, overflow: 'auto' };
  const headerStyle = (color: string): React.CSSProperties => ({
    fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', color, marginBottom: '8px', letterSpacing: '0.5px',
  });
  const rowStyle: React.CSSProperties = {
    display: 'flex', borderBottom: '1px solid var(--border-color)', padding: '2px 0',
  };
  const keyStyle: React.CSSProperties = { width: '160px', flexShrink: 0, color: 'var(--accent-blue)', fontWeight: 600 };
  const valStyle: React.CSSProperties = { flex: 1, wordBreak: 'break-all', color: 'var(--text-secondary)' };

  const sourceEntries = sourceEvent
    ? Object.entries(sourceEvent).filter(([k]) => !k.startsWith('__') && !k.startsWith('cribl_'))
    : [];
  const sentinelEntries = sentinelEvent ? Object.entries(sentinelEvent) : [];

  return (
    <div style={detailStyle}>
      <div style={{ display: 'flex', gap: '16px' }}>
        <div style={colStyle}>
          <div style={headerStyle('var(--accent-purple)')}>Source Event ({sourceEntries.length} fields)</div>
          {sourceEntries.map(([k, v]) => (
            <div key={k} style={rowStyle}>
              <div style={keyStyle}>{k}</div>
              <div style={valStyle}>{typeof v === 'object' ? JSON.stringify(v) : String(v ?? '')}</div>
            </div>
          ))}
          {!sourceEvent && <div style={{ color: 'var(--text-muted)' }}>No source event selected</div>}
        </div>
        <div style={{ width: '1px', background: 'var(--border-color)', flexShrink: 0 }} />
        <div style={colStyle}>
          <div style={headerStyle('var(--accent-orange)')}>Sentinel Event ({sentinelEntries.length} fields)</div>
          {sentinelEntries.map(([k, v]) => (
            <div key={k} style={rowStyle}>
              <div style={keyStyle}>{k}</div>
              <div style={valStyle}>{typeof v === 'object' ? JSON.stringify(v) : String(v ?? '')}</div>
            </div>
          ))}
          {!sentinelEvent && <div style={{ color: 'var(--text-muted)' }}>No matching Sentinel event</div>}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

function DataFlow() {
  const navigate = useNavigate();
  const [flows, setFlows] = useState<SourceFlow[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedEvent, setSelectedEvent] = useState<{ sourceId: string; eventIdx: number } | null>(null);
  const [criblConnected, setCriblConnected] = useState(false);
  const [azureConnected, setAzureConnected] = useState(false);
  const [workerGroup, setWorkerGroup] = useState('');
  const [workerGroups, setWorkerGroups] = useState<Array<{ id: string; name: string }>>([]);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Load connection status and worker groups
  useEffect(() => {
    if (!window.api) return;
    const init = async () => {
      try {
        const status = await window.api.auth.status();
        setCriblConnected(status.cribl.connected);
        setAzureConnected(status.azure.loggedIn);
        if (status.cribl.connected) {
          const groups = await window.api.auth.criblWorkerGroups();
          if (groups.success && groups.groups.length > 0) {
            setWorkerGroups(groups.groups);
            setWorkerGroup(groups.groups[0].id);
          }
        }
      } catch { /* skip */ }
    };
    init();
  }, []);

  // Load active sources when worker group changes
  const loadSources = useCallback(async () => {
    if (!window.api || !criblConnected || !workerGroup) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const result = await window.api.auth.criblSources(workerGroup);
      if (result.success) {
        const activeSources = result.sources.filter((src) => !src.disabled);
        setFlows((prev) => {
          // Preserve existing flow data, add new sources, remove gone ones
          const existing = new Map(prev.map((f) => [f.source.id, f]));
          return activeSources.map((src) => {
            const ex = existing.get(src.id);
            if (ex) return { ...ex, source: src };
            return {
              source: src,
              stages: {
                source: { ...EMPTY_STAGE },
                sentinel: { ...EMPTY_STAGE },
              },
              health: 'ok' as const,
              expanded: false,
            };
          });
        });
      }
    } catch { /* skip */ }
    setLoading(false);
  }, [criblConnected, workerGroup]);

  useEffect(() => { loadSources(); }, [loadSources]);

  // Toggle expand
  const toggleExpand = (sourceId: string) => {
    setFlows((prev) => prev.map((f) =>
      f.source.id === sourceId ? { ...f, expanded: !f.expanded } : f
    ));
  };

  // Capture all stages for a single source
  const captureSource = useCallback(async (sourceId: string) => {
    if (!window.api) return;

    const updateStage = (stage: keyof SourceFlow['stages'], data: Partial<StageData>) => {
      setFlows((prev) => prev.map((f) =>
        f.source.id === sourceId
          ? { ...f, stages: { ...f.stages, [stage]: { ...f.stages[stage], ...data } } }
          : f
      ));
    };

    // Stage 1: Source capture -- get raw events from the source
    updateStage('source', { loading: true, error: '' });
    // Stage 1: Source capture
    let capturedEvents: Array<Record<string, unknown>> = [];
    try {
      const result = await window.api.auth.criblCapture(workerGroup, sourceId, 5, 60000);
      if (result.success && result.events.length > 0) {
        capturedEvents = result.events.slice(0, 5);
        updateStage('source', { events: capturedEvents, loading: false, eventCount: capturedEvents.length, lastCapture: Date.now() });
      } else {
        updateStage('source', { loading: false, error: result.error || 'No events captured' });
        return;
      }
    } catch (err) {
      updateStage('source', { loading: false, error: err instanceof Error ? err.message : 'Failed' });
      return;
    }

    await new Promise((r) => setTimeout(r, 500));

    // Stage 2: Sentinel -- find the same events on the Sentinel side
    // Extract identifying fields from source events to build a correlated query
    updateStage('sentinel', { loading: true, error: '' });
    if (!azureConnected) {
      updateStage('sentinel', { loading: false, error: 'Connect to Azure to query Sentinel' });
      return;
    }

    try {
      // Extract source IPs and timestamps from captured events for correlation
      const sourceIPs = new Set<string>();
      const destIPs = new Set<string>();
      capturedEvents.forEach((e) => {
        const raw = String(e._raw || '');
        // Extract IPs from PAN-OS CSV or generic fields
        const ips = raw.match(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g) || [];
        if (ips.length >= 2) { sourceIPs.add(ips[0]!); destIPs.add(ips[1]!); }
        // Also check parsed fields
        for (const [k, v] of Object.entries(e)) {
          if (typeof v === 'string' && /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v)) {
            if (k.toLowerCase().includes('src') || k.toLowerCase().includes('source')) sourceIPs.add(v);
            if (k.toLowerCase().includes('dst') || k.toLowerCase().includes('dest')) destIPs.add(v);
          }
        }
      });

      // Build a KQL query that searches for these specific events in Sentinel
      let query: string;
      const srcList = Array.from(sourceIPs).slice(0, 5);
      const dstList = Array.from(destIPs).slice(0, 5);

      if (srcList.length > 0) {
        const ipFilter = srcList.map((ip) => `SourceIP == "${ip}"`).join(' or ');
        query = `CommonSecurityLog | where ${ipFilter} | order by TimeGenerated desc | take 5`;
      } else {
        // Fallback: get most recent events
        query = 'CommonSecurityLog | order by TimeGenerated desc | take 5';
      }

      const result = await window.api.auth.azureQuery(query, 'P7D');
      if (result.success && result.rows.length > 0) {
        updateStage('sentinel', { events: result.rows, eventCount: result.rows.length, loading: false, lastCapture: Date.now() });
      } else {
        // Try broader search
        const fallbackQuery = 'CommonSecurityLog | order by TimeGenerated desc | take 5';
        const fallback = await window.api.auth.azureQuery(fallbackQuery, 'P7D');
        if (fallback.success && fallback.rows.length > 0) {
          updateStage('sentinel', { events: fallback.rows, eventCount: fallback.rows.length, loading: false, lastCapture: Date.now(), error: 'Showing recent events (exact source match not found)' });
        } else {
          updateStage('sentinel', { loading: false, error: fallback.error || 'No data in CommonSecurityLog. Ensure the pack is deployed with a valid destination secret.' });
        }
      }
    } catch (err) {
      updateStage('sentinel', { loading: false, error: err instanceof Error ? err.message : 'Query failed' });
    }
  }, [workerGroup, azureConnected]);

  // Capture all sources
  const captureAll = useCallback(async () => {
    for (const flow of flows) {
      await captureSource(flow.source.id);
    }
  }, [flows, captureSource]);

  // Auto-refresh
  useEffect(() => {
    if (autoRefresh && flows.length > 0) {
      intervalRef.current = setInterval(captureAll, 45000);
    } else if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [autoRefresh, captureAll, flows.length]);

  const totalSources = flows.length;
  const sourcesWithData = flows.filter((f) => f.stages.source.events.length > 0).length;
  const sourcesWithErrors = flows.filter((f) =>
    f.stages.source.error || f.stages.sentinel.error
  ).length;

  return (
    <div style={s.page}>
      <style>{`
        @keyframes flowPulse {
          0%, 100% { opacity: 0.4; transform: scale(1); }
          50% { opacity: 1; transform: scale(1.5); }
        }
      `}</style>

      <div style={s.topBar}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <button
              className="btn-secondary"
              style={{ fontSize: '11px', padding: '4px 10px' }}
              onClick={() => navigate('/')}
            >
              Back
            </button>
            <div style={s.title}>Data Flow Monitor</div>
          </div>
          <div style={s.subtitle}>Live pipeline view -- source through transformation to Sentinel</div>
        </div>
        <div style={s.controls}>
          {workerGroups.length > 1 && (
            <select
              style={{ fontSize: '11px', padding: '4px 8px', background: 'var(--bg-input)', border: '1px solid var(--border-color)', borderRadius: '4px', color: 'var(--text-primary)' }}
              value={workerGroup}
              onChange={(e) => setWorkerGroup(e.target.value)}
            >
              {workerGroups.map((g) => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
            </select>
          )}
          <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '10px', color: 'var(--text-muted)', cursor: 'pointer' }}>
            <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />
            Auto (45s)
          </label>
          <button className="btn-secondary" style={{ fontSize: '10px', padding: '4px 10px' }} onClick={loadSources}>
            Refresh
          </button>
          <button className="btn-primary" style={{ fontSize: '10px', padding: '4px 10px' }} onClick={captureAll} disabled={flows.length === 0}>
            Capture All
          </button>
        </div>
      </div>

      <div style={s.statusBar}>
        <div style={s.statusItem}>
          <div style={s.dot(criblConnected ? 'ok' : 'error')} />
          <span style={{ color: 'var(--text-secondary)' }}>Cribl: {criblConnected ? workerGroup : 'Not connected'}</span>
        </div>
        <div style={s.statusItem}>
          <div style={s.dot(azureConnected ? 'ok' : 'warn')} />
          <span style={{ color: 'var(--text-secondary)' }}>Sentinel: {azureConnected ? 'Connected' : 'Not connected'}</span>
        </div>
        <div style={s.statusItem}>
          <span style={{ color: 'var(--text-muted)' }}>{totalSources} sources</span>
        </div>
        {sourcesWithData > 0 && (
          <div style={s.statusItem}>
            <div style={s.dot('ok')} />
            <span style={{ color: 'var(--text-muted)' }}>{sourcesWithData} with data</span>
          </div>
        )}
        {sourcesWithErrors > 0 && (
          <div style={s.statusItem}>
            <div style={s.dot('error')} />
            <span style={{ color: 'var(--accent-red)' }}>{sourcesWithErrors} with errors</span>
          </div>
        )}
      </div>

      <div style={s.body}>
        {loading && <div style={s.emptyState}>Loading active sources...</div>}

        {!loading && !criblConnected && (
          <div style={s.emptyState}>
            <div style={s.emptyTitle}>Connect to Cribl</div>
            <div>Click the Cribl indicator in the top bar to connect, then data flows will appear here.</div>
          </div>
        )}

        {!loading && criblConnected && flows.length === 0 && (
          <div style={s.emptyState}>
            <div style={s.emptyTitle}>No active sources</div>
            <div>No enabled sources found on worker group "{workerGroup}". Configure sources in Cribl Stream.</div>
          </div>
        )}

        {flows.map((flow) => {
          const hasAnyData = Object.values(flow.stages).some((st) => st.events.length > 0);
          const hasAnyError = Object.values(flow.stages).some((st) => st.error);
          const health = hasAnyError ? 'error' : hasAnyData ? 'ok' : 'unknown';

          return (
            <div key={flow.source.id} style={s.flowRow(health, flow.expanded)}>
              {/* Collapsed header */}
              <div style={s.flowHeader} onClick={() => toggleExpand(flow.source.id)}>
                <div style={s.dot(health)} />
                <span style={s.sourceName}>{flow.source.id}</span>
                <span style={s.sourceType}>{flow.source.type}</span>

                {/* Mini stage bars */}
                <div style={s.stageIndicators}>
                  <div style={s.miniStage(flow.stages.source.events.length > 0, !!flow.stages.source.error)} title="Source" />
                  <span style={s.miniArrow}>{'--->'}</span>
                  <div style={s.miniStage(flow.stages.sentinel.events.length > 0, !!flow.stages.sentinel.error)} title="Sentinel" />
                </div>

                <button
                  className="btn-secondary"
                  style={s.captureBtn}
                  onClick={(e) => { e.stopPropagation(); captureSource(flow.source.id); }}
                >
                  Capture
                </button>
              </div>

              {/* Expanded stage detail */}
              {flow.expanded && (
                <>
                <div style={s.stagesRow}>
                  {(['source', 'sentinel'] as const).map((stage, idx) => (
                    <div key={stage} style={{ display: 'flex', flex: 1 }}>
                      <div style={s.stageCol(STAGE_COLORS[stage])}>
                        <div style={s.stageHead(STAGE_COLORS[stage])}>
                          <span>{stage === 'source' ? 'SOURCE (Cribl)' : 'DESTINATION (Sentinel)'}</span>
                          <span style={s.stageCount}>
                            {flow.stages[stage].events.length > 0 ? `${flow.stages[stage].events.length} events` : ''}
                          </span>
                        </div>
                        <div style={s.stageBody}>
                          {flow.stages[stage].loading && (
                            <div style={{ color: 'var(--text-muted)', textAlign: 'center', padding: '10px' }}>
                              {stage === 'sentinel' ? 'Querying Sentinel (ingestion may take 2-5 min)...' : 'Capturing...'}
                            </div>
                          )}
                          {flow.stages[stage].error && !flow.stages[stage].loading && (
                            <div style={{ color: 'var(--accent-red)', padding: '4px', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{flow.stages[stage].error}</div>
                          )}
                          {flow.stages[stage].events.map((event, i) => (
                            <MiniEvent
                              key={i}
                              event={event}
                              isNew={Date.now() - flow.stages[stage].lastCapture < 3000}
                              selected={selectedEvent?.sourceId === flow.source.id && selectedEvent?.eventIdx === i && stage === 'source'}
                              onClick={() => setSelectedEvent(
                                selectedEvent?.sourceId === flow.source.id && selectedEvent?.eventIdx === i
                                  ? null : { sourceId: flow.source.id, eventIdx: i }
                              )}
                            />
                          ))}
                        </div>
                      </div>
                      {idx < 1 && (
                        <div style={s.arrowCol}>
                          <div style={s.arrowDot(hasAnyData)} />
                        </div>
                      )}
                    </div>
                  ))}
                </div>

                {/* Event detail: side-by-side source vs sentinel comparison */}
                {selectedEvent?.sourceId === flow.source.id && (
                  <div style={{ padding: '0 8px 8px' }}>
                    <EventDetail
                      sourceEvent={flow.stages.source.events[selectedEvent.eventIdx] || null}
                      sentinelEvent={flow.stages.sentinel.events[selectedEvent.eventIdx] || flow.stages.sentinel.events[0] || null}
                    />
                  </div>
                )}
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default DataFlow;
