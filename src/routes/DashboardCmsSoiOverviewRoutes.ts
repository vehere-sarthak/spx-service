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

function mapBuckets(agg: any) {
  return (agg?.buckets || []).map((b: any) => ({
    key: b.key,
    count: b.doc_count,
    hits: b.hits?.value ?? b.doc_count,
  }));
}

function multiTerms(raw: string | null, field: string) {
  if (!raw || raw === "all") return null;
  const values = raw.split(",").map((s) => s.trim()).filter((s) => s && s !== "all");
  if (!values.length) return null;
  if (values.length === 1) return { term: { [field]: values[0] } };
  return { terms: { [field]: values } };
}

function advancedFilters(advanced: string) {
  const must: any[] = [];
  if (!advanced.trim()) return must;
  const fieldMap: Record<string, string> = {
    priority: "priority.keyword",
    type: "type.keyword",
    probe_host_name: "probe_host_name.keyword",
    probe_ip: "probe_ip.keyword",
    countries_a2_codes: "countries_a2_codes.keyword",
    protocols: "protocols.keyword",
    link_name: "link_name.keyword",
    host: "host.keyword",
    value: "value.keyword",
    ref_id: "ref_id.keyword",
  };
  for (const part of advanced.split("|")) {
    const [field, condition, rawVal] = part.split(":");
    if (!field || !condition) continue;
    const value = decodeURIComponent(rawVal || "");
    const kw = fieldMap[field] || `${field}.keyword`;
    const plain = kw.replace(/\.keyword$/, "");
    if (condition === "exists") must.push({ exists: { field: plain } });
    else if (condition === "not_exists") must.push({ bool: { must_not: [{ exists: { field: plain } }] } });
    else if (condition === "is") must.push({ term: { [kw]: value } });
    else if (condition === "is_not") must.push({ bool: { must_not: [{ term: { [kw]: value } }] } });
    else if (condition === "contains") must.push({ wildcard: { [kw]: `*${value}*` } });
    else if (condition === "not_contains") must.push({ bool: { must_not: [{ wildcard: { [kw]: `*${value}*` } }] } });
    else if (condition === "starts_with") must.push({ prefix: { [kw]: value } });
  }
  return must;
}

/** ref_id on a SOI doc is a target_managements _id; map those to personalInfo.alias. */
async function resolveTargetAliases(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return out;
  try {
    const res: any = await esSearch(`${INDEX.targets}/_mget`, { ids: unique }, "POST");
    for (const doc of res?.docs || []) {
      const alias = doc?._source?.personalInfo?.alias;
      if (doc?._id && alias) out.set(String(doc._id), String(alias));
    }
  } catch {
    // Alias lookup is cosmetic — fall back to the raw ref_id.
  }
  return out;
}

