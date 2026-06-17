import { OpenPosition, TradeParameters } from './riskManager.js';
import { POSITION } from '../config.js';

// ─────────────────────────────────────────────────────────────────────────────
// POSITION MANAGER — direction-aware lifecycle state machine
//
// Supports both LONG and SHORT positions with symmetric logic.
//
// LONG lifecycle:
//   stop below entry | partial target above entry | trailing stop moves UP
//
// SHORT lifecycle:
//   stop above entry | partial target below entry | trailing stop moves DOWN
//
// All comparisons and movements are gated on `direction` so the orchestrator
// never needs to know which side it's on — it just calls checkPosition().
// ─────────────────────────────────────────────────────────────────────────────

export type TradeDirection = 'long' | 'short';

export type PositionPhase =
  | 'OPEN'           // Freshly entered — watching for partial profit
  | 'PARTIAL_PROFIT' // 50% sold at 1× target — stop at entry, trailing to 2×
  | 'BREAK_EVEN'     // Stop moved to entry without partial (legacy path)
  | 'PARTIAL_EXIT'   // Trailing remainder after full target hit
  | 'CLOSED';

export interface ManagedPosition extends OpenPosition {
  direction:       TradeDirection;
  phase:           PositionPhase;
  tradeParams:     TradeParameters;
  stopPrice:       number;
  highestPrice:    number;  // For longs: highest seen. For shorts: lowest seen (best short price).
  sizeRemaining:   number;
  partialExitDone: boolean;
  openedAt:        Date;
}

export type PositionAction =
  | { type: 'HOLD';         reason: string }
  | { type: 'MOVE_STOP';    newStopPrice: number; reason: string }
  | { type: 'PARTIAL_EXIT'; coinsToSell: number;  reason: string }
  | { type: 'FULL_EXIT';    reason: string };

export interface PositionCheckResult {
  action:          PositionAction;
  updatedPosition: ManagedPosition;
}

// ─────────────────────────────────────────────────────────────────────────────
// P&L HELPERS — direction-aware
// ─────────────────────────────────────────────────────────────────────────────

export function calcPnL(direction: TradeDirection, entry: number, current: number, shares: number): number {
  return direction === 'long'
    ? (current - entry) * shares
    : (entry - current) * shares;
}

export function calcRiskPerShare(entry: number, stop: number): number {
  return Math.abs(entry - stop);
}

// Is the stop on the correct side of entry for this direction?
export function isValidStop(direction: TradeDirection, entry: number, stop: number): boolean {
  return direction === 'long' ? stop < entry : stop > entry;
}

// Is the target on the correct side of entry for this direction?
export function isValidTarget(direction: TradeDirection, entry: number, target: number): boolean {
  return direction === 'long' ? target > entry : target < entry;
}

// Has price reached or exceeded the partial/full target?
export function hitTarget(direction: TradeDirection, current: number, target: number): boolean {
  return direction === 'long' ? current >= target : current <= target;
}

// Has price hit or blown through the stop?
export function hitStop(direction: TradeDirection, current: number, stop: number): boolean {
  return direction === 'long' ? current <= stop : current >= stop;
}

// Best price seen since entry (highest for longs, lowest for shorts).
function bestPrice(direction: TradeDirection, prev: number, current: number): number {
  return direction === 'long' ? Math.max(prev, current) : Math.min(prev, current);
}

// Trailing stop from the best price seen.
// Long:  best * (1 - pct)  → moves up
// Short: best * (1 + pct)  → moves down
function trailingStop(direction: TradeDirection, best: number, pct: number): number {
  const raw = direction === 'long' ? best * (1 - pct) : best * (1 + pct);
  return Math.round(raw * 100) / 100;
}

// Is the new trailing stop better (tighter) than the current one?
function isBetterStop(direction: TradeDirection, newStop: number, currentStop: number): boolean {
  return direction === 'long' ? newStop > currentStop : newStop < currentStop;
}

