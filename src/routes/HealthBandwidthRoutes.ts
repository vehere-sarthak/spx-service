import { Router } from "express";
import type { Response } from "express";
import { asyncHandler, searchParams, wildcardPath, fail } from "../lib/http";

const router = Router();

function ok(reply: Response, data: unknown) {
  return reply.json(data);
}

import { INDEX, esSearch } from "../lib/es-server";
import { parseTimeParam } from "../lib/api-utils";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Probe bandwidth / traffic over time from link-stats. */
router.get("/", asyncHandler(async (req, reply) => {
  try {
    const q = searchParams(req);
    const startTime = parseTimeParam(q.get("startTime"), "now-8h");
    const endTime = parseTimeParam(q.get("endTime"), "now");
    const probe = (q.get("probe") || "").trim();

    const filter: any[] = [{ range: { "@timestamp": { gte: startTime, lte: endTime } } }];
    if (probe && probe !== "all") {
      filter.push({
        bool: {
          should: [
            { term: { "probe_host_name.keyword": probe } },
            { term: { "probe_ip.keyword": probe } },
          ],
          minimum_should_match: 1,
        },
      });
    }

    const data: any = await esSearch(INDEX.links + "/_search", {
      size: 0,
      query: { bool: { filter } },
      aggs: {
        timeline: {
          date_histogram: { field: "@timestamp", fixed_interval: "15m", min_doc_count: 0 },
          aggs: {
            bytes: { sum: { field: "total_bytes" } },
            packets: { sum: { field: "total_packets" } },
            bandwidth: { avg: { field: "bandwidth_mbps" } },
          },
        },
        by_probe: {
          terms: { field: "probe_ip.keyword", size: 20 },
          aggs: {
            bytes: { sum: { field: "total_bytes" } },
            bandwidth: { avg: { field: "bandwidth_mbps" } },
            host: { terms: { field: "probe_host_name.keyword", size: 1 } },
          },
        },
        by_link: {
          terms: { field: "link_name.keyword", size: 15 },
          aggs: { bytes: { sum: { field: "total_bytes" } } },
        },
      },
    });

    const timeline = (data.aggregations?.timeline?.buckets || []).map((b: any) => ({
      t: b.key_as_string,
      bytes: b.bytes?.value || 0,
      packets: b.packets?.value || 0,
      bandwidth_mbps: b.bandwidth?.value || (b.bytes?.value || 0) / (15 * 60) / 125000, // approx Mbps
    }));

    return reply.json({
      startTime,
      endTime,
      timeline,
      probes: (data.aggregations?.by_probe?.buckets || []).map((b: any) => ({
        ip: b.key,
        host: b.host?.buckets?.[0]?.key || b.key,
        bytes: b.bytes?.value || 0,
        bandwidth_mbps: b.bandwidth?.value || 0,
      })),
      links: (data.aggregations?.by_link?.buckets || []).map((b: any) => ({
        key: b.key,
        bytes: b.bytes?.value || 0,
      })),
    });
  } catch (e) {
    return reply.status(502).json({ error: e instanceof Error ? e.message : "bandwidth failed" });
  }
}));

export default router;
