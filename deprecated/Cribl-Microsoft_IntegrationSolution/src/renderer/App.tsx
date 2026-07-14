import { useState, useEffect } from 'react';
import { Routes, Route } from 'react-router-dom';
import Layout from './components/Layout';
import DepsCheck from './pages/DepsCheck';
import RepoSetup from './pages/RepoSetup';
import SetupWizard from './pages/SetupWizard';
import DataFlow from './pages/DataFlow';
import DcrAutomation from './pages/DcrAutomation';
import Discovery from './pages/Discovery';
import LabAutomation from './pages/LabAutomation';
import SentinelIntegration from './pages/SentinelIntegration';
import PackBuilder from './pages/PackBuilder';
import Packs from './pages/Packs';
import SiemMigration from './pages/SiemMigration';
import Settings from './pages/Settings';
import AuthBar from './components/AuthBar';

// Full-width layout without sidebar (for DataFlow)
function FullWidthLayout() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', width: '100vw', overflow: 'hidden' }}>
      <AuthBar />
      <div style={{ flex: 1, overflow: 'hidden' }}>
        <DataFlow />
      </div>
    </div>
  );
}

// Export integration mode for other components to read
export let integrationMode: string = 'full';

// Acceptable Use Agreement -- shown on first launch
function AcceptableUse({ onAccept }: { onAccept: () => void }) {
  const [scrolledToBottom, setScrolledToBottom] = useState(false);
  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 30) setScrolledToBottom(true);
  };
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      height: '100vh', padding: '40px', background: 'var(--bg-primary)',
    }}>
      <div style={{
        maxWidth: '700px', width: '100%', background: 'var(--bg-secondary)',
        border: '1px solid var(--border-color)', borderRadius: '8px',
        padding: '32px', boxShadow: '0 4px 24px rgba(0,0,0,0.3)',
        display: 'flex', flexDirection: 'column', maxHeight: '80vh',
      }}>
        <div style={{ fontSize: '20px', fontWeight: 700, marginBottom: '4px' }}>
          Acceptable Use Agreement
        </div>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '16px' }}>
          Please review the terms below before using the Cribl SOC Optimization Toolkit.
        </div>

        <div style={{
          flex: 1, overflowY: 'auto', padding: '16px', background: 'var(--bg-primary)',
          border: '1px solid var(--border-color)', borderRadius: '4px',
          fontSize: '12px', lineHeight: 1.6, color: 'var(--text-secondary)', marginBottom: '16px',
        }} onScroll={handleScroll}>
          <p style={{ fontWeight: 700, color: 'var(--text-primary)', marginBottom: '8px' }}>
            Cribl SOC Optimization Toolkit for Microsoft Sentinel
          </p>
          <p>
            This toolkit helps security engineers build Cribl Stream integration packs for
            Microsoft Sentinel. It runs locally on your workstation and can operate in multiple modes
            depending on the permissions you grant it.
          </p>

          <p style={{ fontWeight: 700, color: 'var(--text-primary)', margin: '14px 0 6px' }}>
            What this app can do when granted permissions:
          </p>
          <ul style={{ paddingLeft: '20px', margin: '8px 0' }}>
            <li style={{ marginBottom: '6px' }}>
              <strong>Azure (when connected):</strong> Create resource groups, Log Analytics workspaces,
              Data Collection Rules, and enable Microsoft Sentinel -- using your existing Azure PowerShell
              session. These operations only execute with the permissions your Azure account has been granted.
              Resources created may incur costs on your subscription.
            </li>
            <li style={{ marginBottom: '6px' }}>
              <strong>Cribl Stream (when connected):</strong> Upload packs, create routes, commit and deploy
              configurations to worker groups -- using OAuth credentials or admin credentials you provide.
              Only operates within the permissions of the Cribl account used.
            </li>
            <li style={{ marginBottom: '6px' }}>
              <strong>GitHub (read-only):</strong> Fetches Sentinel Solution definitions and Elastic
              integration sample data from public repositories using a GitHub Personal Access Token
              for rate limit purposes.
            </li>
          </ul>

          <p style={{ fontWeight: 700, color: 'var(--accent-green)', margin: '14px 0 6px' }}>
            Air-Gapped mode -- no external modifications:
          </p>
          <p>
            The app includes an <strong>Air-Gapped mode</strong> that disables all Azure and Cribl
            connections. In this mode, the app only generates local artifacts (Cribl packs, ARM templates,
            deployment instructions) without modifying any external systems. Use this mode when you want
            to review and approve all changes before applying them manually.
          </p>

          <p style={{ fontWeight: 700, color: 'var(--text-primary)', margin: '14px 0 6px' }}>
            Additional information:
          </p>
          <ul style={{ paddingLeft: '20px', margin: '8px 0' }}>
            <li style={{ marginBottom: '6px' }}>
              <strong>Credential storage:</strong> Cribl API credentials and GitHub tokens are encrypted
              on your local machine using Windows DPAPI (OS-level encryption).
            </li>
            <li style={{ marginBottom: '6px' }}>
              <strong>EDR compatibility:</strong> Fetching certain Sentinel Solutions may trigger EDR
              alerts due to offensive security tool references in detection content. The app includes
              a built-in blocklist to skip known problematic solutions.
            </li>
            <li style={{ marginBottom: '6px' }}>
              <strong>Platform:</strong> Tested on Windows 11. Other operating systems may have issues
              with PowerShell-based features.
            </li>
          </ul>

          <p style={{ margin: '12px 0 6px' }}>
            For the full security disclaimer, see{' '}
            <span style={{ color: 'var(--accent-blue)', fontFamily: 'var(--font-mono)' }}>SECURITY_DISCLAIMER.md</span>
            {' '}in the repository root.
          </p>
          <p style={{ marginTop: '16px', fontStyle: 'italic', color: 'var(--text-muted)' }}>
            This software is provided as-is. You are responsible for reviewing and approving any
            resources created or configurations deployed by this toolkit.
          </p>
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
            {scrolledToBottom ? 'You have reviewed the agreement.' : 'Scroll to the bottom to continue.'}
          </div>
          <button className="btn-success" style={{ fontSize: '13px', padding: '10px 32px', fontWeight: 700 }}
            onClick={onAccept} disabled={!scrolledToBottom}>
            I Accept
          </button>
        </div>
      </div>
    </div>
  );
}

