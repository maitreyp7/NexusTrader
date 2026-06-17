import { API } from '../config.js';
import { retry } from '../core/retry.js';

// ─────────────────────────────────────────────────────────────────────────────
// GROQ CLIENT — AI Brain
//
// Every agent that needs language understanding goes through this file.
// Groq hosts Llama 3.3 70B for free — fast enough for real-time trading.
//
// WHY GROQ + LLAMA instead of writing more code?
//   Some tasks genuinely need language understanding:
//   - Reading 20 news headlines and scoring market sentiment
//   - Writing a human-readable explanation of a trade decision
//   - Interpreting mixed signals ("bullish chart but bearish macro")
//   These are hard to do with if/else. Language models handle them naturally.
//
// WHY NOT use AI for everything?
//   The math (RSI, MACD, ATR, position sizing) is deterministic and auditable.
//   We only call Groq where language understanding adds real value.
//   This keeps costs at zero and keeps the system predictable.
//
// OUTPUT FORMAT:
//   All agents request JSON mode — the model is forced to return valid JSON.
//   We validate the structure before trusting any numbers.
//   If Groq is down or returns garbage → agents return neutral (0.50).
//   The bot never stops trading because an AI call failed.
//
// SWAPPING TO CLAUDE:
//   Change API.groq.model and the endpoint URL. Everything else stays the same.
// ─────────────────────────────────────────────────────────────────────────────

const GROQ_API_URL = 'https://api.cerebras.ai/v1/chat/completions';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface GroqMessage {
  role:    'system' | 'user' | 'assistant';
  content: string;
}

export interface GroqResponse<T> {
  result:     T;
  tokensUsed: number;   // Total tokens (prompt + completion)
  latencyMs:  number;   // How long the call took
  modelUsed:  string;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN FUNCTION — askGroq
//
// Send a conversation to Groq and get a structured response back.
// Always use JSON mode — never parse free-form text.
//
// Usage example:
//   const response = await askGroq<{ score: number; reason: string }>([
//     { role: 'system', content: 'You are a crypto sentiment analyst...' },
//     { role: 'user',   content: `Rate these headlines: ${JSON.stringify(headlines)}` },
//   ]);
//   const score = response.result.score; // Validated number
// ─────────────────────────────────────────────────────────────────────────────
export async function askGroq<T>(
  messages:    GroqMessage[],
  temperature: number = 0.1,  // Near-zero = consistent, deterministic responses
): Promise<GroqResponse<T>> {
  const startMs = Date.now();

  const raw = await retry('Groq API call', async () => {
    const controller = new AbortController();
    const timeout    = setTimeout(() => controller.abort(), API.groq.timeoutMs);

    try {
      const res = await fetch(GROQ_API_URL, {
        method:  'POST',
        signal:  controller.signal,
        headers: {
          'Authorization': `Bearer ${API.groq.key}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify({
          model:           API.groq.model,
          messages,
          max_tokens:      API.groq.maxTokens,
          temperature,
          response_format: { type: 'json_object' },  // Force valid JSON output
        }),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text}`);
      }

      return res.json() as Promise<{
        choices: [{ message: { content: string } }];
        usage:   { total_tokens: number };
        model:   string;
      }>;
    } finally {
      clearTimeout(timeout);
    }
  });

  const content = raw.choices[0]?.message?.content;
  if (!content) throw new Error('Groq returned empty content');

  let result: T;
  try {
    result = JSON.parse(content) as T;
  } catch {
    throw new Error(`Groq returned invalid JSON: ${content.slice(0, 200)}`);
  }

  return {
    result,
    tokensUsed: raw.usage?.total_tokens ?? 0,
    latencyMs:  Date.now() - startMs,
    modelUsed:  raw.model ?? API.groq.model,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SAFE WRAPPER — askGroqSafe
//
// Like askGroq but never throws. If the call fails for any reason,
// returns null. Agents use this so a Groq outage never stops trading.
// ─────────────────────────────────────────────────────────────────────────────
let _lastGroqAlertAt = 0; // rate-limit Discord alerts to once per hour

export async function askGroqSafe<T>(
  messages:    GroqMessage[],
  temperature: number = 0.1,
): Promise<GroqResponse<T> | null> {
  try {
    return await askGroq<T>(messages, temperature);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[groq] Call failed — falling back to neutral: ${msg}`);

    // Alert Discord if model is gone (404) or API is broken — rate-limited to 1/hour
    const isModelError = msg.includes('404') || msg.includes('not_found') || msg.includes('does not exist');
    const now = Date.now();
    if (isModelError && now - _lastGroqAlertAt > 3_600_000 && API.discord.enabled && API.discord.webhookUrl) {
      _lastGroqAlertAt = now;
      fetch(API.discord.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: `⚠️ **Cerebras API broken** — model \`${API.groq.model}\` returned 404.\nBot is still trading but AI lessons/sentiment are disabled.\nFix: update \`API.groq.model\` in \`config.ts\` to a valid model.\n\`\`\`${msg.slice(0, 300)}\`\`\``,
        }),
      }).catch(() => {}); // never block trading on a Discord failure
    }

    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// VALIDATE SCORE — ensures a number from the LLM is in range
// LLMs occasionally return 1.2 instead of 1.0, or "0.7" instead of 0.7.
// Never trust a raw number from an LLM without clamping it.
// ─────────────────────────────────────────────────────────────────────────────
export function validateScore(value: unknown, fieldName: string): number {
  const n = typeof value === 'string' ? parseFloat(value) : Number(value);
  if (isNaN(n)) throw new Error(`Groq returned non-numeric ${fieldName}: ${value}`);
  return Math.max(0, Math.min(1, n));  // Clamp to 0–1
}
