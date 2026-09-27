import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Feature, FeatureCollection, LineString, Point } from "geojson";
import { api } from "../api";
import { CampusMap } from "../map/CampusMap";
import { FloorViewer } from "../editor/FloorViewer";
import type { FloorLayout } from "../editor/types";
import type {
  CampusMapData,
  Coordinate,
  RouteEndpoint,
  RouteResponse,
  TravelProfile,
} from "../types";
import "./public-map.css";

type PublicMode = "view" | "routing" | "send-note";
type EndpointKind = "start" | "destination";
type SearchResult = {
  kind: string;
  id: string;
  name: string;
  longitude?: number;
  latitude?: number;
  buildingId?: string;
};
type Choice = {
  label: string;
  endpoint: RouteEndpoint;
  buildingId?: string;
  coordinate?: Coordinate;
};
type PublicPath = {
  id: string;
  name?: string;
  kind: "main" | "shortcut";
  blocked: boolean;
  note?: string | null;
  source?: "osm" | "editor";
};
type MapData = CampusMapData & {
  paths?: FeatureCollection<LineString, PublicPath>;
  points: FeatureCollection<
    Point,
    { id: string; name?: string; note?: string }
  >;
  alerts: Array<{ id: string; coordinates: Coordinate; description: string }>;
};
type SavedFloorSummary = { id: string; floor_number: number; version?: number };
type SavedFloorDetails = {
  id?: string;
  building_id?: string;
  floor_number?: number;
  boundary: { coordinates?: number[][][] } | number[][][];
  local_width?: number;
  localWidth?: number;
  local_height?: number;
  localHeight?: number;
  map_transform?: FloorLayout["transform"];
  mapTransform?: FloorLayout["transform"];
  version?: number;
  features: Array<{
    id: string;
    kind: "room" | "door" | "point" | "stairs" | "lift";
    name: string;
    geometry: Record<string, unknown>;
    connector_id?: string;
    served_floors?: number[];
    is_exit?: boolean;
    outdoor_position?: Coordinate;
    linked_graph_node_id?: string;
  }>;
};

const profileLabels: Record<TravelProfile, string> = {
  healthy: "Healthy",
  wheelchair: "Wheelchair",
  heavy_luggage: "Heavy luggage",
};
const noRouteMessages: Record<string, string> = {
  NO_WALKABLE_GRAPH: "No mapped walking paths are available in this area yet.",
  NO_VERIFIED_PATHS: "No mapped walking paths are available in this area yet.",
  START_UNREACHABLE:
    "No mapped walking path can be reached from this start. Try another point.",
  DEST_UNREACHABLE:
    "No mapped walking path reaches this destination. Try another point.",
  NO_PLAUSIBLE_APPROACH:
    "No nearby mapped walking path reaches an approach to this building.",
  DIFFERENT_COMPONENTS:
    "The mapped walking paths do not connect these locations yet.",
  BLOCKED_OR_INELIGIBLE: "No available route for this profile right now.",
  NO_SUITABLE_WHEELCHAIR_ROUTE:
    "No suitable wheelchair route was found with current map data. Another path may need mapping or accessibility checks.",
};
const maximumNoteLength = 500;

export function routePresentation(response: unknown) {
  const value = response as {
    segments?: Array<{
      geometry?: LineString;
      coordinates?: Coordinate[];
      source?: string;
      sourceId?: string;
      pathId?: string;
      kind?: "main" | "shortcut";
      note?: string | null;
    }>;
    approaches?: Array<{ boundary?: Coordinate; role?: string }>;
  };
  const segments: FeatureCollection<
    LineString,
    {
      source?: string;
      sourceId?: string;
      pathId?: string;
      kind?: "main" | "shortcut";
      note?: string | null;
    }
  > = {
    type: "FeatureCollection",
    features: (value.segments ?? []).flatMap((segment) => {
      const geometry =
        segment.geometry ??
        (segment.coordinates
          ? { type: "LineString" as const, coordinates: segment.coordinates }
          : undefined);
      return geometry
        ? [
            {
              type: "Feature" as const,
              properties: {
                source: segment.source,
                sourceId: segment.sourceId,
                pathId: segment.pathId,
                kind: segment.kind,
                note: segment.note,
              },
              geometry,
            },
          ]
        : [];
    }),
  };
  const approaches: FeatureCollection<Point, { role?: string }> = {
    type: "FeatureCollection",
    features: (value.approaches ?? []).flatMap((item) =>
      item.boundary
        ? [
            {
              type: "Feature" as const,
              properties: { role: item.role },
              geometry: { type: "Point" as const, coordinates: item.boundary },
            },
          ]
        : [],
    ),
  };
  return { segments, approaches };
}

