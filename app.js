const VEHICLES = {
  class1: {
    id: "class1",
    label: "Moped klass 1",
    defaultCruise: 45,
    allowCycleways: false,
  },
  class2: {
    id: "class2",
    label: "Moped klass 2",
    defaultCruise: 25,
    allowCycleways: true,
  },
  atraktor: {
    id: "atraktor",
    label: "A-traktor / EPA",
    defaultCruise: 30,
    allowCycleways: false,
  },
};

const MAP_STYLES = {
  street: {
    id: "street",
    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    options: {
      maxZoom: 19,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    },
  },
  satellite: {
    id: "satellite",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    options: {
      maxZoom: 19,
      attribution: "Tiles &copy; Esri",
    },
  },
};

const ROAD_BASE = new Set([
  "trunk",
  "trunk_link",
  "primary",
  "primary_link",
  "secondary",
  "secondary_link",
  "tertiary",
  "tertiary_link",
  "unclassified",
  "residential",
  "service",
  "living_street",
  "road",
]);

const CLASS2_EXTRA = new Set(["cycleway", "path"]);
const BLOCKED_ACCESS = new Set(["no", "private"]);
const geocodeCache = new Map();
const networkCache = new Map();

const state = {
  map: null,
  routeRenderer: null,
  baseLayers: {},
  mapStyle: "street",
  panelOpen: true,
  startMode: "current",
  vehicle: "class1",
  startPoint: null,
  endPoint: null,
  currentLocation: null,
  currentHeading: 0,
  route: null,
  navigationActive: false,
  markers: {
    start: null,
    end: null,
    current: null,
  },
  layers: {
    route: null,
  },
  navWatchId: null,
  pickingMode: null,
  geocodeControllers: {},
  lastRouteRequestId: 0,
  statusHideTimer: null,
  autoBuildTimer: null,
};

const els = {
  controlPanel: document.getElementById("control-panel"),
  panelToggle: document.getElementById("panel-toggle"),
  panelToggleIcon: document.getElementById("panel-toggle-icon"),
  panelBackdrop: document.getElementById("panel-backdrop"),
  statusChip: document.getElementById("status-chip"),
  statusText: document.getElementById("status-text"),
  returnButton: document.getElementById("return-button"),
  styleToggle: document.getElementById("style-toggle"),
  vehicleToggle: document.getElementById("vehicle-toggle"),
  startMode: document.getElementById("start-mode"),
  manualStartWrap: document.getElementById("manual-start-wrap"),
  startInput: document.getElementById("start-input"),
  endInput: document.getElementById("end-input"),
  startSuggestions: document.getElementById("start-suggestions"),
  endSuggestions: document.getElementById("end-suggestions"),
  clearButton: document.getElementById("clear-button"),
  startNavigation: document.getElementById("start-navigation"),
  distanceOutput: document.getElementById("distance-output"),
  etaOutput: document.getElementById("eta-output"),
  summaryNote: document.getElementById("summary-note"),
  pickStart: document.getElementById("pick-start"),
  pickEnd: document.getElementById("pick-end"),
};

init();

function init() {
  initMap();
  bindUI();
  setMapStyle(state.mapStyle);
  applyVehicleState();
  updateStartMode();
  syncPanelState();
  bootstrapLocation();
}

function initMap() {
  state.map = L.map("map", {
    zoomControl: false,
    preferCanvas: true,
    zoomSnap: 0.25,
    zoomDelta: 0.5,
  }).setView([59.3293, 18.0686], 12.5);

  state.routeRenderer = L.canvas({ padding: 0.6 });

  L.control.zoom({ position: "bottomleft" }).addTo(state.map);

  Object.values(MAP_STYLES).forEach((style) => {
    state.baseLayers[style.id] = L.tileLayer(style.url, {
      crossOrigin: true,
      ...style.options,
    });
  });

  state.map.on("click", handleMapClick);
  state.map.on("moveend zoomend", updateReturnButtonVisibility);
}

function bindUI() {
  els.panelToggle.addEventListener("click", togglePanel);
  els.panelBackdrop.addEventListener("click", () => setPanelOpen(false));
  els.returnButton.addEventListener("click", recenterToCurrentLocation);

  els.vehicleToggle.addEventListener("click", (event) => {
    const button = event.target.closest("[data-vehicle]");
    if (!button) {
      return;
    }
    state.vehicle = button.dataset.vehicle;
    applyVehicleState();
    if (state.route) {
      buildRoute();
    }
  });

  els.styleToggle.addEventListener("click", (event) => {
    const button = event.target.closest("[data-style]");
    if (!button) {
      return;
    }
    setMapStyle(button.dataset.style);
  });

  els.startMode.addEventListener("click", (event) => {
    const button = event.target.closest("[data-mode]");
    if (!button || button.dataset.mode === state.startMode) {
      return;
    }
    state.startMode = button.dataset.mode;
    updateStartMode();
    maybeAutoBuildRoute();
  });

  els.startNavigation.addEventListener("click", startNavigationMode);
  els.clearButton.addEventListener("click", clearRouteAndInputs);
  els.pickStart.addEventListener("click", () => toggleMapPicker("start"));
  els.pickEnd.addEventListener("click", () => toggleMapPicker("end"));

  bindAutocomplete(els.startInput, els.startSuggestions, "start");
  bindAutocomplete(els.endInput, els.endSuggestions, "end");

  document.addEventListener("click", (event) => {
    if (!event.target.closest(".field-group")) {
      closeSuggestions("start");
      closeSuggestions("end");
    }
  });

  window.addEventListener("resize", syncPanelState);
}

