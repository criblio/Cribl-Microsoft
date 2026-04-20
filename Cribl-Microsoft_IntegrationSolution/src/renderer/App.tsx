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

function App() {
  const [depsReady, setDepsReady] = useState(false);
  const [reposDone, setReposDone] = useState<boolean | null>(null); // null = checking
  const [setupDone, setSetupDone] = useState<boolean | null>(null); // null = checking

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
