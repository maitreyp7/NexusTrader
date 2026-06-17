import { API } from '../config.js';
import { log } from '../core/logger.js';

// ─────────────────────────────────────────────────────────────────────────────
// ECONOMIC CALENDAR
//
// Some days are simply too dangerous to trade ORB:
//   - FOMC meeting days: Fed rate decisions move markets violently
//   - CPI release days: inflation data causes gap opens and reversals
//   - NFP (Non-Farm Payroll): first Friday of every month, huge volatility
//
// On these days, the opening range is distorted by the event — price gaps
// or whipsaws before/after the announcement, making ORB signals unreliable.
//
// We use two sources (layered fallback):
//   1. FRED API — if FRED_API_KEY is set, fetch today's economic releases
//   2. Hardcoded dates — FOMC dates are published a year in advance, so we
//      can hardcode them with confidence. CPI and NFP follow a pattern too.
// ─────────────────────────────────────────────────────────────────────────────

export interface CalendarEvent {
  date:   string;   // YYYY-MM-DD
  name:   string;   // Event name
  impact: 'HIGH' | 'MEDIUM' | 'LOW';
}

export interface CalendarResult {
  shouldSkipTrading: boolean;
  reason:            string;
  events:            CalendarEvent[];
}

// ─────────────────────────────────────────────────────────────────────────────
// HARDCODED HIGH-IMPACT DATES
//
// FOMC (Federal Open Market Committee) dates — 8 meetings per year.
// Source: https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm
// These are published 12+ months in advance — reliable to hardcode.
//
// Both days of a 2-day meeting are included (policy announcement is day 2,
// but day 1 sees elevated uncertainty too).
// ─────────────────────────────────────────────────────────────────────────────

const FOMC_DATES_2025: string[] = [
  '2025-01-28', '2025-01-29',   // Meeting 1
  '2025-03-18', '2025-03-19',   // Meeting 2
  '2025-05-06', '2025-05-07',   // Meeting 3
  '2025-06-17', '2025-06-18',   // Meeting 4
  '2025-07-29', '2025-07-30',   // Meeting 5
  '2025-09-16', '2025-09-17',   // Meeting 6
  '2025-10-28', '2025-10-29',   // Meeting 7
  '2025-12-09', '2025-12-10',   // Meeting 8
];

const FOMC_DATES_2026: string[] = [
  '2026-01-27', '2026-01-28',   // Meeting 1
  '2026-03-17', '2026-03-18',   // Meeting 2
  '2026-04-28', '2026-04-29',   // Meeting 3
  '2026-06-16', '2026-06-17',   // Meeting 4
  '2026-07-28', '2026-07-29',   // Meeting 5
  '2026-09-15', '2026-09-16',   // Meeting 6
  '2026-10-27', '2026-10-28',   // Meeting 7
  '2026-12-08', '2026-12-09',   // Meeting 8
];

// CPI (Consumer Price Index) — released monthly by BLS, ~8:30 AM ET
// Usually 2nd or 3rd Tuesday/Wednesday of the month
// These are approximate — the exact schedule is released by BLS each year
const CPI_DATES_2025: string[] = [
  '2025-01-15', '2025-02-12', '2025-03-12',
  '2025-04-10', '2025-05-13', '2025-06-11',
  '2025-07-15', '2025-08-12', '2025-09-10',
  '2025-10-15', '2025-11-13', '2025-12-10',
];

const CPI_DATES_2026: string[] = [
  '2026-01-14', '2026-02-11', '2026-03-11',
  '2026-04-14', '2026-05-13', '2026-06-10',
  '2026-07-15', '2026-08-12', '2026-09-10',
  '2026-10-14', '2026-11-12', '2026-12-09',
];

// ─────────────────────────────────────────────────────────────────────────────
// BUILD EVENT LIST
// Converts the raw date arrays into CalendarEvent objects for easy querying
// ─────────────────────────────────────────────────────────────────────────────

function buildHardcodedEvents(): CalendarEvent[] {
  const events: CalendarEvent[] = [];

  for (const date of [...FOMC_DATES_2025, ...FOMC_DATES_2026]) {
    events.push({ date, name: 'FOMC Meeting', impact: 'HIGH' });
  }

  for (const date of [...CPI_DATES_2025, ...CPI_DATES_2026]) {
    events.push({ date, name: 'CPI Release', impact: 'HIGH' });
  }

  return events;
}

