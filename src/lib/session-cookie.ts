import type { Request, Response } from 'express';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { md5 } from './api-utils';
import {
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
  exp: number; // unix sec
};

function sign(data: string) {
  return createHmac('sha256', getSessionSecret()).update(data).digest('base64url');
}

export function encodeSession(payload: SessionPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${sign(body)}`;
}

export function decodeSession(token?: string | null): SessionPayload | null {
  if (!token) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = sign(body);
  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }
  try {
    const payload = JSON.parse(
      Buffer.from(body, 'base64url').toString('utf8')
    ) as SessionPayload;
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
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

export function newSessionKey(user_id: string) {
  return md5(`${user_id}:${Date.now()}:${randomBytes(8).toString('hex')}`);
}

export function sslEnabled(): boolean {
  return ConfigService.sslOptions() !== null;
}
