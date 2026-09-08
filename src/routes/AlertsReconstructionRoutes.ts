import { Router } from "express";
import type { Response } from "express";
import { asyncHandler, searchParams, wildcardPath, fail } from "../lib/http";

const router = Router();

function ok(reply: Response, data: unknown) {
  return reply.json(data);
}

import { INDEX, esSearch } from "../lib/es-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Reconstruction / session PCAP helpers.
 * 1) Loads alert from ES
 * 2) Best-effort proxy to probe reconstruction API (vehere-ui parity)
 * 3) Falls back to session metadata + hex dump fields when present on the alert
 */
router.get("/", asyncHandler(async (req, reply) => {
  try {
    const q = searchParams(req);
    const id = q.get("id") || "";
    const index = q.get("index") || INDEX.alerts;
    if (!id) return reply.status(400).json({ error: "id required" });

    const doc: any = await esSearch(`${index}/_doc/${id}`, undefined, "GET");
    if (!doc?._source) return reply.status(404).json({ error: "alert not found" });
    const src = doc._source;
    const probeIp = src.probe_ip || src.probeIp || "";
    const sessionId = src.session_id || src.sess_id || src.flow_id || id;
    const hex =
      src.hexdump ||
      src.hex ||
      src.payload_hex ||
      src.frame_hex ||
      null;

    let reconstruction: any = null;
    if (probeIp) {
      try {
        const ctrl = AbortSignal.timeout(8000);
        const res = await fetch(`https://${probeIp}:8082/api/v1/reconstruction/checkdata`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            row_data: { _id: id, _index: index, _source: src },
            id,
            recon_folder: id,
            probe_ip: probeIp,
            type: "m",
            start_time: src["@timestamp"],
            archive: "N",
          }),
          // @ts-expect-error Node fetch accepts rejectUnauthorized; it is absent from the DOM RequestInit type
          rejectUnauthorized: false,
          signal: ctrl,
        }).catch(() =>
          fetch(`http://${probeIp}:8082/api/v1/reconstruction/checkdata`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              row_data: { _id: id, _index: index, _source: src },
              id,
              recon_folder: id,
              probe_ip: probeIp,
              type: "m",
              start_time: src["@timestamp"],
              archive: "N",
            }),
            signal: ctrl,
          })
        );
        if (res) reconstruction = await res.json().catch(() => ({ status: res.status }));
      } catch (e) {
        reconstruction = { error: e instanceof Error ? e.message : "probe unreachable" };
      }
    }

    const pcapUrl =
      probeIp && sessionId
        ? `/api/v1/alerts/reconstruction/pcap?probe_ip=${encodeURIComponent(probeIp)}&session_id=${encodeURIComponent(
            String(sessionId)
          )}&id=${encodeURIComponent(id)}`
        : null;

    return reply.json({
      id,
      index,
      probe_ip: probeIp || null,
      session_id: sessionId,
      src_ip: src.src_ip || src.source_ip || src.value,
      dst_ip: src.dst_ip || src.dest_ip || src.link_name,
      hex,
      reconstruction,
      pcapUrl,
      fields: {
        alert_name: src.alert_name,
        type: src.type,
        alert_type: src.alert_type,
        link_name: src.link_name,
        probe_host_name: src.probe_host_name,
        "@timestamp": src["@timestamp"],
      },
    });
  } catch (e) {
    return reply.status(502).json({ error: e instanceof Error ? e.message : "reconstruction failed" });
  }
}));

export default router;
