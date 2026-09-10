import { Router } from "express";
import { asyncHandler, searchParams } from "../lib/http";
import { INDEX, esSearch, mapAlert, totalHits } from "../lib/es-server";
import { parseTimeParam, pickInterval, resolveBoundMs } from "../lib/api-utils";

const router = Router();

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PRIORITY_RANK = ["critical", "high", "medium", "low", "info"];

/** Highest priority present in a `priority.keyword` sub-aggregation. */
function worstPriority(buckets: { key: string }[] | undefined) {
  const seen = new Set((buckets || []).map((b) => String(b.key).toLowerCase()));
  return PRIORITY_RANK.find((p) => seen.has(p)) || "info";
}

function firstKey(agg: any, fallback = "") {
  return agg?.buckets?.[0]?.key != null ? String(agg.buckets[0].key) : fallback;
}

function termCounts(agg: any) {
  return (agg?.buckets || []).map((b: any) => ({ key: String(b.key), count: b.doc_count }));
}

/**
 * Which of the four possible states a tap is in. The whole point of the fabric
 * is that `dark` and `blind` are invisible in any single index: only the join
 * of link-stats against soi-stats can tell "carrying traffic but matching
 * nothing" apart from "matching, but the stats agent stopped reporting".
 */
function linkState(carried: number, matched: number) {
  if (carried > 0 && matched > 0) return "live";
  if (carried > 0) return "dark";
  if (matched > 0) return "blind";
  return "silent";
}

/**
 * The interception fabric: probe -> link -> subject, joined on `link_name`.
 *
 * `link_name` is the one field the three stat indices agree on — link-stats
 * counts what the tap carried, soi-stats counts what the selectors matched on
 * it, and logvehere-alerts names the subject that surfaced. Joining them here
 * is what turns three separate volume charts into one causal chain.
 */
