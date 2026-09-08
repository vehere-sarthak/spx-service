import { Router } from "express";
import type { Response } from "express";
import { asyncHandler, searchParams, wildcardPath, fail } from "../lib/http";

const router = Router();

function ok(reply: Response, data: unknown) {
  return reply.json(data);
}

import { md5, nowEpochSec, pageParams } from "../lib/api-utils";
import { sql, sqlExec } from "../lib/mysql";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

router.get("/", asyncHandler(async (req, reply) => {
  try {
    const q = searchParams(req);
    const { page, pageSize, from } = pageParams(q, 20);
    const query = (q.get("query") || "").trim();
    const where = query ? "WHERE u.user_id LIKE ? OR u.user_name LIKE ? OR u.email_id LIKE ?" : "";
    const params = query ? [`%${query}%`, `%${query}%`, `%${query}%`] : [];
    const countRows = await sql<{ c: number }>(
      `SELECT COUNT(*) c FROM users u ${where}`,
      params
    );
    let rows: any[];
    try {
      rows = await sql(
        `SELECT u.id, u.user_id, u.user_name, u.email_id, u.role_id, u.theme, u.login_flag,
                u.created_by, u.created_on, u.last_modified_by, u.last_modified_on,
                u.mfa_enabled, u.totp_enabled,
                r.role_name, r.permissions, r.landingPage
         FROM users u
         LEFT JOIN roles r ON r.id = u.role_id
         ${where}
         ORDER BY u.created_on DESC
         LIMIT ? OFFSET ?`,
        [...params, pageSize, from]
      );
    } catch {
      rows = await sql(
        `SELECT u.id, u.user_id, u.user_name, u.email_id, u.role_id, u.theme, u.login_flag,
                u.created_by, u.created_on, u.last_modified_by, u.last_modified_on, u.mfa_enabled,
                r.role_name, r.permissions, r.landingPage
         FROM users u
         LEFT JOIN roles r ON r.id = u.role_id
         ${where}
         ORDER BY u.created_on DESC
         LIMIT ? OFFSET ?`,
        [...params, pageSize, from]
      );
    }
    return reply.json({
      total: countRows[0]?.c || 0,
      page,
      pageSize,
      items: rows,
    });
  } catch (e) {
    return reply.status(502).json({ error: e instanceof Error ? e.message : "users failed" });
  }
}));

router.post("/", asyncHandler(async (req, reply) => {
  try {
    const body = (req.body ?? {});
    const data = body?.data || body;
    const user_id = String(data.user_id || "").trim();
    const user_name = String(data.user_name || user_id).trim();
    const role_id = Number(data.role_id);
    const plain = String(data.user_pass || data.password || "");
    if (!user_id || !role_id || !plain) {
      return reply.status(400).json({ error: "user_id, role_id, user_pass required" });
    }
    const now = nowEpochSec();
    const by = String(data.created_by || "spiderx");
    await sqlExec(
      `INSERT INTO users (user_id, role_id, user_name, user_pass, email_id, theme, login_flag,
        created_by, created_on, last_modified_by, last_modified_on, password_expiry, is_new)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, 1)`,
      [
        user_id,
        role_id,
        user_name,
        md5(plain),
        data.email_id || "",
        data.theme || "dark",
        by,
        now,
        by,
        now,
        now + 90 * 24 * 3600,
      ]
    );
    return reply.json({ ok: true, user_id });
  } catch (e) {
    return reply.status(502).json({ error: e instanceof Error ? e.message : "create failed" });
  }
}));

router.put("/", asyncHandler(async (req, reply) => {
  try {
    const body = (req.body ?? {});
    const data = body?.data || body;
    const id = Number(body?._id || data.id);
    if (!id) return reply.status(400).json({ error: "id required" });
    const now = nowEpochSec();
    const by = String(data.last_modified_by || "spiderx");
    const sets: string[] = [
      "user_name = ?",
      "role_id = ?",
      "email_id = ?",
      "theme = ?",
      "last_modified_by = ?",
      "last_modified_on = ?",
    ];
    const params: any[] = [
      data.user_name || data.user_id,
      Number(data.role_id),
      data.email_id || "",
      data.theme || "dark",
      by,
      now,
    ];
    if (data.user_pass || data.password) {
      sets.push("user_pass = ?");
      params.push(md5(String(data.user_pass || data.password)));
    }
    if (data.mfa_enabled !== undefined && data.mfa_enabled !== null) {
      sets.push("mfa_enabled = ?");
      params.push(Number(data.mfa_enabled) ? 1 : 0);
    }
    // Never force totp_enabled=1 without a secret — only allow clear via reset_totp
    if (data.reset_totp) {
      sets.push("totp_enabled = 0", "totp_secret = NULL", "totp_recovery_codes = NULL");
    } else if (data.totp_enabled === 0 || data.totp_enabled === false) {
      sets.push("totp_enabled = ?");
      params.push(0);
    }
    params.push(id);
    try {
      await sqlExec(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`, params);
    } catch (e) {
      // Retry without MFA columns if schema lacks them
      const msg = e instanceof Error ? e.message : String(e);
      if (!/mfa_enabled|totp_enabled|totp_secret|totp_recovery|Unknown column/i.test(msg)) throw e;
      if (data.reset_totp) {
        try {
          await sqlExec(`UPDATE users SET totp_enabled=0, mfa_enabled=? WHERE id=?`, [
            Number(data.mfa_enabled) ? 1 : 0,
            id,
          ]);
          return reply.json({ ok: true, id });
        } catch {
          /* fall through */
        }
      }
      const safeSets = sets.filter(
        (s) =>
          !s.startsWith("mfa_enabled") &&
          !s.startsWith("totp_enabled") &&
          !s.startsWith("totp_secret") &&
          !s.startsWith("totp_recovery")
      );
      const safeParams: any[] = [
        data.user_name || data.user_id,
        Number(data.role_id),
        data.email_id || "",
        data.theme || "dark",
        by,
        now,
      ];
      if (data.user_pass || data.password) {
        safeParams.push(md5(String(data.user_pass || data.password)));
      }
      safeParams.push(id);
      await sqlExec(`UPDATE users SET ${safeSets.join(", ")} WHERE id = ?`, safeParams);
    }
    return reply.json({ ok: true, id });
  } catch (e) {
    return reply.status(502).json({ error: e instanceof Error ? e.message : "update failed" });
  }
}));

router.delete("/", asyncHandler(async (req, reply) => {
  try {
    const body = (req.body ?? {});
    const ids: number[] = body?.ids || (body?.id ? [body.id] : []);
    if (!ids.length) return reply.status(400).json({ error: "ids required" });
    await sqlExec(`DELETE FROM users WHERE id IN (${ids.map(() => "?").join(",")})`, ids);
    return reply.json({ ok: true, deleted: ids.length });
  } catch (e) {
    return reply.status(502).json({ error: e instanceof Error ? e.message : "delete failed" });
  }
}));

export default router;
