const CATEGORICAL_COLORS = [
  "#4e79a7", "#f28e2b", "#59a14f", "#76b7b2",
  "#edc948", "#b07aa1", "#ff9da7", "#9c755f",
  "#bab0ac", "#499894"
];

const PRIORITY_COLORS = {
  "HAZARDOUS":    "#d97706",
  "PRIORITY":  "#4e79a7",
  "LOW":     "#94a3b8",
  "Unknown": "#cbd5e1"
};

const NEIGHBORHOOD_COLOR_SCALE = d3.scaleSequential(d3.interpolateBlues);


function l3FormatCount(v) {
  return d3.format(",")(v);
}

function rollupByField(records, accessor, limit) {
  const counts = d3.rollups(
    records,
    v => v.length,
    d => accessor(d) || "Unknown"
  ).sort((a, b) => d3.descending(a[1], b[1]));
  return typeof limit === "number" ? counts.slice(0, limit) : counts;
}

function emitFilter(field, value) {
  if (typeof window.onLevel3Filter === "function") {
    window.onLevel3Filter(field, value);
  }
}

function showEmpty(containerSel, msg) {
  containerSel.html("");
  containerSel.append("p")
    .attr("class", "mini-empty")
    .text(msg || "No data for current filter.");
}


function showL3Tooltip(event, html) {
  const tip = document.getElementById("tooltip");
  if (!tip) return;
  tip.innerHTML = html;
  tip.style.opacity = 1;
  tip.style.zIndex = 1000000;

  const pad = 12;
  const tw  = tip.offsetWidth  || 160;
  const th  = tip.offsetHeight || 60;
  let left  = event.pageX + pad;
  let top   = event.pageY + pad;
  if (left + tw > window.innerWidth  - 8) left = event.pageX - tw - pad;
  if (top  + th > window.innerHeight - 8) top  = event.pageY - th - pad;
  tip.style.left = `${left}px`;
  tip.style.top  = `${top}px`;
}

function hideL3Tooltip() {
  const tip = document.getElementById("tooltip");
  if (!tip) return;
  tip.style.opacity = 0;
  tip.style.zIndex = 0;
  tip.innerHTML = "";
}


