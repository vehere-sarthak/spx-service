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

/** PII reveal — look up deferred/original value for a redacted field. */
router.get("/", asyncHandler(async (req, reply) => {
  try {
    const q = searchParams(req);
    const id = q.get("id") || "";
    const field = q.get("field") || "";
    if (!id || !field) return reply.status(400).json({ status: "FAIL", error: "id and field required" });

    // Try dedicated pii index first, then session/link docs
    const indices = [INDEX.links, "logvehere-pii*", "logvehere-session*"].filter(Boolean);
    for (const index of indices) {
      try {
        const data: any = await esSearch(`${index}/_search`, {
          size: 5,
          query: {
            bool: {
              should: [
                { term: { "session.id.keyword": id } },
                { term: { "session_id.keyword": id } },
                { term: { _id: id } },
                { term: { "id.keyword": id } },
              ],
              minimum_should_match: 1,
            },
          },
        });
        const hits = data.hits?.hits || [];
        for (const h of hits) {
          const src = h._source || {};
          const val =
            src[field] ??
            src?.pii?.[field] ??
            src?.payload?.[field] ??
            src?.original?.[field] ??
            src?.deferred?.[field];
          if (val != null && val !== "") {
            return reply.json({ status: "SUCCESS", response: val, source: index });
          }
        }
      } catch {
        /* next */
      }
    }
    return reply.json({ status: "FAIL", response: null, message: "Value not found" });
  } catch (e) {
    return reply.status(502).json({ status: "FAIL", error: e instanceof Error ? e.message : "pii failed" });
  }
}));

export default router;
