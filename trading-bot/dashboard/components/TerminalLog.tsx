'use client';
import { useState, useEffect, useRef, useCallback } from 'react';
import { Terminal, ChevronRight } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';

interface LogEntry {
  id:        string;
  timestamp: string;
  level:     'INFO' | 'WARN' | 'ERROR' | 'TRADE';
  message:   string;
  animate:   boolean;
}

interface TerminalLogProps {
  fullHeight?: boolean;
}

const LEVEL_STYLE: Record<string, { color: string; label: string }> = {
  INFO:  { color: '#4b5563', label: 'INFO ' },
  WARN:  { color: '#f59e0b', label: 'WARN ' },
  ERROR: { color: '#ff4d6d', label: 'ERROR' },
  TRADE: { color: '#00ff9f', label: 'TRADE' },
};

function LogLine({ line }: { line: LogEntry }) {
  const style    = LEVEL_STYLE[line.level] ?? LEVEL_STYLE.INFO;
  const msgColor = line.level === 'TRADE' ? '#00ff9f'
                 : line.level === 'ERROR' ? '#ff4d6d'
                 : line.level === 'WARN'  ? '#f59e0b'
                 : '#6b7280';
  return (
    <div className={`flex items-start gap-2 text-xs mono leading-relaxed ${line.animate ? 'log-line' : ''}`}>
      <span style={{ color: '#2d3748', flexShrink: 0 }}>{line.timestamp}</span>
      <span className="font-bold flex-shrink-0" style={{ color: style.color }}>[{style.label}]</span>
      <span style={{ color: msgColor }}>{line.message}</span>
    </div>
  );
}

export default function TerminalLog({ fullHeight }: TerminalLogProps) {
  const [logs,     setLogs]     = useState<LogEntry[]>([]);
  const [command,  setCommand]  = useState('');
  const [loading,  setLoading]  = useState(true);
  const bottomRef  = useRef<HTMLDivElement>(null);
  const inputRef   = useRef<HTMLInputElement>(null);
  const lastLineId = useRef('');

  // Fetch real bot logs from API
  const fetchLogs = useCallback(async () => {
    try {
      const res  = await apiFetch('/api/logs');
      const data = await res.json();
      if (data.error || !data.logs?.length) { setLoading(false); return; }

      const fresh = data.logs as LogEntry[];
      const lastId = fresh[fresh.length - 1]?.id ?? '';

      setLogs(prev => {
        if (lastId === lastLineId.current) return prev;
        lastLineId.current = lastId;

        // Mark new lines for animation
        const prevIds = new Set(prev.map(l => l.id));
        return fresh.map(l => ({ ...l, animate: !prevIds.has(l.id) }));
      });
      setLoading(false);
    } catch {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchLogs();
    const t = setInterval(fetchLogs, 5_000); // poll every 5s
    return () => clearInterval(t);
  }, [fetchLogs]);

  // Auto-scroll to bottom when new lines arrive
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs.length]);

  function handleCommand(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key !== 'Enter' || !command.trim()) return;
    const now = new Date().toLocaleTimeString('en-US', { hour12: false });
    const cmd = command.trim().toLowerCase();

    const responses: Record<string, { level: LogEntry['level']; message: string }> = {
      help:      { level: 'INFO',  message: 'Commands: status | positions | clear | help' },
      status:    { level: 'INFO',  message: 'ORB Bot — reading logs from logs/bot-stdout.log. Refresh for live data.' },
      positions: { level: 'TRADE', message: 'Check Alpaca dashboard or the Active Positions panel.' },
      clear:     { level: 'INFO',  message: '' },
    };

    if (cmd === 'clear') { setLogs([]); setCommand(''); return; }

    const response = responses[cmd] ?? { level: 'ERROR' as const, message: `Unknown: "${command}" — try "help"` };
    setLogs(prev => [
      ...prev,
      { id: `cmd-${Date.now()}`,  timestamp: now, level: 'INFO',         message: `> ${command}`, animate: true },
      { id: `res-${Date.now()}`,  timestamp: now, level: response.level, message: response.message, animate: true },
    ]);
    setCommand('');
  }

  return (
    <div className="glass rounded-xl flex flex-col hover-glow" style={{ height: fullHeight ? '100%' : undefined, minHeight: 0 }}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b flex-shrink-0"
           style={{ borderColor: 'rgba(255,255,255,0.05)' }}>
        <div className="flex items-center gap-2">
          <Terminal size={14} style={{ color: '#00ff9f' }} />
          <h2 className="text-sm font-semibold mono tracking-wide" style={{ color: '#e0e0e0' }}>SYSTEM LOG</h2>
          {!loading && (
            <span className="text-xs mono" style={{ color: '#4b5563' }}>— live from bot-stdout.log</span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-2.5 h-2.5 rounded-full" style={{ background: '#ff4d6d' }} />
          <div className="w-2.5 h-2.5 rounded-full" style={{ background: '#f59e0b' }} />
          <div className="w-2.5 h-2.5 rounded-full" style={{ background: '#00ff9f' }} />
        </div>
      </div>

      {/* Log lines */}
      <div className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-1 min-h-0">
        {loading && (
          <p className="text-xs mono" style={{ color: '#4b5563' }}>Reading bot log...</p>
        )}
        {!loading && logs.length === 0 && (
          <p className="text-xs mono" style={{ color: '#4b5563' }}>No log entries yet. Bot may not be running.</p>
        )}
        {logs.map(line => <LogLine key={line.id} line={line} />)}
        <div ref={bottomRef} />
      </div>

      {/* Command input */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-t flex-shrink-0"
           style={{ borderColor: 'rgba(255,255,255,0.05)', background: 'rgba(0,0,0,0.2)' }}>
        <ChevronRight size={12} style={{ color: '#00ff9f', flexShrink: 0 }} />
        <input
          ref={inputRef}
          type="text"
          value={command}
          onChange={e => setCommand(e.target.value)}
          onKeyDown={handleCommand}
          placeholder="type a command... (try: status, help)"
          className="flex-1 bg-transparent text-xs mono outline-none"
          style={{ color: '#00ff9f', caretColor: '#00ff9f' }}
          spellCheck={false}
          autoComplete="off"
        />
        <span className="cursor-blink text-xs mono" style={{ color: '#00ff9f' }}>█</span>
      </div>
    </div>
  );
}
