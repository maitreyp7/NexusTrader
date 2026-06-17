import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

const SIGNALS_PATH = process.env.SIGNALS_PATH
  || '/opt/nexustrader/signals/signals.json';

export async function GET() {
  try {
    if (!fs.existsSync(SIGNALS_PATH)) {
      return NextResponse.json({ error: 'signals.json not found — run market-lens pipeline first' }, { status: 404 });
    }
    const raw  = fs.readFileSync(SIGNALS_PATH, 'utf-8');
    const data = JSON.parse(raw);
    return NextResponse.json(data);
  } catch (err) {
    console.error('[market-lens] Internal error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
