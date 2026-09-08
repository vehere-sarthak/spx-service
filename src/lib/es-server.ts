import https from "https";
import { URL } from "url";
import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { getAppConfig, getEsAuth, getEsPrimaryHost } from "./app-config";

// Cursor / corporate proxies break direct ES access — always bypass for this host.
for (const k of [
  "http_proxy",
  "https_proxy",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "all_proxy",
]) {
  delete process.env[k];
}
process.env.NO_PROXY = "*";
process.env.no_proxy = "*";

function esHostResolved() {
  return getEsPrimaryHost().replace(/\/$/, "");
}
function esUser() {
  return getEsAuth().username;
}
function esPass() {
  return getEsAuth().password;
}
function esRejectUnauthorized() {
  return getEsAuth().rejectUnauthorized === true;
}
const USE_CURL = (process.env.ES_TRANSPORT || "auto").toLowerCase();

/** Prefer dbIndex from spiderx.yml when present. */
function indexFromConfig() {
  const d = getAppConfig().dbIndex || {};
  return {
    alerts: d.alert_index_pattern || "logvehere-alerts-*",
    links: d.link_stats_index || "link-stats-*",
    soi: d.soi_stats_index || "soi-stats-*",
    targets: d.target_managements_index || "target_managements",
    audit: d.auditTrail_index ? `${d.auditTrail_index}*` : "audittrail-*",
    monitor: d.monitoring_index_pattern || "logvehere-monitor-*",
    iface: d.capture_input_identification_index || "udf_iface",
    captureFilter: d.capture_filter_index || "capture_filter",
    frameDumps: d.frame_dumps_index || "frame_dumps-*",
  } as const;
}

export const INDEX = new Proxy({} as ReturnType<typeof indexFromConfig>, {
  get(_t, prop: string) {
    return (indexFromConfig() as any)[prop];
  },
});

export type EsHit<T = Record<string, unknown>> = {
  _id: string;
  _index: string;
  _source: T;
};

function requestViaCurl<T>(method: string, urlStr: string, body?: Record<string, unknown>): T {
  const args = [
    "-sk",
    "--noproxy",
    "*",
    "-u",
    `${esUser()}:${esPass()}`,
    "--max-time",
    "60",
    "-X",
    method,
    "-H",
    "Accept: application/json",
  ];
  if (body) {
    args.push("-H", "Content-Type: application/json", "--data-binary", JSON.stringify(body));
  }
  args.push(urlStr);
  const r = spawnSync("curl", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`curl ES failed (exit ${r.status}): ${(r.stderr || "").slice(0, 200)}`);
  const text = r.stdout || "{}";
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Invalid ES JSON from curl: ${text.slice(0, 200)}`);
  }
  if (json?.error) throw new Error(json.error?.reason || JSON.stringify(json.error));
  return json as T;
}

function requestViaHttps<T>(method: string, urlStr: string, body?: Record<string, unknown>): Promise<T> {
  const url = new URL(urlStr);
  const payload = body ? JSON.stringify(body) : undefined;
  const auth = Buffer.from(`${esUser()}:${esPass()}`).toString("base64");

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method,
        rejectUnauthorized: esRejectUnauthorized(),
        timeout: 60000,
        headers: {
          Authorization: `Basic ${auth}`,
          Accept: "application/json",
          ...(payload
            ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
            : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json: any;
          try {
            json = JSON.parse(text || "{}");
          } catch {
            reject(new Error(`Invalid ES JSON (${res.statusCode}): ${text.slice(0, 200)}`));
            return;
          }
          if ((res.statusCode || 500) >= 400 || json?.error) {
            reject(new Error(json?.error?.reason || `ES HTTP ${res.statusCode}`));
            return;
          }
          resolve(json as T);
        });
      }
    );
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("ES request timeout"));
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

export async function esSearch<T = unknown>(
  indexPath: string,
  body?: Record<string, unknown>,
  method: "GET" | "POST" = "POST"
): Promise<T> {
  const url = `${esHostResolved()}/${indexPath.replace(/^\//, "")}`;
  const preferCurl = USE_CURL === "curl" || USE_CURL === "auto";

  if (USE_CURL === "curl") {
    return requestViaCurl<T>(method, url, body);
  }

  if (preferCurl) {
    try {
      return await requestViaHttps<T>(method, url, body);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/ENETUNREACH|ECONNREFUSED|EHOSTUNREACH|ETIMEDOUT|proxy/i.test(msg)) {
        return requestViaCurl<T>(method, url, body);
      }
      throw e;
    }
  }

  return requestViaHttps<T>(method, url, body);
}

export function totalHits(res: any): number {
  const t = res?.hits?.total;
  if (typeof t === "number") return t;
  return t?.value ?? 0;
}

export function esHost() {
  return esHostResolved();
}

export function readApiCache<T = unknown>(name: string): T | null {
  try {
    const p = path.join(process.cwd(), "data", "es-cache", "api", `${name}.json`);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf8")) as T;
  } catch {
    return null;
  }
}

export type TargetIdentityDto = {
  alias?: string;
  firstName?: string;
  lastName?: string;
  description?: string;
  subject?: string[];
  priority?: string;
  targetValue?: string[];
  captureAction?: string[];
  createdBy?: string;
  lastModifiedBy?: string;
  importName?: string;
  enabled?: boolean;
  activeFrom?: string;
  validTill?: string;
};

/** Normalise the target document an alert carries into console-facing identity. */
export function mapTarget(raw: any): TargetIdentityDto | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const asList = (v: unknown) =>
    Array.isArray(v) ? v.map(String).filter(Boolean) : v ? [String(v)] : undefined;
  const info = raw.personalInfo || {};
  const out: TargetIdentityDto = {
    alias: info.alias || undefined,
    firstName: info.firstName || undefined,
    lastName: info.lastName || undefined,
    description: info.description || undefined,
    subject: asList(raw.interceptionCriteria?.subject),
    priority: info.priority || undefined,
    targetValue: asList(raw.targetValue),
    captureAction: asList(raw.capture_action),
    createdBy: raw.created_by || undefined,
    lastModifiedBy: raw.last_modified_by || undefined,
    importName: raw.importName || undefined,
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : undefined,
    // The *TZ twins are already ISO; the bare fields are epoch seconds.
    activeFrom: raw.activeFromTZ || epochToIso(raw.activeFrom),
    validTill: raw.validTillTZ || epochToIso(raw.validTill),
  };
  return Object.values(out).some((v) => v != null) ? out : undefined;
}

