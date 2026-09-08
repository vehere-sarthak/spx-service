import { Router } from "express";
import type { Response } from "express";
import { asyncHandler, searchParams, wildcardPath, fail } from "../lib/http";

const router = Router();

function ok(reply: Response, data: unknown) {
  return reply.json(data);
}

import { nowEpochSec, pageParams } from "../lib/api-utils";
import { sql, sqlExec } from "../lib/mysql";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

router.get("/", asyncHandler(async (req, reply) => {
  try {
    const q = searchParams(req);
    const { page, pageSize, from } = pageParams(q, 20);
    const query = (q.get("query") || "").trim();
    const where = query ? "WHERE role_name LIKE ? OR permissions LIKE ?" : "";
    const params = query ? [`%${query}%`, `%${query}%`] : [];
    const countRows = await sql<{ c: number }>(`SELECT COUNT(*) c FROM roles ${where}`, params);
    const rows = await sql(
      `SELECT r.*,
        (SELECT COUNT(*) FROM users u WHERE u.role_id = r.id) AS user_count
       FROM roles r
       ${where}
       ORDER BY r.created_on DESC
       LIMIT ? OFFSET ?`,
      [...params, pageSize, from]
    );
    return reply.json({ total: countRows[0]?.c || 0, page, pageSize, items: rows });
  } catch (e) {
    return reply.status(502).json({ error: e instanceof Error ? e.message : "roles failed" });
  }
}));

router.post("/", asyncHandler(async (req, reply) => {
  try {
    const body = (req.body ?? {});
    const data = body?.data || body;
    const role_name = String(data.role_name || "").trim();
    const permissions = String(data.permissions || "").trim();
    if (!role_name || !permissions) {
      return reply.status(400).json({ error: "role_name and permissions required" });
    }
    const now = nowEpochSec();
    const by = String(data.created_by || "spiderx");
    const result = await sqlExec(
      `INSERT INTO roles (role_name, permissions, system_name, created_by, created_on, last_modified_by, last_modified_on, landingPage)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        role_name,
        permissions,
        data.system_name || null,
        by,
        now,
        by,
        now,
        data.landingPage || "command",
      ]
    );
    return reply.json({ ok: true, id: result.insertId });
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
    await sqlExec(
      `UPDATE roles SET role_name=?, permissions=?, system_name=?, landingPage=?, last_modified_by=?, last_modified_on=? WHERE id=?`,
      [
        data.role_name,
        data.permissions,
        data.system_name || null,
        data.landingPage || "command",
        data.last_modified_by || "spiderx",
        now,
        id,
      ]
    );
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
    await sqlExec(`DELETE FROM roles WHERE id IN (${ids.map(() => "?").join(",")})`, ids);
    return reply.json({ ok: true, deleted: ids.length });
  } catch (e) {
    return reply.status(502).json({ error: e instanceof Error ? e.message : "delete failed" });
  }
}));

export default router;
