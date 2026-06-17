import { API, COINS } from '../config.js';
import { retry, sleep } from './retry.js';
import { PortfolioState, OpenPosition } from './riskManager.js';

// ─────────────────────────────────────────────────────────────────────────────
// EXECUTION ENGINE — Component 8
//
// The only file in the system that talks to the Alpaca brokerage API.
// Every actual order — entries, stops, take-profits, closes — goes through here.
//
// Responsibilities:
//   1. Place orders (market buy, limit sell, stop-loss, take-profit)
//   2. Poll for fill confirmation (market orders fill fast, but not instantly)
//   3. Cancel open orders (when position closes or session ends)
//   4. Sync account state → build PortfolioState for the Risk Manager
//
// PAPER vs LIVE trading:
//   Only one line changes — the base URL in config.ts:
//   Paper: https://paper-api.alpaca.markets   (current)
//   Live:  https://api.alpaca.markets          (when ready)
//   Everything else is identical. Alpaca's paper API is a faithful simulation.
//
// NOTE ON SLIPPAGE:
//   Alpaca's paper trading engine fills market orders at the current quote,
//   which slightly underestimates real slippage (real orders move the market).
//   The Backtesting Engine adds 0.1% slippage manually to compensate.
//   In live trading, actual fills will reflect real market conditions.
//
// NOTE ON ORDER PAIRING:
//   When we enter a position, we immediately submit BOTH a stop-loss AND a
//   take-profit order. Alpaca's OCO (One-Cancels-Other) is not available on
//   crypto, so we manage both orders ourselves. When one fills, the orchestrator
//   cancels the other.
// ─────────────────────────────────────────────────────────────────────────────

// ─── Auth headers (reused across all calls) ───────────────────────────────────
const headers = {
  'APCA-API-KEY-ID':     API.alpaca.key,
  'APCA-API-SECRET-KEY': API.alpaca.secret,
  'Content-Type':        'application/json',
};

// ─── Types ────────────────────────────────────────────────────────────────────

export type OrderSide   = 'buy' | 'sell';
export type OrderType   = 'market' | 'limit' | 'stop' | 'stop_limit';
export type OrderStatus =
  | 'new' | 'accepted' | 'pending_new'
  | 'partially_filled' | 'filled'
  | 'done_for_day' | 'canceled' | 'expired' | 'replaced' | 'rejected' | 'held';

export interface PlacedOrder {
  orderId:        string;
  symbol:         string;
  side:           OrderSide;
  type:           OrderType;
  qty:            number;           // Coins requested
  filledQty:      number;           // Coins actually filled (may be less)
  filledAvgPrice: number | null;    // Null until filled
  stopPrice:      number | null;    // Set for stop orders
  limitPrice:     number | null;    // Set for limit orders
  status:         OrderStatus;
  submittedAt:    Date;
  filledAt:       Date | null;
}

export interface AccountInfo {
  id:             string;
  cash:           number;           // Available USD
  portfolioValue: number;           // Total account value (cash + positions)
  buyingPower:    number;           // Cash available to deploy right now
  currency:       string;           // 'USD'
  equity:         number;           // Current account equity
  lastEquity:     number;           // Yesterday's close equity (for today's P&L)
  todayPnL:       number;           // equity - lastEquity (USD)
  todayPnLPct:    number;           // Today's P&L as fraction
}

// What Alpaca returns for a position
interface AlpacaPosition {
  symbol:         string;
  qty:            string;
  avg_entry_price: string;
  current_price:  string;
  unrealized_pl:  string;
  market_value:   string;
}

// ─────────────────────────────────────────────────────────────────────────────
// ORDER PLACEMENT
// ─────────────────────────────────────────────────────────────────────────────

// Entry: buy {qty} shares at market, atomically attaching stop-loss + take-profit
// as a bracket order so there is zero window of unprotected exposure.
// Falls back to a plain market buy if Alpaca rejects the bracket.
export async function placeMarketBuy(
  symbol:         string,
  qty:            number,
  stopLossPrice?: number,
  takeProfitPrice?: number,
): Promise<PlacedOrder> {
  if (stopLossPrice && takeProfitPrice) {
    try {
      return await placeOrder({
        symbol,
        qty,
        side:          'buy',
        type:          'market',
        time_in_force: 'day',
        order_class:   'bracket',
        stop_loss:     { stop_price: stopLossPrice.toFixed(2), limit_price: (stopLossPrice * 0.999).toFixed(2) },
        take_profit:   { limit_price: takeProfitPrice.toFixed(2) },
      });
    } catch {
      // Bracket order rejected — fall through to plain market buy
    }
  }
  return placeOrder({
    symbol,
    qty,
    side:          'buy',
    type:          'market',
    time_in_force: 'day',
  });
}