router.get("/", asyncHandler(async (req, reply) => {
  try {
    const q = searchParams(req);
    const startTime = parseTimeParam(q.get("startTime") || q.get("fromDate"), "now-7d");
    const endTime = parseTimeParam(q.get("endTime") || q.get("toDate"), "now");
    const query = (q.get("query") || "").trim();

    const filter: any[] = [{ range: { "@timestamp": { gte: startTime, lte: endTime } } }];
    const probe = multiTerms(q.get("probe"), "probe_host_name.keyword");
    const link = multiTerms(q.get("link"), "link_name.keyword");
    const priority = multiTerms(q.get("priority"), "priority.keyword");
    const type = multiTerms(q.get("type"), "type.keyword");
    const country = multiTerms(q.get("country"), "countries_a2_codes.keyword");
    const protocol = multiTerms(q.get("protocol"), "protocols.keyword");
    for (const f of [probe, link, priority, type, country, protocol]) {
      if (f) filter.push(f);
    }
    filter.push(...advancedFilters(q.get("advanced") || ""));
    if (query) {
      filter.push({
        multi_match: {
          query,
          fields: ["value", "link_name", "type", "probe_host_name", "priority", "ref_id"],
        },
      });
    }

    const [kpi, hits, countries, types, links, aliases, hosts, protocols, alerts] = await Promise.all([
      esSearch(INDEX.alerts + "/_search", {
        size: 0,
        query: { bool: { filter: [{ range: { "@timestamp": { gte: startTime, lte: endTime } } }] } },
        aggs: { by_priority: { terms: { field: "priority.keyword", size: 10 } } },
      }),
      esSearch(INDEX.soi + "/_search", {
        size: 0,
        query: { bool: { filter } },
        aggs: {
          hits: { sum: { field: "hit_count" } },
          timeline: {
            date_histogram: { field: "@timestamp", fixed_interval: "6h", min_doc_count: 0 },
            aggs: { hits: { sum: { field: "hit_count" } } },
          },
          severity: { terms: { field: "priority.keyword", size: 10 } },
        },
      }),
      esSearch(INDEX.soi + "/_search", {
        size: 0,
        query: { bool: { filter } },
        aggs: {
          countries: {
            terms: { field: "countries_a2_codes.keyword", size: 15 },
            aggs: { hits: { sum: { field: "hit_count" } } },
          },
        },
      }),
      esSearch(INDEX.soi + "/_search", {
        size: 0,
        query: { bool: { filter } },
        aggs: {
          types: {
            terms: { field: "type.keyword", size: 15 },
            aggs: { hits: { sum: { field: "hit_count" } } },
          },
        },
      }),
      esSearch(INDEX.soi + "/_search", {
        size: 0,
        query: { bool: { filter } },
        aggs: {
          links: {
            terms: { field: "link_name.keyword", size: 15 },
            aggs: { hits: { sum: { field: "hit_count" } } },
          },
        },
      }),
      esSearch(INDEX.soi + "/_search", {
        size: 0,
        query: { bool: { filter } },
        aggs: {
          // SOI docs carry `ref_id` (the target_managements _id), not `filter_names`.
          // The readable alias is resolved from that id below.
          aliases: {
            terms: { field: "ref_id.keyword", size: 15 },
            aggs: { hits: { sum: { field: "hit_count" } } },
          },
        },
      }),
      esSearch(INDEX.soi + "/_search", {
        size: 0,
        query: { bool: { filter } },
        aggs: {
          hosts: {
            terms: { field: "probe_host_name.keyword", size: 15 },
            aggs: { hits: { sum: { field: "hit_count" } } },
          },
        },
      }),
      esSearch(INDEX.soi + "/_search", {
        size: 0,
        query: { bool: { filter } },
        aggs: {
          protocols: {
            terms: { field: "protocols.keyword", size: 15 },
            aggs: { hits: { sum: { field: "hit_count" } } },
          },
        },
      }),
      esSearch(INDEX.alerts + "/_search", {
        size: 0,
        query: { bool: { filter: [{ range: { "@timestamp": { gte: startTime, lte: endTime } } }] } },
        aggs: {
          alerts: {
            terms: { field: "alert_name.keyword", size: 15 },
            // vehere-ui's Top Active Alerts lists priority/probe/link per alert,
            // so carry one representative document per bucket.
            aggs: {
              latest: {
                top_hits: {
                  size: 1,
                  sort: [{ "@timestamp": "desc" }],
                  _source: ["priority", "probe_host_name", "link_name", "type"],
                },
              },
            },
          },
        },
      }),
    ]);

    // Resolve SOI alias ref_ids to target aliases in one mget.
    const aliasBuckets = mapBuckets((aliases as any).aggregations?.aliases);
    const aliasNames = await resolveTargetAliases(aliasBuckets.map((b: any) => String(b.key)));

    const pri = Object.fromEntries(
      (((kpi as any).aggregations?.by_priority?.buckets || []) as any[]).map((b) => [
        String(b.key).toLowerCase(),
        b.doc_count,
      ])
    );

    return reply.json({
      startTime,
      endTime,
      kpi: {
        totalSoi: totalHits(hits),
        totalHits: (hits as any).aggregations?.hits?.value || 0,
        highAlerts: pri.high || 0,
        criticalAlerts: pri.critical || 0,
        alertsTotal: totalHits(kpi),
        activeSpiderX: ((hosts as any).aggregations?.hosts?.buckets || []).length,
      },
      severity: mapBuckets((hits as any).aggregations?.severity),
      timeline: ((hits as any).aggregations?.timeline?.buckets || []).map((b: any) => ({
        t: b.key_as_string,
        count: b.doc_count,
        hits: b.hits?.value || 0,
      })),
      countries: mapBuckets((countries as any).aggregations?.countries),
      types: mapBuckets((types as any).aggregations?.types),
      links: mapBuckets((links as any).aggregations?.links),
      aliases: aliasBuckets.map((b: any) => ({
        ...b,
        ref_id: b.key,
        key: aliasNames.get(String(b.key)) || String(b.key),
      })),
      hosts: mapBuckets((hosts as any).aggregations?.hosts),
      protocols: mapBuckets((protocols as any).aggregations?.protocols),
      topAlerts: ((alerts as any).aggregations?.alerts?.buckets || []).map((b: any) => {
        const src = b.latest?.hits?.hits?.[0]?._source || {};
        return {
          key: b.key,
          count: b.doc_count,
          priority: String(src.priority || "info").toLowerCase(),
          probe: src.probe_host_name || "-",
          link: src.link_name || "-",
          type: src.type || "-",
        };
      }),
    });
  } catch (e) {
    return reply.status(502).json({ error: e instanceof Error ? e.message : "overview failed" });
  }
}));

export default router;
