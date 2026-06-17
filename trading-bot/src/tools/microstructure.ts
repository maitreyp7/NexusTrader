import { OrderBook } from './marketData.js';

// ─────────────────────────────────────────────────────────────────────────────
// MICROSTRUCTURE.TS — Component 3: Market Microstructure Layer
//
// Analyzes the live order book to understand real-time supply and demand.
// This is different from all other signals — it looks at what traders are
// ACTUALLY offering to buy and sell RIGHT NOW, not historical price patterns.
//
// What we measure:
//   1. Bid-ask spread   — the cost to enter and exit a trade immediately
//   2. Order imbalance  — are there more buyers or sellers in the book?
//   3. Liquidity zones  — price levels with heavy order concentration
//   4. Bid support      — strong buy walls below price (downside protection)
//   5. Ask resistance   — strong sell walls above price (upside barrier)
//
// IMPORTANT LIMITATIONS (read before trusting this signal):
//   - The order book is a SNAPSHOT. It changes every millisecond.
//   - Large orders can be SPOOFED: a whale places a huge order to create
//     the illusion of support, then cancels it when price approaches.
//     We partially account for this but can't fully eliminate the risk.
//   - This signal is WEAK on its own. It's strongest when CONFIRMING
//     a signal already seen in technical or sentiment analysis.
//   - Only reliable on liquid markets (BTC, ETH). Not suitable for
//     low-volume coins where a single trader can dominate the book.
// ─────────────────────────────────────────────────────────────────────────────

// ─── Output Types ─────────────────────────────────────────────────────────────

export interface LiquidityZone {
  price: number;
  totalVolume: number;       // Total order volume at this price level
  side: 'bid' | 'ask';      // Buy wall or sell wall
  strength: 'strong' | 'moderate' | 'weak';
  distancePct: number;       // How far from current price (%)
}

export interface MicrostructureResult {
  // Spread analysis
  spread: number;            // Absolute spread in USD
  spreadPct: number;         // Spread as % of mid price
  spreadSignal: 'tight' | 'normal' | 'wide';
  // Tight (<0.02%) = cheap to trade | Normal = fine | Wide (>0.1%) = avoid

  // Order book imbalance
  bidAskImbalance: number;   // -1 (all sellers) to +1 (all buyers)
  imbalanceSignal: 'buy_pressure' | 'sell_pressure' | 'balanced';

  // Liquidity zones (top 3 on each side)
  liquidityZones: LiquidityZone[];

  // Key levels
  bidSupport: number;        // Strongest buy wall price below current
  askResistance: number;     // Strongest sell wall price above current
  currentPrice: number;      // Mid price at time of analysis

  // Trade viability
  tradeable: boolean;        // False if spread is too wide to trade profitably
  reason: string;            // Human-readable summary

  // Score for Decision Engine
  normalized: number;        // 0–1
  computedAt: Date;
}

// ─── Thresholds ───────────────────────────────────────────────────────────────
const SPREAD_TIGHT_PCT  = 0.0005;  // 0.05% — liquid enough
const SPREAD_WIDE_PCT   = 0.0040;  // 0.40% — only block truly illiquid markets
const IMBALANCE_THRESHOLD = 0.15;  // ±15% imbalance before we call it directional pressure
const LIQUIDITY_WALL_MULTIPLIER = 3.0; // Order must be 3x avg to count as a "wall"

