import type { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * Route bodies were ported from spx-ui's Next handlers, which read params from
 * a URLSearchParams. Rebuilding one here keeps that logic byte-identical.
 */
export function searchParams(req: Request): URLSearchParams {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(req.query || {})) {
    if (Array.isArray(v)) v.forEach((x) => params.append(k, String(x)));
    else if (v !== undefined) params.set(k, String(v));
  }
  return params;
}

/** Wildcard segments of a catch-all route, e.g. /alerts/dashboard/trend -> [...]. */
export function wildcardPath(req: Request): string[] {
  const raw = (req.params as any)?.[0] ?? '';
  return String(raw).split('/').filter(Boolean);
}

/** Forwards rejections to the Express error handler instead of dropping them. */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
): RequestHandler {
  return (req, res, next) => {
    void Promise.resolve(fn(req, res, next)).catch(next);
  };
}

export function fail(res: Response, e: unknown, status = 500) {
  const message = e instanceof Error ? e.message : 'API error';
  res.status(status).json({ error: message });
}
