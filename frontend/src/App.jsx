import { useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "./App.css";

const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:8000";
const MEI_API_BASE = import.meta.env.VITE_MEI_WORKER_URL || "http://localhost:8787";
const STORAGE_KEY = "snipe_and_cloak_v7";
const DEFAULT_CENTER = { lat: 29.652834, lon: -82.322222 };

const FLOW_STEPS = [
  {
    id: "hatsu",
    number: "01",
    name: "Hatsu",
    detail: "select routes",
    description: "Choose the routes worth watching.",
  },
  {
    id: "en",
    number: "02",
    name: "En",
    detail: "spatial stop scan",
    description: "Scan nearby stops through location, address, or map.",
  },
  {
    id: "gyo",
    number: "03",
    name: "Gyo",
    detail: "target stop",
    description: "Focus on the stop that matters.",
  },
  {
    id: "ken",
    number: "04",
    name: "Ken",
    detail: "threshold",
    description: "Choose a one-to-four stop alert threshold.",
  },
  {
    id: "mei",
    number: "05",
    name: "Mei",
    detail: "track",
    description: "Track live vehicle progress toward the target.",
  },
  {
    id: "kuro",
    number: "06",
    name: "Kuro",
    detail: "confirm",
    description: "Confirm boarding or return to tracking.",
  },
];

function normalizeStage(stage) {
  const aliases = {
    routes: "hatsu",
    stops: "en",
    cloak: "gyo",
    armed: "mei",
    released: "kuro",
  };

  return aliases[stage] || stage;
}

function getCurrentFlowStep(stage) {
  const normalized = normalizeStage(stage);
  const index = FLOW_STEPS.findIndex((step) => step.id === normalized);

  if (index === -1) {
    return {
      index: 0,
      current: FLOW_STEPS[0],
      next: FLOW_STEPS[1],
    };
  }

  return {
    index,
    current: FLOW_STEPS[index],
    next: FLOW_STEPS[(index + 1) % FLOW_STEPS.length],
  };
}

function ModePanel({ stage }) {
  const { index, current, next } = getCurrentFlowStep(stage);

  return (
    <section className="flowPanel">
      <div className="flowHeader">
        <span>Current mode</span>
        <strong>{current.number} / 06</strong>
      </div>

      <div className="flowCore">
        <div className="flowOrb">
          <span>{current.number}</span>
        </div>

        <div>
          <div className="flowName">{current.name}</div>
          <div className="flowDetail">{current.detail}</div>
        </div>
      </div>

      <p className="flowDescription">
        {current.description}
      </p>

      <div className="flowNext">
        <span>next</span>
        <strong>
          {next.name} — {next.detail}
        </strong>
      </div>

      <div className="flowCycle" aria-label="Execution pipeline">
        {FLOW_STEPS.map((step, stepIndex) => (
          <div
            key={step.id}
            className={
              stepIndex === index
                ? "flowNode active"
                : stepIndex < index
                  ? "flowNode complete"
                  : "flowNode"
            }
          >
            {step.number}
          </div>
        ))}
      </div>
    </section>
  );
}


function readSession() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveSession(data) {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

function clearSession() {
  sessionStorage.removeItem(STORAGE_KEY);
}

async function apiGet(path, base = API_BASE) {
  const res = await fetch(`${base}${path}`);
  const data = await res.json();
  if (!res.ok) {
    const detail = data?.detail;
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail || data || "Request failed"));
  }
  return data;
}

async function apiPost(path, body, base = API_BASE) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    const detail = data?.detail;
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail || data || "Request failed"));
  }
  return data;
}


function meiGet(path) {
  return apiGet(path, MEI_API_BASE);
}

function meiPost(path, body) {
  return apiPost(path, body, MEI_API_BASE);
}

function routeId(route) {
  return String(route?.route ?? route ?? "").trim();
}

function routeLabel(route) {
  return String(route?.display || route?.route || route || "");
}

function sortRoutes(a, b) {
  const av = Number(routeLabel(a));
  const bv = Number(routeLabel(b));
  if (!Number.isNaN(av) && !Number.isNaN(bv)) return av - bv;
  return routeLabel(a).localeCompare(routeLabel(b));
}


function numericRoute(route) {
  const n = Number(routeLabel(route));
  return Number.isNaN(n) ? 999 : n;
}

