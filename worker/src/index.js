const DEFAULT_POLL_SECONDS = 20;
const LIVE_REPLAN_SECONDS = 30;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return corsResponse(null, 204);

    if (url.pathname === "/health") {
      return json({ ok: true, service: "snipe-and-cloak-mei-worker" });
    }

    if (url.pathname === "/api/mei/start" && request.method === "POST") {
      const body = await request.json();
      const sessionId = crypto.randomUUID().replaceAll("-", "");
      const stub = getSessionStub(env, sessionId);

      const response = await stub.fetch("https://mei-session/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...body, session_id: sessionId }),
      });

      return corsResponse(await response.text(), response.status, {
        "content-type": "application/json",
      });
    }

    const match = url.pathname.match(/^\/api\/mei\/([^/]+)(?:\/([^/]+))?$/);
    if (match) {
      const sessionId = match[1];
      const action = match[2] || "status";

      if (action === "next" && request.method === "POST") {
        const oldStub = getSessionStub(env, sessionId);
        const oldResponse = await oldStub.fetch("https://mei-session/status");
        if (!oldResponse.ok) {
          return corsResponse(await oldResponse.text(), oldResponse.status, {
            "content-type": "application/json",
          });
        }

        const oldSession = await oldResponse.json();
        await oldStub.fetch("https://mei-session/replace", { method: "POST" });

        const newSessionId = crypto.randomUUID().replaceAll("-", "");
        const newStub = getSessionStub(env, newSessionId);
        const newResponse = await newStub.fetch("https://mei-session/start", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            session_id: newSessionId,
            candidates: oldSession.candidates || [],
            trigger_distance: oldSession.trigger_distance || 1,
            start_at: null,
            poll_seconds: oldSession.poll_seconds || DEFAULT_POLL_SECONDS,
          }),
        });

        return corsResponse(await newResponse.text(), newResponse.status, {
          "content-type": "application/json",
        });
      }

      const stub = getSessionStub(env, sessionId);

      if (action === "status" && request.method === "GET") {
        const response = await stub.fetch("https://mei-session/status");
        return corsResponse(await response.text(), response.status, {
          "content-type": "application/json",
        });
      }

      if (action === "boarded" && request.method === "POST") {
        const response = await stub.fetch("https://mei-session/boarded", { method: "POST" });
        return corsResponse(await response.text(), response.status, {
          "content-type": "application/json",
        });
      }
    }

    return json({ error: "not_found" }, 404);
  },
};

export class MeiSession {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/start" && request.method === "POST") {
      const body = await request.json();
      const triggerDistance = clampInt(body.trigger_distance || 1, 1, 4);
      const pollSeconds = clampInt(body.poll_seconds || DEFAULT_POLL_SECONDS, 5, 120);
      const startAt = body.start_at || null;

      const session = {
        session_id: body.session_id,
        status: startAt ? "scheduled" : "queued",
        created_at: nowIso(),
        started_at: null,
        start_at: startAt,
        last_poll_at: null,
        trigger_distance: triggerDistance,
        poll_seconds: pollSeconds,
        candidates: Array.isArray(body.candidates) ? body.candidates : [],
        watch_plans: [],
        watch_states: [],
        watchable_count: 0,
        fired_keys: [],
        lost_after_threshold_counts: {},
        events: [makeEvent("mei", "Mei worker request accepted. Durable Object owns this session.")],
        cancelled: false,
      };

