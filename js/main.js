const APP_CONFIG = window.APP_CONFIG || {};
const SOCRATA_DOMAIN = APP_CONFIG.SOCRATA_DOMAIN || "data.cincinnati-oh.gov";

function usableSocrataAppToken(raw) {
  const t = raw == null ? "" : String(raw).trim();
  if (!t) return "";
  if (/^REPLACE/i.test(t)) return "";
  return t;
}

const SOCRATA_APP_TOKEN = usableSocrataAppToken(APP_CONFIG.SOCRATA_APP_TOKEN);
let omitSocrataAppToken = false;

const DATASET_ID = "gcej-gmiw";
// Predefined list of service types to show on the map and in the dropdown
const TARGET_SERVICE_TYPES = ["PTHOLE", "PLMB_DEF", "MTL-FRN", "SEWAG_EX", "GRFITI", "RCYCLNG"];
// Service type requests: API coverage ~2004–2026 (2026 partial).
const DATE_RANGE_START = "2004-01-01T00:00:00.000";
const DATE_RANGE_END = "2026-12-31T23:59:59.999";
const SOCRATA_CSV_PAGE_LIMIT = 50000;
/** Parallel CSV page fetches (same $where); keep moderate to reduce 429 risk without an app token. */
const SOCRATA_PARALLEL_PAGES = 4;

/** Default timeline year (filters map + charts on load; user can switch to “All years”). */
const DEFAULT_TIMELINE_YEAR = 2025;

const STORAGE_KEY_SERVICE_TYPE_COLORS = "cincinnati311_serviceTypeColors_v1";

function loadServiceTypeColorsFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_SERVICE_TYPE_COLORS);
    if (!raw) return {};
    const o = JSON.parse(raw);
    return o && typeof o === "object" ? o : {};
  } catch {
    return {};
  }
}

function saveServiceTypeColorsToStorage(colors) {
  try {
    localStorage.setItem(STORAGE_KEY_SERVICE_TYPE_COLORS, JSON.stringify(colors));
  } catch { /* quota / private mode */ }
}

const SELECT_FIELDS = [
  "sr_number",
  "sr_type",
  "sr_type_desc",
  "priority",
  "dept_name",
  "method_received",
  "neighborhood",
  "date_created",
  "date_last_update",
  "latitude",
  "longitude"
];


let leafletMapInstance = null;
let allRecords         = [];
let filteredRecords    = [];
let activeBrushRange   = null;
let mapSelectionBounds = null;

let filterDepartment     = "";
let filterNeighborhoods  = [];
let filterPriority       = "";
let filterMethodReceived = "";
/** Checked service types for filtering (subset of TARGET_SERVICE_TYPES once data is loaded). */
let filterServiceTypes   = [];

function getLevel3ActiveFilters() {
  return {
    neighborhood: filterNeighborhoods[0] || "",
    method: filterMethodReceived,
    dept: filterDepartment,
    priority: filterPriority,
    serviceTypesSelected: [...filterServiceTypes],
    serviceTypeColors: leafletMapInstance ? leafletMapInstance.getServiceTypeColorsObject() : {},
    serviceTypesOnlySubset: filterServiceTypes.length < TARGET_SERVICE_TYPES.length
  };
}

let dataSourceLabel   = "Unknown";
let dataWarningMessage = "";

const timelineState = {
  svg: null,
  brush: null,
  brushGroup: null,
  xScale: null,
  bin: "month"
};


function getValue(record, aliases) {
  for (const key of aliases) {
    if (record[key] !== undefined && record[key] !== null && String(record[key]).trim() !== "") {
      return String(record[key]).trim();
    }
  }
  return null;
}

function parseDate(rawDate) {
  if (!rawDate) return null;
  const date = new Date(rawDate);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeRecord(record) {
  const latitudeRaw  = getValue(record, ["latitude",  "LATITUDE"]);
  const longitudeRaw = getValue(record, ["longitude", "LONGITUDE"]);
  const latitude     = latitudeRaw  !== null ? Number(latitudeRaw)  : null;
  const longitude    = longitudeRaw !== null ? Number(longitudeRaw) : null;

  const dateCreated    = parseDate(getValue(record, ["date_created",    "DATE_CREATED"]));
  const dateLastUpdate = parseDate(getValue(record, ["date_last_update","DATE_LAST_UPDATE"]));

  let daysToUpdate = null;
  if (dateCreated && dateLastUpdate) {
    const diffMs = dateLastUpdate.getTime() - dateCreated.getTime();
    daysToUpdate = Math.max(0, diffMs / (1000 * 60 * 60 * 24));
  }

  return {
    srNumber:       getValue(record, ["sr_number",       "SR_NUMBER"])       || "Unknown",
    srType:         getValue(record, ["sr_type",         "SR_TYPE"])         || "Unknown",
    srTypeDesc:     getValue(record, ["sr_type_desc",    "SR_TYPE_DESC"])    || "Unknown",
    priority:       getValue(record, ["priority",        "PRIORITY"])        || "Unknown",
    deptName:       getValue(record, ["dept_name",       "DEPT_NAME"])       || "Unknown",
    methodReceived: getValue(record, ["method_received", "METHOD_RECEIVED"]) || "Unknown",
    neighborhood:   getValue(record, ["neighborhood",    "NEIGHBORHOOD"])    || "Unknown",
    dateCreated,
    dateLastUpdate,
    latitude:  Number.isFinite(latitude)  ? latitude  : null,
    longitude: Number.isFinite(longitude) ? longitude : null,
    daysToUpdate
  };
}

function normalizeAll(records) {
  return records.map(normalizeRecord);
}


function setDataLoadProgress(message) {
  const el = document.getElementById("data-source");
  if (el) el.textContent = message;
}

/**
 * Push filter work to Socrata so we download only the six target service types, not the full 311 feed.
 * (Roughly 600k rows vs 2.1M+ for the date range alone — fewer pages, less bandwidth, faster parse.)
 */
function buildSocrataWhereClauseForTargetTypes() {
  const list = TARGET_SERVICE_TYPES.map(t => `'${String(t).replace(/'/g, "''")}'`).join(",");
  return `date_created between '${DATE_RANGE_START}' and '${DATE_RANGE_END}' AND sr_type IN (${list})`;
}

async function socrataFetchWithRetry(url) {
  const headers = {};
  if (SOCRATA_APP_TOKEN && !omitSocrataAppToken) {
    headers["X-App-Token"] = SOCRATA_APP_TOKEN;
  }

  const response = await fetch(url, { headers });
  const text = await response.text();

  if (!response.ok) {
    let portalMsg = "";
    try {
      const err = JSON.parse(text);
      if (err && typeof err === "object" && err.message) portalMsg = String(err.message);
    } catch { }

    if (
      response.status === 403 &&
      SOCRATA_APP_TOKEN &&
      !omitSocrataAppToken &&
      /invalid app_token/i.test(portalMsg)
    ) {
      omitSocrataAppToken = true;
      return socrataFetchWithRetry(url);
    }
    if (response.status === 429) {
      const retry = response.headers.get("Retry-After");
      const extra = retry ? ` Retry after ${retry}s.` : "";
      throw new Error(`Rate limited (HTTP 429).${extra} ${portalMsg}`.trim());
    }
    throw new Error(
      `Socrata error HTTP ${response.status}: ${portalMsg || response.statusText || "request failed"}`
    );
  }

  return text;
}

async function requestSocrataCsv(url, options = {}) {
  const { silent = false } = options;
  if (!silent) setDataLoadProgress("Loading from API…");

  const text = await socrataFetchWithRetry(url);

  let rows;
  try {
    rows = d3.csvParse(text);
  } catch (parseErr) {
    const hint = parseErr instanceof Error ? parseErr.message : String(parseErr);
    throw new Error(`Socrata returned CSV that could not be parsed: ${hint}`);
  }

  if (!Array.isArray(rows)) throw new Error("Socrata CSV parse did not return rows.");

  if (!silent) setDataLoadProgress(`Loading from API… ${formatCount(rows.length)} rows`);
  return rows;
}

async function fetchSocrataRowCount(whereClause) {
  const params = new URLSearchParams({
    $select: "count(*)",
    $where: whereClause
  });
  const url = `https://${SOCRATA_DOMAIN}/resource/${DATASET_ID}.json?${params.toString()}`;
  const text = await socrataFetchWithRetry(url);
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Socrata count response was not valid JSON.");
  }
  if (!Array.isArray(data) || !data.length) return 0;
  const raw = data[0].count ?? data[0].COUNT;
  return Math.max(0, parseInt(String(raw ?? "0"), 10));
}

