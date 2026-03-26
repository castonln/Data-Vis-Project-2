"use strict";

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
const TARGET_SERVICE_TYPE = "PTHOLE";
const DATE_RANGE_START = "2004-01-01T00:00:00.000";
const DATE_RANGE_END = "2026-12-31T23:59:59.999";
const SOCRATA_CSV_PAGE_LIMIT = 50000;

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

// ─── App state ────────────────────────────────────────────────────────────────

let leafletMapInstance = null;
let allRecords         = [];
let filteredRecords    = [];
let activeBrushRange   = null;

let filterDepartment     = "";
let filterNeighborhoods  = [];
let filterPriority       = "";
let filterMethodReceived = "";   // ← Level 3 method filter

let dataSourceLabel   = "Unknown";
let dataWarningMessage = "";

const timelineState = {
  svg: null,
  brush: null,
  brushGroup: null,
  xScale: null,
  bin: "month"
};

// ─── Data helpers ─────────────────────────────────────────────────────────────

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

// ─── Data loading ─────────────────────────────────────────────────────────────

function setDataLoadProgress(message) {
  const el = document.getElementById("data-source");
  if (el) el.textContent = message;
}

async function requestSocrataCsv(url) {
  const headers = {};
  if (SOCRATA_APP_TOKEN && !omitSocrataAppToken) {
    headers["X-App-Token"] = SOCRATA_APP_TOKEN;
  }

  setDataLoadProgress("Loading from API…");
  const response = await fetch(url, { headers });
  const text = await response.text();

  if (!response.ok) {
    let portalMsg = "";
    try {
      const err = JSON.parse(text);
      if (err && typeof err === "object" && err.message) portalMsg = String(err.message);
    } catch { /* plain text is fine */ }

    if (
      response.status === 403 &&
      SOCRATA_APP_TOKEN &&
      !omitSocrataAppToken &&
      /invalid app_token/i.test(portalMsg)
    ) {
      omitSocrataAppToken = true;
      return requestSocrataCsv(url);
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

  let rows;
  try {
    rows = d3.csvParse(text);
  } catch (parseErr) {
    const hint = parseErr instanceof Error ? parseErr.message : String(parseErr);
    throw new Error(`Socrata returned CSV that could not be parsed: ${hint}`);
  }

  if (!Array.isArray(rows)) throw new Error("Socrata CSV parse did not return rows.");

  setDataLoadProgress(`Loading from API… ${formatCount(rows.length)} rows`);
  return rows;
}

async function fetchAllSocrataRecords() {
  omitSocrataAppToken = false;
  const whereClause = `sr_type='${TARGET_SERVICE_TYPE}' AND date_created between '${DATE_RANGE_START}' and '${DATE_RANGE_END}'`;
  const allRows = [];
  let offset = 0;
  const maxPages = 50;

  for (let p = 0; p < maxPages; p++) {
    const params = new URLSearchParams({
      $select: SELECT_FIELDS.join(","),
      $where:  whereClause,
      $order:  ":id",
      $limit:  String(SOCRATA_CSV_PAGE_LIMIT),
      $offset: String(offset)
    });
    const url = `https://${SOCRATA_DOMAIN}/resource/${DATASET_ID}.csv?${params.toString()}`;
    const rows = await requestSocrataCsv(url);
    allRows.push(...rows);
    setDataLoadProgress(`Loading from API… ${formatCount(allRows.length)} rows`);
    if (rows.length === 0 || rows.length < SOCRATA_CSV_PAGE_LIMIT) break;
    offset += SOCRATA_CSV_PAGE_LIMIT;
  }

  return allRows;
}

function isPotholeFromCsv(record) {
  const type     = getValue(record, ["SR_TYPE",     "sr_type"])     || "";
  const typeDesc = getValue(record, ["SR_TYPE_DESC","sr_type_desc"]) || "";
  return type.toUpperCase() === TARGET_SERVICE_TYPE || typeDesc.toUpperCase().includes("POTHOLE");
}

async function fetchFallbackCsv() {
  const csvData = await d3.csv("data/311Sample.csv");
  return csvData.filter(record => isPotholeFromCsv(record));
}

async function loadRecords() {
  try {
    const liveRecords = await fetchAllSocrataRecords();
    return { sourceLabel: "Live API", warningMessage: "", records: normalizeAll(liveRecords) };
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
    return {
      sourceLabel:    "Fallback sample CSV",
      warningMessage: `Live API did not load. ${detail} Showing local sample CSV instead.`,
      records:        normalizeAll(fallbackRecords)
    };
  }
}

// ─── Formatters ───────────────────────────────────────────────────────────────

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

// ─── Filter chips & dropdowns ────────────────────────────────────────────────

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
  const el = document.getElementById("filter-chips");
  if (!el) return;

  const items = [];
  if (filterDepartment)
    items.push({ field: "filterDepartment", label: "Dept",     value: filterDepartment });
  filterNeighborhoods.forEach(n =>
    items.push({ field: "filterNeighborhood", label: "Area",   value: n, filterValue: n })
  );
  if (filterPriority)
    items.push({ field: "filterPriority",    label: "Priority", value: filterPriority });
  if (filterMethodReceived)
    items.push({ field: "filterMethod",      label: "Method",   value: filterMethodReceived });

  el.innerHTML = "";
  if (items.length === 0) { el.hidden = true; return; }

  el.hidden = false;
  items.forEach(({ field, label, value, filterValue }) => {
    const btn = document.createElement("button");
    btn.type      = "button";
    btn.className = field === "filterNeighborhood"
      ? "filter-chip filter-chip-neighborhood"
      : "filter-chip";
    btn.dataset.filterField = field;
    if (field === "filterNeighborhood" && filterValue !== undefined) {
      btn.dataset.filterValue = filterValue;
    }
    btn.setAttribute(
      "aria-label",
      field === "filterNeighborhood"
        ? `Remove neighborhood: ${value}`
        : `Remove ${label} filter: ${value}`
    );
    const span = document.createElement("span");
    span.textContent = field === "filterNeighborhood" ? value : `${label}: ${value}`;
    const x = document.createElement("span");
    x.className = "filter-chip-x";
    x.setAttribute("aria-hidden", "true");
    x.textContent = "×";
    btn.append(span, x);
    el.appendChild(btn);
  });
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

// ─── Status panel ─────────────────────────────────────────────────────────────

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
    partialEl.hidden = !allRecords.some(
      r => r.dateCreated && r.dateCreated.getFullYear() === 2026
    );
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

  // Level 3 record-count badge
  const countBadge = document.getElementById("l3-record-count");
  if (countBadge) countBadge.textContent = formatCount(filteredRecords.length);
}

// ─── Mini summary charts (sidebar) ───────────────────────────────────────────

function renderCategoryChart(containerId, records, accessor, limit) {
  const container = d3.select(containerId);
  container.html("");

  const counts = d3.rollups(records, values => values.length, d => accessor(d) || "Unknown")
    .sort((a, b) => d3.descending(a[1], b[1]));

  const rows = typeof limit === "number" ? counts.slice(0, limit) : counts;
  if (rows.length === 0) {
    container.append("p").attr("class", "mini-empty").text("No data in current filter.");
    return;
  }

  const maxCount = rows[0][1] || 1;
  rows.forEach(([label, count]) => {
    const row = container.append("div").attr("class", "mini-row");
    row.append("div").attr("class", "mini-label").text(label);
    const barWrap = row.append("div").attr("class", "mini-bar-wrap");
    barWrap.append("div")
      .attr("class", "mini-bar")
      .style("width", `${(count / maxCount) * 100}%`);
    row.append("div").attr("class", "mini-value").text(formatCount(count));
  });
}

function updateSummaryCharts() {
  renderCategoryChart("#methods-chart", filteredRecords, d => d.methodReceived, 7);
  renderCategoryChart("#depts-chart",   filteredRecords, d => d.deptName,       7);
  renderCategoryChart("#priority-chart",filteredRecords, d => d.priority,       null);
}

// ─── Timeline ─────────────────────────────────────────────────────────────────

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
    .attr("height", "auto")
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

// ─── Core filter pipeline ─────────────────────────────────────────────────────

function applyFilters() {
  let next = allRecords.slice();

  // Timeline year scope
  const timelineYearEl = document.getElementById("timeline-year");
  const timelineYear   = timelineYearEl && timelineYearEl.value
    ? timelineYearEl.value.trim() : "";
  if (timelineYear) {
    const y = Number(timelineYear);
    next = next.filter(r => r.dateCreated && r.dateCreated.getFullYear() === y);
  }

  // Brush date range
  if (activeBrushRange) {
    next = next.filter(r => {
      if (!r.dateCreated) return false;
      return r.dateCreated >= activeBrushRange[0] && r.dateCreated < activeBrushRange[1];
    });
  }

  // Attribute filters
  if (filterDepartment)        next = next.filter(r => r.deptName       === filterDepartment);
  if (filterNeighborhoods.length > 0) {
    const nh = new Set(filterNeighborhoods);
    next = next.filter(r => nh.has(r.neighborhood));
  }
  if (filterPriority)          next = next.filter(r => r.priority       === filterPriority);
  if (filterMethodReceived)    next = next.filter(r => r.methodReceived  === filterMethodReceived);

  filteredRecords = next;

  // Push to map
  if (leafletMapInstance) leafletMapInstance.setFilteredData(filteredRecords);

  // Update all views
  updateSummaryCharts();
  updateStatusPanel();

  // Level 3 dedicated charts
  if (typeof window.updateLevel3Charts === "function") {
    window.updateLevel3Charts(filteredRecords, {
      neighborhood: filterNeighborhoods[0] || "",
      method:       filterMethodReceived,
      dept:         filterDepartment,
      priority:     filterPriority
    });
  }
}

// ─── Level 3 click-to-filter hook ────────────────────────────────────────────

window.onLevel3Filter = function (field, value) {
  // Toggle: clicking an already-active value clears it
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
  }

  applyFilters();
};

