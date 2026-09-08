import { Router } from "express";
import type { Response } from "express";
import { asyncHandler, searchParams, wildcardPath, fail } from "../lib/http";

const router = Router();

function ok(reply: Response, data: unknown) {
  return reply.json(data);
}

import { INDEX, esSearch, mapAlert } from "../lib/es-server";
import { parseTimeParam, pageParams } from "../lib/api-utils";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Flag / unflag / read / unread alerts in ES */
router.post("/", asyncHandler(async (req, reply) => {
  try {
    const body = (req.body ?? {});
    const action = String(body.action || "").toLowerCase(); // flag|unflag|read|unread|tag|untag
    const ids: { _id: string; _index?: string }[] = body.ids || [];
    const user = String(body.user || "spiderx");
    if (!ids.length) return reply.status(400).json({ error: "ids required" });

    if (action === "flag" || action === "unflag") {
      const flagged = action === "flag";
      await Promise.all(
        ids.map((d) =>
          esSearch(
            `${d._index || INDEX.alerts}/_update/${d._id}`,
            {
              doc: {
                important_flag: flagged,
                flagged_by: flagged ? user : null,
                flagged_on: flagged ? new Date().toISOString() : null,
              },
            },
            "POST"
          )
        )
      );
      return reply.json({ ok: true, action, count: ids.length });
    }

    if (action === "read" || action === "unread") {
      await Promise.all(
        ids.map((d) =>
          esSearch(
            `${d._index || INDEX.alerts}/_update/${d._id}`,
            {
              doc: {
                acknowledged_by: action === "read" ? user : null,
                acknowledged_on: action === "read" ? new Date().toISOString() : null,
              },
            },
            "POST"
          )
        )
      );
      return reply.json({ ok: true, action, count: ids.length });
    }

    if (action === "tag" || action === "untag") {
      const tagName = String(body.tagName || "").trim();
      const tagColor = String(body.tagColor || "#E11D2E");
      if (!tagName) return reply.status(400).json({ error: "tagName required" });
      await Promise.all(
        ids.map(async (d) => {
          const doc: any = await esSearch(`${d._index || INDEX.alerts}/_doc/${d._id}`, undefined, "GET");
          const src = doc?._source || {};
          const tags: any[] = Array.isArray(src.tags) ? [...src.tags] : [];
          if (action === "tag") {
            if (!tags.some((t) => (t.name || t) === tagName)) tags.push({ name: tagName, color: tagColor });
          } else {
            const next = tags.filter((t) => (t.name || t) !== tagName);
            tags.length = 0;
            tags.push(...next);
          }
          await esSearch(`${d._index || INDEX.alerts}/_update/${d._id}`, { doc: { tags } }, "POST");
        })
      );
      return reply.json({ ok: true, action, tagName, count: ids.length });
    }

    return reply.status(400).json({ error: "unknown action" });
  } catch (e) {
    return reply.status(502).json({ error: e instanceof Error ? e.message : "mark failed" });
  }
}));

/** CSV export of alerts matching filters (or selected ids) */
router.get("/", asyncHandler(async (req, reply) => {
  try {
    const q = searchParams(req);
    const startTime = parseTimeParam(q.get("startTime"), "now-7d");
    const endTime = parseTimeParam(q.get("endTime"), "now");
    const ids = (q.get("ids") || "").split(",").filter(Boolean);
    const { pageSize } = pageParams(q, 2000);
    const must: any[] = ids.length
      ? [{ ids: { values: ids } }]
      : [{ range: { "@timestamp": { gte: startTime, lte: endTime } } }];
    const query = (q.get("query") || "").trim();
    if (query && !ids.length) {
      must.push({
        multi_match: {
          query,
          fields: ["alert_name", "value", "link_name", "probe_host_name", "type"],
        },
      });
    }
    const data: any = await esSearch(INDEX.alerts + "/_search", {
      size: Math.min(pageSize, 5000),
      track_total_hits: true,
      sort: [{ "@timestamp": "desc" }],
      query: { bool: { must } },
    });
    const items = (data.hits?.hits || []).map(mapAlert);
    const header = ["id", "title", "severity", "value", "link", "probe", "type", "alert_type", "mitre", "timestamp", "flagged"];
    const lines = [
      header.join(","),
      ...items.map((r: any) =>
        [
          r.id,
          r.title,
          r.severity,
          r.value,
          r.link_name,
          r.probe_host_name,
          r.protocol,
          r.alert_type,
          r.mitre,
          r.ts,
          r.flagged ? "yes" : "no",
        ]
          .map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`)
          .join(",")
      ),
    ];
    reply.setHeader("Content-Type", "text/csv; charset=utf-8");
    reply.setHeader(
      "Content-Disposition",
      `attachment; filename="alerts-export-${Date.now()}.csv"`
    );
    return reply.send(lines.join("\n"));
  } catch (e) {
    return reply.status(502).json({ error: e instanceof Error ? e.message : "export failed" });
  }
}));

export default router;
