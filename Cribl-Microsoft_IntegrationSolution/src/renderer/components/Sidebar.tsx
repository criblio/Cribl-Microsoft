import { useState, useEffect } from 'react';
import { NavLink } from 'react-router-dom';
import CriblLogo from './CriblLogo';

interface NavItem {
  path: string;
  label: string;
  icon: string;
}

interface NavItemDef extends NavItem {
  requires?: 'cribl' | 'azure' | 'both';  // undefined = always shown
}

const allNavItems: NavItemDef[] = [
  { path: '/', label: 'Sentinel Integration', icon: '[S]' },
  { path: '/data-flow', label: 'Data Flow', icon: '[F]', requires: 'cribl' },
  { path: '/dcr-automation', label: 'DCR Automation', icon: '[A]', requires: 'azure' },
  { path: '/discovery', label: 'Discovery', icon: '[D]', requires: 'cribl' },
  { path: '/lab-automation', label: 'Labs', icon: '[L]', requires: 'azure' },
  { path: '/siem-migration', label: 'SIEM Migration', icon: '[M]' },
  { path: '/pack-builder', label: 'Pack Builder', icon: '[B]' },
  { path: '/packs', label: 'Packs', icon: '[P]' },
  { path: '/repositories', label: 'Repositories', icon: '[R]' },
  { path: '/settings', label: 'Settings', icon: '[G]' },
];

function getNavItems(mode: string): NavItemDef[] {
  return allNavItems.filter((item) => {
    if (!item.requires) return true;
    if (mode === 'full') return true;
    if (mode === 'air-gapped') return false;
    if (mode === 'cribl-only') return item.requires !== 'azure';
    if (mode === 'azure-only') return item.requires !== 'cribl';
    return true;
  });
}

const styles = {
  sidebar: {
    width: 'var(--sidebar-width)',
    background: 'var(--bg-secondary)',
    borderRight: '1px solid var(--border-color)',
    display: 'flex',
    flexDirection: 'column' as const,
    flexShrink: 0,
    overflow: 'hidden',
  } as React.CSSProperties,
  header: {
    padding: '20px 16px 16px',
    borderBottom: '1px solid var(--border-color)',
  } as React.CSSProperties,
  title: {
    fontSize: '15px',
    fontWeight: 700,
    color: 'var(--accent-blue)',
    letterSpacing: '0.5px',
  } as React.CSSProperties,
  subtitle: {
    fontSize: '11px',
    color: 'var(--text-muted)',
    marginTop: '4px',
  } as React.CSSProperties,
  nav: {
    flex: 1,
    padding: '8px 0',
    overflow: 'auto',
  } as React.CSSProperties,
  link: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    padding: '10px 16px',
    color: 'var(--text-secondary)',
    textDecoration: 'none',
    fontSize: '13px',
    borderLeft: '3px solid transparent',
    transition: 'all 0.15s',
  } as React.CSSProperties,
  activeLink: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    padding: '10px 16px',
    color: 'var(--accent-blue)',
    textDecoration: 'none',
    fontSize: '13px',
    borderLeft: '3px solid var(--accent-blue)',
    background: 'rgba(79, 195, 247, 0.08)',
    transition: 'all 0.15s',
  } as React.CSSProperties,
  icon: {
    fontFamily: 'var(--font-mono)',
    fontSize: '11px',
    width: '24px',
    textAlign: 'center' as const,
    color: 'var(--text-muted)',
  } as React.CSSProperties,
  footer: {
    padding: '12px 16px',
    borderTop: '1px solid var(--border-color)',
    fontSize: '11px',
    color: 'var(--text-muted)',
  } as React.CSSProperties,
};