function routeBucket(route) {
  const n = numericRoute(route);
  if (n <= 12) return "core";
  if (n <= 25) return "transfer";
  if (n <= 52) return "distance";
  return "edge";
}

function routeSize(route) {
  const n = numericRoute(route);
  if ([1, 5, 8, 20, 33, 38, 75].includes(n)) return "big";
  if ([10, 12, 15, 23, 26, 37, 52].includes(n)) return "med";
  return "small";
}

const ROUTE_FIELDS = [
  ["core", "Campus Spine", "high-frequency campus lines"],
  ["transfer", "Transfer Weave", "routes that stitch transfer points"],
  ["distance", "Cross-town Runs", "longer city-spanning lines"],
  ["edge", "Outer Lines", "outer coverage and lower-frequency routes"],
];

function predictionLabel(prediction) {
  if (!prediction) return "no live signal";
  const eta = prediction.prdctdn ? `${prediction.prdctdn} min` : "live";
  const destination = prediction.des ? ` · ${prediction.des}` : "";
  return `${eta}${destination}`;
}

function getScheduledStart(timeValue) {
  if (!timeValue) return null;

  const [hh, mm] = timeValue.split(":").map(Number);
  if (Number.isNaN(hh) || Number.isNaN(mm)) return null;

  const start = new Date();
  start.setHours(hh, mm, 0, 0);

  // If the chosen clock time already passed, interpret it as tomorrow.
  if (start.getTime() <= Date.now()) {
    start.setDate(start.getDate() + 1);
  }

  return start;
}

function formatClock(value) {
  if (!value) return "now";
  return new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function groupLatLon(group) {
  const first = group?.candidates?.find((c) => c.lat && c.lon);
  return first ? { lat: first.lat, lon: first.lon } : null;
}

function titleFor(stage) {
  if (stage === "hatsu") return "Hatsu";
  if (stage === "en") return "En";
  if (stage === "gyo") return "Gyo";
  if (stage === "ken") return "Ken";
  if (stage === "mei") return "Mei";
  if (stage === "kuro") return "Kuro";
  return "Snipe and Cloak";
}

function subtitleFor(stage) {
  if (stage === "hatsu") return "Choose routes before the space is scanned.";
  if (stage === "en") return "Locate possible stops through current position, address, map, or route list.";
  if (stage === "gyo") return "Focus on the target stop to cloak.";
  if (stage === "ken") return "Choose the Ken threshold: 1, 2, 3, or 4 stops before target.";
  if (stage === "mei") return "Backend worker watches live progress and records checkpoint history.";
  if (stage === "kuro") return "Final approach reached. Confirm whether you boarded.";
  return "";
}

function MapPanel({ center, groups, activeIndex, onSelectGroup, onMapClick, className = "" }) {
  const mapEl = useRef(null);
  const mapRef = useRef(null);
  const markerLayerRef = useRef(null);

  useEffect(() => {
    if (!mapEl.current || mapRef.current) return;

    const map = L.map(mapEl.current, { zoomControl: false }).setView(
      [center.lat, center.lon],
      15
    );

    L.control.zoom({ position: "bottomright" }).addTo(map);

    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);

    map.on("click", (event) => {
      onMapClick?.({ lat: event.latlng.lat, lon: event.latlng.lng });
    });

    markerLayerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;

    setTimeout(() => map.invalidateSize(), 100);
  }, []);

  useEffect(() => {
    if (!mapRef.current || !center) return;
    mapRef.current.setView([center.lat, center.lon], mapRef.current.getZoom() || 15, {
      animate: true,
    });
  }, [center?.lat, center?.lon]);

  useEffect(() => {
    if (!mapRef.current || !markerLayerRef.current) return;

    const layer = markerLayerRef.current;
    layer.clearLayers();

    if (center) {
      L.circleMarker([center.lat, center.lon], {
        radius: 7,
        color: "#e6c15a",
        weight: 2,
        fillColor: "#111111",
        fillOpacity: 0.95,
      })
        .bindTooltip("scan point", { direction: "top" })
        .addTo(layer);
    }

    groups.forEach((group, index) => {
      const pos = groupLatLon(group);
      if (!pos) return;

      const active = index === activeIndex;
      const marker = L.circleMarker([pos.lat, pos.lon], {
        radius: active ? 11 : 8,
        color: active ? "#111111" : "#78350f",
        weight: active ? 3 : 2,
        fillColor: active ? "#e6c15a" : "#f4f1ea",
        fillOpacity: active ? 0.95 : 0.8,
      });

      marker.bindTooltip(group.label || "stop", { direction: "top" });
      marker.on("click", () => onSelectGroup?.(index));
      marker.addTo(layer);
    });

    if (groups.length > 0) {
      const points = groups.map(groupLatLon).filter(Boolean).map((p) => [p.lat, p.lon]);
      if (points.length > 1) {
        mapRef.current.fitBounds(points, { padding: [48, 48], maxZoom: 17 });
      }
    }
  }, [groups, activeIndex, center?.lat, center?.lon]);

  return <div className={`mapPanel ${className}`} ref={mapEl} />;
}