function togglePanel() {
  setPanelOpen(!state.panelOpen);
}

function setPanelOpen(nextValue) {
  state.panelOpen = nextValue;
  syncPanelState();
}

function syncPanelState() {
  const desktop = window.innerWidth >= 980;
  els.controlPanel.classList.toggle("is-collapsed", !desktop && !state.panelOpen);
  els.panelBackdrop.classList.toggle("is-hidden", desktop || !state.panelOpen);
  els.panelToggleIcon.textContent = !desktop && !state.panelOpen ? "‹" : "›";
}

function setMapStyle(styleId) {
  if (!MAP_STYLES[styleId]) {
    return;
  }

  Object.values(state.baseLayers).forEach((layer) => {
    if (state.map.hasLayer(layer)) {
      state.map.removeLayer(layer);
    }
  });

  state.baseLayers[styleId].addTo(state.map);
  state.mapStyle = styleId;

  [...els.styleToggle.querySelectorAll("[data-style]")].forEach((button) => {
    button.classList.toggle("is-active", button.dataset.style === styleId);
  });
}

function applyVehicleState() {
  [...els.vehicleToggle.querySelectorAll("[data-vehicle]")].forEach((button) => {
    button.classList.toggle("is-active", button.dataset.vehicle === state.vehicle);
  });
}

function updateStartMode() {
  const usingCurrent = state.startMode === "current";

  [...els.startMode.querySelectorAll("[data-mode]")].forEach((button) => {
    button.classList.toggle("is-active", button.dataset.mode === state.startMode);
  });

  els.manualStartWrap.classList.toggle("is-open", !usingCurrent);
  els.startInput.disabled = usingCurrent;
  els.pickStart.disabled = usingCurrent;

  if (usingCurrent) {
    els.startInput.value = "";
    if (state.currentLocation) {
      state.startPoint = state.currentLocation;
      removeMarker("start");
      if (!state.navigationActive) {
        state.map.flyTo([state.currentLocation.lat, state.currentLocation.lon], 17.25, {
          duration: 0.8,
        });
      }
    }
  } else if (state.startPoint?.source === "current") {
    state.startPoint = null;
  }
}

function bootstrapLocation() {
  if (!navigator.geolocation) {
    state.startMode = "manual";
    updateStartMode();
    setStatus("Plats går inte att läsa här.", 2500);
    return;
  }

  navigator.geolocation.getCurrentPosition(
    (position) => {
      const point = toPoint(position.coords.latitude, position.coords.longitude, {
        label: "Nuvarande plats",
        source: "current",
      });
      state.currentLocation = point;
      state.currentHeading = normalizeHeading(position.coords.heading);
      updateMarker("current", point, "current", state.currentHeading);

      if (state.startMode === "current") {
        state.startPoint = point;
        removeMarker("start");
      }

      state.map.flyTo([point.lat, point.lon], 17.25, { duration: 1.05 });
      setStatus("Plats hittad.", 2200);
      maybeAutoBuildRoute();
    },
    () => {
      state.startMode = "manual";
      updateStartMode();
      setStatus("Kunde inte hämta din plats.", 3000);
    },
    {
      enableHighAccuracy: true,
      timeout: 12000,
      maximumAge: 30000,
    }
  );
}

function bindAutocomplete(input, container, kind) {
  let debounceTimer = null;

  input.addEventListener("input", () => {
    if (kind === "start" && state.startMode === "current") {
      return;
    }

    if (kind === "start") {
      state.startPoint = null;
    } else {
      state.endPoint = null;
      state.route = null;
      els.startNavigation.disabled = true;
    }

    window.clearTimeout(debounceTimer);
    const value = input.value.trim();
    if (value.length < 3) {
      closeSuggestions(kind);
      return;
    }

    debounceTimer = window.setTimeout(async () => {
      const results = await fetchGeocodeSuggestions(value, kind, 8);
      renderSuggestions(container, results, kind, value);
    }, 220);
  });

  input.addEventListener("keydown", async (event) => {
    if (event.key !== "Enter") {
      return;
    }
    event.preventDefault();
    const point = await resolveTypedAddress(kind);
    if (point) {
      maybeAutoBuildRoute(kind);
    }
  });
}

async function fetchGeocodeSuggestions(query, kind, limit = 8) {
  const cacheKey = `${limit}:${query.toLowerCase()}`;
  if (geocodeCache.has(cacheKey)) {
    return geocodeCache.get(cacheKey);
  }

  if (state.geocodeControllers[kind]) {
    state.geocodeControllers[kind].abort();
  }

  const controller = new AbortController();
  state.geocodeControllers[kind] = controller;

  const primary = await requestGeocode(query, limit, controller.signal, true);
  const fallback = primary.length ? primary : await requestGeocode(query, limit, controller.signal, false);
  const ranked = rankGeocodeResults(query, fallback);
  geocodeCache.set(cacheKey, ranked);
  return ranked;
}

