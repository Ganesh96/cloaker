import math
import os
import time
import threading
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import quote_plus

import requests
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

load_dotenv()

RIDERTS_API_KEY = os.getenv("RIDERTS_API_KEY")
RIDERTS_BASE_URL = "https://riderts.app/bustime/api/v3"

if not RIDERTS_API_KEY:
    raise RuntimeError("Missing RIDERTS_API_KEY. Add it to backend/.env")

app = FastAPI(title="Cloaker Backend", version="0.3.0")

allowed_origins = os.getenv(
    "CORS_ALLOW_ORIGINS",
    "http://localhost:5173,http://localhost:3000",
).split(",")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[origin.strip() for origin in allowed_origins],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class TTLCache:
    def __init__(self):
        self._data: Dict[str, Tuple[float, Any]] = {}

    def get(self, key: str) -> Optional[Any]:
        item = self._data.get(key)
        if not item:
            return None
        expires_at, value = item
        if time.time() > expires_at:
            self._data.pop(key, None)
            return None
        return value

    def set(self, key: str, value: Any, ttl_seconds: int) -> None:
        self._data[key] = (time.time() + ttl_seconds, value)


cache = TTLCache()


def as_list(value: Any) -> List[Any]:
    if value is None:
        return []
    return value if isinstance(value, list) else [value]


def cache_key(endpoint: str, params: Dict[str, Any]) -> str:
    clean = "&".join(f"{k}={params[k]}" for k in sorted(params.keys()))
    return f"{endpoint}?{clean}"


def bustime_get(endpoint: str, ttl_seconds: int = 0, **params: Any) -> Dict[str, Any]:
    request_params = {**params, "key": RIDERTS_API_KEY, "format": "json"}
    key = cache_key(endpoint, {k: v for k, v in request_params.items() if k != "key"})

    if ttl_seconds > 0:
        cached = cache.get(key)
        if cached is not None:
            return cached

    try:
        response = requests.get(
            f"{RIDERTS_BASE_URL}/{endpoint}",
            params=request_params,
            timeout=14,
        )
        response.raise_for_status()
    except requests.RequestException as exc:
        raise HTTPException(status_code=502, detail=f"RideRTS API request failed: {exc}")

    try:
        payload = response.json()
    except ValueError:
        raise HTTPException(status_code=502, detail="RideRTS API returned non-JSON response")

    root = payload.get("bustime-response", {})

    if ttl_seconds > 0:
        cache.set(key, root, ttl_seconds)

    return root


def geocode_get(q: str) -> List[Dict[str, Any]]:
    key = f"nominatim?q={q}"
    cached = cache.get(key)
    if cached is not None:
        return cached

    try:
        response = requests.get(
            "https://nominatim.openstreetmap.org/search",
            params={
                "q": q,
                "format": "jsonv2",
                "limit": 5,
                "addressdetails": 1,
            },
            headers={"User-Agent": "cloaker-local-dev/0.2"},
            timeout=12,
        )
        response.raise_for_status()
        data = response.json()
    except requests.RequestException as exc:
        raise HTTPException(status_code=502, detail=f"Geocoder failed: {exc}")
    except ValueError:
        raise HTTPException(status_code=502, detail="Geocoder returned non-JSON response")

    results = []
    for item in data:
        try:
            results.append(
                {
                    "label": item.get("display_name"),
                    "lat": float(item.get("lat")),
                    "lon": float(item.get("lon")),
                    "type": item.get("type"),
                    "class": item.get("class"),
                }
            )
        except (TypeError, ValueError):
            continue

    cache.set(key, results, 60 * 10)
    return results


def get_errors(root: Dict[str, Any]) -> List[Dict[str, Any]]:
    return as_list(root.get("error"))


def is_no_prediction_error(errors: List[Dict[str, Any]]) -> bool:
    text = " ".join(str(err) for err in errors).lower()
    return "no arrival times" in text or "no predictions" in text or "no service" in text


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    radius = 6_371_000
    p1 = math.radians(lat1)
    p2 = math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * radius * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def safe_float(value: Any) -> Optional[float]:
    try:
        if value is None:
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def normalize_route(raw: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "route": str(raw.get("rt")),
        "name": raw.get("rtnm"),
        "display": raw.get("rtdd") or raw.get("rt"),
        "color": raw.get("rtclr"),
    }


def normalize_direction(raw: Dict[str, Any]) -> Dict[str, Any]:
    return {"id": raw.get("id"), "name": raw.get("name")}