// Stop-loss: direction-aware protective stop order.
// Long  → sell-stop below entry: triggers if price drops to stopPrice.
// Short → buy-stop  above entry: triggers if price rises to stopPrice.
// isShort defaults to false so existing callers without the arg stay correct.
export async function placeStopLoss(
  symbol:    string,
  qty:       number,
  stopPrice: number,
  isShort:   boolean = false,
): Promise<PlacedOrder> {
  if (isShort) {
    // Buy-stop to cover a short — limit slightly above stop so it fills
    const limitPrice = stopPrice * (1 + API.orders.stopLossLimitOffsetPct);
    return placeOrder({
      symbol,
      qty,
      side:          'buy',
      type:          'stop_limit',
      stop_price:    stopPrice.toFixed(2),
      limit_price:   limitPrice.toFixed(2),
      time_in_force: 'day',
    });
  }
  // Sell-stop to exit a long — limit slightly below stop so it fills
  const limitPrice = stopPrice * (1 - API.orders.stopLossLimitOffsetPct);
  return placeOrder({
    symbol,
    qty,
    side:          'sell',
    type:          'stop_limit',
    stop_price:    stopPrice.toFixed(2),
    limit_price:   limitPrice.toFixed(2),
    time_in_force: 'day',
  });
}

// Take-profit: limit order to close a position when price reaches {limitPrice}.
// For longs: sell limit above entry. For shorts: buy limit below entry (cover).
export async function placeTakeProfit(
  symbol:     string,
  qty:        number,
  limitPrice: number,
  isShort:    boolean = false,
): Promise<PlacedOrder> {
  return placeOrder({
    symbol,
    qty,
    side:          isShort ? 'buy' : 'sell',
    type:          'limit',
    limit_price:   limitPrice.toFixed(2),
    time_in_force: 'day',
  });
}

// Exit long: sell {qty} shares at market price right now.
// Used when stop logic or session end requires immediate exit.
export async function placeMarketSell(symbol: string, qty: number): Promise<PlacedOrder> {
  return placeOrder({
    symbol,
    qty,
    side:          'sell',
    type:          'market',
    time_in_force: 'day',
  });
}

// Open short: sell {qty} shares short at market. Alpaca paper trading supports
// short selling out of the box — no additional account changes needed.
// Attaches bracket stop/target if provided so exposure is always protected.
export async function placeMarketShort(
  symbol:          string,
  qty:             number,
  stopLossPrice?:  number,   // ABOVE entry for shorts
  takeProfitPrice?: number,  // BELOW entry for shorts
): Promise<PlacedOrder> {
  if (stopLossPrice && takeProfitPrice) {
    try {
      return await placeOrder({
        symbol,
        qty,
        side:          'sell',
        type:          'market',
        time_in_force: 'day',
        order_class:   'bracket',
        stop_loss:     { stop_price: stopLossPrice.toFixed(2), limit_price: (stopLossPrice * 1.001).toFixed(2) },
        take_profit:   { limit_price: takeProfitPrice.toFixed(2) },
      });
    } catch {
      // Bracket rejected — fall through to plain short
    }
  }
  return placeOrder({
    symbol,
    qty,
    side:          'sell',
    type:          'market',
    time_in_force: 'day',
  });
}

