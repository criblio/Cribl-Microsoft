import { useState, useEffect } from 'react';

interface SentinelBrowserProps {
  onSelect: (solution: { name: string; path: string; details?: Record<string, unknown> }) => void;
}

interface SolutionEntry {
  name: string;
  path: string;
  type: string;
}

const styles = {
  container: {} as React.CSSProperties,
  searchBar: {
    marginBottom: '16px',
  } as React.CSSProperties,
  searchInput: {
    width: '100%',
    padding: '10px 14px',
    fontSize: '13px',
  } as React.CSSProperties,
  info: {
    fontSize: '12px',
    color: 'var(--text-muted)',
    marginBottom: '16px',
  } as React.CSSProperties,
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
    gap: '12px',
    maxHeight: '500px',
    overflow: 'auto',
    paddingRight: '4px',
  } as React.CSSProperties,
  card: {
    background: 'var(--bg-secondary)',
    border: '1px solid var(--border-color)',
    borderRadius: 'var(--radius)',
    padding: '14px',
    cursor: 'pointer',
    transition: 'border-color 0.15s',
  } as React.CSSProperties,
  cardName: {
    fontSize: '13px',
    fontWeight: 600,
    marginBottom: '4px',
    wordBreak: 'break-word' as const,
  } as React.CSSProperties,
  cardPath: {
    fontSize: '11px',
    color: 'var(--text-muted)',
    fontFamily: 'var(--font-mono)',
  } as React.CSSProperties,
  loading: {
    textAlign: 'center' as const,
    padding: '40px',
    color: 'var(--text-muted)',
  } as React.CSSProperties,
  error: {
    padding: '20px',
    color: 'var(--accent-red)',
    background: 'rgba(239, 83, 80, 0.1)',
    borderRadius: 'var(--radius)',
    fontSize: '13px',
  } as React.CSSProperties,
  count: {
    fontSize: '12px',
    color: 'var(--text-muted)',
    marginBottom: '12px',
  } as React.CSSProperties,
};

function SentinelBrowser({ onSelect }: SentinelBrowserProps) {
  const [solutions, setSolutions] = useState<SolutionEntry[]>([]);
  const [filtered, setFiltered] = useState<SolutionEntry[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    fetchSolutions();
  }, []);

  useEffect(() => {
    if (!search.trim()) {
      setFiltered(solutions);
    } else {
      const term = search.toLowerCase();
      setFiltered(solutions.filter((s) => s.name.toLowerCase().includes(term)));
    }
  }, [search, solutions]);

  async function fetchSolutions() {
    if (!window.api) return;
    setLoading(true);
    setError('');
    try {
      const result = await window.api.github.fetchSentinelSolutions();
      setSolutions(result);
      setFiltered(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setError(`Failed to fetch Sentinel solutions: ${message}`);
    } finally {
      setLoading(false);
    }
  }

  const handleSelect = async (solution: SolutionEntry) => {
    onSelect({
      name: solution.name,
      path: solution.path,
    });
  };

  if (loading) {
    return <div style={styles.loading}>Fetching Microsoft Sentinel Content Hub solutions...</div>;
  }

  if (error) {
    return (
      <div>
        <div style={styles.error}>{error}</div>
        <button className="btn-secondary" style={{ marginTop: '12px' }} onClick={fetchSolutions}>
          Retry
        </button>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <div style={styles.info}>
        Browse Microsoft Sentinel Content Hub solutions from the Azure/Azure-Sentinel GitHub repository.
        Select a solution to generate a Cribl Pack.
      </div>

      <div style={styles.searchBar}>
        <input
          style={styles.searchInput}
          type="text"
          placeholder="Search solutions (e.g. CrowdStrike, Palo Alto, Fortinet...)"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div style={styles.count}>
        Showing {filtered.length} of {solutions.length} solutions
      </div>

      <div style={styles.grid}>
        {filtered.map((solution) => (
          <div
            key={solution.path}
            style={styles.card}
            onClick={() => handleSelect(solution)}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--accent-purple)';
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--border-color)';
            }}
          >
            <div style={styles.cardName}>{solution.name}</div>
            <div style={styles.cardPath}>{solution.path}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default SentinelBrowser;