async function fetchSocrataPage(whereClause, offset) {
  const params = new URLSearchParams({
    $select: SELECT_FIELDS.join(","),
    $where: whereClause,
    $order: ":id",
    $limit: String(SOCRATA_CSV_PAGE_LIMIT),
    $offset: String(offset)
  });
  const url = `https://${SOCRATA_DOMAIN}/resource/${DATASET_ID}.csv?${params.toString()}`;
  return requestSocrataCsv(url, { silent: true });
}

async function fetchAllSocrataRecordsSequential(whereClause) {
  const allRows = [];
  let offset = 0;
  const maxPages = 50;

  for (let p = 0; p < maxPages; p++) {
    const rows = await fetchSocrataPage(whereClause, offset);
    allRows.push(...rows);
    setDataLoadProgress(`Loading from API… ${formatCount(allRows.length)} rows`);
    if (rows.length === 0 || rows.length < SOCRATA_CSV_PAGE_LIMIT) break;
    offset += SOCRATA_CSV_PAGE_LIMIT;
  }

  return allRows;
}

async function fetchAllSocrataRecords() {
  omitSocrataAppToken = false;
  const whereClause = buildSocrataWhereClauseForTargetTypes();

  setDataLoadProgress("Counting matching rows…");
  let totalRows;
  try {
    totalRows = await fetchSocrataRowCount(whereClause);
  } catch (err) {
    console.warn("Socrata count query failed; falling back to sequential paging.", err);
    return fetchAllSocrataRecordsSequential(whereClause);
  }

  if (totalRows === 0) return [];

  const pageCount = Math.min(50, Math.ceil(totalRows / SOCRATA_CSV_PAGE_LIMIT));
  setDataLoadProgress(`Loading ${formatCount(totalRows)} rows (${pageCount} request${pageCount === 1 ? "" : "s"})…`);

  if (pageCount === 1) {
    const rows = await fetchSocrataPage(whereClause, 0);
    setDataLoadProgress(`Loading from API… ${formatCount(rows.length)} rows`);
    return rows;
  }

  const allRows = [];
  for (let start = 0; start < pageCount; start += SOCRATA_PARALLEL_PAGES) {
    const batchOffsets = [];
    for (let i = 0; i < SOCRATA_PARALLEL_PAGES && start + i < pageCount; i++) {
      batchOffsets.push((start + i) * SOCRATA_CSV_PAGE_LIMIT);
    }
    const batchRows = await Promise.all(batchOffsets.map(off => fetchSocrataPage(whereClause, off)));
    for (const rows of batchRows) allRows.push(...rows);
    setDataLoadProgress(
      `Loading from API… ${formatCount(allRows.length)} / ${formatCount(totalRows)}`
    );
  }

  return allRows;
}

function populateServiceTypesDropdown() {
  const el = document.getElementById("service-types-options");
  if (!el) return;

  el.innerHTML = "";

  TARGET_SERVICE_TYPES.forEach(type => {
    const row = document.createElement("label");
    row.className = "service-type-option";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = type;
    checkbox.checked = filterServiceTypes.includes(type);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) {
        if (!filterServiceTypes.includes(type)) {
          filterServiceTypes.push(type);
        }
      } else {
        filterServiceTypes = filterServiceTypes.filter(t => t !== type);
      }
      updateServiceTypesButtonText();
      applyFilters();
    });

    const text = document.createElement("span");
    text.className = "service-type-option-label";
    text.textContent = type;

    const colorInput = document.createElement("input");
    colorInput.type = "color";
    colorInput.className = "service-type-color-input";
    colorInput.setAttribute("aria-label", `Color for ${type}`);
    colorInput.title = `Map color for ${type}`;
    if (leafletMapInstance) {
      colorInput.value = leafletMapInstance.getServiceTypeColor(type);
    }
    colorInput.addEventListener("click", e => e.stopPropagation());
    colorInput.addEventListener("change", () => {
      if (!leafletMapInstance) return;
      leafletMapInstance.setServiceTypeColor(type, colorInput.value);
      saveServiceTypeColorsToStorage(leafletMapInstance.getServiceTypeColorsObject());
      if (typeof window.updateLevel3Charts === "function") {
        window.updateLevel3Charts(filteredRecords, getLevel3ActiveFilters());
      }
    });

    row.appendChild(checkbox);
    row.appendChild(text);
    row.appendChild(colorInput);
    el.appendChild(row);
  });
}

function updateServiceTypesButtonText() {
  const btn = document.getElementById("service-types-toggle");
  if (!btn) return;
  
  if (filterServiceTypes.length === 0) {
    btn.textContent = "Select service types…";
  } else if (filterServiceTypes.length === TARGET_SERVICE_TYPES.length) {
    btn.textContent = `All ${TARGET_SERVICE_TYPES.length} types`;
  } else if (filterServiceTypes.length === 1) {
    btn.textContent = filterServiceTypes[0];
  } else {
    btn.textContent = `${filterServiceTypes.length} selected`;
  }
}

async function fetchFallbackCsv() {
  const csvData = await d3.csv("data/311Sample.csv");
  return csvData;
}

