import { INDEX, esSearch, totalHits } from "./es-server";
import { pageParams, parseTimeParam } from "./api-utils";

export function mapTargetHit(h: any) {
  const s = h._source || {};
  const p = s.personalInfo || {};
  return {
    id: h._id,
    _version: h._version,
    alias: p.alias,
    name: [p.firstName, p.lastName].filter(Boolean).join(" ") || p.alias,
    firstName: p.firstName,
    lastName: p.lastName,
    priority: String(p.priority || "").toLowerCase(),
    enabled: !!s.enabled,
    values: s.targetValue || [],
    condition: s.condition,
    interceptionCriteria: s.interceptionCriteria || { assignTo: [] },
    assignTo: s.interceptionCriteria?.assignTo || [],
    shared: s.shared || [],
    created_by: s.created_by,
    created_on: s.created_on,
    last_modified_by: s.last_modified_by,
    last_modified_on: s.last_modified_on,
    activeFrom: s.activeFromTZ || s.activeFrom,
    validTill: s.validTillTZ || s.validTill,
    activeFromTZ: s.activeFromTZ,
    validTillTZ: s.validTillTZ,
    description: p.description,
    capture_action: s.capture_action,
    importName: s.importName,
    personalInfo: p,
  };
}

export function buildTargetQuery(q: URLSearchParams) {
  const query = (q.get("query") || "").trim();
  const statusRaw = (q.get("status") || "all").toLowerCase();
  const priorityRaw = (q.get("priority") || "all").toLowerCase();
  const advanced = (q.get("advanced") || "").trim();
  const statuses = statusRaw.split(",").map((s) => s.trim()).filter(Boolean);
  const priorities = priorityRaw.split(",").map((s) => s.trim()).filter(Boolean);
  const must: any[] = [];

  if (query) {
    must.push({
      multi_match: {
        query,
        fields: [
          "personalInfo.alias",
          "personalInfo.firstName",
          "personalInfo.lastName",
          "targetValue",
          "created_by",
          "importName",
        ],
      },
    });
  }

  const statusFilters = statuses.filter((s) => s !== "all");
  if (statusFilters.length === 1) {
    if (statusFilters[0] === "active") must.push({ term: { enabled: true } });
    if (statusFilters[0] === "inactive") must.push({ term: { enabled: false } });
  } else if (statusFilters.length > 1) {
    const should: any[] = [];
    if (statusFilters.includes("active")) should.push({ term: { enabled: true } });
    if (statusFilters.includes("inactive")) should.push({ term: { enabled: false } });
    if (should.length) must.push({ bool: { should, minimum_should_match: 1 } });
  }

  const priFilters = priorities.filter((s) => s !== "all");
  if (priFilters.length) {
    const should = priFilters.flatMap((priority) => [
      { term: { "personalInfo.priority.keyword": priority } },
      { term: { "personalInfo.priority.keyword": priority[0].toUpperCase() + priority.slice(1) } },
      { term: { "personalInfo.priority.keyword": priority.toUpperCase() } },
    ]);
    must.push({ bool: { should, minimum_should_match: 1 } });
  }

  if (advanced) {
    for (const part of advanced.split("|")) {
      const [field, condition, rawVal] = part.split(":");
      if (!field || !condition) continue;
      const value = decodeURIComponent(rawVal || "");
      const fieldMap: Record<string, string> = {
        alias: "personalInfo.alias.keyword",
        priority: "personalInfo.priority.keyword",
        created_by: "created_by.keyword",
        targetValue: "targetValue.keyword",
        firstName: "personalInfo.firstName.keyword",
        lastName: "personalInfo.lastName.keyword",
        description: "personalInfo.description.keyword",
      };
      const kw = fieldMap[field] || `${field}.keyword`;
      if (condition === "exists") must.push({ exists: { field: fieldMap[field]?.replace(/\.keyword$/, "") || field } });
      else if (condition === "not_exists")
        must.push({ bool: { must_not: [{ exists: { field: fieldMap[field]?.replace(/\.keyword$/, "") || field } }] } });
      else if (condition === "is") must.push({ term: { [kw]: value } });
      else if (condition === "is_not") must.push({ bool: { must_not: [{ term: { [kw]: value } }] } });
      else if (condition === "contains") must.push({ wildcard: { [kw]: `*${value}*` } });
      else if (condition === "not_contains") must.push({ bool: { must_not: [{ wildcard: { [kw]: `*${value}*` } }] } });
      else if (condition === "starts_with") must.push({ prefix: { [kw]: value } });
    }
  }

  return must.length ? { bool: { must } } : { match_all: {} };
}

export function sortSpec(q: URLSearchParams) {
  const sortOn = q.get("sortOn") || "created_on";
  const sortDir = (q.get("sortDir") || "desc").toLowerCase() === "asc" ? "asc" : "desc";
  const fieldMap: Record<string, string> = {
    created_on: "created_on",
    last_modified_on: "last_modified_on",
    name: "personalInfo.alias.keyword",
    "personalInfo.alias.keyword": "personalInfo.alias.keyword",
    priority: "personalInfo.priority.keyword",
  };
  const field = fieldMap[sortOn] || "created_on";
  return [{ [field]: sortDir }];
}

