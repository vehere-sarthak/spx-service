import { Router } from "express";
import type { Response } from "express";
import { asyncHandler, searchParams, wildcardPath, fail } from "../lib/http";

const router = Router();

function ok(reply: Response, data: unknown) {
  return reply.json(data);
}

import { INDEX, buildTargetDoc, esSearch, listTargets, syncCaptureFilter } from "../lib/targets";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

router.get("/", asyncHandler(async (req, reply) => {
  try {
    const data = await listTargets(searchParams(req));
    return reply.json(data);
  } catch (e) {
    return reply.status(502).json({ error: e instanceof Error ? e.message : "list failed" });
  }
}));

router.post("/", asyncHandler(async (req, reply) => {
  try {
    const body = (req.body ?? {});
    const data = body?.data || body;
    const by = String(data.created_by || data.last_modified_by || "spiderx");
    const alias = data?.personalInfo?.alias || data?.alias;
    if (!alias) return reply.status(400).json({ error: "alias required" });
    const doc = buildTargetDoc(data, by);
    const res: any = await esSearch(`${INDEX.targets}/_doc`, doc, "POST");
    const id = res._id;
    await syncCaptureFilter(id, doc, by).catch(() => null);
    return reply.json({ ok: true, success: true, id, _id: id });
  } catch (e) {
    return reply.status(502).json({ error: e instanceof Error ? e.message : "create failed" });
  }
}));

router.put("/", asyncHandler(async (req, reply) => {
  try {
    const body = (req.body ?? {});
    const data = body?.data || body;
    const id = body?._id || data?.id;
    if (!id) return reply.status(400).json({ error: "_id required" });
    const by = String(data.last_modified_by || data.created_by || "spiderx");
    const existingRes: any = await esSearch(`${INDEX.targets}/_doc/${id}`, undefined, "GET");
    const existing = existingRes._source || {};
    const doc = buildTargetDoc(data, by, existing);
    await esSearch(`${INDEX.targets}/_update/${id}`, { doc }, "POST");
    await syncCaptureFilter(id, doc, by).catch(() => null);
    return reply.json({ ok: true, success: true, id, _id: id });
  } catch (e) {
    return reply.status(502).json({ error: e instanceof Error ? e.message : "update failed" });
  }
}));

router.delete("/", asyncHandler(async (req, reply) => {
  try {
    const body = (req.body ?? {}).catch(() => ({}));
    const ids: string[] = body?.ids || [];
    if (!ids.length) {
      // filter-based delete
      const q = new URLSearchParams();
      if (body?.query) q.set("query", body.query);
      if (body?.status) q.set("status", body.status);
      if (body?.priority) q.set("priority", body.priority);
      const listed = await listTargets(q);
      const allIds = (listed.items || []).map((t: any) => t.id);
      if (!allIds.length) return reply.json({ ok: true, deleted: 0 });
      await esSearch(`${INDEX.targets}/_delete_by_query`, { query: { ids: { values: allIds } } }, "POST");
      await esSearch(
        `${INDEX.captureFilter}/_delete_by_query`,
        { query: { terms: { "reference_id.keyword": allIds } } },
        "POST"
      ).catch(() => null);
      return reply.json({ ok: true, success: true, deleted: allIds.length });
    }
    await esSearch(`${INDEX.targets}/_delete_by_query`, { query: { ids: { values: ids } } }, "POST");
    await esSearch(
      `${INDEX.captureFilter}/_delete_by_query`,
      { query: { terms: { "reference_id.keyword": ids } } },
      "POST"
    ).catch(() => null);
    return reply.json({ ok: true, success: true, deleted: ids.length });
  } catch (e) {
    return reply.status(502).json({ error: e instanceof Error ? e.message : "delete failed" });
  }
}));

export default router;