def normalize_stop(raw: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "stop_id": str(raw.get("stpid")),
        "name": raw.get("stpnm"),
        "lat": safe_float(raw.get("lat")),
        "lon": safe_float(raw.get("lon")),
    }


def get_routes_from_root(root: Dict[str, Any]) -> List[Dict[str, Any]]:
    return as_list(root.get("routes") or root.get("route"))


def get_all_routes() -> List[Dict[str, Any]]:
    root = bustime_get("getroutes", ttl_seconds=60 * 60)
    errors = get_errors(root)
    if errors:
        raise HTTPException(status_code=502, detail=errors)
    routes = [normalize_route(route) for route in get_routes_from_root(root) if route.get("rt")]
    routes.sort(key=lambda r: str(r.get("display") or r.get("route")))
    return routes


def get_directions_for_route(route: str) -> List[Dict[str, Any]]:
    root = bustime_get("getdirections", ttl_seconds=60 * 60 * 12, rt=route)
    if get_errors(root):
        return []
    raw = as_list(root.get("directions") or root.get("dir"))
    return [normalize_direction(d) for d in raw if d.get("id")]


def get_stops_for_route_direction(route: str, direction_id: str) -> List[Dict[str, Any]]:
    root = bustime_get("getstops", ttl_seconds=60 * 60 * 12, rt=route, dir=direction_id)
    if get_errors(root):
        return []
    raw = as_list(root.get("stops") or root.get("stop"))
    stops = []
    for stop in raw:
        normalized = normalize_stop(stop)
        if normalized["stop_id"] and normalized["lat"] is not None and normalized["lon"] is not None:
            stops.append(normalized)
    return stops


def get_predictions_for_stop(route: str, stop_id: str, top: int = 3) -> List[Dict[str, Any]]:
    root = bustime_get("getpredictions", ttl_seconds=8, rt=route, stpid=stop_id, top=top, tmres="s")
    errors = get_errors(root)
    if errors:
        if is_no_prediction_error(errors):
            return []
        return []
    return as_list(root.get("prd"))


def get_vehicle(vehicle_id: str) -> Optional[Dict[str, Any]]:
    root = bustime_get("getvehicles", ttl_seconds=5, vid=vehicle_id, tmres="s")
    if get_errors(root):
        return None
    vehicles = as_list(root.get("vehicle"))
    return vehicles[0] if vehicles else None


def get_pattern(pattern_id: str) -> Optional[Dict[str, Any]]:
    root = bustime_get("getpatterns", ttl_seconds=60 * 60, pid=pattern_id)
    if get_errors(root):
        return None
    patterns = as_list(root.get("ptr"))
    return patterns[0] if patterns else None


def extract_pattern_stops(pattern: Dict[str, Any]) -> List[Dict[str, Any]]:
    points = as_list(pattern.get("pt"))
    stops = []
    for point in points:
        if point.get("typ") != "S" or not point.get("stpid"):
            continue
        pdist = safe_float(point.get("pdist"))
        if pdist is None:
            continue
        stops.append(
            {
                "stop_id": str(point.get("stpid")),
                "name": point.get("stpnm"),
                "lat": safe_float(point.get("lat")),
                "lon": safe_float(point.get("lon")),
                "pdist": pdist,
                "seq": point.get("seq"),
            }
        )
    return stops


def find_best_target_index(stop_points: List[Dict[str, Any]], target_stop_id: str, current_pdist: Optional[float]) -> Optional[int]:
    matching = [i for i, stop in enumerate(stop_points) if str(stop["stop_id"]) == str(target_stop_id)]
    if not matching:
        return None
    if current_pdist is None:
        return matching[0]
    ahead = [i for i in matching if stop_points[i]["pdist"] >= current_pdist]
    return ahead[0] if ahead else matching[0]