function renderNeighborhoodChart(records, activeValue) {
  const TOP_N     = 20;
  const container = d3.select("#neighborhood-chart");
  container.html("");

  const rows = rollupByField(records, d => d.neighborhood, TOP_N);
  if (rows.length === 0) { showEmpty(container); return; }

  const maxCount = rows[0][1] || 1;
  NEIGHBORHOOD_COLOR_SCALE.domain([0, maxCount]);

  const ROW_HEIGHT = 26;
  const margin     = { top: 10, right: 64, bottom: 36, left: 148 };
  const width      = Math.max(400, container.node().clientWidth || 520);
  const innerW     = width - margin.left - margin.right;
  const innerH     = rows.length * ROW_HEIGHT;
  const height     = innerH + margin.top + margin.bottom;

  const svg = container.append("svg")
    .attr("viewBox", `0 0 ${width} ${height}`)
    .attr("width",  "100%")
    .attr("height", "auto")
    .attr("role",   "img")
    .attr("aria-label", "Top neighbourhoods by number of service requests");

  const g = svg.append("g")
    .attr("transform", `translate(${margin.left},${margin.top})`);

  const xScale = d3.scaleLinear().domain([0, maxCount]).range([0, innerW]).nice();
  const yScale = d3.scaleBand()
    .domain(rows.map(d => d[0]))
    .range([0, innerH])
    .padding(0.18);

  g.append("g").attr("class", "grid-lines")
    .selectAll("line")
    .data(xScale.ticks(5))
    .join("line")
      .attr("x1", d => xScale(d)).attr("x2", d => xScale(d))
      .attr("y1", 0).attr("y2", innerH)
      .attr("stroke", "var(--border)").attr("stroke-width", 1);

  g.selectAll(".nb-bar")
    .data(rows)
    .join("rect")
      .attr("class",  "nb-bar chart-bar")
      .attr("x",      0)
      .attr("y",      d => yScale(d[0]))
      .attr("height", yScale.bandwidth())
      .attr("width",  d => xScale(d[1]))
      .attr("fill",   d =>
        activeValue && d[0] === activeValue
          ? "#f28e2b"
          : NEIGHBORHOOD_COLOR_SCALE(d[1])
      )
      .attr("rx", 3)
      .style("cursor", "pointer")
      .on("click",      (_e, d) => emitFilter("neighborhood", d[0]))
      .on("mouseover",  function (_e, d) {
        d3.select(this).attr("opacity", 0.8);
        const pct = ((d[1] / d3.sum(rows, r => r[1])) * 100).toFixed(1);
        showL3Tooltip(_e,
          `<strong>${d[0]}</strong><br>${l3FormatCount(d[1])} requests (${pct}%)`
        );
      })
      .on("mousemove",  (e, d) => {
        const pct = ((d[1] / d3.sum(rows, r => r[1])) * 100).toFixed(1);
        showL3Tooltip(e,
          `<strong>${d[0]}</strong><br>${l3FormatCount(d[1])} requests (${pct}%)`
        );
      })
      .on("mouseleave", function () {
        d3.select(this).attr("opacity", 1);
        hideL3Tooltip();
      });

  g.selectAll(".nb-label")
    .data(rows)
    .join("text")
      .attr("class", "nb-label chart-count-label")
      .attr("x",  d => xScale(d[1]) + 4)
      .attr("y",  d => yScale(d[0]) + yScale.bandwidth() / 2)
      .attr("dy", "0.35em")
      .attr("font-size", 11)
      .attr("fill", "var(--muted-foreground)")
      .text(d => l3FormatCount(d[1]));

  g.append("g")
    .attr("class", "axis y-axis")
    .call(d3.axisLeft(yScale).tickSize(0).tickPadding(6))
    .call(ax => ax.select(".domain").remove())
    .selectAll("text")
      .attr("font-size", 12)
      .attr("fill", "var(--foreground)")
      .style("cursor", "pointer")
      .on("click", (_e, d) => emitFilter("neighborhood", d));

  g.append("g")
    .attr("class", "axis x-axis")
    .attr("transform", `translate(0,${innerH})`)
    .call(d3.axisBottom(xScale).ticks(5).tickFormat(d3.format(",d")))
    .call(ax => ax.select(".domain").remove())
    .selectAll("text")
      .attr("font-size", 11)
      .attr("fill", "var(--muted-foreground)");

  svg.append("text")
    .attr("x", margin.left + innerW / 2)
    .attr("y", height - 4)
    .attr("text-anchor", "middle")
    .attr("font-size", 11)
    .attr("fill", "var(--muted-foreground)")
    .text("Number of service requests");
}


function renderMethodChart(records, activeValue) {
  const container = d3.select("#method-chart");
  container.html("");

  const rows = rollupByField(records, d => d.methodReceived);
  if (rows.length === 0) { showEmpty(container); return; }

  const colorScale = d3.scaleOrdinal()
    .domain(rows.map(d => d[0]))
    .range(CATEGORICAL_COLORS);

  renderDonut(container, rows, colorScale, "method", activeValue);
}


