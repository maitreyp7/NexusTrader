import * as fs   from 'fs';
import * as path from 'path';
import { LOGGING } from '../config.js';
import type { SessionLog } from './journal.js';

// ─────────────────────────────────────────────────────────────────────────────
// MONITOR AGENT
//
// Runs at end-of-session. Scans the day's bot log and session data for
// anomalies, bugs, and risk events, then writes a plain-English report to:
//
//   logs/monitor/YYYY-MM-DD.md
//
// When you ask Claude "check today's monitor report", it reads this file
// and immediately knows exactly what happened, what broke, and what to fix.
//
// WHAT IT DETECTS:
//   - Recurring errors / warnings (groups by type, shows count)
//   - Entries without exits (orphaned positions)
//   - Stop prices above entry prices (invalid setups that slipped through)
//   - Trades that closed in under 30 seconds (likely bracket misfires)
//   - Double entries on the same symbol in the same window
//   - Missing session end (bot may have crashed)
//   - API failures (Groq rate limits, Marketaux 404s, Alpaca errors)
//   - Symbols that had no data / were skipped with reason
//   - Circuit breaker events
//   - Trades with neutral scores (whale/technical = 0.5 → data gap)
// ─────────────────────────────────────────────────────────────────────────────

const MONITOR_DIR = path.join(LOGGING.sessionLogDir, '..', 'monitor');

interface Issue {
  severity: 'BUG' | 'WARN' | 'INFO';
  category: string;
  message:  string;
  count?:   number;
}

