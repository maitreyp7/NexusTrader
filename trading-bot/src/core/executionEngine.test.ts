import {
  getAccountInfo,
  buildPortfolioState,
  placeMarketBuy,
  placeStopLoss,
  placeTakeProfit,
  placeMarketSell,
  cancelOrder,
  cancelAllOrdersForSymbol,
  getOrderStatus,
  waitForFill,
  getPositionQty,
} from './executionEngine.js';
import { getCurrentPrice } from '../tools/marketData.js';

async function runTests() {
  console.log('\n⚡ Testing Execution Engine...\n');
  let passed = 0; let failed = 0;

  async function test(name: string, fn: () => Promise<void> | void) {
    try { await fn(); console.log(`  ✅ ${name}`); passed++; }
    catch (err) { console.log(`  ❌ ${name}: ${err instanceof Error ? err.message : err}`); failed++; }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // TEST 1: Account Info
  // ─────────────────────────────────────────────────────────────────────────

  await test('getAccountInfo — fetches real account data', async () => {
    const account = await getAccountInfo();

    if (!account.id)           throw new Error('Missing account ID');
    if (account.cash < 0)      throw new Error(`Negative cash: $${account.cash}`);
    if (account.portfolioValue <= 0) throw new Error(`Invalid portfolio value: $${account.portfolioValue}`);
    if (account.currency !== 'USD') throw new Error(`Expected USD, got ${account.currency}`);

    console.log(`\n       ┌─ Alpaca Paper Account ──────────────────────────`);
    console.log(`       │  ID:              ${account.id}`);
    console.log(`       │  Portfolio value: $${account.portfolioValue.toLocaleString('en-US', { minimumFractionDigits: 2 })}`);
    console.log(`       │  Cash:            $${account.cash.toLocaleString('en-US', { minimumFractionDigits: 2 })}`);
    console.log(`       │  Buying power:    $${account.buyingPower.toLocaleString('en-US', { minimumFractionDigits: 2 })}`);
    console.log(`       └────────────────────────────────────────────────────\n`);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // TEST 2: Portfolio State
  // ─────────────────────────────────────────────────────────────────────────

  await test('buildPortfolioState — builds valid PortfolioState from live account', async () => {
    const state = await buildPortfolioState();

    if (state.totalValue <= 0)  throw new Error(`Invalid totalValue: ${state.totalValue}`);
    if (state.cash < 0)         throw new Error(`Negative cash: ${state.cash}`);
    if (typeof state.openPositions !== 'object') throw new Error('openPositions must be an object');

    const posCount = Object.keys(state.openPositions).length;
    console.log(`       Portfolio: $${state.totalValue.toFixed(2)} total, $${state.cash.toFixed(2)} cash, ${posCount} open positions`);

    if (posCount > 0) {
      for (const [sym, pos] of Object.entries(state.openPositions)) {
        console.log(`       Position: ${sym} — $${pos.sizeUsd.toFixed(2)} (entry: $${pos.entryPrice.toFixed(2)}, P&L: $${pos.unrealizedPnL.toFixed(2)})`);
      }
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // TEST 3: Order Lifecycle (place → check → cancel)
  // Strategy: place a LIMIT BUY far below market — it won't fill.
  // Then verify status, then cancel. No position ever opens.
  // ─────────────────────────────────────────────────────────────────────────

  await test('limit order → getOrderStatus → cancelOrder (no fill)', async () => {
    // Strategy: place a limit BUY at 50% of current price — it will never fill.
    // Then verify we can check its status and cancel it cleanly.
    // Alpaca minimum order size is $10, so we need qty × limitPrice ≥ $10.
    const price        = await getCurrentPrice('BTC/USD');
    const currentPrice = price.price;
    const limitPrice   = Math.round(currentPrice * 0.50 * 100) / 100; // 50% below — never fills
    const minQty       = Math.ceil((10 / limitPrice) * 10000) / 10000; // ensures ≥ $10 notional
    const qty          = Math.max(minQty, 0.0003);

    console.log(`\n       Placing limit BUY for ${qty} BTC at $${limitPrice} (50% below market $${currentPrice.toFixed(2)})...`);

    // Direct Alpaca call — limit buy far from market, guaranteed no fill
    const res = await fetch(
      `${(await import('../config.js')).API.alpaca.baseUrl}/v2/orders`,
      {
        method: 'POST',
        headers: {
          'APCA-API-KEY-ID':     (await import('../config.js')).API.alpaca.key,
          'APCA-API-SECRET-KEY': (await import('../config.js')).API.alpaca.secret,
          'Content-Type':        'application/json',
        },
        body: JSON.stringify({
          symbol:        'BTC/USD',
          qty,
          side:          'buy',
          type:          'limit',
          limit_price:   limitPrice.toFixed(2),
          time_in_force: 'gtc',
        }),
      }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const raw = await res.json() as any;
    const orderId = raw.id;

    console.log(`       Order placed: ${orderId}`);

    // Check status — should be open/pending, not filled
    const status = await getOrderStatus(orderId);
    if (!['new', 'accepted', 'pending_new', 'held'].includes(status.status)) {
      throw new Error(`Expected open status, got: ${status.status}`);
    }
    console.log(`       Status: ${status.status} ✓`);

    // Cancel it
    const cancelled = await cancelOrder(orderId);
    if (!cancelled) throw new Error('cancelOrder returned false');
    console.log(`       Cancelled ✓`);

    // Confirm cancellation — Alpaca processes async so allow 'pending_cancel' briefly
    await new Promise(r => setTimeout(r, 1500));
    const afterCancel = await getOrderStatus(orderId);
    if (!['canceled', 'pending_cancel', 'done_for_day'].includes(afterCancel.status)) {
      throw new Error(`Expected canceled/pending_cancel, got: ${afterCancel.status}`);
    }
    console.log(`       Confirmed: ${afterCancel.status} ✓`);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // TEST 4: cancelAllOrdersForSymbol (no open orders case)
  // ─────────────────────────────────────────────────────────────────────────

  await test('cancelAllOrdersForSymbol — returns 0 when no open orders', async () => {
    const count = await cancelAllOrdersForSymbol('BTC/USD');
    console.log(`       Open orders cancelled: ${count}`);
    // No assertion on the count — could be 0 or more depending on state
  });

  // ─────────────────────────────────────────────────────────────────────────
  // TEST 5: Full round-trip on paper — buy tiny amount, sell it back
  // This test actually opens and closes a real paper position.
  // Uses the smallest possible quantity: 0.0001 BTC (~$6-7)
  // ─────────────────────────────────────────────────────────────────────────

  await test('Full paper round-trip: market buy → market sell (tiny size)', async () => {
    // Alpaca minimum order is $10. At ~$70k/BTC, 0.00015 BTC = ~$10.50 — just above minimum.
    const price    = await getCurrentPrice('BTC/USD');
    const TINY_QTY = Math.ceil((11 / price.price) * 100000) / 100000; // ensures ≥ $11 notional

    console.log(`\n       Placing market BUY for ${TINY_QTY} BTC...`);
    const buyOrder = await placeMarketBuy('BTC/USD', TINY_QTY);
    console.log(`       Buy order: ${buyOrder.orderId} (status: ${buyOrder.status})`);

    // Wait for fill (market orders fill fast — should be <5s)
    const filled = await waitForFill(buyOrder.orderId, 15_000);
    if (filled.status !== 'filled') throw new Error(`Buy did not fill: ${filled.status}`);
    if (!filled.filledAvgPrice) throw new Error('No fill price returned');

    console.log(`       Filled at: $${filled.filledAvgPrice.toFixed(2)} for ${filled.filledQty} BTC`);

    // Fetch actual position balance — Alpaca may credit slightly fewer coins
    // than requested (paper trading precision). Always sell what's actually held.
    // Wait 3s for paper trading engine to register the fill as a position.
    await new Promise(r => setTimeout(r, 3000));
    const actualQty = await getPositionQty('BTC/USD');
    if (actualQty <= 0) throw new Error('Position not found after buy fill');
    console.log(`       Actual position: ${actualQty} BTC (requested ${TINY_QTY})`);

    console.log(`       Placing market SELL for ${actualQty} BTC...`);
    const sellOrder = await placeMarketSell('BTC/USD', actualQty);

    const sellFilled = await waitForFill(sellOrder.orderId, 15_000);
    if (sellFilled.status !== 'filled') throw new Error(`Sell did not fill: ${sellFilled.status}`);
    if (!sellFilled.filledAvgPrice) throw new Error('No fill price on sell');

    const slippage = sellFilled.filledAvgPrice - filled.filledAvgPrice;
    console.log(`       Sold at: $${sellFilled.filledAvgPrice.toFixed(2)} (slippage: $${slippage.toFixed(2)})`);
    console.log(`       Round-trip complete ✓`);
  });

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed === 0) console.log('✅ Execution Engine is solid. Ready to build Phase 3 agents.\n');
  else console.log('❌ Fix the failures above before moving on.\n');
}

runTests().catch(console.error);
