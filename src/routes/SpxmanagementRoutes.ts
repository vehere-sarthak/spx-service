import { Router } from "express";
import type { Response } from "express";
import { asyncHandler, searchParams, wildcardPath, fail } from "../lib/http";

const router = Router();

function ok(reply: Response, data: unknown) {
  return reply.json(data);
}

import { nowEpochSec, pageParams } from "../lib/api-utils";
import { sql, sqlExec } from "../lib/mysql";
import { INDEX, esSearch } from "../lib/es-server";
import { decryptWirePassword, encryptPassword, proxyToSpx, SPX_PORT } from "../lib/spx-proxy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

router.get("/", asyncHandler(async (req, reply) => {
  try {
    const q = searchParams(req);
    const { page, pageSize, from } = pageParams(q, 50);
    const query = (q.get("query") || "").trim();
    const where = query ? "WHERE name LIKE ? OR ip_address LIKE ? OR username LIKE ?" : "";
    const params = query ? [`%${query}%`, `%${query}%`, `%${query}%`] : [];
    const countRows = await sql<{ c: number }>(`SELECT COUNT(*) c FROM spx_management ${where}`, params);
    const rows = await sql(
      `SELECT id, name, ip_address, username, created_by, created_on, last_modified_by, last_modified_on
       FROM spx_management ${where}
       ORDER BY created_on DESC LIMIT ? OFFSET ?`,
      [...params, pageSize, from]
    );

    const live: any = await esSearch(INDEX.links + "/_search", {
      size: 0,
      query: { range: { "@timestamp": { gte: "now-1d", lte: "now" } } },
      aggs: {
        by_ip: {
          terms: { field: "probe_ip.keyword", size: 100 },
          aggs: {
            last: {
              top_hits: {
                size: 1,
                sort: [{ "@timestamp": "desc" }],
                _source: ["probe_host_name", "probe_ip", "@timestamp"],
              },
            },
            links: { cardinality: { field: "link_name.keyword" } },
          },
        },
      },
    }).catch(() => ({ aggregations: { by_ip: { buckets: [] } } }));

    const byIp = new Map(
      ((live.aggregations?.by_ip?.buckets || []) as any[]).map((b) => {
        const last = b.last?.hits?.hits?.[0]?._source || {};
        const age = Date.now() - new Date(last["@timestamp"] || 0).getTime();
        return [
          b.key,
          {
            probe_status: !last["@timestamp"] ? "Stopped" : age > 10 * 60 * 1000 ? "Degraded" : "Running",
            last_seen: last["@timestamp"],
            links: b.links?.value || 0,
            probe_host_name: last.probe_host_name,
          },
        ];
      })
    );

    const items = rows.map((r: any) => {
      const liveRow = byIp.get(r.ip_address) || { probe_status: "Stopped", links: 0 };
      const probe_status = liveRow.probe_status || "Stopped";
      const agent_status =
        probe_status === "Running" ? "Running" : probe_status === "Degraded" ? "Degraded" : "Stopped";
      return { ...r, ...liveRow, probe_status, agent_status };
    });

    return reply.json({
      total: countRows[0]?.c || 0,
      page,
      pageSize,
      items,
      result: items,
      kpi: {
        appliances: countRows[0]?.c || 0,
        agentRunning: items.filter((i: any) => i.agent_status === "Running").length,
        probeRunning: items.filter((i: any) => i.probe_status === "Running").length,
      },
    });
  } catch (e) {
    return reply.status(502).json({ error: e instanceof Error ? e.message : "spx list failed" });
  }
}));

router.post("/", asyncHandler(async (req, reply) => {
  try {
    const body = (req.body ?? {});
    const data = body?.data || body;
    const name = String(data.name || "").trim();
    const ip_address = String(data.ip_address || "").trim();
    const username = String(data.username || "admin").trim();
    const plainPassword = decryptWirePassword(String(data.password || ""));
    if (!name || !ip_address || !plainPassword) {
      return reply.status(400).json({ error: "name, ip_address, password required" });
    }

    let loginResult: { status: number; data: any };
    try {
      loginResult = await proxyToSpx(ip_address, "/api/auth/login", "POST", {
        username,
        password: plainPassword,
      });
    } catch (err: any) {
      return reply.status(502).json({
          error: `Unable to reach Spider-X Edge at ${ip_address}:${SPX_PORT}. ${err?.message || ""}`,
        });
    }
    if (loginResult.status === 401 || !loginResult.data?.ok) {
      return reply.status(401).json({ error: "Invalid credentials. Authentication against Spider-X Edge appliance failed." });
    }

    const now = nowEpochSec();
    const by = String(data.created_by || "spiderx");
    const result = await sqlExec(
      `INSERT INTO spx_management (name, ip_address, username, password, created_by, created_on, last_modified_by, last_modified_on)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [name, ip_address, username, encryptPassword(plainPassword), by, now, by, now]
    );
    return reply.json({
      ok: true,
      success: true,
      id: result.insertId,
      message: "Spider-X Edge appliance registered successfully.",
    });
  } catch (e) {
    return reply.status(502).json({ error: e instanceof Error ? e.message : "register failed" });
  }
}));

router.put("/", asyncHandler(async (req, reply) => {
  try {
    const body = (req.body ?? {});
    const data = body?.data || body;
    const id = Number(body?._id || data.id);
    if (!id) return reply.status(400).json({ error: "id required" });
    const now = nowEpochSec();
    const sets = ["name=?", "ip_address=?", "username=?", "last_modified_by=?", "last_modified_on=?"];
    const params: any[] = [
      data.name,
      data.ip_address,
      data.username,
      data.last_modified_by || "spiderx",
      now,
    ];
    if (data.password) {
      sets.push("password=?");
      params.push(encryptPassword(decryptWirePassword(String(data.password))));
    }
    params.push(id);
    await sqlExec(`UPDATE spx_management SET ${sets.join(", ")} WHERE id=?`, params);
    return reply.json({ ok: true, id });
  } catch (e) {
    return reply.status(502).json({ error: e instanceof Error ? e.message : "update failed" });
  }
}));

router.delete("/", asyncHandler(async (req, reply) => {
  try {
    const body = (req.body ?? {});
    const ids: number[] = body?.ids || (body?.id ? [Number(body.id)] : []);
    if (!ids.length) return reply.status(400).json({ error: "ids required" });
    await sqlExec(`DELETE FROM spx_management WHERE id IN (${ids.map(() => "?").join(",")})`, ids);
    return reply.json({
      ok: true,
      success: true,
      deleted: ids.length,
      message: "Appliance removed successfully.",
    });
  } catch (e) {
    return reply.status(502).json({ error: e instanceof Error ? e.message : "delete failed" });
  }
}));

export default router;