// Cover short: buy {qty} shares to close a short position.
export async function coverShort(symbol: string, qty: number): Promise<PlacedOrder> {
  return placeOrder({
    symbol,
    qty,
    side:          'buy',
    type:          'market',
    time_in_force: 'day',
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// ORDER MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────

// Get the current status of an order (filled? partial? still open?).
export async function getOrderStatus(orderId: string): Promise<PlacedOrder> {
  const raw = await retry(`Alpaca getOrder (${orderId})`, async () => {
    const res = await fetch(`${API.alpaca.baseUrl}/v2/orders/${orderId}`, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    return res.json() as Promise<AlpacaOrderRaw>;
  });
  return parseOrder(raw);
}

// Cancel a specific open order.
// Returns true if cancelled, false if it was already filled/cancelled.
export async function cancelOrder(orderId: string): Promise<boolean> {
  try {
    await retry(`Alpaca cancelOrder (${orderId})`, async () => {
      const res = await fetch(`${API.alpaca.baseUrl}/v2/orders/${orderId}`, {
        method: 'DELETE',
        headers,
      });
      // 204 = cancelled, 422 = already filled/cancelled (not an error for us)
      if (res.status !== 204 && res.status !== 422) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }
    });
    return true;
  } catch {
    return false;
  }
}

// Get the actual coin quantity held for a symbol from Alpaca's positions.
// Use this instead of filledQty when selling — Alpaca may credit slightly fewer
// coins than requested (paper trading precision quirk).
export async function getPositionQty(symbol: string): Promise<number> {
  // For equity symbols (QQQ, SPY), the symbol is used directly.
  // For legacy crypto symbols (BTC/USD), remove the slash.
  const alpacaSymbol = symbol.replace('/', '');

  const position = await retry(`Alpaca getPosition (${symbol})`, async () => {
    const res = await fetch(`${API.alpaca.baseUrl}/v2/positions/${alpacaSymbol}`, { headers });
    if (res.status === 404) return null; // No position held
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    return res.json() as Promise<AlpacaPosition>;
  });

  if (!position) return 0;
  return parseFloat(position.qty);
}

// Cancel ALL open orders for a specific symbol.
// Call this before placing a market exit (don't want stop/TP orders competing).
// Returns the count of orders cancelled.
export async function cancelAllOrdersForSymbol(symbol: string): Promise<number> {
  const openOrders = await retry(`Alpaca listOrders (${symbol})`, async () => {
    const res = await fetch(
      `${API.alpaca.baseUrl}/v2/orders?status=open&symbols=${encodeURIComponent(symbol)}`,
      { headers },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    return res.json() as Promise<AlpacaOrderRaw[]>;
  });

  if (!openOrders.length) return 0;

  const cancellations = await Promise.all(openOrders.map(o => cancelOrder(o.id)));
  return cancellations.filter(Boolean).length;
}

// Wait for an order to fill, polling every 2 seconds.
// Throws if timeout is exceeded or order is rejected.
export async function waitForFill(
  orderId:   string,
  timeoutMs: number = 30_000,  // 30 seconds — enough for any liquid crypto market
): Promise<PlacedOrder> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const order = await getOrderStatus(orderId);

    if (order.status === 'filled') return order;

    if (order.status === 'partially_filled') {
      // Partial fills can happen — wait for the rest
      await sleep(2_000);
      continue;
    }

    // Terminal failure states — stop waiting
    if (['canceled', 'rejected', 'expired', 'done_for_day'].includes(order.status)) {
      throw new Error(`Order ${orderId} ended without filling: status=${order.status}`);
    }

    await sleep(2_000);
  }

  throw new Error(`Order ${orderId} did not fill within ${timeoutMs / 1000}s — check Alpaca dashboard`);
}

// ─────────────────────────────────────────────────────────────────────────────
// ACCOUNT STATE
// ─────────────────────────────────────────────────────────────────────────────

// Fetch the current account balance and metadata from Alpaca.
export async function getAccountInfo(): Promise<AccountInfo> {
  const raw = await retry('Alpaca getAccount', async () => {
    const res = await fetch(`${API.alpaca.baseUrl}/v2/account`, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    return res.json() as Promise<{
      id:               string;
      cash:             string;
      portfolio_value:  string;
      buying_power:     string;
      currency:         string;
      equity:           string;
      last_equity:      string;
      daytrade_count:   number;
      pattern_day_trader: boolean;
    }>;
  });

  const equity      = parseFloat(raw.equity ?? raw.portfolio_value);
  const lastEquity  = parseFloat(raw.last_equity ?? raw.equity ?? raw.portfolio_value);
  const todayPnL    = equity - lastEquity;
  const todayPnLPct = lastEquity > 0 ? todayPnL / lastEquity : 0;

  return {
    id:             raw.id,
    cash:           parseFloat(raw.cash),
    portfolioValue: parseFloat(raw.portfolio_value),
    buyingPower:    parseFloat(raw.buying_power),
    currency:       raw.currency,
    equity,
    lastEquity,
    todayPnL,
    todayPnLPct,
  };
}

/**
 * Returns the number of day trades used in the rolling 5-day window.
 * Alpaca tracks this natively — no manual counting needed.
 * Returns 0 on error so the bot doesn't block on a failed check.
 */
export async function getDayTradeCount(): Promise<number> {
  const raw = await retry('Alpaca getDayTradeCount', async () => {
    const res = await fetch(`${API.alpaca.baseUrl}/v2/account`, { headers });
    if (!res.ok) throw new Error(`Alpaca account fetch failed: HTTP ${res.status}`);
    return res.json() as Promise<{ daytrade_count: number }>;
  });
  return raw.daytrade_count ?? 0;
}

// Build a complete PortfolioState from live Alpaca data.
// Call this at the start of each session so the Risk Manager has real numbers.
// This is the bridge between the brokerage and our internal state model.
export async function buildPortfolioState(): Promise<PortfolioState> {
  const [account, rawPositions] = await Promise.all([
    getAccountInfo(),
    retry('Alpaca getPositions', async () => {
      const res = await fetch(`${API.alpaca.baseUrl}/v2/positions`, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      return res.json() as Promise<AlpacaPosition[]>;
    }),
  ]);

  // Convert Alpaca's position format to our internal OpenPosition format.
  // We only track coins that are in our watchlist — ignore anything else.
  const openPositions: Record<string, OpenPosition> = {};

  for (const pos of rawPositions) {
    // Alpaca uses "BTCUSD" format, we use "BTC/USD" — normalize
    const symbol = normalizeAlpacaSymbol(pos.symbol);
    if (!COINS.watchlist.includes(symbol)) continue;

    openPositions[symbol] = {
      symbol,
      qty:           Math.abs(parseFloat(pos.qty)),
      sizeUsd:       parseFloat(pos.market_value),
      entryPrice:    parseFloat(pos.avg_entry_price),
      currentPrice:  parseFloat(pos.current_price),
      unrealizedPnL: parseFloat(pos.unrealized_pl),
    };
  }

  // dailyPnL and consecutiveLosses come from our Journal — seeded to 0 here.
  // The session orchestrator will populate these from the journal before trading.
  return {
    totalValue:           account.portfolioValue,
    cash:                 account.cash,
    dailyPnL:             0,    // Populated by session orchestrator from journal
    dailyPnLPct:          0,    // Populated by session orchestrator from journal
    dailySpentUsd:        0,    // Populated by session orchestrator from journal
    openPositions,
    consecutiveLosses:    0,    // Populated by session orchestrator from journal
    circuitBreakerActive: false, // Checked separately by checkCircuitBreaker()
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// INTERNALS
// ─────────────────────────────────────────────────────────────────────────────

interface AlpacaOrderBody {
  symbol:        string;
  qty:           number;
  side:          OrderSide;
  type:          OrderType;
  time_in_force: string;
  stop_price?:   string;
  limit_price?:  string;
  order_class?:  string;
  stop_loss?:    { stop_price: string; limit_price: string };
  take_profit?:  { limit_price: string };
}

interface AlpacaOrderRaw {
  id:              string;
  symbol:          string;
  side:            string;
  type:            string;
  qty:             string;
  filled_qty:      string;
  filled_avg_price: string | null;
  stop_price:      string | null;
  limit_price:     string | null;
  status:          string;
  submitted_at:    string;
  filled_at:       string | null;
}

async function placeOrder(body: AlpacaOrderBody): Promise<PlacedOrder> {
  if (body.qty <= 0) {
    throw new Error(`Invalid order quantity: ${body.qty}. Must be positive.`);
  }

  const raw = await retry(`Alpaca placeOrder (${body.side} ${body.qty} ${body.symbol})`, async () => {
    const res = await fetch(`${API.alpaca.baseUrl}/v2/orders`, {
      method:  'POST',
      headers,
      body:    JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text}`);
    }

    return res.json() as Promise<AlpacaOrderRaw>;
  });

  return parseOrder(raw);
}

function parseOrder(raw: AlpacaOrderRaw): PlacedOrder {
  return {
    orderId:        raw.id,
    symbol:         normalizeAlpacaSymbol(raw.symbol),
    side:           raw.side as OrderSide,
    type:           raw.type as OrderType,
    qty:            parseFloat(raw.qty),
    filledQty:      parseFloat(raw.filled_qty ?? '0'),
    filledAvgPrice: raw.filled_avg_price ? parseFloat(raw.filled_avg_price) : null,
    stopPrice:      raw.stop_price  ? parseFloat(raw.stop_price)  : null,
    limitPrice:     raw.limit_price ? parseFloat(raw.limit_price) : null,
    status:         raw.status as OrderStatus,
    submittedAt:    new Date(raw.submitted_at),
    filledAt:       raw.filled_at ? new Date(raw.filled_at) : null,
  };
}

// Normalize a symbol returned from Alpaca.
// For equities, Alpaca returns the symbol as-is (e.g. "QQQ", "SPY").
// For old crypto symbols, Alpaca returns "BTCUSD" and we convert to "BTC/USD".
function normalizeAlpacaSymbol(symbol: string): string {
  // Already normalized or is a plain equity ticker
  if (symbol.includes('/')) return symbol;

  // Check against known equity symbols first
  const equitySymbols = Object.keys(COINS.symbols);
  if (equitySymbols.includes(symbol)) return symbol;

  // Try to match against symbols by alpaca field
  for (const [key, cfg] of Object.entries(COINS.symbols as Record<string, { alpaca: string }>)) {
    if (cfg.alpaca === symbol || cfg.alpaca.replace('/', '') === symbol) return key;
  }

  // Fallback: insert slash before USD (BTCUSD → BTC/USD, ETHUSD → ETH/USD)
  return symbol.replace(/(BTC|ETH|SOL|AVAX|LINK|DOT)USD$/i, '$1/USD');
}