// ─────────────────────────────────────────────────────────────────────────────
// FACTORY — openPosition
// ─────────────────────────────────────────────────────────────────────────────
export function openPosition(
  symbol:      string,
  filledPrice: number,
  coinsFilled: number,
  tradeParams: TradeParameters,
  direction:   TradeDirection = 'long',
): ManagedPosition {
  const stopPrice = direction === 'long'
    ? filledPrice - tradeParams.stopLossDistance
    : filledPrice + tradeParams.stopLossDistance;

  return {
    symbol,
    direction,
    qty:             coinsFilled,
    sizeUsd:         filledPrice * coinsFilled,
    entryPrice:      filledPrice,
    currentPrice:    filledPrice,
    unrealizedPnL:   0,
    phase:           'OPEN',
    tradeParams,
    stopPrice:       Math.round(stopPrice * 100) / 100,
    highestPrice:    filledPrice,
    sizeRemaining:   coinsFilled,
    partialExitDone: false,
    openedAt:        new Date(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN FUNCTION — checkPosition
// ─────────────────────────────────────────────────────────────────────────────
export function checkPosition(
  position:      ManagedPosition,
  currentPrice:  number,
  isSessionEnd:  boolean = false,
  maxHoldMinutes: number = 45,  // ORB default; midday/power pass larger values
): PositionCheckResult {
  const dir         = position.direction;
  const best        = bestPrice(dir, position.highestPrice, currentPrice);
  const unrealized  = calcPnL(dir, position.entryPrice, currentPrice, position.sizeRemaining);

  const updated: ManagedPosition = {
    ...position,
    currentPrice,
    highestPrice: best,
    sizeUsd:      currentPrice * position.sizeRemaining,
    unrealizedPnL: Math.round(unrealized * 100) / 100,
  };

  // ── Priority 1: Session end ───────────────────────────────────────────────
  if (isSessionEnd) {
    return result({ type: 'FULL_EXIT', reason: 'Session end — closing all positions' }, updated, 'CLOSED');
  }

  // ── Priority 1.5: Max hold time (window-aware) ───────────────────────────
  // Hard-close crons are the real backstop; this is a safety net for edge cases.
  const minutesHeld = (Date.now() - position.openedAt.getTime()) / 60_000;
  if (minutesHeld >= maxHoldMinutes) {
    return result({ type: 'FULL_EXIT', reason: `Max hold time exceeded (${minutesHeld.toFixed(0)} min of ${maxHoldMinutes} max)` }, updated, 'CLOSED');
  }

  // ── Priority 2: Stop hit ──────────────────────────────────────────────────
  if (hitStop(dir, currentPrice, position.stopPrice)) {
    const lossAmt = calcPnL(dir, position.entryPrice, currentPrice, position.sizeRemaining);
    const lossPct = (Math.abs(currentPrice - position.entryPrice) / position.entryPrice * 100).toFixed(2);
    return result({
      type:   'FULL_EXIT',
      reason: `Stop-loss triggered at $${currentPrice.toFixed(2)} (stop: $${position.stopPrice.toFixed(2)}, ${lossPct}% from entry, P&L: $${lossAmt.toFixed(2)})`,
    }, updated, 'CLOSED');
  }

  // ── Phase: OPEN ───────────────────────────────────────────────────────────
  if (position.phase === 'OPEN') {
    const partialTarget = position.tradeParams.partialProfitPrice;

    if (hitTarget(dir, currentPrice, partialTarget)) {
      const coinsToSell = Math.floor(position.sizeRemaining * POSITION.exit.partialTakeProfitSize);
      const newStop     = Math.round(position.entryPrice * 100) / 100;

      if (coinsToSell <= 0) {
        return result({
          type:         'MOVE_STOP',
          newStopPrice: newStop,
          reason:       `1× target hit at $${currentPrice.toFixed(2)} — too few shares to split (${position.sizeRemaining}), stop moved to entry $${newStop.toFixed(2)}. Trailing to 2× target.`,
        }, { ...updated, stopPrice: newStop, phase: 'PARTIAL_PROFIT', partialExitDone: true });
      }

      const coinsLeft = position.sizeRemaining - coinsToSell;
      const profitAmt = calcPnL(dir, position.entryPrice, currentPrice, coinsToSell);

      return result({
        type:        'PARTIAL_EXIT',
        coinsToSell,
        reason:      `Partial profit (1× target) at $${currentPrice.toFixed(2)} — ${dir === 'short' ? 'covered' : 'sold'} ${coinsToSell} shares (+$${profitAmt.toFixed(2)}). Stop moved to entry $${newStop.toFixed(2)}. Trailing ${coinsLeft} shares to 2× target.`,
      }, {
        ...updated,
        sizeRemaining:   coinsLeft,
        stopPrice:       newStop,
        phase:           'PARTIAL_PROFIT',
        partialExitDone: true,
      });
    }

    // Early trail: once price moves 0.5% in our favour, begin trailing
    const earlyTrailTrigger = dir === 'long'
      ? position.entryPrice * (1 + POSITION.exit.earlyTrailTriggerPct)
      : position.entryPrice * (1 - POSITION.exit.earlyTrailTriggerPct);

    const earlyTriggered = dir === 'long' ? best >= earlyTrailTrigger : best <= earlyTrailTrigger;

    if (earlyTriggered) {
      const newStop = trailingStop(dir, best, position.tradeParams.trailingStopPct);
      if (isBetterStop(dir, newStop, position.stopPrice)) {
        return result({
          type:         'MOVE_STOP',
          newStopPrice: newStop,
          reason:       `Early trail: stop moved to $${newStop.toFixed(2)} (${(position.tradeParams.trailingStopPct * 100).toFixed(1)}% from ${dir === 'long' ? 'high' : 'low'} $${best.toFixed(2)})`,
        }, { ...updated, stopPrice: newStop });
      }
    }

    return result({
      type:   'HOLD',
      reason: `Monitoring ${dir} — $${currentPrice.toFixed(2)}, stop $${position.stopPrice.toFixed(2)}, partial target $${partialTarget.toFixed(2)}`,
    }, updated);
  }

  // ── Phase: PARTIAL_PROFIT ─────────────────────────────────────────────────
  if (position.phase === 'PARTIAL_PROFIT') {
    if (hitTarget(dir, currentPrice, position.tradeParams.takeProfitPrice)) {
      const profitAmt = calcPnL(dir, position.entryPrice, currentPrice, position.sizeRemaining);
      return result({
        type:   'FULL_EXIT',
        reason: `Full target (2×) hit at $${currentPrice.toFixed(2)} — exiting remaining ${position.sizeRemaining} shares (+$${profitAmt.toFixed(2)})`,
      }, updated, 'CLOSED');
    }

    const newTrailingStop = trailingStop(dir, best, position.tradeParams.trailingStopPct);
    if (isBetterStop(dir, newTrailingStop, position.stopPrice)) {
      return result({
        type:         'MOVE_STOP',
        newStopPrice: newTrailingStop,
        reason:       `Trailing stop moved to $${newTrailingStop.toFixed(2)} (${(position.tradeParams.trailingStopPct * 100).toFixed(1)}% from ${dir === 'long' ? 'high' : 'low'} $${best.toFixed(2)})`,
      }, { ...updated, stopPrice: newTrailingStop });
    }

    return result({
      type:   'HOLD',
      reason: `Trailing to 2× (${dir}) — best $${best.toFixed(2)}, stop $${position.stopPrice.toFixed(2)}, target $${position.tradeParams.takeProfitPrice.toFixed(2)}`,
    }, updated);
  }

  // ── Phase: BREAK_EVEN ─────────────────────────────────────────────────────
  if (position.phase === 'BREAK_EVEN') {
    if (hitTarget(dir, currentPrice, position.tradeParams.takeProfitPrice)) {
      const coinsToSell = Math.floor(position.sizeRemaining * POSITION.exit.partialTakeProfitSize);
      const trailStop   = trailingStop(dir, currentPrice, position.tradeParams.trailingStopPct);

      if (coinsToSell <= 0) {
        return result({
          type:   'FULL_EXIT',
          reason: `Take-profit hit at $${currentPrice.toFixed(2)} — too few shares to split, closing position.`,
        }, updated, 'CLOSED');
      }

      const coinsLeft = position.sizeRemaining - coinsToSell;
      const profitAmt = calcPnL(dir, position.entryPrice, currentPrice, coinsToSell);

      return result({
        type:        'PARTIAL_EXIT',
        coinsToSell,
        reason:      `Take-profit hit at $${currentPrice.toFixed(2)} (+$${profitAmt.toFixed(2)} on ${coinsToSell} shares). Trailing remaining ${coinsLeft} shares.`,
      }, {
        ...updated,
        sizeRemaining:   coinsLeft,
        stopPrice:       trailStop,
        phase:           'PARTIAL_EXIT',
        partialExitDone: true,
      });
    }

    return result({
      type:   'HOLD',
      reason: `Break-even protected (${dir}) — $${currentPrice.toFixed(2)}, target $${position.tradeParams.takeProfitPrice.toFixed(2)}, stop $${position.stopPrice.toFixed(2)}`,
    }, updated);
  }

  // ── Phase: PARTIAL_EXIT ───────────────────────────────────────────────────
  if (position.phase === 'PARTIAL_EXIT') {
    const newTrailingStop = trailingStop(dir, best, position.tradeParams.trailingStopPct);

    if (isBetterStop(dir, newTrailingStop, position.stopPrice)) {
      return result({
        type:         'MOVE_STOP',
        newStopPrice: newTrailingStop,
        reason:       `Trailing stop moved to $${newTrailingStop.toFixed(2)} (${(position.tradeParams.trailingStopPct * 100).toFixed(1)}% from ${dir === 'long' ? 'high' : 'low'} $${best.toFixed(2)})`,
      }, { ...updated, stopPrice: newTrailingStop });
    }

    return result({
      type:   'HOLD',
      reason: `Trailing ${dir} — best $${best.toFixed(2)}, stop $${position.stopPrice.toFixed(2)}, current $${currentPrice.toFixed(2)}`,
    }, updated);
  }

  return result({ type: 'HOLD', reason: 'Position already CLOSED — should be removed from active tracking' }, updated);
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function result(
  action:      PositionAction,
  pos:         ManagedPosition,
  closePhase?: 'CLOSED',
): PositionCheckResult {
  return {
    action,
    updatedPosition: closePhase ? { ...pos, phase: closePhase } : pos,
  };
}

export function buildPositionSummary(position: ManagedPosition): string {
  const dir      = position.direction.toUpperCase();
  const movePct  = ((Math.abs(position.currentPrice - position.entryPrice) / position.entryPrice) * 100).toFixed(2);
  const sign     = position.unrealizedPnL >= 0 ? '+' : '';
  const phaseLabel = {
    OPEN:           'Open (monitoring)',
    PARTIAL_PROFIT: '50% locked at 1×, trailing to 2×',
    BREAK_EVEN:     'Break-even protected',
    PARTIAL_EXIT:   '50% taken, trailing remainder',
    CLOSED:         'Closed',
  }[position.phase];

  return [
    `${position.symbol} [${dir}] | Phase: ${phaseLabel}`,
    `Entry: $${position.entryPrice.toFixed(2)} → Current: $${position.currentPrice.toFixed(2)} (${movePct}%)`,
    `Unrealized P&L: ${sign}$${position.unrealizedPnL.toFixed(2)}`,
    `Stop: $${position.stopPrice.toFixed(2)} | Remaining: ${position.sizeRemaining} shares`,
  ].join(' | ');
}
