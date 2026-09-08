import { Router } from "express";
import type { Response } from "express";
import { asyncHandler, searchParams, wildcardPath, fail } from "../lib/http";

const router = Router();

function ok(reply: Response, data: unknown) {
  return reply.json(data);
}

import * as fs from "fs";
import * as os from "os";
import { INDEX, esHost, esSearch } from "../lib/es-server";
import { sql } from "../lib/mysql";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PRODUCT_NAME_FALLBACK = "Vehere Spider-X";
const ENTITLEMENT_NOT_TRACKED = "Not Available";

function readJsonSafe(path?: string) {
  if (!path) return null;
  try {
    return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function parseThroughput(prodCode?: string) {
  if (!prodCode) return "10 Gbps";
  const m = String(prodCode).match(/(\d+)\s*g/i);
  if (m) return `${m[1]} Gbps`;
  return "10 Gbps";
}

function parseLicenseDates(prodCode?: string, daysToExpire?: number | string) {
  // Best-effort; license schema varies. Keep displayable values.
  const end =
    daysToExpire === "LIFETIME"
      ? "LIFETIME"
      : typeof daysToExpire === "number"
        ? new Date(Date.now() + daysToExpire * 86400000).toISOString().slice(0, 10)
        : "-";
  return { start: "-", end };
}

router.get("/", asyncHandler(async (req, reply) => {
  try {
    const licensePath = process.env.LICENSE_FILE_PATH || "";
    const metaPath = process.env.BUILD_GLOBAL_META_PATH || "";
    const aboutConfigPath = process.env.ABOUT_CONFIG_PATH || "";

    const licenseRaw = readJsonSafe(licensePath);
    const metadata = readJsonSafe(metaPath);
    const aboutCfg = readJsonSafe(aboutConfigPath);

    const [es, users, roles, spx, ifaces] = await Promise.all([
      esSearch<any>("", undefined, "GET").catch(() => null),
      sql<{ c: number }>("SELECT COUNT(*) c FROM users").catch(() => [{ c: 0 }]),
      sql<{ c: number }>("SELECT COUNT(*) c FROM roles").catch(() => [{ c: 0 }]),
      sql<{ c: number }>("SELECT COUNT(*) c FROM spx_management").catch(() => [{ c: 0 }]),
      esSearch(INDEX.iface + "/_count", undefined, "GET").catch(() => ({ count: 0 })),
    ]);

    const productDetails = {
      name: metadata?.product?.name || null,
      version: metadata?.product?.version?.split?.("-")?.[0] || process.env.SPIDERX_VERSION || "0.1.0",
      build_no:
        metadata?.product?.version?.split?.("-")?.[1] ||
        metadata?.product?.build_no ||
        process.env.SPIDERX_BUILD ||
        process.env.npm_package_version ||
        "dev",
      buildDate: metadata?.product?.buildDate || null,
      model: metadata?.product?.model || os.cpus()?.[0]?.model || null,
      deploymentMode: metadata?.product?.deploymentMode || null,
    };

    const daysToExpire =
      licenseRaw?.daysToExpire ??
      licenseRaw?.licenseData?.daysToExpire ??
      (licenseRaw ? "LIFETIME" : undefined);

    const serialKey = licenseRaw?.serialKey || licenseRaw?.licenseData?.serialKey || "-";
    const email = licenseRaw?.licenseData?.info?.email || licenseRaw?.info?.email || "-";
    const prodCode = licenseRaw?.licenseData?.prodCode || licenseRaw?.prodCode || "";
    const throughput = licenseRaw?.throughput || parseThroughput(prodCode);
    const dates = parseLicenseDates(prodCode, daysToExpire);

    const subscriptionStatus =
      daysToExpire === "LIFETIME" || (typeof daysToExpire === "number" && daysToExpire > 0)
        ? "Active"
        : daysToExpire !== undefined
          ? "Expired"
          : "-";

    const hostname =
      aboutCfg?.networkConfig?.hostname ||
      aboutCfg?.hostname ||
      os.hostname() ||
      process.env.HOSTNAME ||
      "spiderx-console";

    const managementIp =
      aboutCfg?.networkConfig?.ipv4_conf?.ipv4_ip_address ||
      aboutCfg?.ipv4_ip_address ||
      "-";

    let serialNumber = "-";
    let uptime = "-";
    try {
      uptime = `${Math.floor(os.uptime() / 3600)}h ${Math.floor((os.uptime() % 3600) / 60)}m`;
    } catch {
      /* ignore */
    }
    try {
      if (fs.existsSync("/sys/class/dmi/id/product_serial")) {
        serialNumber = fs.readFileSync("/sys/class/dmi/id/product_serial", "utf8").trim() || "-";
      }
    } catch {
      /* ignore */
    }

    return reply.json({
      productName: productDetails.name || PRODUCT_NAME_FALLBACK,
      productDetails,
      license: {
        status: subscriptionStatus,
        capacity: throughput,
        licensedTo: email,
        licenseKey: serialKey,
        installationDate: licenseRaw?.licenseStartDate || dates.start,
        expiryDate: licenseRaw?.licenseEndDate || dates.end,
        daysToExpire:
          daysToExpire === "LIFETIME"
            ? "LIFETIME"
            : typeof daysToExpire === "number"
              ? `${daysToExpire} day${daysToExpire === 1 ? "" : "s"}`
              : "-",
        prodCode: prodCode || "-",
      },
      entitlement: {
        subscriptionStatus,
        autoRenewal: ENTITLEMENT_NOT_TRACKED,
        softwareUpdates: ENTITLEMENT_NOT_TRACKED,
        technicalSupport: ENTITLEMENT_NOT_TRACKED,
      },
      software: {
        version: productDetails.version,
        build: productDetails.build_no,
        releaseDate: productDetails.buildDate || "-",
      },
      system: {
        hostname,
        model: productDetails.model || "-",
        serialNumber,
        deploymentMode: productDetails.deploymentMode || "-",
        managementIp,
        uptime,
      },
      // Extra ops context for SpiderX console
      environment: {
        elasticsearch: es
          ? {
              ok: true,
              host: esHost(),
              cluster: es.cluster_name,
              name: es.name,
              version: es.version?.number,
            }
          : { ok: false, host: esHost() },
        mysql: {
          host: process.env.MYSQL_HOST || "127.0.0.1",
          database: process.env.MYSQL_DATABASE || "ui_db",
          users: users[0]?.c || 0,
          roles: roles[0]?.c || 0,
          appliances: spx[0]?.c || 0,
        },
        capture_ifaces: (ifaces as any)?.count ?? 0,
      },
    });
  } catch (e) {
    return reply.status(502).json({ error: e instanceof Error ? e.message : "about failed" });
  }
}));

export default router;
