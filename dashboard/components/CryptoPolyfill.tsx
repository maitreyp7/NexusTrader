'use client';

// Recharts calls crypto.randomUUID() which is unavailable on plain HTTP origins
// (only HTTPS + localhost get a real crypto object). This shim adds a minimal
// implementation so chart libraries don't crash on the trading-bot's HTTP host.
if (typeof window !== 'undefined') {
  const w = window as Window & { crypto: Crypto & { randomUUID?: () => string } };
  if (!w.crypto) {
    (w as unknown as { crypto: object }).crypto = {};
  }
  if (typeof w.crypto.randomUUID !== 'function') {
    w.crypto.randomUUID = function randomUUID(): `${string}-${string}-${string}-${string}-${string}` {
      // RFC4122 v4-ish using Math.random — fine for chart IDs, not for security.
      const hex = '0123456789abcdef';
      let out = '';
      for (let i = 0; i < 36; i++) {
        if (i === 8 || i === 13 || i === 18 || i === 23) {
          out += '-';
        } else if (i === 14) {
          out += '4';
        } else if (i === 19) {
          out += hex[(Math.random() * 4) | 0 | 8];
        } else {
          out += hex[(Math.random() * 16) | 0];
        }
      }
      return out as `${string}-${string}-${string}-${string}-${string}`;
    };
  }
}

export default function CryptoPolyfill() {
  return null;
}