export default function App() {
  const [stage, setStage] = useState("hatsu");
  const [routes, setRoutes] = useState([]);
  const [selectedRoutes, setSelectedRoutes] = useState([]);
  const [routeFilter, setRouteFilter] = useState("");
  const [routeFieldFocus, setRouteFieldFocus] = useState("");
  const [location, setLocation] = useState(null);
  const [candidateGroups, setCandidateGroups] = useState([]);
  const [selectedGroupIndex, setSelectedGroupIndex] = useState(0);
  const [kenTrigger, setKenTrigger] = useState(1);
  const [meiStartTime, setMeiStartTime] = useState("");
  const [meiScheduledFor, setMeiScheduledFor] = useState(null);
  const [meiSessionId, setMeiSessionId] = useState(null);
  const [watchPlans, setWatchPlans] = useState([]);
  const [watchStates, setWatchStates] = useState([]);
  const [eventLog, setEventLog] = useState([]);
  const [meiSignal, setMeiSignal] = useState(null);
  const [enMode, setEnMode] = useState("current");
  const [query, setQuery] = useState("");
  const [addressResults, setAddressResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const firedRef = useRef(new Set());

  const filteredRoutes = useMemo(() => {
    const q = routeFilter.trim().toLowerCase();
    const base = [...routes].sort(sortRoutes);
    if (!q) return base;
    return base.filter((route) => {
      const id = routeId(route).toLowerCase();
      const label = routeLabel(route).toLowerCase();
      const name = String(route.name || "").toLowerCase();
      return id.includes(q) || label.includes(q) || name.includes(q);
    });
  }, [routes, routeFilter]);

  const routeBuckets = useMemo(() => {
    const grouped = { core: [], transfer: [], distance: [], edge: [] };
    filteredRoutes.forEach((route) => {
      grouped[routeBucket(route)].push(route);
    });
    return grouped;
  }, [filteredRoutes]);

  const hatsuBlocks = useMemo(() => {
    return [
      ["all", "All lines", "entire route atlas", filteredRoutes.length],
      ...ROUTE_FIELDS.map(([key, label, description]) => [
        key,
        label,
        description,
        routeBuckets[key]?.length || 0,
      ]),
    ];
  }, [filteredRoutes.length, routeBuckets]);

  const expandedRoutes = useMemo(() => {
    if (!routeFieldFocus) return [];
    if (routeFieldFocus === "all") return filteredRoutes;
    return routeBuckets[routeFieldFocus] || [];
  }, [routeFieldFocus, filteredRoutes, routeBuckets]);

  const selectedGroup = candidateGroups[selectedGroupIndex] || null;
  const mapCenter = groupLatLon(selectedGroup) || location || DEFAULT_CENTER;

  useEffect(() => {
    const sessionFromUrl = new URLSearchParams(window.location.search).get("mei");
    const saved = readSession();
    if (saved) {
      setStage(saved.stage || "hatsu");
      setSelectedRoutes(saved.selectedRoutes || []);
      setRouteFieldFocus(saved.routeFieldFocus || "");
      setLocation(saved.location || null);
      setCandidateGroups(saved.candidateGroups || []);
      setSelectedGroupIndex(saved.selectedGroupIndex || 0);
      setKenTrigger(saved.kenTrigger || 1);
      setMeiStartTime(saved.meiStartTime || "");
      setMeiScheduledFor(saved.meiScheduledFor || null);
      setMeiSessionId(saved.meiSessionId || null);
      setWatchPlans(saved.watchPlans || []);
      setEventLog(saved.eventLog || []);
    }

    if (sessionFromUrl) {
      setMeiSessionId(sessionFromUrl);
      setStage("mei");
    }

    loadRoutes();
  }, []);

  useEffect(() => {
    saveSession({
      stage,
      selectedRoutes,
      routeFieldFocus,
      location,
      candidateGroups,
      selectedGroupIndex,
      kenTrigger,
      meiStartTime,
      meiScheduledFor,
      meiSessionId,
      watchPlans,
      eventLog,
    });
  }, [stage, selectedRoutes, routeFieldFocus, location, candidateGroups, selectedGroupIndex, kenTrigger, meiStartTime, meiScheduledFor, meiSessionId, watchPlans, eventLog]);

  async function loadRoutes() {
    try {
      setLoading(true);
      setError("");
      const data = await apiGet("/api/routes");
      setRoutes(data.routes || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  function toggleRoute(route) {
    const id = routeId(route);
    setSelectedRoutes((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      return [...prev, id];
    });
  }

  function goEn() {
    if (!selectedRoutes.length) {
      setError("Select at least one route in Hatsu.");
      return;
    }
    setError("");
    setStage("en");
  }

  async function resolveByPoint(point, radius = 900) {
    if (!selectedRoutes.length) return;
    setLoading(true);
    setError("");
    try {
      setLocation(point);
      const data = await apiPost("/api/resolve-start", {
        routes: selectedRoutes,
        lat: point.lat,
        lon: point.lon,
        radius_m: radius,
        max_candidates_per_route: 8,
      });
      setCandidateGroups(data.best_groups || []);
      setSelectedGroupIndex(0);
      if (!(data.best_groups || []).length) {
        setError("No nearby stops were found for the selected routes. Use route list fallback.");
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function useCurrentLocation() {
    if (!navigator.geolocation) {
      setError("Current location is not available in this browser. Use address, map, or route list.");
      return;
    }

    setLoading(true);
    setError("");
    try {
      const pos = await new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 12000,
          maximumAge: 15000,
        });
      });
      await resolveByPoint({
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        source: "current",
      });
    } catch (err) {
      setError("Current location was blocked or unavailable. Use Address / stop, Map, or Route list.");
      setLoading(false);
    }
  }

  async function searchAddressOrStop() {
    if (!query.trim()) return;
    setLoading(true);
    setError("");
    setAddressResults([]);

    try {
      const stopData = await apiGet(`/api/search-stops?query=${encodeURIComponent(query)}&routes=${encodeURIComponent(selectedRoutes.join(","))}&limit=40`);

      if (stopData.best_groups?.length) {
        setCandidateGroups(stopData.best_groups);
        setSelectedGroupIndex(0);
      }

      const geo = await apiGet(`/api/geocode?q=${encodeURIComponent(query + ", Gainesville, FL")}`);
      setAddressResults(geo.results || []);

      if (!stopData.best_groups?.length && geo.results?.length) {
        const first = geo.results[0];
        await resolveByPoint({ lat: first.lat, lon: first.lon, source: "address", label: first.label }, 1000);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function useRouteListFallback() {
    setLoading(true);
    setError("");
    try {
      const data = await apiPost("/api/selected-route-stops", {
        routes: selectedRoutes,
        include_predictions: false,
      });
      setCandidateGroups(data.best_groups || []);
      setSelectedGroupIndex(0);
      setLocation(null);
      if (!(data.best_groups || []).length) setError("No stops were returned for those routes.");
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  function continueToGyo() {
    if (!candidateGroups.length) {
      setError("Select or generate at least one stop candidate in En.");
      return;
    }
    setError("");
    setStage("gyo");
  }

  function continueToKen() {
    if (!selectedGroup) {
      setError("Select a target stop in Gyo.");
      return;
    }
    setError("");
    setStage("ken");
  }


  async function requestNotificationPermission() {
    if ("Notification" in window && Notification.permission === "default") {
      try {
        await Notification.requestPermission();
      } catch {
        // Non-blocking. Production FCM will still store server-side events.
      }
    }
  }
  async function startWatchNow() {
    if (!selectedGroup) return;

    setLoading(true);
    setError("");
    firedRef.current = new Set();
    setWatchStates([]);

    try {
      await requestNotificationPermission();
      const session = await meiPost("/api/mei/start", {
        candidates: selectedGroup.candidates || [],
        trigger_distance: kenTrigger,
        start_at: null,
        poll_seconds: 8,
      });

      setMeiSessionId(session.session_id);
      setWatchPlans(session.watch_plans || []);
      setWatchStates(session.watch_states || []);
      setMeiScheduledFor(null);
      setStage("mei");
      window.history.replaceState(null, "", `${window.location.pathname}?mei=${session.session_id}`);

      setEventLog((prev) => [
        {
          id: `mei-started:${Date.now()}`,
          type: "mei",
          message: "Mei worker started. You can reopen this session link while the backend is running.",
          time: new Date().toLocaleTimeString(),
        },
        ...prev,
      ]);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function armMei() {
    if (!selectedGroup) return;

    const scheduled = getScheduledStart(meiStartTime);

    if (scheduled && scheduled.getTime() - Date.now() > 15000) {
      try {
        setLoading(true);
        setError("");
        setWatchPlans([]);
        setWatchStates([]);
        await requestNotificationPermission();
        const session = await meiPost("/api/mei/start", {
          candidates: selectedGroup.candidates || [],
          trigger_distance: kenTrigger,
          start_at: scheduled.toISOString(),
          poll_seconds: 8,
        });
        setMeiSessionId(session.session_id);
        setMeiScheduledFor(scheduled.toISOString());
        setStage("mei");
        window.history.replaceState(null, "", `${window.location.pathname}?mei=${session.session_id}`);
        setEventLog((prev) => [
          {
            id: `mei-scheduled:${Date.now()}`,
            type: "mei",
            message: `Mei worker scheduled for ${formatClock(scheduled.toISOString())}. It will choose the first live bus after that time.`,
            time: new Date().toLocaleTimeString(),
          },
          ...prev,
        ]);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
      return;
    }

    await startWatchNow();
  }

  useEffect(() => {
    if (stage !== "mei" || !meiSessionId) return;
    let cancelled = false;

    async function pollSession() {
      try {
        const session = await meiGet(`/api/mei/${meiSessionId}`);
        if (cancelled) return;

        const events = session.events || [];
        setWatchPlans(session.watch_plans || []);
        setWatchStates(session.watch_states || []);
        setEventLog(events);

        const latestKen = events.find((event) => event.type === "ken");
        if (latestKen && !firedRef.current.has(latestKen.id)) {
          firedRef.current.add(latestKen.id);
          setMeiSignal(latestKen);

          if ("Notification" in window && Notification.permission === "granted") {
            new Notification("Snipe and Cloak", { body: latestKen.message });
          }
        }

        const hasKuroEvent = events.some((event) => event.type === "kuro");
        if (session.status === "kuro_pending" || hasKuroEvent) {
          setStage("kuro");
        }
      } catch (err) {
        if (!cancelled) setError(err.message);
      }
    }

    pollSession();
    const timer = setInterval(pollSession, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [stage, meiSessionId]);

  async function boardedYes() {
    if (meiSessionId) {
      try { await meiPost(`/api/mei/${meiSessionId}/boarded`, {}); } catch {}
    }
    clearSession();
    window.history.replaceState(null, "", window.location.pathname);
    firedRef.current = new Set();
    setStage("hatsu");
    setSelectedRoutes([]);
    setRouteFilter("");
    setRouteFieldFocus("");
    setLocation(null);
    setCandidateGroups([]);
    setSelectedGroupIndex(0);
    setKenTrigger(1);
    setMeiStartTime("");
    setMeiScheduledFor(null);
    setMeiSessionId(null);
    setWatchPlans([]);
    setWatchStates([]);
    setEventLog([]);
    setMeiSignal(null);
    setError("");
  }

  async function boardedNo() {
    setError("");
    if (!meiSessionId) {
      await startWatchNow();
      return;
    }
    try {
      setLoading(true);
      const session = await meiPost(`/api/mei/${meiSessionId}/next`, {});
      setMeiSessionId(session.session_id);
      setWatchPlans(session.watch_plans || []);
      setWatchStates(session.watch_states || []);
      setEventLog(session.events || []);
      setStage("mei");
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  function clearAll() {
    clearSession();
    window.history.replaceState(null, "", window.location.pathname);
    firedRef.current = new Set();
    setStage("hatsu");
    setSelectedRoutes([]);
    setRouteFilter("");
    setRouteFieldFocus("");
    setLocation(null);
    setCandidateGroups([]);
    setSelectedGroupIndex(0);
    setKenTrigger(1);
    setMeiStartTime("");
    setMeiScheduledFor(null);
    setMeiSessionId(null);
    setWatchPlans([]);
    setWatchStates([]);
    setEventLog([]);
    setMeiSignal(null);
    setError("");
  }

  return (
    <main className="page">
      <aside className="rail">
        <div>
          <div className="brand">Snipe and Cloak</div>
          <div className="brandSub">Focused transit signal</div>
        </div>

        <ModePanel stage={stage} />

        <button className="subtleButton" onClick={clearAll}>
          Clear session
        </button>
      </aside>

      <section className="main">
        <header className="top">
          <div>
            <p className="mono">{stage.toUpperCase()}</p>
            <h1>{titleFor(stage)}</h1>
            <p className="subcopy">{subtitleFor(stage)}</p>
          </div>
          <div className="readyPill">{loading ? "working" : "ready"}</div>
        </header>

        {error && <div className="error">{error}</div>}

        {stage === "hatsu" && (
          <section className="surface hatsuGrid hatsuGridV5">
            <div className="copyBlock">
              <p className="mono bronze">HATSU</p>
              <h2>Select the buses first.</h2>
              <p>No presets. Search directly, or open a route family. The atlas stays collapsed until you ask for detail.</p>

              <div className="selectedBox">
                <span>Selected routes</span>
                <strong>{selectedRoutes.length ? selectedRoutes.join(" · ") : "none"}</strong>
              </div>
            </div>

            <div className="routeBlock routeBlockV5">
              <input
                className="search"
                value={routeFilter}
                onChange={(e) => setRouteFilter(e.target.value)}
                placeholder="Search route number or destination"
              />

              <div className="fieldDeck">
                {hatsuBlocks.map(([key, label, description, count]) => (
                  <button
                    key={key}
                    className={routeFieldFocus === key ? `fieldBlock ${key} active` : `fieldBlock ${key}`}
                    onClick={() => setRouteFieldFocus(routeFieldFocus === key ? "" : key)}
                  >
                    <span>{label}</span>
                    <strong>{count}</strong>
                    <em>{description}</em>
                  </button>
                ))}
              </div>

              {routeFilter.trim() && (
                <div className="expandedRoutes searchResults">
                  <div className="expandedHead">
                    <span>Search result</span>
                    <strong>{filteredRoutes.length}</strong>
                  </div>
                  <div className="routeListTwoCol">
                    {filteredRoutes.map((route) => (
                      <RouteNode
                        key={routeId(route)}
                        route={route}
                        active={selectedRoutes.includes(routeId(route))}
                        onToggle={toggleRoute}
                      />
                    ))}
                  </div>
                </div>
              )}

              {!routeFilter.trim() && routeFieldFocus && (
                <div className="expandedRoutes">
                  <div className="expandedHead">
                    <span>{hatsuBlocks.find(([key]) => key === routeFieldFocus)?.[1]}</span>
                    <strong>{expandedRoutes.length}</strong>
                  </div>
                  <div className="routeListTwoCol">
                    {expandedRoutes.map((route) => (
                      <RouteNode
                        key={routeId(route)}
                        route={route}
                        active={selectedRoutes.includes(routeId(route))}
                        onToggle={toggleRoute}
                      />
                    ))}
                  </div>
                </div>
              )}

              {!routeFilter.trim() && !routeFieldFocus && (
                <div className="empty quietEmpty">Open a route family or search to reveal bus lines.</div>
              )}

              {filteredRoutes.length === 0 && routeFilter.trim() && (
                <div className="empty">No routes match the filter. Clear the filter to reveal all route families.</div>
              )}

              <button className="primary" onClick={goEn} disabled={!selectedRoutes.length || loading}>Proceed to En</button>
            </div>
          </section>
        )}

        {stage === "en" && (
          <section className="surface enGrid">
            <div className="toolColumn">
              <p className="mono bronze">EN</p>
              <h2>Find the stop-space.</h2>

              <div className="modeGrid">
                {[["current", "Current"], ["address", "Address / stop"], ["map", "Map"], ["list", "Route list"]].map(([key, label]) => (
                  <button key={key} className={enMode === key ? "mode active" : "mode"} onClick={() => setEnMode(key)}>{label}</button>
                ))}
              </div>

              {enMode === "current" && (
                <div className="optionPanel">
                  <p>Use browser location and show candidate stops near you for routes {selectedRoutes.join(", ")}.</p>
                  <button className="primary full" onClick={useCurrentLocation} disabled={loading}>Use current location</button>
                </div>
              )}

              {enMode === "address" && (
                <div className="optionPanel">
                  <p>Search by stop name or address. Stop matches appear immediately; address matches can scan nearby stops.</p>
                  <div className="queryRow">
                    <input className="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Rawlings Hall, Museum Rd, address..." />
                    <button className="primary compact" onClick={searchAddressOrStop} disabled={loading || !query.trim()}>Search</button>
                  </div>
                  {addressResults.length > 0 && (
                    <div className="addressResults">
                      {addressResults.map((result, index) => (
                        <button key={`${result.label}-${index}`} onClick={() => resolveByPoint({ lat: result.lat, lon: result.lon, source: "address", label: result.label }, 1000)}>
                          {result.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {enMode === "map" && (
                <div className="optionPanel">
                  <p>Click the map. En scans around that point for stops served by your selected routes.</p>
                  <div className="hint">Map center starts at the OpenStreetMap coordinate you provided.</div>
                </div>
              )}

              {enMode === "list" && (
                <div className="optionPanel">
                  <p>Fallback path: ignore location and show stops from the selected route patterns.</p>
                  <button className="primary full" onClick={useRouteListFallback} disabled={loading}>Load route stop list</button>
                </div>
              )}

              <div className="candidateCount">
                <span>Candidates</span>
                <strong>{candidateGroups.length}</strong>
              </div>

              <button className="primary full" onClick={continueToGyo} disabled={!candidateGroups.length}>Proceed to Gyo</button>
            </div>

            <div className="mapStack">
              <MapPanel center={mapCenter} groups={candidateGroups} activeIndex={selectedGroupIndex} onSelectGroup={setSelectedGroupIndex} onMapClick={(point) => { setEnMode("map"); resolveByPoint({ ...point, source: "map" }, 900); }} />
              <div className="miniList">
                {candidateGroups.slice(0, 8).map((group, index) => (
                  <button key={`${group.label}-${index}`} className={index === selectedGroupIndex ? "miniStop active" : "miniStop"} onClick={() => setSelectedGroupIndex(index)}>
                    <strong>{group.label}</strong>
                    <span>{group.routes_served?.join(", ")} {group.min_distance_m ? `· ${Math.round(group.min_distance_m)}m` : ""}</span>
                  </button>
                ))}
              </div>
            </div>
          </section>
        )}

        {stage === "gyo" && (
          <section className="surface gyoGrid">
            <div className="copyBlock">
              <p className="mono bronze">GYO</p>
              <h2>Choose the target stop.</h2>
              <p>This is the stop the bus is approaching. Mei tracks vehicles toward this stop, and Ken decides which checkpoint alerts you.</p>
              <button className="primary" onClick={continueToKen} disabled={!selectedGroup}>Proceed to Ken</button>
            </div>
            <div className="focusArea">
              <MapPanel center={mapCenter} groups={candidateGroups} activeIndex={selectedGroupIndex} onSelectGroup={setSelectedGroupIndex} />
              <div className="targetList">
                {candidateGroups.map((group, index) => (
                  <button key={`${group.label}-${index}`} className={index === selectedGroupIndex ? "target active" : "target"} onClick={() => setSelectedGroupIndex(index)}>
                    <strong>{group.label}</strong>
                    <span>{group.routes_served?.join(" · ")}</span>
                  </button>
                ))}
              </div>
            </div>
          </section>
        )}

        {stage === "ken" && (
          <section className="surface kenGrid">
            <div className="copyBlock">
              <p className="mono bronze">KEN</p>
              <h2>Set the Ken threshold.</h2>
              <p>Choose the checkpoint that should alert you before the target. No sound is required; Mei records the event and can notify from the backend later.</p>
              <div className="selectedBox">
                <span>Target</span>
                <strong>{selectedGroup?.label || "none"}</strong>
              </div>
            </div>
            <div className="kenPanel">
              {[1, 2, 3, 4].map((distance) => (
                <button
                  key={distance}
                  className={kenTrigger === distance ? "kenChoice active" : "kenChoice"}
                  onClick={() => setKenTrigger(distance)}
                >
                  <strong>{distance}</strong>
                  <span>{distance === 1 ? "stop" : "stops"} before target</span>
                </button>
              ))}
              <div className="meiScheduleCard">
                <span className="label">Mei start</span>
                <p>Leave blank to start now. Set a time to catch the first live bus after that clock time.</p>
                <div className="scheduleRow">
                  <input
                    className="timeInput"
                    type="time"
                    value={meiStartTime}
                    onChange={(e) => setMeiStartTime(e.target.value)}
                  />
                  <button className="secondary" onClick={() => setMeiStartTime("")}>Now</button>
                </div>
              </div>
              <button className="primary full" onClick={armMei} disabled={loading}>
                {meiStartTime ? `Schedule Mei for ${meiStartTime}` : "Arm Mei"}
              </button>
            </div>
          </section>
        )}

        {stage === "mei" && (
          <section className="surface meiGrid">
            <div className="copyBlock slim">
              <p className="mono bronze">MEI</p>
              <h2>Worker active.</h2>
              <p>Mei runs as a backend worker. It logs the 4, 3, 2, and 1 stop checkpoints as the bus approaches the target. Kuro opens at one stop before target.</p>
              {meiSignal && (
                <div className="meiSignal">
                  <span>Ken threshold</span>
                  <strong>{meiSignal.message}</strong>
                  <em>{meiSignal.time}</em>
                </div>
              )}
              {meiScheduledFor && !watchPlans.length && (
                <div className="selectedBox cyanBox">
                  <span>Scheduled start</span>
                  <strong>{formatClock(meiScheduledFor)}</strong>
                </div>
              )}
              {meiSessionId && (
                <div className="selectedBox linkBox">
                  <span>Session link</span>
                  <strong>{`${window.location.origin}${window.location.pathname}?mei=${meiSessionId}`}</strong>
                  <em>Worker endpoint: {MEI_API_BASE}</em>
                </div>
              )}
              <div className="selectedBox">
                <span>Ken</span>
                <strong>{kenTrigger} stop{kenTrigger === 1 ? "" : "s"} before</strong>
              </div>
            </div>
            <div className="watchArea">
              <div className="watchGrid">
                {watchPlans.map((item, index) => {
                  const state = watchStates.find((s) => s?.candidate?.route === item.candidate.route) || {};
                  return (
                    <div className="watchCard" key={`${item.candidate.route}-${index}`}>
                      <div className="watchTop"><strong>{item.candidate.route}</strong><span>{state.status || item.plan.status}</span></div>
                      <div className="watchStop">{item.candidate.stop_name}</div>
                      <div className="watchMeta">
                        <span>{predictionLabel(state.prediction || item.plan.prediction)}</span>
                        <span>vehicle {item.plan.vehicle_id || "n/a"}</span>
                        <span>progress {state.current_pdist ? Math.round(state.current_pdist) : "n/a"}</span>
                        {(state.error || item.plan.message) && <span className="errorText">{state.error || item.plan.message}</span>}
                      </div>
                    </div>
                  );
                })}
              </div>
              <EventLog events={eventLog} />
            </div>
          </section>
        )}

        {stage === "kuro" && (
          <section className="surface kuroGrid">
            <div className="copyBlock">
              <p className="mono bronze">KURO</p>
              <h2>Final approach.</h2>
              <p>The bus reached one stop before your target. Confirm whether you boarded. Yes clears the session and returns to Hatsu. No returns to Mei and arms the next live vehicle.</p>
            </div>
            <div className="kuroPanel">
              <EventLog events={eventLog} />
              <div className="confirmRow">
                <button className="primary" onClick={boardedYes}>Boarded</button>
                <button className="secondary" onClick={boardedNo}>Not yet</button>
              </div>
            </div>
          </section>
        )}
      </section>
    </main>
  );
}

function RouteNode({ route, active, onToggle }) {
  return (
    <button
      className={`routeNode listNode ${active ? "active" : ""}`}
      onClick={() => onToggle(route)}
    >
      <span className="routeNum">{routeLabel(route)}</span>
      <span className="routeDest">{route.name || "RTS"}</span>
    </button>
  );
}

function EventLog({ events }) {
  return (
    <div className="logPanel">
      <span className="mono bronze">Log</span>
      {events.length === 0 && <p>No events yet.</p>}
      {events.map((event) => (
        <div className="logItem" key={event.id}>
          <strong>{event.message}</strong>
          <span>{event.time}</span>
        </div>
      ))}
    </div>
  );
}