async function requestGeocode(query, limit, signal, swedenOnly) {
  const endpoint = new URL("https://nominatim.openstreetmap.org/search");
  endpoint.searchParams.set("format", "jsonv2");
  endpoint.searchParams.set("limit", String(limit));
  endpoint.searchParams.set("accept-language", "sv");
  endpoint.searchParams.set("addressdetails", "1");
  endpoint.searchParams.set("dedupe", "1");
  endpoint.searchParams.set("q", query);
  if (swedenOnly) {
    endpoint.searchParams.set("countrycodes", "se");
  }

  try {
    const response = await fetch(endpoint, {
      headers: { Accept: "application/json" },
      signal,
    });
    if (!response.ok) {
      return [];
    }
    return response.json();
  } catch (error) {
    if (error.name !== "AbortError") {
      setStatus("Adressen kunde inte sökas just nu.", 2500);
    }
    return [];
  }
}

function rankGeocodeResults(query, results) {
  const normalizedQuery = normalizeText(query);
  const houseNumber = extractHouseNumber(query);

  return [...results].sort((a, b) => scoreGeocodeResult(b, normalizedQuery, houseNumber) - scoreGeocodeResult(a, normalizedQuery, houseNumber));
}

function scoreGeocodeResult(item, normalizedQuery, houseNumber) {
  const display = normalizeText(item.display_name || "");
  const address = item.address || {};
  let score = 0;

  if (display.includes(normalizedQuery)) {
    score += 6;
  }

  if (houseNumber) {
    if (String(address.house_number || "").toLowerCase() === houseNumber) {
      score += 10;
    }
    if (display.includes(houseNumber)) {
      score += 5;
    }
  }

  const road = normalizeText(address.road || address.pedestrian || address.path || "");
  if (road && normalizedQuery.includes(road)) {
    score += 4;
  }

  if ((item.type || "").includes("house") || (item.class || "") === "place") {
    score += 2;
  }

  return score;
}

function renderSuggestions(container, results, kind, query) {
  container.innerHTML = "";
  if (!results.length) {
    container.classList.remove("is-open");
    return;
  }

  results.forEach((item) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "suggestion-item";
    button.innerHTML = `<strong>${escapeHtml(firstLine(item.display_name))}</strong><span>${escapeHtml(item.display_name)}</span>`;
    button.addEventListener("click", () => {
      applyResolvedPlace(kind, item, query);
      closeSuggestions(kind);
      setPanelOpen(true);
      maybeAutoBuildRoute(kind);
    });
    container.appendChild(button);
  });

  container.classList.add("is-open");
}

async function resolveTypedAddress(kind) {
  if (kind === "start" && state.startMode === "current") {
    return state.currentLocation;
  }

  const input = kind === "start" ? els.startInput : els.endInput;
  const text = input.value.trim();
  if (!text) {
    return kind === "start" ? state.startPoint : state.endPoint;
  }

  const results = await fetchGeocodeSuggestions(text, kind, 10);
  if (!results.length) {
    setSummaryMessage(`Hittade inte adressen: ${text}`, "error");
    return null;
  }

  closeSuggestions(kind);
  return applyResolvedPlace(kind, results[0], text);
}

function applyResolvedPlace(kind, item, typedLabel) {
  const point = toPoint(Number(item.lat), Number(item.lon), {
    label: typedLabel || item.display_name,
    displayName: item.display_name,
    source: "search",
  });

  if (kind === "start") {
    state.startPoint = point;
    els.startInput.value = typedLabel || item.display_name;
    updateMarker("start", point, "start");
  } else {
    state.endPoint = point;
    els.endInput.value = typedLabel || item.display_name;
    updateMarker("end", point, "end");
  }

  setStatus("Adress vald.", 1800);
  return point;
}

function closeSuggestions(kind) {
  const container = kind === "start" ? els.startSuggestions : els.endSuggestions;
  container.classList.remove("is-open");
}

function toggleMapPicker(kind) {
  state.pickingMode = state.pickingMode === kind ? null : kind;
  renderMapPickerToast();
  if (state.pickingMode) {
    setPanelOpen(false);
    setStatus(kind === "start" ? "Tryck på kartan för att välja start." : "Tryck på kartan för att välja destination.", 2600);
  }
}

function renderMapPickerToast() {
  const existing = document.querySelector(".map-picker-toast");
  if (existing) {
    existing.remove();
  }

  if (!state.pickingMode) {
    return;
  }

  const toast = document.createElement("div");
  toast.className = "map-picker-toast";
  toast.textContent = state.pickingMode === "start" ? "Tryck på kartan för start." : "Tryck på kartan för destination.";
  document.querySelector(".map-stage").appendChild(toast);
}
function handleMapClick(event) {
  if (state.pickingMode) {
    const point = toPoint(event.latlng.lat, event.latlng.lng, {
      label: formatLatLon({ lat: event.latlng.lat, lon: event.latlng.lng }),
      source: "map",
    });

    if (state.pickingMode === "start") {
      if (state.startMode === "current") {
        state.startMode = "manual";
        updateStartMode();
      }
      state.startPoint = point;
      els.startInput.value = point.label;
      updateMarker("start", point, "start");
    } else {
      state.endPoint = point;
      els.endInput.value = point.label;
      updateMarker("end", point, "end");
    }

    state.pickingMode = null;
    renderMapPickerToast();
    setPanelOpen(true);
    maybeAutoBuildRoute();
    return;
  }

  if (window.innerWidth < 980 && state.panelOpen) {
    setPanelOpen(false);
  }
}

