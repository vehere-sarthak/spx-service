import { Router } from "express";
import type { Response } from "express";
import { asyncHandler, searchParams, wildcardPath, fail } from "../lib/http";

const router = Router();

function ok(reply: Response, data: unknown) {
  return reply.json(data);
}


export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Proxy PCAP download from probe reconstruction service. */
router.get("/", asyncHandler(async (req, reply) => {
  try {
    const q = searchParams(req);
    const probeIp = q.get("probe_ip") || "";
    const sessionId = q.get("session_id") || "";
    const id = q.get("id") || sessionId;
    if (!probeIp || !sessionId) {
      return reply.status(400).json({ error: "probe_ip and session_id required" });
    }
    // Common vehere path pattern; try a few variants
    const candidates = [
      `https://${probeIp}:8082/api/v1/reconstruction/getfiles/${sessionId}.zip`,
      `http://${probeIp}:8082/api/v1/reconstruction/getfiles/${sessionId}.zip`,
      `https://${probeIp}:8082/api/v1/reconstruction/getpcapfile/0/0/0/0/m/0/${sessionId}/${id}.pcap`,
      `http://${probeIp}:8082/api/v1/reconstruction/getpcapfile/0/0/0/0/m/0/${sessionId}/${id}.pcap`,
    ];
    for (const url of candidates) {
      try {
        const res = await fetch(url, {
          signal: AbortSignal.timeout(12000),
          // @ts-expect-error Node fetch accepts rejectUnauthorized; it is absent from the DOM RequestInit type
          rejectUnauthorized: false,
        });
        if (res.ok) {
          const buf = Buffer.from(await res.arrayBuffer());
          const ctype = res.headers.get("content-type") || "application/octet-stream";
          const name = url.endsWith(".zip") ? `${sessionId}.zip` : `${sessionId}.pcap`;
          reply.setHeader("Content-Type", ctype);
          reply.setHeader("Content-Disposition", `attachment; filename="${name}"`);
          return reply.send(buf);
        }
      } catch {
        /* try next */
      }
    }
    return reply.status(404).json({
        error: "PCAP not available from probe",
        hint: "Reconstruction may still be processing, or probe API is unreachable from SpiderX.",
      });
  } catch (e) {
    return reply.status(502).json({ error: e instanceof Error ? e.message : "pcap failed" });
  }
}));

export default router;