async function loadRecords() {
  try {
    const liveRecords = await fetchAllSocrataRecords();
    let normalized = normalizeAll(liveRecords);
    // Filter to only include target service types
    const targetSt = new Set(TARGET_SERVICE_TYPES);
    normalized = normalized.filter(r => r.srType && targetSt.has(r.srType));
    return {
      sourceLabel: "Live API",
      warningMessage: "",
      records: normalized
    };
  } catch (error) {
    console.warn("Live API failed. Falling back to local CSV.", error);
    const reason = error instanceof Error ? error.message : String(error);
    const isRateLimited = /429|rate limit/i.test(reason);
    const isNetwork =
      error instanceof TypeError ||
      /failed to fetch|network|load failed|CORS/i.test(reason);
    let detail = reason;
    if (isRateLimited) {
      detail =
        "The open data portal returned HTTP 429 (too many requests). Wait a few minutes, ensure SOCRATA_APP_TOKEN is set in js/config.local.js, and reload. ";
      detail += `Technical: ${reason}`;
    } else if (isNetwork) {
      detail =
        "Request was blocked or failed (often: open the site via http://localhost, not file://). ";
      detail += reason;
    }
    const fallbackRecords = await fetchFallbackCsv();
    let normalized = normalizeAll(fallbackRecords);
    // Filter to only include target service types
    const targetSt = new Set(TARGET_SERVICE_TYPES);
    normalized = normalized.filter(r => r.srType && targetSt.has(r.srType));
    return {
      sourceLabel:    "Fallback sample CSV",
      warningMessage: `Live API did not load. ${detail} Showing local sample CSV instead.`,
      records: normalized
    };
  }
}


function formatCount(value) {
  return d3.format(",")(value);
}

function formatRange(range) {
  if (!range) return "All dates";
  const formatter    = d3.timeFormat("%b %d, %Y");
  const inclusiveEnd = d3.timeDay.offset(range[1], -1);
  return `${formatter(range[0])} to ${formatter(inclusiveEnd)}`;
}

function uniqueSortedStrings(values) {
  return [
    ...new Set(
      values.map(v =>
        v != null && String(v).trim() !== "" ? String(v).trim() : "Unknown"
      )
    )
  ].sort((a, b) => d3.ascending(a.toLowerCase(), b.toLowerCase()));
}


function populateNeighborhoodDropdown() {
  const el = document.getElementById("filter-neighborhood");
  if (!el) return;
  const values = uniqueSortedStrings(allRecords.map(d => d.neighborhood));
  const valid  = new Set(values);
  filterNeighborhoods = filterNeighborhoods.filter(n => valid.has(n));
  const taken     = new Set(filterNeighborhoods);
  const available = values.filter(v => !taken.has(v));

  el.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent =
    available.length > 0
      ? "Add neighborhood…"
      : "All selected — remove a tag to add more";
  el.appendChild(placeholder);
  available.forEach(v => {
    const opt = document.createElement("option");
    opt.value       = v;
    opt.textContent = v;
    el.appendChild(opt);
  });
  el.value    = "";
  el.disabled = available.length === 0;
}

function fillSelectOptions(selectId, values, allLabel) {
  const el = document.getElementById(selectId);
  if (!el) return;
  const current = el.value;
  el.innerHTML  = "";
  const allOpt = document.createElement("option");
  allOpt.value       = "";
  allOpt.textContent = allLabel;
  el.appendChild(allOpt);
  values.forEach(v => {
    const opt = document.createElement("option");
    opt.value       = v;
    opt.textContent = v;
    el.appendChild(opt);
  });
  el.value = values.includes(current) ? current : "";
}

function renderFilterChips() {
  // Render scope filters (Department, Neighborhood, Priority)
  const scopeEl = document.getElementById("filter-chips-scope");
  if (scopeEl) {
    const scopeItems = [];
    if (filterDepartment) scopeItems.push({ field: "filterDepartment", label: "Dept", value: filterDepartment });
    filterNeighborhoods.forEach(n => {
      scopeItems.push({ field: "filterNeighborhood", label: "Area", value: n, filterValue: n });
    });
    if (filterPriority) scopeItems.push({ field: "filterPriority", label: "Priority", value: filterPriority });

    scopeEl.innerHTML = "";
    if (scopeItems.length === 0) {
      scopeEl.hidden = true;
    } else {
      scopeEl.hidden = false;
      scopeItems.forEach(({ field, label, value, filterValue }) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = field === "filterNeighborhood" ? "filter-chip filter-chip-neighborhood" : "filter-chip";
        btn.dataset.filterField = field;
        if (field === "filterNeighborhood" && filterValue !== undefined) {
          btn.dataset.filterValue = filterValue;
        }
        btn.setAttribute(
          "aria-label",
          field === "filterNeighborhood" ? `Remove neighborhood: ${value}` : `Remove ${label} filter: ${value}`
        );
        const span = document.createElement("span");
        span.textContent = field === "filterNeighborhood" ? value : `${label}: ${value}`;
        const x = document.createElement("span");
        x.className = "filter-chip-x";
        x.setAttribute("aria-hidden", "true");
        x.textContent = "×";
        btn.append(span, x);
        scopeEl.appendChild(btn);
      });
    }
  }

  // Render service type filters
  const stEl = document.getElementById("filter-chips");
  if (stEl) {
    stEl.innerHTML = "";
    if (filterServiceTypes.length === 0) {
      stEl.hidden = true;
    } else {
      stEl.hidden = false;
      filterServiceTypes.forEach(st => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "filter-chip filter-chip-service-type";
        btn.dataset.filterField = "filterServiceType";
        btn.dataset.filterValue = st;
        btn.setAttribute("aria-label", `Remove service type: ${st}`);
        btn.style.setProperty("--chip-type-color", getServiceTypeColorForMini(st));
        const span = document.createElement("span");
        span.textContent = st;
        const x = document.createElement("span");
        x.className = "filter-chip-x";
        x.setAttribute("aria-hidden", "true");
        x.textContent = "×";
        btn.append(span, x);
        stEl.appendChild(btn);
      });
    }
  }
}

function populateFilterSelects() {
  fillSelectOptions(
    "filter-dept",
    uniqueSortedStrings(allRecords.map(d => d.deptName)),
    "All departments"
  );
  populateNeighborhoodDropdown();
  fillSelectOptions(
    "filter-priority",
    uniqueSortedStrings(allRecords.map(d => d.priority)),
    "All priorities"
  );
}


