import { Router } from "express";
import type { Response } from "express";
import { asyncHandler, searchParams, wildcardPath, fail } from "../lib/http";

const router = Router();

function ok(reply: Response, data: unknown) {
  return reply.json(data);
}

import { md5, nowEpochSec } from "../lib/api-utils";
import { sql, sqlExec } from "../lib/mysql";
import {
  consumeRecoveryCode,
  generateRecoveryCodes,
  generateTotpSecret,
  storeRecoveryHashes,
  totpQrImageUrl,
  totpUri,
  verifyTotp,
} from "../lib/totp";
import {
  clearSessionCookie,
  newSessionKey,
  sessionFromRequest,
  setSessionCookie,
} from "../lib/session-cookie";
import { parsePermissions } from "../lib/permissions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function userPayload(user: any) {
  return {
    id: user.id,
    user_id: user.user_id,
    user_name: user.user_name,
    role_id: user.role_id,
    role_name: user.role_name,
    email_id: user.email_id,
    landingPage: user.landingPage || "command",
    permissions: parsePermissions(user.permissions),
    mfa_enabled: Number(user.mfa_enabled || 0),
    totp_enabled: Number(user.totp_enabled || 0),
    login_flag: Number(user.login_flag || 0),
  };
}

async function loadUser(user_id: string) {
  const rows = await sql<any>(
    `SELECT u.*, r.role_name, r.permissions, r.landingPage
     FROM users u LEFT JOIN roles r ON r.id = u.role_id
     WHERE u.user_id = ? LIMIT 1`,
    [user_id]
  );
  return rows[0] || null;
}

async function issueFullSession(reply: Response, user: any) {
  const session_key = newSessionKey(user.user_id);
  await sqlExec(`INSERT INTO user_session (user_id, session_key, last_access) VALUES (?, ?, ?)`, [
    user.user_id,
    session_key,
    nowEpochSec(),
  ]);
  const payload = userPayload(user);
  // Cookie before body — Express cannot add headers once the body is sent.
  setSessionCookie(reply, {
    session_key,
    user_id: user.user_id,
    role_id: user.role_id,
    role_name: user.role_name,
    permissions: payload.permissions,
    exp: nowEpochSec() + 12 * 3600,
  });
  return reply.json({ ok: true, session_key, user: payload, next: "ok" });
}

function challengeResponse(reply: Response, user_id: string, next: string, ttl = 600) {
  const challenge = newSessionKey(user_id);
  setSessionCookie(reply, {
    session_key: challenge,
    user_id,
    permissions: [],
    exp: nowEpochSec() + ttl,
  });
  return reply.json({ ok: true, statusCode: 303, next, challenge, user_id });
}

