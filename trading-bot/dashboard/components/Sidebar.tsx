'use client';
import { useState } from 'react';
import {
  LayoutDashboard, Activity, Terminal, ChevronRight,
  BookOpen, Telescope,
} from 'lucide-react';

interface SidebarProps {
  active:   string;
  onChange: (page: string) => void;
}

const NAV = [
  { id: 'dashboard',   label: 'Dashboard',    icon: LayoutDashboard },
  { id: 'market-lens', label: 'Market Lens',  icon: Telescope },
  { id: 'trades',      label: 'Live Trades',  icon: Activity },
  { id: 'journal',     label: 'Journal',      icon: BookOpen },
  { id: 'terminal',    label: 'Terminal',     icon: Terminal },
];

export default function Sidebar({ active, onChange }: SidebarProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <aside
      style={{
        background: '#0a0b10',
        borderRight: '1px solid rgba(255,255,255,0.05)',
        display: 'flex',
        flexDirection: 'column',
        height: '100dvh',
        width: expanded ? 192 : 56,
        flexShrink: 0,
        transition: 'width 0.25s cubic-bezier(0.16,1,0.3,1)',
        zIndex: 50,
        position: 'relative',
      }}
    >
      {/* Logo */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '16px 12px', borderBottom: '1px solid rgba(255,255,255,0.05)',
      }}>
        <div style={{
          width: 32, height: 32, borderRadius: 8, flexShrink: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(0,255,159,0.1)', border: '1px solid rgba(0,255,159,0.3)',
          boxShadow: '0 0 12px rgba(0,255,159,0.15)',
        }}>
          <span style={{ color: '#00ff9f', fontSize: 11, fontWeight: 700, fontFamily: 'JetBrains Mono, monospace' }}>ORB</span>
        </div>
        {expanded && (
          <span style={{ color: '#00ff9f', fontSize: 13, fontWeight: 600, fontFamily: 'JetBrains Mono, monospace', whiteSpace: 'nowrap' }}>
            TradeBot
          </span>
        )}
      </div>

      {/* Nav items */}
      <nav style={{ flex: 1, padding: '16px 8px', display: 'flex', flexDirection: 'column', gap: 4 }}>
        {NAV.map(({ id, label, icon: Icon }) => {
          const isActive = active === id;
          return (
            <button
              key={id}
              title={label}
              onClick={() => onChange(id)}
              style={{
                display: 'flex', alignItems: 'center', gap: 12,
                padding: '10px 8px', borderRadius: 8, width: '100%',
                textAlign: 'left', cursor: 'pointer', border: 'none',
                background: isActive ? 'rgba(0,255,159,0.06)' : 'transparent',
                outline: isActive ? '1px solid rgba(0,255,159,0.15)' : 'none',
                color: isActive ? '#00ff9f' : '#6b7280',
                transition: 'all 0.15s ease',
              }}
              onMouseEnter={e => {
                if (!isActive) (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.05)';
              }}
              onMouseLeave={e => {
                if (!isActive) (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
              }}
            >
              <Icon size={17} style={{ flexShrink: 0 }} />
              {expanded && (
                <span style={{ fontSize: 12, fontWeight: 500, fontFamily: 'JetBrains Mono, monospace', whiteSpace: 'nowrap' }}>
                  {label}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {/* Expand toggle */}
      <button
        onClick={() => setExpanded(e => !e)}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: 12, borderTop: '1px solid rgba(255,255,255,0.05)',
          background: 'transparent', border: 'none', cursor: 'pointer',
          color: '#4b5563', transition: 'color 0.15s ease',
        }}
        onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.color = '#9ca3af'; }}
        onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.color = '#4b5563'; }}
      >
        <ChevronRight
          size={14}
          style={{ transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.3s ease' }}
        />
      </button>
    </aside>
  );
}
