import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

// Protects all /api/* routes with a shared token.
// Set DASHBOARD_TOKEN in dashboard/.env.local (a random secret, never committed).
// Requests must include the header: x-dashboard-token: <your token>
// The dashboard's own fetch calls pass this automatically (add to all client fetches).
export function middleware(req: NextRequest) {
  const expected = process.env.DASHBOARD_TOKEN;

  // If DASHBOARD_TOKEN is not set, block all API access — misconfigured is safer than open.
  if (!expected) {
    console.error('[middleware] DASHBOARD_TOKEN is not set — blocking API access');
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