function updateStatusPanel() {
  const mappedFiltered   = filteredRecords.filter(d => d.latitude !== null && d.longitude !== null).length;
  const unmappedFiltered = filteredRecords.length - mappedFiltered;

  document.getElementById("data-source").textContent      = dataSourceLabel;
  document.getElementById("count-total").textContent      = formatCount(filteredRecords.length);
  document.getElementById("count-mapped").textContent     = formatCount(mappedFiltered);
  document.getElementById("count-unmapped").textContent   = formatCount(unmappedFiltered);
  document.getElementById("count-total-year").textContent = formatCount(allRecords.length);

  const partialEl = document.getElementById("partial-year-note");
  if (partialEl) {
    const yearEl = document.getElementById("timeline-year");
    const selectedYear = yearEl ? yearEl.value.trim() : "";
    partialEl.hidden = selectedYear !== "2026";
  }

  document.getElementById("active-range").textContent = formatRange(activeBrushRange);

  const attrParts = [];
  const tyEl = document.getElementById("timeline-year");
  const ty   = tyEl && tyEl.value ? tyEl.value.trim() : "";
  if (ty)                       attrParts.push(`Timeline year: ${ty}`);
  if (filterDepartment)         attrParts.push(`Dept: ${filterDepartment}`);
  if (filterNeighborhoods.length) attrParts.push(`Area: ${filterNeighborhoods.join(", ")}`);
  if (filterPriority)           attrParts.push(`Priority: ${filterPriority}`);
  if (filterMethodReceived)     attrParts.push(`Method: ${filterMethodReceived}`);

  const attrEl = document.getElementById("active-filters");
  if (attrEl) attrEl.textContent = attrParts.length ? attrParts.join(" · ") : "None";

  const mapRegionEl = document.getElementById("map-region-status");
  if (mapRegionEl) {
    mapRegionEl.textContent = mapSelectionBounds ? "Rectangle on map (see outline)" : "None";
  }

  const mapDrawBtn = document.getElementById("map-draw-region");
  if (mapDrawBtn && leafletMapInstance) {
    const heatMode = leafletMapInstance.activeMapMode === "heat";
    mapDrawBtn.disabled = heatMode;
    mapDrawBtn.title = heatMode ? "Switch to Points mode to draw a map region." : "";
    const active = leafletMapInstance.brushModeActive;
    mapDrawBtn.setAttribute("aria-pressed", active ? "true" : "false");
    mapDrawBtn.textContent = active ? "Drawing..." : "Draw region";
  }

  const mapClearBtn = document.getElementById("map-clear-region");
  if (mapClearBtn) {
    mapClearBtn.disabled = !mapSelectionBounds;
  }

  const mapMoveBtn = document.getElementById("map-move-region");
  if (mapMoveBtn && leafletMapInstance) {
    const heatMode = leafletMapInstance.activeMapMode === "heat";
    mapMoveBtn.disabled = heatMode || !mapSelectionBounds;
    mapMoveBtn.title = heatMode
      ? "Switch to Points mode to move the map region."
      : !mapSelectionBounds
        ? "Draw a region on the map first."
        : "Drag inside the blue rectangle to move it without panning the map.";
    mapMoveBtn.setAttribute(
      "aria-pressed",
      leafletMapInstance.moveRegionModeActive ? "true" : "false"
    );
    mapMoveBtn.classList.toggle(
      "map-toolbar-btn-primary",
      Boolean(leafletMapInstance.moveRegionModeActive)
    );
    mapMoveBtn.textContent = leafletMapInstance.moveRegionModeActive
      ? "Moving..."
      : "Move region";
  }

  renderFilterChips();

  const warningEl = document.getElementById("data-warning");
  if (warningEl) {
    if (dataWarningMessage && String(dataWarningMessage).trim() !== "") {
      warningEl.textContent = dataWarningMessage;
      warningEl.hidden = false;
    } else {
      warningEl.textContent = "";
      warningEl.hidden = true;
    }
  }

  const countBadge = document.getElementById("l3-record-count");
  if (countBadge) countBadge.textContent = formatCount(filteredRecords.length);
}


const MINI_CHART_TYPE_FALLBACK_COLORS = {
  PTHOLE: "#e11d48",
  PLMB_DEF: "#0ea5e9",
  "MTL-FRN": "#10b981",
  SEWAG_EX: "#1a1a1a",
  GRFITI: "#8b5cf6",
  RCYCLNG: "#eab308",
  Unknown: "#6b7280"
};

function getServiceTypeColorForMini(srType) {
  const key = srType || "Unknown";
  if (leafletMapInstance && typeof leafletMapInstance.getServiceTypeColor === "function") {
    return leafletMapInstance.getServiceTypeColor(key);
  }
  return MINI_CHART_TYPE_FALLBACK_COLORS[key] || "#64748b";
}

/** Order [srType, count] pairs: target types first (stable), then any other types by count. */
function orderMiniChartServiceTypeSegments(entries) {
  const map = new Map(entries);
  const out = [];
  for (const t of TARGET_SERVICE_TYPES) {
    const c = map.get(t);
    if (c > 0) out.push([t, c]);
  }
  const extras = [...map.entries()]
    .filter(([t]) => !TARGET_SERVICE_TYPES.includes(t))
    .sort((a, b) => b[1] - a[1]);
  return out.concat(extras);
}

/** Stable priority order for stacked mini-bar segments */
function orderMiniChartPrioritySegments(entries) {
  const rank = k => {
    const u = String(k || "Unknown").trim().toUpperCase();
    if (u === "HAZARDOUS") return 0;
    if (u === "PRIORITY") return 1;
    if (u === "STANDARD") return 2;
    if (u === "LOW") return 3;
    return 4;
  };
  return [...entries].sort((a, b) => rank(a[0]) - rank(b[0]) || b[1] - a[1]);
}

function getPrioritySegmentColor(p) {
  const u = String(p || "Unknown").trim().toUpperCase();
  if (u === "HAZARDOUS") return "#dc2626";
  if (u === "PRIORITY") return "#d97706";
  if (u === "STANDARD") return "#2563eb";
  if (u === "LOW") return "#64748b";
  return "#94a3b8";
}

function orderMiniChartSegments(entries, innerField) {
  if (innerField === "srType") return orderMiniChartServiceTypeSegments(entries);
  if (innerField === "priority") return orderMiniChartPrioritySegments(entries);
  return [...entries].sort((a, b) => b[1] - a[1]);
}

function innerAccessorForField(innerField) {
  if (innerField === "deptName") return d => d.deptName || "Unknown";
  if (innerField === "priority") return d => d.priority || "Unknown";
  if (innerField === "neighborhood") return d => d.neighborhood || "Unknown";
  return d => d.srType || "Unknown";
}

/**
 * Pick a segment fill that matches the map legend whenever the inner
 * dimension equals the map's current "Color points by" mode.
 */
function segmentColor(innerField, key) {
  if (innerField === "srType") return getServiceTypeColorForMini(key);
  if (innerField === "priority") return getPrioritySegmentColor(key);

  if (
    leafletMapInstance &&
    typeof leafletMapInstance.colorScale === "function" &&
    leafletMapInstance.colorMode === innerField
  ) {
    return leafletMapInstance.colorScale(key || "Unknown");
  }

  return "#94a3b8";
}

function segmentTitlePrefix(innerField) {
  if (innerField === "deptName") return "Dept";
  if (innerField === "priority") return "Priority";
  if (innerField === "neighborhood") return "Area";
  return "Type";
}

/** Map “Color points by” → inner mini-bar dimension (for methods / depts / priority charts). */
function innerFieldFromMapColorMode(colorMode) {
  if (colorMode === "daysToUpdate") return "srType";
  if (colorMode === "neighborhood") return "neighborhood";
  if (colorMode === "deptName") return "deptName";
  if (colorMode === "priority") return "priority";
  return "srType";
}

function getMapColorModeForMiniBars() {
  if (leafletMapInstance && leafletMapInstance.colorMode) {
    return leafletMapInstance.colorMode;
  }
  const el = document.getElementById("color-mode");
  return el && el.value ? el.value : "srType";
}

