'use client';
import { useEffect, useState, useCallback } from 'react';
import { apiFetch } from '@/lib/apiFetch';
import { Telescope, TrendingUp, TrendingDown, Minus, AlertTriangle, Clock, RefreshCw, ChevronDown, ChevronUp, Zap, Brain } from 'lucide-react';

interface Thesis {
  ticker:                    string;
  company:                   string;
  sector:                    string;
  verdict:                   'BUY_WATCH' | 'SELL_WATCH' | 'MONITOR';
  confidence:                number;
  final_score:               number;
  priority:                  string;
  thesis:                    string;
  entry_rationale?:          string;
  catalysts:                 string[];
  risks:                     string[];
  second_order_beneficiaries: string[];
  time_horizon:              string;
  market_priced_in:          boolean;
  insider_signal:            boolean;
  congressional_signal:      boolean;
  macro_tailwind:            boolean;
  sources_used:              string[];
}

interface SignalsData {
  generated_at: string;
  date:         string;
  theses:       Thesis[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function verdictColor(verdict: string) {
  if (verdict === 'BUY_WATCH')  return '#00ff9f';
  if (verdict === 'SELL_WATCH') return '#ff4d6d';
  return '#f59e0b';
}

function verdictIcon(verdict: string) {
  if (verdict === 'BUY_WATCH')  return <TrendingUp  size={13} />;
  if (verdict === 'SELL_WATCH') return <TrendingDown size={13} />;
  return <Minus size={13} />;
}

function confidenceBar(score: number) {
  const color =
    score >= 80 ? '#00ff9f' :
    score >= 65 ? '#f59e0b' :
    score >= 50 ? '#00cfff' : '#6b7280';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ flex: 1, height: 4, background: 'rgba(255,255,255,0.06)', borderRadius: 2, overflow: 'hidden' }}>
        <div style={{ width: `${score}%`, height: '100%', background: color, borderRadius: 2, transition: 'width 0.4s ease' }} />
      </div>
      <span className="mono" style={{ fontSize: 11, color, minWidth: 28, textAlign: 'right' }}>{score}</span>
    </div>
  );
}

