import WebSocket from 'ws';
import { API }   from '../config.js';
import { log }   from '../core/logger.js';
import type { Candle } from './marketData.js';

// ─────────────────────────────────────────────────────────────────────────────
// ALPACA BAR STREAM
//
// Subscribes to Alpaca's real-time WebSocket data feed for 1-minute bars.
// Replaces HTTP polling (2-5s latency) with push delivery (<500ms latency).
//
// The stream keeps a rolling in-memory buffer of recent bars per symbol.
// The execution loop reads from this buffer instead of making HTTP calls,
// dramatically reducing the chance of missing a breakout candle.
//
// Falls back to HTTP (via getEquityBars) if the stream is unavailable.
// ─────────────────────────────────────────────────────────────────────────────

const STREAM_URL = 'wss://stream.data.alpaca.markets/v2/iex';
const BUFFER_SIZE = 30; // Keep last 30 bars per symbol

// In-memory bar buffer: symbol → ordered array of recent 1m bars (oldest first)
const barBuffer = new Map<string, Candle[]>();

let ws:            WebSocket | null = null;
let isConnected    = false;
let isAuthenticated = false;
let subscribedSymbols: string[] = [];
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let streamDisabled = false;  // Set permanently when subscription is unsupported

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────

/** Start streaming bars for the given symbols. Call once at bot startup. */
export function startBarStream(_symbols: string[]): void {
  // WebSocket stream requires paid Alpaca subscription — disabled, using HTTP polling
}

/** Stop the stream and clean up. */
export function stopBarStream(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  ws?.close();
  ws = null;
  isConnected     = false;
  isAuthenticated = false;
}

/**
 * Get the latest N bars for a symbol from the stream buffer.
 * Returns null if the buffer doesn't have enough data yet (fall back to HTTP).
 */
export function getStreamedBars(symbol: string, limit: number): Candle[] | null {
  if (!isConnected || !isAuthenticated) return null;
  const buf = barBuffer.get(symbol);
  if (!buf || buf.length < Math.min(limit, 3)) return null;
  return buf.slice(-limit);
}

/** True if the stream is connected and authenticated. */
export function isStreamReady(): boolean {
  return isConnected && isAuthenticated;
}

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL — CONNECTION & RECONNECT
// ─────────────────────────────────────────────────────────────────────────────

function connect(): void {
  if (streamDisabled) return;
  if (ws) {
    ws.removeAllListeners();
    ws.close();
  }

  log.info('[BarStream] Connecting to Alpaca WebSocket...');
  ws = new WebSocket(STREAM_URL);

  ws.on('open', () => {
    log.info('[BarStream] Connected — authenticating...');
    isConnected = true;
    ws!.send(JSON.stringify({
      action: 'auth',
      key:    API.alpaca.key,
      secret: API.alpaca.secret,
    }));
  });

  ws.on('message', (raw: Buffer) => {
    try {
      const messages = JSON.parse(raw.toString()) as AlpacaStreamMsg[];
      for (const msg of messages) handleMessage(msg);
    } catch {
      // Malformed message — ignore
    }
  });

  ws.on('error', (err) => {
    log.warn(`[BarStream] WebSocket error: ${err.message}`);
  });

  ws.on('close', () => {
    isConnected     = false;
    isAuthenticated = false;
    if (streamDisabled) return;
    log.warn('[BarStream] Disconnected — reconnecting in 5s...');
    reconnectTimer = setTimeout(connect, 5_000);
  });
}

function handleMessage(msg: AlpacaStreamMsg): void {
  switch (msg.T) {
    case 'success':
      if (msg.msg === 'authenticated') {
        isAuthenticated = true;
        log.info('[BarStream] Authenticated — subscribing to bars...');
        ws!.send(JSON.stringify({
          action: 'subscribe',
          bars:   subscribedSymbols,
        }));
      }
      break;

    case 'subscription':
      log.info(`[BarStream] Subscribed to bars: ${(msg.bars ?? []).join(', ')}`);
      break;

    case 'b': {
      // Incoming 1-minute bar
      const candle: Candle = {
        openTime:  new Date(msg.t!),
        open:      msg.o!,
        high:      msg.h!,
        low:       msg.l!,
        close:     msg.c!,
        volume:    msg.v!,
        closeTime: new Date(msg.t!),
        vwap:      msg.vw,
      };

      const sym = msg.S!;
      const buf = barBuffer.get(sym) ?? [];
      buf.push(candle);
      // Keep buffer bounded
      if (buf.length > BUFFER_SIZE) buf.shift();
      barBuffer.set(sym, buf);
      break;
    }

    case 'error': {
      const errMsg = msg.msg ?? 'unknown';
      log.warn(`[BarStream] Stream error: ${errMsg}`);
      if (errMsg.toLowerCase().includes('subscription') || errMsg.toLowerCase().includes('forbidden')) {
        log.warn('[BarStream] Subscription not supported on this plan — disabling stream permanently, using HTTP polling only');
        streamDisabled = true;
        stopBarStream();
      }
      break;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ALPACA STREAM MESSAGE SHAPE
// ─────────────────────────────────────────────────────────────────────────────

interface AlpacaStreamMsg {
  T:     string;         // message type: 'b'=bar, 'success', 'subscription', 'error'
  S?:    string;         // symbol
  t?:    string;         // timestamp
  o?:    number;         // open
  h?:    number;         // high
  l?:    number;         // low
  c?:    number;         // close
  v?:    number;         // volume
  vw?:   number;         // vwap
  msg?:  string;         // auth/error message
  bars?: string[];       // subscription confirmation
}