function App() {
  const [accepted, setAccepted] = useState<boolean | null>(null); // null = checking
  const [depsReady, setDepsReady] = useState(false);
  const [reposDone, setReposDone] = useState<boolean | null>(null);
  const [setupDone, setSetupDone] = useState<boolean | null>(null);

  // Check if user has previously accepted the agreement
  useEffect(() => {
    if (!window.api) { setAccepted(false); return; }
    window.api.config.read('accepted-terms.json').then((data: any) => {
      setAccepted(!!data?.accepted);
    }).catch(() => setAccepted(false));
  }, []);

  const handleAccept = async () => {
    if (window.api) {
      try {
        await window.api.config.write('accepted-terms.json', { accepted: true, acceptedAt: new Date().toISOString() });
      } catch { /* non-fatal */ }
    }
    setAccepted(true);
  };

  // Check if setup wizard has been completed previously
  useEffect(() => {
    if (!depsReady) return;
    const check = async () => {
      try {
        if (window.api) {
          const config = await window.api.config.read('integration-mode.json') as any;
          if (config?.mode) {
            integrationMode = String(config.mode);
          }
        }
      } catch { /* config doesn't exist yet */ }
      // Always show repos page and wizard on every launch
      setReposDone(false);
      setSetupDone(false);
    };
    check();
  }, [depsReady]);

  // Show acceptance agreement on first launch
  if (accepted === null) {
    return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', color: 'var(--text-muted)' }}>Loading...</div>;
  }
  if (!accepted) {
    return <AcceptableUse onAccept={handleAccept} />;
  }

  if (!depsReady) {
    return <DepsCheck onReady={() => setDepsReady(true)} />;
  }

  // Show loading while checking setup status
  if (reposDone === null || setupDone === null) {
    return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', color: 'var(--text-muted)' }}>Loading...</div>;
  }

  // First-run only: repos step (skippable, can be revisited via sidebar)
  if (!reposDone) {
    return <RepoSetup wizard onContinue={() => setReposDone(true)} />;
  }

  // Show setup wizard if credentials / mode not configured
  if (!setupDone) {
    return <SetupWizard onComplete={(mode) => { integrationMode = mode; setSetupDone(true); }} />;
  }

  return (
    <Routes>
      <Route path="/data-flow" element={<FullWidthLayout />} />
      <Route path="/" element={<Layout />}>
        <Route index element={<SentinelIntegration />} />
        <Route path="dcr-automation" element={<DcrAutomation />} />
        <Route path="discovery" element={<Discovery />} />
        <Route path="lab-automation" element={<LabAutomation />} />
        <Route path="pack-builder" element={<PackBuilder />} />
        <Route path="packs" element={<Packs />} />
        <Route path="repositories" element={<RepoSetup />} />
        <Route path="siem-migration" element={<SiemMigration />} />
        <Route path="settings" element={<Settings />} />
      </Route>
    </Routes>
  );
}

export default App;
