export type Severity = "critical" | "high" | "medium" | "low" | "info";
export type KillStage =
  | "recon"
  | "delivery"
  | "exploit"
  | "install"
  | "c2"
  | "actions";

/**
 * Who the alert is about. Alerts embed the whole target document the probe
 * matched on, so the console can name the analyst's own subject rather than
 * echoing back the raw matched value.
 */
export interface TargetIdentity {
  alias?: string;
  firstName?: string;
  lastName?: string;
  description?: string;
  /** Case / subject-of-interest labels the target was filed under. */
  subject?: string[];
  priority?: string;
  targetValue?: string[];
  captureAction?: string[];
  createdBy?: string;
  lastModifiedBy?: string;
  importName?: string;
  enabled?: boolean;
  /** ISO bounds of the interception authority window. */
  activeFrom?: string;
  validTill?: string;
}

export interface Detection {
  id: string;
  index?: string;
  title: string;
  severity: Severity;
  stage: KillStage;
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
  hit_count?: number;
  status: "open" | "investigating" | "contained";
  value?: string;
  alert_type?: string;
  link_name?: string;
  probe_host_name?: string;
  probe_ip?: string;
  flagged?: boolean;
  tags?: { name: string; color?: string }[];
  session_id?: string;
  target?: TargetIdentity;
}

export const STAGE_LABEL: Record<KillStage, string> = {
  recon: "Recon",
  delivery: "Delivery",
  exploit: "Exploit",
  install: "Install",
  c2: "C2",
  actions: "Actions",
};

export function severityColor(s: Severity | string) {
  const map: Record<string, string> = {
    critical: "#E11D2E",
    high: "#F97316",
    medium: "#EAB308",
    low: "#3B82F6",
    info: "#06B6D4",
  };
  return map[s] || map.info;
}
