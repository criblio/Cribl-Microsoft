import { useState, useEffect } from 'react';
import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';
import Terminal from './Terminal';
import AuthBar from './AuthBar';

const styles = {
  container: {
    display: 'flex',
    height: '100vh',
    width: '100vw',
    overflow: 'hidden',
  } as React.CSSProperties,
  main: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column' as const,
    overflow: 'hidden',
  } as React.CSSProperties,
  content: {
    flex: 1,
    overflow: 'auto',
    padding: '24px',
  } as React.CSSProperties,
  terminalWrapper: (expanded: boolean) => ({
    height: expanded ? 'var(--terminal-height)' : '36px',
    borderTop: '1px solid var(--border-color)',
    transition: 'height 0.2s ease',
    flexShrink: 0,
  } as React.CSSProperties),
};

function Layout() {
  const [terminalExpanded, setTerminalExpanded] = useState(true);

  return (
    <div style={styles.container}>
      <Sidebar />
      <div style={styles.main}>
        <AuthBar />
        <div style={styles.content}>
          <Outlet />
        </div>
        <div style={styles.terminalWrapper(terminalExpanded)}>
          <Terminal
            expanded={terminalExpanded}
            onToggle={() => setTerminalExpanded(!terminalExpanded)}
          />
        </div>
      </div>
    </div>
  );
}

export default Layout;
