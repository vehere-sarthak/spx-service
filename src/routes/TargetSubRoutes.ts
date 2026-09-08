import { Router } from "express";
import type { Response } from "express";
import { asyncHandler, searchParams, wildcardPath, fail } from "../lib/http";

const router = Router();

function ok(reply: Response, data: unknown) {
  return reply.json(data);
}

import {
  INDEX,
  buildTargetDoc,
  esSearch,
  listTargets,
  mapTargetHit,
  pageParams,
  parseTimeParam,
  syncCaptureFilter,
  totalHits,
} from "../lib/targets";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: { sub: string[] } };


router.get("/*", asyncHandler(async (req, reply) => {
  const sub = (wildcardPath(req)).join("/");
  const q = searchParams(req);

  try {
    if (sub === "export") {
      const listed = await listTargets(
        new URLSearchParams({
          ...Object.fromEntries(q.entries()),
          page: "0",
          pageSize: q.get("pageSize") || "5000",
        })
      );
      const ids = (q.get("ids") || "").split(",").filter(Boolean);
      const rows = ids.length
        ? listed.items.filter((t: any) => ids.includes(t.id))
        : listed.items;
      return ok(reply, {
        details: rows.map((t: any) => ({
          alias: t.alias,
          firstName: t.firstName,
          lastName: t.lastName,
          priority: t.priority,
          status: t.enabled ? "active" : "inactive",
          values: (t.values || []).join("|"),
          created_by: t.created_by,
          created_on: t.created_on,
          validTill: t.validTill,
          description: t.description,
          id: t.id,
        })),
        totalCount: rows.length,
        exportedCount: rows.length,
      });
    }

    if (sub === "soi-stats") {
      const targetId = q.get("targetId") || "";
      if (!targetId) return reply.status(400).json({ error: "targetId required" });
      const startTime = parseTimeParam(q.get("fromDate") || q.get("startTime"), "now-7d");
      const endTime = parseTimeParam(q.get("toDate") || q.get("endTime"), "now");
      const termsAgg = (field: string) => ({
        terms: { field, size: 10, order: { total_hits: "desc" as const } },
        aggs: { total_hits: { sum: { field: "hit_count" } } },
      });
      const data: any = await esSearch(INDEX.soi + "/_search", {
        size: 0,
        query: {
          bool: {
            filter: [
              { term: { "ref_id.keyword": targetId } },
              { range: { "@timestamp": { gte: startTime, lte: endTime } } },
            ],
          },
        },
        aggs: {
          linkNames: termsAgg("link_name.keyword"),
          priorities: termsAgg("priority.keyword"),
          hosts: termsAgg("probe_host_name.keyword"),
          countries: termsAgg("countries_a2_codes.keyword"),
          total_hit_count: { sum: { field: "hit_count" } },
        },
      }).catch(() => ({ aggregations: {} }));
      const toBuckets = (agg: any) =>
        (agg?.buckets || []).map((b: any) => ({ key: b.key, count: b.total_hits?.value || 0 }));
      const aggs = data.aggregations || {};
      return ok(reply, {
        totalHits: aggs.total_hit_count?.value || 0,
        linkNames: toBuckets(aggs.linkNames),
        priorities: toBuckets(aggs.priorities),
        hosts: toBuckets(aggs.hosts),
        countries: toBuckets(aggs.countries),
      });
    }

    if (sub === "activity") {
      const targetName = q.get("targetName") || "";
      if (!targetName) return reply.status(400).json({ error: "targetName required" });
      const startTime = parseTimeParam(q.get("fromDate") || q.get("startTime"), "now-7d");
      const endTime = parseTimeParam(q.get("toDate") || q.get("endTime"), "now");
      const { page, pageSize, from } = pageParams(q, 50);
      const data: any = await esSearch(INDEX.soi + "/_search", {
        from,
        size: pageSize,
        track_total_hits: true,
        sort: [{ "@timestamp": "desc" }],
        query: {
          bool: {
            must: [
              { range: { "@timestamp": { gte: startTime, lte: endTime } } },
              {
                multi_match: {
                  query: targetName,
                  fields: ["filter_names", "target_name", "alias", "value", "keyword", "matched_value"],
                },
              },
            ],
          },
        },
      }).catch(async () =>
        esSearch(INDEX.alerts + "/_search", {
          from,
          size: pageSize,
          track_total_hits: true,
          sort: [{ "@timestamp": "desc" }],
          query: {
            bool: {
              must: [
                { range: { "@timestamp": { gte: startTime, lte: endTime } } },
                { multi_match: { query: targetName, fields: ["value", "alert_name", "link_name"] } },
              ],
            },
          },
        })
      );

      // Also build day timeline buckets for UI
      const timeline: any = await esSearch(INDEX.soi + "/_search", {
        size: 0,
        query: {
          bool: {
            must: [
              { range: { "@timestamp": { gte: startTime, lte: endTime } } },
              {
                multi_match: {
                  query: targetName,
                  fields: ["filter_names", "target_name", "alias", "value", "keyword"],
                },
              },
            ],
          },
        },
        aggs: {
          by_day: {
            date_histogram: { field: "@timestamp", calendar_interval: "day", min_doc_count: 1 },
            aggs: {
              by_type: { terms: { field: "priority.keyword", size: 10 } },
              hits: { sum: { field: "hit_count" } },
            },
          },
        },
      }).catch(() => ({ aggregations: { by_day: { buckets: [] } } }));

      const details = ((timeline.aggregations?.by_day?.buckets || []) as any[]).map((b) => ({
        date: b.key_as_string,
        count: b.doc_count,
        hits: b.hits?.value || 0,
        types: (b.by_type?.buckets || []).map((t: any) => ({ type: t.key, count: t.doc_count })),
      }));

      return ok(reply, {
        total: totalHits(data),
        page,
        pageSize,
        items: (data.hits?.hits || []).map((h: any) => ({ id: h._id, ts: h._source?.["@timestamp"], ...h._source })),
        details,
        success: true,
      });
    }

    if (sub === "frames") {
      const targetId = q.get("targetId") || "";
      if (!targetId) return reply.status(400).json({ error: "targetId required" });
      const startTime = parseTimeParam(q.get("fromDate") || q.get("startTime"), "now-1d");
      const endTime = parseTimeParam(q.get("toDate") || q.get("endTime"), "now");
      const { page, pageSize, from } = pageParams(q, 25);
      const caps: any = await esSearch(INDEX.captureFilter + "/_search", {
        size: 1000,
        _source: false,
        query: {
          bool: {
            should: [
              { term: { "reference_id.keyword": targetId } },
              { term: { reference_id: targetId } },
            ],
            minimum_should_match: 1,
          },
        },
      });
      const refIds = (caps.hits?.hits || []).map((h: any) => h._id);
      // also try targetId directly as ref_id (some deployments)
      const filterIds = [...new Set([...refIds, targetId])];
      const data: any = await esSearch(INDEX.frameDumps + "/_search", {
        from,
        size: pageSize,
        track_total_hits: true,
        sort: [{ "@timestamp": "desc" }],
        query: {
          bool: {
            filter: [
              {
                bool: {
                  should: [
                    { terms: { "ref_id.keyword": filterIds } },
                    { term: { "reference_id.keyword": targetId } },
                  ],
                  minimum_should_match: 1,
                },
              },
              { range: { "@timestamp": { gte: startTime, lte: endTime } } },
            ],
          },
        },
      }).catch(() => ({ hits: { hits: [], total: 0 } }));

      const rows = (data.hits?.hits || []).map((h: any) => {
        const s = h._source || {};
        return {
          id: h._id,
          _id: h._id,
          ts: s["@timestamp"],
          link_name: s.link_name,
          iface: s.iface_name || s.interface || s.capture_iface,
          length: s.frame_len || s.length || s.pkt_len,
          src_ip: s.src_ip || s.source_ip,
          dst_ip: s.dst_ip || s.dest_ip,
          hexdump: s.hexdump || s.frame_hex || s.raw,
          ...s,
        };
      });
      return ok(reply, { total: totalHits(data), totalCount: totalHits(data), page, pageSize, items: rows, rows });
    }

    // GET by id: /target-managements/:id
    if ((wildcardPath(req)).length === 1 && !["export", "activity", "frames", "soi-stats"].includes(sub)) {
      const id = wildcardPath(req)[0];
      const data: any = await esSearch(`${INDEX.targets}/_doc/${id}`, undefined, "GET");
      return ok(reply, mapTargetHit(data));
    }

    return reply.status(404).json({ error: `Unknown GET target-managements/${sub}` });
  } catch (e) {
    return reply.status(502).json({ error: e instanceof Error ? e.message : "failed" });
  }
}));