/** When row label is the same dimension as the inner breakdown, bars would be a single block — use service type instead. */
function effectiveInnerFieldForRowAxis(rowAxis, innerFromMap) {
  if (rowAxis === "deptName" && innerFromMap === "deptName") return "srType";
  if (rowAxis === "priority" && innerFromMap === "priority") return "srType";
  return innerFromMap;
}

/**
 * @param {string} innerField - "srType" | "deptName" | "priority" — dimension shown inside each bar
 */
function renderCategoryChart(containerId, records, accessor, limit, clickFilterField, innerField = "srType") {
  const container = d3.select(containerId);
  container.html("");

  const counts = d3.rollups(records, values => values.length, d => accessor(d) || "Unknown")
    .sort((a, b) => d3.descending(a[1], b[1]));

  const rows = typeof limit === "number" ? counts.slice(0, limit) : counts;
  if (rows.length === 0) {
    container.append("p").attr("class", "mini-empty").text("No data in current filter.");
    return;
  }

  const innerAcc = innerAccessorForField(innerField);
  const byCategory = d3.rollup(
    records,
    v => d3.rollups(v, vv => vv.length, innerAcc),
    d => accessor(d) || "Unknown"
  );

  const titlePrefix = segmentTitlePrefix(innerField);

  const maxCount = rows[0][1] || 1;
  rows.forEach(([label, count]) => {
    const row = container.append("div").attr("class", "mini-row");
    if (clickFilterField === "neighborhood" && filterNeighborhoods.includes(label)) {
      row.classed("mini-row--active", true);
    }
    if (clickFilterField && typeof window.onLevel3Filter === "function") {
      row
        .style("cursor", "pointer")
        .attr("title", "Click to add or remove this value from filters")
        .on("click", () => window.onLevel3Filter(clickFilterField, label));
    }
    row.append("div").attr("class", "mini-label").text(label);
    const barWrap = row.append("div").attr("class", "mini-bar-wrap");
    const outer = barWrap.append("div")
      .attr("class", "mini-bar-outer")
      .style("width", `${(count / maxCount) * 100}%`);
    const segWrap = outer.append("div").attr("class", "mini-bar-segments");
    const segments = orderMiniChartSegments(byCategory.get(label) || [], innerField);
    let allocated = 0;
    segments.forEach(([segKey, c], i) => {
      const isLast = i === segments.length - 1;
      const pctNum = count && isLast
        ? Math.max(0, 100 - allocated)
        : count
          ? (c / count) * 100
          : 0;
      if (!isLast) allocated += pctNum;
      const pctDisp = count ? ((c / count) * 100).toFixed(1) : "0";
      segWrap.append("div")
        .attr("class", "mini-seg")
        .style("width", `${pctNum}%`)
        .style("background-color", segmentColor(innerField, segKey))
        .attr("title", `${titlePrefix} ${segKey}: ${formatCount(c)} (${pctDisp}% of row)`);
    });
    row.append("div").attr("class", "mini-value").text(formatCount(count));
  });
}

function updateSummaryCharts() {
  const innerLinked = innerFieldFromMapColorMode(getMapColorModeForMiniBars());

  // Top neighborhoods: inner mix always by service type (row label is already neighborhood).
  renderCategoryChart("#neighborhood-chart", filteredRecords, d => d.neighborhood, 12, "neighborhood", "srType");
  // Inner mix follows Map → Color points by (Time mode still maps to service type above).
  renderCategoryChart(
    "#methods-chart",
    filteredRecords,
    d => d.methodReceived,
    7,
    null,
    effectiveInnerFieldForRowAxis("methodReceived", innerLinked)
  );
  renderCategoryChart(
    "#depts-chart",
    filteredRecords,
    d => d.deptName,
    7,
    null,
    effectiveInnerFieldForRowAxis("deptName", innerLinked)
  );
  renderCategoryChart(
    "#priority-chart",
    filteredRecords,
    d => d.priority,
    null,
    null,
    effectiveInnerFieldForRowAxis("priority", innerLinked)
  );
}


const PTHOLE_MIN_YEAR = 2004;

function getRecordsDateExtent(records) {
  const withDate = records.filter(d => d.dateCreated);
  if (withDate.length === 0) return null;
  return d3.extent(withDate, d => d.dateCreated);
}

function getTimelineBin() {
  const el = document.getElementById("timeline-year");
  return el && el.value ? "week" : "month";
}

function buildTimelineSeries(records, bin, yearFilter) {
  let subset = records.filter(d => d.dateCreated);
  if (yearFilter) {
    const y = Number(yearFilter);
    subset = subset.filter(d => d.dateCreated.getFullYear() === y);
  }
  if (subset.length === 0) return [];

  const [minD, maxD] = d3.extent(subset, d => d.dateCreated);

  if (bin === "month") {
    const start  = d3.timeMonth.floor(minD);
    const end    = d3.timeMonth.ceil(maxD);
    const months = d3.timeMonth.range(start, end);
    const counts = d3.rollup(subset, v => v.length, d => +d3.timeMonth.floor(d.dateCreated));
    return months.map(monthStart => ({
      periodStart: monthStart,
      periodEnd:   d3.timeMonth.offset(monthStart, 1),
      count:       counts.get(+monthStart) || 0,
      bin:         "month"
    }));
  }

  const weekStart0 = d3.timeMonday.floor(minD);
  const weekEnd    = d3.timeMonday.ceil(maxD);
  const weeks      = d3.timeMonday.range(weekStart0, weekEnd);
  const counts     = d3.rollup(subset, v => v.length, d => +d3.timeMonday.floor(d.dateCreated));
  return weeks.map(weekStart => ({
    periodStart: weekStart,
    periodEnd:   d3.timeMonday.offset(weekStart, 1),
    count:       counts.get(+weekStart) || 0,
    bin:         "week"
  }));
}

function populateTimelineYearSelect() {
  const el = document.getElementById("timeline-year");
  if (!el) return;
  const ext    = getRecordsDateExtent(allRecords);
  const minY   = ext ? ext[0].getFullYear() : PTHOLE_MIN_YEAR;
  const maxY   = ext ? ext[1].getFullYear() : 2026;
  const yStart = Math.max(PTHOLE_MIN_YEAR, Math.min(minY, maxY));
  const yEnd   = Math.min(2026, Math.max(minY, maxY));
  const current = el.value;

  el.innerHTML = "";
  const allOpt = document.createElement("option");
  allOpt.value       = "";
  allOpt.textContent = "All years (monthly bins)";
  el.appendChild(allOpt);
  for (let y = yEnd; y >= yStart; y -= 1) {
    const opt = document.createElement("option");
    opt.value       = String(y);
    opt.textContent = y === 2026 ? `${y} (partial)` : String(y);
    el.appendChild(opt);
  }
  if (current && [...el.options].some(o => o.value === current)) el.value = current;
}

function applyDefaultTimelineYearSelection() {
  const el = document.getElementById("timeline-year");
  if (!el) return;
  const preferred = String(DEFAULT_TIMELINE_YEAR);
  if ([...el.options].some(o => o.value === preferred)) {
    el.value = preferred;
  }
}