function maybeAutoBuildRoute(changedKind = "") {
  window.clearTimeout(state.autoBuildTimer);

  const hasStart = state.startMode === "current" ? Boolean(state.currentLocation) : Boolean(state.startPoint);
  const hasEndText = Boolean(els.endInput.value.trim()) || Boolean(state.endPoint);
  const hasManualStartText = state.startMode === "manual" ? Boolean(els.startInput.value.trim()) : true;

  if (!hasStart && !hasManualStartText) {
    return;
  }

  if (!hasEndText) {
    return;
  }

  if (changedKind === "start" && !state.endPoint && !els.endInput.value.trim()) {
    return;
  }

  state.autoBuildTimer = window.setTimeout(() => {
    buildRoute();
  }, 180);
}

async function buildRoute() {
  const requestId = ++state.lastRouteRequestId;

  try {
    const resolved = await ensureResolvedInputs();
    if (!resolved) {
      return;
    }

    const startPoint = state.startMode === "current" ? state.currentLocation : state.startPoint;
    const endPoint = state.endPoint;

    if (!startPoint || !endPoint) {
      return;
    }

    if (haversineKm(startPoint, endPoint) > 80) {
      state.route = null;
      clearRouteLayer();
      els.startNavigation.disabled = true;
      els.distanceOutput.textContent = "-";
      els.etaOutput.textContent = "-";
      setSummaryMessage("Rutten är för lång. Testa en närmare adress.", "error");
      return;
    }

    setStatus("Beräknar rutt…");
    const network = await fetchRoadNetwork(startPoint, endPoint, VEHICLES[state.vehicle]);
    if (requestId !== state.lastRouteRequestId) {
      return;
    }

    const result = calculateRoute(network, startPoint, endPoint, VEHICLES[state.vehicle]);
    if (!result) {
      state.route = null;
      clearRouteLayer();
      els.distanceOutput.textContent = "-";
      els.etaOutput.textContent = "-";
      els.startNavigation.disabled = true;
      setSummaryMessage("Det gick inte att beräkna någon rutt här.", "error");
      setStatus("Ingen rutt hittades.", 2500);
      return;
    }

    state.route = result;
    drawRoute(result.coordinates);
    renderRouteSummary(result);
    els.startNavigation.disabled = false;
    setStatus("Rutten är klar.", 2500);
  } catch (error) {
    console.error(error);
    state.route = null;
    clearRouteLayer();
    els.startNavigation.disabled = true;
    els.distanceOutput.textContent = "-";
    els.etaOutput.textContent = "-";
    setSummaryMessage("Karttjänsten svarade inte just nu.", "error");
    setStatus("Ruttberäkningen misslyckades.", 2500);
  }
}

async function ensureResolvedInputs() {
  if (state.startMode === "manual") {
    const resolvedStart = await resolveTypedAddress("start");
    if (!resolvedStart) {
      return false;
    }
  }

  const resolvedEnd = await resolveTypedAddress("end");
  if (!resolvedEnd) {
    return false;
  }

  return true;
}

async function fetchRoadNetwork(startPoint, endPoint, vehicle) {
  const directDistanceKm = haversineKm(startPoint, endPoint);
  const attemptBuffersKm = [
    Math.max(1.5, directDistanceKm * 0.35),
    Math.max(3.5, directDistanceKm * 0.55),
    Math.max(6.5, directDistanceKm * 0.9),
  ];

  let lastError = null;

  for (const bufferKm of attemptBuffersKm) {
    const bbox = buildBBox(startPoint, endPoint, bufferKm);
    const cacheKey = `${vehicle.id}:${bbox.join(",")}`;
    if (networkCache.has(cacheKey)) {
      const cached = networkCache.get(cacheKey);
      if (cached.segments.length) {
        return cached;
      }
    }

    try {
      const data = await queryOverpass(bbox);
      const graph = buildGraph(data, vehicle);
      networkCache.set(cacheKey, graph);
      if (graph.segments.length) {
        return graph;
      }
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError) {
    throw lastError;
  }

  return { adjacency: new Map(), segments: [] };
}

async function queryOverpass(bbox) {
  const [south, west, north, east] = bbox;
  const query = `
[out:json][timeout:25];
(
  way["highway"](${south},${west},${north},${east});
);
(._;>;);
out body;
  `.trim();

  const response = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
    },
    body: new URLSearchParams({ data: query }),
  });

  if (!response.ok) {
    throw new Error(`Overpass ${response.status}`);
  }

  return response.json();
}