export async function listTargets(q: URLSearchParams) {
  const { page, pageSize, from } = pageParams(q, 100);
  const data: any = await esSearch(INDEX.targets + "/_search", {
    from,
    size: pageSize,
    track_total_hits: true,
    version: true,
    sort: sortSpec(q),
    query: buildTargetQuery(q),
    aggs: {
      by_priority: { terms: { field: "personalInfo.priority.keyword", size: 10 } },
      enabled: { terms: { field: "enabled", size: 2 } },
      all: { filter: { match_all: {} } },
    },
  });

  const enabledBuckets = data.aggregations?.enabled?.buckets || [];
  const activeCount =
    enabledBuckets.find((b: any) => b.key === 1 || b.key_as_string === "true")?.doc_count || 0;
  const inActiveCount =
    enabledBuckets.find((b: any) => b.key === 0 || b.key_as_string === "false")?.doc_count || 0;
  const pri = Object.fromEntries(
    ((data.aggregations?.by_priority?.buckets || []) as any[]).map((b) => [
      String(b.key).toLowerCase(),
      b.doc_count,
    ])
  );

  return {
    total: totalHits(data),
    totalCount: totalHits(data),
    page,
    pageSize,
    items: (data.hits?.hits || []).map(mapTargetHit),
    details: (data.hits?.hits || []).map(mapTargetHit),
    counts: {
      all: activeCount + inActiveCount,
      active: activeCount,
      inactive: inActiveCount,
      high: pri.high || 0,
      medium: pri.medium || 0,
      low: pri.low || 0,
    },
    allCount: activeCount + inActiveCount,
    activeCount,
    inActiveCount,
    highPriorityCount: pri.high || 0,
    mediumPriorityCount: pri.medium || 0,
    lowPriorityCount: pri.low || 0,
    aggs: {
      by_priority: data.aggregations?.by_priority?.buckets || [],
      enabled: enabledBuckets,
    },
  };
}

export function buildTargetDoc(data: any, by: string, existing?: any) {
  const now = Math.floor(Date.now() / 1000);
  const alias = data?.personalInfo?.alias || data?.alias;
  const values = data?.targetValue || data?.values || [];
  const priority = data.personalInfo?.priority || data.priority || "medium";
  const firstName = data.personalInfo?.firstName || data.firstName || "";
  const lastName = data.personalInfo?.lastName || data.lastName || "";
  const description = data.personalInfo?.description || data.description || "";
  const activeFromTZ = data.activeFromTZ || existing?.activeFromTZ || new Date().toISOString();
  const validTillTZ =
    data.validTillTZ ||
    existing?.validTillTZ ||
    new Date(Date.now() + 30 * 86400000).toISOString();
  const activeFrom = data.activeFrom || Math.floor(new Date(activeFromTZ).getTime() / 1000);
  const validTill = data.validTill || Math.floor(new Date(validTillTZ).getTime() / 1000);
  const assignTo = data.interceptionCriteria?.assignTo || data.assignTo || [];
  const condition =
    data.condition ||
    JSON.stringify(
      values.map((v: string) => ({
        match: { keyword: { query: v, operator: "and" } },
      }))
    );

  return {
    personalInfo: { alias, firstName, lastName, priority, description },
    targetValue: values,
    condition,
    interceptionCriteria: {
      ...(existing?.interceptionCriteria || {}),
      assignTo,
      subject: data.interceptionCriteria?.subject || existing?.interceptionCriteria?.subject || [],
    },
    enabled: data.enabled !== false,
    shared: data.shared ?? existing?.shared ?? [],
    capture_action: data.capture_action || existing?.capture_action || ["metadata"],
    activeFrom,
    activeFromTZ,
    validTill,
    validTillTZ,
    created_by: existing?.created_by || data.created_by || by,
    created_on: existing?.created_on || data.created_on || now,
    last_modified_by: by,
    last_modified_on: now,
    importName: data.importName || existing?.importName,
    "@timestamp": Date.now(),
  };
}

export async function syncCaptureFilter(id: string, doc: any, by: string) {
  const now = Math.floor(Date.now() / 1000);
  // update existing by reference_id or create
  const existing: any = await esSearch(INDEX.captureFilter + "/_search", {
    size: 1,
    query: { term: { "reference_id.keyword": id } },
  }).catch(() => ({ hits: { hits: [] } }));
  const hit = existing.hits?.hits?.[0];
  const payload = {
    reference_id: id,
    name: doc.personalInfo?.alias,
    rule_type: "capture",
    values: doc.targetValue || [],
    condition: doc.condition,
    enabled: doc.enabled,
    created_by: hit?._source?.created_by || by,
    created_on: hit?._source?.created_on || now,
    last_modified_by: by,
    last_modified_on: now,
  };
  if (hit?._id) {
    await esSearch(`${INDEX.captureFilter}/_update/${hit._id}`, { doc: payload }, "POST");
  } else {
    await esSearch(`${INDEX.captureFilter}/_doc`, payload, "POST");
  }
}

export { pageParams, parseTimeParam, INDEX, esSearch, totalHits };
