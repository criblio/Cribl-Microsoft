import { useState } from 'react';
import SentinelBrowser from './PackBuilder/SentinelBrowser';
import PackScaffold from './PackBuilder/PackScaffold';
import PackManager from './PackBuilder/PackManager';
import StatusBadge from '../components/StatusBadge';

type PackBuilderView = 'manager' | 'browse' | 'scaffold';

interface SelectedSolution {
  name: string;
  path: string;
  details?: Record<string, unknown>;
}

const styles = {
  page: { maxWidth: '1000px' } as React.CSSProperties,
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: '24px',
  } as React.CSSProperties,
  title: { fontSize: '20px', fontWeight: 700 } as React.CSSProperties,
  tabs: {
    display: 'flex',
    gap: '0',
    marginBottom: '20px',
    borderBottom: '1px solid var(--border-color)',
  } as React.CSSProperties,
  tab: (active: boolean) => ({
    padding: '10px 20px',
    fontSize: '13px',
    fontWeight: 600,
    cursor: 'pointer',
    color: active ? 'var(--accent-purple)' : 'var(--text-secondary)',
    borderBottom: active ? '2px solid var(--accent-purple)' : '2px solid transparent',
    background: 'none',
    borderTop: 'none',
    borderLeft: 'none',
    borderRight: 'none',
    borderRadius: 0,
  } as React.CSSProperties),
};

function PackBuilder() {
  const [view, setView] = useState<PackBuilderView>('manager');
  const [selectedSolution, setSelectedSolution] = useState<SelectedSolution | null>(null);

  const handleSolutionSelected = (solution: SelectedSolution) => {
    setSelectedSolution(solution);
    setView('scaffold');
  };

  const handlePackCreated = () => {
    setSelectedSolution(null);
    setView('manager');
  };

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <h1 style={styles.title}>Cribl Pack Builder</h1>
        <StatusBadge status="idle" />
      </div>

      <div style={styles.tabs}>
        <button style={styles.tab(view === 'manager')} onClick={() => setView('manager')}>
          My Packs
        </button>
        <button style={styles.tab(view === 'browse')} onClick={() => setView('browse')}>
          Sentinel Content Hub
        </button>
        {view === 'scaffold' && selectedSolution && (
          <button style={styles.tab(true)}>
            New Pack: {selectedSolution.name}
          </button>
        )}
      </div>

      {view === 'manager' && (
        <PackManager onNewPack={() => setView('browse')} />
      )}

      {view === 'browse' && (
        <SentinelBrowser onSelect={handleSolutionSelected} />
      )}

      {view === 'scaffold' && selectedSolution && (
        <PackScaffold
          solution={selectedSolution}
          onCreated={handlePackCreated}
          onCancel={() => setView('browse')}
        />
      )}
    </div>
  );
}

export default PackBuilder;
