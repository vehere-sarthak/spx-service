import type { NextFunction, Request, Response } from 'express';

import { sessionFromRequest, type SessionPayload } from '../lib/session-cookie';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: SessionPayload;
    }
  }
}

/**
 * Paths reachable without a session. Everything else under the API prefix needs
 * one — the same posture uiServices takes by hanging
 * `verifyAndRefreshSessionCookie` in front of its routers.
 *
 * Matched against the path *below* the API prefix, with the query string and any
 * trailing slash removed.
 */
const PUBLIC_PATHS = new Set([
  '/auth/session', // login, MFA, password reset, logout
  '/auth/login', // legacy alias for the same handler
  '/health/live', // container liveness probe
  '/health/ready', // container readiness probe
]);

function normalise(pathname: string): string {
  const withoutQuery = pathname.split('?')[0];
  if (withoutQuery.length > 1 && withoutQuery.endsWith('/')) {
    return withoutQuery.slice(0, -1);
  }
  return withoutQuery;
}

export function requireSession(req: Request, res: Response, next: NextFunction) {
  // CORS preflight carries no cookies by design; blocking it would break the
  // real request that follows.
  if (req.method === 'OPTIONS') return next();

  if (PUBLIC_PATHS.has(normalise(req.path))) return next();

  const session = sessionFromRequest(req);
  if (!session) {
    return res.status(401).json({ error: 'not authenticated', code: 'E_AU_104' });
  }

  req.user = session;
  return next();
}

export default requireSession;
