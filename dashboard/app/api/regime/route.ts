import { NextResponse } from 'next/server';
import { readFileSync, existsSync } from 'fs';
import path from 'path';

// Serves the HMM regime state from logs/brain/hmm-cache.json
// This is written by the bot at pre-market each trading day.

export async function GET() {
  const cachePath = path.join(process.cwd(), '..', 'logs', 'brain', 'hmm-cache.json');
  const modelPath = path.join(process.cwd(), '..', 'logs', 'brain', 'hmm-model.json');

  let regime = null;
  let model  = null;

  try {
    if (existsSync(cachePath)) {
      regime = JSON.parse(readFileSync(cachePath, 'utf-8'));
    }
    if (existsSync(modelPath)) {
      model = JSON.parse(readFileSync(modelPath, 'utf-8'));
    }
  } catch {
    // silently return nulls
  }

  return NextResponse.json({ regime, model });
}
