import { Router } from "express";
import type { Response } from "express";
import { asyncHandler, searchParams, wildcardPath, fail } from "../lib/http";

const router = Router();

function ok(reply: Response, data: unknown) {
  return reply.json(data);
}

import {
  proxyToSpx,
  testEsHttpConnection,
  withApplianceAuth,
} from "../lib/spx-proxy";
import { INDEX, esSearch } from "../lib/es-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: { id: string; action?: string[] } };

function enrichStatusFromLinkStats(rec: any, applianceStatus: any) {
  return (async () => {
    try {
      const live: any = await esSearch(INDEX.links + "/_search", {
        size: 0,
        query: {
          bool: {
            must: [
              { range: { "@timestamp": { gte: "now-1d", lte: "now" } } },
              { term: { "probe_ip.keyword": rec.ip_address } },
            ],
          },
        },
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
      });
      const last = live?.aggregations?.last?.hits?.hits?.[0]?._source;
      const age = last?.["@timestamp"] ? Date.now() - new Date(last["@timestamp"]).getTime() : Infinity;
      const probeRunning = age < 10 * 60 * 1000;
      return {
        ...applianceStatus,
        link_stats: {
          last_seen: last?.["@timestamp"],
          links: live?.aggregations?.links?.value || 0,
          probe_host_name: last?.probe_host_name,
          probe_status: probeRunning ? "Running" : age < 60 * 60 * 1000 ? "Degraded" : "Stopped",
        },
      };
    } catch {
      return applianceStatus;
    }
  })();
}

router.get("/*", asyncHandler(async (req, reply) => {
  const id = Number(String(req.params.id));
  const parts = wildcardPath(req);
  const action = parts.join("/");

  try {
    const rh = await withApplianceAuth(id);
    if (!rh) return reply.status(404).json({ error: "Appliance not found" });

    // Live iface-stats: services/probes/:probeId/iface-stats
    if (parts[0] === "services" && parts[1] === "probes" && parts[3] === "iface-stats") {
      const probeId = parts[2];
      const result = await proxyToSpx(
        rh.record.ip_address,
        `/api/services/probes/${probeId}/iface-stats`,
        "GET",
        undefined,
        rh.authHeaders
      );
      return reply.status(result.status).json(result.data);
    }

    const map: Record<string, string> = {
      "services/status": "/api/services/status",
      interfaces: "/api/interfaces",
      "config/agent": "/api/config/agent",
      "config/probes": "/api/config/probes",
    };

    const path = map[action];
    if (!path) {
      return reply.status(404).json({ error: `Unknown GET action ${action}` });
    }

    let result: { status: number; data: any };
    try {
      result = await proxyToSpx(rh.record.ip_address, path, "GET", undefined, rh.authHeaders);
    } catch (e) {
      if (action === "services/status") {
        // Fall back to link-stats derived status when appliance unreachable
        const fallback = await enrichStatusFromLinkStats(rh.record, {
          agent: { active: false, state: "stopped" },
          probes: [],
          agent_status: "Stopped",
          probe_status: "Stopped",
          unreachable: true,
          error: e instanceof Error ? e.message : "unreachable",
        });
        return reply.json(fallback);
      }
      throw e;
    }

    if (action === "services/status") {
      const data = await enrichStatusFromLinkStats(rh.record, result.data);
      // Normalize display fields for UI
      const agentActive =
        data?.agent?.active === true ||
        String(data?.agent?.state || "").toLowerCase() === "running" ||
        String(data?.agent_status || "").toLowerCase() === "running";
      const probes = Array.isArray(data?.probes) ? data.probes : [];
      const anyProbe =
        probes.some((p: any) => p.running || String(p.state).toLowerCase() === "running") ||
        data?.link_stats?.probe_status === "Running";
      return reply.json({
        ...data,
        agent_status: agentActive ? "Running" : "Stopped",
        probe_status: anyProbe
          ? "Running"
          : data?.link_stats?.probe_status || "Stopped",
      });
    }

    return reply.status(result.status).json(result.data);
  } catch (e) {
    return reply.status(502).json({ error: e instanceof Error ? e.message : "proxy failed" });
  }
}));

router.post("/*", asyncHandler(async (req, reply) => {
  const id = Number(String(req.params.id));
  const action = (wildcardPath(req)).join("/");
  try {
    const rh = await withApplianceAuth(id);
    if (!rh) return reply.status(404).json({ error: "Appliance not found" });
    const body = (req.body ?? {}).catch(() => ({}));

    if (action === "config/agent/test-connection") {
      const { host, port, user, password, scheme, verify_certs } = body || {};
      if (!host || !port || !user || password === undefined) {
        return reply.status(400).json({ ok: false, message: "host, port, user and password are required" });
      }
      const probed = await testEsHttpConnection({
        host,
        port: Number(port),
        user,
        password,
        scheme,
        verify_certs,
      });
      return reply.json(probed);
    }

    const map: Record<string, { path: string; body?: any }> = {
      "services/agent/start": { path: "/api/services/agent/start", body: {} },
      "services/agent/stop": { path: "/api/services/agent/stop", body: {} },
      "services/probes/start": { path: "/api/services/probes/start", body: {} },
      "services/probes/stop": { path: "/api/services/probes/stop", body: {} },
      "config/probes/apply": { path: "/api/config/probes/apply", body },
      "auth/change-password": {
        path: "/api/auth/change-password",
        body: {
          username: body.username,
          current_password: body.current_password,
          new_password: body.new_password,
        },
      },
    };

    const entry = map[action];
    if (!entry) {
      return reply.status(404).json({ error: `Unknown POST action ${action}` });
    }

    // Empty interfaces → try clear variants
    if (action === "config/probes/apply") {
      const interfaces = Array.isArray(body?.interfaces) ? body.interfaces : [];
      if (!interfaces.length) {
        const attempts = [
          { path: "/api/config/probes/apply", body: { interfaces: [], probe_ips: {}, clear: true } },
          { path: "/api/config/probes/apply?clear=true", body: { interfaces: [], probe_ips: {} } },
          { path: "/api/config/probes/reset", body: {} },
          { path: "/api/config/probes/clear", body: {} },
        ];
        let last = { status: 400, data: { detail: "select at least one interface" } as any };
        for (const a of attempts) {
          last = await proxyToSpx(rh.record.ip_address, a.path, "POST", a.body, rh.authHeaders);
          if (last.status >= 200 && last.status < 300) break;
        }
        return reply.status(last.status).json(last.data);
      }
    }

    const result = await proxyToSpx(rh.record.ip_address, entry.path, "POST", entry.body, rh.authHeaders);
    return reply.status(result.status).json(result.data);
  } catch (e) {
    return reply.status(502).json({ error: e instanceof Error ? e.message : "proxy failed" });
  }
}));

router.put("/*", asyncHandler(async (req, reply) => {
  const id = Number(String(req.params.id));
  const action = (wildcardPath(req)).join("/");
  try {
    const rh = await withApplianceAuth(id);
    if (!rh) return reply.status(404).json({ error: "Appliance not found" });
    if (action !== "config/agent") {
      return reply.status(404).json({ error: `Unknown PUT action ${action}` });
    }
    const body = (req.body ?? {}).catch(() => ({}));
    const payload = body?.config ? body : body?.data ? body.data : body;
    const result = await proxyToSpx(rh.record.ip_address, "/api/config/agent", "PUT", payload, rh.authHeaders);
    return reply.status(result.status).json(result.data);
  } catch (e) {
    return reply.status(502).json({ error: e instanceof Error ? e.message : "proxy failed" });
  }
}));

export default router;