function buildGraph(data, vehicle) {
  const nodes = new Map();
  const adjacency = new Map();
  const segments = [];

  for (const element of data.elements || []) {
    if (element.type === "node") {
      nodes.set(element.id, { id: element.id, lat: element.lat, lon: element.lon });
    }
  }

  for (const element of data.elements || []) {
    if (element.type !== "way" || !isWayAllowed(element.tags || {}, vehicle)) {
      continue;
    }

    const tags = element.tags || {};
    const onewayMode = getOnewayMode(tags);

    for (let index = 0; index < element.nodes.length - 1; index += 1) {
      const fromId = element.nodes[index];
      const toId = element.nodes[index + 1];
      const fromNode = nodes.get(fromId);
      const toNode = nodes.get(toId);
      if (!fromNode || !toNode) {
        continue;
      }

      const distanceKm = haversineKm(fromNode, toNode);
      if (!distanceKm) {
        continue;
      }

      const edgeMeta = {
        distanceKm,
        durationMin: estimateEdgeMinutes(distanceKm, tags),
        highway: tags.highway,
        name: tags.name || readableHighwayName(tags.highway),
        tags,
        from: fromId,
        to: toId,
        fromCoord: [fromNode.lat, fromNode.lon],
        toCoord: [toNode.lat, toNode.lon],
      };

      segments.push(edgeMeta);

      if (onewayMode === "both" || onewayMode === "forward") {
        pushEdge(adjacency, fromId, edgeMeta);
      }

      if (onewayMode === "both" || onewayMode === "reverse") {
        pushEdge(adjacency, toId, {
          ...edgeMeta,
          from: toId,
          to: fromId,
          fromCoord: [toNode.lat, toNode.lon],
          toCoord: [fromNode.lat, fromNode.lon],
        });
      }
    }
  }

  return { nodes, adjacency, segments };
}

function isWayAllowed(tags, vehicle) {
  const highway = tags.highway;
  if (!highway) {
    return false;
  }

  if (
    highway === "motorway" ||
    highway === "motorway_link" ||
    highway === "steps" ||
    highway === "footway" ||
    highway === "pedestrian" ||
    highway === "bridleway" ||
    highway === "construction"
  ) {
    return false;
  }

  if (
    BLOCKED_ACCESS.has(tags.access) ||
    BLOCKED_ACCESS.has(tags.vehicle) ||
    BLOCKED_ACCESS.has(tags.motor_vehicle) ||
    tags.motorroad === "yes" ||
    tags.moped === "no" ||
    tags.mofa === "no"
  ) {
    return false;
  }

  if (highway === "service" && tags.service === "parking_aisle") {
    return false;
  }

  if (ROAD_BASE.has(highway)) {
    return true;
  }

  if (!vehicle.allowCycleways || !CLASS2_EXTRA.has(highway)) {
    return false;
  }

  if (highway === "path") {
    return (
      tags.bicycle === "yes" ||
      tags.bicycle === "designated" ||
      tags.moped === "yes" ||
      tags.mofa === "yes"
    );
  }

  return tags.bicycle !== "no";
}

function getOnewayMode(tags) {
  if (tags.oneway === "-1") {
    return "reverse";
  }
  if (tags.oneway === "yes" || tags.junction === "roundabout") {
    return "forward";
  }
  return "both";
}

function estimateEdgeMinutes(distanceKm, tags) {
  const vehicle = VEHICLES[state.vehicle];
  const roadLimit = deriveRoadLimit(tags);
  const comfortFactor = tags.highway === "cycleway" || tags.highway === "path" ? 0.78 : 0.84;
  const effectiveSpeed = Math.max(8, Math.min(vehicle.defaultCruise * 0.82, roadLimit * comfortFactor));
  return (distanceKm / effectiveSpeed) * 60;
}

function deriveRoadLimit(tags) {
  const parsed = parseMaxSpeed(tags.maxspeed);
  if (parsed) {
    return parsed;
  }

  switch (tags.highway) {
    case "trunk":
    case "primary":
      return 80;
    case "secondary":
    case "secondary_link":
      return 70;
    case "tertiary":
    case "tertiary_link":
      return 60;
    case "residential":
    case "living_street":
      return 30;
    case "cycleway":
    case "path":
      return 25;
    case "service":
      return 25;
    default:
      return 50;
  }
}

function parseMaxSpeed(rawValue) {
  if (!rawValue) {
    return null;
  }
  const direct = Number(String(rawValue).replace(/[^\d]/g, ""));
  return Number.isFinite(direct) && direct > 0 ? direct : null;
}