      await this.state.storage.put("session", session);
      await this.scheduleNext(session, 1000);
      return json(session);
    }

    if (url.pathname === "/status" && request.method === "GET") {
      const session = await this.state.storage.get("session");
      if (!session) return json({ error: "session_not_found" }, 404);
      return json(publicSession(session));
    }

    if (url.pathname === "/boarded" && request.method === "POST") {
      const session = await this.state.storage.get("session");
      if (!session) return json({ error: "session_not_found" }, 404);

      const next = appendEvent({ ...session, status: "boarded", cancelled: true }, "kuro", "Boarded confirmed. Session closed.");
      await this.state.storage.put("session", next);
      return json(publicSession(next));
    }

    if (url.pathname === "/replace" && request.method === "POST") {
      const session = await this.state.storage.get("session");
      if (!session) return json({ error: "session_not_found" }, 404);
      const next = appendEvent({ ...session, status: "replaced", cancelled: true }, "kuro", "Session replaced by next vehicle request.");
      await this.state.storage.put("session", next);
      return json(publicSession(next));
    }

    return json({ error: "not_found" }, 404);
  }

  async alarm() {
    let session = await this.state.storage.get("session");
    if (!session || session.cancelled || ["boarded", "replaced"].includes(session.status)) return;

    const startAtMs = session.start_at ? Date.parse(session.start_at) : null;
    if (startAtMs && Date.now() < startAtMs) {
      session.status = "scheduled";
      await this.state.storage.put("session", session);
      await this.scheduleNext(session, Math.max(1000, Math.min(startAtMs - Date.now(), 60_000)));
      return;
    }

    if (!session.started_at) {
      session.started_at = nowIso();
      session = appendEvent(session, "mei", "Mei worker started. Planning live route signals.");
    }

    const currentPlans = Array.isArray(session.watch_plans) ? session.watch_plans : [];
    const hasWatchable = currentPlans.some((item) => item?.plan?.status === "watchable");

    if (!hasWatchable) {
      const plans = await this.buildWatchPlans(session.candidates || []);
      const watchableCount = plans.filter((item) => item?.plan?.status === "watchable").length;
      session.watch_plans = plans;
      session.watchable_count = watchableCount;
      session.status = watchableCount ? "tracking" : "waiting_for_live_bus";
      session.last_poll_at = nowIso();

      if (watchableCount) {
        session = appendEvent(session, "mei", `Mei acquired ${watchableCount} live route signal${watchableCount === 1 ? "" : "s"}.`);
      } else {
        session = appendEventLimited(session, "mei_waiting", "No live bus is watchable yet. Mei will retry.", 1);
      }

      await this.state.storage.put("session", session);
      await this.scheduleNext(session, watchableCount ? 1000 : LIVE_REPLAN_SECONDS * 1000);
      return;
    }

    const result = await this.pollTrackingSession(session);
    await this.state.storage.put("session", result);

    if (!result.cancelled && result.status !== "kuro_pending") {
      await this.scheduleNext(result, (result.poll_seconds || DEFAULT_POLL_SECONDS) * 1000);
    }
  }

  async scheduleNext(_session, delayMs) {
    await this.state.storage.setAlarm(Date.now() + Math.max(1000, delayMs));
  }

  async buildWatchPlans(candidates) {
    const plans = [];
    for (const candidate of candidates) {
      const route = String(candidate.route || "").trim();
      const stopId = String(candidate.stop_id || "").trim();
      if (!route || !stopId) continue;
      const plan = await this.watchPlan({ route, stop_id: stopId, alert_stop_id: stopId });
      plans.push({ candidate, plan });
    }
    return plans;
  }

  async watchPlan(req) {
    const alertStopId = String(req.alert_stop_id || req.stop_id);
    const predictions = await this.getPredictions(req.route, req.stop_id, 3);

    if (!predictions.length) {
      return {
        status: "no_live_prediction",
        route: req.route,
        stop_id: req.stop_id,
        alert_stop_id: alertStopId,
        message: "No live prediction found for this route/stop.",
      };
    }

    const prediction = predictions[0];
    const vehicleId = prediction.vid;
    if (!vehicleId) {
      return { status: "prediction_only", route: req.route, stop_id: req.stop_id, alert_stop_id: alertStopId, prediction };
    }

    const vehicle = await this.getVehicle(vehicleId);
    if (!vehicle) {
      return { status: "vehicle_missing", route: req.route, stop_id: req.stop_id, alert_stop_id: alertStopId, vehicle_id: vehicleId, prediction };
    }

    const patternId = vehicle.pid;
    if (!patternId) {
      return { status: "pattern_missing", route: req.route, stop_id: req.stop_id, alert_stop_id: alertStopId, vehicle_id: vehicleId, prediction, vehicle };
    }

    const pattern = await this.getPattern(patternId);
    if (!pattern) {
      return { status: "pattern_not_found", route: req.route, stop_id: req.stop_id, alert_stop_id: alertStopId, vehicle_id: vehicleId, pattern_id: patternId, prediction, vehicle };
    }

    const stopPoints = extractPatternStops(pattern);
    const currentPdist = safeFloat(vehicle.pdist);
    const alertIndex = findBestTargetIndex(stopPoints, alertStopId, currentPdist);
    if (alertIndex === null) {
      return {
        status: "alert_stop_not_in_vehicle_pattern",
        route: req.route,
        stop_id: req.stop_id,
        alert_stop_id: alertStopId,
        vehicle_id: vehicleId,
        pattern_id: patternId,
        prediction,
        vehicle,
        pattern_stop_count: stopPoints.length,
      };
    }

    const stopsBefore = {};
    for (let distance = 1; distance <= 4; distance++) {
      const idx = alertIndex - distance;
      if (idx >= 0) stopsBefore[String(distance)] = stopPoints[idx];
    }

    const alertStop = stopPoints[alertIndex];

    return {
      status: "watchable",
      route: req.route,
      stop_id: req.stop_id,
      alert_stop_id: alertStopId,
      vehicle_id: String(vehicleId),
      pattern_id: String(patternId),
      prediction,
      vehicle,
      current_pdist: currentPdist,
      stops_before: stopsBefore,
      four_stops_before: stopsBefore["4"] || null,
      three_stops_before: stopsBefore["3"] || null,
      two_stops_before: stopsBefore["2"] || null,
      one_stop_before: stopsBefore["1"] || null,
      alert_stop: alertStop,
      thresholds: {
        four_stop_before_pdist: stopsBefore["4"]?.pdist ?? null,
        three_stop_before_pdist: stopsBefore["3"]?.pdist ?? null,
        two_stop_before_pdist: stopsBefore["2"]?.pdist ?? null,
        one_stop_before_pdist: stopsBefore["1"]?.pdist ?? null,
        alert_stop_pdist: alertStop.pdist,
      },
    };
  }

  async pollTrackingSession(session) {
    const fired = new Set(session.fired_keys || []);
    const triggerDistance = clampInt(session.trigger_distance || 1, 1, 4);
    const lostCounts = session.lost_after_threshold_counts || {};
    const states = [];
    let kuroReady = false;
    let nextSession = { ...session, status: "tracking", last_poll_at: nowIso() };

    for (const item of session.watch_plans || []) {
      const state = await this.pollWatchPlan(item);
      states.push(state);

      const route = String(state.route || state.candidate?.route || item.candidate?.route || "?");
      const events = state.events || {};
      const plan = state.plan || item.plan || {};
      const targetName = plan.alert_stop?.name || state.candidate?.stop_name || item.candidate?.stop_name || "target stop";
      const stopsBefore = plan.stops_before || {};

      for (const distance of [4, 3, 2, 1]) {
        const eventName = checkpointEventName(distance);
        const key = `${route}:${eventName}`;
        if (!events[eventName] || fired.has(key)) continue;
        fired.add(key);
        const stopName = stopsBefore[String(distance)]?.name || `${distance} stop${distance === 1 ? "" : "s"} before ${targetName}`;
        const eventType = distance === triggerDistance ? "ken" : "checkpoint";
        nextSession = appendEvent(nextSession, eventType, `Route ${route} reached ${stopName} — ${distance} stop${distance === 1 ? "" : "s"} before ${targetName}.`, {
          route,
          distance,
          stop_name: stopName,
          target_stop: targetName,
        });
      }

      const kuroKey = `${route}:kuro_one_stop`;
      if (events.one_stops_before_reached && !events.one_stop_before_reached) {
        // Defensive typo bridge; should not happen.
        events.one_stop_before_reached = true;
      }
      if (events.one_stop_before_reached && !fired.has(kuroKey)) {
        fired.add(kuroKey);
        kuroReady = true;
        const stopName = stopsBefore["1"]?.name || "one stop before target";
        nextSession = appendEvent(nextSession, "kuro", `Route ${route} reached ${stopName} — final approach. Confirm Kuro.`, {
          route,
          distance: 1,
          stop_name: stopName,
          target_stop: targetName,
        });
      }

      const triggerEvent = checkpointEventName(triggerDistance);
      const thresholdAlreadyFired = fired.has(`${route}:${triggerEvent}`);
      const degraded = ["vehicle_unavailable", "vehicle_has_no_pdist", "poll_degraded", "poll_failed"].includes(state.status);
      if (thresholdAlreadyFired && degraded && !fired.has(kuroKey)) {
        lostCounts[route] = (lostCounts[route] || 0) + 1;
        if (lostCounts[route] >= 2) {
          fired.add(kuroKey);
          kuroReady = true;
          nextSession = appendEvent(nextSession, "kuro", `Route ${route}: signal dropped after Ken threshold. Confirm Kuro or catch the next bus.`, {
            route,
            distance: 1,
            target_stop: targetName,
          });
        }
      } else if (!degraded) {
        lostCounts[route] = 0;
      }
    }

    nextSession.watch_states = states;
    nextSession.fired_keys = Array.from(fired);
    nextSession.lost_after_threshold_counts = lostCounts;
    if (kuroReady) nextSession.status = "kuro_pending";
    return nextSession;
  }

  async pollWatchPlan(item) {
    const plan = item.plan || {};
    const candidate = item.candidate || {};
    if (plan.status !== "watchable") {
      return {
        route: candidate.route || plan.route,
        status: plan.status || "not_watchable",
        stopName: candidate.stop_name,
        prediction: plan.prediction || candidate.next_prediction,
        candidate,
        plan,
        events: emptyEvents(),
      };
    }

    const vehicle = await this.getVehicle(plan.vehicle_id);
    const predictions = await this.getPredictions(plan.route, plan.stop_id, 3);

    if (!vehicle) {
      return {
        route: plan.route,
        stop_id: plan.stop_id,
        alert_stop_id: plan.alert_stop_id,
        vehicle_id: plan.vehicle_id,
        status: "vehicle_unavailable",
        prediction: predictions[0] || null,
        candidate,
        plan,
        events: emptyEvents(),
      };
    }

    const currentPdist = safeFloat(vehicle.pdist);
    if (currentPdist === null) {
      return {
        route: plan.route,
        stop_id: plan.stop_id,
        alert_stop_id: plan.alert_stop_id,
        vehicle_id: plan.vehicle_id,
        status: "vehicle_has_no_pdist",
        vehicle,
        prediction: predictions[0] || null,
        candidate,
        plan,
        events: emptyEvents(),
      };
    }

    const t = plan.thresholds || {};
    const eventState = {
      four_stops_before_reached: t.four_stop_before_pdist !== null && t.four_stop_before_pdist !== undefined && currentPdist >= Number(t.four_stop_before_pdist),
      three_stops_before_reached: t.three_stop_before_pdist !== null && t.three_stop_before_pdist !== undefined && currentPdist >= Number(t.three_stop_before_pdist),
      two_stops_before_reached: t.two_stop_before_pdist !== null && t.two_stop_before_pdist !== undefined && currentPdist >= Number(t.two_stop_before_pdist),
      one_stop_before_reached: t.one_stop_before_pdist !== null && t.one_stop_before_pdist !== undefined && currentPdist >= Number(t.one_stop_before_pdist),
      arrived_at_alert_stop: t.alert_stop_pdist !== null && t.alert_stop_pdist !== undefined && currentPdist >= Number(t.alert_stop_pdist),
    };

    return {
      route: plan.route,
      stop_id: plan.stop_id,
      alert_stop_id: plan.alert_stop_id,
      vehicle_id: plan.vehicle_id,
      status: "tracking",
      vehicle,
      current_pdist: currentPdist,
      prediction: predictions[0] || null,
      candidate,
      plan,
      events: eventState,
    };
  }

  async bustimeGet(endpoint, params = {}) {
    if (!this.env.RIDERTS_API_KEY) throw new Error("RIDERTS_API_KEY secret is missing");
    const url = new URL(`${this.env.RIDERTS_BASE_URL || "https://riderts.app/bustime/api/v3"}/${endpoint}`);
    const fullParams = { ...params, key: this.env.RIDERTS_API_KEY, format: "json" };
    for (const [key, value] of Object.entries(fullParams)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }

    const response = await fetch(url.toString(), { cf: { cacheTtl: 0 } });
    if (!response.ok) throw new Error(`RideRTS ${endpoint} failed: HTTP ${response.status}`);
    const payload = await response.json();
    return payload["bustime-response"] || {};
  }

  async getPredictions(route, stopId, top = 3) {
    try {
      const root = await this.bustimeGet("getpredictions", { rt: route, stpid: stopId, top, tmres: "s" });
      if (root.error) return [];
      return asList(root.prd);
    } catch (_error) {
      return [];
    }
  }

  async getVehicle(vehicleId) {
    try {
      const root = await this.bustimeGet("getvehicles", { vid: vehicleId, tmres: "s" });
      if (root.error) return null;
      return asList(root.vehicle)[0] || null;
    } catch (_error) {
      return null;
    }
  }

  async getPattern(patternId) {
    try {
      const root = await this.bustimeGet("getpatterns", { pid: patternId });
      if (root.error) return null;
      return asList(root.ptr)[0] || null;
    } catch (_error) {
      return null;
    }
  }
}