function Badge({ label, color }: { label: string; color: string }) {
  return (
    <span className="mono" style={{
      fontSize: 10, padding: '2px 6px', borderRadius: 4,
      background: `${color}15`, border: `1px solid ${color}30`, color,
    }}>
      {label}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Thesis card — expandable
// ─────────────────────────────────────────────────────────────────────────────

function ThesisCard({ t, rank }: { t: Thesis; rank: number }) {
  const [expanded, setExpanded] = useState(rank === 0); // top pick expanded by default
  const color = verdictColor(t.verdict);

  return (
    <div
      className="rounded-xl transition-all"
      style={{
        background: 'rgba(255,255,255,0.02)',
        border: `1px solid ${expanded ? color + '25' : 'rgba(255,255,255,0.06)'}`,
        overflow: 'hidden',
        transition: 'border-color 0.2s',
      }}
    >
      {/* Header row — always visible */}
      <button
        onClick={() => setExpanded(e => !e)}
        style={{
          width: '100%', background: 'transparent', border: 'none', cursor: 'pointer',
          padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 12, textAlign: 'left',
        }}
      >
        {/* Rank */}
        <span className="mono" style={{ fontSize: 11, color: '#2d3748', minWidth: 16 }}>#{rank + 1}</span>

        {/* Verdict icon */}
        <span style={{ color, flexShrink: 0 }}>{verdictIcon(t.verdict)}</span>

        {/* Ticker + company */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span className="mono" style={{ fontSize: 14, fontWeight: 700, color }}>{t.ticker}</span>
            <span className="mono" style={{ fontSize: 11, color: '#6b7280', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {t.company}
            </span>
            <span className="mono" style={{ fontSize: 10, color: '#4b5563' }}>{t.sector}</span>
          </div>
          <div style={{ marginTop: 4 }}>
            {confidenceBar(t.final_score)}
          </div>
        </div>

        {/* Signal badges */}
        <div style={{ display: 'flex', gap: 4, flexShrink: 0, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <Badge label={t.verdict.replace('_', ' ')} color={color} />
          <Badge label={t.time_horizon.toUpperCase()} color="#00cfff" />
          {t.insider_signal && <Badge label="INSIDER" color="#a855f7" />}
          {t.macro_tailwind  && <Badge label="MACRO ↑"  color="#f59e0b" />}
          {!t.market_priced_in && <Badge label="EARLY"  color="#00ff9f" />}
        </div>

        {/* Expand chevron */}
        <span style={{ color: '#4b5563', flexShrink: 0 }}>
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </span>
      </button>

      {/* Expanded body */}
      {expanded && (
        <div style={{ padding: '0 16px 16px', borderTop: '1px solid rgba(255,255,255,0.04)' }}>
          {/* Thesis */}
          <div style={{ marginTop: 12 }}>
            <p className="mono" style={{ fontSize: 12, color: '#9ca3af', lineHeight: 1.6 }}>{t.thesis}</p>
          </div>

          {/* Entry rationale */}
          {t.entry_rationale && (
            <div style={{ marginTop: 10, padding: '8px 12px', borderRadius: 6, background: `${color}08`, border: `1px solid ${color}20` }}>
              <p className="mono" style={{ fontSize: 11, color, lineHeight: 1.5 }}>
                <span style={{ opacity: 0.6 }}>WHY NOW: </span>{t.entry_rationale}
              </p>
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 14 }}>
            {/* Catalysts */}
            {t.catalysts.length > 0 && (
              <div>
                <p className="mono" style={{ fontSize: 10, color: '#4b5563', marginBottom: 6, letterSpacing: '0.08em' }}>CATALYSTS</p>
                <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {t.catalysts.map((c, i) => (
                    <li key={i} className="mono" style={{ fontSize: 11, color: '#6b7280', display: 'flex', gap: 6 }}>
                      <span style={{ color: '#00ff9f', flexShrink: 0 }}>+</span>{c}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Risks */}
            {t.risks.length > 0 && (
              <div>
                <p className="mono" style={{ fontSize: 10, color: '#4b5563', marginBottom: 6, letterSpacing: '0.08em' }}>RISKS</p>
                <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {t.risks.map((r, i) => (
                    <li key={i} className="mono" style={{ fontSize: 11, color: '#6b7280', display: 'flex', gap: 6 }}>
                      <span style={{ color: '#ff4d6d', flexShrink: 0 }}>−</span>{r}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {/* Second order beneficiaries */}
          {t.second_order_beneficiaries.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <p className="mono" style={{ fontSize: 10, color: '#4b5563', marginBottom: 6, letterSpacing: '0.08em' }}>SECOND-ORDER PLAYS</p>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {t.second_order_beneficiaries.map((b, i) => (
                  <Badge key={i} label={b} color="#00cfff" />
                ))}
              </div>
            </div>
          )}

          {/* Sources */}
          {t.sources_used.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <p className="mono" style={{ fontSize: 10, color: '#2d3748', marginBottom: 4, letterSpacing: '0.08em' }}>SOURCES</p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {t.sources_used.slice(0, 4).map((s, i) => (
                  <p key={i} className="mono" style={{ fontSize: 10, color: '#374151' }}>· {s.slice(0, 90)}</p>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────────────────────

export default function MarketLens() {
  const [data,     setData]     = useState<SignalsData | null>(null);
  const [error,    setError]    = useState<string | null>(null);
  const [loading,  setLoading]  = useState(true);
  const [lastFetch, setLastFetch] = useState<Date | null>(null);

  const fetchSignals = useCallback(async () => {
    try {
      const res = await apiFetch('/api/market-lens');
      if (!res.ok) {
        const err = await res.json();
        setError(err.error ?? 'Failed to load signals');
        return;
      }
      const json = await res.json();
      setData(json);
      setError(null);
      setLastFetch(new Date());
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSignals();
    // Refresh every 5 minutes — signals only update once a day but check for new runs
    const t = setInterval(fetchSignals, 5 * 60_000);
    return () => clearInterval(t);
  }, [fetchSignals]);

  const isStale = data ? data.date !== new Date().toISOString().slice(0, 10) : false;

  const buyCount  = data?.theses.filter(t => t.verdict === 'BUY_WATCH').length  ?? 0;
  const sellCount = data?.theses.filter(t => t.verdict === 'SELL_WATCH').length ?? 0;
  const monCount  = data?.theses.filter(t => t.verdict === 'MONITOR').length    ?? 0;

  return (
    <div className="glass rounded-xl flex flex-col" style={{ height: '100%', overflow: 'hidden' }}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b flex-shrink-0"
           style={{ borderColor: 'rgba(255,255,255,0.05)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Telescope size={15} style={{ color: '#00cfff' }} />
          <h2 className="mono" style={{ fontSize: 13, fontWeight: 600, color: '#e0e0e0', letterSpacing: '0.05em' }}>
            MARKET LENS
          </h2>
          {data && (
            <span className="mono" style={{
              fontSize: 10, padding: '2px 7px', borderRadius: 10,
              background: 'rgba(0,207,255,0.08)', border: '1px solid rgba(0,207,255,0.15)', color: '#00cfff',
            }}>
              {data.theses.length} theses
            </span>
          )}
          {isStale && (
            <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <AlertTriangle size={11} style={{ color: '#f59e0b' }} />
              <span className="mono" style={{ fontSize: 10, color: '#f59e0b' }}>stale — run pipeline</span>
            </span>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {/* Summary badges */}
          {data && (
            <div style={{ display: 'flex', gap: 6 }}>
              {buyCount  > 0 && <Badge label={`${buyCount} BUY`}     color="#00ff9f" />}
              {sellCount > 0 && <Badge label={`${sellCount} SELL`}   color="#ff4d6d" />}
              {monCount  > 0 && <Badge label={`${monCount} MONITOR`} color="#f59e0b" />}
            </div>
          )}

          {/* Date + refresh */}
          {data && (
            <span className="mono" style={{ fontSize: 10, color: '#4b5563', display: 'flex', alignItems: 'center', gap: 4 }}>
              <Clock size={10} />
              {data.date}
            </span>
          )}
          <button
            onClick={fetchSignals}
            style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#4b5563', display: 'flex' }}
            title="Refresh"
          >
            <RefreshCw size={12} />
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-4 py-4 min-h-0" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {loading && (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: '#4b5563' }}>
            <Brain size={24} style={{ opacity: 0.3, marginBottom: 8 }} />
            <p className="mono" style={{ fontSize: 12 }}>Loading signals...</p>
          </div>
        )}

        {error && !loading && (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
            <AlertTriangle size={24} style={{ color: '#f59e0b', opacity: 0.5, marginBottom: 8 }} />
            <p className="mono" style={{ fontSize: 12, color: '#f59e0b' }}>{error}</p>
            <p className="mono" style={{ fontSize: 11, color: '#4b5563', marginTop: 6 }}>
              Run: <span style={{ color: '#00cfff' }}>python main.py --ingest</span> then enable API key and run full pipeline
            </p>
          </div>
        )}

        {!loading && !error && data?.theses.length === 0 && (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: '#4b5563' }}>
            <Zap size={24} style={{ opacity: 0.3, marginBottom: 8 }} />
            <p className="mono" style={{ fontSize: 12 }}>No theses passed the confidence threshold.</p>
          </div>
        )}

        {!loading && !error && data?.theses.map((t, i) => (
          <ThesisCard key={t.ticker + i} t={t} rank={i} />
        ))}

        {lastFetch && (
          <p className="mono" style={{ fontSize: 10, color: '#1f2937', textAlign: 'center', marginTop: 4 }}>
            Last fetched {lastFetch.toLocaleTimeString()}
          </p>
        )}
      </div>
    </div>
  );
}
