import { createRequire } from 'module';
import { API, SENTIMENT_CONFIG } from '../config.js';
import { retry } from '../core/retry.js';
import { askGroqSafe, validateScore } from './groqClient.js';

// google-trends-api is a CommonJS module — use createRequire for ESM compatibility
const require = createRequire(import.meta.url);
const googleTrends = require('google-trends-api') as {
  interestOverTime: (options: { keyword: string | string[]; startTime: Date; endTime?: Date }) => Promise<string>;
};

// ─────────────────────────────────────────────────────────────────────────────
// SENTIMENT AGENT
//
// Measures the current emotional tone of the crypto market from two sources:
//
//   1. CryptoPanic — aggregates crypto news from 100+ sources in real time.
//      We fetch the 20 most recent BTC/ETH headlines and ask Groq to score them.
//      Score: 0 (extreme fear/panic) → 1 (extreme greed/euphoria)
//
//   2. Fear & Greed Index — a composite daily index from alternative.me.
//      0 = Extreme Fear, 100 = Extreme Greed.
//      Already used in patterns.ts — here we blend it into the sentiment score.
//
// WHY SENTIMENT MATTERS:
//   Markets move on emotion as much as fundamentals. When everyone is panicking
//   and selling (extreme fear), that's often the best time to buy — and vice versa.
//   "Be fearful when others are greedy, be greedy when others are fearful." — Buffett
//
// OUTPUT: sentimentScore (0–1)
//   0.00–0.30 = Extreme fear / panic news → contrarian BUY signal
//   0.30–0.45 = Fear / negative news
//   0.45–0.55 = Neutral
//   0.55–0.70 = Positive news / optimism
//   0.70–1.00 = Extreme greed / euphoria → contrarian SELL warning
//
// GRACEFUL DEGRADATION:
//   If CryptoPanic fails → use Fear & Greed only
//   If both fail → return 0.50 (neutral) and log a data gap
// ─────────────────────────────────────────────────────────────────────────────

