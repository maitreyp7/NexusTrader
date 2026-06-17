'use client';
import { useState } from 'react';
import { Power, AlertTriangle } from 'lucide-react';

interface SliderProps {
  label: string; value: number; min: number; max: number;
  unit: string; color: string;
}

function GlowSlider({ label, value, min, max, unit, color }: SliderProps) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div>
      <div className="flex justify-between items-center mb-1.5">
        <span className="text-xs mono" style={{ color: '#6b7280' }}>{label}</span>
        <span className="text-xs mono font-semibold" style={{ color }}>{value}{unit}</span>
      </div>
      {/* Read-only progress bar — not an interactive input */}
      <div className="w-full h-1 rounded-full" style={{ background: 'rgba(255,255,255,0.06)' }}>
        <div
          className="h-1 rounded-full transition-all duration-500"
          style={{ width: `${pct}%`, background: color, boxShadow: `0 0 6px ${color}60` }}
        />
      </div>
    </div>
  );
}

function Toggle({ label, description, enabled, onChange }: {
  label: string; description: string; enabled: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between p-2.5 rounded-lg transition-all duration-200 hover-glow"
         style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)' }}>
      <div>
        <p className="text-xs font-medium mono" style={{ color: '#e0e0e0' }}>{label}</p>
        <p className="text-xs mono mt-0.5" style={{ color: '#4b5563' }}>{description}</p>
      </div>
      <button
        onClick={() => onChange(!enabled)}
        className="relative w-9 h-5 rounded-full transition-all duration-300 cursor-pointer flex-shrink-0"
        style={{ background: enabled ? 'rgba(0,255,159,0.3)' : 'rgba(255,255,255,0.08)',
                 border: enabled ? '1px solid rgba(0,255,159,0.5)' : '1px solid rgba(255,255,255,0.1)' }}
      >
        <div className="absolute top-0.5 w-4 h-4 rounded-full transition-all duration-300"
             style={{ left: enabled ? '17px' : '2px',
                      background: enabled ? '#00ff9f' : '#4b5563',
                      boxShadow: enabled ? '0 0 8px rgba(0,255,159,0.6)' : 'none' }} />
      </button>
    </div>
  );
}