function calculateRoute(network, startPoint, endPoint, vehicle) {
  if (!network.segments.length) {
    return null;
  }

  const startVirtual = connectVirtualPoint(network, startPoint, "virtual-start");
  const endVirtual = connectVirtualPoint(network, endPoint, "virtual-end");
  if (!startVirtual || !endVirtual) {
    return null;
  }

  const adjacency = cloneAdjacency(network.adjacency);
  injectVirtualConnections(adjacency, startVirtual);
  injectVirtualConnections(adjacency, endVirtual);

  const path = shortestPath(adjacency, startVirtual.id, endVirtual.id);
  if (!path) {
    return null;
  }

  return buildRoutePayload(path, startPoint, endPoint, vehicle);
}
function connectVirtualPoint(network, point, virtualId) {
  let bestSegment = null;
  let bestProjection = null;
  let shortestDistance = Infinity;

  for (const segment of network.segments) {
    const projection = projectPointOntoSegment(point, segment.fromCoord, segment.toCoord);
    if (!projection) {
      continue;
    }
    if (projection.distanceKm < shortestDistance) {
      shortestDistance = projection.distanceKm;
      bestProjection = projection;
      bestSegment = segment;
    }
  }

  if (!bestSegment || !bestProjection) {
    return null;
  }

  const tags = bestSegment.tags || {};
  const projectedPoint = toPoint(bestProjection.lat, bestProjection.lon, {
    label: bestSegment.name || readableHighwayName(tags.highway),
    source: "projection",
  });

  const totalDistance = bestSegment.distanceKm;
  const fromDistance = totalDistance * bestProjection.ratio;
  const toDistance = Math.max(totalDistance - fromDistance, 0);
  const onewayMode = getOnewayMode(tags);
  const links = [];
  const minutes = (km) => estimateEdgeMinutes(km, tags);

  if (onewayMode === "both") {
    links.push(
      makeLink(virtualId, bestSegment.from, fromDistance, minutes(fromDistance), bestSegment.name, tags, [projectedPoint.lat, projectedPoint.lon], bestSegment.fromCoord),
      makeLink(bestSegment.from, virtualId, fromDistance, minutes(fromDistance), bestSegment.name, tags, bestSegment.fromCoord, [projectedPoint.lat, projectedPoint.lon]),
      makeLink(virtualId, bestSegment.to, toDistance, minutes(toDistance), bestSegment.name, tags, [projectedPoint.lat, projectedPoint.lon], bestSegment.toCoord),
      makeLink(bestSegment.to, virtualId, toDistance, minutes(toDistance), bestSegment.name, tags, bestSegment.toCoord, [projectedPoint.lat, projectedPoint.lon])
    );
  }

  if (onewayMode === "forward") {
    links.push(
      makeLink(virtualId, bestSegment.to, toDistance, minutes(toDistance), bestSegment.name, tags, [projectedPoint.lat, projectedPoint.lon], bestSegment.toCoord),
      makeLink(bestSegment.from, virtualId, fromDistance, minutes(fromDistance), bestSegment.name, tags, bestSegment.fromCoord, [projectedPoint.lat, projectedPoint.lon])
    );
  }

  if (onewayMode === "reverse") {
    links.push(
      makeLink(virtualId, bestSegment.from, fromDistance, minutes(fromDistance), bestSegment.name, tags, [projectedPoint.lat, projectedPoint.lon], bestSegment.fromCoord),
      makeLink(bestSegment.to, virtualId, toDistance, minutes(toDistance), bestSegment.name, tags, bestSegment.toCoord, [projectedPoint.lat, projectedPoint.lon])
    );
  }

  return {
    id: virtualId,
    links: links.filter((link) => link.distanceKm >= 0),
  };
}

function makeLink(from, to, distanceKm, durationMin, name, tags, fromCoord, toCoord) {
  return {
    from,
    to,
    distanceKm,
    durationMin,
    name: name || readableHighwayName(tags.highway),
    highway: tags.highway,
    tags,
    fromCoord,
    toCoord,
  };
}

function cloneAdjacency(adjacency) {
  const clone = new Map();
  for (const [key, edges] of adjacency.entries()) {
    clone.set(key, edges.map((edge) => ({ ...edge })));
  }
  return clone;
}

function injectVirtualConnections(adjacency, virtualNode) {
  adjacency.set(virtualNode.id, adjacency.get(virtualNode.id) || []);
  for (const link of virtualNode.links) {
    pushEdge(adjacency, link.from, link);
  }
}

function shortestPath(adjacency, startId, endId) {
  const heap = new MinHeap();
  const distances = new Map([[startId, 0]]);
  const previous = new Map();

  heap.push({ id: startId, cost: 0 });

  while (!heap.isEmpty()) {
    const current = heap.pop();
    if (!current) {
      break;
    }

    if (current.id === endId) {
      break;
    }

    if (current.cost > (distances.get(current.id) ?? Infinity)) {
      continue;
    }

    const neighbors = adjacency.get(current.id) || [];
    for (const edge of neighbors) {
      const nextCost = current.cost + edge.distanceKm;
      if (nextCost < (distances.get(edge.to) ?? Infinity)) {
        distances.set(edge.to, nextCost);
        previous.set(edge.to, { node: current.id, edge });
        heap.push({ id: edge.to, cost: nextCost });
      }
    }
  }

  if (!previous.has(endId)) {
    return null;
  }

  const steps = [];
  let cursor = endId;

  while (cursor !== startId) {
    const entry = previous.get(cursor);
    if (!entry) {
      return null;
    }
    steps.push(entry.edge);
    cursor = entry.node;
  }

  steps.reverse();
  return { edges: steps };
}

function buildRoutePayload(path, startPoint, endPoint, vehicle) {
  let totalDistanceKm = 0;
  let totalMinutes = 0;
  const coordinates = [[startPoint.lat, startPoint.lon]];

  for (const edge of path.edges) {
    totalDistanceKm += edge.distanceKm;
    totalMinutes += edge.durationMin;

    if (!sameCoord(coordinates[coordinates.length - 1], edge.fromCoord)) {
      coordinates.push(edge.fromCoord);
    }
    if (!sameCoord(coordinates[coordinates.length - 1], edge.toCoord)) {
      coordinates.push(edge.toCoord);
    }
  }

  if (!sameCoord(coordinates[coordinates.length - 1], [endPoint.lat, endPoint.lon])) {
    coordinates.push([endPoint.lat, endPoint.lon]);
  }

  return {
    coordinates,
    totalDistanceKm,
    totalMinutes,
    routeProfile: summarizeRouteProfile(path.edges, vehicle),
  };
}

function summarizeRouteProfile(edges, vehicle) {
  const cycleDistance = edges
    .filter((edge) => edge.highway === "cycleway" || edge.highway === "path")
    .reduce((sum, edge) => sum + edge.distanceKm, 0);
  const smallRoadDistance = edges
    .filter((edge) => ["residential", "service", "living_street", "unclassified"].includes(edge.highway))
    .reduce((sum, edge) => sum + edge.distanceKm, 0);

  if (vehicle.allowCycleways && cycleDistance > smallRoadDistance) {
    return "Mest cykelväg";
  }
  if (smallRoadDistance > 0) {
    return "Småvägar först";
  }
  return "Blandad landsväg";
}

