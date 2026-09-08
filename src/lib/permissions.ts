/** SpiderX / vehere-ui module permission tree for role editing. */
export type PermNode = {
  id: string;
  label: string;
  children?: PermNode[];
};

export const APP_PERMISSION_TREE: PermNode[] = [
  {
    id: "mcsConfiguration",
    label: "Dashboard / Command",
    children: [{ id: "cmsDashboard", label: "CMS SOI Dashboard" }, { id: "command", label: "Command view" }],
  },
  {
    id: "alerts",
    label: "Alerts",
    children: [{ id: "alertGrid", label: "Alert grid" }],
  },
  {
    id: "managementSystem",
    label: "Target Management",
    children: [{ id: "targetManagementSystem", label: "Targets / EOI" }],
  },
  { id: "linkMonitoring", label: "Link Monitoring" },
  { id: "healthMonitorings", label: "Health" },
  { id: "auditTrail", label: "Audit Trail" },
  { id: "spiderxEdge", label: "Spider-X Edge" },
  {
    id: "configuration",
    label: "Configuration",
    children: [
      { id: "aboutConfiguration", label: "About" },
      {
        id: "dataManagement",
        label: "Data Management",
        children: [{ id: "linkIdentifier", label: "Capture Input Identification" }],
      },
      {
        id: "management",
        label: "User Management",
        children: [
          { id: "userManagement", label: "Users" },
          { id: "roleManagement", label: "Roles" },
        ],
      },
    ],
  },
];

export function flattenPermissionIds(nodes: PermNode[] = APP_PERMISSION_TREE): string[] {
  const out: string[] = [];
  const walk = (list: PermNode[]) => {
    for (const n of list) {
      out.push(n.id);
      if (n.children) walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

export function parsePermissions(raw: string | string[] | undefined | null): string[] {
  if (Array.isArray(raw)) return raw.map(String).map((s) => s.trim()).filter(Boolean);
  return String(raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function serializePermissions(ids: string[]): string {
  return [...new Set(ids)].join(",");
}
