import { API, LOGGING } from '../config.js';
import * as fs   from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// ─────────────────────────────────────────────────────────────────────────────
// LOGGER — Component 10 (Logging & Debugging System)
//
// A single `log` object used everywhere in the codebase. Import it once and
// call log.info(), log.warn(), log.error(), log.debug() anywhere.
//
// Features:
//   1. Log levels — respects LOGGING.level from config (debug/info/warn/error)
//      Lower-priority messages are silenced at runtime without code changes.
//   2. Timestamps — every line has an ISO timestamp for post-session analysis.
//   3. Color-coded output — levels are color-coded so you can scan terminal
//      output quickly. Errors are red, warnings yellow, info cyan, debug gray.
//   4. Discord notifications — log.discord() sends a message to your Discord
//      channel. Never throws — a Discord failure never crashes the bot.
//   5. Trade alerts — log.trade() formats a trade notification with all
//      relevant details and posts it to Discord automatically.
//
// DESIGN: No third-party logging library. Node.js has everything we need.
// External dependencies add upgrade risk and slow startup. This is ~100 lines.
//
// USAGE:
//   import { log } from '../core/logger.js';
//   log.info('[PortfolioManager] Starting analysis cycle for BTC/USD');
//   log.warn('[RiskManager] Approaching daily loss limit: -$120 of -$150 max');
//   log.error('[Execution] Order rejected: insufficient buying power');
//   await log.discord('Session complete. P&L: +$47.20 (+0.94%)');
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// FILE LOG — writes a dated log file to logs/ next to the project root.
// One file per calendar day in ET. Files older than 14 days are deleted on startup.
// Uses synchronous fs calls so the hot path stays simple (no async drain to manage).
// ─────────────────────────────────────────────────────────────────────────────

const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..'
);
const LOGS_DIR = path.join(PROJECT_ROOT, 'logs');

function getEtDateString(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
}

function getLogFilePath(): string {
  return path.join(LOGS_DIR, `bot-${getEtDateString()}.log`);
}

function initLogsDir(): void {
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    // Prune files older than 14 days
    const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
    for (const file of fs.readdirSync(LOGS_DIR)) {
      if (!file.startsWith('bot-') || !file.endsWith('.log')) continue;
      const full = path.join(LOGS_DIR, file);
      try {
        if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
      } catch { /* ignore */ }
    }
  } catch { /* if logs dir fails, file logging is just disabled */ }
}

initLogsDir();

function writeToFile(line: string): void {
  try {
    fs.appendFileSync(getLogFilePath(), line + '\n', 'utf8');
  } catch { /* never crash the bot over a log write */ }
}

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

// Maps each level to a priority number so we can filter low-priority messages.
// e.g. if LOGGING.level = 'info', debug messages are silenced.
const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info:  1,
  warn:  2,
  error: 3,
};

// Terminal color codes (ANSI escape sequences)
// These make it easy to visually scan terminal output for problems
const COLORS: Record<LogLevel, string> = {
  debug: '\x1b[90m',  // gray    — low-priority diagnostic info
  info:  '\x1b[36m',  // cyan    — normal operation
  warn:  '\x1b[33m',  // yellow  — something worth knowing, not critical
  error: '\x1b[31m',  // red     — something went wrong, needs attention
};
const BOLD  = '\x1b[1m';
const RESET = '\x1b[0m';

// ─────────────────────────────────────────────────────────────────────────────
// CORE LOG FUNCTION
// ─────────────────────────────────────────────────────────────────────────────

function logLine(level: LogLevel, message: string): void {
  // Silences messages below the configured minimum level.
  // e.g. LOGGING.level = 'info' → debug messages are dropped.
  if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[LOGGING.level]) return;

  const timestamp = new Date().toISOString();
  const levelTag  = level.toUpperCase().padEnd(5); // pad to 5 chars so output aligns
  const color     = COLORS[level];
  const bold      = level === 'error' ? BOLD : '';
  const plainLine = `${timestamp} [${levelTag}] ${message}`;

  // Color output to terminal, plain text to file
  console.log(`${color}${bold}${timestamp} [${levelTag}]${RESET} ${message}`);
  writeToFile(plainLine);
}

// ─────────────────────────────────────────────────────────────────────────────
// DISCORD SENDER
// Sends a message to your Discord channel via webhook.
// Always resolves — never throws. Bot stability > notifications.
// ─────────────────────────────────────────────────────────────────────────────

async function sendDiscord(message: string, attempt = 1): Promise<void> {
  if (!API.discord.enabled) return;

  try {
    const res = await fetch(API.discord.webhookUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      // Discord has a 2000 character limit on message content
      body: JSON.stringify({ content: message.slice(0, 2000) }),
    });

    // 204 = success. 429 = rate limited — Discord tells us how long to wait via
    // retry_after; honour it and retry once so important messages aren't dropped.
    if (res.status === 429) {
      if (attempt <= 2) {
        let retryMs = 1000;
        try {
          const body = await res.json() as { retry_after?: number };
          if (typeof body.retry_after === 'number') retryMs = Math.ceil(body.retry_after * 1000) + 250;
        } catch { /* use default */ }
        logLine('warn', `[Logger] Discord rate limited — retrying in ${retryMs}ms (attempt ${attempt})`);
        await new Promise(r => setTimeout(r, retryMs));
        return sendDiscord(message, attempt + 1);
      }
      logLine('warn', '[Logger] Discord rate limit hit — message dropped after retry');
    } else if (!res.ok) {
      logLine('warn', `[Logger] Discord webhook returned ${res.status} — message may not have sent`);
    }
  } catch (err) {
    // Never let a Discord failure crash the bot. Just log locally.
    logLine('warn', `[Logger] Discord send failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// THE LOG OBJECT — import this everywhere
// ─────────────────────────────────────────────────────────────────────────────

export const log = {
  // Standard log levels — use these throughout the codebase
  debug: (msg: string): void  => logLine('debug', msg),
  info:  (msg: string): void  => logLine('info',  msg),
  warn:  (msg: string): void  => logLine('warn',  msg),
  error: (msg: string): void  => logLine('error', msg),

  // Discord — fire-and-forget. Awaiting is optional.
  discord: (msg: string): Promise<void> => sendDiscord(msg),

  // Convenience: log locally AND post to Discord
  // Use for important events: trade executed, circuit breaker fired, session ended
  important: (msg: string): Promise<void> => {
    logLine('info', msg);
    return sendDiscord(msg);
  },
};