function renderRouteSummary(route) {
  els.distanceOutput.textContent = formatDistance(route.totalDistanceKm);
  els.etaOutput.textContent = formatMinutes(route.totalMinutes);
  els.startNavigation.disabled = false;
  setSummaryMessage(`Rutt klar: ${formatDistance(route.totalDistanceKm)} • ${formatMinutes(route.totalMinutes)}`, "success");
}

function drawRoute(coordinates) {
  clearRouteLayer();

  state.layers.route = L.polyline(coordinates, {
    renderer: state.routeRenderer,
    color: "#1473ff",
    weight: 6,
    opacity: 0.96,
    lineCap: "round",
    lineJoin: "round",
    smoothFactor: 1,
    interactive: false,
  }).addTo(state.map);

  focusRelevantBounds();
}

function clearRouteLayer() {
  if (state.layers.route) {
    state.map.removeLayer(state.layers.route);
  }
  state.layers.route = null;
}

function startNavigationMode() {
  if (!state.route) {
    return;
  }

  state.navigationActive = true;
  recenterToCurrentLocation();
  setStatus("Navigation aktiv.", 5000);
  updateReturnButtonVisibility();

  if (window.innerWidth < 980) {
    setPanelOpen(false);
  }

  if (!navigator.geolocation) {
    return;
  }

  if (state.navWatchId) {
    navigator.geolocation.clearWatch(state.navWatchId);
  }

  state.navWatchId = navigator.geolocation.watchPosition(
    (position) => {
      const point = toPoint(position.coords.latitude, position.coords.longitude, {
        label: "Nuvarande plats",
        source: "current",
      });
      state.currentLocation = point;
      state.currentHeading = normalizeHeading(position.coords.heading);
      updateMarker("current", point, "current", state.currentHeading);
      if (state.startMode === "current") {
        state.startPoint = point;
      }
      updateReturnButtonVisibility();
    },
    () => {
      setStatus("Positionen kunde inte uppdateras.", 2500);
    },
    {
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 5000,
    }
  );
}

function recenterToCurrentLocation() {
  const point = state.currentLocation || state.startPoint;
  if (!point) {
    return;
  }

  state.map.flyTo([point.lat, point.lon], 17.75, { duration: 0.8 });
  els.returnButton.classList.add("is-hidden");
}

function updateReturnButtonVisibility() {
  if (!state.navigationActive || !state.currentLocation) {
    els.returnButton.classList.add("is-hidden");
    return;
  }

  const visible = state.map.getBounds().contains([state.currentLocation.lat, state.currentLocation.lon]);
  els.returnButton.classList.toggle("is-hidden", visible);
}

function focusRelevantBounds() {
  if (state.route?.coordinates?.length) {
    state.map.fitBounds(state.route.coordinates, {
      padding: [40, 40],
      maxZoom: 16,
    });
    return;
  }

  const points = [];
  if (state.startMode === "manual" && state.startPoint) {
    points.push([state.startPoint.lat, state.startPoint.lon]);
  }
  if (state.currentLocation && state.startMode === "current") {
    points.push([state.currentLocation.lat, state.currentLocation.lon]);
  }
  if (state.endPoint) {
    points.push([state.endPoint.lat, state.endPoint.lon]);
  }

  if (points.length >= 2) {
    state.map.fitBounds(points, { padding: [40, 40], maxZoom: 15.5 });
  }
}

function updateMarker(kind, point, markerType, heading = 0) {
  removeMarker(kind);
  state.markers[kind] = L.marker([point.lat, point.lon], {
    icon: createMarkerIcon(markerType, heading),
  }).addTo(state.map);
}

function removeMarker(kind) {
  if (state.markers[kind]) {
    state.map.removeLayer(state.markers[kind]);
    state.markers[kind] = null;
  }
}

