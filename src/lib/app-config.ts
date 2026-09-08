/**
 * Config shim. spx-ui owns spiderx.yml; ConfigService pulls it over HTTPS.
 * These helpers keep the same names the route handlers used when they lived in
 * spx-ui, so the ported code reads identically.
 */
import ConfigService, { SpiderXConfig } from '../providers/ConfigService';

export type { SpiderXConfig };

export function getAppConfig(): SpiderXConfig {
  return ConfigService.get();
}

export function getEsPrimaryHost(): string {
  const h = getAppConfig().elasticsearch_config?.hosts;
  if (Array.isArray(h)) return String(h[0] || 'https://localhost:9200').replace(/\/$/, '');
  return String(h || 'https://localhost:9200').replace(/\/$/, '');
}

export function getEsAuth() {
  const es = getAppConfig().elasticsearch_config || {};
  return {
    username: es.username || 'admin',
    password: es.password || '',
    rejectUnauthorized: es.rejectUnauthorized === true,
  };
}

export function getMysqlConfig() {
  const m = getAppConfig().mySQL_config || {};
  return {
    host: m.host || 'localhost',
    port: Number(m.port || 3306),
    user: m.user || 'vehere',
    password: m.password || '',
    database: m.database || 'ui_db',
    connectionLimit: Number(m.connectionLimit || 10),
  };
}

export function getTotpIssuer(): string {
  return (getAppConfig().auth as any)?.APP_TOTP_ISSUER || 'SpiderX';
}

export function getSessionSecret(): string {
  return (
    process.env.SPIDERX_SESSION_SECRET ||
    ((getAppConfig().auth as any)?.session_jwt_secret as string) ||
    'change-me-in-production'
  );
}

export function getSessionMaxAgeSec(): number {
  return Number((getAppConfig().auth as any)?.session_cookie_expiresIn_sec || 43200);
}

export function getSessionCookieName(): string {
  return ((getAppConfig().auth as any)?.session_cookie_key_name as string) || 'spiderx_sid';
}