function renderDepartmentChart(records, activeValue) {
  const container = d3.select("#dept-chart");
  container.html("");

  const rows = rollupByField(records, d => d.deptName);
  if (rows.length === 0) { showEmpty(container); return; }

  const maxCount   = rows[0][1] || 1;
  const colorScale = d3.scaleOrdinal()
    .domain(rows.map(d => d[0]))
    .range(CATEGORICAL_COLORS);

  const ROW_HEIGHT = 30;
  const margin     = { top: 10, right: 72, bottom: 36, left: 170 };
  const width      = Math.max(400, container.node().clientWidth || 520);
  const innerW     = width - margin.left - margin.right;
  const innerH     = rows.length * ROW_HEIGHT;
  const height     = innerH + margin.top + margin.bottom;

  const svg = container.append("svg")
    .attr("viewBox", `0 0 ${width} ${height}`)
    .attr("width",  "100%")
    .attr("height", "auto")
    .attr("role",   "img")
    .attr("aria-label", "Service requests by department");

  const g = svg.append("g")
    .attr("transform", `translate(${margin.left},${margin.top})`);

  const xScale = d3.scaleLinear().domain([0, maxCount]).range([0, innerW]).nice();
  const yScale = d3.scaleBand()
    .domain(rows.map(d => d[0]))
    .range([0, innerH])
    .padding(0.2);

  g.append("g").attr("class", "grid-lines")
    .selectAll("line")
    .data(xScale.ticks(5))
    .join("line")
      .attr("x1", d => xScale(d)).attr("x2", d => xScale(d))
      .attr("y1", 0).attr("y2", innerH)
      .attr("stroke", "var(--border)").attr("stroke-width", 1);

  g.selectAll(".dept-bar")
    .data(rows)
    .join("rect")
      .attr("class",  "dept-bar chart-bar")
      .attr("x",      0)
      .attr("y",      d => yScale(d[0]))
      .attr("height", yScale.bandwidth())
      .attr("width",  d => xScale(d[1]))
      .attr("fill",   d =>
        activeValue && d[0] === activeValue ? "#d97706" : colorScale(d[0])
      )
      .attr("rx", 3)
      .style("cursor", "pointer")
      .on("click",      (_e, d) => emitFilter("dept", d[0]))
      .on("mouseover",  function (e, d) {
        d3.select(this).attr("opacity", 0.8);
        const pct = ((d[1] / d3.sum(rows, r => r[1])) * 100).toFixed(1);
        showL3Tooltip(e,
          `<strong>${d[0]}</strong><br>${l3FormatCount(d[1])} requests (${pct}%)`
        );
      })
      .on("mousemove",  (e, d) => {
        const pct = ((d[1] / d3.sum(rows, r => r[1])) * 100).toFixed(1);
        showL3Tooltip(e,
          `<strong>${d[0]}</strong><br>${l3FormatCount(d[1])} requests (${pct}%)`
        );
      })
      .on("mouseleave", function () {
        d3.select(this).attr("opacity", 1);
        hideL3Tooltip();
      });

  g.selectAll(".dept-label")
    .data(rows)
    .join("text")
      .attr("class", "dept-label chart-count-label")
      .attr("x",  d => xScale(d[1]) + 5)
      .attr("y",  d => yScale(d[0]) + yScale.bandwidth() / 2)
      .attr("dy", "0.35em")
      .attr("font-size", 11)
      .attr("fill", "var(--muted-foreground)")
      .text(d => l3FormatCount(d[1]));

  g.append("g")
    .attr("class", "axis y-axis")
    .call(d3.axisLeft(yScale).tickSize(0).tickPadding(6))
    .call(ax => ax.select(".domain").remove())
    .selectAll("text")
      .attr("font-size", 12)
      .attr("fill", "var(--foreground)")
      .style("cursor", "pointer")
      .on("click", (_e, d) => emitFilter("dept", d));

  g.append("g")
    .attr("class", "axis x-axis")
    .attr("transform", `translate(0,${innerH})`)
    .call(d3.axisBottom(xScale).ticks(5).tickFormat(d3.format(",d")))
    .call(ax => ax.select(".domain").remove())
    .selectAll("text")
      .attr("font-size", 11)
      .attr("fill", "var(--muted-foreground)");

  svg.append("text")
    .attr("x", margin.left + innerW / 2)
    .attr("y", height - 4)
    .attr("text-anchor", "middle")
    .attr("font-size", 11)
    .attr("fill", "var(--muted-foreground)")
    .text("Number of service requests");
}


function renderPriorityChart(records, activeValue) {
  const container = d3.select("#priority-chart-l3");
  container.html("");

  const rows = rollupByField(records, d => d.priority);
  if (rows.length === 0) { showEmpty(container); return; }

  const colorScale = d3.scaleOrdinal()
    .domain(Object.keys(PRIORITY_COLORS))
    .range(Object.values(PRIORITY_COLORS))
    .unknown("#cbd5e1");

  renderDonut(container, rows, colorScale, "priority", activeValue);
}