const badgeStyle = (critical: boolean): React.CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  minWidth: '18px',
  height: '18px',
  padding: '0 5px',
  borderRadius: '9px',
  fontSize: '10px',
  fontWeight: 700,
  fontFamily: 'var(--font-mono)',
  marginLeft: 'auto',
  background: critical ? 'rgba(239, 83, 80, 0.2)' : 'rgba(255, 167, 38, 0.2)',
  color: critical ? 'var(--accent-red)' : 'var(--accent-orange)',
});

const syncDot: React.CSSProperties = {
  width: '6px',
  height: '6px',
  borderRadius: '50%',
  background: 'var(--accent-green)',
  marginLeft: '6px',
  flexShrink: 0,
};

function ModeIndicator() {
  const [mode, setMode] = useState('');
  useEffect(() => {
    if (!window.api) return;
    window.api.config.read('integration-mode.json')
      .then((c: any) => setMode(c?.mode || ''))
      .catch(() => {});
  }, []);
  if (!mode) return null;
  const labels: Record<string, { text: string; color: string }> = {
    'full': { text: 'Full', color: 'var(--accent-green)' },
    'azure-only': { text: 'Azure Only', color: 'var(--accent-blue)' },
    'cribl-only': { text: 'Cribl Only', color: 'var(--accent-orange)' },
    'air-gapped': { text: 'Air-Gapped', color: 'var(--accent-purple, #AB47BC)' },
  };
  const m = labels[mode] || { text: mode, color: 'var(--text-muted)' };
  return (
    <span style={{ fontSize: '9px', padding: '2px 6px', borderRadius: '3px', background: 'rgba(255,255,255,0.05)', color: m.color, fontWeight: 600 }}>
      {m.text}
    </span>
  );
}

function Sidebar() {
  const [changeCount, setChangeCount] = useState(0);
  const [criticalCount, setCriticalCount] = useState(0);
  const [syncState, setSyncState] = useState<string>('idle');
  const [sidebarMode, setSidebarMode] = useState('full');

  useEffect(() => {
    if (!window.api) return;
    window.api.config.read('integration-mode.json')
      .then((c: any) => setSidebarMode(c?.mode || 'full'))
      .catch(() => {});
  }, []);

  const navItems = getNavItems(sidebarMode);

  useEffect(() => {
    if (!window.api) return;

    // Poll change detection status
    const checkAlerts = async () => {
      try {
        const status = await window.api.changeDetection.status();
        setChangeCount(status.summary.packsWithChanges);
        setCriticalCount(status.summary.criticalCount);
      } catch { /* not available yet */ }
    };

    // Listen for live broadcasts
    const unsubChanges = window.api.changeDetection.onStatus((ev) => {
      setChangeCount(ev.alertCount);
      setCriticalCount(ev.criticalCount);
    });

    const unsubSync = window.api.registrySync.onProgress((ev) => {
      setSyncState(ev.state);
    });

    checkAlerts();
    const interval = setInterval(checkAlerts, 30000);

    return () => {
      clearInterval(interval);
      unsubChanges();
      unsubSync();
    };
  }, []);

  return (
    <div style={styles.sidebar}>
      <div style={styles.header}>
        <CriblLogo height={22} />
        <div style={styles.subtitle}>
          SOC Optimization Toolkit
          {syncState === 'syncing' && (
            <span style={syncDot} title="Registry sync in progress" />
          )}
        </div>
      </div>
      <nav style={styles.nav}>
        {navItems.map((item) => (
          <NavLink
            key={item.path}
            to={item.path}
            end={item.path === '/'}
            style={({ isActive }) => (isActive ? styles.activeLink : styles.link)}
          >
            <span style={styles.icon}>{item.icon}</span>
            {item.label}
            {item.path === '/pack-builder' && changeCount > 0 && (
              <span style={badgeStyle(criticalCount > 0)}>{changeCount}</span>
            )}
          </NavLink>
        ))}
      </nav>
      <div style={styles.footer}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span>v1.0.0</span>
          <ModeIndicator />
        </div>
      </div>
    </div>
  );
}

export default Sidebar;