// ─── UI event wiring ──────────────────────────────────────────────────────────

function wireUiEvents() {
  const colorModeSelect      = document.getElementById("color-mode");
  const basemapToggleButton  = document.getElementById("basemap-toggle");
  const mapModeToggleButton  = document.getElementById("map-mode-toggle");
  const clearBrushButton     = document.getElementById("clear-brush");
  const heatAvailable        = Boolean(leafletMapInstance && leafletMapInstance.heatLayer);

  if (!heatAvailable) {
    mapModeToggleButton.disabled    = true;
    mapModeToggleButton.textContent = "Heatmap N/A";
    document.getElementById("map-mode-label").textContent = "Points only";
  }

  colorModeSelect.addEventListener("change", event => {
    if (leafletMapInstance) leafletMapInstance.setColorMode(event.target.value);
  });

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
      filterPriority      = "";
      filterMethodReceived = "";
      if (filterDept)       filterDept.value       = "";
      if (filterPriorityEl) filterPriorityEl.value = "";
      populateNeighborhoodDropdown();
      applyFilters();
    });
  }

  const filterChipsEl = document.getElementById("filter-chips");
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
  }
}

// ─── App bootstrap ────────────────────────────────────────────────────────────

async function initializeApp() {
  setDataLoadProgress("Connecting to API…");
  const dataset = await loadRecords();
  dataSourceLabel   = dataset.sourceLabel;
  dataWarningMessage = dataset.warningMessage || "";

  allRecords      = dataset.records.slice();
  filteredRecords = allRecords.slice();

  leafletMapInstance = new LeafletMap(
    {
      parentElement:    "#my-map",
      tooltipElement:   "#tooltip",
      legendElement:    "#legend",
      initialColorMode: "daysToUpdate",
      initialBasemap:   "street",
      initialMapMode:   "points"
    },
    filteredRecords
  );

  if (!leafletMapInstance.heatLayer) {
    const heatWarning = "Heatmap plugin failed to load; points mode only.";
    dataWarningMessage = dataWarningMessage
      ? `${dataWarningMessage} ${heatWarning}`
      : heatWarning;
  }

  populateFilterSelects();
  populateTimelineYearSelect();
  renderTimeline(allRecords);
  updateSummaryCharts();
  updateStatusPanel();
  wireUiEvents();

  // Sync basemap button label
  const basemapLabel = document.getElementById("basemap-label");
  const basemapBtn   = document.getElementById("basemap-toggle");
  if (leafletMapInstance && basemapLabel && basemapBtn) {
    const street = leafletMapInstance.activeBasemap === "street";
    basemapLabel.textContent = street ? "Street (OSM)" : "OpenCycleMap";
    basemapBtn.textContent   = street ? "OpenCycleMap" : "Street map";
  }

  // Initial Level 3 render
  if (typeof window.updateLevel3Charts === "function") {
    window.updateLevel3Charts(filteredRecords, {});
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