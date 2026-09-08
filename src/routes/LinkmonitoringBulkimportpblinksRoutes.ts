import { Router } from "express";
import type { Response } from "express";
import { asyncHandler, searchParams, wildcardPath, fail } from "../lib/http";

const router = Router();

function ok(reply: Response, data: unknown) {
  return reply.json(data);
}

import { INDEX, esSearch } from "../lib/es-server";
import { nowEpochSec } from "../lib/api-utils";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Bulk import capture-input records (Link Survey / PB rows). */
router.post("/", asyncHandler(async (req, reply) => {
  try {
    const body = (req.body ?? {});
    const pb = body?.data?.pbData || body?.pbData || {};
    let rows: any[] = [];
    const raw = body?.data?.linkRows ?? body?.linkRows ?? body?.rows;
    if (typeof raw === "string") {
      try {
        rows = JSON.parse(raw);
      } catch {
        rows = [];
      }
    } else if (Array.isArray(raw)) {
      rows = raw;
    }
    if (!rows.length) {
      return reply.json({
        success: true,
        ok: true,
        inserted: 0,
        ids: [],
        pbData: pb,
        message: "No link rows; PB survey config acknowledged.",
      });
    }

    const now = nowEpochSec();
    const by = String(body.created_by || "spiderx");
    const inserted: string[] = [];
    const errors: string[] = [];

    for (const row of rows) {
      try {
        const name = String(row.title || row.name || "").trim();
        const value = String(row.value || row.vlan || "").trim();
        if (!name || !value) {
          errors.push(`skip: missing title/value (${JSON.stringify(row)})`);
          continue;
        }
        const typeKey = String(row.type || "vlan_id").toLowerCase();
        const cap =
          typeKey.includes("mac") ? "mac" : typeKey.includes("mpls") ? "mpls" : typeKey.includes("iface") ? "iface" : "vlan_id";
        const typeLabel =
          cap === "mac" ? "MAC" : cap === "mpls" ? "MPLS" : cap === "iface" ? "IFACE" : "VLAN ID";
        const doc: any = {
          name,
          type: typeLabel,
          [cap]: [value],
          groupName: row.groupName || undefined,
          pbIP: pb.pbIP || row.pbIP,
          pbPort: pb.pbPort || row.pbPort,
          pbType: pb.pbType || row.pbType || "ixia",
          pbDeviceName: pb.pbDeviceName || row.pbDeviceName,
          pbUsername: pb.pbUsername,
          created_by: by,
          created_on: now,
          last_modified_by: by,
          last_modified_on: now,
          import_source: "link_survey",
        };
        const res: any = await esSearch(`${INDEX.iface}/_doc`, doc, "POST");
        inserted.push(res._id);
      } catch (e) {
        errors.push(e instanceof Error ? e.message : "row failed");
      }
    }

    return reply.json({
      success: true,
      ok: true,
      inserted: inserted.length,
      ids: inserted,
      details: errors.length ? Buffer.from(errors.join("\n")).toString("base64") : undefined,
      message: `Imported ${inserted.length} of ${rows.length} row(s).`,
    });
  } catch (e) {
    return reply.status(502).json({ error: e instanceof Error ? e.message : "import failed" });
  }
}));

export default router;
