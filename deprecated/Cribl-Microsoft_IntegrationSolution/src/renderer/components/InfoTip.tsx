import { useState, useRef, useEffect, useCallback } from 'react';

interface InfoTipProps {
  text: string;
  maxWidth?: number;
}

const iconStyle: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  width: '14px', height: '14px', borderRadius: '50%', cursor: 'pointer',
  fontSize: '9px', fontWeight: 700, fontFamily: 'var(--font-mono)',
  background: 'rgba(79, 195, 247, 0.15)', color: 'var(--accent-blue)',
  border: '1px solid rgba(79, 195, 247, 0.3)', flexShrink: 0,
  lineHeight: 1, userSelect: 'none',
};

function InfoTip({ text, maxWidth = 320 }: InfoTipProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const iconRef = useRef<HTMLSpanElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  const updatePosition = useCallback(() => {
    if (!iconRef.current) return;
    const rect = iconRef.current.getBoundingClientRect();
    let top = rect.top - 8; // above the icon with gap
    let left = rect.left + rect.width / 2;

    // After first render, adjust if popover goes off-screen
    if (popRef.current) {
      const popRect = popRef.current.getBoundingClientRect();
      // If it would go above viewport, show below instead
      if (top - popRect.height < 4) {
        top = rect.bottom + 8;
      }
      // Keep within horizontal bounds
      if (left - popRect.width / 2 < 4) left = popRect.width / 2 + 4;
      if (left + popRect.width / 2 > window.innerWidth - 4) left = window.innerWidth - popRect.width / 2 - 4;
    }

    setPos({ top, left });
  }, []);

  useEffect(() => {
    if (!open) { setPos(null); return; }
    updatePosition();
    // Re-position after render so popRef dimensions are available
    requestAnimationFrame(updatePosition);

    const close = (e: MouseEvent) => {
      if (iconRef.current?.contains(e.target as Node)) return;
      if (popRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open, updatePosition]);

  return (
    <span style={{ display: 'inline-flex', marginLeft: '4px' }}>
      <span
        ref={iconRef}
        style={iconStyle}
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
      >
        i
      </span>
      {open && pos && (
        <div
          ref={popRef}
          style={{
            position: 'fixed', zIndex: 10000,
            top: `${pos.top}px`, left: `${pos.left}px`,
            transform: 'translate(-50%, -100%)',
            padding: '10px 12px',
            background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
            borderRadius: '6px', boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
            fontSize: '11px', lineHeight: 1.5, color: 'var(--text-secondary)',
            whiteSpace: 'pre-wrap', maxWidth: `${maxWidth}px`, width: 'max-content',
            fontWeight: 400, fontFamily: 'var(--font-primary, -apple-system, sans-serif)',
            pointerEvents: 'none',
          }}
        >
          {text}
          <div style={{
            position: 'absolute', bottom: '-5px', left: '50%',
            width: '8px', height: '8px', background: 'var(--bg-secondary)',
            border: '1px solid var(--border-color)', borderTop: 'none', borderLeft: 'none',
            transform: 'translateX(-50%) rotate(45deg)',
          }} />
        </div>
      )}
    </span>
  );
}

export default InfoTip;