function renderDonut(container, rows, colorScale, filterField, activeValue) {
  const total      = d3.sum(rows, d => d[1]);
  const width      = Math.max(360, container.node().clientWidth || 400);
  const height     = 300;
  const legendItemH = 22;
  const legendH    = Math.ceil(rows.length / 2) * legendItemH + 8;
  const totalH     = height + legendH;
  const cx = width / 2;
  const cy = height / 2;
  const outerR  = Math.min(cx, cy) - 18;
  const innerR  = outerR * 0.55;

  const svg = container.append("svg")
    .attr("viewBox", `0 0 ${width} ${totalH}`)
    .attr("width",  "100%")
    .attr("height", "auto")
    .attr("role",   "img")
    .attr("aria-label", "Donut chart");

  const pie = d3.pie().value(d => d[1]).sort(null).padAngle(0.018);
  const arc      = d3.arc().innerRadius(innerR).outerRadius(outerR);
  const arcHover = d3.arc().innerRadius(innerR).outerRadius(outerR + 7);

  const g = svg.append("g").attr("transform", `translate(${cx},${cy})`);

  g.selectAll(".donut-slice")
    .data(pie(rows))
    .join("path")
      .attr("class", "donut-slice")
      .attr("d", arc)
      .attr("fill", d =>
        activeValue && d.data[0] === activeValue
          ? d3.color(colorScale(d.data[0])).darker(0.6)
          : colorScale(d.data[0])
      )
      .attr("stroke", "var(--card)").attr("stroke-width", 2)
      .style("cursor", "pointer")
      .on("click",      (_e, d) => emitFilter(filterField, d.data[0]))
      .on("mouseover",  function (e, d) {
        d3.select(this).attr("d", arcHover);
        const pct = ((d.data[1] / total) * 100).toFixed(1);
        showL3Tooltip(e,
          `<strong>${d.data[0]}</strong><br>${l3FormatCount(d.data[1])} requests (${pct}%)`
        );
      })
      .on("mousemove",  (e, d) => {
        const pct = ((d.data[1] / total) * 100).toFixed(1);
        showL3Tooltip(e,
          `<strong>${d.data[0]}</strong><br>${l3FormatCount(d.data[1])} requests (${pct}%)`
        );
      })
      .on("mouseleave", function () {
        d3.select(this).attr("d", arc);
        hideL3Tooltip();
      });

  g.append("text")
    .attr("text-anchor", "middle").attr("dy", "-0.2em")
    .attr("font-size", 22).attr("font-weight", 700)
    .attr("fill", "var(--foreground)")
    .text(l3FormatCount(total));

  g.append("text")
    .attr("text-anchor", "middle").attr("dy", "1.3em")
    .attr("font-size", 12)
    .attr("fill", "var(--muted-foreground)")
    .text("total requests");

  const legendW = width * 0.8;
  const cols    = rows.length > 5 ? 2 : 1;
  const colW    = legendW / cols;

  const legend = svg.append("g")
    .attr("class", "donut-legend")
    .attr("transform", `translate(${width * 0.1},${height + 8})`);

  rows.forEach((d, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);

    const item = legend.append("g")
      .attr("transform", `translate(${col * colW},${row * legendItemH})`)
      .style("cursor", "pointer")
      .on("click", () => emitFilter(filterField, d[0]));

    item.append("rect")
      .attr("width", 13).attr("height", 13).attr("rx", 3).attr("y", -1)
      .attr("fill", colorScale(d[0]));

    item.append("text")
      .attr("x", 19).attr("dy", "0.85em")
      .attr("font-size", 12)
      .attr("fill", "var(--foreground)")
      .text(`${d[0]} (${l3FormatCount(d[1])})`);
  });
}


function updateLevel3Charts(records, activeFilters = {}) {
  renderNeighborhoodChart(records, activeFilters.neighborhood || "");
  renderMethodChart(records,       activeFilters.method       || "");
  renderDepartmentChart(records,   activeFilters.dept         || "");
  renderPriorityChart(records,     activeFilters.priority     || "");
}

window.updateLevel3Charts = updateLevel3Charts;