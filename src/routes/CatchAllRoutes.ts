import { Router } from "express";
import type { Response } from "express";
import { asyncHandler, searchParams, wildcardPath, fail } from "../lib/http";

const router = Router();

function ok(reply: Response, data: unknown) {
  return reply.json(data);
}

import { INDEX, esHost, esSearch, linkSignals, mapAlert, readApiCache, totalHits } from "../lib/es-server";
import { pageParams, parseTimeParam, pickInterval, resolveBoundMs } from "../lib/api-utils";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: { path: string[] } };


const PRIORITY_RANK = ["critical", "high", "medium", "low", "info"];

/** Highest priority present in a per-term `priority.keyword` sub-aggregation. */
function worstPriority(buckets: { key: string }[] | undefined) {
  const seen = new Set((buckets || []).map((b) => String(b.key).toLowerCase()));
  return PRIORITY_RANK.find((p) => seen.has(p)) || "info";
}

/** Compact byte label for the golden-thread rail. */
function formatBytesShort(n: number) {
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let v = Math.max(0, n);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function cacheOk(reply: Response, name: string) {
  const cached = readApiCache(name);
  if (!cached) return null;
  return ok(reply, { ...(cached as object), source: "cache" });
}

router.get("/*", asyncHandler(async (req, reply) => {
  const parts = wildcardPath(req);
  const path = parts.join("/");
  const q = searchParams(req);

  try {
    // health
    if (path === "health/es") {
      const info: any = await esSearch("", undefined, "GET");
      return ok(reply, { ok: true, host: esHost(), cluster: info.cluster_name, name: info.name });
    }

    // command center aggregate
    if (path === "ndr/command") {
      const startTime = parseTimeParam(q.get("startTime"), "now-7d");
      const endTime = parseTimeParam(q.get("endTime"), "now");
      const priority = (q.get("priority") || "").trim().toLowerCase();
      const inRange = { range: { "@timestamp": { gte: startTime, lte: endTime } } };
      // One bucket width shared by every timeline on the page, plus explicit
      // bounds — without them a per-target histogram only spans that target's own
      // first-to-last hit and the waterfall rows stop lining up.
      const { interval } = pickInterval(startTime, endTime, 48);
      const windowEndMs = resolveBoundMs(endTime, Date.now());
      const windowStartMs = resolveBoundMs(startTime, windowEndMs - 7 * 86_400_000);
      const bounds = { min: windowStartMs, max: windowEndMs };
      const nowSec = Math.floor(Date.now() / 1000);
      // The stream is a windowed slice, so its filter has to run in ES — filtering a
      // 20-doc page client-side would show nothing for priorities the KPI counts as busy.
      const recentQuery = priority
        ? {
            bool: {
              filter: [inRange],
              // `priority.keyword` is stored with inconsistent casing, same as /alerts.
              should: [
                { term: { "priority.keyword": priority } },
                { term: { "priority.keyword": priority[0].toUpperCase() + priority.slice(1) } },
              ],
              minimum_should_match: 1,
            },
          }
        : inRange;

      // Counter sub-fields are per-deployment, so the waterfall rows come from the
      // live link-stats mapping rather than a hard-coded protocol list.
      const signals = await linkSignals();
      const spectrumAggs = Object.fromEntries(
        signals.map((sig) => [`${sig.band}:${sig.key}`, { sum: { field: sig.field } }])
      );

      const [
        alertsAgg,
        soiAgg,
        linksAgg,
        targetsAgg,
        recent,
        cadence,
        offenders,
        spectrum,
        filters,
        wire,
        subjectsAgg,
      ] = await Promise.all([
          esSearch(INDEX.alerts + "/_search", {
            size: 0,
            // Without this the headline total caps at 10k and contradicts the priority strip.
            track_total_hits: true,
            query: inRange,
            aggs: { by_priority: { terms: { field: "priority.keyword", size: 10 } } },
          }),
          esSearch(INDEX.soi + "/_search", {
            size: 0,
            // The golden-thread rail reports this as a document count, so it must
            // not stop at the 10k default the way an unbounded search would.
            track_total_hits: true,
            query: inRange,
            aggs: { hits: { sum: { field: "hit_count" } } },
          }),
          esSearch(INDEX.links + "/_search", {
            size: 0,
            query: { range: { "@timestamp": { gte: "now-1d", lte: endTime } } },
            aggs: {
              links: { cardinality: { field: "link_name.keyword" } },
              bytes: { sum: { field: "total_bytes" } },
            },
          }),
          esSearch(INDEX.targets + "/_search", {
            size: 0,
            track_total_hits: true,
            query: { match_all: {} },
            aggs: {
              enabled: { filter: { term: { enabled: true } } },
              // Authority-window state: a target can be enabled but already lapsed.
              active_now: {
                filter: {
                  bool: {
                    filter: [
                      { term: { enabled: true } },
                      { range: { activeFrom: { lte: nowSec } } },
                      { range: { validTill: { gte: nowSec } } },
                    ],
                  },
                },
              },
              expired: { filter: { range: { validTill: { lt: nowSec } } } },
              expiring_24h: {
                filter: { range: { validTill: { gte: nowSec, lte: nowSec + 86_400 } } },
              },
              subjects: { cardinality: { field: "interceptionCriteria.subject.keyword" } },
            },
          }),
          esSearch(INDEX.alerts + "/_search", {
            size: 20,
            sort: [{ "@timestamp": "desc" }],
            query: recentQuery,
            track_total_hits: true,
          }),
          esSearch(INDEX.alerts + "/_search", {
            size: 0,
            query: inRange,
            aggs: {
              timeline: {
                date_histogram: {
                  field: "@timestamp",
                  fixed_interval: interval,
                  min_doc_count: 0,
                  extended_bounds: bounds,
                },
                aggs: {
                  by_priority: { terms: { field: "priority.keyword", size: 6 } },
                  subjects: { cardinality: { field: "target.personalInfo.alias.keyword" } },
                },
              },
            },
          }),
          esSearch(INDEX.alerts + "/_search", {
            size: 0,
            query: inRange,
            aggs: {
              offenders: {
                terms: { field: "value.keyword", size: 8 },
                aggs: {
                  // Severity per offender over the full range, not whatever the last 20 docs held.
                  by_priority: { terms: { field: "priority.keyword", size: 5 } },
                  // Gives every orbit node a real document to open in the dock.
                  latest: { top_hits: { size: 1, sort: [{ "@timestamp": "desc" }] } },
                },
              },
              links: { terms: { field: "link_name.keyword", size: 8 } },
            },
          }),
          esSearch(INDEX.links + "/_search", {
            size: 0,
            query: inRange,
            aggs: {
              timeline: {
                date_histogram: {
                  field: "@timestamp",
                  fixed_interval: interval,
                  min_doc_count: 0,
                  extended_bounds: bounds,
                },
                aggs: spectrumAggs,
              },
            },
          }),
          // Golden-thread hop 2: what the agent actually hands the probes.
          esSearch(INDEX.captureFilter + "/_search", {
            size: 0,
            track_total_hits: true,
            query: { match_all: {} },
            aggs: { enabled: { filter: { term: { enabled: true } } } },
          }),
          // Hop 4-5: what the probes saw and the edge wrote back.
          esSearch(INDEX.links + "/_search", {
            size: 0,
            track_total_hits: true,
            query: inRange,
            aggs: {
              packets: { sum: { field: "total_packets" } },
              bytes: { sum: { field: "total_bytes" } },
              probes: { cardinality: { field: "probe_host_name.keyword" } },
              links: { cardinality: { field: "link_name.keyword" } },
            },
          }),
          // Hop 7: the analyst's own subjects, by name, over time.
          esSearch(INDEX.alerts + "/_search", {
            size: 0,
            query: inRange,
            aggs: {
              subjects: {
                terms: { field: "target.personalInfo.alias.keyword", size: 24 },
                aggs: {
                  timeline: {
                    date_histogram: {
                      field: "@timestamp",
                      fixed_interval: interval,
                      min_doc_count: 0,
                      extended_bounds: bounds,
                    },
                  },
                  subject: { terms: { field: "target.interceptionCriteria.subject.keyword", size: 1 } },
                  by_priority: { terms: { field: "priority.keyword", size: 5 } },
                  links: { cardinality: { field: "link_name.keyword" } },
                  latest: { top_hits: { size: 1, sort: [{ "@timestamp": "desc" }] } },
                },
              },
              named: { filter: { exists: { field: "target.personalInfo.alias.keyword" } } },
              in_play: { cardinality: { field: "target.personalInfo.alias.keyword" } },
              latest: {
                top_hits: { size: 1, sort: [{ "@timestamp": "desc" }], _source: { includes: ["@timestamp"] } },
              },
            },
          }),
        ]);

      const pri = Object.fromEntries(
        ((alertsAgg as any).aggregations?.by_priority?.buckets || []).map((b: any) => [
          String(b.key).toLowerCase(),
          b.doc_count,
        ])
      );

      const cadenceBuckets = ((cadence as any).aggregations?.timeline?.buckets || []).map((b: any) => ({
        t: b.key_as_string,
        total: b.doc_count,
        subjects: b.subjects?.value || 0,
        priorities: Object.fromEntries(
          (b.by_priority?.buckets || []).map((p: any) => [String(p.key).toLowerCase(), p.doc_count])
        ) as Record<string, number>,
      }));

      const spectrumBuckets = (spectrum as any).aggregations?.timeline?.buckets || [];
      const spectrumRows = signals
        .map((sig) => {
          const key = `${sig.band}:${sig.key}`;
          const values = spectrumBuckets.map((b: any) => Math.round(b[key]?.value || 0));
          return {
            key: sig.key,
            band: sig.band,
            total: values.reduce((a: number, v: number) => a + v, 0),
            values,
          };
        })
        // A counter that never fired in this window is a dead row, not a quiet one.
        .filter((r) => r.total > 0)
        .sort((a, b) => b.total - a.total);

      const targetAggs = (targetsAgg as any).aggregations || {};
      const wireAggs = (wire as any).aggregations || {};
      const subjAggs = (subjectsAgg as any).aggregations || {};
      const alertsTotal = totalHits(alertsAgg);
      const latestAlertTs = subjAggs.latest?.hits?.hits?.[0]?._source?.["@timestamp"];
      const activeTargets = targetAggs.active_now?.doc_count || 0;
      const inPlay = subjAggs.in_play?.value || 0;

      // The seven hops of the golden thread, each with the live number that
      // proves the hop is moving. `stale` is advisory only — a hop with no
      // traffic in the window is not necessarily broken, just quiet.
      const thread = [
        {
          id: "target",
          step: 1,
          label: "Targets saved",
          detail: "target_managements",
          value: totalHits(targetsAgg),
          sub: `${activeTargets.toLocaleString()} active now`,
          stale: activeTargets === 0,
        },
        {
          id: "filter",
          step: 2,
          label: "Capture filters",
          detail: "capture_filter",
          value: totalHits(filters),
          sub: `${((filters as any).aggregations?.enabled?.doc_count || 0).toLocaleString()} enabled`,
          stale: totalHits(filters) === 0,
        },
        {
          id: "probe",
          step: 3,
          label: "Probes serving",
          detail: "probe dictionary",
          value: wireAggs.probes?.value || 0,
          sub: `${(wireAggs.links?.value || 0).toLocaleString()} links armed`,
          stale: (wireAggs.probes?.value || 0) === 0,
        },
        {
          id: "wire",
          step: 4,
          label: "Packets matched",
          detail: "on the wire",
          value: Math.round(wireAggs.packets?.value || 0),
          sub: formatBytesShort(wireAggs.bytes?.value || 0),
          stale: (wireAggs.packets?.value || 0) === 0,
        },
        {
          id: "edge",
          step: 5,
          label: "SOI hits",
          detail: "written on the edge",
          value: Math.round((soiAgg as any).aggregations?.hits?.value || 0),
          sub: `${totalHits(soiAgg).toLocaleString()} stat docs`,
          stale: totalHits(soiAgg) === 0,
        },
        {
          id: "cms",
          step: 6,
          label: "Indexed on CMS",
          detail: "soi-stats-*, link-stats-*",
          value: totalHits(soiAgg) + totalHits(wire),
          sub: "stat docs indexed",
          // Rendered relative by the rail, so freshness reads at a glance.
          ts: latestAlertTs || null,
          stale: !latestAlertTs,
        },
        {
          id: "console",
          step: 7,
          label: "Subjects in play",
          detail: "surfaced to the analyst",
          value: inPlay,
          sub: `${alertsTotal.toLocaleString()} alerts`,
          stale: inPlay === 0,
        },
      ];

      const subjectBuckets = subjAggs.subjects?.buckets || [];
      const subjectColumns = (subjectBuckets[0]?.timeline?.buckets || []).map(
        (b: any) => b.key_as_string
      );
      const subjectRows = subjectBuckets.map((b: any) => {
        const hit = b.latest?.hits?.hits?.[0];
        const latest = hit ? mapAlert(hit) : null;
        return {
          alias: b.key,
          subject: b.subject?.buckets?.[0]?.key || null,
          priority: worstPriority(b.by_priority?.buckets),
          total: b.doc_count,
          links: b.links?.value || 0,
          values: (b.timeline?.buckets || []).map((t: any) => t.doc_count),
          latest,
        };
      });

      return ok(reply, {
        kpi: {
          alerts_total: totalHits(alertsAgg),
          critical: pri.critical || 0,
          high: pri.high || 0,
          medium: pri.medium || 0,
          low: pri.low || 0,
          soi_hits: (soiAgg as any).aggregations?.hits?.value || 0,
          links: (linksAgg as any).aggregations?.links?.value || 0,
          link_bytes: (linksAgg as any).aggregations?.bytes?.value || 0,
          targets_total: totalHits(targetsAgg),
          targets_enabled: targetAggs.enabled?.doc_count || 0,
          targets_active: activeTargets,
          targets_expired: targetAggs.expired?.doc_count || 0,
          targets_expiring_24h: targetAggs.expiring_24h?.doc_count || 0,
          subjects_total: targetAggs.subjects?.value || 0,
          subjects_in_play: inPlay,
        },
        thread,
        subjects: { interval, buckets: subjectColumns, rows: subjectRows },
        cadence: { interval, buckets: cadenceBuckets },
        spectrum: {
          interval,
          buckets: spectrumBuckets.map((b: any) => b.key_as_string),
          rows: spectrumRows,
        },
        trend: { timeline: cadenceBuckets.map((b: any) => ({ t: b.t, count: b.total })) },
        offenders: {
          offenders: ((offenders as any).aggregations?.offenders?.buckets || []).map((b: any) => {
            const hit = b.latest?.hits?.hits?.[0];
            return {
              key: b.key,
              doc_count: b.doc_count,
              severity: worstPriority(b.by_priority?.buckets),
              latest: hit ? mapAlert(hit) : null,
            };
          }),
          links: (offenders as any).aggregations?.links?.buckets || [],
        },
        recent: {
          items: ((recent as any).hits?.hits || []).map(mapAlert),
          total: totalHits(recent),
          priority: priority || null,
        },
        meta: { es_host: esHost(), interval },
      });
    }

    // alerts list
    if (path === "alerts") {
      const { page, pageSize, from } = pageParams(q, 25);
      const startTime = parseTimeParam(q.get("startTime"), "now-7d");
      const endTime = parseTimeParam(q.get("endTime"), "now");
      const query = (q.get("query") || "").trim();
      const severity = (q.get("severity") || "").toLowerCase();
      const type = (q.get("type") || "").trim();
      const alertType = (q.get("alert_type") || "").trim();
      const probe = (q.get("probe") || q.get("probe_host_name") || "").trim();
      const link = (q.get("link") || q.get("link_name") || "").trim();
      const advanced = (q.get("advanced") || "").trim();

      const must: any[] = [{ range: { "@timestamp": { gte: startTime, lte: endTime } } }];
      if (query) {
        must.push({
          multi_match: {
            query,
            fields: ["alert_name", "value", "link_name", "probe_host_name", "type", "alert_type"],
          },
        });
      }
      const sevList = severity.split(",").map((s) => s.trim()).filter((s) => s && s !== "all");
      if (sevList.length) {
        must.push({
          bool: {
            should: sevList.flatMap((s) => [
              { term: { "priority.keyword": s } },
              { term: { "priority.keyword": s[0].toUpperCase() + s.slice(1) } },
            ]),
            minimum_should_match: 1,
          },
        });
      }
      const typeList = type.split(",").map((s) => s.trim()).filter((s) => s && s !== "all");
      if (typeList.length) must.push({ terms: { "type.keyword": typeList } });
      const alertTypeList = alertType.split(",").map((s) => s.trim()).filter((s) => s && s !== "all");
      if (alertTypeList.length) must.push({ terms: { "alert_type.keyword": alertTypeList } });
      const probeList = probe.split(",").map((s) => s.trim()).filter((s) => s && s !== "all");
      if (probeList.length) must.push({ terms: { "probe_host_name.keyword": probeList } });
      const linkList = link.split(",").map((s) => s.trim()).filter((s) => s && s !== "all");
      if (linkList.length) must.push({ terms: { "link_name.keyword": linkList } });

      // advanced rules: field:condition:value|...
      if (advanced) {
        for (const part of advanced.split("|")) {
          const [field, condition, rawVal] = part.split(":");
          if (!field || !condition) continue;
          const value = decodeURIComponent(rawVal || "");
          const kw = `${field}.keyword`;
          if (condition === "exists") must.push({ exists: { field } });
          else if (condition === "not_exists") must.push({ bool: { must_not: [{ exists: { field } }] } });
          else if (condition === "is") must.push({ term: { [kw]: value } });
          else if (condition === "is_not") must.push({ bool: { must_not: [{ term: { [kw]: value } }] } });
          else if (condition === "contains") must.push({ wildcard: { [kw]: `*${value}*` } });
          else if (condition === "not_contains") must.push({ bool: { must_not: [{ wildcard: { [kw]: `*${value}*` } }] } });
          else if (condition === "starts_with") must.push({ prefix: { [kw]: value } });
          else if (condition === "is_one_of") {
            const vals = value.split(",").map((s) => s.trim()).filter(Boolean);
            if (vals.length) must.push({ terms: { [kw]: vals } });
          } else if (condition === "cidr") {
            must.push({ term: { [field]: value } }); // ES IP type supports CIDR in term on ip fields
          } else if (["gt", "gte", "lt", "lte"].includes(condition)) {
            must.push({ range: { [field]: { [condition]: isNaN(Number(value)) ? value : Number(value) } } });
          }
        }
      }

      const data: any = await esSearch(INDEX.alerts + "/_search", {
        from,
        size: pageSize,
        track_total_hits: true,
        sort: [{ "@timestamp": "desc" }],
        query: { bool: { must } },
        aggs: {
          by_priority: { terms: { field: "priority.keyword", size: 10 } },
          by_type: { terms: { field: "type.keyword", size: 15 } },
          by_alert_type: { terms: { field: "alert_type.keyword", size: 10 } },
          by_probe: { terms: { field: "probe_host_name.keyword", size: 20 } },
          by_link: { terms: { field: "link_name.keyword", size: 20 } },
        },
      });

      return ok(reply, {
        total: totalHits(data),
        page,
        pageSize,
        startTime,
        endTime,
        items: (data.hits?.hits || []).map(mapAlert),
        aggs: {
          by_priority: data.aggregations?.by_priority?.buckets || [],
          by_type: data.aggregations?.by_type?.buckets || [],
          by_alert_type: data.aggregations?.by_alert_type?.buckets || [],
          by_probe: data.aggregations?.by_probe?.buckets || [],
          by_link: data.aggregations?.by_link?.buckets || [],
        },
      });
    }

    if (path === "alerts/dashboard/alerts-trend") {
      const startTime = q.get("startTime") || "now-7d";
      const data: any = await esSearch(INDEX.alerts + "/_search", {
        size: 0,
        query: { range: { "@timestamp": { gte: startTime, lte: "now" } } },
        aggs: {
          timeline: {
            date_histogram: {
              field: "@timestamp",
              fixed_interval: q.get("interval") || "6h",
              min_doc_count: 0,
            },
          },
          by_priority: { terms: { field: "priority.keyword", size: 10 } },
        },
      });
      return ok(reply, {
        total: totalHits(data),
        timeline: (data.aggregations?.timeline?.buckets || []).map((b: any) => ({
          t: b.key_as_string,
          count: b.doc_count,
        })),
        by_priority: data.aggregations?.by_priority?.buckets || [],
      });
    }

    if (path === "alerts/dashboard/top-offenders") {
      const startTime = q.get("startTime") || "now-7d";
      const data: any = await esSearch(INDEX.alerts + "/_search", {
        size: 0,
        query: { range: { "@timestamp": { gte: startTime, lte: "now" } } },
        aggs: {
          offenders: { terms: { field: "value.keyword", size: Number(q.get("size") || 10) } },
          hosts: { terms: { field: "probe_host_name.keyword", size: 8 } },
          links: { terms: { field: "link_name.keyword", size: 8 } },
        },
      });
      return ok(reply, {
        offenders: data.aggregations?.offenders?.buckets || [],
        hosts: data.aggregations?.hosts?.buckets || [],
        links: data.aggregations?.links?.buckets || [],
      });
    }

    // links
    if (path === "link-monitoring") {
      const { page, pageSize } = pageParams(q, 50);
      const startTime = parseTimeParam(q.get("startTime"), "now-1d");
      const endTime = parseTimeParam(q.get("endTime"), "now");
      const query = (q.get("query") || "").trim().toLowerCase();
      const probeHost = q.get("probeHost") || "";
      const probeIp = q.get("probeIp") || "";
      const idType = q.get("identifierType") || "";

      const data: any = await esSearch(INDEX.links + "/_search", {
        size: 0,
        track_total_hits: true,
        query: { range: { "@timestamp": { gte: startTime, lte: endTime } } },
        aggs: {
          bytes: { sum: { field: "total_bytes" } },
          packets: { sum: { field: "total_packets" } },
          soi: { sum: { field: "total_soi_type_count" } },
          probes: { cardinality: { field: "probe_host_name.keyword" } },
          links: {
            terms: { field: "link_name.keyword", size: Number(q.get("aggSize") || 500) },
            aggs: {
              bytes: { sum: { field: "total_bytes" } },
              packets: { sum: { field: "total_packets" } },
              soi: { sum: { field: "total_soi_type_count" } },
              last: {
                top_hits: {
                  size: 1,
                  sort: [{ "@timestamp": "desc" }],
                  _source: [
                    "link_name",
                    "probe_host_name",
                    "probe_ip",
                    "probe_id",
                    "identifier_type",
                    "identifier_value",
                    "total_bytes",
                    "total_packets",
                    "protocols",
                    "protocols_count",
                    "applications",
                    "applications_count",
                    "categories",
                    "encapsulations",
                    "countries_a2_codes",
                    "iface_names",
                    "start_time_in_epoch_milli",
                    "end_time_in_epoch_milli",
                    "@timestamp",
                  ],
                },
              },
            },
          },
          by_probe: { terms: { field: "probe_host_name.keyword", size: 30 } },
          by_probe_ip: { terms: { field: "probe_ip.keyword", size: 30 } },
          by_id_type: { terms: { field: "identifier_type.keyword", size: 20 } },
        },
      });

      let items = (data.aggregations?.links?.buckets || []).map((b: any) => {
        const last = b.last?.hits?.hits?.[0]?._source || {};
        const ageMs = Date.now() - new Date(last["@timestamp"] || 0).getTime();
        const state = !last["@timestamp"] ? "no-data" : ageMs > 10 * 60 * 1000 ? "failed" : "passed";
        const windowSec = Math.max(
          1,
          (Number(last.end_time_in_epoch_milli || 0) - Number(last.start_time_in_epoch_milli || 0)) / 1000
        );
        const bps = (Number(last.total_bytes || 0) * 8) / windowSec;
        return {
          id: b.key,
          name: b.key,
          probe: last.probe_host_name || "-",
          probe_ip: last.probe_ip || "-",
          probe_id: last.probe_id,
          identifier_type: last.identifier_type,
          identifier_value: last.identifier_value,
          state,
          mbps: Math.round(bps / 1_000_000),
          packets: Number(b.packets?.value || last.total_packets || 0),
          bytes: Number(b.bytes?.value || 0),
          soi: Number(b.soi?.value || 0),
          protocols: last.protocols || [],
          protocols_count: last.protocols_count || {},
          applications: last.applications || [],
          applications_count: last.applications_count || {},
          categories: last.categories || [],
          encapsulations: last.encapsulations || [],
          countries: last.countries_a2_codes || [],
          iface_names: last.iface_names || [],
          ts: last["@timestamp"],
          end_time_in_epoch_milli: last.end_time_in_epoch_milli,
        };
      });

      if (query) {
        items = items.filter((l: any) =>
          [l.name, l.probe, l.probe_ip, l.identifier_type, l.identifier_value]
            .join(" ")
            .toLowerCase()
            .includes(query)
        );
      }
      if (probeHost) items = items.filter((l: any) => l.probe === probeHost);
      if (probeIp) items = items.filter((l: any) => l.probe_ip === probeIp);
      if (idType) items = items.filter((l: any) => l.identifier_type === idType);
      const stateFilter = (q.get("state") || "").toLowerCase();
      if (stateFilter && stateFilter !== "all") {
        items = items.filter((l: any) => String(l.state).toLowerCase() === stateFilter);
      }

      const totalFiltered = items.length;
      const paged = items.slice(page * pageSize, page * pageSize + pageSize);
      const up = items.filter((l: any) => l.state === "passed").length;
      const degraded = items.filter((l: any) => l.state === "failed").length;
      const down = items.filter((l: any) => l.state === "no-data").length;

      return ok(reply, {
        total: totalFiltered,
        page,
        pageSize,
        startTime,
        endTime,
        windowHits: totalHits(data),
        kpi: {
          links: totalFiltered,
          probes: data.aggregations?.probes?.value || 0,
          bytes: data.aggregations?.bytes?.value || 0,
          packets: data.aggregations?.packets?.value || 0,
          soi: data.aggregations?.soi?.value || 0,
          passed: up,
          failed: degraded,
          noData: down,
        },
        facets: {
          probeHost: data.aggregations?.by_probe?.buckets || [],
          probeIp: data.aggregations?.by_probe_ip?.buckets || [],
          identifierType: data.aggregations?.by_id_type?.buckets || [],
        },
        items: paged,
      });
    }

    if (path === "link-monitoring/detail") {
      const linkName = q.get("link_name") || "";
      const startTime = q.get("startTime") || "now-1d";
      if (!linkName) return reply.status(400).json({ error: "link_name required" });
      const data: any = await esSearch(INDEX.links + "/_search", {
        size: 0,
        query: {
          bool: {
            must: [
              { term: { "link_name.keyword": linkName } },
              { range: { "@timestamp": { gte: startTime, lte: "now" } } },
            ],
          },
        },
        aggs: {
          bytes: { sum: { field: "total_bytes" } },
          packets: { sum: { field: "total_packets" } },
          timeline: {
            date_histogram: { field: "@timestamp", fixed_interval: "30m", min_doc_count: 0 },
            aggs: {
              bytes: { sum: { field: "total_bytes" } },
              packets: { sum: { field: "total_packets" } },
            },
          },
          last: {
            top_hits: {
              size: 1,
              sort: [{ "@timestamp": "desc" }],
              _source: true,
            },
          },
        },
      });
      const last = data.aggregations?.last?.hits?.hits?.[0]?._source || {};
      const protoCounts = last.protocols_count || {};
      const appCounts = last.applications_count || {};
      return ok(reply, {
        link_name: linkName,
        totals: {
          bytes: data.aggregations?.bytes?.value || 0,
          packets: data.aggregations?.packets?.value || 0,
          docs: totalHits(data),
        },
        last,
        timeline: (data.aggregations?.timeline?.buckets || []).map((b: any) => ({
          t: b.key_as_string,
          bytes: b.bytes?.value || 0,
          packets: b.packets?.value || 0,
        })),
        protocols: Object.entries(protoCounts).map(([name, value]) => ({ name, value: Number(value) })),
        applications: Object.entries(appCounts).map(([name, value]) => ({ name, value: Number(value) })),
      });
    }

    // targets
    if (path === "target-managements") {
      const { page, pageSize, from } = pageParams(q, 25);
      const query = (q.get("query") || "").trim();
      const status = (q.get("status") || "all").toLowerCase();
      const priority = (q.get("priority") || "all").toLowerCase();
      const must: any[] = [];
      if (query) {
        must.push({
          multi_match: {
            query,
            fields: [
              "personalInfo.alias",
              "personalInfo.firstName",
              "personalInfo.lastName",
              "targetValue",
              "created_by",
            ],
          },
        });
      }
      if (status === "active") must.push({ term: { enabled: true } });
      if (status === "inactive") must.push({ term: { enabled: false } });
      if (priority && priority !== "all") {
        must.push({
          bool: {
            should: [
              { term: { "personalInfo.priority.keyword": priority } },
              { term: { "personalInfo.priority.keyword": priority[0].toUpperCase() + priority.slice(1) } },
              { term: { "personalInfo.priority.keyword": priority.toUpperCase() } },
            ],
            minimum_should_match: 1,
          },
        });
      }
      const data: any = await esSearch(INDEX.targets + "/_search", {
        from,
        size: pageSize,
        track_total_hits: true,
        sort: [{ created_on: "desc" }],
        query: must.length ? { bool: { must } } : { match_all: {} },
        aggs: {
          by_priority: { terms: { field: "personalInfo.priority.keyword", size: 10 } },
          enabled: { terms: { field: "enabled", size: 2 } },
        },
      });
      const items = (data.hits?.hits || []).map((h: any) => {
        const s = h._source || {};
        const p = s.personalInfo || {};
        return {
          id: h._id,
          alias: p.alias,
          name: [p.firstName, p.lastName].filter(Boolean).join(" ") || p.alias,
          firstName: p.firstName,
          lastName: p.lastName,
          priority: String(p.priority || "").toLowerCase(),
          enabled: !!s.enabled,
          values: s.targetValue || [],
          created_by: s.created_by,
          created_on: s.created_on,
          last_modified_by: s.last_modified_by,
          last_modified_on: s.last_modified_on,
          activeFrom: s.activeFromTZ || s.activeFrom,
          validTill: s.validTillTZ || s.validTill,
          description: p.description,
          capture_action: s.capture_action,
          importName: s.importName,
        };
      });
      const enabledBuckets = data.aggregations?.enabled?.buckets || [];
      const activeCount = enabledBuckets.find((b: any) => b.key === 1 || b.key_as_string === "true")?.doc_count || 0;
      const inActiveCount =
        enabledBuckets.find((b: any) => b.key === 0 || b.key_as_string === "false")?.doc_count || 0;
      return ok(reply, {
        total: totalHits(data),
        page,
        pageSize,
        items,
        counts: {
          all: totalHits(data),
          active: activeCount,
          inactive: inActiveCount,
        },
        aggs: {
          by_priority: data.aggregations?.by_priority?.buckets || [],
          enabled: enabledBuckets,
        },
      });
    }

    if (path === "target-managements/activity") {
      const targetName = q.get("targetName") || "";
      const startTime = parseTimeParam(q.get("fromDate") || q.get("startTime"), "now-7d");
      const endTime = parseTimeParam(q.get("toDate") || q.get("endTime"), "now");
      const { page, pageSize, from } = pageParams(q, 25);
      if (!targetName) return reply.status(400).json({ error: "targetName required" });
      // Prefer SOI hits linked to this target alias/value
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
                  fields: ["filter_names", "target_name", "alias", "value", "keyword"],
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
      return ok(reply, {
        total: totalHits(data),
        page,
        pageSize,
        items: (data.hits?.hits || []).map((h: any) => ({
          id: h._id,
          ts: h._source?.["@timestamp"],
          ...h._source,
        })),
      });
    }

    if (path === "target-managements/frames") {
      const targetId = q.get("targetId") || "";
      const startTime = parseTimeParam(q.get("fromDate") || q.get("startTime"), "now-1d");
      const endTime = parseTimeParam(q.get("toDate") || q.get("endTime"), "now");
      const { page, pageSize, from } = pageParams(q, 25);
      if (!targetId) return reply.status(400).json({ error: "targetId required" });
      const caps: any = await esSearch(INDEX.captureFilter + "/_search", {
        size: 1000,
        _source: false,
        query: { term: { "reference_id.keyword": targetId } },
      });
      const refIds = (caps.hits?.hits || []).map((h: any) => h._id);
      if (!refIds.length) return ok(reply, { total: 0, page, pageSize, items: [] });
      const data: any = await esSearch(INDEX.frameDumps + "/_search", {
        from,
        size: pageSize,
        track_total_hits: true,
        sort: [{ "@timestamp": "desc" }],
        query: {
          bool: {
            filter: [
              { terms: { "ref_id.keyword": refIds } },
              { range: { "@timestamp": { gte: startTime, lte: endTime } } },
            ],
          },
        },
      });
      return ok(reply, {
        total: totalHits(data),
        page,
        pageSize,
        items: (data.hits?.hits || []).map((h: any) => ({ id: h._id, ...h._source })),
      });
    }

    if (path.startsWith("target-managements/") && parts.length === 2) {
      const id = parts[1];
      const data: any = await esSearch(`${INDEX.targets}/_doc/${id}`, undefined, "GET");
      const s = data._source || {};
      const p = s.personalInfo || {};
      return ok(reply, {
        id: data._id,
        ...s,
        alias: p.alias,
        priority: String(p.priority || "").toLowerCase(),
        name: [p.firstName, p.lastName].filter(Boolean).join(" ") || p.alias,
      });
    }

    // edge — probes from link-stats + capture ifaces from udf_iface
    if (path === "edge/overview") {
      const startTime = q.get("startTime") || "now-1d";
      const [probes, ifaces, esInfo] = await Promise.all([
        esSearch(INDEX.links + "/_search", {
          size: 0,
          query: { range: { "@timestamp": { gte: startTime, lte: "now" } } },
          aggs: {
            probes: {
              terms: { field: "probe_host_name.keyword", size: 50 },
              aggs: {
                ip: { terms: { field: "probe_ip.keyword", size: 1 } },
                links: { cardinality: { field: "link_name.keyword" } },
                bytes: { sum: { field: "total_bytes" } },
                packets: { sum: { field: "total_packets" } },
                last: {
                  top_hits: {
                    size: 1,
                    sort: [{ "@timestamp": "desc" }],
                    _source: ["probe_host_name", "probe_ip", "probe_id", "@timestamp"],
                  },
                },
              },
            },
          },
        }),
        esSearch(INDEX.iface + "/_search", { size: 100, query: { match_all: {} }, sort: [{ created_on: "desc" }] }),
        esSearch("", undefined, "GET"),
      ]);
      const probeItems = (((probes as any).aggregations?.probes?.buckets || []) as any[]).map((b) => {
        const last = b.last?.hits?.hits?.[0]?._source || {};
        const ageMs = Date.now() - new Date(last["@timestamp"] || 0).getTime();
        return {
          id: b.key,
          name: b.key,
          ip: last.probe_ip || b.ip?.buckets?.[0]?.key || "-",
          probe_id: last.probe_id,
          links: b.links?.value || 0,
          bytes: b.bytes?.value || 0,
          packets: b.packets?.value || 0,
          last_seen: last["@timestamp"],
          status: !last["@timestamp"] ? "stopped" : ageMs > 10 * 60 * 1000 ? "degraded" : "running",
        };
      });
      const ifaceItems = (((ifaces as any).hits?.hits || []) as any[]).map((h) => {
        const s = h._source || {};
        return {
          id: h._id,
          name: s.name,
          type: s.type,
          vlan_id: s.vlan_id || [],
          pbIP: s.pbIP,
          pbDeviceName: s.pbDeviceName,
          pbPort: s.pbPort,
          created_by: s.created_by,
          created_on: s.created_on,
          enabled: s.enabled !== false,
        };
      });
      return ok(reply, {
        es: {
          ok: true,
          cluster: (esInfo as any).cluster_name,
          name: (esInfo as any).name,
          host: esHost(),
        },
        probes: probeItems,
        ifaces: ifaceItems,
        kpi: {
          probes: probeItems.length,
          running: probeItems.filter((p: any) => p.status === "running").length,
          ifaces: ifaceItems.length,
          links: probeItems.reduce((a: number, p: any) => a + p.links, 0),
        },
      });
    }

    // health dashboard
    if (path === "health/dashboard") {
      const startTime = parseTimeParam(q.get("startTime"), "now-8h");
      const endTime = parseTimeParam(q.get("endTime"), "now");
      const host = q.get("host") || "";
      const must: any[] = [{ range: { "@timestamp": { gte: startTime, lte: endTime } } }];
      if (host) must.push({ term: { "beat.hostname": host } });

      const [hostsAgg, cpuMem, disk, procs, esInfo] = await Promise.all([
        esSearch(INDEX.monitor + "/_search", {
          size: 0,
          query: { range: { "@timestamp": { gte: startTime, lte: endTime } } },
          aggs: {
            hosts: {
              terms: { field: "beat.hostname", size: 20 },
              aggs: { system: { terms: { field: "system_name.keyword", size: 1 } } },
            },
          },
        }),
        esSearch(INDEX.monitor + "/_search", {
          size: 0,
          query: {
            bool: {
              must: [...must, { exists: { field: "system.cpu.user.pct" } }],
            },
          },
          aggs: {
            timeline: {
              date_histogram: { field: "@timestamp", fixed_interval: "10m", min_doc_count: 0 },
              aggs: {
                cpu: { avg: { field: "system.cpu.user.pct" } },
                sys: { avg: { field: "system.cpu.system.pct" } },
                idle: { avg: { field: "system.cpu.idle.pct" } },
              },
            },
          },
        }),
        esSearch(INDEX.monitor + "/_search", {
          size: 1,
          sort: [{ "@timestamp": "desc" }],
          query: {
            bool: {
              must: [...must, { exists: { field: "system.fsstat.total_size.total" } }],
            },
          },
        }),
        esSearch(INDEX.monitor + "/_search", {
          size: 0,
          query: {
            bool: {
              must: [
                ...must,
                { range: { "@timestamp": { gte: "now-1h", lte: "now" } } },
                { exists: { field: "system.process.name" } },
              ],
            },
          },
          aggs: { procs: { terms: { field: "system.process.name.keyword", size: 20 } } },
        }).catch(() => ({ aggregations: { procs: { buckets: [] } } })),
        esSearch("", undefined, "GET"),
      ]);

      // memory series (separate because field may not always co-exist)
      const memSeries: any = await esSearch(INDEX.monitor + "/_search", {
        size: 0,
        query: {
          bool: {
            must: [...must, { exists: { field: "system.memory.actual.used.pct" } }],
          },
        },
        aggs: {
          timeline: {
            date_histogram: { field: "@timestamp", fixed_interval: "10m", min_doc_count: 0 },
            aggs: { mem: { avg: { field: "system.memory.actual.used.pct" } } },
          },
        },
      }).catch(() => ({ aggregations: { timeline: { buckets: [] } } }));

      const diskSrc = ((disk as any).hits?.hits || [])[0]?._source?.system?.fsstat || {};
      const diskTotal = diskSrc.total_size || {};

      return ok(reply, {
        hosts: ((hostsAgg as any).aggregations?.hosts?.buckets || []).map((b: any) => ({
          name: b.key,
          system: b.system?.buckets?.[0]?.key || b.key,
          docs: b.doc_count,
        })),
        es: {
          ok: true,
          cluster: (esInfo as any).cluster_name,
          name: (esInfo as any).name,
          host: esHost(),
          version: (esInfo as any).version?.number,
        },
        cpu: ((cpuMem as any).aggregations?.timeline?.buckets || []).map((b: any) => ({
          t: b.key_as_string,
          user: Number(((b.cpu?.value || 0) * 100).toFixed(2)),
          system: Number(((b.sys?.value || 0) * 100).toFixed(2)),
          idle: Number(((b.idle?.value || 0) * 100).toFixed(2)),
        })),
        memory: ((memSeries as any).aggregations?.timeline?.buckets || []).map((b: any) => ({
          t: b.key_as_string,
          used: Number(((b.mem?.value || 0) * 100).toFixed(2)),
        })),
        disk: {
          total: diskTotal.total || 0,
          used: diskTotal.used || 0,
          free: diskTotal.free || 0,
        },
        processes: ((procs as any).aggregations?.procs?.buckets || []).map((b: any) => ({
          name: b.key,
          count: b.doc_count,
        })),
      });
    }

    // audit
    if (path === "audittrail") {
      const { page, pageSize, from } = pageParams(q, 50);
      const startTime = parseTimeParam(q.get("startTime") || q.get("startingdate"), "now-30d");
      const endTime = parseTimeParam(q.get("endTime") || q.get("endingdate"), "now");
      const query = (q.get("query") || "").trim();
      const categoryFilter = (q.get("category") || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const must: any[] = [{ range: { "@timestamp": { gte: startTime, lte: endTime } } }];
      if (query) {
        must.push({
          multi_match: {
            query,
            fields: ["username", "module", "event", "eventMessage", "clientIp", "category"],
          },
        });
      }
      if (categoryFilter.length) {
        must.push({
          bool: {
            should: [
              { terms: { "category.keyword": categoryFilter } },
              { terms: { category: categoryFilter } },
              { terms: { "module.keyword": categoryFilter } },
              { terms: { module: categoryFilter } },
            ],
            minimum_should_match: 1,
          },
        });
      }
      let data: any;
      try {
        data = await esSearch(INDEX.audit + "/_search", {
          from,
          size: pageSize,
          track_total_hits: true,
          sort: [{ "@timestamp": "desc" }],
          query: { bool: { must } },
          aggs: {
            by_category: {
              terms: { field: "category.keyword", size: 50, missing: "uncategorized" },
            },
          },
        });
      } catch {
        data = await esSearch(INDEX.audit + "/_search", {
          from,
          size: pageSize,
          track_total_hits: true,
          sort: [{ "@timestamp": "desc" }],
          query: { bool: { must } },
        });
      }
      const items = (data.hits?.hits || []).map((h: any) => {
        const s = h._source || {};
        return {
          id: h._id,
          ts: s["@timestamp"],
          username: s.username,
          clientIp: s.clientIp,
          category: s.category,
          module: s.module,
          event: s.event,
          message: s.eventMessage || s.message,
        };
      });
      return ok(reply, {
        total: totalHits(data),
        page,
        pageSize,
        startTime,
        endTime,
        items,
        aggs: {
          by_category: (data.aggregations?.by_category?.buckets || []).map((b: any) => ({
            key: b.key,
            doc_count: b.doc_count,
          })),
        },
      });
    }

    if (path === "dashboard/cms/soi/kpi-summary") {
      const startTime = q.get("startTime") || "now-7d";
      const [alerts, soi, links, targets] = await Promise.all([
        esSearch(INDEX.alerts + "/_search", {
          size: 0,
          query: { range: { "@timestamp": { gte: startTime, lte: "now" } } },
          aggs: { by_priority: { terms: { field: "priority.keyword", size: 10 } } },
        }),
        esSearch(INDEX.soi + "/_search", {
          size: 0,
          query: { range: { "@timestamp": { gte: startTime, lte: "now" } } },
          aggs: { hits: { sum: { field: "hit_count" } } },
        }),
        esSearch(INDEX.links + "/_search", {
          size: 0,
          query: { range: { "@timestamp": { gte: "now-1d", lte: "now" } } },
          aggs: {
            links: { cardinality: { field: "link_name.keyword" } },
            bytes: { sum: { field: "total_bytes" } },
          },
        }),
        esSearch(INDEX.targets + "/_search", {
          size: 0,
          query: { match_all: {} },
          aggs: { enabled: { filter: { term: { enabled: true } } } },
        }),
      ]);
      const pri = Object.fromEntries(
        ((alerts as any).aggregations?.by_priority?.buckets || []).map((b: any) => [
          String(b.key).toLowerCase(),
          b.doc_count,
        ])
      );
      return ok(reply, {
        alerts_total: totalHits(alerts),
        critical: pri.critical || 0,
        high: pri.high || 0,
        medium: pri.medium || 0,
        low: pri.low || 0,
        soi_hits: (soi as any).aggregations?.hits?.value || 0,
        links: (links as any).aggregations?.links?.value || 0,
        link_bytes: (links as any).aggregations?.bytes?.value || 0,
        targets_total: totalHits(targets),
        targets_enabled: (targets as any).aggregations?.enabled?.doc_count || 0,
      });
    }

    return reply.status(404).json({ error: `Unknown route /api/v1/${path}` });
  } catch (e) {
    console.error("[api/v1]", path, e);
    const fallbackKey =
      path === "health/es"
        ? "health-es"
        : path === "ndr/command"
          ? "ndr-command"
          : path === "alerts"
            ? "alerts"
            : path === "link-monitoring"
              ? "link-monitoring"
              : path === "target-managements"
                ? "target-managements"
                : path === "audittrail"
                  ? "audittrail"
                  : null;
    if (fallbackKey) {
      const cached = cacheOk(reply, fallbackKey);
      if (cached) {
        console.warn("[api/v1] serving cache for", path);
        return cached;
      }
    }
    return fail(reply, e, 502);
  }
}));

router.post("/*", asyncHandler(async (req, reply) => {
  const parts = wildcardPath(req);
  const path = parts.join("/");
  try {
    if (path === "target-managements/toggle-status") {
      const body = (req.body ?? {});
      const id = body?._id || body?.id;
      const enabled = !!(body?.data?.enabled ?? body?.enabled);
      if (!id) return reply.status(400).json({ error: "_id required" });
      await esSearch(`${INDEX.targets}/_update/${id}`, { doc: { enabled } }, "POST");
      return ok(reply, { ok: true, id, enabled });
    }

    if (path === "target-managements") {
      const body = (req.body ?? {});
      const data = body?.data || body;
      const _id = body?._id;
      const alias = data?.personalInfo?.alias || data?.alias;
      const values = data?.targetValue || data?.values || [];
      if (!alias) return reply.status(400).json({ error: "alias required" });
      const now = Math.floor(Date.now() / 1000);
      const by = data.created_by || data.last_modified_by || "spiderx";
      const doc = {
        personalInfo: {
          alias,
          firstName: data.personalInfo?.firstName || data.firstName || "",
          lastName: data.personalInfo?.lastName || data.lastName || "",
          priority: data.personalInfo?.priority || data.priority || "medium",
          description: data.personalInfo?.description || data.description || "",
        },
        targetValue: values,
        enabled: data.enabled !== false,
        capture_action: data.capture_action || ["metadata"],
        activeFrom: data.activeFrom || now,
        activeFromTZ: data.activeFromTZ || new Date().toISOString(),
        validTill: data.validTill || now + 30 * 24 * 3600,
        validTillTZ: data.validTillTZ || new Date(Date.now() + 30 * 86400000).toISOString(),
        created_by: data.created_by || by,
        created_on: data.created_on || now,
        last_modified_by: by,
        last_modified_on: now,
        "@timestamp": Date.now(),
      };
      let id = _id;
      if (_id) {
        await esSearch(`${INDEX.targets}/_update/${_id}`, { doc }, "POST");
      } else {
        const res: any = await esSearch(`${INDEX.targets}/_doc`, doc, "POST");
        id = res._id;
      }
      // sync capture_filter
      await esSearch(`${INDEX.captureFilter}/_doc`, {
        reference_id: id,
        name: alias,
        rule_type: "capture",
        values,
        enabled: doc.enabled,
        created_by: by,
        created_on: now,
        last_modified_by: by,
        last_modified_on: now,
      }, "POST").catch(() => null);
      return ok(reply, { ok: true, id });
    }

    if (path === "target-managements/delete") {
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

    return reply.status(404).json({ error: `Unknown POST /api/v1/${path}` });
  } catch (e) {
    console.error("[api/v1 POST]", path, e);
    return fail(reply, e, 502);
  }
}));

export default router;
