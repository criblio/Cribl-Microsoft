import { useState, useEffect } from 'react';

interface CrblFile {
  path: string;
  name: string;
  size: number;
  createdAt: number;
}

interface PackInfo {
  name: string;
  version: string;
  path: string;
  displayName?: string;
  author?: string;
  description?: string;
  crblPath?: string;
  crblSize?: number;
  createdAt?: number;
  crblFiles?: CrblFile[];
  tables?: string[];
}

interface StorageInfo {
  packsDir: string;
  totalSize: number;
  packCount: number;
  crblCount: number;
  orphanedCrblCount: number;
  oldVersionCount: number;
}

const s = {
  page: { maxWidth: '900px' } as React.CSSProperties,
  title: { fontSize: '20px', fontWeight: 700, marginBottom: '8px' } as React.CSSProperties,
  subtitle: { fontSize: '12px', color: 'var(--text-muted)', marginBottom: '24px' } as React.CSSProperties,
  grid: { display: 'flex', flexDirection: 'column' as const, gap: '12px' } as React.CSSProperties,
  card: {
    background: 'var(--bg-secondary)',
    border: '1px solid var(--border-color)',
    borderRadius: 'var(--radius)',
    padding: '16px',
  } as React.CSSProperties,
  cardHeader: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '16px',
  } as React.CSSProperties,
  cardInfo: { flex: 1, minWidth: 0 } as React.CSSProperties,
  packName: { fontSize: '15px', fontWeight: 600, marginBottom: '4px' } as React.CSSProperties,
  packMeta: {
    fontSize: '11px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)',
    display: 'flex', gap: '12px', flexWrap: 'wrap' as const, marginBottom: '6px',
  } as React.CSSProperties,
  packDesc: { fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '8px' } as React.CSSProperties,
  actions: {
    display: 'flex', gap: '8px', flexShrink: 0, flexWrap: 'wrap' as const,
  } as React.CSSProperties,
  btn: {
    padding: '6px 14px', fontSize: '11px', borderRadius: 'var(--radius)',
    border: '1px solid var(--border-color)', background: 'var(--bg-primary)',
    color: 'var(--text-primary)', cursor: 'pointer', whiteSpace: 'nowrap' as const,
    fontFamily: 'var(--font-mono)',
  } as React.CSSProperties,
  btnPrimary: {
    padding: '6px 14px', fontSize: '11px', borderRadius: 'var(--radius)',
    border: 'none', background: 'var(--accent-blue)', color: '#000',
    cursor: 'pointer', fontWeight: 600, whiteSpace: 'nowrap' as const,
    fontFamily: 'var(--font-mono)',
  } as React.CSSProperties,
  btnDanger: {
    padding: '6px 14px', fontSize: '11px', borderRadius: 'var(--radius)',
    border: '1px solid rgba(239, 83, 80, 0.3)', background: 'transparent',
    color: 'var(--accent-red)', cursor: 'pointer', whiteSpace: 'nowrap' as const,
    fontFamily: 'var(--font-mono)',
  } as React.CSSProperties,
  empty: {
    textAlign: 'center' as const, padding: '48px 16px',
    color: 'var(--text-muted)', fontSize: '13px',
  } as React.CSSProperties,
  statusRow: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px',
  } as React.CSSProperties,
  count: { fontSize: '12px', color: 'var(--text-muted)' } as React.CSSProperties,
  refreshBtn: {
    padding: '4px 10px', fontSize: '11px', borderRadius: 'var(--radius)',
    border: '1px solid var(--border-color)', background: 'var(--bg-secondary)',
    color: 'var(--text-secondary)', cursor: 'pointer', fontFamily: 'var(--font-mono)',
  } as React.CSSProperties,
  detailsGrid: {
    display: 'flex', gap: '16px', flexWrap: 'wrap' as const, marginTop: '10px',
    padding: '10px', background: 'var(--bg-primary)', borderRadius: '4px',
    border: '1px solid var(--border-color)',
  } as React.CSSProperties,
  badge: {
    fontSize: '10px', padding: '2px 8px', borderRadius: '10px',
    fontFamily: 'var(--font-mono)', display: 'inline-block', marginRight: '4px', marginBottom: '4px',
  } as React.CSSProperties,
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function Packs() {
  const [packs, setPacks] = useState<PackInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [deployedPacks, setDeployedPacks] = useState<Map<string, string[]>>(new Map());
  const [storage, setStorage] = useState<StorageInfo | null>(null);
  const [cleaning, setCleaning] = useState(false);
  const [cleanResult, setCleanResult] = useState<{ removed: string[]; freedBytes: number } | null>(null);

  const loadPacks = async () => {
    if (!window.api) return;
    setLoading(true);
    try {
      const result = await window.api.packBuilder.list();
      setPacks(result || []);

      // Load storage info
      try {
        const info = await window.api.packBuilder.storageInfo();
        setStorage(info);
      } catch { /* skip */ }

      // Check which packs are deployed to which worker groups
      try {
        const auth = await window.api.auth.status();
        if (auth.cribl.connected) {
          const groups = await window.api.auth.criblWorkerGroups();
          if (groups.success) {
            const deployed = new Map<string, string[]>();
            for (const group of groups.groups) {
              try {
                const groupPacks = await window.api.auth.criblListPacks(group.id);
                if (groupPacks.packs) {
                  for (const p of groupPacks.packs) {
                    const existing = deployed.get(p.id) || [];
                    existing.push(group.name);
                    deployed.set(p.id, existing);
                  }
                }
              } catch { /* skip */ }
            }
            setDeployedPacks(deployed);
          }
        }
      } catch { /* skip */ }
    } catch { /* skip */ }
    setLoading(false);
  };

  useEffect(() => { loadPacks(); }, []);

  const handleDownload = (pack: PackInfo) => {
    if (!pack.crblPath) return;
    const url = '/api/pack/download?path=' + encodeURIComponent(pack.crblPath);
    const a = document.createElement('a');
    a.href = url;
    a.download = pack.name + '_' + pack.version + '.crbl';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const handleDelete = async (pack: PackInfo) => {
    if (!window.api) return;
    const crblCount = pack.crblFiles?.length || 0;
    const msg = 'Delete pack "' + (pack.displayName || pack.name) + '"'
      + (crblCount > 0 ? ' and ' + crblCount + ' .crbl file' + (crblCount > 1 ? 's' : '') : '')
      + '? This cannot be undone.';
    if (!confirm(msg)) return;
    setDeleting(pack.name);
    try {
      await window.api.packBuilder.delete(pack.name);
      await loadPacks();
    } catch { /* skip */ }
    setDeleting(null);
  };

  const handleDeleteCrbl = async (crblName: string) => {
    if (!window.api) return;
    if (!confirm('Delete "' + crblName + '"? This cannot be undone.')) return;
    try {
      await window.api.packBuilder.deleteCrbl(crblName);
      await loadPacks();
    } catch { /* skip */ }
  };

  const handleRepackage = async (pack: PackInfo) => {
    if (!window.api) return;
    try {
      await window.api.packBuilder.package(pack.path);
      await loadPacks();
    } catch { /* skip */ }
  };

  const handleClean = async () => {
    if (!window.api) return;
    setCleaning(true);
    setCleanResult(null);
    try {
      const result = await window.api.packBuilder.clean();
      setCleanResult(result);
      await loadPacks();
    } catch { /* skip */ }
    setCleaning(false);
  };

  const cleanableCount = (storage?.orphanedCrblCount || 0) + (storage?.oldVersionCount || 0);

  return (
    <div style={s.page}>
      <div style={s.title}>Packs</div>
      <div style={s.subtitle}>Cribl packs built by the SOC Optimization Toolkit</div>

      {/* Storage info bar */}
      {storage && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '10px 14px', marginBottom: '16px', borderRadius: 'var(--radius)',
          background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
          fontSize: '11px', fontFamily: 'var(--font-mono)',
        }}>
          <div style={{ display: 'flex', gap: '16px', color: 'var(--text-muted)' }}>
            <span>{storage.packCount} pack{storage.packCount !== 1 ? 's' : ''}</span>
            <span>{storage.crblCount} .crbl file{storage.crblCount !== 1 ? 's' : ''}</span>
            <span>{formatBytes(storage.totalSize)} total</span>
            {storage.orphanedCrblCount > 0 && (
              <span style={{ color: 'var(--accent-orange)' }}>
                {storage.orphanedCrblCount} orphaned
              </span>
            )}
            {storage.oldVersionCount > 0 && (
              <span style={{ color: 'var(--accent-orange)' }}>
                {storage.oldVersionCount} old version{storage.oldVersionCount !== 1 ? 's' : ''}
              </span>
            )}
          </div>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            {cleanResult && (
              <span style={{ color: 'var(--accent-green)', fontSize: '10px' }}>
                Removed {cleanResult.removed.length} file{cleanResult.removed.length !== 1 ? 's' : ''}, freed {formatBytes(cleanResult.freedBytes)}
              </span>
            )}
            {cleanableCount > 0 && (
              <button
                style={{ ...s.btnDanger, padding: '3px 10px', fontSize: '10px' }}
                onClick={handleClean}
                disabled={cleaning}
              >
                {cleaning ? 'Cleaning...' : 'Clean Up (' + cleanableCount + ')'}
              </button>
            )}
          </div>
        </div>
      )}

      <div style={s.statusRow}>
        <span style={s.count}>{packs.length} pack{packs.length !== 1 ? 's' : ''}</span>
        <button style={s.refreshBtn} onClick={loadPacks} disabled={loading}>
          {loading ? 'Loading...' : 'Refresh'}
        </button>
      </div>

      {packs.length === 0 && !loading && (
        <div style={s.empty}>
          No packs built yet. Use the Sentinel Integration page to create one.
        </div>
      )}

      <div style={s.grid}>
        {packs.map((pack) => {
          const deployGroups = deployedPacks.get(pack.name) || [];
          const isExpanded = expanded === pack.name;
          const crblFiles = pack.crblFiles || [];

          return (
            <div key={pack.name} style={s.card}>
              <div style={s.cardHeader}>
                <div style={s.cardInfo}>
                  <div style={s.packName}>
                    <span style={{ cursor: 'pointer' }} onClick={() => setExpanded(isExpanded ? null : pack.name)}>
                      {isExpanded ? '\u25BC' : '\u25B6'} {pack.displayName || pack.name}
                    </span>
                  </div>
                  <div style={s.packMeta}>
                    <span>v{pack.version}</span>
                    {pack.author && <span>{pack.author}</span>}
                    {pack.crblSize != null && <span>{formatBytes(pack.crblSize)}</span>}
                    {pack.createdAt && <span>{formatDate(pack.createdAt)}</span>}
                    {crblFiles.length > 1 && (
                      <span style={{ color: 'var(--accent-orange)' }}>
                        {crblFiles.length} versions
                      </span>
                    )}
                  </div>
                  {pack.description && <div style={s.packDesc}>{pack.description}</div>}

                  {/* Deployment status badges */}
                  <div>
                    {deployGroups.length > 0 ? (
                      deployGroups.map((g) => (
                        <span key={g} style={{ ...s.badge, background: 'rgba(102, 187, 106, 0.15)', color: 'var(--accent-green)', border: '1px solid rgba(102, 187, 106, 0.3)' }}>
                          Deployed: {g}
                        </span>
                      ))
                    ) : (
                      <span style={{ ...s.badge, background: 'rgba(255, 255, 255, 0.05)', color: 'var(--text-muted)', border: '1px solid var(--border-color)' }}>
                        Not deployed
                      </span>
                    )}
                    {!pack.crblPath && (
                      <span style={{ ...s.badge, background: 'rgba(255, 152, 0, 0.15)', color: 'var(--accent-orange)', border: '1px solid rgba(255, 152, 0, 0.3)' }}>
                        Not packaged
                      </span>
                    )}
                  </div>
                </div>
                <div style={s.actions}>
                  {pack.crblPath ? (
                    <button style={s.btnPrimary} onClick={() => handleDownload(pack)}>Download</button>
                  ) : (
                    <button style={s.btn} onClick={() => handleRepackage(pack)}>Package</button>
                  )}
                  <button
                    style={s.btnDanger}
                    onClick={() => handleDelete(pack)}
                    disabled={deleting === pack.name}
                  >
                    {deleting === pack.name ? '...' : 'Delete'}
                  </button>
                </div>
              </div>

              {/* Expanded details */}
              {isExpanded && (
                <div style={s.detailsGrid}>
                  <div style={{ width: '100%', fontSize: '11px', fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}>
                    <div style={{ marginBottom: '4px', fontWeight: 600, color: 'var(--text-primary)' }}>Pack Contents</div>
                    <div>Path: {pack.path}</div>
                    {deployGroups.length > 0 && <div>Deployed to: {deployGroups.join(', ')}</div>}
                    {pack.tables && pack.tables.length > 0 && <div>Tables: {pack.tables.join(', ')}</div>}

                    {/* .crbl version list */}
                    {crblFiles.length > 0 && (
                      <div style={{ marginTop: '10px' }}>
                        <div style={{ fontWeight: 600, color: 'var(--text-primary)', marginBottom: '6px' }}>
                          Build Artifacts ({crblFiles.length})
                        </div>
                        <div style={{
                          border: '1px solid var(--border-color)', borderRadius: '4px',
                          overflow: 'hidden',
                        }}>
                          {crblFiles.map((crbl, i) => (
                            <div key={crbl.name} style={{
                              display: 'flex', alignItems: 'center', gap: '8px',
                              padding: '6px 10px', fontSize: '11px',
                              borderBottom: i < crblFiles.length - 1 ? '1px solid var(--border-color)' : 'none',
                              background: i === 0 ? 'rgba(102, 187, 106, 0.05)' : 'transparent',
                            }}>
                              <span style={{ flex: 1, color: 'var(--text-primary)' }}>{crbl.name}</span>
                              <span style={{ color: 'var(--text-muted)' }}>{formatBytes(crbl.size)}</span>
                              <span style={{ color: 'var(--text-muted)', minWidth: '140px' }}>{formatDate(crbl.createdAt)}</span>
                              {i === 0 && (
                                <span style={{
                                  fontSize: '9px', padding: '1px 6px', borderRadius: '3px',
                                  background: 'rgba(102, 187, 106, 0.15)', color: 'var(--accent-green)',
                                }}>latest</span>
                              )}
                              {i > 0 && (
                                <button
                                  style={{
                                    fontSize: '10px', padding: '2px 8px', borderRadius: '3px',
                                    border: '1px solid rgba(239, 83, 80, 0.3)', background: 'transparent',
                                    color: 'var(--accent-red)', cursor: 'pointer', fontFamily: 'var(--font-mono)',
                                  }}
                                  onClick={() => handleDeleteCrbl(crbl.name)}
                                >
                                  Remove
                                </button>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default Packs;
