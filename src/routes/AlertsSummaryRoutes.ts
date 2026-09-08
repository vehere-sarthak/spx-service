import { Router } from "express";
import type { Response } from "express";
import { asyncHandler, searchParams, wildcardPath, fail } from "../lib/http";

const router = Router();

function ok(reply: Response, data: unknown) {
  return reply.json(data);
}

import { INDEX, esSearch, totalHits } from "../lib/es-server";
import { parseTimeParam } from "../lib/api-utils";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Alerts summary dashboard aggregates (trend, offenders, mitre, severity, types). */
router.get("/", asyncHandler(async (req, reply) => {
  try {
    const q = searchParams(req);
    const startTime = parseTimeParam(q.get("startTime"), "now-7d");
    const endTime = parseTimeParam(q.get("endTime"), "now");
    const filter = [{ range: { "@timestamp": { gte: startTime, lte: endTime } } }];

    const [trend, offenders, mitre, severity, types, flagged] = await Promise.all([
      esSearch(INDEX.alerts + "/_search", {
        size: 0,
        query: { bool: { filter } },
        aggs: {
          timeline: {
            date_histogram: { field: "@timestamp", fixed_interval: "6h", min_doc_count: 0 },
          },
        },
      }),
      esSearch(INDEX.alerts + "/_search", {
        size: 0,
        query: { bool: { filter } },
        aggs: { offenders: { terms: { field: "value.keyword", size: 12 } } },
      }),
      esSearch(INDEX.alerts + "/_search", {
        size: 0,
        query: { bool: { filter } },
        aggs: { mitre: { terms: { field: "mitre_technique.keyword", size: 12 } } },
      }),
      esSearch(INDEX.alerts + "/_search", {
        size: 0,
        query: { bool: { filter } },
        aggs: { by_priority: { terms: { field: "priority.keyword", size: 10 } } },
      }),
      esSearch(INDEX.alerts + "/_search", {
        size: 0,
        query: { bool: { filter } },
        aggs: { by_type: { terms: { field: "type.keyword", size: 12 } } },
      }),
      esSearch(INDEX.alerts + "/_search", {
        size: 0,
        query: { bool: { filter: [...filter, { term: { important_flag: true } }] } },
      }).catch(() => ({ hits: { total: 0 } })),
    ]);

    return reply.json({
      startTime,
      endTime,
      kpi: {
        total: totalHits(trend),
        flagged: totalHits(flagged),
        high: ((severity as any).aggregations?.by_priority?.buckets || [])
          .filter((b: any) => String(b.key).toLowerCase() === "high" || String(b.key).toLowerCase() === "critical")
          .reduce((a: number, b: any) => a + b.doc_count, 0),
      },
      timeline: ((trend as any).aggregations?.timeline?.buckets || []).map((b: any) => ({
        t: b.key_as_string,
        count: b.doc_count,
      })),
      offenders: ((offenders as any).aggregations?.offenders?.buckets || []).map((b: any) => ({
        key: b.key,
        count: b.doc_count,
      })),
      mitre: ((mitre as any).aggregations?.mitre?.buckets || []).map((b: any) => ({
        key: b.key,
        count: b.doc_count,
      })),
      severity: ((severity as any).aggregations?.by_priority?.buckets || []).map((b: any) => ({
        key: b.key,
        count: b.doc_count,
      })),
      types: ((types as any).aggregations?.by_type?.buckets || []).map((b: any) => ({
        key: b.key,
        count: b.doc_count,
      })),
    });
  } catch (e) {
    return reply.status(502).json({ error: e instanceof Error ? e.message : "summary failed" });
  }
}));

export default router;
