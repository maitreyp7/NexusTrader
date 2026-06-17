import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

const PORTFOLIO_PATH = path.resolve(
  process.cwd(),
  '../../NexusTrader/signals/portfolio.json'
);

const LOG_PATH = path.resolve(
  process.cwd(),
  '../../NexusTrader/swing-bot/logs/swing-bot.log'
);

export async function GET() {
  try {
    const portfolio = fs.existsSync(PORTFOLIO_PATH)
      ? JSON.parse(fs.readFileSync(PORTFOLIO_PATH, 'utf-8'))
      : { positions: [], date: null };

    // Last 30 lines of swing-bot log
    let logLines: string[] = [];
    if (fs.existsSync(LOG_PATH)) {
      const raw   = fs.readFileSync(LOG_PATH, 'utf-8');
      logLines = raw.split('\n').filter(Boolean).slice(-30);
    }

    return NextResponse.json({ portfolio, logLines });
  } catch (err) {
    console.error('[swing-bot] Internal error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