export default function StrategyControls() {
  const [botRunning, setBotRunning] = useState(true);
  const [confirmEmergency, setConfirmEmergency] = useState(false);

  // Read-only — reflect actual bot config values from src/config.ts
  const risk       = 1.0;  // riskPerTradePct
  const stopLoss   = 2.0;  // stopLossPct
  const takeProfit = 3.0;  // takeProfitPct

  const [strategies, setStrategies] = useState({
    oversold:  true,
    momentum:  true,
    macd:      false,
  });

  const toggle = (k: keyof typeof strategies) =>
    setStrategies(s => ({ ...s, [k]: !s[k] }));

  return (
    <div className="glass rounded-xl p-4 flex flex-col gap-4 hover-glow h-full overflow-y-auto">
      <h2 className="text-sm font-semibold mono tracking-wide flex-shrink-0" style={{ color: '#e0e0e0' }}>
        STRATEGY CONTROLS
      </h2>

      {/* Bot on/off */}
      <div className="flex gap-2 flex-shrink-0">
        <button
          onClick={() => setBotRunning(true)}
          className="flex-1 flex items-center justify-center gap-2 py-2 rounded-lg text-xs mono font-semibold transition-all duration-200 cursor-pointer"
          style={{
            background: botRunning ? 'rgba(0,255,159,0.12)' : 'rgba(255,255,255,0.04)',
            border: botRunning ? '1px solid rgba(0,255,159,0.35)' : '1px solid rgba(255,255,255,0.08)',
            color: botRunning ? '#00ff9f' : '#4b5563',
            boxShadow: botRunning ? '0 0 12px rgba(0,255,159,0.15)' : 'none',
          }}
        >
          <Power size={12} /> START BOT
        </button>
        <button
          onClick={() => setBotRunning(false)}
          className="flex-1 flex items-center justify-center gap-2 py-2 rounded-lg text-xs mono font-semibold transition-all duration-200 cursor-pointer"
          style={{
            background: !botRunning ? 'rgba(245,158,11,0.12)' : 'rgba(255,255,255,0.04)',
            border: !botRunning ? '1px solid rgba(245,158,11,0.35)' : '1px solid rgba(255,255,255,0.08)',
            color: !botRunning ? '#f59e0b' : '#4b5563',
          }}
        >
          <Power size={12} /> STOP BOT
        </button>
      </div>

      {/* Strategies */}
      <div className="flex flex-col gap-2 flex-shrink-0">
        <p className="text-xs mono" style={{ color: '#4b5563' }}>ACTIVE PATTERNS</p>
        <Toggle label="Oversold Accumulation" description="RSI + MACD reversal confluence" enabled={strategies.oversold} onChange={() => toggle('oversold')} />
        <Toggle label="Momentum Breakout"     description="Volume-confirmed trend follow"  enabled={strategies.momentum} onChange={() => toggle('momentum')} />
        <Toggle label="MACD Crossover"        description="Signal line cross entry"         enabled={strategies.macd}     onChange={() => toggle('macd')} />
      </div>

      {/* Sliders */}
      <div className="flex flex-col gap-4 flex-shrink-0">
        <p className="text-xs mono" style={{ color: '#4b5563' }}>RISK PARAMETERS</p>
        <GlowSlider label="Risk Per Trade" value={risk}       min={0.5} max={3}  unit="%" color="#00cfff" />
        <GlowSlider label="Stop Loss"      value={stopLoss}   min={0.5} max={5}  unit="%" color="#ff4d6d" />
        <GlowSlider label="Take Profit"    value={takeProfit} min={1}   max={10} unit="%" color="#00ff9f" />
      </div>

      {/* R:R display */}
      <div className="p-2.5 rounded-lg flex-shrink-0"
           style={{ background: 'rgba(0,207,255,0.04)', border: '1px solid rgba(0,207,255,0.1)' }}>
        <div className="flex justify-between text-xs mono">
          <span style={{ color: '#4b5563' }}>Reward/Risk Ratio</span>
          <span style={{ color: '#00cfff' }}>{(takeProfit / stopLoss).toFixed(1)}:1</span>
        </div>
      </div>

      {/* Emergency close */}
      <div className="flex-shrink-0">
        {!confirmEmergency ? (
          <button
            onClick={() => setConfirmEmergency(true)}
            className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg text-xs mono font-bold transition-all duration-200 cursor-pointer hover-glow"
            style={{ background: 'rgba(255,77,109,0.08)', border: '1px solid rgba(255,77,109,0.25)', color: '#ff4d6d' }}
          >
            <AlertTriangle size={12} /> EMERGENCY CLOSE ALL
          </button>
        ) : (
          <div className="rounded-lg p-3" style={{ background: 'rgba(255,77,109,0.1)', border: '1px solid rgba(255,77,109,0.3)' }}>
            <p className="text-xs mono mb-2 text-center" style={{ color: '#ff4d6d' }}>
              Close ALL positions immediately?
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setConfirmEmergency(false)}
                className="flex-1 py-1.5 rounded text-xs mono cursor-pointer transition-colors"
                style={{ background: 'rgba(255,255,255,0.06)', color: '#6b7280' }}
              >
                Cancel
              </button>
              <button
                onClick={() => { alert('Emergency close sent!'); setConfirmEmergency(false); }}
                className="flex-1 py-1.5 rounded text-xs mono font-bold cursor-pointer transition-colors"
                style={{ background: 'rgba(255,77,109,0.25)', color: '#ff4d6d', border: '1px solid rgba(255,77,109,0.4)' }}
              >
                CONFIRM
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