export function runMonitor(session: SessionLog, logFilePath?: string): string {
  const issues: Issue[] = [];
  const today = session.date;

  // ── 1. Parse the bot log for this session's window ──────────────────────────
  const botLogPath = logFilePath ?? path.join(LOGGING.sessionLogDir, '..', `bot-${today}.log`);
  const mainLogPath = path.join(LOGGING.sessionLogDir, '..', 'bot.log');

  // Read whichever log exists — daily log preferred, fallback to main
  let rawLog = '';
  if (fs.existsSync(botLogPath)) {
    rawLog = fs.readFileSync(botLogPath, 'utf-8');
  } else if (fs.existsSync(mainLogPath)) {
    // Extract today's lines from the rolling log
    rawLog = fs.readFileSync(mainLogPath, 'utf-8')
      .split('\n')
      .filter(line => line.includes(today))
      .join('\n');
  }

  const logLines = rawLog.split('\n').filter(Boolean);

  // ── 2. Session-level checks ──────────────────────────────────────────────────

  if (!session.sessionEndedAt) {
    issues.push({ severity: 'BUG', category: 'Session', message: 'Session never ended — bot may have crashed before end-of-session cleanup' });
  }

  if (session.circuitBreakered) {
    issues.push({ severity: 'WARN', category: 'Risk', message: `Circuit breaker fired today — trading halted mid-session (${session.consecutiveLosses} consecutive losses)` });
  }

  // ── 3. Trade-level checks ────────────────────────────────────────────────────

  const closedTrades = session.trades.filter(t => t.outcome !== 'OPEN');
  const openTrades   = session.trades.filter(t => t.outcome === 'OPEN');

  if (openTrades.length > 0) {
    issues.push({
      severity: 'BUG',
      category: 'Positions',
      message:  `${openTrades.length} position(s) never closed: ${openTrades.map(t => t.symbol).join(', ')} — may be stuck open in Alpaca`,
    });
  }

  // Double entries: same symbol appearing more than once in closed trades
  const symbolCounts = new Map<string, number>();
  for (const t of session.trades) {
    symbolCounts.set(t.symbol, (symbolCounts.get(t.symbol) ?? 0) + 1);
  }
  for (const [sym, count] of symbolCounts) {
    if (count > 1) {
      issues.push({ severity: 'BUG', category: 'Double Entry', message: `${sym} entered ${count}× in the same session — dedup may have failed` });
    }
  }

  // Trades that closed in under 30 seconds
  for (const t of closedTrades) {
    if (t.durationMs !== null && t.durationMs < 30_000) {
      issues.push({
        severity: 'BUG',
        category: 'Fast Exit',
        message:  `${t.symbol} [${t.outcome}] closed in ${(t.durationMs / 1000).toFixed(1)}s — likely stop was above entry or bracket misfired. Exit: ${t.exitReason}`,
      });
    }
  }

  // Trades where any signal score is exactly 0.5 (neutral fallback — data gap)
  for (const t of session.trades) {
    const scores = t.decision.scores as unknown as Record<string, number>;
    const neutralSignals = Object.entries(scores)
      .filter(([, v]) => v === 0.5)
      .map(([k]) => k);
    if (neutralSignals.length >= 3) {
      issues.push({
        severity: 'WARN',
        category: 'Data Gaps',
        message:  `${t.symbol} entered with ${neutralSignals.length} neutral signals (${neutralSignals.join(', ')}) — decision made on incomplete data`,
      });
    }
  }

  // ── 4. Log pattern analysis ──────────────────────────────────────────────────

  // Group warnings and errors by type
  const warnCounts  = new Map<string, number>();
  const errorCounts = new Map<string, number>();

  for (const line of logLines) {
    const isWarn  = line.includes('[WARN ]');
    const isError = line.includes('[ERROR]') || line.includes('[error]');
    if (!isWarn && !isError) continue;

    // Extract the meaningful part after the timestamp and level
    const msgMatch = line.match(/\[(?:WARN |ERROR)\]\s*(.+)/);
    const msg = msgMatch?.[1]?.trim() ?? line;

    // Bucket by prefix (first ~60 chars) to group similar messages
    const bucket = msg.slice(0, 70).replace(/\$[\d.]+/g, '$X').replace(/\d{4}-\d{2}-\d{2}/g, 'DATE');

    if (isError) errorCounts.set(bucket, (errorCounts.get(bucket) ?? 0) + 1);
    else         warnCounts.set(bucket,  (warnCounts.get(bucket)  ?? 0) + 1);
  }

  for (const [msg, count] of [...errorCounts.entries()].sort((a, b) => b[1] - a[1])) {
    issues.push({ severity: 'BUG', category: 'Error', message: msg, count });
  }

  for (const [msg, count] of [...warnCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    issues.push({ severity: 'WARN', category: 'Warning', message: msg, count });
  }

  // ── 5. Specific known patterns ───────────────────────────────────────────────

  const groqRateLimited = logLines.filter(l => l.includes('429') || l.includes('rate limit')).length;
  if (groqRateLimited > 0) {
    issues.push({ severity: 'WARN', category: 'API', message: `Groq rate limited ${groqRateLimited}× — ARIA narratives and lessons may be missing`, count: groqRateLimited });
  }

  const marketauxFails = logLines.filter(l => l.includes('Marketaux') && l.includes('404')).length;
  if (marketauxFails > 0) {
    issues.push({ severity: 'INFO', category: 'API', message: `Marketaux earnings API returned 404 for ${marketauxFails} symbols — earnings filter bypassed (trades still allowed)`, count: marketauxFails });
  }

  const alpacaErrors = logLines.filter(l => l.includes('Alpaca') && (l.includes('error') || l.includes('failed'))).length;
  if (alpacaErrors > 0) {
    issues.push({ severity: 'WARN', category: 'API', message: `Alpaca API errors: ${alpacaErrors} — check for order rejections or connectivity issues`, count: alpacaErrors });
  }

  const neutralTechnical = logLines.filter(l => l.includes('5m candles') && l.includes('need 30')).length;
  if (neutralTechnical > 0) {
    issues.push({ severity: 'INFO', category: 'Data', message: `Insufficient 5m candles for technical analysis on ${neutralTechnical} symbol-cycles — using neutral score (0.5). Entry decisions made with partial data.` });
  }

  const rangeTooTight = logLines.filter(l => l.includes('range invalid') && l.includes('too tight')).length;
  if (rangeTooTight > 0) {
    issues.push({ severity: 'INFO', category: 'Range', message: `${rangeTooTight} symbol-windows skipped — range too tight. Consider lowering minRangeSize further if this is frequent.` });
  }

  // ── 6. Build the report ──────────────────────────────────────────────────────

  const bugs   = issues.filter(i => i.severity === 'BUG');
  const warns  = issues.filter(i => i.severity === 'WARN');
  const infos  = issues.filter(i => i.severity === 'INFO');

  const wins      = closedTrades.filter(t => t.outcome === 'WIN').length;
  const losses    = closedTrades.filter(t => t.outcome === 'LOSS').length;
  const pnlSign   = session.dailyPnL >= 0 ? '+' : '';
  const winRate   = closedTrades.length > 0 ? ((wins / closedTrades.length) * 100).toFixed(0) + '%' : '—';
  const updatedAt = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false });

  const formatIssue = (i: Issue) => {
    const prefix = i.severity === 'BUG' ? '🔴' : i.severity === 'WARN' ? '🟡' : 'ℹ️';
    const count  = i.count && i.count > 1 ? ` ×${i.count}` : '';
    return `${prefix} **[${i.category}]** ${i.message}${count}`;
  };

  const tradeRows = session.trades.map(t => {
    const dur    = t.durationMs ? `${Math.round(t.durationMs / 1000)}s` : '—';
    const pnl    = t.realizedPnL !== null ? `${t.realizedPnL >= 0 ? '+' : ''}$${t.realizedPnL.toFixed(2)}` : 'OPEN';
    const icon   = t.outcome === 'WIN' ? '✅' : t.outcome === 'LOSS' ? '🔴' : t.outcome === 'OPEN' ? '⏳' : '🟡';
    const scores = t.decision.scores as unknown as Record<string, number>;
    const scoreStr = `T:${scores.technical?.toFixed(2)} M:${scores.macro?.toFixed(2)} S:${scores.sentiment?.toFixed(2)}`;
    return `| ${icon} ${t.symbol} | ${t.outcome} | ${pnl} | ${dur} | ${scoreStr} | ${(t.exitReason ?? '—').slice(0, 50)} |`;
  }).join('\n');

  const md = [
    `# Monitor Report — ${today}`,
    `_Generated ${updatedAt} ET_`,
    '',
    '## Session Summary',
    '',
    `| | |`,
    `|---|---|`,
    `| Trades | ${closedTrades.length} closed · ${wins}W / ${losses}L · ${winRate} win rate |`,
    `| P&L | ${pnlSign}$${session.dailyPnL.toFixed(2)} |`,
    `| Open positions at close | ${openTrades.length} |`,
    `| Circuit breaker | ${session.circuitBreakered ? '🔴 FIRED' : '✅ Did not fire'} |`,
    `| Session ended cleanly | ${session.sessionEndedAt ? '✅ Yes' : '🔴 No — may have crashed'} |`,
    '',
    '## Issues',
    '',
    bugs.length === 0 && warns.length === 0
      ? '✅ **No bugs or warnings detected.**'
      : [
          bugs.length  > 0 ? `### 🔴 Bugs (${bugs.length})\n${bugs.map(formatIssue).join('\n')}` : '',
          warns.length > 0 ? `### 🟡 Warnings (${warns.length})\n${warns.map(formatIssue).join('\n')}` : '',
          infos.length > 0 ? `### ℹ️ Info (${infos.length})\n${infos.map(formatIssue).join('\n')}` : '',
        ].filter(Boolean).join('\n\n'),
    '',
    '## Trade Log',
    '',
    session.trades.length > 0 ? [
      '| Symbol | Outcome | P&L | Duration | Scores | Exit Reason |',
      '|--------|---------|-----|----------|--------|-------------|',
      tradeRows,
    ].join('\n') : '_No trades today._',
    '',
    '## How to Use This Report',
    '',
    '_Paste this file path into Claude and say "fix the bugs in today\'s monitor report":_',
    `\`logs/monitor/${today}.md\``,
    '',
    '---',
    `_Monitor agent v1 · ${bugs.length} bugs · ${warns.length} warnings · ${infos.length} info_`,
  ].join('\n');

  // Write to disk
  fs.mkdirSync(MONITOR_DIR, { recursive: true });
  const reportPath = path.join(MONITOR_DIR, `${today}.md`);
  fs.writeFileSync(reportPath, md, 'utf-8');

  return reportPath;
}