function handleBrush(event) {
  if (!event.selection) {
    activeBrushRange = null;
    applyFilters();
    return;
  }

  const [x0, x1] = event.selection;
  const inv0 = timelineState.xScale.invert(x0);
  const inv1 = timelineState.xScale.invert(x1);

  if (timelineState.bin === "month") {
    const startDate = d3.timeMonth.floor(inv0);
    let   endDate   = d3.timeMonth.ceil(inv1);
    if (endDate <= startDate) endDate = d3.timeMonth.offset(startDate, 1);
    activeBrushRange = [startDate, endDate];
  } else {
    const startDate = d3.timeMonday.floor(inv0);
    let   endDate   = d3.timeMonday.ceil(inv1);
    if (endDate <= startDate) endDate = d3.timeMonday.offset(startDate, 1);
    activeBrushRange = [startDate, endDate];
  }
  applyFilters();
}

function positionTimelineTooltip(event, html) {
  const tip = document.getElementById("timeline-tooltip");
  if (!tip) return;
  tip.innerHTML = html;
  tip.hidden    = false;
  const pad = 12;
  const w   = tip.offsetWidth;
  const h   = tip.offsetHeight;
  let left  = event.clientX + pad;
  let top   = event.clientY + pad;
  if (left + w > window.innerWidth  - 8) left = event.clientX - w - pad;
  if (top  + h > window.innerHeight - 8) top  = event.clientY - h - pad;
  tip.style.left = `${left}px`;
  tip.style.top  = `${top}px`;
}

function hideTimelineTooltip() {
  const tip = document.getElementById("timeline-tooltip");
  if (tip) { tip.hidden = true; tip.innerHTML = ""; }
}

function formatTimelineBarTooltip(d) {
  if (d.bin === "month") {
    const label = d3.timeFormat("%B %Y")(d.periodStart);
    return `<strong>${label}</strong><br>${formatCount(d.count)} requests`;
  }
  const endDay   = d3.timeDay.offset(d.periodEnd, -1);
  const rangeLabel =
    `${d3.timeFormat("%b %d, %Y")(d.periodStart)} – ${d3.timeFormat("%b %d, %Y")(endDay)}`;
  return `<strong>${rangeLabel}</strong><br>${formatCount(d.count)} requests`;
}

function renderTimeline(records) {
  const yearEl      = document.getElementById("timeline-year");
  const yearFilter  = yearEl && yearEl.value ? yearEl.value : "";
  const bin         = getTimelineBin();
  timelineState.bin = bin;

  const series    = buildTimelineSeries(records, bin, yearFilter);
  const container = document.getElementById("timeline-chart");
  const width     = Math.max(860, container.clientWidth || 860);
  const height    = 280;
  const margin    = { top: 14, right: 18, bottom: 48, left: 52 };

  d3.select("#timeline-chart").html("");

  if (series.length === 0) {
    d3.select("#timeline-chart")
      .append("p")
      .attr("class", "mini-empty")
      .text("No dated requests for this timeline selection.");
    timelineState.svg        = null;
    timelineState.brush      = null;
    timelineState.brushGroup = null;
    timelineState.xScale     = null;
    return;
  }

  const svg = d3.select("#timeline-chart")
    .append("svg")
    .attr("viewBox", `0 0 ${width} ${height}`)
    .attr("width",  "100%")
    .attr("height", height)
    .attr("font-family", '"IBM Plex Sans", system-ui, sans-serif');

  const xDomainStart = series[0].periodStart;
  const xDomainEnd   = series[series.length - 1].periodEnd;

  const xScale = d3.scaleTime()
    .domain([xDomainStart, xDomainEnd])
    .range([margin.left, width - margin.right]);

  const yScale = d3.scaleLinear()
    .domain([0, d3.max(series, d => d.count) || 1])
    .nice()
    .range([height - margin.bottom, margin.top]);

  const barWidth = d => Math.max(1, xScale(d.periodEnd) - xScale(d.periodStart) - 1);

  svg.append("g")
    .selectAll("rect")
    .data(series)
    .join("rect")
      .attr("class",  "timeline-bar")
      .attr("x",      d => xScale(d.periodStart))
      .attr("y",      d => yScale(d.count))
      .attr("width",  d => barWidth(d))
      .attr("height", d => yScale(0) - yScale(d.count))
      .on("mousemove",  (event, d) => positionTimelineTooltip(event, formatTimelineBarTooltip(d)))
      .on("mouseleave", hideTimelineTooltip);

  const xAxis = bin === "month"
    ? d3.axisBottom(xScale)
        .ticks(series.length > 48 ? d3.timeYear.every(2) : d3.timeYear.every(1))
        .tickFormat(d3.timeFormat("%Y"))
    : d3.axisBottom(xScale)
        .ticks(d3.timeMonth.every(1))
        .tickFormat(d3.timeFormat("%b"));

  svg.append("g")
    .attr("transform", `translate(0,${height - margin.bottom})`)
    .call(xAxis)
    .selectAll("path,line")
    .attr("class", "axis-path");

  svg.append("g")
    .attr("transform", `translate(${margin.left},0)`)
    .call(d3.axisLeft(yScale).ticks(6))
    .selectAll("path,line")
    .attr("class", "axis-line");

  const xAxisLabel = bin === "month"
    ? "Time (monthly bins; 2026 partial)"
    : `Time (weekly bins, ${yearFilter})`;

  svg.append("text")
    .attr("x",            width / 2)
    .attr("y",            height - 8)
    .attr("text-anchor",  "middle")
    .attr("fill",         "#64748b")
    .attr("font-size",    12)
    .text(xAxisLabel);

  svg.append("text")
    .attr("transform",   `translate(15,${height / 2}) rotate(-90)`)
    .attr("text-anchor", "middle")
    .attr("fill",        "#64748b")
    .attr("font-size",   12)
    .text("Requests per period");

  svg.selectAll(".tick text")
    .attr("fill",      "#64748b")
    .attr("font-size", 11);

  const brush = d3.brushX()
    .extent([
      [margin.left, margin.top],
      [width - margin.right, height - margin.bottom]
    ])
    .on("brush end", handleBrush);

  const brushGroup = svg.append("g")
    .attr("class", "brush")
    .call(brush);

  timelineState.svg        = svg;
  timelineState.brush      = brush;
  timelineState.brushGroup = brushGroup;
  timelineState.xScale     = xScale;
}