function getSessionStub(env, sessionId) {
  const id = env.MEI_SESSION.idFromName(String(sessionId));
  return env.MEI_SESSION.get(id);
}

function asList(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function safeFloat(value) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function extractPatternStops(pattern) {
  return asList(pattern?.pt)
    .filter((point) => point?.typ === "S" && point?.stpid && safeFloat(point?.pdist) !== null)
    .map((point) => ({
      stop_id: String(point.stpid),
      name: point.stpnm,
      lat: safeFloat(point.lat),
      lon: safeFloat(point.lon),
      pdist: safeFloat(point.pdist),
      seq: point.seq,
    }));
}

function findBestTargetIndex(stopPoints, targetStopId, currentPdist) {
  const matches = [];
  for (let i = 0; i < stopPoints.length; i++) {
    if (String(stopPoints[i].stop_id) === String(targetStopId)) matches.push(i);
  }
  if (!matches.length) return null;
  if (currentPdist === null || currentPdist === undefined) return matches[0];
  const ahead = matches.find((i) => Number(stopPoints[i].pdist) >= Number(currentPdist));
  return ahead ?? matches[0];
}

function checkpointEventName(distance) {
  return {
    4: "four_stops_before_reached",
    3: "three_stops_before_reached",
    2: "two_stops_before_reached",
    1: "one_stop_before_reached",
  }[distance];
}

function emptyEvents() {
  return {
    four_stops_before_reached: false,
    three_stops_before_reached: false,
    two_stops_before_reached: false,
    one_stop_before_reached: false,
    arrived_at_alert_stop: false,
  };
}

function makeEvent(type, message, extra = {}) {
  return {
    id: crypto.randomUUID(),
    type,
    message,
    time: new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" }),
    at: nowIso(),
    ...extra,
  };
}

function appendEvent(session, type, message, extra = {}) {
  return {
    ...session,
    events: [makeEvent(type, message, extra), ...(session.events || [])].slice(0, 80),
  };
}

function appendEventLimited(session, type, message, maxExisting = 1) {
  const existing = (session.events || []).filter((event) => event.type === type).length;
  if (existing >= maxExisting) return session;
  return appendEvent(session, type, message);
}

function nowIso() {
  return new Date().toISOString();
}

function publicSession(session) {
  // Strip internal counters only when desired; keeping most fields helps local debugging.
  return session;
}

function clampInt(value, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function json(data, status = 200) {
  return corsResponse(JSON.stringify(data), status, { "content-type": "application/json" });
}

function corsResponse(body, status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: {
      ...headers,
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type,authorization",
    },
  });
}