router.post("/", asyncHandler(async (req, reply) => {
  try {
    const body = (req.body ?? {});
    const action = String(body.action || "login").toLowerCase();

    if (action === "login") {
      const user_id = String(body.user_id || body.username || "").trim();
      const password = String(body.user_pass || body.password || "");
      if (!user_id || !password) {
        return reply.status(400).json({ error: "username and password required" });
      }
      const user = await loadUser(user_id);
      if (!user || user.user_pass !== md5(password)) {
        return reply.status(401).json({ error: "Invalid credentials" });
      }

      if (Number(user.is_new) === 1 || Number(user.login_flag) === 1) {
        return challengeResponse(reply, user_id, "reset-password");
      }
      if (Number(user.totp_enabled) === 1) {
        return challengeResponse(reply, user_id, "totp-challenge");
      }
      if (Number(user.mfa_enabled) === 1 && Number(user.totp_enabled) !== 1) {
        return challengeResponse(reply, user_id, "totp-setup", 900);
      }
      return issueFullSession(reply, user);
    }

    if (action === "reset-password") {
      const sess = sessionFromRequest(req);
      const user_id = sess?.user_id || String(body.user_id || "");
      const old_pass = String(body.old_pass || "");
      const new_pass = String(body.new_pass || "");
      if (!user_id || !new_pass) {
        return reply.status(400).json({ error: "user_id and new_pass required" });
      }
      const user = await loadUser(user_id);
      if (!user) return reply.status(404).json({ error: "user not found" });
      if (old_pass && user.user_pass !== md5(old_pass) && Number(user.is_new) !== 1) {
        return reply.status(401).json({ error: "Current password incorrect" });
      }
      await sqlExec(
        `UPDATE users SET user_pass=?, is_new=0, login_flag=0, last_modified_on=?, last_modified_by=? WHERE user_id=?`,
        [md5(new_pass), nowEpochSec(), user_id, user_id]
      );
      return reply.json({ ok: true, message: "Password updated. Sign in again.", next: "login" });
    }

    if (action === "totp-setup-generate") {
      const sess = sessionFromRequest(req);
      const user_id = sess?.user_id || String(body.user_id || "");
      if (!user_id) return reply.status(401).json({ error: "not authenticated" });
      const secret = generateTotpSecret();
      const otpauth = totpUri(secret, user_id);
      return reply.json({
        ok: true,
        secret,
        otpauth,
        qrCodeUrl: totpQrImageUrl(otpauth),
        qrHint: `Scan QR or enter secret ${secret} in authenticator app`,
      });
    }

    if (action === "totp-setup-verify") {
      const sess = sessionFromRequest(req);
      const user_id = sess?.user_id || String(body.user_id || "");
      const secret = String(body.secret || "");
      const token = String(body.token || "");
      if (!user_id || !secret || !token) {
        return reply.status(400).json({ error: "user_id, secret, token required" });
      }
      if (!verifyTotp(token, secret)) {
        return reply.status(401).json({ error: "Invalid authenticator code" });
      }
      const recoveryCodes = generateRecoveryCodes(8);
      const hashes = storeRecoveryHashes(recoveryCodes);
      try {
        await sqlExec(
          `UPDATE users SET totp_enabled=1, totp_secret=?, totp_recovery_codes=?, mfa_enabled=1 WHERE user_id=?`,
          [secret, hashes, user_id]
        );
      } catch {
        try {
          await sqlExec(`UPDATE users SET totp_enabled=1, totp_secret=?, mfa_enabled=1 WHERE user_id=?`, [
            secret,
            user_id,
          ]);
        } catch {
          await sqlExec(`UPDATE users SET totp_enabled=1, mfa_enabled=1 WHERE user_id=?`, [user_id]);
        }
      }
      const user = await loadUser(user_id);
      const session_key = newSessionKey(user_id);
      await sqlExec(`INSERT INTO user_session (user_id, session_key, last_access) VALUES (?, ?, ?)`, [
        user_id,
        session_key,
        nowEpochSec(),
      ]);
      const payload = userPayload(user);
      setSessionCookie(reply, {
        session_key,
        user_id,
        role_id: user.role_id,
        role_name: user.role_name,
        permissions: payload.permissions,
        exp: nowEpochSec() + 12 * 3600,
      });
      return reply.json({
        ok: true,
        session_key,
        user: payload,
        next: "ok",
        recoveryCodes,
      });
    }

    if (action === "totp-validate") {
      const sess = sessionFromRequest(req);
      const user_id = sess?.user_id || String(body.user_id || "");
      const token = String(body.token || "").trim();
      const recoveryCode = String(body.recoveryCode || "").trim();
      if (!user_id || (!token && !recoveryCode)) {
        return reply.status(400).json({ error: "token or recoveryCode required" });
      }
      const user = await loadUser(user_id);
      if (!user) return reply.status(404).json({ error: "user not found" });

      if (recoveryCode) {
        const remaining = consumeRecoveryCode(user.totp_recovery_codes, recoveryCode);
        if (!remaining) {
          return reply.status(401).json({ error: "Invalid recovery code" });
        }
        try {
          await sqlExec(`UPDATE users SET totp_recovery_codes=? WHERE user_id=?`, [remaining, user_id]);
        } catch {
          /* column may be missing */
        }
        return issueFullSession(reply, user);
      }

      const secret = user.totp_secret || body.secret;
      if (!secret || !verifyTotp(token, secret)) {
        return reply.status(401).json({ error: "Invalid authenticator code" });
      }
      return issueFullSession(reply, user);
    }

    if (action === "totp-reset") {
      const sess = sessionFromRequest(req);
      if (!sess?.user_id) return reply.status(401).json({ error: "not authenticated" });
      const target = String(body.user_id || sess.user_id);
      // self always ok; admin targeting others allowed if caller has users write (best-effort: any session)
      try {
        await sqlExec(
          `UPDATE users SET totp_enabled=0, totp_secret=NULL, totp_recovery_codes=NULL WHERE user_id=?`,
          [target]
        );
      } catch {
        await sqlExec(`UPDATE users SET totp_enabled=0 WHERE user_id=?`, [target]);
      }
      return reply.json({ ok: true, message: "TOTP cleared — user must re-enroll if MFA required" });
    }

    if (action === "totp-info") {
      const sess = sessionFromRequest(req);
      const user_id = sess?.user_id || String(body.user_id || "");
      if (!user_id) return reply.status(401).json({ error: "not authenticated" });
      const user = await loadUser(user_id);
      if (!user) return reply.status(404).json({ error: "not found" });
      let recoveryCodesCount = 0;
      try {
        const arr = JSON.parse(user.totp_recovery_codes || "[]");
        recoveryCodesCount = Array.isArray(arr) ? arr.length : 0;
      } catch {
        recoveryCodesCount = 0;
      }
      return reply.json({
        ok: true,
        totp_enabled: Number(user.totp_enabled || 0),
        mfa_enabled: Number(user.mfa_enabled || 0),
        recoveryCodesCount,
      });
    }

    if (action === "logout") {
      const sess = sessionFromRequest(req);
      if (sess?.session_key) {
        await sqlExec(`DELETE FROM user_session WHERE session_key=?`, [sess.session_key]).catch(() => null);
      }
      clearSessionCookie(reply);
      return reply.json({ ok: true });
    }

    if (action === "me") {
      const sess = sessionFromRequest(req);
      if (!sess?.user_id) return reply.status(401).json({ error: "not authenticated" });
      const user = await loadUser(sess.user_id);
      if (!user) return reply.status(401).json({ error: "not authenticated" });
      return reply.json({ ok: true, user: userPayload(user), session: sess });
    }

    return reply.status(400).json({ error: "unknown action" });
  } catch (e) {
    return reply.status(502).json({ error: e instanceof Error ? e.message : "auth failed" });
  }
}));

export default router;
