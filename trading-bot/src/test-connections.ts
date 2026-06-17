import * as dotenv from 'dotenv';
dotenv.config();

// ─── Test 1: Alpaca ───────────────────────────────────────────────────────────
async function testAlpaca() {
  const response = await fetch(`${process.env.ALPACA_BASE_URL}/v2/account`, {
    headers: {
      'APCA-API-KEY-ID': process.env.ALPACA_API_KEY!,
      'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY!,
    },
  });

  if (!response.ok) throw new Error(`Alpaca error: ${response.status} ${response.statusText}`);

  const account = await response.json() as any;
  console.log('✅ Alpaca connected');
  console.log(`   Account ID : ${account.id}`);
  console.log(`   Cash       : $${parseFloat(account.cash).toLocaleString()}`);
  console.log(`   Status     : ${account.status}`);
}

// ─── Test 2: Groq ─────────────────────────────────────────────────────────────
async function testGroq() {
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'llama-3.1-8b-instant',
      messages: [{ role: 'user', content: 'Reply with exactly: GROQ_OK' }],
      max_tokens: 10,
    }),
  });

  if (!response.ok) throw new Error(`Groq error: ${response.status} ${response.statusText}`);

  const data = await response.json() as any;
  const reply = data.choices[0].message.content.trim();
  console.log('✅ Groq AI connected');
  console.log(`   Model reply: ${reply}`);
}

// ─── Test 3: Discord ──────────────────────────────────────────────────────────
async function testDiscord() {
  const response = await fetch(process.env.DISCORD_WEBHOOK_URL!, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content: '✅ **Trading Bot connected!** All systems online. Ready to start building.',
    }),
  });

  if (!response.ok) throw new Error(`Discord error: ${response.status} ${response.statusText}`);
  console.log('✅ Discord connected — check your #general channel for a test message');
}

// ─── Run all tests ────────────────────────────────────────────────────────────
async function runTests() {
  console.log('\n🔍 Testing all connections...\n');

  try { await testAlpaca(); } catch (e: any) { console.log(`❌ Alpaca failed: ${e.message}`); }
  try { await testGroq();   } catch (e: any) { console.log(`❌ Groq failed: ${e.message}`); }
  try { await testDiscord();} catch (e: any) { console.log(`❌ Discord failed: ${e.message}`); }

  console.log('\nDone.\n');
}

runTests();