router.post("/*", asyncHandler(async (req, reply) => {
  const sub = (wildcardPath(req)).join("/");
  try {
    if (sub === "toggle-status") {
      const body = (req.body ?? {});
      const id = body?._id || body?.id;
      if (!id) return reply.status(400).json({ error: "_id required" });
      const cur: any = await esSearch(`${INDEX.targets}/_doc/${id}`, undefined, "GET");
      const current = !!cur._source?.enabled;
      const desired =
        body?.data?.enabled !== undefined || body?.enabled !== undefined
          ? !!(body?.data?.enabled ?? body?.enabled)
          : !current;
      await esSearch(`${INDEX.targets}/_update/${id}`, { doc: { enabled: desired } }, "POST");
      return ok(reply, { ok: true, id, enabled: desired });
    }

    if (sub === "share-target") {
      const body = (req.body ?? {});
      const targetId = body?.targetId || body?._id;
      const userIds: string[] = body?.userIds || [];
      if (!targetId) return reply.status(400).json({ error: "targetId required" });
      const shared = userIds.includes("All") ? ["All"] : userIds;
      await esSearch(`${INDEX.targets}/_update/${targetId}`, { doc: { shared } }, "POST");
      return ok(reply, { ok: true, success: true, targetId, shared });
    }

    if (sub === "bulk-import-target") {
      const body = (req.body ?? {});
      let rows: any[] = [];
      if (typeof body?.data === "string") {
        rows = JSON.parse(body.data);
      } else if (Array.isArray(body?.data)) {
        rows = body.data;
      } else if (Array.isArray(body)) {
        rows = body;
      }
      const by = String(body?.created_by || "spiderx");
      let inserted = 0;
      const failed: any[] = [];
      for (const row of rows) {
        try {
          const alias = row?.personalInfo?.alias || row?.alias;
          if (!alias) {
            failed.push({ row, error: "alias required" });
            continue;
          }
          const values = row?.targetValue || row?.values || [];
          const doc = buildTargetDoc(
            {
              ...row,
              alias,
              values,
              personalInfo: {
                alias,
                firstName: row?.personalInfo?.firstName || row?.firstName || "",
                lastName: row?.personalInfo?.lastName || row?.lastName || "",
                priority: row?.personalInfo?.priority || row?.priority || "medium",
                description: row?.personalInfo?.description || row?.description || "",
              },
              importName: row?.importName || body?.importName || `import-${Date.now()}`,
            },
            by
          );
          const res: any = await esSearch(`${INDEX.targets}/_doc`, doc, "POST");
          await syncCaptureFilter(res._id, doc, by).catch(() => null);
          inserted++;
        } catch (err) {
          failed.push({ row, error: err instanceof Error ? err.message : "failed" });
        }
      }
      return ok(reply, { ok: true, insertedCount: inserted, failedRecords: failed });
    }

    if (sub === "delete" || sub === "frames/decode") {
      if (sub === "delete") {
        const body = (req.body ?? {});
        const ids: string[] = body?.ids || [];
        if (!ids.length) return reply.status(400).json({ error: "ids required" });
        await esSearch(`${INDEX.targets}/_delete_by_query`, { query: { ids: { values: ids } } }, "POST");
        await esSearch(
          `${INDEX.captureFilter}/_delete_by_query`,
          { query: { terms: { "reference_id.keyword": ids } } },
          "POST"
        ).catch(() => null);
        return ok(reply, { ok: true, deleted: ids.length });
      }
      // frames/decode — return structured stub from hex if tshark unavailable
      const body = (req.body ?? {});
      const hex = String(body?.hexdump || "").replace(/\s+/g, "");
      if (!hex) return reply.status(400).json({ error: "hexdump required" });
      const bytes = hex.match(/.{1,2}/g) || [];
      return ok(reply, {
        details: [
          {
            name: "Frame",
            showname: `Frame (${bytes.length} bytes)`,
            fields: [
              { name: "frame.len", showname: `Frame length: ${bytes.length} bytes` },
              { name: "hex", showname: hex.slice(0, 512) },
            ],
          },
        ],
      });
    }

    return reply.status(404).json({ error: `Unknown POST target-managements/${sub}` });
  } catch (e) {
    return reply.status(502).json({ error: e instanceof Error ? e.message : "failed" });
  }
}));

export default router;
