interface StatusBadgeProps {
  status: 'running' | 'success' | 'error' | 'idle';
  label?: string;
}

const colorMap = {
  running: 'var(--accent-orange)',
  success: 'var(--accent-green)',
  error: 'var(--accent-red)',
  idle: 'var(--text-muted)',
};

const styles = {
  badge: (status: string) => ({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    padding: '4px 10px',
    borderRadius: '12px',
    fontSize: '11px',
    fontWeight: 600,
    background: `${colorMap[status as keyof typeof colorMap]}22`,
    color: colorMap[status as keyof typeof colorMap],
    fontFamily: 'var(--font-mono)',
  } as React.CSSProperties),
  dot: (status: string) => ({
    width: '6px',
    height: '6px',
    borderRadius: '50%',
    background: colorMap[status as keyof typeof colorMap],
  } as React.CSSProperties),
};

function StatusBadge({ status, label }: StatusBadgeProps) {
  const defaultLabels = {
    running: 'Running',
    success: 'Complete',
    error: 'Error',
    idle: 'Ready',
  };

  return (
    <span style={styles.badge(status)}>
      <span style={styles.dot(status)} />
      {label || defaultLabels[status]}
    </span>
  );
}

export default StatusBadge;