router.get("/", asyncHandler(async (req, reply) => {
  const q = searchParams(req);
  const startTime = parseTimeParam(q.get("startTime"), "now-7d");
  const endTime = parseTimeParam(q.get("endTime"), "now");
  const inRange = { range: { "@timestamp": { gte: startTime, lte: endTime } } };
  const { interval } = pickInterval(startTime, endTime, 32);
  const windowEndMs = resolveBoundMs(endTime, Date.now());
  const windowStartMs = resolveBoundMs(startTime, windowEndMs - 7 * 86_400_000);
  const bounds = { min: windowStartMs, max: windowEndMs };

  const TOP_LINKS = 12;
  const TOP_SUBJECTS = 8;

  try {
    const [wire, soi, byLink, bySubject] = await Promise.all([
      // What each tap carried.
      esSearch(INDEX.links + "/_search", {
        size: 0,
        query: inRange,
        aggs: {
          links: {
            terms: { field: "link_name.keyword", size: TOP_LINKS, order: { bytes: "desc" } },
            aggs: {
              bytes: { sum: { field: "total_bytes" } },
              packets: { sum: { field: "total_packets" } },
              probe: { terms: { field: "probe_host_name.keyword", size: 1 } },
              probe_ip: { terms: { field: "probe_ip.keyword", size: 1 } },
              iface: { terms: { field: "iface_names.keyword", size: 1 } },
              protocols: { terms: { field: "protocols.keyword", size: 4 } },
              throughput: {
                date_histogram: {
                  field: "@timestamp",
                  fixed_interval: interval,
                  min_doc_count: 0,
                  extended_bounds: bounds,
                },
                aggs: { bytes: { sum: { field: "total_bytes" } } },
              },
            },
          },
        },
      }),
      // What the selectors matched on each tap.
      esSearch(INDEX.soi + "/_search", {
        size: 0,
        track_total_hits: true,
        query: inRange,
        aggs: {
          links: {
            terms: { field: "link_name.keyword", size: TOP_LINKS },
            aggs: {
              hits: { sum: { field: "hit_count" } },
              refs: { cardinality: { field: "ref_id.keyword" } },
              types: { terms: { field: "type.keyword", size: 4 } },
              spark: {
                date_histogram: {
                  field: "@timestamp",
                  fixed_interval: interval,
                  min_doc_count: 0,
                  extended_bounds: bounds,
                },
                aggs: { hits: { sum: { field: "hit_count" } } },
              },
            },
          },
        },
      }),
      // What surfaced to the analyst, per tap — and which subjects it named.
      esSearch(INDEX.alerts + "/_search", {
        size: 0,
        query: inRange,
        aggs: {
          links: {
            terms: { field: "link_name.keyword", size: TOP_LINKS },
            aggs: {
              by_priority: { terms: { field: "priority.keyword", size: 6 } },
              aliases: { cardinality: { field: "target.personalInfo.alias.keyword" } },
              selectors: { cardinality: { field: "value.keyword" } },
              // Ribbon weights for the link -> subject tier.
              top_aliases: { terms: { field: "target.personalInfo.alias.keyword", size: TOP_SUBJECTS * 3 } },
            },
          },
        },
      }),
      // The subject tier itself.
      esSearch(INDEX.alerts + "/_search", {
        size: 0,
        track_total_hits: true,
        query: inRange,
        aggs: {
          total_subjects: { cardinality: { field: "target.personalInfo.alias.keyword" } },
          subjects: {
            terms: { field: "target.personalInfo.alias.keyword", size: TOP_SUBJECTS },
            aggs: {
              subject: { terms: { field: "target.interceptionCriteria.subject.keyword", size: 1 } },
              by_priority: { terms: { field: "priority.keyword", size: 6 } },
              links: { terms: { field: "link_name.keyword", size: TOP_LINKS } },
              selectors: { terms: { field: "value.keyword", size: 3 } },
              latest: { top_hits: { size: 1, sort: [{ "@timestamp": "desc" }] } },
            },
          },
        },
      }),
    ]);

    const wireBuckets = (wire as any).aggregations?.links?.buckets || [];
    const soiBuckets = (soi as any).aggregations?.links?.buckets || [];
    const alertBuckets = (byLink as any).aggregations?.links?.buckets || [];
    const subjectBuckets = (bySubject as any).aggregations?.subjects?.buckets || [];

    const soiByLink = new Map<string, any>(soiBuckets.map((b: any) => [String(b.key), b]));
    const alertsByLink = new Map<string, any>(alertBuckets.map((b: any) => [String(b.key), b]));

    // A tap that only ever appears in soi-stats is exactly the `blind` case the
    // state machine exists to surface, so union the key sets rather than
    // iterating link-stats alone.
    const linkKeys = [...new Set<string>([
      ...wireBuckets.map((b: any) => String(b.key)),
      ...soiBuckets.map((b: any) => String(b.key)),
    ])];

    const timeline: string[] =
      (wireBuckets[0]?.throughput?.buckets || soiBuckets[0]?.spark?.buckets || []).map(
        (b: any) => b.key_as_string
      );

    const keptSubjects = new Set<string>(subjectBuckets.map((b: any) => String(b.key)));

    const links = linkKeys
      .map((key) => {
        const w = wireBuckets.find((b: any) => String(b.key) === key);
        const s = soiByLink.get(key);
        const a = alertsByLink.get(key);
        const bytes = Math.round(w?.bytes?.value || 0);
        const hits = Math.round(s?.hits?.value || 0);
        return {
          key,
          iface: firstKey(w?.iface) || key.split("_").slice(1).join("_"),
          probe: firstKey(w?.probe) || "unknown",
          probeIp: firstKey(w?.probe_ip),
          bytes,
          packets: Math.round(w?.packets?.value || 0),
          statDocs: w?.doc_count || 0,
          soiDocs: s?.doc_count || 0,
          hits,
          refs: s?.refs?.value || 0,
          alerts: a?.doc_count || 0,
          subjects: a?.aliases?.value || 0,
          selectors: a?.selectors?.value || 0,
          worst: worstPriority(a?.by_priority?.buckets),
          protocols: termCounts(w?.protocols).map((p: { key: string }) => p.key),
          types: termCounts(s?.types).map((t: { key: string }) => t.key),
          // Detection density: matched hits per GB carried. The number that says
          // whether a tap is earning its capacity.
          yield: bytes > 0 ? hits / (bytes / 1_073_741_824) : 0,
          state: linkState(bytes, hits),
          spark: (s?.spark?.buckets || []).map((b: any) => Math.round(b.hits?.value || 0)),
          throughput: (w?.throughput?.buckets || []).map((b: any) => Math.round(b.bytes?.value || 0)),
        };
      })
      .sort((x, y) => y.bytes - x.bytes || y.hits - x.hits);

    // Probe tier: rolled up from the taps it owns, so the two tiers can never
    // disagree about a total.
    const probeMap = new Map<string, any>();
    for (const l of links) {
      const p = probeMap.get(l.probe) || {
        key: l.probe,
        ip: l.probeIp,
        links: 0,
        bytes: 0,
        packets: 0,
        hits: 0,
        alerts: 0,
        dark: 0,
      };
      p.ip = p.ip || l.probeIp;
      p.links += 1;
      p.bytes += l.bytes;
      p.packets += l.packets;
      p.hits += l.hits;
      p.alerts += l.alerts;
      if (l.state === "dark" || l.state === "blind") p.dark += 1;
      probeMap.set(l.probe, p);
    }
    const probes = [...probeMap.values()].sort((a, b) => b.bytes - a.bytes);

    const subjects = subjectBuckets.map((b: any) => {
      const hit = b.latest?.hits?.hits?.[0];
      return {
        alias: String(b.key),
        subject: firstKey(b.subject) || null,
        priority: worstPriority(b.by_priority?.buckets),
        alerts: b.doc_count,
        selectors: termCounts(b.selectors).map((s: { key: string }) => s.key),
        links: termCounts(b.links).map((l: { key: string }) => l.key),
        latest: hit ? mapAlert(hit) : null,
      };
    });

    // Ribbons. Probe -> link is weighted by what the wire carried; link ->
    // subject by what actually surfaced, so the two halves of the fabric read as
    // capacity on the left and yield on the right.
    const probeLink = links.map((l) => ({ from: l.probe, to: l.key, weight: l.bytes || l.hits }));
    const linkSubject: { from: string; to: string; weight: number; tone: string }[] = [];
    for (const l of links) {
      const a = alertsByLink.get(l.key);
      for (const t of a?.top_aliases?.buckets || []) {
        const alias = String(t.key);
        if (!keptSubjects.has(alias)) continue;
        linkSubject.push({
          from: l.key,
          to: alias,
          weight: t.doc_count,
          tone: subjects.find((s: { alias: string }) => s.alias === alias)?.priority || "info",
        });
      }
    }

    const totalSubjects = (bySubject as any).aggregations?.total_subjects?.value || 0;

    return reply.json({
      interval,
      timeline,
      probes,
      links,
      subjects,
      edges: { probeLink, linkSubject },
      totals: {
        carried: links.reduce((n, l) => n + l.bytes, 0),
        packets: links.reduce((n, l) => n + l.packets, 0),
        matched: links.reduce((n, l) => n + l.hits, 0),
        surfaced: totalHits(bySubject),
        soiDocs: totalHits(soi),
        subjects: totalSubjects,
        shownSubjects: subjects.length,
        taps: links.length,
        degraded: links.filter((l) => l.state === "dark" || l.state === "blind").length,
      },
    });
  } catch (e) {
    return reply.status(502).json({ error: e instanceof Error ? e.message : "fabric failed" });
  }
}));

export default router;
