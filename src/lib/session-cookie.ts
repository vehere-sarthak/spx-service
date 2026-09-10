import type { Request, Response } from 'express';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { md5 } from './api-utils';
import {
  getAuthSecret,
  getSessionCookieName,
  getSessionMaxAgeSec,
  getSessionSecret,
} from './app-config';
import ConfigService from '../providers/ConfigService';

export type SessionPayload = {
  session_key: string;
  user_id: string;
  role_id?: number;
  role_name?: string;
  permissions: string[];
  /** Landing route id, so spx-ui's middleware can redirect without a round trip. */
  landingPage?: string;
  exp: number; // unix sec
};

/**
 * Half-authenticated states (password accepted, MFA or a forced reset still
 * outstanding) get their OWN cookie — the same split uiServices keeps between
 * `vhr` and `auth`. Sharing one cookie meant a caller who had only passed the
 * password step carried something any presence check would read as a session.
 */
export type ChallengePurpose = 'reset-password' | 'totp-challenge' | 'totp-setup';

export type ChallengePayload = {
  session_key: string;
  user_id: string;
  purpose: ChallengePurpose;
  exp: number; // unix sec
};

function sign(data: string, secret: string) {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

function encodeWith(payload: SessionPayload | ChallengePayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${sign(body, secret)}`;
}

/** A completed session, signed with the session key. */
export function encodeSession(payload: SessionPayload): string {
  return encodeWith(payload, getSessionSecret());
}

/** A half-authenticated challenge, signed with the separate auth key. */
export function encodeChallenge(payload: ChallengePayload): string {
  return encodeWith(payload, getAuthSecret());
}

function decodeSigned<T extends { exp?: number }>(
  token: string | null | undefined,
  secret: string
): T | null {
  if (!token) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = sign(body, secret);
  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T;
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export function decodeSession(token?: string | null): SessionPayload | null {
  const payload = decodeSigned<SessionPayload & { purpose?: string }>(token, getSessionSecret());
  // A challenge token now carries a different signature, so it cannot verify
  // here at all. The purpose check stays as defence in depth.
  if (!payload || payload.purpose) return null;
  return payload;
}

/** Cookie first; `vhr` header covers the window before the browser commits it. */
export function sessionFromRequest(req: Request): SessionPayload | null {
  const name = getSessionCookieName();
  const fromCookie = (req as any).cookies?.[name];
  if (fromCookie) {
    const s = decodeSession(fromCookie);
    if (s) return s;
  }
  const header = req.headers['vhr'];
  return decodeSession(Array.isArray(header) ? header[0] : header);
}

export function setSessionCookie(res: Response, payload: SessionPayload) {
  res.cookie(getSessionCookieName(), encodeSession(payload), {
    httpOnly: true,
    // spx-ui (:4000) and spx-service (:8082) are different origins, so the
    // session cookie has to survive a cross-site XHR — that needs SameSite=None,
    // which browsers only honour on Secure cookies.
    sameSite: 'none',
    secure: true,
    path: '/',
    maxAge: getSessionMaxAgeSec() * 1000,
  });
}

export function clearSessionCookie(res: Response) {
  res.cookie(getSessionCookieName(), '', {
    httpOnly: true,
    sameSite: 'none',
    secure: true,
    path: '/',
    maxAge: 0,
  });
}

export function getChallengeCookieName(): string {
  return `${getSessionCookieName()}_auth`;
}

export function setChallengeCookie(res: Response, payload: ChallengePayload) {
  const ttlMs = Math.max(1000, (payload.exp - Math.floor(Date.now() / 1000)) * 1000);
  res.cookie(getChallengeCookieName(), encodeChallenge(payload), {
    httpOnly: true,
    sameSite: 'none',
    secure: true,
    path: '/',
    maxAge: ttlMs,
  });
}

export function clearChallengeCookie(res: Response) {
  res.cookie(getChallengeCookieName(), '', {
    httpOnly: true,
    sameSite: 'none',
    secure: true,
    path: '/',
    maxAge: 0,
  });
}

/** The mid-login token: proves the password step passed, and nothing more. */
export function challengeFromRequest(req: Request): ChallengePayload | null {
  const fromCookie = (req as any).cookies?.[getChallengeCookieName()];
  const header = req.headers['x-spiderx-auth'];
  const raw = fromCookie || (Array.isArray(header) ? header[0] : header);
  const payload = decodeSigned<ChallengePayload>(raw, getAuthSecret());
  return payload && payload.purpose ? payload : null;
}

export function newSessionKey(user_id: string) {
  return md5(`${user_id}:${Date.now()}:${randomBytes(8).toString('hex')}`);
}

export function sslEnabled(): boolean {
  return ConfigService.sslOptions() !== null;
}
