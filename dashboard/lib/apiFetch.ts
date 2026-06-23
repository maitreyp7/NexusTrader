// Wrapper around fetch for all internal /api/* calls.
// Injects the dashboard auth token from the environment so every route
// goes through the middleware check without each component managing headers.
//
// Usage: replace `fetch('/api/foo')` with `apiFetch('/api/foo')`

const TOKEN =
  typeof process !== 'undefined'
    ? process.env.NEXT_PUBLIC_DASHBOARD_TOKEN ?? ''
    : '';

export function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  return fetch(input, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      'x-dashboard-token': TOKEN,
    },
  });
}
