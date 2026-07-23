import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

// Protects all /api/* routes with a shared token.
// Set DASHBOARD_TOKEN in dashboard/.env.local (a random secret, never committed).
// Requests must include the header: x-dashboard-token: <your token>
// The dashboard's own fetch calls pass this automatically (add to all client fetches).
export function middleware(req: NextRequest) {
  // Next.js edge middleware only reliably inlines NEXT_PUBLIC_* vars at build time;
  // a server-only var (DASHBOARD_TOKEN) reads as undefined here, which silently 401'd
  // every request. Fall back to the public token (the client already sends this exact
  // value, so the gate is unchanged) and keep the server var as the preferred source.
  const expected = process.env.DASHBOARD_TOKEN || process.env.NEXT_PUBLIC_DASHBOARD_TOKEN;

  // If neither token is set, block all API access — misconfigured is safer than open.
  if (!expected) {
    console.error('[middleware] no dashboard token set — blocking API access');
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const provided = req.headers.get('x-dashboard-token');
  if (provided !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return NextResponse.next();
}

export const config = {
  matcher: '/api/:path*',
};
