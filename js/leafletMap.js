function defaultServiceTypeColorEntries() {
  return [
    ["PTHOLE",   "#e11d48"],
    ["PLMB_DEF", "#0ea5e9"],
    ["MTL-FRN",  "#10b981"],
    ["SEWAG_EX", "#1a1a1a"],
    ["GRFITI",   "#8b5cf6"],
    ["RCYCLNG",  "#eab308"],
    ["Unknown",  "#6b7280"]
  ];
}

class LeafletMap {
  constructor(_config, _data) {
    this.config = {
      parentElement: _config.parentElement,
      tooltipElement: _config.tooltipElement || "#tooltip",
      legendElement: _config.legendElement || "#legend",
      initialColorMode: _config.initialColorMode || "daysToUpdate",
      initialBasemap: _config.initialBasemap || "street",
      initialMapMode: _config.initialMapMode || "points",
      targetServiceTypes: Array.isArray(_config.targetServiceTypes) ? _config.targetServiceTypes : [],
      onMapSelectionChange:
        typeof _config.onMapSelectionChange === "function" ? _config.onMapSelectionChange : () => {},
      onBrushSessionEnd:
        typeof _config.onBrushSessionEnd === "function" ? _config.onBrushSessionEnd : () => {}
    };

    this._initServiceTypeColors(_config.initialServiceTypeColors);

    this.brushModeActive = false;
    this.selectionRect = null;
    this._brushStartLatLng = null;
    this._previewRect = null;
    this._brushDocHandlers = null;

    this.moveRegionModeActive = false;
    this._moveStartLatLng = null;
    this._moveInitialBounds = null;
    this._moveRegionDocHandlers = null;

    this.data = _data || [];
    this.filteredData = this.data.slice();
    this.mappedData = this.filteredData.filter(d => d.latitude !== null && d.longitude !== null);
    this.applyDisplayCap();

    this.colorMode = this.config.initialColorMode;
    this.activeBasemap = this.config.initialBasemap;
    this.activeMapMode = this.config.initialMapMode;
    this.initialBoundsApplied = false;

    this.tooltip = d3.select(this.config.tooltipElement);
    this.legendContainer = d3.select(this.config.legendElement);

    this.initVis();
  }

  _initServiceTypeColors(overrides) {
    this.serviceTypeColors = new Map(defaultServiceTypeColorEntries());
    if (overrides && typeof overrides === "object") {
      for (const [k, v] of Object.entries(overrides)) {
        if (typeof v === "string" && /^#[0-9A-Fa-f]{6}$/.test(v)) {
          this.serviceTypeColors.set(k, v.toLowerCase());
        }
      }
    }
  }

  getServiceTypeColor(srType) {
    const key = srType || "Unknown";
    return this.serviceTypeColors.get(key) || "#64748b";
  }

  getServiceTypeColorsObject() {
    return Object.fromEntries(this.serviceTypeColors);
  }

  setServiceTypeColor(srType, hex) {
    if (!srType || !this.serviceTypeColors.has(srType)) return;
    const h = String(hex).trim();
    if (!/^#[0-9A-Fa-f]{6}$/.test(h)) return;
    this.serviceTypeColors.set(srType, h.toLowerCase());
    if (this.colorMode === "srType" || this.colorMode === "daysToUpdate") {
      this.updateColors();
      this.renderLegend();
    }
  }

  initVis() {
    const vis = this;

    vis.streetLayer = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap contributors"
    });

    const appCfg = typeof window !== "undefined" ? window.APP_CONFIG || {} : {};
    const tfKey = String(
      appCfg.THUNDERFOREST_API_KEY || appCfg.THUNDERFOREST_API || ""
    ).trim();
    vis.cycleLayer = tfKey
      ? L.tileLayer(
        `https://{s}.tile.thunderforest.com/cycle/{z}/{x}/{y}{r}.png?apikey=${encodeURIComponent(tfKey)}`,
        {
          subdomains: "abc",
          attribution:
            '&copy; <a href="https://www.thunderforest.com/">Thunderforest</a>, &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
          maxZoom: 22
        }
      )
      : null;

    if (vis.cycleLayer) {
      vis.cycleLayer.on("tileerror", () => {
        if (!vis._tfTileErrorLogged) {
          vis._tfTileErrorLogged = true;
          console.warn(
            "Thunderforest tiles failed to load. Check THUNDERFOREST_API_KEY in config.local.js, " +
              "that the key is active, and that this origin is allowed in your Thunderforest account (localhost / deployment domain)."
          );
        }
      });
    }