// ─────────────────────────────────────────────────────────────────────────────
// MAIN FUNCTION — analyzeMicrostructure
// Takes an order book snapshot and returns the full microstructure analysis.
// ─────────────────────────────────────────────────────────────────────────────
export function analyzeMicrostructure(book: OrderBook): MicrostructureResult {
  if (!book.bids.length || !book.asks.length) {
    throw new Error('Cannot analyze microstructure: empty order book');
  }

  const bestBid     = book.bids[0][0];
  const bestAsk     = book.asks[0][0];
  const midPrice    = (bestBid + bestAsk) / 2;
  const spread      = bestAsk - bestBid;
  const spreadPct   = spread / midPrice;

  if (bestBid <= 0 || bestAsk <= 0) {
    throw new Error(`Invalid order book: bid=${bestBid}, ask=${bestAsk}`);
  }
  if (bestBid >= bestAsk) {
    throw new Error(`Crossed order book: bid (${bestBid}) >= ask (${bestAsk})`);
  }

  // ── 1. Spread Analysis ─────────────────────────────────────────────────────
  const spreadSignal: MicrostructureResult['spreadSignal'] =
    spreadPct <= SPREAD_TIGHT_PCT ? 'tight' :
    spreadPct >= SPREAD_WIDE_PCT  ? 'wide'  : 'normal';

  // Wide spread = not worth trading. The transaction cost eats too much profit.
  const tradeable = spreadSignal !== 'wide';

  // ── 2. Order Book Imbalance ────────────────────────────────────────────────
  // Already computed in the data layer — reuse it
  const imbalanceSignal: MicrostructureResult['imbalanceSignal'] =
    book.bidAskImbalance >  IMBALANCE_THRESHOLD ? 'buy_pressure'  :
    book.bidAskImbalance < -IMBALANCE_THRESHOLD ? 'sell_pressure' : 'balanced';

  // ── 3. Liquidity Zones ─────────────────────────────────────────────────────
  // Find price levels where order volume is significantly above average.
  // These act as support (bids) and resistance (asks) levels.
  const liquidityZones = detectLiquidityZones(book.bids, book.asks, midPrice);

  // ── 4. Key Support / Resistance Levels ────────────────────────────────────
  const bidWalls = liquidityZones.filter(z => z.side === 'bid');
  const askWalls = liquidityZones.filter(z => z.side === 'ask');

  // Strongest bid wall = closest strong buy wall below current price
  const bidSupport = bidWalls.length > 0
    ? bidWalls.sort((a, b) => b.price - a.price)[0].price  // Closest below
    : bestBid;

  // Strongest ask wall = closest strong sell wall above current price
  const askResistance = askWalls.length > 0
    ? askWalls.sort((a, b) => a.price - b.price)[0].price  // Closest above
    : bestAsk;

  // ── 5. Compute Score ───────────────────────────────────────────────────────
  const normalized = computeMicrostructureScore(
    spreadSignal,
    book.bidAskImbalance,
    bidWalls.length,
    askWalls.length,
    tradeable,
  );

  // ── 6. Human-readable summary ──────────────────────────────────────────────
  const reason = buildReason(spreadSignal, spreadPct, imbalanceSignal, book.bidAskImbalance, liquidityZones);

  return {
    spread:           Math.round(spread    * 100) / 100,
    spreadPct:        spreadPct,  // Keep full precision — rounds to 0 for very tight BTC spreads
    spreadSignal,
    bidAskImbalance:  Math.round(book.bidAskImbalance * 1000) / 1000,
    imbalanceSignal,
    liquidityZones,
    bidSupport:       Math.round(bidSupport    * 100) / 100,
    askResistance:    Math.round(askResistance * 100) / 100,
    currentPrice:     Math.round(midPrice      * 100) / 100,
    tradeable,
    reason,
    normalized,
    computedAt: new Date(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// DETECT LIQUIDITY ZONES
// Scans both sides of the order book for price levels with unusually large
// order volume. These are "walls" that price tends to bounce off.
// ─────────────────────────────────────────────────────────────────────────────
function detectLiquidityZones(
  bids: [number, number][],
  asks: [number, number][],
  midPrice: number,
): LiquidityZone[] {
  const zones: LiquidityZone[] = [];

  // Calculate average order size on each side (to define what "large" means)
  const avgBidVolume = bids.reduce((s, [, q]) => s + q, 0) / bids.length;
  const avgAskVolume = asks.reduce((s, [, q]) => s + q, 0) / asks.length;

  // Scan bid side for walls
  for (const [price, volume] of bids) {
    if (volume >= avgBidVolume * LIQUIDITY_WALL_MULTIPLIER) {
      const distancePct = ((midPrice - price) / midPrice) * 100;
      zones.push({
        price,
        totalVolume: Math.round(volume * 10000) / 10000,
        side: 'bid',
        strength: volume >= avgBidVolume * 6 ? 'strong' :
                  volume >= avgBidVolume * 3 ? 'moderate' : 'weak',
        distancePct: Math.round(distancePct * 100) / 100,
      });
    }
  }

  // Scan ask side for walls
  for (const [price, volume] of asks) {
    if (volume >= avgAskVolume * LIQUIDITY_WALL_MULTIPLIER) {
      const distancePct = ((price - midPrice) / midPrice) * 100;
      zones.push({
        price,
        totalVolume: Math.round(volume * 10000) / 10000,
        side: 'ask',
        strength: volume >= avgAskVolume * 6 ? 'strong' :
                  volume >= avgAskVolume * 3 ? 'moderate' : 'weak',
        distancePct: Math.round(distancePct * 100) / 100,
      });
    }
  }

  // Return top 3 on each side, sorted by strength then distance
  const topBids = zones
    .filter(z => z.side === 'bid')
    .sort((a, b) => b.totalVolume - a.totalVolume)
    .slice(0, 3);

  const topAsks = zones
    .filter(z => z.side === 'ask')
    .sort((a, b) => b.totalVolume - a.totalVolume)
    .slice(0, 3);

  return [...topBids, ...topAsks];
}

// ─────────────────────────────────────────────────────────────────────────────
// COMPUTE MICROSTRUCTURE SCORE (0–1)
//
// Components:
//   - Spread: tight = good (easier to enter/exit), wide = bad
//   - Imbalance: buy pressure = bullish lean, sell pressure = bearish
//   - Bid walls: strong support below = bullish lean
//   - Ask walls: strong resistance above = bearish lean (if nearby)
//   - Tradeable: if not tradeable, score is capped at 0.45 (never triggers a trade)
// ─────────────────────────────────────────────────────────────────────────────
function computeMicrostructureScore(
  spreadSignal: 'tight' | 'normal' | 'wide',
  imbalance: number,      // -1 to +1
  bidWallCount: number,
  askWallCount: number,
  tradeable: boolean,
): number {
  if (!tradeable) return 0.35; // Wide spread = penalize heavily

  // Spread component (0.3 weight)
  const spreadScore = spreadSignal === 'tight' ? 0.70 : 0.50;

  // Imbalance component (0.5 weight) — map -1…+1 to 0…1
  const imbalanceScore = (imbalance + 1) / 2;

  // Wall component (0.2 weight) — more bid walls vs ask walls = slightly bullish
  const wallBalance = bidWallCount + askWallCount === 0
    ? 0.50
    : bidWallCount / (bidWallCount + askWallCount);

  const raw = (spreadScore * 0.30) + (imbalanceScore * 0.50) + (wallBalance * 0.20);
  return Math.max(0, Math.min(1, Math.round(raw * 1000) / 1000));
}

// ─────────────────────────────────────────────────────────────────────────────
// BUILD REASON STRING
// Human-readable explanation for logs and Discord messages.
// ─────────────────────────────────────────────────────────────────────────────
function buildReason(
  spreadSignal: string,
  spreadPct: number,
  imbalanceSignal: string,
  imbalance: number,
  zones: LiquidityZone[],
): string {
  const parts: string[] = [];

  parts.push(`Spread: ${(spreadPct * 100).toFixed(3)}% (${spreadSignal})`);
  parts.push(`Order flow: ${imbalanceSignal} (${(imbalance * 100).toFixed(1)}% imbalance)`);

  const strongZones = zones.filter(z => z.strength === 'strong');
  if (strongZones.length > 0) {
    const walls = strongZones.map(z =>
      `${z.side === 'bid' ? 'support' : 'resistance'} at $${z.price.toLocaleString()} (${z.distancePct}% away)`
    ).join(', ');
    parts.push(`Strong walls: ${walls}`);
  }

  return parts.join(' | ');
}