function applyFilters() {
  let next = allRecords.slice();

  if (filterServiceTypes.length > 0) {
    const st = new Set(filterServiceTypes);
    next = next.filter(r => st.has(r.srType));
  }

  const timelineYearEl = document.getElementById("timeline-year");
  const timelineYear   = timelineYearEl && timelineYearEl.value
    ? timelineYearEl.value.trim() : "";
  if (timelineYear) {
    const y = Number(timelineYear);
    next = next.filter(r => r.dateCreated && r.dateCreated.getFullYear() === y);
  }

  if (activeBrushRange) {
    next = next.filter(r => {
      if (!r.dateCreated) return false;
      return r.dateCreated >= activeBrushRange[0] && r.dateCreated < activeBrushRange[1];
    });
  }

  if (filterDepartment)        next = next.filter(r => r.deptName       === filterDepartment);
  if (filterNeighborhoods.length > 0) {
    const nh = new Set(filterNeighborhoods);
    next = next.filter(r => nh.has(r.neighborhood));
  }
  if (filterPriority)          next = next.filter(r => r.priority       === filterPriority);
  if (filterMethodReceived)    next = next.filter(r => r.methodReceived  === filterMethodReceived);

  if (mapSelectionBounds) {
    next = next.filter(r => {
      if (r.latitude == null || r.longitude == null) return false;
      return mapSelectionBounds.contains(L.latLng(r.latitude, r.longitude));
    });
  }

  filteredRecords = next;

  if (leafletMapInstance) leafletMapInstance.setFilteredData(filteredRecords);

  updateSummaryCharts();
  updateStatusPanel();

  if (typeof window.updateLevel3Charts === "function") {
    window.updateLevel3Charts(filteredRecords, getLevel3ActiveFilters());
  }
}


window.onLevel3Filter = function (field, value) {
  if (field === "neighborhood") {
    const idx = filterNeighborhoods.indexOf(value);
    if (idx === -1) {
      filterNeighborhoods.push(value);
      filterNeighborhoods.sort((a, b) =>
        a.localeCompare(b, undefined, { sensitivity: "base" })
      );
    } else {
      filterNeighborhoods.splice(idx, 1);
    }
    populateNeighborhoodDropdown();

  } else if (field === "method") {
    filterMethodReceived = filterMethodReceived === value ? "" : value;

  } else if (field === "dept") {
    filterDepartment = filterDepartment === value ? "" : value;
    const deptEl = document.getElementById("filter-dept");
    if (deptEl) deptEl.value = filterDepartment;

  } else if (field === "priority") {
    filterPriority = filterPriority === value ? "" : value;
    const prioEl = document.getElementById("filter-priority");
    if (prioEl) prioEl.value = filterPriority;

  } else if (field === "serviceType") {
    const idx = filterServiceTypes.indexOf(value);
    if (idx === -1) {
      filterServiceTypes.push(value);
    } else {
      filterServiceTypes.splice(idx, 1);
    }
    populateServiceTypesDropdown();
    updateServiceTypesButtonText();
  }

  applyFilters();
};


function wireUiEvents() {
  const colorModeSelect      = document.getElementById("color-mode");
  const basemapToggleButton  = document.getElementById("basemap-toggle");
  const mapModeToggleButton  = document.getElementById("map-mode-toggle");
  const clearBrushButton     = document.getElementById("clear-brush");
  const heatAvailable        = Boolean(leafletMapInstance && leafletMapInstance.heatLayer);
  const syncMapModeControls  = () => {
    if (!leafletMapInstance) return;
    const isPoints = leafletMapInstance.activeMapMode === "points";
    mapModeToggleButton.textContent = isPoints ? "Heatmap" : "Points";
    document.getElementById("map-mode-label").textContent = isPoints ? "Points" : "Heatmap";
    colorModeSelect.disabled = !isPoints;
  };

  if (!heatAvailable) {
    mapModeToggleButton.disabled    = true;
    mapModeToggleButton.textContent = "Heatmap N/A";
    document.getElementById("map-mode-label").textContent = "Points only";
  } else {
    syncMapModeControls();
  }

  colorModeSelect.addEventListener("change", event => {
    if (leafletMapInstance) leafletMapInstance.setColorMode(event.target.value);
    updateSummaryCharts();
  });

  const serviceTypesToggle = document.getElementById("service-types-toggle");
  const serviceTypesOptions = document.getElementById("service-types-options");
  if (serviceTypesToggle && serviceTypesOptions) {
    serviceTypesToggle.addEventListener("click", () => {
      const isHidden = serviceTypesOptions.hidden;
      serviceTypesOptions.hidden = !isHidden;
      serviceTypesToggle.setAttribute("aria-expanded", !isHidden);
    });

    // Close dropdown when clicking outside
    document.addEventListener("click", event => {
      if (!serviceTypesToggle.contains(event.target) && !serviceTypesOptions.contains(event.target)) {
        serviceTypesOptions.hidden = true;
        serviceTypesToggle.setAttribute("aria-expanded", "false");
      }
    });
  }

  if (!leafletMapInstance.cycleLayer) {
    basemapToggleButton.disabled = true;
    basemapToggleButton.title =
      "Set THUNDERFOREST_API_KEY (or THUNDERFOREST_API) in config.local.js. Allow your domain in the Thunderforest dashboard.";
  }

  basemapToggleButton.addEventListener("click", () => {
    if (!leafletMapInstance || !leafletMapInstance.cycleLayer) return;
    const activeBasemap = leafletMapInstance.toggleBasemap();
    const isStreet      = activeBasemap === "street";
    basemapToggleButton.textContent = isStreet ? "OpenCycleMap" : "Street map";
    const label = document.getElementById("basemap-label");
    if (label) label.textContent = isStreet ? "Street (OSM)" : "OpenCycleMap";
  });

  mapModeToggleButton.addEventListener("click", () => {
    if (!leafletMapInstance || !leafletMapInstance.heatLayer) return;
    const nextMode   = leafletMapInstance.activeMapMode === "points" ? "heat" : "points";
    const activeMode = leafletMapInstance.setMapMode(nextMode);
    const isPoints   = activeMode === "points";
    mapModeToggleButton.textContent = isPoints ? "Heatmap" : "Points";
    document.getElementById("map-mode-label").textContent = isPoints ? "Points" : "Heatmap";
    colorModeSelect.disabled = !isPoints;
    updateStatusPanel();
  });

  const mapDrawRegionBtn = document.getElementById("map-draw-region");
  if (mapDrawRegionBtn && leafletMapInstance) {
    mapDrawRegionBtn.addEventListener("click", () => {
      if (!leafletMapInstance) return;
      if (leafletMapInstance.activeMapMode !== "points") return;
      if (leafletMapInstance.moveRegionModeActive) {
        leafletMapInstance.setMoveRegionMode(false);
      }
      if (leafletMapInstance.brushModeActive) {
        leafletMapInstance.cancelBrushMode();
      } else {
        leafletMapInstance.setBrushMode(true);
      }
      updateStatusPanel();
    });
  }

  const mapClearRegionBtn = document.getElementById("map-clear-region");
  if (mapClearRegionBtn && leafletMapInstance) {
    mapClearRegionBtn.addEventListener("click", () => {
      if (!leafletMapInstance) return;
      leafletMapInstance.clearSpatialSelection();
    });
  }

  const mapMoveRegionBtn = document.getElementById("map-move-region");
  if (mapMoveRegionBtn && leafletMapInstance) {
    mapMoveRegionBtn.addEventListener("click", () => {
      if (!leafletMapInstance || !leafletMapInstance.selectionRect) return;
      if (leafletMapInstance.activeMapMode !== "points") return;
      leafletMapInstance.setMoveRegionMode(!leafletMapInstance.moveRegionModeActive);
      updateStatusPanel();
    });
  }

  document.addEventListener("keydown", event => {
    if (event.key !== "Escape") return;
    if (!leafletMapInstance) return;
    if (leafletMapInstance.moveRegionModeActive) {
      leafletMapInstance.setMoveRegionMode(false);
      updateStatusPanel();
      return;
    }
    if (!leafletMapInstance.brushModeActive) return;
    leafletMapInstance.cancelBrushMode();
  });

  clearBrushButton.addEventListener("click", () => {
    if (!timelineState.brushGroup || !timelineState.brush) return;
    timelineState.brushGroup.call(timelineState.brush.move, null);
  });

  const timelineYearEl = document.getElementById("timeline-year");
  if (timelineYearEl) {
    timelineYearEl.addEventListener("change", () => {
      activeBrushRange = null;
      if (timelineState.brushGroup && timelineState.brush) {
        timelineState.brushGroup.call(timelineState.brush.move, null);
      }
      renderTimeline(allRecords);
      applyFilters();
    });
  }

  const filterDept          = document.getElementById("filter-dept");
  const filterNeighborhoodEl = document.getElementById("filter-neighborhood");
  const filterPriorityEl    = document.getElementById("filter-priority");
  const clearFiltersButton  = document.getElementById("clear-filters");

  const onDeptPriorityChange = () => {
    filterDepartment = filterDept       ? filterDept.value       : "";
    filterPriority   = filterPriorityEl ? filterPriorityEl.value : "";
    applyFilters();
  };

  if (filterDept)       filterDept.addEventListener("change",       onDeptPriorityChange);
  if (filterPriorityEl) filterPriorityEl.addEventListener("change", onDeptPriorityChange);

  if (filterNeighborhoodEl) {
    filterNeighborhoodEl.addEventListener("change", () => {
      const v = filterNeighborhoodEl.value;
      if (!v) return;
      if (!filterNeighborhoods.includes(v)) {
        filterNeighborhoods.push(v);
        filterNeighborhoods.sort((a, b) =>
          a.localeCompare(b, undefined, { sensitivity: "base" })
        );
      }
      populateNeighborhoodDropdown();
      applyFilters();
    });
  }

  if (clearFiltersButton) {
    clearFiltersButton.addEventListener("click", () => {
      filterDepartment    = "";
      filterNeighborhoods = [];
      filterPriority = "";
      filterServiceTypes = ["PTHOLE"];
      if (filterDept) filterDept.value = "";
      if (filterPriorityEl) filterPriorityEl.value = "";
      populateNeighborhoodDropdown();
      populateServiceTypesDropdown();
      updateServiceTypesButtonText();
      applyFilters();
    });
  }

  const filterChipsEl = document.getElementById("filter-chips");
  const filterChipsScopeEl = document.getElementById("filter-chips-scope");
  
  const handleChipClick = (event) => {
    const chip = event.target.closest(".filter-chip");
    if (!chip || !chip.dataset.filterField) return;
    const field = chip.dataset.filterField;
    if (field === "filterDepartment") {
      filterDepartment = "";
      if (filterDept) filterDept.value = "";
    } else if (field === "filterNeighborhood" && chip.dataset.filterValue) {
      const v = chip.dataset.filterValue;
      filterNeighborhoods = filterNeighborhoods.filter(n => n !== v);
      populateNeighborhoodDropdown();
    } else if (field === "filterPriority") {
      filterPriority = "";
      if (filterPriorityEl) filterPriorityEl.value = "";
    } else if (field === "filterServiceType" && chip.dataset.filterValue) {
      const v = chip.dataset.filterValue;
      filterServiceTypes = filterServiceTypes.filter(st => st !== v);
      populateServiceTypesDropdown();
      updateServiceTypesButtonText();
    }
    applyFilters();
  };

  if (filterChipsEl) {
    filterChipsEl.addEventListener("click", event => {
      const chip = event.target.closest(".filter-chip");
      if (!chip || !chip.dataset.filterField) return;
      const field = chip.dataset.filterField;

      if (field === "filterDepartment") {
        filterDepartment = "";
        if (filterDept) filterDept.value = "";
      } else if (field === "filterNeighborhood" && chip.dataset.filterValue) {
        const v = chip.dataset.filterValue;
        filterNeighborhoods = filterNeighborhoods.filter(n => n !== v);
        populateNeighborhoodDropdown();
      } else if (field === "filterPriority") {
        filterPriority = "";
        if (filterPriorityEl) filterPriorityEl.value = "";
      } else if (field === "filterMethod") {
        filterMethodReceived = "";
      }
      applyFilters();
    });
    filterChipsEl.addEventListener("click", handleChipClick);
  }
  if (filterChipsScopeEl) {
    filterChipsScopeEl.addEventListener("click", handleChipClick);
  }
}


