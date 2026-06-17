import * as http from 'http';
import * as fs   from 'fs';
import * as path from 'path';

const PORT     = 3002;
const LOGS_DIR = path.resolve(process.cwd(), 'logs');

function json(res: http.ServerResponse, data: unknown, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type':  'application/json',
    'Access-Control-Allow-Origin': 'http://localhost:3000',
  });
  res.end(body);
}

function readJson(filePath: string): unknown | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch { return null; }
}

export function startLogServer() {
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET') { json(res, { error: 'GET only' }, 405); return; }

    const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
    const p   = url.pathname;

    // GET /session?date=YYYY-MM-DD  or  /session  (today)
    if (p === '/session') {
      const raw  = url.searchParams.get('date') ?? new Date().toISOString().split('T')[0];
      // Reject anything that isn't a plain YYYY-MM-DD — prevents path traversal
      if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) { json(res, { error: 'Invalid date' }, 400); return; }
      const date = raw;
      const sessionsDir = path.join(LOGS_DIR, 'sessions');
      const file = path.join(sessionsDir, `${date}.json`);
      // Defense-in-depth: resolved path must stay inside sessions dir
      if (!path.resolve(file).startsWith(path.resolve(sessionsDir) + path.sep)) {
        json(res, { error: 'Invalid path' }, 400); return;
      }
      const data = readJson(file);
      if (!data) { json(res, { error: 'No session for ' + date }, 404); return; }
      json(res, data);
      return;
    }

    // GET /sessions  — list available session dates
    if (p === '/sessions') {
      const dir = path.join(LOGS_DIR, 'sessions');
      try {
        const dates = fs.readdirSync(dir)
          .filter(f => f.endsWith('.json'))
          .map(f => f.replace('.json', ''))
          .sort()
          .reverse();
        json(res, { dates });
      } catch { json(res, { dates: [] }); }
      return;
    }

    // GET /logs  — last 120 lines of today's bot log
    if (p === '/logs') {
      const today   = new Date().toISOString().split('T')[0];
      const candidates = [
        path.join(LOGS_DIR, `bot-${today}.log`),
        path.join(LOGS_DIR, 'bot.log'),
      ];
      const logFile = candidates.find(f => fs.existsSync(f));
      if (!logFile) { json(res, { lines: [] }); return; }
      try {
        const lines = fs.readFileSync(logFile, 'utf8')
          .split('\n').filter(Boolean).slice(-120);
        json(res, { lines });
      } catch { json(res, { lines: [] }); }
      return;
    }

    // GET /pattern-stats
    if (p === '/pattern-stats') {
      const file = path.join(LOGS_DIR, 'journal', 'pattern-stats.json');
      const data = readJson(file);
      json(res, data ?? []);
      return;
    }

    json(res, { error: 'Not found' }, 404);
  });

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[LogServer] Listening on port ${PORT}`);
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`[LogServer] Port ${PORT} in use — skipping log server`);
    } else {
      console.error('[LogServer] Error:', err.message);
    }
  });
}
