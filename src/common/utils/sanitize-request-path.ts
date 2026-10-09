/**
 * Redact sensitive query params (e.g. email verify tokens) before logging / JSON path.
 */
export function sanitizeRequestPath(url: string): string {
  if (!url.includes('?')) {
    return url;
  }

  const [pathname, query = ''] = url.split('?', 2);
  if (!query) {
    return pathname;
  }

  const params = new URLSearchParams(query);
  const sensitive = new Set([
    'token',
    'access_token',
    'refresh_token',
    'code',
    'password',
    'newpassword',
    'authorization',
  ]);
  let changed = false;
  const keys = Array.from(params.keys());
  for (const key of keys) {
    if (sensitive.has(key.toLowerCase())) {
      params.set(key, '[REDACTED]');
      changed = true;
    }
  }

  if (!changed) {
    return url;
  }

  const next = params.toString();
  return next ? `${pathname}?${next}` : pathname;
}