// NFP (Non-Farm Payroll) — first Friday of every month, ~8:30 AM ET
// We detect it dynamically instead of hardcoding (pattern is reliable)
function isNFPDay(dateStr: string): boolean {
  const date = new Date(dateStr + 'T12:00:00Z'); // Use noon UTC to avoid timezone edge cases
  const dayOfWeek = date.getUTCDay();    // 5 = Friday
  const dayOfMonth = date.getUTCDate();  // Day number

  // First Friday of the month: Friday where dayOfMonth <= 7
  return dayOfWeek === 5 && dayOfMonth <= 7;
}

// ─────────────────────────────────────────────────────────────────────────────
// FRED API FETCH
//
// If FRED_API_KEY is configured, we try to fetch today's economic releases
// from the St. Louis Fed's free API. This supplements our hardcoded dates
// with any releases we might have missed.
//
// Endpoint: /fred/releases/dates?realtime_start=TODAY&realtime_end=TODAY
// Returns a list of FRED series releases scheduled for today.
// ─────────────────────────────────────────────────────────────────────────────

async function fetchFredEvents(today: string): Promise<CalendarEvent[]> {
  if (!API.fred.key) return [];   // No key — skip FRED

  try {
    const url = `${API.fred.baseUrl}/releases/dates?api_key=${API.fred.key}&realtime_start=${today}&realtime_end=${today}&file_type=json`;

    const res = await fetch(url, {
      signal: AbortSignal.timeout(8_000),
    });

    if (!res.ok) {
      log.warn(`[Calendar] FRED API error: HTTP ${res.status} — falling back to hardcoded dates`);
      return [];
    }

    const data = await res.json() as {
      release_dates: { release_id: number; release_name: string; date: string }[];
    };

    const events: CalendarEvent[] = [];

    for (const release of (data.release_dates ?? [])) {
      // High-impact FRED releases to flag
      const highImpactKeywords = [
        'consumer price index', 'cpi',
        'employment situation',  // NFP
        'federal open market',   // FOMC minutes
        'producer price index',  // PPI
        'gross domestic product', 'gdp',
        'retail sales',
        'personal income',       // PCE (Fed's preferred inflation measure)
      ];

      const name = release.release_name?.toLowerCase() ?? '';
      const isHigh = highImpactKeywords.some(kw => name.includes(kw));

      events.push({
        date:   today,
        name:   release.release_name,
        impact: isHigh ? 'HIGH' : 'MEDIUM',
      });
    }

    return events;

  } catch (err) {
    log.warn(`[Calendar] FRED fetch failed: ${err instanceof Error ? err.message : err} — using hardcoded dates`);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN FUNCTION — checkTodayEvents
//
// Returns a CalendarResult that the pre-market filter uses to decide
// whether to trade today. If any HIGH impact event is found → skip.
// ─────────────────────────────────────────────────────────────────────────────
export async function checkTodayEvents(): Promise<CalendarResult> {
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

  // Layer 1: Hardcoded events
  const hardcoded = buildHardcodedEvents();
  const todayHardcoded = hardcoded.filter(e => e.date === today);

  // Layer 2: NFP check (dynamic — first Friday of month)
  const nfpEvents: CalendarEvent[] = [];
  if (isNFPDay(today)) {
    nfpEvents.push({ date: today, name: 'Non-Farm Payroll (NFP)', impact: 'HIGH' });
  }

  // Layer 3: FRED API (optional enrichment)
  let fredEvents: CalendarEvent[] = [];
  try {
    fredEvents = await fetchFredEvents(today);
  } catch {
    // Already logged in fetchFredEvents — safe to ignore
  }

  // Merge all events, deduplicate by name
  const allEvents = [...todayHardcoded, ...nfpEvents];

  // Add FRED events that don't duplicate hardcoded ones
  for (const fe of fredEvents) {
    const alreadyKnown = allEvents.some(e =>
      e.name.toLowerCase().includes(fe.name.toLowerCase().slice(0, 10))
    );
    if (!alreadyKnown) {
      allEvents.push(fe);
    }
  }

  // Check if any high-impact events exist today
  const highImpact = allEvents.filter(e => e.impact === 'HIGH');
  const shouldSkipTrading = highImpact.length > 0;

  const reason = shouldSkipTrading
    ? `High-impact event(s) today: ${highImpact.map(e => e.name).join(', ')} — skipping ORB`
    : allEvents.length > 0
      ? `Events today (not blocking): ${allEvents.map(e => e.name).join(', ')}`
      : 'No major economic events today — clear to trade';

  return {
    shouldSkipTrading,
    reason,
    events: allEvents,
  };
}