function epochToIso(v: unknown): string | undefined {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  // Target documents store seconds; alerts occasionally carry millis.
  return new Date(n > 1e12 ? n : n * 1000).toISOString();
}

export type DetectionDto = {
  id: string;
  index?: string;
  title: string;
  severity: "critical" | "high" | "medium" | "low" | "info";
  stage: "recon" | "delivery" | "exploit" | "install" | "c2" | "actions";
  src: string;
  dst: string;
  host: string;
  protocol: string;
  mitre: string;
  ts: string;
  confidence: number;
  /** Byte volume, when the alert document carries one. */
  bytes: number;
  /** Raw `hit_count` from the alert document — a count, not a byte size. */
  hit_count: number;
  status: "open" | "investigating" | "contained";
  value?: string;
  alert_type?: string;
  link_name?: string;
  probe_host_name?: string;
  probe_ip?: string;
  flagged?: boolean;
  tags?: { name: string; color?: string }[];
  session_id?: string;
  target?: TargetIdentityDto;
};

export function mapAlert(hit: EsHit<any>): DetectionDto {
  const s = hit._source || {};
  const priority = String(s.priority || "info").toLowerCase();
  const severity = (["critical", "high", "medium", "low", "info"].includes(priority)
    ? priority
    : "info") as DetectionDto["severity"];
  const tags = Array.isArray(s.tags)
    ? s.tags.map((t: any) => (typeof t === "string" ? { name: t } : { name: t.name, color: t.color }))
    : [];

  return {
    id: hit._id,
    index: hit._index,
    title: s.alert_name || s.value || "Alert",
    severity,
    stage: "actions",
    src: s.value || "-",
    dst: s.link_name || "-",
    host: s.probe_host_name || "-",
    protocol: s.type || s.alert_type || "-",
    mitre: s.mitre_technique || s.mitre || "-",
    ts: s["@timestamp"],
    confidence: Number(s.confidence || s.score || 0),
    bytes: Number(s.bytes ?? s.total_bytes ?? 0),
    hit_count: Number(s.hit_count || 0),
    status: s.acknowledged_by ? "investigating" : "open",
    value: s.value,
    alert_type: s.alert_type,
    link_name: s.link_name,
    probe_host_name: s.probe_host_name,
    probe_ip: s.probe_ip,
    flagged: !!s.important_flag,
    tags,
    session_id: s.session_id || s.sess_id || s.flow_id,
    target: mapTarget(s.target),
  };
}

export type LinkSignal = { key: string; band: "encap" | "protocol"; field: string };

let signalCache: { at: number; signals: LinkSignal[] } | null = null;

/**
 * Counter sub-fields present on link-stats (`encapsulations_count.TCP`, …).
 * Read from the mapping so a probe build that adds a protocol shows up without
 * a code change; capped so the spectrum aggregation stays one cheap request.
 */
export async function linkSignals(limit = 30): Promise<LinkSignal[]> {
  if (signalCache && Date.now() - signalCache.at < 300_000) return signalCache.signals;

  const bands: { parent: string; band: LinkSignal["band"] }[] = [
    { parent: "encapsulations_count", band: "encap" },
    { parent: "protocols_count", band: "protocol" },
  ];
  const seen = new Map<string, LinkSignal>();
  try {
    const mapping: any = await esSearch(`${INDEX.links}/_mapping`, undefined, "GET");
    // A wildcard pattern answers with one entry per concrete index; union them
    // so a protocol seen on any day of the window still gets a row.
    for (const entry of Object.values(mapping || {}) as any[]) {
      const props = entry?.mappings?.properties || {};
      for (const { parent, band } of bands) {
        for (const key of Object.keys(props[parent]?.properties || {})) {
          const field = `${parent}.${key}`;
          if (!seen.has(field)) seen.set(field, { key, band, field });
        }
      }
    }
  } catch {
    /* fall through to the built-in list */
  }

  if (seen.size === 0) {
    for (const key of ["ETH", "IPV4", "IPV6", "TCP", "UDP", "ARP", "ICMP", "OSPF"]) {
      seen.set(`encapsulations_count.${key}`, { key, band: "encap", field: `encapsulations_count.${key}` });
    }
    for (const key of ["DNS", "HTTP", "HTTPS", "SSH", "SSL", "QUIC", "RTP", "NTP"]) {
      seen.set(`protocols_count.${key}`, { key, band: "protocol", field: `protocols_count.${key}` });
    }
  }

  const signals = [...seen.values()].slice(0, limit);
  signalCache = { at: Date.now(), signals };
  return signals;
}