export function visitorReason(code: string) {
  return (
    noRouteMessages[code] ??
    (code || "No available route for these locations right now.")
  );
}

export function PublicMap() {
  const [mapData, setMapData] = useState<MapData>();
  const [mapError, setMapError] = useState("");
  const [mode, setMode] = useState<PublicMode>("view");
  const [selectedPathId, setSelectedPathId] = useState("");
  const [selectedPointId, setSelectedPointId] = useState("");
  const [selectedAlertId, setSelectedAlertId] = useState("");
  const [selectedBuildingId, setSelectedBuildingId] = useState("");
  const [buildingFloor, setBuildingFloor] = useState(0);
  const [showFloorViewer, setShowFloorViewer] = useState(false);
  const [buildingFloors, setBuildingFloors] = useState<SavedFloorSummary[]>([]);
  const [floorViewerState, setFloorViewerState] = useState<
    "loading" | "unavailable" | "error" | "ready"
  >("unavailable");
  const [floorViewerLayout, setFloorViewerLayout] = useState<FloorLayout>();
  const [floorViewerError, setFloorViewerError] = useState("");
  const [start, setStart] = useState<Choice>();
  const [destination, setDestination] = useState<Choice>();
  const [editingEndpoint, setEditingEndpoint] = useState<EndpointKind>("start");
  const [pendingChoice, setPendingChoice] = useState<Choice>();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [profile, setProfile] = useState<TravelProfile>("healthy");
  const [route, setRoute] = useState<Feature<LineString>>();
  const [routeSegments, setRouteSegments] =
    useState<ReturnType<typeof routePresentation>["segments"]>();
  const [approachPoints, setApproachPoints] =
    useState<ReturnType<typeof routePresentation>["approaches"]>();
  const [routePathIds, setRoutePathIds] = useState<string[]>([]);
  const [routeOutdated, setRouteOutdated] = useState(false);
  const [routeLoading, setRouteLoading] = useState(false);
  const [routeMessages, setRouteMessages] = useState<string[]>([]);
  const [requestError, setRequestError] = useState("");
  const [noteCoordinate, setNoteCoordinate] = useState<Coordinate>();
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [messageSent, setMessageSent] = useState(false);
  const routeRequestId = useRef(0);
  const routeRevision = useRef<string | undefined>(undefined);
  const recomputeRouteRef = useRef<(replan?: boolean) => void>(() => undefined);

  async function loadBuildingFloors(buildingId: string) {
    const apiBase = import.meta.env.VITE_API_URL ?? "http://localhost:3001";
    const response = await fetch(
      `${apiBase}/api/buildings/${encodeURIComponent(buildingId)}`,
    );
    const payload = await response.json();
    if (!response.ok)
      throw new Error(payload?.error ?? "Floor list could not be loaded");
    return (payload.floors ?? []) as SavedFloorSummary[];
  }

  async function showRequestedFloor(retry = false) {
    if (!selectedBuildingId) return;
    setShowFloorViewer(true);
    setFloorViewerState("loading");
    setFloorViewerError("");
    try {
      const floors = retry
        ? buildingFloors
        : await loadBuildingFloors(selectedBuildingId);
      setBuildingFloors(floors);
      if (!floors.some((floor) => floor.floor_number === buildingFloor)) {
        setFloorViewerLayout(undefined);
        setFloorViewerState("unavailable");
        return;
      }
      const saved = (await api.floor(
        selectedBuildingId,
        buildingFloor,
      )) as unknown as SavedFloorDetails;
      const boundaryCoordinates = Array.isArray(saved.boundary)
        ? saved.boundary[0]
        : saved.boundary.coordinates?.[0];
      const transform = saved.mapTransform ?? saved.map_transform;
      if (!transform)
        throw new Error("The saved floor has no coordinate transform.");
      const boundary = (boundaryCoordinates ?? [])
        .slice(0, -1)
        .map(([x = 0, y = 0]) => ({ x, y }));
      const layout: FloorLayout = {
        buildingId: selectedBuildingId,
        floor: buildingFloor,
        version:
          saved.version ??
          floors.find((floor) => floor.floor_number === buildingFloor)
            ?.version ??
          1,
        localWidth: saved.localWidth ?? saved.local_width ?? 0,
        localHeight: saved.localHeight ?? saved.local_height ?? 0,
        transform,
        boundary,
        status: "published",
        features: saved.features.map((feature) => {
          const geometry = feature.geometry;
          if (feature.kind === "room")
            return {
              id: feature.id,
              kind: "room",
              name: feature.name,
              x: Number(geometry.x),
              y: Number(geometry.y),
              width: Number(geometry.width),
              height: Number(geometry.height),
            };
          if (feature.kind === "door")
            return {
              id: feature.id,
              kind: "door",
              name: feature.name,
              parent: geometry.parent as Extract<
                FloorLayout["features"][number],
                { kind: "door" }
              >["parent"],
              position: Number(geometry.position),
              isExit: Boolean(feature.is_exit),
              outdoorPosition: feature.outdoor_position,
              linkedGraphNodeId: feature.linked_graph_node_id,
            };
          if (feature.kind === "stairs" || feature.kind === "lift")
            return {
              id: feature.id,
              kind: feature.kind,
              name: feature.name,
              x: Number(geometry.x),
              y: Number(geometry.y),
              size: Number(geometry.size),
              connectorId: feature.connector_id ?? "",
              servedFloors: feature.served_floors ?? [],
            };
          return {
            id: feature.id,
            kind: "point",
            name: feature.name,
            x: Number(geometry.x),
            y: Number(geometry.y),
          };
        }),
      };
      setFloorViewerLayout(layout);
      setFloorViewerState("ready");
    } catch (cause) {
      setFloorViewerError(
        cause instanceof Error
          ? cause.message
          : "Floor layout could not be loaded",
      );
      setFloorViewerState("error");
    }
  }

  const refreshMap = useCallback(async () => {
    try {
      const next = (await api.map()) as MapData;
      setMapData(next);
      setMapError("");
      if (routePathIds.length) {
        const blockedIds = new Set(
          next.paths?.features
            .filter((feature) => feature.properties?.blocked)
            .map((feature) => feature.properties?.id ?? "") ?? [],
        );
        if (routePathIds.some((id) => blockedIds.has(id))) {
          routeRequestId.current += 1;
          setRoute(undefined);
          setRouteSegments(undefined);
          setApproachPoints(undefined);
          setRoutePathIds([]);
          setRouteOutdated(true);
          setRouteMessages([]);
          if (start && destination) recomputeRouteRef.current(true);
        }
      }
    } catch (cause) {
      setMapError(
        cause instanceof Error ? cause.message : "Map data could not be loaded",
      );
    }
  }, [routePathIds, start, destination]);

  useEffect(() => {
    void refreshMap();
    const refresh = () => {
      if (document.visibilityState === "visible") void refreshMap();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    const timer = window.setInterval(refresh, 30_000);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
      window.clearInterval(timer);
    };
  }, [refreshMap]);

  useEffect(() => {
    if (!route || !routePathIds.length) return;
    let active = true;
    let checking = false;
    let observedRevision = routeRevision.current;
    const checkNetwork = async () => {
      if (checking) return;
      checking = true;
      try {
        const current = await api.networkState();
        if (!active) return;
        if (observedRevision === undefined) {
          observedRevision = current.revision;
          return;
        }
        if (current.revision === observedRevision) return;
        observedRevision = current.revision;
        const blocked = new Set(current.blockedPathIds);
        if (routePathIds.some((id) => blocked.has(id))) {
          routeRequestId.current += 1;
          setRoute(undefined);
          setRouteSegments(undefined);
          setApproachPoints(undefined);
          setRoutePathIds([]);
          setRouteOutdated(false);
          setRouteMessages(["Route changed; finding another way."]);
          recomputeRouteRef.current(true);
        }
      } catch {
        // Network polling is advisory; an unavailable check leaves the current
        // route visible until the next poll or an explicit recalculation.
      } finally {
        checking = false;
      }
    };
    const onFocus = () => {
      if (document.visibilityState === "visible") void checkNetwork();
    };
    const timer = window.setInterval(checkNetwork, 12_000);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [route, routePathIds]);

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(async () => {
      if (mode !== "routing" || query.trim().length < 2) {
        setResults([]);
        setSearching(false);
        return;
      }
      setSearching(true);
      try {
        const response = await api.search(query);
        if (active) setResults(response.results);
      } catch {
        if (active) setResults([]);
      } finally {
        if (active) setSearching(false);
      }
    }, 220);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [mode, query]);

  const selectedPath = mapData?.paths?.features.find(
    (feature) => feature.properties?.id === selectedPathId,
  );
  const selectedPoint = mapData?.points.features.find(
    (feature) => feature.properties?.id === selectedPointId,
  );
  const selectedAlert = mapData?.alerts.find(
    (alert) => alert.id === selectedAlertId,
  );
  const selectedPathDetails = selectedPath?.properties;
  const selectedBuilding = mapData?.buildings.features.find(
    (feature) => feature.properties.id === selectedBuildingId,
  );
  const pendingCoordinate =
    mode === "send-note" ? noteCoordinate : pendingChoice?.coordinate;
  const routeSourceIds = (routeSegments?.features ?? []).flatMap((feature) => {
    const id = feature.properties?.sourceId ?? feature.properties?.pathId;
    return id ? [id] : [];
  });
  const routeNotes = useMemo(() => {
    const seen = new Set<string>();
    const notes: string[] = [];
    for (const segment of routeSegments?.features ?? []) {
      const id = segment.properties?.sourceId ?? segment.properties?.pathId;
      const path = id
        ? mapData?.paths?.features.find(
            (feature) => feature.properties?.id === id,
          )
        : undefined;
      const text = (
        segment.properties?.note ??
        path?.properties?.note ??
        ""
      ).trim();
      const stableId = id ?? text;
      if (text && !seen.has(stableId)) {
        seen.add(stableId);
        notes.push(text);
      }
    }
    return notes;
  }, [mapData, routeSegments]);

  function clearRoute() {
    routeRequestId.current += 1;
    setRoute(undefined);
    setRouteSegments(undefined);
    setApproachPoints(undefined);
    setRoutePathIds([]);
    setRouteOutdated(false);
    setRouteMessages([]);
    setRequestError("");
  }

  function changeMode(next: PublicMode) {
    routeRequestId.current += 1;
    setRouteLoading(false);
    setMode(next);
    setPendingChoice(undefined);
    setNoteCoordinate(undefined);
    setRequestError("");
    setMessageSent(false);
    setSelectedPointId("");
    setSelectedAlertId("");
    if (next !== "routing") setQuery("");
  }

  function setLocation(choice: Choice) {
    if (editingEndpoint === "start") {
      setStart(choice);
      setEditingEndpoint("destination");
    } else {
      setDestination(choice);
    }
    setPendingChoice(undefined);
    setQuery("");
    clearRoute();
  }

  function chooseMapPoint(coordinate: Coordinate) {
    if (mode === "send-note") {
      setNoteCoordinate(coordinate);
      setMessageSent(false);
      return;
    }
    if (mode !== "routing") return;
    clearRoute();
    setPendingChoice({
      label: "Map point",
      endpoint: { kind: "outdoor", coordinates: coordinate },
      coordinate,
    });
    setQuery("");
  }

  function chooseBuilding(id: string) {
    if (mode === "routing") {
      const building = mapData?.buildings.features.find(
        (feature) => feature.properties.id === id,
      );
      const choice: Choice = {
        label: building?.properties.name ?? "Mapped building",
        buildingId: id,
        endpoint: { kind: "building", buildingId: id } as RouteEndpoint,
      };
      setPendingChoice(choice);
      setQuery("");
      return;
    }
    if (mode === "view") {
      setSelectedBuildingId(id);
      setBuildingFloor(0);
      setShowFloorViewer(false);
      setBuildingFloors([]);
      setFloorViewerLayout(undefined);
      void loadBuildingFloors(id)
        .then(setBuildingFloors)
        .catch((cause: unknown) => {
          setFloorViewerError(
            cause instanceof Error
              ? cause.message
              : "Floor list could not be loaded",
          );
        });
      setSelectedPathId("");
      setSelectedPointId("");
      setSelectedAlertId("");
    }
  }

  function chooseSearchResult(result: SearchResult) {
    clearRoute();
    const buildingId =
      result.kind === "building" ? result.id : result.buildingId;
    if (buildingId) {
      setPendingChoice({
        label: result.name,
        buildingId,
        endpoint: { kind: "building", buildingId } as RouteEndpoint,
        coordinate:
          result.longitude != null && result.latitude != null
            ? [result.longitude, result.latitude]
            : undefined,
      });
    } else if (result.longitude != null && result.latitude != null) {
      const coordinates: Coordinate = [result.longitude, result.latitude];
      setPendingChoice({
        label: result.name,
        endpoint: { kind: "outdoor", coordinates },
        coordinate: coordinates,
      });
    }
    setQuery(result.name);
    setResults([]);
  }

  function locateStart() {
    navigator.geolocation?.getCurrentPosition(
      (position) => {
        const coordinates: Coordinate = [
          position.coords.longitude,
          position.coords.latitude,
        ];
        setPendingChoice({
          label: "Current location",
          endpoint: { kind: "outdoor", coordinates },
          coordinate: coordinates,
        });
      },
      () =>
        setRequestError(
          "Location permission was denied. Search for a place or select a map point instead.",
        ),
      { enableHighAccuracy: true },
    );
  }

  async function findRoute(replan = false) {
    if (!start || !destination) return;
    const requestId = ++routeRequestId.current;
    setRouteLoading(true);
    setRequestError("");
    setRouteMessages(replan ? ["Route changed; finding another way."] : []);
    setRoute(undefined);
    setRouteSegments(undefined);
    setApproachPoints(undefined);
    setRouteOutdated(false);
    try {
      const response = await api.route(
        profile,
        start.endpoint,
        destination.endpoint,
      );
      if (requestId !== routeRequestId.current) return;
      if (response.status === "ok") {
        routeRevision.current = response.networkRevision;
        const presentation = routePresentation(response);
        setRoute({
          type: "Feature",
          properties: {},
          geometry: response.geometry,
        });
        setRouteSegments(presentation.segments);
        setApproachPoints(presentation.approaches);
        const sourceIds = presentation.segments.features.flatMap((feature) => {
          const id = feature.properties?.sourceId ?? feature.properties?.pathId;
          return id ? [id] : [];
        });
        setRoutePathIds([...new Set(sourceIds)]);
        setRouteMessages([
          ...(replan ? ["Route changed; finding another way."] : []),
          ...(response as Extract<RouteResponse, { status: "ok" }>).notices,
        ]);
      } else if (response.status === "no_route") {
        routeRevision.current = response.networkRevision;
        setRoutePathIds([]);
        setRouteMessages([
          ...(replan ? ["Route changed; finding another way."] : []),
          noRouteMessages[response.code] ?? response.message,
        ]);
      } else {
        routeRevision.current = response.networkRevision;
        setRoutePathIds([]);
        setRouteMessages(["Route changed; finding another way."]);
        window.setTimeout(() => {
          if (requestId === routeRequestId.current) void findRoute(true);
        }, 0);
      }
    } catch (cause) {
      if (requestId === routeRequestId.current)
        setRequestError(
          cause instanceof Error
            ? cause.message
            : "Route could not be calculated.",
        );
    } finally {
      if (requestId === routeRequestId.current) setRouteLoading(false);
    }
  }
  recomputeRouteRef.current = (replan) => {
    void findRoute(replan);
  };

  async function sendNote() {
    const text = note.trim();
    if (!noteCoordinate || !text || text.length > maximumNoteLength || sending)
      return;
    setSending(true);
    setRequestError("");
    try {
      await api.message(noteCoordinate, text);
      setNote("");
      setNoteCoordinate(undefined);
      setMessageSent(true);
    } catch (cause) {
      setRequestError(
        cause instanceof Error
          ? cause.message
          : "Message could not be sent. Try again.",
      );
    } finally {
      setSending(false);
    }
  }

  const startCoordinate = start?.coordinate;
  const destinationCoordinate = destination?.coordinate;
  const canFindRoute = Boolean(
    start && destination && !pendingChoice && !query.trim(),
  );
  const mapSelectedBuildingId =
    mode === "view"
      ? selectedBuildingId
      : mode === "routing"
        ? (pendingChoice?.buildingId ??
          (editingEndpoint === "start"
            ? start?.buildingId
            : destination?.buildingId))
        : undefined;
  const paths = [...(mapData?.paths?.features ?? [])].sort((left, right) => {
    const byName = (left.properties?.name ?? "").localeCompare(
      right.properties?.name ?? "",
    );
    return (
      byName ||
      (left.properties?.id ?? "").localeCompare(right.properties?.id ?? "")
    );
  });

  return (
    <main className="app-shell public-map-page">
      <header className="topbar">
        <div>
          <span className="eyebrow">SGSITS · Indore</span>
          <h1>Campus Access</h1>
        </div>
        <a href="/edit/login">Editor sign in</a>
      </header>
      <nav className="public-modes" role="tablist" aria-label="Map mode">
        {(
          [
            ["view", "View"],
            ["routing", "Routing"],
            ["send-note", "Send Note"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            role="tab"
            aria-selected={mode === value}
            className={mode === value ? "active" : ""}
            onClick={() => changeMode(value)}
          >
            {label}
          </button>
        ))}
      </nav>
      <section className="workspace">
        <div className="map-wrap">
          <CampusMap
            data={mapData}
            interactionMode={mode}
            start={startCoordinate}
            destination={destinationCoordinate}
            pending={pendingCoordinate}
            route={route}
            routeSegments={routeSegments}
            approachPoints={approachPoints}
            selectedBuildingId={mapSelectedBuildingId}
            onPick={chooseMapPoint}
            onBuilding={chooseBuilding}
            onPath={(id) => {
              if (mode === "view") {
                setSelectedPathId(id);
                setSelectedPointId("");
                setSelectedAlertId("");
                setSelectedBuildingId("");
              }
            }}
            onPoint={(id) => {
              if (mode === "view") {
                setSelectedPointId(id);
                setSelectedPathId("");
                setSelectedAlertId("");
                setSelectedBuildingId("");
              }
            }}
            onAlert={(id) => {
              if (mode === "view") {
                setSelectedAlertId(id);
                setSelectedPathId("");
                setSelectedPointId("");
                setSelectedBuildingId("");
              }
            }}
            onPendingMove={mode === "send-note" ? setNoteCoordinate : undefined}
          />
          <div className="map-prompt">
            <b>
              {mode === "view"
                ? "Explore campus"
                : mode === "routing"
                  ? "Choose route locations"
                  : "Select a location on the map"}
            </b>
            <span>
              {mode === "send-note"
                ? noteCoordinate
                  ? "Location: Selected"
                  : "Select a location on the map"
                : mode === "routing"
                  ? "Search a building or place, or select a point on the map."
                  : "Select a path, alert, point or building to view details."}
            </span>
          </div>
        </div>
        <aside className="panel public-route-panel">
          {mode === "view" && (
            <section
              className="public-view-panel"
              aria-label="Campus map details"
            >
              <h2>View campus</h2>
              <label className="field">
                Route or path
                <select
                  aria-label="Select route or path"
                  value={selectedPathId}
                  onChange={(event) => {
                    setSelectedPathId(event.target.value);
                    setSelectedPointId("");
                    setSelectedAlertId("");
                    setSelectedBuildingId("");
                  }}
                >
                  <option value="">Choose a path</option>
                  {paths.map((feature, index) => (
                    <option
                      key={feature.properties?.id}
                      value={feature.properties?.id}
                    >
                      {feature.properties?.name ||
                        `Path ${String(index + 1).padStart(2, "0")}`}
                    </option>
                  ))}
                </select>
              </label>
              {selectedPathDetails && (
                <div className="feature-detail">
                  <h3>{selectedPathDetails.name || "Selected path"}</h3>
                  <p>
                    {selectedPathDetails.blocked
                      ? "Blocked"
                      : "Good for routing"}
                  </p>
                  {selectedPathDetails.note && (
                    <p>{selectedPathDetails.note}</p>
                  )}
                </div>
              )}
              {selectedPoint && (
                <div className="feature-detail">
                  <h3>{selectedPoint.properties?.name || "Outdoor point"}</h3>
                  <p>{selectedPoint.properties?.note || "No note."}</p>
                </div>
              )}
              {selectedAlert && (
                <div className="feature-detail">
                  <h3>Campus alert</h3>
                  <p>{selectedAlert.description}</p>
                </div>
              )}
              {selectedBuilding && !showFloorViewer && (
                <div className="feature-detail building-view-card">
                  <h3>{selectedBuilding.properties.name}</h3>
                  <p>Building selected</p>
                  <label className="field">
                    Floor
                    <select
                      value={buildingFloor}
                      onChange={(event) =>
                        setBuildingFloor(Number(event.target.value))
                      }
                      aria-label="Select building floor"
                    >
                      {buildingFloors.length ? (
                        buildingFloors.map((floor) => (
                          <option key={floor.id} value={floor.floor_number}>
                            {floor.floor_number === 0
                              ? "Ground floor"
                              : `Floor ${floor.floor_number}`}
                          </option>
                        ))
                      ) : (
                        <option value={0}>Ground floor</option>
                      )}
                    </select>
                  </label>
                  <button
                    className="primary full"
                    onClick={() => void showRequestedFloor()}
                  >
                    View floor layout
                  </button>
                </div>
              )}
              {showFloorViewer && selectedBuilding && (
                <div className="feature-detail floor-view-panel">
                  <div className="floor-view-heading">
                    <h3>
                      {selectedBuilding.properties.name} ·{" "}
                      {buildingFloor === 0
                        ? "Ground floor"
                        : `Floor ${buildingFloor}`}
                    </h3>
                    <button
                      className="back"
                      onClick={() => setShowFloorViewer(false)}
                    >
                      Back to map
                    </button>
                  </div>
                  <FloorViewer
                    state={floorViewerState}
                    layout={floorViewerLayout}
                    buildingName={selectedBuilding.properties.name}
                    error={floorViewerError}
                    onRetry={() => void showRequestedFloor(true)}
                  />
                </div>
              )}
              {!selectedPath &&
                !selectedPoint &&
                !selectedAlert &&
                !selectedBuilding && (
                  <p className="muted">
                    Choose a feature on the map or select a path above.
                  </p>
                )}
            </section>
          )}
          {mode === "routing" && (
            <section className="routing-panel" aria-label="Outdoor routing">
              <h2>Outdoor routing</h2>
              <div className="route-location">
                <label className="field">
                  Start
                  <input
                    value={
                      editingEndpoint === "start" ? query : (start?.label ?? "")
                    }
                    onFocus={() => setEditingEndpoint("start")}
                    onChange={(event) => {
                      setEditingEndpoint("start");
                      setQuery(event.target.value);
                      setPendingChoice(undefined);
                      clearRoute();
                    }}
                    placeholder="Search a place or choose map point"
                    autoComplete="off"
                  />
                </label>
                {editingEndpoint === "start" && results.length > 0 && (
                  <ul className="search-results">
                    {results.map((item) => (
                      <li key={`${item.kind}-${item.id}`}>
                        <button onClick={() => chooseSearchResult(item)}>
                          {item.name}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {editingEndpoint === "start" && (
                  <button className="gps-button" onClick={locateStart}>
                    Use phone GPS
                  </button>
                )}
                {start && (
                  <button
                    className="quiet"
                    onClick={() => {
                      setEditingEndpoint("start");
                      setQuery("");
                      setPendingChoice(undefined);
                      clearRoute();
                    }}
                  >
                    Change start
                  </button>
                )}
                {start && (
                  <button
                    className="quiet"
                    onClick={() => {
                      setStart(undefined);
                      setEditingEndpoint("start");
                      setQuery("");
                      clearRoute();
                    }}
                  >
                    Clear start
                  </button>
                )}
              </div>
              <div className="route-location">
                <label className="field">
                  Destination
                  <input
                    value={
                      editingEndpoint === "destination"
                        ? query
                        : (destination?.label ?? "")
                    }
                    onFocus={() => setEditingEndpoint("destination")}
                    onChange={(event) => {
                      setEditingEndpoint("destination");
                      setQuery(event.target.value);
                      setPendingChoice(undefined);
                      clearRoute();
                    }}
                    placeholder="Search a building or place"
                    autoComplete="off"
                  />
                </label>
                {editingEndpoint === "destination" && results.length > 0 && (
                  <ul className="search-results">
                    {results.map((item) => (
                      <li key={`${item.kind}-${item.id}`}>
                        <button onClick={() => chooseSearchResult(item)}>
                          {item.name}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {destination && (
                  <button
                    className="quiet"
                    onClick={() => {
                      setEditingEndpoint("destination");
                      setQuery("");
                      setPendingChoice(undefined);
                      clearRoute();
                    }}
                  >
                    Change destination
                  </button>
                )}
                {destination && (
                  <button
                    className="quiet"
                    onClick={() => {
                      setDestination(undefined);
                      setEditingEndpoint("destination");
                      setQuery("");
                      clearRoute();
                    }}
                  >
                    Clear destination
                  </button>
                )}
              </div>
              {searching && <p className="muted">Searching…</p>}
              {pendingChoice && (
                <div className="selection-card">
                  <span className="selection-kicker">Location selected</span>
                  <h3>{pendingChoice.label}</h3>
                  <button
                    className="primary full"
                    onClick={() => setLocation(pendingChoice)}
                  >
                    Use as {editingEndpoint}
                  </button>
                </div>
              )}
              <div className="profiles" aria-label="Travel profile">
                {(Object.keys(profileLabels) as TravelProfile[]).map(
                  (value) => (
                    <button
                      key={value}
                      className={profile === value ? "selected" : ""}
                      onClick={() => {
                        setProfile(value);
                        clearRoute();
                      }}
                    >
                      {profileLabels[value]}
                    </button>
                  ),
                )}
              </div>
              <button
                className="primary full"
                disabled={!canFindRoute || routeLoading}
                onClick={() => void findRoute()}
              >
                {routeLoading ? "Finding a route…" : "Find route"}
              </button>
              {(route || routeOutdated) && (
                <button className="quiet full" onClick={clearRoute}>
                  Clear route
                </button>
              )}
              {routeOutdated && (
                <p className="notice" role="status">
                  This route changed. Find a new route to continue.
                </p>
              )}
              {routeMessages.map((text, index) => (
                <p className="notice" role="status" key={`${index}-${text}`}>
                  {text}
                </p>
              ))}
              {routeNotes.map((text, index) => (
                <p className="route-note" key={`${index}-${text}`}>
                  {text}
                </p>
              ))}
              {route && routeSourceIds.length === 0 && (
                <p className="muted">Route is ready.</p>
              )}
              {requestError && (
                <p className="error" role="alert">
                  {requestError}
                </p>
              )}
            </section>
          )}
          {mode === "send-note" && (
            <section
              className="send-note-panel"
              aria-label="Send a note to the editor"
            >
              <h2>Send Note</h2>
              <p className="location-selected">
                {noteCoordinate
                  ? "Location: Selected"
                  : "Select a location on the map"}
              </p>
              <label className="field">
                What should the editor know?{" "}
                <small>
                  {note.length}/{maximumNoteLength}
                </small>
                <textarea
                  maxLength={maximumNoteLength}
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                />
              </label>
              <button
                className="primary full"
                disabled={!noteCoordinate || !note.trim() || sending}
                onClick={() => void sendNote()}
              >
                {sending ? "Sending…" : "Send"}
              </button>
              {messageSent && (
                <p className="success-message" role="status">
                  Message sent to editor
                </p>
              )}
              {requestError && (
                <p className="error" role="alert">
                  {requestError}
                </p>
              )}
            </section>
          )}
          {mapError && (
            <p className="error" role="alert">
              Map data: {mapError}{" "}
              <button onClick={() => void refreshMap()}>Retry</button>
            </p>
          )}
        </aside>
      </section>
    </main>
  );
}