function createMarkerIcon(markerType, heading = 0) {
  if (markerType === "current") {
    return L.divIcon({
      className: "",
      html: `<div class="marker-arrow" style="transform: rotate(${heading}deg)"><span class="pulse-ring"></span></div>`,
      iconSize: [22, 22],
      iconAnchor: [11, 11],
    });
  }

  return L.divIcon({
    className: "",
    html: `<div class="marker-pin ${markerType}"></div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
}

function clearRouteAndInputs() {
  state.route = null;
  state.navigationActive = false;
  state.endPoint = null;
  clearRouteLayer();
  removeMarker("end");
  els.endInput.value = "";
  els.distanceOutput.textContent = "-";
  els.etaOutput.textContent = "-";
  els.startNavigation.disabled = true;
  els.returnButton.classList.add("is-hidden");
  setSummaryMessage("Välj start och destination.", "info");

  if (state.navWatchId && navigator.geolocation) {
    navigator.geolocation.clearWatch(state.navWatchId);
    state.navWatchId = null;
  }

  if (state.startMode === "manual") {
    state.startPoint = null;
    els.startInput.value = "";
    removeMarker("start");
  } else if (state.currentLocation) {
    state.startPoint = state.currentLocation;
  }
}

function setStatus(message, autoHideMs = 0) {
  window.clearTimeout(state.statusHideTimer);
  els.statusText.textContent = message;
  els.statusChip.classList.remove("is-hidden");

  if (autoHideMs > 0) {
    state.statusHideTimer = window.setTimeout(() => {
      els.statusChip.classList.add("is-hidden");
    }, autoHideMs);
  }
}

function setSummaryMessage(message, tone = "info") {
  els.summaryNote.textContent = message;
  els.summaryNote.dataset.tone = tone;
}

function pushEdge(adjacency, fromId, edge) {
  if (!adjacency.has(fromId)) {
    adjacency.set(fromId, []);
  }
  adjacency.get(fromId).push(edge);
}

function buildBBox(a, b, bufferKm) {
  const latPadding = bufferKm / 111;
  const meanLat = ((a.lat + b.lat) / 2) * (Math.PI / 180);
  const lonPadding = bufferKm / (111 * Math.max(Math.cos(meanLat), 0.2));

  return [
    Math.min(a.lat, b.lat) - latPadding,
    Math.min(a.lon, b.lon) - lonPadding,
    Math.max(a.lat, b.lat) + latPadding,
    Math.max(a.lon, b.lon) + lonPadding,
  ].map((value) => Number(value.toFixed(5)));
}

function toPoint(lat, lon, extra = {}) {
  return { lat, lon, ...extra };
}

function projectPointOntoSegment(point, fromCoord, toCoord) {
  const ax = fromCoord[1];
  const ay = fromCoord[0];
  const bx = toCoord[1];
  const by = toCoord[0];
  const px = point.lon;
  const py = point.lat;
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;

  if (!lengthSq) {
    return null;
  }

  const ratio = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq));
  const projLon = ax + ratio * dx;
  const projLat = ay + ratio * dy;

  return {
    lat: projLat,
    lon: projLon,
    ratio,
    distanceKm: haversineKm(point, { lat: projLat, lon: projLon }),
  };
}

function haversineKm(a, b) {
  const toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad;
  const dLon = (b.lon - a.lon) * toRad;
  const lat1 = a.lat * toRad;
  const lat2 = b.lat * toRad;
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const c = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;
  return 6371 * 2 * Math.atan2(Math.sqrt(c), Math.sqrt(1 - c));
}

function normalizeHeading(value) {
  return Number.isFinite(value) ? value : 0;
}

function formatDistance(km) {
  if (km < 1) {
    return `${Math.round(km * 1000)} m`;
  }
  return `${km.toFixed(km >= 10 ? 1 : 2)} km`;
}

function formatMinutes(minutes) {
  const rounded = Math.max(1, Math.round(minutes));
  if (rounded < 60) {
    return `${rounded} min`;
  }
  const hours = Math.floor(rounded / 60);
  const mins = rounded % 60;
  return mins ? `${hours} h ${mins} min` : `${hours} h`;
}

function formatLatLon(point) {
  return `${point.lat.toFixed(5)}, ${point.lon.toFixed(5)}`;
}

function firstLine(value) {
  return value.split(",")[0] || value;
}

function extractHouseNumber(value) {
  const match = value.toLowerCase().match(/\b\d+[a-zåäö]?\b/);
  return match ? match[0] : "";
}

function normalizeText(value) {
  return String(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function sameCoord(a, b) {
  return a && b && a[0] === b[0] && a[1] === b[1];
}

function readableHighwayName(highway) {
  switch (highway) {
    case "trunk":
    case "primary":
      return "huvudled";
    case "secondary":
    case "tertiary":
      return "landsväg";
    case "residential":
    case "living_street":
      return "lokalgata";
    case "cycleway":
      return "cykelväg";
    case "path":
      return "cykelstråk";
    case "service":
      return "småväg";
    default:
      return "väg";
  }
}

class MinHeap {
  constructor() {
    this.items = [];
  }

  push(item) {
    this.items.push(item);
    this.bubbleUp(this.items.length - 1);
  }

  pop() {
    if (!this.items.length) {
      return null;
    }
    const root = this.items[0];
    const last = this.items.pop();
    if (this.items.length && last) {
      this.items[0] = last;
      this.bubbleDown(0);
    }
    return root;
  }

  bubbleUp(index) {
    let currentIndex = index;
    while (currentIndex > 0) {
      const parentIndex = Math.floor((currentIndex - 1) / 2);
      if (this.items[parentIndex].cost <= this.items[currentIndex].cost) {
        break;
      }
      [this.items[parentIndex], this.items[currentIndex]] = [
        this.items[currentIndex],
        this.items[parentIndex],
      ];
      currentIndex = parentIndex;
    }
  }

  bubbleDown(index) {
    let currentIndex = index;
    while (true) {
      const leftIndex = currentIndex * 2 + 1;
      const rightIndex = currentIndex * 2 + 2;
      let smallest = currentIndex;

      if (leftIndex < this.items.length && this.items[leftIndex].cost < this.items[smallest].cost) {
        smallest = leftIndex;
      }

      if (rightIndex < this.items.length && this.items[rightIndex].cost < this.items[smallest].cost) {
        smallest = rightIndex;
      }

      if (smallest === currentIndex) {
        break;
      }

      [this.items[currentIndex], this.items[smallest]] = [
        this.items[smallest],
        this.items[currentIndex],
      ];
      currentIndex = smallest;
    }
  }

  isEmpty() {
    return this.items.length === 0;
  }
}