    const wantCycle = vis.activeBasemap === "cycle" && vis.cycleLayer;
    const initialLayer = wantCycle ? vis.cycleLayer : vis.streetLayer;

    vis.theMap = L.map(vis.config.parentElement.replace("#", ""), {
      center: [39.1031, -84.5120],
      zoom: 12,
      minZoom: 9,
      maxZoom: 19,
      maxBounds: [[38.85, -85.05], [39.42, -84.15]],
      maxBoundsViscosity: 0.85,
      layers: [initialLayer]
    });

    L.control.scale({ imperial: true, metric: true }).addTo(vis.theMap);
    L.svg({ clickable: true }).addTo(vis.theMap);

    vis.overlay = d3.select(vis.theMap.getPanes().overlayPane);
    vis.svg = vis.overlay.select("svg");
    vis.pointLayer = vis.svg.append("g").attr("class", "map-points-layer");
    vis.setSvgPointerEventsForInteraction();

    // Keep the heat surface below the SVG overlay so interaction targets stay available.
    const heatPane = vis.theMap.createPane("heatmap");
    heatPane.style.zIndex = 350;

    if (typeof L.heatLayer === "function") {
      vis.heatLayer = L.heatLayer([], {
        pane: "heatmap",
        radius: 28,
        blur: 20,
        maxZoom: 18,
        minOpacity: 0.5,
        gradient: {
          0.15: "#1e40af",
          0.38: "#3b82f6",
          0.68: "#f59e0b",
          1: "#b45309"
        }
      });
    } else {
      vis.heatLayer = null;
      vis.activeMapMode = "points";
    }

    vis.setColorMode(vis.colorMode);
    vis.updatePointLayer();
    vis.updateHeatLayer();
    vis.setMapMode(vis.activeMapMode);

    vis.theMap.on("zoomend moveend viewreset", () => vis.updateVis());

    if (vis.mappedData.length > 0) {
      const bounds = L.latLngBounds(vis.mappedData.map(d => [d.latitude, d.longitude]));
      vis.theMap.fitBounds(bounds.pad(0.05));
      vis.initialBoundsApplied = true;
    }

