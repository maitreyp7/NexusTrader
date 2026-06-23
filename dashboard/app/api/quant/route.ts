import { NextResponse } from 'next/server';

// ─────────────────────────────────────────────────────────────────────────────
// /api/quant — single source of truth for the two-bot quant system view.
//
// Reads the LIVE Alpaca account and classifies every position into:
//   • BRAIN    (ETFs + crypto, ~70% budget) — the 3-sleeve trend/regime portfolio
//   • MEAN-REV (single stocks, ~30% budget) — short-term oversold-bounce bot
//   • OTHER    (anything neither owns — should be empty; flagged if not)
//
// Returns per-bot market value, share %, position count, unrealized P&L, plus
// account equity / day P&L / cash and the current VIX regime. This is what the
// new dashboard renders. Read-only.
// ─────────────────────────────────────────────────────────────────────────────

const BASE   = process.env.ALPACA_BASE_URL!;
const KEY    = process.env.ALPACA_API_KEY!;
const SECRET = process.env.ALPACA_SECRET_KEY!;

const alpacaHeaders = {
  'APCA-API-KEY-ID':     KEY,
  'APCA-API-SECRET-KEY': SECRET,
};

// Budget caps. The live split is DYNAMIC (gentle perf-tilt, brain ∈ [60%,80%]).
// We show the neutral 70/30 as the reference cap and only alarm if a bot exceeds
// its DYNAMIC ceiling (brain 80% / mean-rev 40%) — so the tilt doesn't false-alarm.
const BRAIN_BUDGET   = 0.70;   // reference (neutral)
const MEANREV_BUDGET = 0.30;   // reference (neutral)
const BRAIN_CEIL     = 0.80;   // dynamic max
const MEANREV_CEIL   = 0.40;   // dynamic max

// Brain universe: ETFs + crypto (Alpaca symbols). Must match live_runner.py ALL.
const BRAIN_SYMBOLS = new Set<string>([
  'SPY', 'QQQ', 'IWM', 'EFA', 'EEM', 'TLT', 'IEF', 'DBC', 'GLD', 'USO', 'UUP',
  'BTC/USD', 'ETH/USD',
]);

// Mean-rev universe: the single-stock list (must match stock_universe.py).
const MEANREV_SYMBOLS = new Set<string>([
  'AAPL','MSFT','GOOGL','AMZN','META','NVDA','AVGO','ORCL','CSCO','ADBE',
  'CRM','INTC','AMD','QCOM','TXN','IBM','NOW','INTU','AMAT','MU',
  'WMT','HD','MCD','NKE','SBUX','TGT','LOW','COST','DIS','CMCSA',
  'PG','KO','PEP','PM','MO','CL','KMB','GIS','KHC','MDLZ',
  'JPM','BAC','WFC','C','GS','MS','AXP','BLK','SCHW','USB',
  'PNC','TFC','COF','BK','SPGI','CME','ICE','MMC','AIG','MET',
  'JNJ','UNH','PFE','MRK','ABBV','TMO','ABT','LLY','BMY','AMGN',
  'GILD','CVS','CI','MDT','ISRG','SYK','BDX','ELV','HUM','DHR',
  'CAT','BA','HON','GE','MMM','UPS','LMT','RTX','DE','EMR',
  'XOM','CVX','COP','SLB','EOG','PSX','VLO','OXY','KMI','WMB',
  'LIN','APD','SHW','FCX','NEM','DOW','NUE','ECL','DD','PPG',
  'NEE','DUK','SO','D','AEP','EXC','SRE','XEL','ED','WEC',
  'T','VZ','TMUS','CHTR','AMT','PLD','CCI','EQIX','SPG','O',
  'TSLA','NFLX','PYPL','SQ','SHOP','UBER','ABNB','COIN','ROKU','SNAP',
  'F','GM','DAL','AAL','CCL','RCL','MGM','WYNN','X','CLF',
]);

type AlpacaPosition = {
  symbol: string; qty: string; market_value: string;
  unrealized_pl: string; unrealized_plpc: string;
  avg_entry_price: string; current_price: string;
};

type BotView = {
  name: string;
  marketValue: number;
  share: number;        // fraction of equity
  budgetCap: number;    // its budget ceiling
  count: number;
  unrealizedPnL: number;
  positions: { symbol: string; marketValue: number; unrealizedPnL: number; unrealizedPct: number }[];
};

