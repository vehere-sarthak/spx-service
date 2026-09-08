import { createHash } from "crypto";

export function md5(text: string) {
  return createHash("md5").update(text).digest("hex");
}

export function nowEpochSec() {
  return Math.floor(Date.now() / 1000);
}

/** Parse UI time params: ISO, epoch ms/sec, or ES date math like now-7d */
export function parseTimeParam(value: string | null | undefined, fallback: string): string {
  if (!value || !value.trim()) return fallback;
  const v = value.trim();
  if (/^now/i.test(v)) return v;
  if (/^\d{13}$/.test(v)) return new Date(Number(v)).toISOString();
  if (/^\d{10}$/.test(v)) return new Date(Number(v) * 1000).toISOString();
  const d = new Date(v);
  if (!Number.isNaN(d.getTime())) return d.toISOString();
  return fallback;
}

export function pageParams(q: URLSearchParams, defaultSize = 25) {
  const page = Math.max(0, parseInt(q.get("page") || "0", 10) || 0);
  const pageSize = Math.min(500, Math.max(1, parseInt(q.get("pageSize") || String(defaultSize), 10) || defaultSize));
  return { page, pageSize, from: page * pageSize };
}

const DATE_MATH_UNIT_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
  M: 2_592_000_000,
};

/**
 * Epoch-ms value of an ES bound (`now-7d`, ISO, epoch) — used only to size
 * histogram buckets, so the month approximation in the table above is fine.
 */
export function resolveBoundMs(value: string | null | undefined, fallback: number): number {
  const v = (value || "").trim();
  if (!v) return fallback;
  const m = /^now(?:([+-])(\d+)([smhdwM]))?(?:\/[smhdwM])?$/.exec(v);
  if (m) {
    if (!m[1]) return Date.now();
    const delta = Number(m[2]) * (DATE_MATH_UNIT_MS[m[3]] || 0);
    return Date.now() + (m[1] === "-" ? -delta : delta);
  }
  const t = Date.parse(v);
  return Number.isNaN(t) ? fallback : t;
}

const INTERVAL_LADDER: { id: string; ms: number }[] = [
  { id: "1m", ms: 60_000 },
  { id: "5m", ms: 300_000 },
  { id: "10m", ms: 600_000 },
  { id: "15m", ms: 900_000 },
  { id: "30m", ms: 1_800_000 },
  { id: "1h", ms: 3_600_000 },
  { id: "2h", ms: 7_200_000 },
  { id: "3h", ms: 10_800_000 },
  { id: "6h", ms: 21_600_000 },
  { id: "12h", ms: 43_200_000 },
  { id: "24h", ms: 86_400_000 },
  { id: "48h", ms: 172_800_000 },
];

/** Smallest ladder interval that keeps the window under `target` buckets. */
export function pickInterval(startTime: string, endTime: string, target = 48) {
  const end = resolveBoundMs(endTime, Date.now());
  const start = resolveBoundMs(startTime, end - 7 * DATE_MATH_UNIT_MS.d);
  const span = Math.max(end - start, 60_000);
  const hit = INTERVAL_LADDER.find((i) => span / i.ms <= target);
  return { interval: (hit || INTERVAL_LADDER[INTERVAL_LADDER.length - 1]).id, spanMs: span };
}