    vis._installMapBrush();
    vis._installRegionMoveDrag();
  }

  _getMapContainerEl() {
    return document.getElementById(this.config.parentElement.replace("#", ""));
  }

  _setBrushCursor(on) {
    const el = this._getMapContainerEl();
    if (el) el.classList.toggle("map-brush-mode", on);
  }

  setSvgPointerEventsForInteraction() {
    const pointsVisible = this.activeMapMode === "points";
    const allowPoints = pointsVisible && !this.brushModeActive;
    this.svg.attr("pointer-events", allowPoints ? "auto" : "none");
  }

  _cancelBrushDrag() {
    const map = this.theMap;
    if (this._brushDocHandlers) {
      document.removeEventListener("mousemove", this._brushDocHandlers.move);
      document.removeEventListener("mouseup", this._brushDocHandlers.up);
      this._brushDocHandlers = null;
    }
    if (this._previewRect) {
      map.removeLayer(this._previewRect);
      this._previewRect = null;
    }
    this._brushStartLatLng = null;
    map.dragging.enable();
  }

  cancelBrushMode() {
    const wasActive = this.brushModeActive || this._brushStartLatLng;
    this.brushModeActive = false;
    this._cancelBrushDrag();
    this._setBrushCursor(false);
    this.setSvgPointerEventsForInteraction();
    if (wasActive) this.config.onBrushSessionEnd();
  }

  setBrushMode(enabled) {
    if (!enabled) {
      this.cancelBrushMode();
      return;
    }
    this.setMoveRegionMode(false);
    this.brushModeActive = true;
    this._setBrushCursor(true);
    this.setSvgPointerEventsForInteraction();
    this.config.onBrushSessionEnd();
  }

  applySpatialSelection(bounds) {
    if (this.selectionRect) {
      this.theMap.removeLayer(this.selectionRect);
    }
    this.selectionRect = L.rectangle(bounds, {
      color: "#2563eb",
      weight: 2,
      fillOpacity: 0.08,
      interactive: false
    }).addTo(this.theMap);
    this.config.onMapSelectionChange(bounds);
  }

  _cancelMoveRegionDrag() {
    if (this._moveRegionDocHandlers) {
      document.removeEventListener("mousemove", this._moveRegionDocHandlers.move);
      document.removeEventListener("mouseup", this._moveRegionDocHandlers.up);
      this._moveRegionDocHandlers = null;
    }
    if (this.theMap) this.theMap.dragging.enable();
    this._moveStartLatLng = null;
    this._moveInitialBounds = null;
  }

  setMoveRegionMode(enabled) {
    if (!enabled) {
      this._cancelMoveRegionDrag();
      this.moveRegionModeActive = false;
      const elOff = this._getMapContainerEl();
      if (elOff) elOff.classList.remove("map-move-region-mode");
      this.config.onBrushSessionEnd();
      return;
    }
    if (this.activeMapMode !== "points" || !this.selectionRect) return;
    this.cancelBrushMode();
    this.moveRegionModeActive = true;
    const elOn = this._getMapContainerEl();
    if (elOn) elOn.classList.add("map-move-region-mode");
    this.config.onBrushSessionEnd();
  }

  clearSpatialSelection() {
    this.cancelBrushMode();
    this.setMoveRegionMode(false);
    if (this.selectionRect) {
      this.theMap.removeLayer(this.selectionRect);
      this.selectionRect = null;
    }
    this.config.onMapSelectionChange(null);
  }

  _installMapBrush() {
    const vis = this;
    const map = vis.theMap;
    const container = map.getContainer();

    const onDown = e => {
      if (!vis.brushModeActive || e.button !== 0) return;
      L.DomEvent.preventDefault(e);
      L.DomEvent.stop(e);
      map.dragging.disable();
      vis._brushStartLatLng = map.mouseEventToLatLng(e);
      vis._previewRect = L.rectangle([vis._brushStartLatLng, vis._brushStartLatLng], {
        color: "#2563eb",
        weight: 2,
        fillOpacity: 0.14,
        interactive: false
      }).addTo(map);

      const onMove = moveEv => {
        if (!vis._brushStartLatLng || !vis._previewRect) return;
        const cur = map.mouseEventToLatLng(moveEv);
        vis._previewRect.setBounds(L.latLngBounds(vis._brushStartLatLng, cur));
      };

      const onUp = upEv => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        vis._brushDocHandlers = null;

        const start = vis._brushStartLatLng;
        if (vis._previewRect) {
          map.removeLayer(vis._previewRect);
          vis._previewRect = null;
        }
        vis._brushStartLatLng = null;
        map.dragging.enable();

        if (!start) return;

        const cur = map.mouseEventToLatLng(upEv);
        const b = L.latLngBounds(start, cur);

        vis.brushModeActive = false;
        vis._setBrushCursor(false);
        vis.setSvgPointerEventsForInteraction();

        const nw = map.latLngToContainerPoint(b.getNorthWest());
        const se = map.latLngToContainerPoint(b.getSouthEast());
        if (Math.abs(nw.x - se.x) < 5 && Math.abs(nw.y - se.y) < 5) {
          vis.config.onBrushSessionEnd();
          return;
        }

        vis.applySpatialSelection(b);
      };

      vis._brushDocHandlers = { move: onMove, up: onUp };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    };
    container.addEventListener("mousedown", onDown, true);
  }

  _installRegionMoveDrag() {
    const vis = this;
    const map = vis.theMap;
    const container = map.getContainer();

    const onDown = e => {
      if (!vis.moveRegionModeActive || e.button !== 0) return;
      if (!vis.selectionRect) return;
      const ll = map.mouseEventToLatLng(e);
      const b = vis.selectionRect.getBounds();
      if (!b.contains(ll)) return;
      L.DomEvent.preventDefault(e);
      L.DomEvent.stop(e);
      map.dragging.disable();
      vis._moveStartLatLng = ll;
      vis._moveInitialBounds = L.latLngBounds(b.getSouthWest(), b.getNorthEast());

      const onMove = moveEv => {
        if (!vis._moveStartLatLng || !vis._moveInitialBounds || !vis.selectionRect) return;
        const cur = map.mouseEventToLatLng(moveEv);
        const dLat = cur.lat - vis._moveStartLatLng.lat;
        const dLng = cur.lng - vis._moveStartLatLng.lng;
        const sw = vis._moveInitialBounds.getSouthWest();
        const ne = vis._moveInitialBounds.getNorthEast();
        const nb = L.latLngBounds(
          [sw.lat + dLat, sw.lng + dLng],
          [ne.lat + dLat, ne.lng + dLng]
        );
        vis.selectionRect.setBounds(nb);
      };

      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        vis._moveRegionDocHandlers = null;
        map.dragging.enable();
        vis._moveStartLatLng = null;
        vis._moveInitialBounds = null;
        if (vis.selectionRect) {
          vis.config.onMapSelectionChange(vis.selectionRect.getBounds());
        }
      };

      vis._moveRegionDocHandlers = { move: onMove, up: onUp };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    };

    container.addEventListener("mousedown", onDown, true);
  }

  /** Limit SVG points so pan/zoom stays responsive (full data still drives legend scales). */
  applyDisplayCap() {
    const SVG_CAP = 12000;
    if (this.mappedData.length > SVG_CAP) {
      const step = Math.ceil(this.mappedData.length / SVG_CAP);
      this.mappedDataDisplay = this.mappedData.filter((_, i) => i % step === 0);
    } else {
      this.mappedDataDisplay = this.mappedData;
    }
  }

  formatDate(dateValue) {
    if (!dateValue) return "N/A";
    return d3.timeFormat("%b %d, %Y")(dateValue);
  }

  tooltipHtml(d) {
    const daysLabel = Number.isFinite(d.daysToUpdate) ? d3.format(".1f")(d.daysToUpdate) : "N/A";
    const heavyTrashRows = [];

    if (d.srType === "MTL-FRN" && (d.numBulkyItems > 0 || d.bulkyItems.length > 0)) {
      const summary = d.heavyTrashCategories && d.heavyTrashCategories.length
        ? Array.from(new Set(d.heavyTrashCategories)).join(", ")
        : "Detailed bulky-item categories unavailable";
      heavyTrashRows.push(
        `<div class="tooltip-row"><strong>Bulky items:</strong> ${d.numBulkyItems || d.bulkyItems.length}</div>`
      );
      heavyTrashRows.push(
        `<div class="tooltip-row"><strong>Heavy trash mix:</strong> ${summary}</div>`
      );
    }

    return `
      <div class="tooltip-title">${d.srTypeDesc}</div>
      <div class="tooltip-row"><strong>Request #:</strong> ${d.srNumber}</div>
      <div class="tooltip-row"><strong>Created:</strong> ${this.formatDate(d.dateCreated)}</div>
      <div class="tooltip-row"><strong>Last update:</strong> ${this.formatDate(d.dateLastUpdate)}</div>
      <div class="tooltip-row"><strong>Days to update:</strong> ${daysLabel}</div>
      <div class="tooltip-row"><strong>Method:</strong> ${d.methodReceived}</div>
      <div class="tooltip-row"><strong>Department:</strong> ${d.deptName}</div>
      <div class="tooltip-row"><strong>Neighborhood:</strong> ${d.neighborhood}</div>
      <div class="tooltip-row"><strong>Priority:</strong> ${d.priority}</div>
      ${heavyTrashRows.join("")}
    `;
  }

  getSequentialEndpoints() {
    const rs = typeof getComputedStyle === "undefined"
      ? null
      : getComputedStyle(document.documentElement);
    const light = rs && rs.getPropertyValue("--seq-light").trim();
    const dark = rs && rs.getPropertyValue("--seq-dark").trim();
    return {
      light: light || "#fecaca",
      dark: dark || "#312e81"
    };
  }

  getNeighborhoodPalette(categoryCount) {
    const palette = [
      "#8dd3c7", "#ffffb3", "#bebada", "#fb8072", "#80b1d3", "#fdb462", "#b3de69",
      "#fccde5", "#d9d9d9", "#bc80bd", "#ccebc5", "#ffed6f", "#a6cee3", "#1f78b4",
      "#b2df8a", "#33a02c", "#fb9a99", "#e31a1c", "#fdbf6f", "#ff7f00", "#cab2d6",
      "#6a3d9a", "#ffff99", "#b15928", "#f781bf", "#999999", "#66c2a5", "#fc8d62",
      "#8da0cb", "#e78ac3", "#a6d854", "#ffd92f", "#e5c494", "#b3b3b3"
    ];

    if (categoryCount <= palette.length) {
      return palette.slice(0, categoryCount);
    }

    return d3.quantize(
      t => d3.interpolateRgbBasis(palette.slice(0, 12))(t),
      categoryCount
    );
  }

  getOrdinalPalette(categoryCount) {
    const seedColors = [
      "#2563eb",
      "#0891b2",
      "#059669",
      "#d97706",
      "#db2777",
      "#7c3aed",
      "#ea580c",
      "#0d9488",
      "#4f46e5",
      "#ca8a04",
      "#be123c",
      "#0369a1"
    ];

    if (categoryCount <= seedColors.length) {
      return seedColors.slice(0, categoryCount);
    }

    return d3.quantize(t => d3.interpolateRgbBasis([
      "#2563eb",
      "#0891b2",
      "#059669",
      "#d97706",
      "#7c3aed"
    ])(t), categoryCount);
  }

  /** High-contrast hues for many departments (map “Color by department”). */
  getDepartmentPalette(categoryCount) {
    const palette = [
      "#1f77b4", "#ff7f0e", "#2ca02c", "#d62728", "#9467bd",
      "#8c564b", "#e377c2", "#17becf", "#bcbd22", "#393b79",
      "#637939", "#843c39", "#7b4173", "#5254a3", "#8ca252",
      "#bd9e39", "#ad494a", "#a55194", "#6b6ecf", "#e7969c",
      "#7f7f7f", "#aec7e8", "#ffbb78", "#98df8a", "#ff9896"
    ];

    if (categoryCount <= palette.length) {
      return palette.slice(0, categoryCount);
    }

    return d3.quantize(
      t => d3.interpolateRgbBasis(palette)(t),
      categoryCount
    );
  }

  prepareCategoricalScale(fieldName) {
    const counts = d3.rollup(
      this.mappedData,
      values => values.length,
      d => d[fieldName] || "Unknown"
    );

    this.categoryItems = Array.from(counts.entries())
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => d3.descending(a.count, b.count));

    const categories = this.categoryItems.map(d => d.value);
    const colors = fieldName === "neighborhood"
      ? this.getNeighborhoodPalette(categories.length)
      : fieldName === "deptName"
        ? this.getDepartmentPalette(categories.length)
        : this.getOrdinalPalette(categories.length);

    this.colorScale = d3.scaleOrdinal()
      .domain(categories)
      .range(colors);

    this.getColor = d => this.colorScale(d[fieldName] || "Unknown");
  }

  setColorMode(mode) {
    this.colorMode = mode;

    if (mode === "daysToUpdate") {
      const validDays = this.mappedData
        .map(d => d.daysToUpdate)
        .filter(Number.isFinite);

      const domain = validDays.length ? d3.extent(validDays) : [0, 1];
      if (domain[0] === domain[1]) {
        domain[1] = domain[0] + 1;
      }

      const { light, dark } = this.getSequentialEndpoints();
      this.colorScale = d3.scaleSequential(t => d3.interpolateLab(light, dark)(t))
        .domain(domain);

      this.getColor = d => Number.isFinite(d.daysToUpdate)
        ? this.colorScale(d.daysToUpdate)
        : "#cbd5e1";

      this.sequentialDomain = domain;
      this.sequentialEndpoints = { light, dark };
    } else if (mode === "priority") {
      const priorityColors = new Map([
        ["HAZARDOUS", "#dc2626"],
        ["PRIORITY", "#d97706"],
        ["STANDARD", "#2563eb"],
        ["Unknown", "#94a3b8"]
      ]);

      const counts = d3.rollup(
        this.mappedData,
        values => values.length,
        d => (d.priority || "Unknown").toUpperCase()
      );

      this.categoryItems = Array.from(counts.entries())
        .map(([value, count]) => ({ value, count }))
        .sort((a, b) => d3.descending(a.count, b.count));

      this.getColor = d => {
        const key = (d.priority || "Unknown").toUpperCase();
        return priorityColors.get(key) || "#64748b";
      };
    } else if (mode === "neighborhood") {
      this.prepareCategoricalScale("neighborhood");
    } else if (mode === "srType") {
      const counts = d3.rollup(
        this.mappedData,
        values => values.length,
        d => d.srType || "Unknown"
      );

      this.categoryItems = this.config.targetServiceTypes
        .map(type => ({
          value: type,
          count: counts.get(type) || 0
        }))
        .sort((a, b) => d3.descending(a.count, b.count));

      this.getColor = d => {
        const key = d.srType || "Unknown";
        return this.getServiceTypeColor(key);
      };
    } else {
      this.prepareCategoricalScale("deptName");
    }

    this.updateColors();
    this.renderLegend();
  }

  updatePointLayer() {
    const vis = this;

    vis.Dots = vis.pointLayer.selectAll("circle")
      .data(vis.mappedDataDisplay, d => d.srNumber)
      .join(
        enter => enter.append("circle")
          .attr("class", "map-point")
          .attr("stroke", "#1e293b")
          .attr("cx", d => vis.theMap.latLngToLayerPoint([d.latitude, d.longitude]).x)
          .attr("cy", d => vis.theMap.latLngToLayerPoint([d.latitude, d.longitude]).y)
          .attr("fill", d => vis.getColor(d))
          .style("pointer-events", "all")
          .on("mouseover", function(event, d) {
            d3.select(this)
              .raise()
              .interrupt()
              .transition()
              .duration(120)
              .attr("r", Math.max(vis.getPointRadius() + 2, 6))
              .attr("stroke-width", 1.2)
              .attr("stroke-opacity", 0.95)
              .attr("fill-opacity", 1);

            vis.tooltip
              .style("opacity", 1)
              .style("z-index", 1000000)
              .html(vis.tooltipHtml(d));
          })
          .on("mousemove", event => {
            vis.tooltip
              .style("left", `${event.pageX + 12}px`)
              .style("top", `${event.pageY + 12}px`);
          })
          .on("mouseleave", function() {
            const appearance = vis.getPointAppearance();
            d3.select(this)
              .interrupt()
              .transition()
              .duration(120)
              .attr("r", appearance.radius)
              .attr("stroke-width", appearance.strokeWidth)
              .attr("stroke-opacity", appearance.strokeOpacity)
              .attr("fill-opacity", appearance.fillOpacity);

            vis.tooltip.style("opacity", 0);
          }),
        update => update,
        exit => exit.remove()
      );

    vis.syncPointModeAppearance();
    vis.updateVis();
  }

  aggregateHeatPoints() {
    const roundedPointGroups = d3.rollups(
      this.mappedData,
      values => ({
        latitude: d3.mean(values, d => d.latitude),
        longitude: d3.mean(values, d => d.longitude),
        count: values.length
      }),
      d => `${d.latitude.toFixed(5)}|${d.longitude.toFixed(5)}`
    );

    return roundedPointGroups.map(([, summary]) => summary);
  }

  updateHeatLayer() {
    if (!this.heatLayer || !this.heatLayer._map) return;

    let aggregatedPoints = this.aggregateHeatPoints();
    const heatMax = Math.max(1, d3.max(aggregatedPoints, d => d.count) || 1);
    this.heatLayer.setOptions({ max: heatMax });

    const HEAT_CAP = 28000;
    if (aggregatedPoints.length > HEAT_CAP) {
      const step = Math.ceil(aggregatedPoints.length / HEAT_CAP);
      aggregatedPoints = aggregatedPoints.filter((_, i) => i % step === 0);
    }

    const heatPoints = aggregatedPoints.map(d => [d.latitude, d.longitude, d.count]);
    this.heatLayer.setLatLngs(heatPoints);
    this.ensureHeatCanvasVisible();
  }

  ensureHeatCanvasVisible() {
    if (!this.heatLayer || !this.heatLayer._canvas) return;

    this.heatLayer._canvas.classList.remove("leaflet-zoom-hide");
    this.heatLayer._canvas.style.display = "block";
    this.heatLayer._canvas.style.opacity = "0.95";
    this.heatLayer._canvas.style.pointerEvents = "none";
  }

  setFilteredData(records) {
    this.filteredData = records.slice();
    this.mappedData = this.filteredData.filter(d => d.latitude !== null && d.longitude !== null);
    this.applyDisplayCap();

    this.setColorMode(this.colorMode);
    this.updatePointLayer();
    this.updateHeatLayer();

    if (!this.initialBoundsApplied && this.mappedData.length > 0) {
      const bounds = L.latLngBounds(this.mappedData.map(d => [d.latitude, d.longitude]));
      this.theMap.fitBounds(bounds.pad(0.05));
      this.initialBoundsApplied = true;
    }
  }

  updateColors() {
    if (!this.Dots) return;
    this.Dots.attr("fill", d => this.getColor(d));
  }

  getPointRadius() {
    return Math.max(3.5, Math.min(7, this.theMap.getZoom() * 0.5 - 1));
  }

  getPointAppearance() {
    if (this.activeMapMode === "heat") {
      return {
        radius: Math.max(this.getPointRadius(), 4.5),
        strokeWidth: 0.9,
        fillOpacity: 0.08,
        strokeOpacity: 0.2
      };
    }

    return {
      radius: this.getPointRadius(),
      strokeWidth: 0.75,
      fillOpacity: 0.85,
      strokeOpacity: 1
    };
  }

  syncPointModeAppearance() {
    if (!this.Dots) return;

    const appearance = this.getPointAppearance();
    // Must match setMapMode: heat mode hides the D3 overlay so only the canvas heat layer shows.
    this.svg.style("display", this.activeMapMode === "points" ? "block" : "none");
    this.Dots
      .style("pointer-events", "all")
      .attr("r", appearance.radius)
      .attr("stroke-width", appearance.strokeWidth)
      .attr("stroke-opacity", appearance.strokeOpacity)
      .attr("fill-opacity", appearance.fillOpacity)
      .attr("fill", d => this.getColor(d));
  }

  updateVis() {
    if (!this.Dots) return;
    const appearance = this.getPointAppearance();

    this.Dots
      .attr("cx", d => this.theMap.latLngToLayerPoint([d.latitude, d.longitude]).x)
      .attr("cy", d => this.theMap.latLngToLayerPoint([d.latitude, d.longitude]).y)
      .attr("r", appearance.radius)
      .attr("stroke-width", appearance.strokeWidth)
      .attr("stroke-opacity", appearance.strokeOpacity)
      .attr("fill-opacity", appearance.fillOpacity)
      .attr("fill", d => this.getColor(d));
  }

  renderHeatLegend() {
    const vis = this;
    vis.legendContainer.html("");

    const legendSvg = vis.legendContainer
      .append("svg")
      .attr("class", "legend-gradient-svg")
      .attr("width", "100%")
      .attr("height", 64);

    const defs = legendSvg.append("defs");
    const linearGradient = defs.append("linearGradient")
      .attr("id", "legend-heat-gradient")
      .attr("x1", "0%")
      .attr("y1", "0%")
      .attr("x2", "100%")
      .attr("y2", "0%");

    const heatStops = [
      { offset: "0%", color: "#1e40af" },
      { offset: "35%", color: "#3b82f6" },
      { offset: "68%", color: "#f59e0b" },
      { offset: "100%", color: "#b45309" }
    ];

    heatStops.forEach(stop => {
      linearGradient.append("stop")
        .attr("offset", stop.offset)
        .attr("stop-color", stop.color);
    });

    legendSvg.append("rect")
      .attr("x", 0)
      .attr("y", 8)
      .attr("width", "100%")
      .attr("height", 16)
      .attr("fill", "url(#legend-heat-gradient)");

    legendSvg.append("text")
      .attr("x", 0)
      .attr("y", 44)
      .attr("class", "legend-text")
      .text("Lower density");

    legendSvg.append("text")
      .attr("x", "100%")
      .attr("y", 44)
      .attr("class", "legend-text legend-right")
      .text("Higher density");

    vis.legendContainer
      .append("p")
      .attr("class", "legend-note")
      .text("Heatmap intensity shows aggregated local concentration of requests.");

    if (vis.mappedData.length > vis.mappedDataDisplay.length) {
      vis.legendContainer
        .append("p")
        .attr("class", "legend-note")
        .text(
          `Heat intensity uses all ${vis.mappedData.length.toLocaleString()} mapped requests. Hover inspection uses a ${vis.mappedDataDisplay.length.toLocaleString()}-point overlay for responsiveness.`
        );
    } else {
      vis.legendContainer
        .append("p")
        .attr("class", "legend-note")
        .text("Timeline brushing and linked filters continue to update the heatmap view.");
    }
  }

  renderLegend() {
    const vis = this;

    if (vis.activeMapMode === "heat") {
      vis.renderHeatLegend();
      return;
    }

    vis.legendContainer.html("");

    if (vis.colorMode === "daysToUpdate") {
      const [minValue, maxValue] = vis.sequentialDomain;
      const gradientId = "legend-gradient-days";

      const legendSvg = vis.legendContainer
        .append("svg")
        .attr("class", "legend-gradient-svg")
        .attr("width", "100%")
        .attr("height", 64);

      const defs = legendSvg.append("defs");
      const linearGradient = defs.append("linearGradient")
        .attr("id", gradientId)
        .attr("x1", "0%").attr("y1", "0%")
        .attr("x2", "100%").attr("y2", "0%");

      const { light, dark } = vis.sequentialEndpoints || vis.getSequentialEndpoints();
      const steps = 12;
      for (let i = 0; i <= steps; i += 1) {
        const t = i / steps;
        linearGradient.append("stop")
          .attr("offset", `${t * 100}%`)
          .attr("stop-color", d3.interpolateLab(light, dark)(t));
      }

      legendSvg.append("rect")
        .attr("x", 0).attr("y", 8)
        .attr("width", "100%").attr("height", 16)
        .attr("fill", `url(#${gradientId})`);

      legendSvg.append("text")
        .attr("x", 0).attr("y", 44)
        .attr("class", "legend-text")
        .text(`${d3.format(".1f")(minValue)} days`);

      legendSvg.append("text")
        .attr("x", "100%").attr("y", 44)
        .attr("class", "legend-text legend-right")
        .text(`${d3.format(".1f")(maxValue)} days`);

      vis.legendContainer
        .append("p")
        .attr("class", "legend-note")
        .text("Longer time-to-update values appear darker.");

      if (vis.mappedData.length > vis.mappedDataDisplay.length) {
        vis.legendContainer
          .append("p")
          .attr("class", "legend-note")
          .text(
            `Showing ${vis.mappedDataDisplay.length.toLocaleString()} of ${vis.mappedData.length.toLocaleString()} mapped points (sampled for performance).`
          );
      }

      return;
    }

    const list = vis.legendContainer
      .append("ul")
      .attr("class", "legend-list");

    vis.categoryItems.forEach(item => {
      const row = list.append("li").attr("class", "legend-item");
      
      let colorValue;
      if (vis.colorMode === "srType") {
        colorValue = { srType: item.value };
      } else {
        colorValue = {
          priority: item.value,
          neighborhood: item.value,
          deptName: item.value
        };
      }
      
      row.append("span")
        .attr("class", "legend-swatch")
        .style("background-color", vis.getColor(colorValue));

      row.append("span")
        .attr("class", "legend-label")
        .text(`${item.value} (${d3.format(",")(item.count)})`);
    });

    if (vis.mappedData.length > vis.mappedDataDisplay.length) {
      vis.legendContainer
        .append("p")
        .attr("class", "legend-note")
        .text(
          `Showing ${vis.mappedDataDisplay.length.toLocaleString()} of ${vis.mappedData.length.toLocaleString()} mapped points (sampled for performance).`
        );
    }
  }

  setMapMode(mode) {
    if (mode === "heat" && !this.heatLayer) {
      this.activeMapMode = "points";
    } else {
      this.activeMapMode = mode;
    }

    if (this.activeMapMode === "heat") {
      this.cancelBrushMode();
      this.setMoveRegionMode(false);
    }

    const showPoints = this.activeMapMode === "points";
    this.svg.style("display", showPoints ? "block" : "none");

    if (this.heatLayer) {
      if (this.activeMapMode === "heat") {
        this.heatLayer.addTo(this.theMap);
        this.updateHeatLayer();
        requestAnimationFrame(() => {
          if (this.heatLayer && this.heatLayer._map && typeof this.heatLayer._reset === "function") {
            this.heatLayer._reset();
          }
        });
        this.ensureHeatCanvasVisible();
      } else {
        this.theMap.removeLayer(this.heatLayer);
      }
    }

    this.setSvgPointerEventsForInteraction();
    this.renderLegend();
    return this.activeMapMode;
  }

  toggleBasemap() {
    if (!this.cycleLayer) {
      return "street";
    }
    if (this.activeBasemap === "street") {
      this.theMap.removeLayer(this.streetLayer);
      this.cycleLayer.addTo(this.theMap);
      this.activeBasemap = "cycle";
    } else {
      this.theMap.removeLayer(this.cycleLayer);
      this.streetLayer.addTo(this.theMap);
      this.activeBasemap = "street";
    }

    return this.activeBasemap;
  }
}