export interface SentimentResult {
  score:          number;    // 0–1 for Decision Engine
  label:          'extreme_fear' | 'fear' | 'neutral' | 'greed' | 'extreme_greed';
  fearGreed:      number;    // Raw 0–100 Fear & Greed index
  newsScore:      number;    // 0–1 from CryptoPanic headline analysis (0.5 if unavailable)
  redditScore:    number;    // 0–1 from Reddit top posts (0.5 if unavailable)
  trendsScore:    number;    // 0–1 from Google Trends (high interest = contrarian bearish)
  trendsInterest: number;    // Raw Google Trends value 0–100
  headlines:      string[];  // Top CryptoPanic headlines used
  redditPosts:    string[];  // Top Reddit post titles used
  groqReason:     string;    // Groq's one-line reasoning
  dataGaps:       string[];  // Which sources failed
  fetchedAt:      Date;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN FUNCTION — analyzeSentiment
// ─────────────────────────────────────────────────────────────────────────────
export async function analyzeSentiment(symbols: string[] = ['QQQ', 'SPY']): Promise<SentimentResult> {
  const dataGaps: string[] = [];

  // Fetch all four sources in parallel — none blocks the others
  const [newsResult, fearGreed, redditResult, trendsResult] = await Promise.all([
    fetchNewsHeadlines(symbols, dataGaps),
    fetchFearGreed(dataGaps),
    fetchRedditSentiment(symbols, dataGaps),
    fetchGoogleTrends(symbols, dataGaps),
  ]);

  const { headlines, newsScore } = newsResult;
  const { posts: redditPosts, score: redditScore } = redditResult;

  // Determine if we're analyzing equity symbols (QQQ, SPY) or crypto
  const equitySymbolSet = ['QQQ', 'SPY', 'IWM', 'DIA'];
  const isEquity = symbols.some(s => equitySymbolSet.includes(s.replace('/USD', '').toUpperCase()));

  // Blend weights differ by asset class:
  //
  // EQUITY (QQQ, SPY) — Fear & Greed index is crypto-only, so weight it at 0%:
  //   News/Reddit equity:  45% — r/investing, r/stocks, r/StockMarket headlines
  //   Reddit sentiment:    35% — additional equity subreddit signal
  //   Google Trends:       20% — search interest as contrarian signal
  //
  // CRYPTO — full four-source blend:
  //   CryptoPanic news:    35% — most real-time, curated crypto-specific news
  //   Reddit sentiment:    25% — raw retail crowd psychology
  //   Fear & Greed:        25% — daily composite (smooths noise)
  //   Google Trends:       15% — search interest as contrarian signal
  const fearGreedNormalized = fearGreed / 100;  // 0–100 → 0–1
  const ew = SENTIMENT_CONFIG.equityWeights;
  const cw = SENTIMENT_CONFIG.cryptoWeights;
  const blendedScore = isEquity
    ? (newsScore          * ew.news)   +
      (redditScore        * ew.reddit) +
      (trendsResult.score * ew.trends)
    : (newsScore             * cw.news)      +
      (redditScore           * cw.reddit)    +
      (fearGreedNormalized   * cw.fearGreed) +
      (trendsResult.score    * cw.trends);
  const score = Math.round(Math.max(0, Math.min(1, blendedScore)) * 1000) / 1000;

  const label = scoreToLabel(score);

  return {
    score,
    label,
    fearGreed,
    newsScore,
    redditScore,
    trendsScore:    trendsResult.score,
    trendsInterest: trendsResult.interest,
    headlines,
    redditPosts,
    groqReason: newsResult.reason,
    dataGaps,
    fetchedAt: new Date(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// NEWS FETCH + GROQ SCORING
// ─────────────────────────────────────────────────────────────────────────────

interface NewsResult {
  headlines: string[];
  newsScore:  number;
  reason:     string;
}

// Determine search terms based on symbols — supports both equity and crypto
function getSearchTerms(symbols: string[]): { query: string; isEquity: boolean } {
  // Equity symbols (QQQ, SPY, etc.) — search for market/ETF news
  const equitySymbols = ['QQQ', 'SPY', 'IWM', 'DIA', 'AAPL', 'MSFT', 'NVDA', 'TSLA'];
  const hasEquity = symbols.some(s => equitySymbols.includes(s.replace('/USD', '').toUpperCase()));

  if (hasEquity) {
    return {
      query:    'stock market S&P 500 QQQ ETF equities',
      isEquity: true,
    };
  }

  // Crypto symbols
  return {
    query:    symbols.map(s => s.replace('/USD', '')).join(' '),
    isEquity: false,
  };
}

async function fetchNewsHeadlines(symbols: string[], dataGaps: string[]): Promise<NewsResult> {
  const { isEquity } = getSearchTerms(symbols);

  // For equity symbols, use Reddit finance news as the news source instead of CryptoPanic
  // (CryptoPanic is crypto-only; equity news comes from Reddit r/investing and r/stocks)
  if (isEquity) {
    return fetchEquityNewsFromReddit(symbols, dataGaps);
  }

  // Step 1: Fetch headlines from CryptoPanic (crypto only)
  let headlines: string[] = [];

  try {
    const currencies = symbols.map(s => s.replace('/USD', '')).join(',');
    const url = `https://cryptopanic.com/api/v1/posts/?auth_token=public&currencies=${currencies}&kind=news&public=true`;

    const data = await retry('CryptoPanic news', async () => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      return res.json() as Promise<{
        results: { title: string; published_at: string }[];
      }>;
    });

    headlines = (data.results ?? [])
      .slice(0, 20)
      .map(r => r.title)
      .filter(t => t && t.length > 5);

  } catch (err) {
    dataGaps.push(`CryptoPanic unavailable: ${err instanceof Error ? err.message : 'unknown error'}`);
    return { headlines: [], newsScore: 0.50, reason: 'News data unavailable — using neutral' };
  }

  if (headlines.length === 0) {
    dataGaps.push('CryptoPanic returned no headlines');
    return { headlines: [], newsScore: 0.50, reason: 'No headlines — using neutral' };
  }

  // Step 2: Ask Groq to score the headlines
  const groqResult = await askGroqSafe<{
    score:  number;
    reason: string;
    bullish_count: number;
    bearish_count: number;
  }>([
    {
      role:    'system',
      content: `You are a crypto market sentiment analyst. Given a list of news headlines,
score the overall market sentiment from 0.0 to 1.0.

Scoring guide:
- 0.00–0.20: Extreme panic, crash news, regulatory crackdown, exchange collapse
- 0.20–0.40: Negative news, bearish outlook, significant sell-off
- 0.40–0.60: Mixed or neutral news, no clear direction
- 0.60–0.80: Positive developments, institutional adoption, bullish momentum
- 0.80–1.00: Euphoric headlines, massive gains, everyone is bullish

IMPORTANT: Contrarian interpretation — extreme greed (>0.80) is actually a SELL warning.
Extreme fear (<0.20) can be a BUY opportunity.

Respond with ONLY valid JSON: { "score": 0.0-1.0, "reason": "one sentence", "bullish_count": N, "bearish_count": N }`,
    },
    {
      role:    'user',
      content: `Score the sentiment of these ${headlines.length} crypto headlines:\n${headlines.map((h, i) => `${i + 1}. ${h}`).join('\n')}`,
    },
  ]);

  if (!groqResult) {
    dataGaps.push('Groq sentiment analysis failed — using neutral (0.50)');
    return { headlines, newsScore: 0.50, reason: 'AI analysis unavailable' };
  }

  const newsScore = validateScore(groqResult.result.score, 'sentiment score');
  return {
    headlines,
    newsScore,
    reason: groqResult.result.reason ?? 'No reason provided',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// EQUITY NEWS — from Reddit finance subreddits
//
// Since CryptoPanic is crypto-only, we use Reddit's r/investing and r/stocks
// for equity market sentiment. Same approach, different subreddits.
// ─────────────────────────────────────────────────────────────────────────────
async function fetchEquityNewsFromReddit(symbols: string[], dataGaps: string[]): Promise<NewsResult> {
  const symbolStr = symbols.join(' and ');
  const subreddits = ['investing', 'stocks', 'StockMarket'];
  const allPosts: string[] = [];

  try {
    const results = await Promise.allSettled(
      subreddits.map(sub =>
        retry(`Reddit r/${sub} (equity)`, async () => {
          const res = await fetch(
            `https://www.reddit.com/r/${sub}/hot.json?limit=10`,
            {
              headers: { 'User-Agent': 'AI-Trading-Bot/1.0 (educational project)' },
              signal:  AbortSignal.timeout(8_000),
            },
          );
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json() as Promise<{
            data: { children: { data: { title: string; upvote_ratio: number } }[] };
          }>;
        }),
      ),
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        const posts = result.value?.data?.children ?? [];
        const titles = posts
          .filter(p => p.data.upvote_ratio > 0.55)
          .map(p => p.data.title)
          .filter(t => t && t.length > 10);
        allPosts.push(...titles);
      }
    }

    if (allPosts.length === 0) {
      dataGaps.push('Reddit equity subreddits: no posts retrieved');
      return { headlines: [], newsScore: 0.50, reason: 'No equity news — using neutral' };
    }

    const groqResult = await askGroqSafe<{ score: number; reason: string }>([
      {
        role:    'system',
        content: `You are a US stock market sentiment analyst. Given Reddit post titles from r/investing, r/stocks, and r/StockMarket, score the overall equity market sentiment from 0.0 to 1.0.

0.00–0.20: Mass panic, crash posts, recession fears, extreme bearish
0.20–0.40: Negative mood, concern about losses, bearish outlook
0.40–0.60: Mixed/neutral discussion, no clear directional bias
0.60–0.80: Optimistic posts, rally expected, bullish momentum
0.80–1.00: Euphoria, everyone bullish, possible overheating

Respond ONLY with valid JSON: { "score": 0.0-1.0, "reason": "one sentence" }`,
      },
      {
        role:    'user',
        content: `Analyzing sentiment for ${symbolStr}. Score these ${allPosts.length} posts:\n${allPosts.slice(0, 20).map((p, i) => `${i + 1}. ${p}`).join('\n')}`,
      },
    ]);

    if (!groqResult) {
      return { headlines: allPosts.slice(0, 10), newsScore: 0.50, reason: 'AI analysis unavailable' };
    }

    return {
      headlines: allPosts.slice(0, 10),
      newsScore: validateScore(groqResult.result.score, 'equity sentiment score'),
      reason:    groqResult.result.reason ?? 'No reason provided',
    };

  } catch (err) {
    dataGaps.push(`Equity news unavailable: ${err instanceof Error ? err.message : 'unknown'}`);
    return { headlines: [], newsScore: 0.50, reason: 'News data unavailable — using neutral' };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// REDDIT SENTIMENT FETCH
//
// Uses Reddit's public JSON endpoint — no API key required.
// We pull top 25 posts from r/CryptoCurrency and r/Bitcoin, then ask Groq
// to score the collective mood. Reddit captures retail sentiment *before* it
// shows up in prices — early signal for crowd psychology shifts.
//
// Why no API key: Reddit's .json endpoint is publicly accessible for read-only
// access on public subreddits. Adding ?limit=25 and a proper User-Agent is all
// that's needed. We stay well within rate limits at one call per analysis cycle.
// ─────────────────────────────────────────────────────────────────────────────

interface RedditResult {
  posts: string[];
  score: number;
}

async function fetchRedditSentiment(symbols: string[], dataGaps: string[]): Promise<RedditResult> {
  const neutral: RedditResult = { posts: [], score: 0.50 };

  // Choose subreddits based on the type of symbols being analyzed
  const equitySymbols = ['QQQ', 'SPY', 'IWM', 'DIA'];
  const hasEquity     = symbols.some(s => equitySymbols.includes(s.replace('/USD', '').toUpperCase()));
  const subreddits    = hasEquity
    ? ['investing', 'stocks']        // Equity subreddits
    : ['CryptoCurrency', 'Bitcoin']; // Crypto subreddits
  const allPosts: string[] = [];

  try {
    // Fetch both subreddits in parallel
    const results = await Promise.allSettled(
      subreddits.map(sub =>
        retry(`Reddit r/${sub}`, async () => {
          const res = await fetch(
            `https://www.reddit.com/r/${sub}/hot.json?limit=15`,
            {
              headers: { 'User-Agent': 'AI-Trading-Bot/1.0 (educational project)' },
              signal: AbortSignal.timeout(8_000),
            },
          );
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json() as Promise<{
            data: { children: { data: { title: string; score: number; upvote_ratio: number } }[] };
          }>;
        }),
      ),
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        const posts = result.value?.data?.children ?? [];
        // Only include posts with decent engagement (upvote ratio > 0.6)
        const titles = posts
          .filter(p => p.data.upvote_ratio > 0.60)
          .map(p => p.data.title)
          .filter(t => t && t.length > 10);
        allPosts.push(...titles);
      }
    }

    if (allPosts.length === 0) {
      dataGaps.push('Reddit: no posts retrieved');
      return neutral;
    }

    // Ask Groq to score the posts — prompt differs by asset class
    const equitySymbolsForReddit = ['QQQ', 'SPY', 'IWM', 'DIA'];
    const isEquityReddit = symbols.some(s => equitySymbolsForReddit.includes(s.replace('/USD', '').toUpperCase()));

    const systemPrompt = isEquityReddit
      ? `You are a US stock market sentiment analyst. Given Reddit post titles from r/investing and r/stocks, score the overall equity market sentiment from 0.0 to 1.0.

0.00–0.20: Mass panic, crash fears, recession posts, extreme bearish
0.20–0.40: Negative mood, bearish posts, concern about losses or macro
0.40–0.60: Mixed/neutral discussion, no clear directional bias
0.60–0.80: Optimistic posts, rally expected, bullish on equities
0.80–1.00: Euphoria, everyone bullish, market feels unstoppable

Respond ONLY with valid JSON: { "score": 0.0-1.0, "reason": "one sentence" }`
      : `You are a crypto market sentiment analyst. Given Reddit post titles from r/CryptoCurrency and r/Bitcoin, score the overall retail sentiment from 0.0 to 1.0.

0.00–0.20: Mass panic, crash posts, "crypto is dead", extreme fear
0.20–0.40: Negative mood, bearish posts, concern about losses
0.40–0.60: Mixed/neutral discussion, no clear directional bias
0.60–0.80: Optimistic posts, "to the moon", bullish momentum
0.80–1.00: Euphoria, everyone claims they're getting rich, extreme greed

Respond ONLY with valid JSON: { "score": 0.0-1.0, "reason": "one sentence" }`;

    const groqResult = await askGroqSafe<{ score: number; reason: string }>([
      {
        role:    'system',
        content: systemPrompt,
      },
      {
        role:    'user',
        content: `Score the sentiment of these ${allPosts.length} Reddit posts:\n${allPosts.slice(0, 20).map((p, i) => `${i + 1}. ${p}`).join('\n')}`,
      },
    ]);

    if (!groqResult) {
      dataGaps.push('Groq Reddit analysis failed — using neutral');
      return { posts: allPosts.slice(0, 10), score: 0.50 };
    }

    return {
      posts: allPosts.slice(0, 10),
      score: validateScore(groqResult.result.score, 'reddit sentiment score'),
    };

  } catch (err) {
    dataGaps.push(`Reddit unavailable: ${err instanceof Error ? err.message : 'unknown'}`);
    return neutral;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// FEAR & GREED INDEX FETCH
// ─────────────────────────────────────────────────────────────────────────────

async function fetchFearGreed(dataGaps: string[]): Promise<number> {
  try {
    const data = await retry('Fear & Greed Index', async () => {
      const res = await fetch(`https://api.alternative.me/fng/?limit=1`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<{ data: [{ value: string }] }>;
    });
    return parseInt(data.data[0].value, 10);
  } catch {
    dataGaps.push('Fear & Greed API unavailable — using 50 (neutral)');
    return 50;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GOOGLE TRENDS FETCH
//
// Measures how many people are searching for crypto terms on Google.
// This is a CONTRARIAN signal in crypto:
//   - Very high search interest = retail FOMO = often marks a local top
//   - Very low interest = nobody cares = often near a bottom (accumulation phase)
//   - Moderate interest = healthy growth without mania
//
// We look at 7-day average interest vs a 30-day baseline:
//   - Interest spike > 2x baseline → score drops (too much retail attention)
//   - Flat/declining → slight bullish (under the radar)
//   - Moderate rise → neutral to slightly positive
//
// Uses the unofficial google-trends-api package (no API key required).
// Falls back to neutral (0.50) if blocked or unavailable.
// ─────────────────────────────────────────────────────────────────────────────

interface TrendsResult {
  score:    number;  // 0–1 (contrarian: high interest → low score)
  interest: number;  // Raw 0–100 value from Google Trends
}

async function fetchGoogleTrends(symbols: string[], dataGaps: string[]): Promise<TrendsResult> {
  const neutral: TrendsResult = { score: 0.50, interest: 50 };

  // Map symbols to meaningful search keywords
  const keywords = symbols.map(s => {
    const upper = s.replace('/USD', '').toUpperCase();
    if (upper === 'QQQ') return 'QQQ ETF stock market';
    if (upper === 'SPY') return 'S&P 500 ETF stock market';
    if (s === 'BTC/USD') return 'Bitcoin';
    if (s === 'ETH/USD') return 'Ethereum';
    if (s === 'SOL/USD') return 'Solana';
    return s.replace('/USD', '');
  });

  try {
    // Use the primary keyword
    const keyword = keywords[0] ?? 'S&P 500 ETF stock market';
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const raw = await googleTrends.interestOverTime({ keyword, startTime: thirtyDaysAgo });
    const parsed = JSON.parse(raw) as {
      default: { timelineData: { value: number[]; time: string }[] };
    };

    const timeline = parsed?.default?.timelineData;
    if (!timeline || timeline.length === 0) {
      dataGaps.push('Google Trends: empty response');
      return neutral;
    }

    // Extract interest values (index 0 = our keyword's interest)
    const values = timeline.map(t => t.value[0] ?? 0);

    // Recent 7-day average vs 30-day average
    const recentValues   = values.slice(-7);
    const recentAvg      = recentValues.reduce((a, b) => a + b, 0) / recentValues.length;
    const overallAvg     = values.reduce((a, b) => a + b, 0) / values.length;
    const currentInterest = Math.round(recentAvg);

    // Contrarian scoring:
    //   Interest ≥ 2x baseline → score 0.25 (too much attention = top risk)
    //   Interest 1.5–2x baseline → score 0.35 (elevated, caution)
    //   Interest 0.8–1.5x baseline → score 0.55 (healthy, slight positive)
    //   Interest < 0.8x baseline → score 0.65 (under the radar = accumulation)
    const ratio = overallAvg > 0 ? recentAvg / overallAvg : 1;
    const score =
      ratio >= 2.0  ? 0.25 :
      ratio >= 1.5  ? 0.35 :
      ratio >= 0.8  ? 0.55 :
      0.65;

    return { score, interest: currentInterest };

  } catch (err) {
    dataGaps.push(`Google Trends unavailable: ${err instanceof Error ? err.message : 'unknown'}`);
    return neutral;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function scoreToLabel(score: number): SentimentResult['label'] {
  if (score < 0.20) return 'extreme_fear';
  if (score < 0.40) return 'fear';
  if (score < 0.60) return 'neutral';
  if (score < 0.80) return 'greed';
  return 'extreme_greed';
}