async function fetchRegime(): Promise<{ status: string; vix: number | null; vix3m: number | null }> {
  // Best-effort VIX term-structure read (same logic as the Python regime brain).
  try {
    const url = (s: string) =>
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s)}?interval=1d&range=5d`;
    const [vRes, v3Res] = await Promise.all([
      fetch(url('^VIX'),   { headers: { 'User-Agent': 'Mozilla/5.0' }, cache: 'no-store' }),
      fetch(url('^VIX3M'), { headers: { 'User-Agent': 'Mozilla/5.0' }, cache: 'no-store' }),
    ]);
    const last = (j: { chart?: { result?: { indicators?: { quote?: { close?: (number | null)[] }[] } }[] } }) => {
      const arr = j?.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? [];
      const valid = arr.filter((x): x is number => typeof x === 'number');
      return valid.length ? valid[valid.length - 1] : null;
    };
    const vix   = last(await vRes.json());
    const vix3m = last(await v3Res.json());
    const status = vix !== null && vix3m !== null
      ? (vix < vix3m ? 'RISK-ON' : 'RISK-OFF')
      : 'UNKNOWN';
    return { status, vix, vix3m };
  } catch {
    return { status: 'UNKNOWN', vix: null, vix3m: null };
  }
}

async function fetchEquityHistory(): Promise<number[]> {
  // 1-month daily equity curve for the header sparkline. Best-effort.
  try {
    const res = await fetch(
      `${BASE}/v2/account/portfolio/history?period=1M&timeframe=1D`,
      { headers: alpacaHeaders, cache: 'no-store' },
    );
    if (!res.ok) return [];
    const j = await res.json() as { equity?: (number | null)[] };
    return (j.equity ?? []).filter((x): x is number => typeof x === 'number' && x > 0);
  } catch {
    return [];
  }
}

export async function GET() {
  try {
    const [acctRes, posRes] = await Promise.all([
      fetch(`${BASE}/v2/account`,   { headers: alpacaHeaders, cache: 'no-store' }),
      fetch(`${BASE}/v2/positions`, { headers: alpacaHeaders, cache: 'no-store' }),
    ]);

    if (!acctRes.ok) {
      return NextResponse.json({ error: `Alpaca account error: ${acctRes.status}` }, { status: acctRes.status });
    }

    const acct = await acctRes.json() as { equity: string; last_equity: string; cash: string };
    const equity      = parseFloat(acct.equity);
    const lastEquity  = parseFloat(acct.last_equity);
    const cash        = parseFloat(acct.cash);
    const dayPnL      = equity - lastEquity;
    const dayPnLPct   = lastEquity ? (equity / lastEquity - 1) : 0;

    const rawPos = (posRes.ok ? await posRes.json() : []) as AlpacaPosition[];
    const positions = Array.isArray(rawPos) ? rawPos : [];

    function buildBot(name: string, symbols: Set<string>, cap: number): BotView {
      const mine = positions.filter(p => symbols.has(p.symbol));
      const marketValue   = mine.reduce((s, p) => s + parseFloat(p.market_value), 0);
      const unrealizedPnL = mine.reduce((s, p) => s + parseFloat(p.unrealized_pl), 0);
      return {
        name,
        marketValue,
        share: equity ? marketValue / equity : 0,
        budgetCap: cap,
        count: mine.length,
        unrealizedPnL,
        positions: mine.map(p => ({
          symbol:        p.symbol,
          marketValue:   Math.round(parseFloat(p.market_value) * 100) / 100,
          unrealizedPnL: Math.round(parseFloat(p.unrealized_pl) * 100) / 100,
          unrealizedPct: Math.round(parseFloat(p.unrealized_plpc) * 10000) / 100,
        })).sort((a, b) => b.marketValue - a.marketValue),
      };
    }

    const brain   = buildBot('Brain',   BRAIN_SYMBOLS,   BRAIN_BUDGET);
    const meanrev = buildBot('Mean-rev', MEANREV_SYMBOLS, MEANREV_BUDGET);

    // Anything owned by neither bot — should be empty; surface it if not.
    const other = positions.filter(p => !BRAIN_SYMBOLS.has(p.symbol) && !MEANREV_SYMBOLS.has(p.symbol));
    const otherValue = other.reduce((s, p) => s + parseFloat(p.market_value), 0);

    const [regime, equityHistory] = await Promise.all([fetchRegime(), fetchEquityHistory()]);

    // Health flags (mirror health_check.py)
    const alerts: string[] = [];
    if (meanrev.share > MEANREV_CEIL + 0.08) alerts.push(`Mean-rev over budget: ${(meanrev.share * 100).toFixed(0)}%`);
    if (brain.share   > BRAIN_CEIL   + 0.08) alerts.push(`Brain over budget: ${(brain.share * 100).toFixed(0)}%`);
    if (otherValue > 0.01 * equity)            alerts.push(`Unowned positions: ${other.map(p => p.symbol).join(', ')}`);
    if (dayPnLPct < -0.03)                     alerts.push(`Account down ${(dayPnLPct * 100).toFixed(1)}% today`);

    return NextResponse.json({
      equity, cash, dayPnL, dayPnLPct,
      invested: brain.marketValue + meanrev.marketValue,
      bots: [brain, meanrev],
      other: { value: Math.round(otherValue * 100) / 100, symbols: other.map(p => p.symbol) },
      equityHistory,
      regime,
      alerts,
      health: alerts.length === 0 ? 'HEALTHY' : 'NEEDS ATTENTION',
      asOf: new Date().toISOString(),
    });
  } catch (e) {
    console.error('[quant] error:', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