async function initializeApp() {
  setDataLoadProgress("Connecting to API…");
  const dataset = await loadRecords();
  dataSourceLabel   = dataset.sourceLabel;
  dataWarningMessage = dataset.warningMessage || "";

  allRecords      = dataset.records.slice();
  filteredRecords = allRecords.slice();
  filterServiceTypes = ["PTHOLE"];

  leafletMapInstance = new LeafletMap(
    {
      parentElement:    "#my-map",
      tooltipElement:   "#tooltip",
      legendElement:    "#legend",
      initialColorMode: "srType",
      initialBasemap:   "street",
      initialMapMode:   "points",
      targetServiceTypes: TARGET_SERVICE_TYPES,
      initialServiceTypeColors: loadServiceTypeColorsFromStorage(),
      onMapSelectionChange(bounds) {
        mapSelectionBounds = bounds;
        applyFilters();
      },
      onBrushSessionEnd() {
        updateStatusPanel();
      }
    },
    filteredRecords
  );

  const colorModeEl = document.getElementById("color-mode");
  if (colorModeEl) colorModeEl.value = leafletMapInstance.colorMode;

  if (!leafletMapInstance.heatLayer) {
    const heatWarning = "Heatmap plugin failed to load; points mode only.";
    dataWarningMessage = dataWarningMessage
      ? `${dataWarningMessage} ${heatWarning}`
      : heatWarning;
  }

  populateFilterSelects();
  populateServiceTypesDropdown();
  updateServiceTypesButtonText();
  populateTimelineYearSelect();
  applyDefaultTimelineYearSelection();
  applyFilters();
  renderTimeline(allRecords);
  wireUiEvents();

  const basemapLabel = document.getElementById("basemap-label");
  const basemapBtn   = document.getElementById("basemap-toggle");
  if (leafletMapInstance && basemapLabel && basemapBtn) {
    const street = leafletMapInstance.activeBasemap === "street";
    basemapLabel.textContent = street ? "Street (OSM)" : "OpenCycleMap";
    basemapBtn.textContent   = street ? "OpenCycleMap" : "Street map";
  }
}

initializeApp().catch(error => {
  console.error("Unable to initialize app", error);
  const warningEl = document.getElementById("data-warning");
  if (warningEl) {
    warningEl.textContent = "Failed to initialize the visualization.";
    warningEl.hidden = false;
  }
});