def group_candidates(candidates: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    grouped: Dict[str, Dict[str, Any]] = {}
    for c in candidates:
        key = c.get("stop_name") or c.get("name") or c.get("stop_id")
        if key not in grouped:
            grouped[key] = {
                "label": key,
                "min_distance_m": c.get("distance_m", 999999),
                "routes_served": set(),
                "candidates": [],
                "live_count": 0,
            }
        grouped[key]["min_distance_m"] = min(grouped[key]["min_distance_m"], c.get("distance_m", 999999))
        grouped[key]["routes_served"].add(c["route"])
        grouped[key]["candidates"].append(c)
        if c.get("has_live_prediction"):
            grouped[key]["live_count"] += 1

    groups = []
    for group in grouped.values():
        groups.append(
            {
                "label": group["label"],
                "min_distance_m": group["min_distance_m"],
                "routes_served": sorted(group["routes_served"]),
                "route_count": len(group["routes_served"]),
                "live_count": group["live_count"],
                "candidates": group["candidates"],
            }
        )
    groups.sort(key=lambda g: (-g["route_count"], -g["live_count"], g["min_distance_m"]))
    return groups


class ResolveStartRequest(BaseModel):
    routes: List[str] = Field(..., min_length=1)
    lat: float
    lon: float
    radius_m: int = 700
    max_candidates_per_route: int = 6


class EnScanRequest(BaseModel):
    lat: float
    lon: float
    radius_m: int = 800
    max_routes: int = 40


class SelectedRouteStopsRequest(BaseModel):
    routes: List[str] = Field(..., min_length=1)
    include_predictions: bool = False


class WatchPlanRequest(BaseModel):
    route: str
    stop_id: str
    alert_stop_id: Optional[str] = None
    destination_stop_id: Optional[str] = None


class WatchStateRequest(BaseModel):
    route: str
    stop_id: str
    vehicle_id: str
    # Some BusTime responses serialize pattern_id as a number. Accept either.
    pattern_id: Optional[Any] = None
    alert_stop_id: str
    four_stop_before_pdist: Optional[float] = None
    three_stop_before_pdist: Optional[float] = None
    two_stop_before_pdist: Optional[float] = None
    one_stop_before_pdist: Optional[float] = None
    alert_stop_pdist: Optional[float] = None


@app.get("/health")
def health():
    return {"ok": True, "service": "cloaker-backend"}


@app.get("/api/routes")
def routes():
    return {"routes": get_all_routes()}


@app.get("/api/routes/{route}/directions")
def route_directions(route: str):
    return {"route": route, "directions": get_directions_for_route(route)}


@app.get("/api/routes/{route}/directions/{direction_id}/stops")
def route_direction_stops(route: str, direction_id: str):
    return {"route": route, "direction_id": direction_id, "stops": get_stops_for_route_direction(route, direction_id)}


@app.get("/api/geocode")
def geocode(q: str = Query(..., min_length=2)):
    return {"query": q, "results": geocode_get(q)}


@app.get("/api/search-stops")
def search_stops(
    query: str = Query(..., min_length=1),
    routes: Optional[str] = Query(default=None, description="Comma-separated route IDs, example: 38,1"),
    limit: int = Query(default=30, ge=1, le=150),
):
    query_lower = query.lower().strip()

    if routes:
        route_list = [r.strip() for r in routes.split(",") if r.strip()]
    else:
        route_list = [r["route"] for r in get_all_routes() if r.get("route")]

    seen = set()
    matches = []

    for route in route_list:
        for direction in get_directions_for_route(route):
            direction_id = direction["id"]
            for stop in get_stops_for_route_direction(route, direction_id):
                name = stop.get("name") or ""
                if query_lower not in name.lower() and query_lower not in stop["stop_id"].lower():
                    continue
                key = (stop["stop_id"], route, direction_id)
                if key in seen:
                    continue
                seen.add(key)
                preds = get_predictions_for_stop(route, stop["stop_id"], top=3)
                matches.append(
                    {
                        "route": route,
                        "direction_id": direction_id,
                        "direction_name": direction.get("name"),
                        "stop_id": stop["stop_id"],
                        "stop_name": stop["name"],
                        "lat": stop["lat"],
                        "lon": stop["lon"],
                        "distance_m": 0,
                        "has_live_prediction": len(preds) > 0,
                        "next_prediction": preds[0] if preds else None,
                        "predictions": preds,
                    }
                )
                if len(matches) >= limit:
                    return {"query": query, "routes": route_list, "stops": matches, "best_groups": group_candidates(matches)}

    return {"query": query, "routes": route_list, "stops": matches, "best_groups": group_candidates(matches)}


@app.post("/api/en-scan")
def en_scan(req: EnScanRequest):
    route_list = get_all_routes()
    nearby_by_route: Dict[str, Dict[str, Any]] = {}

    for route_obj in route_list:
        route = str(route_obj["route"])
        for direction in get_directions_for_route(route):
            direction_id = direction.get("id")
            if not direction_id:
                continue
            for stop in get_stops_for_route_direction(route, direction_id):
                if stop["lat"] is None or stop["lon"] is None:
                    continue
                dist = haversine_m(req.lat, req.lon, stop["lat"], stop["lon"])
                if dist > req.radius_m:
                    continue
                candidate = {
                    "route": route,
                    "display": route_obj.get("display") or route,
                    "name": route_obj.get("name"),
                    "direction_id": direction_id,
                    "direction_name": direction.get("name"),
                    "stop_id": stop["stop_id"],
                    "stop_name": stop["name"],
                    "lat": stop["lat"],
                    "lon": stop["lon"],
                    "distance_m": round(dist, 1),
                }
                existing = nearby_by_route.get(route)
                if existing is None or candidate["distance_m"] < existing["nearest_stop"]["distance_m"]:
                    nearby_by_route[route] = {
                        "route": route,
                        "display": route_obj.get("display") or route,
                        "name": route_obj.get("name"),
                        "nearest_stop": candidate,
                    }

    nearby_routes = list(nearby_by_route.values())
    nearby_routes.sort(key=lambda r: r["nearest_stop"]["distance_m"])
    return {"lat": req.lat, "lon": req.lon, "radius_m": req.radius_m, "nearby_routes": nearby_routes[: req.max_routes], "nearby_count": len(nearby_routes)}


@app.post("/api/resolve-start")
def resolve_start(req: ResolveStartRequest):
    all_candidates = []
    for route in req.routes:
        route_candidates = []
        for direction in get_directions_for_route(route):
            direction_id = direction["id"]
            for stop in get_stops_for_route_direction(route, direction_id):
                dist = haversine_m(req.lat, req.lon, stop["lat"], stop["lon"])
                if dist > req.radius_m:
                    continue
                route_candidates.append(
                    {
                        "route": route,
                        "direction_id": direction_id,
                        "direction_name": direction.get("name"),
                        "stop_id": stop["stop_id"],
                        "stop_name": stop["name"],
                        "lat": stop["lat"],
                        "lon": stop["lon"],
                        "distance_m": round(dist, 1),
                    }
                )
        route_candidates.sort(key=lambda x: x["distance_m"])
        for candidate in route_candidates[: req.max_candidates_per_route]:
            preds = get_predictions_for_stop(candidate["route"], candidate["stop_id"], top=3)
            candidate["has_live_prediction"] = len(preds) > 0
            candidate["next_prediction"] = preds[0] if preds else None
            candidate["predictions"] = preds
            all_candidates.append(candidate)

    all_candidates.sort(key=lambda c: (not c["has_live_prediction"], c["distance_m"]))
    return {
        "input": {"routes": req.routes, "lat": req.lat, "lon": req.lon, "radius_m": req.radius_m},
        "best_groups": group_candidates(all_candidates)[:12],
        "candidates": all_candidates[:60],
    }


@app.post("/api/selected-route-stops")
def selected_route_stops(req: SelectedRouteStopsRequest):
    all_candidates = []
    seen = set()
    for route in req.routes:
        for direction in get_directions_for_route(route):
            direction_id = direction["id"]
            for stop in get_stops_for_route_direction(route, direction_id):
                key = (route, direction_id, stop["stop_id"])
                if key in seen:
                    continue
                seen.add(key)
                preds = get_predictions_for_stop(route, stop["stop_id"], top=3) if req.include_predictions else []
                all_candidates.append(
                    {
                        "route": route,
                        "direction_id": direction_id,
                        "direction_name": direction.get("name"),
                        "stop_id": stop["stop_id"],
                        "stop_name": stop["name"],
                        "lat": stop["lat"],
                        "lon": stop["lon"],
                        "distance_m": 0,
                        "has_live_prediction": len(preds) > 0,
                        "next_prediction": preds[0] if preds else None,
                        "predictions": preds,
                    }
                )

    groups = group_candidates(all_candidates)
    return {"input_routes": req.routes, "best_groups": groups, "candidates": all_candidates}


@app.get("/api/predictions")
def predictions(route: str, stop_id: str, top: int = Query(default=3, ge=1, le=10)):
    return {"route": route, "stop_id": stop_id, "predictions": get_predictions_for_stop(route, stop_id, top)}


@app.post("/api/watch-plan")
def watch_plan(req: WatchPlanRequest):
    alert_stop_id = req.alert_stop_id or req.stop_id
    predictions = get_predictions_for_stop(route=req.route, stop_id=req.stop_id, top=3)

    if not predictions:
        return {"status": "no_live_prediction", "route": req.route, "stop_id": req.stop_id, "alert_stop_id": alert_stop_id, "message": "No live prediction found for this route/stop."}

    chosen_prediction = predictions[0]
    vehicle_id = chosen_prediction.get("vid")
    if not vehicle_id:
        return {"status": "prediction_only", "route": req.route, "stop_id": req.stop_id, "alert_stop_id": alert_stop_id, "prediction": chosen_prediction}

    vehicle = get_vehicle(vehicle_id)
    if not vehicle:
        return {"status": "vehicle_missing", "route": req.route, "stop_id": req.stop_id, "alert_stop_id": alert_stop_id, "vehicle_id": vehicle_id, "prediction": chosen_prediction}

    pattern_id = vehicle.get("pid")
    if not pattern_id:
        return {"status": "pattern_missing", "route": req.route, "stop_id": req.stop_id, "alert_stop_id": alert_stop_id, "vehicle_id": vehicle_id, "prediction": chosen_prediction, "vehicle": vehicle}

    pattern = get_pattern(pattern_id)
    if not pattern:
        return {"status": "pattern_not_found", "route": req.route, "stop_id": req.stop_id, "alert_stop_id": alert_stop_id, "vehicle_id": vehicle_id, "pattern_id": pattern_id, "prediction": chosen_prediction, "vehicle": vehicle}

    stop_points = extract_pattern_stops(pattern)
    current_pdist = safe_float(vehicle.get("pdist"))
    alert_index = find_best_target_index(stop_points, alert_stop_id, current_pdist)

    if alert_index is None:
        return {"status": "alert_stop_not_in_vehicle_pattern", "route": req.route, "stop_id": req.stop_id, "alert_stop_id": alert_stop_id, "vehicle_id": vehicle_id, "pattern_id": pattern_id, "prediction": chosen_prediction, "vehicle": vehicle, "pattern_stop_count": len(stop_points)}

    destination = None
    if req.destination_stop_id:
        destination_index = find_best_target_index(stop_points, req.destination_stop_id, current_pdist)
        if destination_index is not None:
            destination = stop_points[destination_index]

    stops_before: Dict[int, Optional[Dict[str, Any]]] = {}
    for distance in range(1, 5):
        idx = alert_index - distance
        stops_before[distance] = stop_points[idx] if idx >= 0 else None

    alert_stop = stop_points[alert_index]

    return {
        "status": "watchable",
        "route": req.route,
        "stop_id": req.stop_id,
        "alert_stop_id": alert_stop_id,
        "destination_stop_id": req.destination_stop_id,
        "vehicle_id": vehicle_id,
        "pattern_id": pattern_id,
        "prediction": chosen_prediction,
        "vehicle": vehicle,
        "current_pdist": current_pdist,
        "four_stops_before": stops_before[4],
        "three_stops_before": stops_before[3],
        "two_stops_before": stops_before[2],
        "one_stop_before": stops_before[1],
        "stops_before": {str(k): v for k, v in stops_before.items() if v is not None},
        "alert_stop": alert_stop,
        "destination_stop": destination,
        "thresholds": {
            "four_stop_before_pdist": stops_before[4]["pdist"] if stops_before[4] else None,
            "three_stop_before_pdist": stops_before[3]["pdist"] if stops_before[3] else None,
            "two_stop_before_pdist": stops_before[2]["pdist"] if stops_before[2] else None,
            "one_stop_before_pdist": stops_before[1]["pdist"] if stops_before[1] else None,
            "alert_stop_pdist": alert_stop["pdist"],
        },
    }


@app.post("/api/watch-state")
def watch_state(req: WatchStateRequest):
    """
    Poll-safe watch state.

    Emits explicit threshold events for 4, 3, 2, and 1 stops before the target.
    Kuro is intentionally keyed to the 1-stop-before threshold for this product
    flow, because that is the user's final confirmation handoff point.
    """

    empty_events = {
        "four_stops_before_reached": False,
        "three_stops_before_reached": False,
        "two_stops_before_reached": False,
        "one_stop_before_reached": False,
        "arrived_at_alert_stop": False,
    }

    try:
        vehicle = get_vehicle(req.vehicle_id)
    except HTTPException as exc:
        predictions = get_predictions_for_stop(route=req.route, stop_id=req.stop_id, top=3)
        return {
            "status": "poll_degraded",
            "route": req.route,
            "stop_id": req.stop_id,
            "vehicle_id": req.vehicle_id,
            "error": exc.detail,
            "fallback_predictions": predictions,
            "prediction": predictions[0] if predictions else None,
            "events": empty_events,
        }

    if not vehicle:
        predictions = get_predictions_for_stop(route=req.route, stop_id=req.stop_id, top=3)
        return {
            "status": "vehicle_unavailable",
            "route": req.route,
            "stop_id": req.stop_id,
            "vehicle_id": req.vehicle_id,
            "fallback_predictions": predictions,
            "prediction": predictions[0] if predictions else None,
            "events": empty_events,
        }

    current_pdist = safe_float(vehicle.get("pdist"))
    if current_pdist is None:
        predictions = get_predictions_for_stop(route=req.route, stop_id=req.stop_id, top=3)
        return {
            "status": "vehicle_has_no_pdist",
            "route": req.route,
            "stop_id": req.stop_id,
            "vehicle_id": req.vehicle_id,
            "vehicle": vehicle,
            "fallback_predictions": predictions,
            "prediction": predictions[0] if predictions else None,
            "events": empty_events,
        }

    four_reached = req.four_stop_before_pdist is not None and current_pdist >= req.four_stop_before_pdist
    three_reached = req.three_stop_before_pdist is not None and current_pdist >= req.three_stop_before_pdist
    two_reached = req.two_stop_before_pdist is not None and current_pdist >= req.two_stop_before_pdist
    one_reached = req.one_stop_before_pdist is not None and current_pdist >= req.one_stop_before_pdist
    arrived = req.alert_stop_pdist is not None and current_pdist >= req.alert_stop_pdist

    try:
        predictions = get_predictions_for_stop(route=req.route, stop_id=req.stop_id, top=3)
    except HTTPException:
        predictions = []

    return {
        "status": "tracking",
        "route": req.route,
        "stop_id": req.stop_id,
        "alert_stop_id": req.alert_stop_id,
        "vehicle_id": req.vehicle_id,
        "vehicle": vehicle,
        "current_pdist": current_pdist,
        "prediction": predictions[0] if predictions else None,
        "events": {
            "four_stops_before_reached": four_reached,
            "three_stops_before_reached": three_reached,
            "two_stops_before_reached": two_reached,
            "one_stop_before_reached": one_reached,
            "arrived_at_alert_stop": arrived,
        },
    }


# -----------------------------------------------------------------------------
# Backend-owned Mei sessions
# -----------------------------------------------------------------------------
# Local dev implementation: in-memory worker sessions. This makes Mei autonomous
# as long as the backend process is running. Production should move this state to
# Durable Objects / Redis / Postgres + a scheduled worker.

MEI_SESSIONS: Dict[str, Dict[str, Any]] = {}
MEI_LOCK = threading.Lock()


class MeiStartRequest(BaseModel):
    candidates: List[Dict[str, Any]] = Field(..., min_length=1)
    trigger_distance: int = Field(default=1, ge=1, le=4)
    start_at: Optional[str] = None
    poll_seconds: int = Field(default=8, ge=5, le=60)


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _parse_start_at(value: Optional[str]) -> Optional[float]:
    if not value:
        return None
    try:
        cleaned = value.replace("Z", "+00:00")
        dt = datetime.fromisoformat(cleaned)
        if dt.tzinfo is None:
            dt = dt.astimezone()
        return dt.timestamp()
    except Exception:
        return None


def _safe_event_payload(message: str, type_: str = "mei", **metadata: Any) -> Dict[str, Any]:
    payload = {
        "id": f"{type_}:{uuid.uuid4().hex}",
        "type": type_,
        "message": message,
        "time": _utc_now_iso(),
    }
    payload.update(metadata)
    return payload


def _set_session(session_id: str, **updates: Any) -> Dict[str, Any]:
    with MEI_LOCK:
        session = MEI_SESSIONS.get(session_id)
        if not session:
            return {}
        session.update(updates)
        return dict(session)


def _get_session(session_id: str) -> Optional[Dict[str, Any]]:
    with MEI_LOCK:
        session = MEI_SESSIONS.get(session_id)
        return dict(session) if session else None


def _append_session_event(session_id: str, message: str, type_: str = "mei", **metadata: Any) -> None:
    with MEI_LOCK:
        session = MEI_SESSIONS.get(session_id)
        if not session:
            return
        session.setdefault("events", [])
        session["events"].insert(0, _safe_event_payload(message, type_, **metadata))
        session["events"] = session["events"][:80]


def _build_watch_plans_for_candidates(candidates: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    plans: List[Dict[str, Any]] = []
    for candidate in candidates:
        route = str(candidate.get("route", "")).strip()
        stop_id = str(candidate.get("stop_id", "")).strip()
        if not route or not stop_id:
            plans.append({
                "candidate": candidate,
                "plan": {"status": "invalid_candidate", "message": "Missing route or stop_id."},
            })
            continue
        try:
            plan = watch_plan(WatchPlanRequest(route=route, stop_id=stop_id, alert_stop_id=stop_id))
        except Exception as exc:
            plan = {"status": "watch_plan_failed", "message": str(exc)}
        plans.append({"candidate": candidate, "plan": plan})
    return plans


def _poll_watch_plan(item: Dict[str, Any]) -> Dict[str, Any]:
    candidate = item.get("candidate", {})
    plan = item.get("plan", {})

    if plan.get("status") != "watchable":
        return {
            "candidate": candidate,
            "plan": plan,
            "route": candidate.get("route") or plan.get("route"),
            "status": plan.get("status", "not_watchable"),
            "prediction": plan.get("prediction") or candidate.get("next_prediction"),
            "events": {
                "four_stops_before_reached": False,
                "three_stops_before_reached": False,
                "two_stops_before_reached": False,
                "one_stop_before_reached": False,
                "arrived_at_alert_stop": False,
            },
        }

    thresholds = plan.get("thresholds") or {}
    state_req = WatchStateRequest(
        route=str(plan.get("route")),
        stop_id=str(plan.get("stop_id")),
        vehicle_id=str(plan.get("vehicle_id")),
        pattern_id=plan.get("pattern_id"),
        alert_stop_id=str(plan.get("alert_stop_id")),
        four_stop_before_pdist=thresholds.get("four_stop_before_pdist"),
        three_stop_before_pdist=thresholds.get("three_stop_before_pdist"),
        two_stop_before_pdist=thresholds.get("two_stop_before_pdist"),
        one_stop_before_pdist=thresholds.get("one_stop_before_pdist"),
        alert_stop_pdist=thresholds.get("alert_stop_pdist"),
    )

    try:
        state = watch_state(state_req)
    except Exception as exc:
        state = {
            "status": "poll_failed",
            "route": candidate.get("route") or plan.get("route"),
            "error": str(exc),
            "events": {
                "four_stops_before_reached": False,
                "three_stops_before_reached": False,
                "two_stops_before_reached": False,
                "one_stop_before_reached": False,
                "arrived_at_alert_stop": False,
            },
        }

    return {**state, "candidate": candidate, "plan": plan}


def _mei_worker(session_id: str) -> None:
    session = _get_session(session_id)
    if not session:
        return

    start_ts = _parse_start_at(session.get("start_at"))
    if start_ts and start_ts > time.time():
        _set_session(session_id, status="scheduled")
        while time.time() < start_ts:
            current = _get_session(session_id)
            if not current or current.get("cancelled"):
                return
            time.sleep(min(5, max(0.5, start_ts - time.time())))

    _set_session(session_id, status="planning", started_at=_utc_now_iso())
    _append_session_event(session_id, "Mei worker started on backend.", "mei")

    # Re-plan until at least one route becomes watchable. This is what catches
    # the first live bus after a scheduled start time.
    while True:
        current = _get_session(session_id)
        if not current or current.get("cancelled"):
            return

        plans = _build_watch_plans_for_candidates(current.get("candidates", []))
        watchable_count = sum(1 for item in plans if item.get("plan", {}).get("status") == "watchable")
        _set_session(session_id, watch_plans=plans, watchable_count=watchable_count, status="tracking" if watchable_count else "waiting_for_live_bus")

        if watchable_count:
            _append_session_event(session_id, f"Mei acquired {watchable_count} watchable route signal(s).", "mei")
            break

        time.sleep(30)

    trigger_distance = int((_get_session(session_id) or {}).get("trigger_distance", 1))
    trigger_distance = max(1, min(4, trigger_distance))
    trigger_event = {
        4: "four_stops_before_reached",
        3: "three_stops_before_reached",
        2: "two_stops_before_reached",
        1: "one_stop_before_reached",
    }[trigger_distance]

    checkpoint_events = [
        (4, "four_stops_before_reached"),
        (3, "three_stops_before_reached"),
        (2, "two_stops_before_reached"),
        (1, "one_stop_before_reached"),
    ]

    fired_keys = set()
    lost_after_threshold_counts: Dict[str, int] = {}
    poll_seconds = int((_get_session(session_id) or {}).get("poll_seconds", 8))

    while True:
        current = _get_session(session_id)
        if not current or current.get("cancelled"):
            return
        if current.get("status") == "kuro_pending":
            time.sleep(poll_seconds)
            continue

        states = []
        kuro_ready = False
        for item in current.get("watch_plans", []):
            state = _poll_watch_plan(item)
            states.append(state)
            route = str(state.get("route") or state.get("candidate", {}).get("route") or "?")
            events = state.get("events") or {}
            plan = state.get("plan") or item.get("plan") or {}
            target_name = (plan.get("alert_stop") or {}).get("name") or state.get("candidate", {}).get("stop_name") or "target stop"
            stops_before = plan.get("stops_before") or {}

            # Log every crossed checkpoint in route order: 4 -> 3 -> 2 -> 1.
            for distance, event_name in checkpoint_events:
                checkpoint_key = f"{route}:{event_name}"
                if not events.get(event_name) or checkpoint_key in fired_keys:
                    continue
                fired_keys.add(checkpoint_key)
                stop_obj = stops_before.get(str(distance)) or {}
                stop_name = stop_obj.get("name") or f"{distance} stop{'s' if distance != 1 else ''} before {target_name}"
                event_type = "ken" if distance == trigger_distance else "checkpoint"
                _append_session_event(
                    session_id,
                    f"Route {route} reached {stop_name} — {distance} stop{'s' if distance != 1 else ''} before {target_name}.",
                    event_type,
                    route=route,
                    distance=distance,
                    stop_name=stop_name,
                    target_stop=target_name,
                )

            # Kuro begins at 1 stop before the target. This is the final handoff.
            kuro_key = f"{route}:kuro_one_stop"
            if events.get("one_stop_before_reached") and kuro_key not in fired_keys:
                fired_keys.add(kuro_key)
                kuro_ready = True
                one_stop = (stops_before.get("1") or {}).get("name") or "one stop before target"
                _append_session_event(
                    session_id,
                    f"Route {route} reached {one_stop} — final approach. Confirm Kuro.",
                    "kuro",
                    route=route,
                    distance=1,
                    stop_name=one_stop,
                    target_stop=target_name,
                )

            # Practical fallback: if the selected Ken threshold fired and the vehicle
            # signal disappears for two consecutive polls, transition to Kuro so the
            # user can confirm or ask for the next bus.
            threshold_already_fired = f"{route}:{trigger_event}" in fired_keys
            degraded_after_threshold = state.get("status") in {
                "vehicle_unavailable",
                "vehicle_has_no_pdist",
                "poll_degraded",
                "poll_failed",
            }

            if threshold_already_fired and degraded_after_threshold and kuro_key not in fired_keys:
                lost_after_threshold_counts[route] = lost_after_threshold_counts.get(route, 0) + 1
                if lost_after_threshold_counts[route] >= 2:
                    fired_keys.add(kuro_key)
                    kuro_ready = True
                    _append_session_event(
                        session_id,
                        f"Route {route}: signal dropped after Ken threshold. Confirm Kuro or catch the next bus.",
                        "kuro",
                        route=route,
                        distance=1,
                        target_stop=target_name,
                    )
            elif not degraded_after_threshold:
                lost_after_threshold_counts[route] = 0

        _set_session(session_id, watch_states=states, last_poll_at=_utc_now_iso())

        if kuro_ready:
            _set_session(session_id, status="kuro_pending")

        time.sleep(poll_seconds)



@app.post("/api/mei/start")
def mei_start(req: MeiStartRequest):
    session_id = uuid.uuid4().hex
    session = {
        "session_id": session_id,
        "status": "scheduled" if req.start_at else "queued",
        "created_at": _utc_now_iso(),
        "start_at": req.start_at,
        "trigger_distance": req.trigger_distance,
        "poll_seconds": req.poll_seconds,
        "candidates": req.candidates,
        "watch_plans": [],
        "watch_states": [],
        "events": [_safe_event_payload("Mei worker request accepted. Backend will watch this session.", "mei")],
        "watchable_count": 0,
        "cancelled": False,
    }

    with MEI_LOCK:
        MEI_SESSIONS[session_id] = session

    thread = threading.Thread(target=_mei_worker, args=(session_id,), daemon=True)
    thread.start()

    return session


@app.get("/api/mei/{session_id}")
def mei_state(session_id: str):
    session = _get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Mei session not found")
    return session


@app.post("/api/mei/{session_id}/boarded")
def mei_boarded(session_id: str):
    session = _get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Mei session not found")
    _set_session(session_id, status="boarded", cancelled=True)
    _append_session_event(session_id, "Boarded confirmed. Session closed.", "kuro")
    return _get_session(session_id)


@app.post("/api/mei/{session_id}/next")
def mei_next(session_id: str):
    session = _get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Mei session not found")

    # Cancel old worker and create a fresh session using the same candidates / trigger.
    _set_session(session_id, cancelled=True, status="replaced")
    req = MeiStartRequest(
        candidates=session.get("candidates", []),
        trigger_distance=int(session.get("trigger_distance", 1)),
        start_at=None,
        poll_seconds=int(session.get("poll_seconds", 8)),
    )
    return mei_start(req)
