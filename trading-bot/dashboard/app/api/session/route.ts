import { NextResponse } from 'next/server';
import { readFileSync, existsSync, readdirSync } from 'fs';
import path from 'path';

// Base directory that holds the bot's logs/sessions + logs/journal.
// The ORB bot writes to /opt/nexustrader/orb-bot/logs — NOT dashboard/../logs.
// Override with ORB_LOGS_DIR; default points at the real location on the VPS.
const ORB_LOGS_DIR = process.env.ORB_LOGS_DIR || '/opt/nexustrader/orb-bot/logs';
const SESSIONS_DIR = path.join(ORB_LOGS_DIR, 'sessions');
const JOURNAL_DIR  = path.join(ORB_LOGS_DIR, 'journal');

function patchSession(session: any): any {
  if (!session) return session;
  if (Array.isArray(session.trades)) {
    const closed = session.trades.filter((t: any) => t.outcome === 'WIN' || t.outcome === 'LOSS');
    session.dailyPnL = closed.reduce((sum: number, t: any) => sum + (t.realizedPnL ?? 0), 0);
  }
  return session;
}

function correctedTrades(trades: any[]): any[] {
  return trades.map(t => {
    if (t.exitPrice == null || t.outcome === 'OPEN' || t.outcome === 'STALE') return t;
    const isShort = (t.pattern ?? '').includes('SHORT');
    const pnl = isShort
      ? (t.entryPrice - t.exitPrice) * t.coinsTraded
      : (t.exitPrice - t.entryPrice) * t.coinsTraded;
    const pnlPct = isShort
      ? (t.entryPrice - t.exitPrice) / t.entryPrice
      : (t.exitPrice - t.entryPrice) / t.entryPrice;
    const outcome = pnl > 0.01 ? 'WIN' : pnl < -0.01 ? 'LOSS' : 'BREAK_EVEN';
    return { ...t, realizedPnL: pnl, realizedPnLPct: pnlPct, outcome };
  });
}

// Reads today's session log from logs/sessions/YYYY-MM-DD.json
// Falls back to most recent log for closed-trade history, but NEVER
// carries over stale OPEN trades from a prior session day.
function getSessionLog() {
  const logsDir = SESSIONS_DIR;
  if (!existsSync(logsDir)) return null;

  const today = new Date().toISOString().split('T')[0];
  const todayPath = path.join(logsDir, `${today}.json`);

  // Today's log exists — return it as-is (OPEN trades are legitimate)
  if (existsSync(todayPath)) {
    try {
      const s = JSON.parse(readFileSync(todayPath, 'utf8'));
      if (Array.isArray(s.trades)) s.trades = correctedTrades(s.trades);
      return patchSession(s);
    } catch { return null; }
  }

  // No session today yet — fall back to most recent log BUT scrub any
  // OPEN trades so stale positions from a prior day never show up.
  const files = readdirSync(logsDir)
    .filter(f => f.endsWith('.json'))
    .sort()
    .reverse();

  if (files.length === 0) return null;

  try {
    const session = JSON.parse(readFileSync(path.join(logsDir, files[0]), 'utf8'));
    // Mark every OPEN trade as STALE so the UI knows not to show them as live
    if (Array.isArray(session.trades)) {
      session.trades = correctedTrades(
        session.trades.map((t: { outcome: string }) =>
          t.outcome === 'OPEN' ? { ...t, outcome: 'STALE' } : t
        )
      );
    }
    return patchSession(session);
  } catch {
    return null;
  }
}

function getPatternStats() {
  const statsPath = path.join(JOURNAL_DIR, 'pattern-stats.json');
  if (!existsSync(statsPath)) return [];
  try {
    return JSON.parse(readFileSync(statsPath, 'utf8'));
  } catch {
    return [];
  }
}

// Build historical P&L from all session logs
function getHistoricalPnL() {
  const logsDir = SESSIONS_DIR;
  if (!existsSync(logsDir)) return [];

  const files = readdirSync(logsDir)
    .filter(f => f.endsWith('.json'))
    .sort()
    .slice(-14); // last 14 sessions

  return files.map(f => {
    try {
      const session = JSON.parse(readFileSync(path.join(logsDir, f), 'utf8'));
      const dateStr = f.replace('.json', '');
      const [, m, d] = dateStr.split('-');
      const trades = correctedTrades(session.trades ?? []);
      // A closed trade is any with a known outcome — include BREAK_EVEN so a day that
      // traded (even at $0) still shows on the calendar instead of vanishing.
      const closed = trades.filter((t: any) => t.outcome === 'WIN' || t.outcome === 'LOSS' || t.outcome === 'BREAK_EVEN');
      const decided = closed.filter((t: any) => t.outcome === 'WIN' || t.outcome === 'LOSS');
      const grossPnL = closed.reduce((sum: number, t: any) => sum + (t.realizedPnL ?? 0), 0);
      return {
        date:    `${m}/${d}`,
        pnl:     grossPnL,
        trades:  closed.length,
        winRate: decided.length === 0 ? 0 : decided.filter((t: any) => t.outcome === 'WIN').length / decided.length,
      };
    } catch {
      return null;
    }
  }).filter(Boolean);
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const dateParam = searchParams.get('date'); // YYYY-MM-DD — browse a specific past day

    // Validate date format before using it in a file path
    if (dateParam && !/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
      return NextResponse.json({ error: 'Invalid date format' }, { status: 400 });
    }

    let session;
    if (dateParam) {
      // Fetch a specific historical session
      const logsDir = SESSIONS_DIR;
      const filePath  = path.join(logsDir, `${dateParam}.json`);
      // Ensure resolved path stays inside logsDir (defense-in-depth)
      if (!path.resolve(filePath).startsWith(path.resolve(logsDir) + path.sep)) {
        return NextResponse.json({ error: 'Invalid path' }, { status: 400 });
      }
      if (existsSync(filePath)) {
        try {
          session = JSON.parse(readFileSync(filePath, 'utf8'));
          if (Array.isArray(session.trades)) {
            session.trades = correctedTrades(
              session.trades.map((t: { outcome: string }) =>
                t.outcome === 'OPEN' ? { ...t, outcome: 'STALE' } : t
              )
            );
          }
          session = patchSession(session);
        } catch { session = null; }
      } else {
        session = null;
      }
    } else {
      session = getSessionLog();
    }

    const patternStats = getPatternStats();
    const performance  = getHistoricalPnL();

    // Available session dates for the history browser
    const logsDir = SESSIONS_DIR;
    const availableDates = existsSync(logsDir)
      ? readdirSync(logsDir).filter(f => f.endsWith('.json')).map(f => f.replace('.json', '')).sort().reverse()
      : [];

    return NextResponse.json({ session, patternStats, performance, availableDates });
  } catch (e) {
    console.error('[session] Internal error:', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
