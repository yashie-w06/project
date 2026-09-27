import { useEffect, useRef, useState } from "react";
import maplibregl, {
  GeoJSONSource,
  LngLatBounds,
  Map,
  Marker,
} from "maplibre-gl";
import type {
  Feature,
  FeatureCollection,
  Geometry,
  LineString,
  Point,
} from "geojson";
import type { CampusMapData, Coordinate } from "../types";
import "./campus-map.css";

interface Props {
  data?: CampusMapData;
  interactionMode?:
    "view" | "routing" | "send-note" | "select" | "draw" | "point" | "alert";
  start?: Coordinate;
  destination?: Coordinate;
  pending?: Coordinate;
  route?: Feature<LineString>;
  routeSegments?: FeatureCollection<
    LineString,
    { pathId?: string; kind?: string; note?: string | null }
  >;
  approachPoints?: FeatureCollection<Point, { role?: string; label?: string }>;
  selectedBuildingId?: string;
  focus?: Feature<Geometry> | Coordinate;
  highlight?: Feature<Geometry>;
  snapPoints?: Coordinate[];
  onPick?: (
    coordinate: Coordinate,
    metadata?: {
      snap?: {
        parentId: string;
        coordinates: Coordinate;
        distanceMetres: number;
        screenPixels: number;
        parentVersion: number;
      };
    },
  ) => void;
  onPath?: (id: string) => void;
  onPoint?: (id: string) => void;
  onAlert?: (id: string) => void;
  onBuilding?: (id: string) => void;
  onPendingMove?: (coordinate: Coordinate) => void;
}

const emptyLine: Feature<LineString> = {
  type: "Feature",
  properties: {},
  geometry: { type: "LineString", coordinates: [] },
};

function extendGeometry(bounds: LngLatBounds, geometry: Geometry) {
  const visit = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    if (typeof value[0] === "number" && typeof value[1] === "number")
      bounds.extend(value as Coordinate);
    else value.forEach(visit);
  };
  if ("coordinates" in geometry) visit(geometry.coordinates);
}

export function CampusMap({
  data,
  interactionMode = "view",
  start,
  destination,
  pending,
  route,
  routeSegments,
  approachPoints,
  selectedBuildingId,
  focus,
  highlight,
  snapPoints,
  onPick,
  onPath,
  onPoint,
  onAlert,
  onBuilding,
  onPendingMove,
}: Props) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<Map | undefined>(undefined);
  const dataRef = useRef(data);
  const didInitialFit = useRef(false);
  const lastSelectedBuilding = useRef<string | undefined>(undefined);
  const lastFocusSignature = useRef<string | undefined>(undefined);
  const handlers = useRef({
    onPick,
    onBuilding,
    onPendingMove,
    onPath,
    onPoint,
    onAlert,
    interactionMode,
  });
  const markers = useRef<Marker[]>([]);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  handlers.current = {
    onPick,
    onBuilding,
    onPendingMove,
    onPath,
    onPoint,
    onAlert,
    interactionMode,
  };
  dataRef.current = data;

  useEffect(() => {
    if (!container.current) return;
    setFailed(false);
    didInitialFit.current = false;
    const map = new maplibregl.Map({
      container: container.current,
      center: [75.8717, 22.7263],
      zoom: 16.5,
      attributionControl: false,
      style: {
        version: 8,
        sources: {
          osm: {
            type: "raster",
            tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
            tileSize: 256,
            attribution: "© OpenStreetMap contributors",
          },
        },
        layers: [{ id: "osm", type: "raster", source: "osm" }],
      },
    });
    map.addControl(new maplibregl.NavigationControl(), "top-right");
    map.addControl(new maplibregl.AttributionControl({ compact: true }));
    map.on("click", (event) => {
      const coordinate: Coordinate = [event.lngLat.lng, event.lngLat.lat];
      const current = dataRef.current;
      const mode = handlers.current.interactionMode;
      if (
        !handlers.current.onPick ||
        (mode !== "draw" &&
          mode !== "point" &&
          mode !== "alert" &&
          mode !== "routing" &&
          mode !== "send-note")
      )
        return;
      let nearest:
        | {
            parentId: string;
            coordinates: Coordinate;
            distanceMetres: number;
            screenPixels: number;
            parentVersion: number;
          }
        | undefined;
      if (mode === "draw" && current) {
        for (const path of current.paths.features) {
          const coordinates = path.geometry.coordinates;
          for (let index = 0; index < coordinates.length - 1; index++) {
            const a = map.project(coordinates[index] as Coordinate);
            const b = map.project(coordinates[index + 1] as Coordinate);
            const dx = b.x - a.x,
              dy = b.y - a.y;
            const denominator = dx * dx + dy * dy;
            const fraction = denominator
              ? Math.max(
                  0,
                  Math.min(
                    1,
                    ((event.point.x - a.x) * dx + (event.point.y - a.y) * dy) /
                      denominator,
                  ),
                )
              : 0;
            const x = a.x + fraction * dx,
              y = a.y + fraction * dy;
            const screenPixels = Math.hypot(
              event.point.x - x,
              event.point.y - y,
            );
            if (
              screenPixels > 12 ||
              (nearest && screenPixels >= nearest.screenPixels)
            )
              continue;
            const [lon0 = 0, lat0 = 0] = coordinates[index]!;
            const [lon1 = 0, lat1 = 0] = coordinates[index + 1]!;
            const snapped: Coordinate = [
              lon0 + fraction * (lon1 - lon0),
              lat0 + fraction * (lat1 - lat0),
            ];
            const radians = Math.PI / 180;
            const dxm =
              (snapped[0] - coordinate[0]) *
              111320 *
              Math.cos(coordinate[1] * radians);
            const dym = (snapped[1] - coordinate[1]) * 110540;
            nearest = {
              parentId: path.properties.id,
              coordinates: snapped,
              distanceMetres: Math.hypot(dxm, dym),
              screenPixels,
              parentVersion: path.properties.version,
            };
          }
        }
      }
      handlers.current.onPick(
        coordinate,
        nearest ? { snap: nearest } : undefined,
      );
    });
    map.on("error", (event) => {
      // A raster basemap tile can fail independently while the campus vectors,
      // route, and editor remain fully usable. Only surface structural map
      // errors as a failed workspace.
      const sourceId = (event as { sourceId?: string }).sourceId;
      if (event.error && sourceId !== "osm") setFailed(true);
    });
    mapRef.current = map;
    const observer = new ResizeObserver(() => map.resize());
    observer.observe(container.current);
    return () => {
      observer.disconnect();
      markers.current.forEach((marker) => marker.remove());
      markers.current = [];
      map.remove();
      mapRef.current = undefined;
    };
  }, [attempt]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !data) return;
    const install = () => {
      const alertPoints: FeatureCollection<
        Point,
        { id: string; description: string }
      > = {
        type: "FeatureCollection",
        features: data.alerts.map((alert) => ({
          type: "Feature",
          id: alert.id,
          properties: { id: alert.id, description: alert.description },
          geometry: { type: "Point", coordinates: alert.coordinates },
        })),
      };
      const sources: Array<[string, object]> = [
        ["buildings", data.buildings],
        ["paths", data.paths],
        ["points", data.points],
        ["alerts", alertPoints],
      ];
      for (const [id, value] of sources) {
        const existing = map.getSource(id) as GeoJSONSource | undefined;
        if (existing) existing.setData(value as never);
        else map.addSource(id, { type: "geojson", data: value as never });
      }
      if (!map.getLayer("buildings-fill")) {
        map.addLayer({
          id: "buildings-fill",
          type: "fill",
          source: "buildings",
          paint: { "fill-color": "#d6a756", "fill-opacity": 0.38 },
        });
        map.addLayer({
          id: "buildings-line",
          type: "line",
          source: "buildings",
          paint: { "line-color": "#754d1d", "line-width": 2 },
        });
        map.addLayer({
          id: "selected-building",
          type: "line",
          source: "buildings",
          filter: ["==", ["get", "id"], ""],
          paint: { "line-color": "#0b62a4", "line-width": 5 },
        });
        map.on("click", "buildings-fill", (event) => {
          const id = event.features?.[0]?.properties?.id;
          if (id && handlers.current.onBuilding) {
            event.originalEvent.stopPropagation();
            handlers.current.onBuilding(String(id));
          }
        });
        map.on("mouseenter", "buildings-fill", () => {
          map.getCanvas().style.cursor = "pointer";
        });
        map.on("mouseleave", "buildings-fill", () => {
          map.getCanvas().style.cursor = "";
        });
      }
      if (!map.getLayer("paths-main"))
        map.addLayer({
          id: "paths-main",
          type: "line",
          source: "paths",
          filter: ["==", ["get", "kind"], "main"],
          paint: { "line-color": "#157a58", "line-width": 4 },
        });
      if (!map.getLayer("paths-shortcut"))
        map.addLayer({
          id: "paths-shortcut",
          type: "line",
          source: "paths",
          filter: ["==", ["get", "kind"], "shortcut"],
          paint: {
            "line-color": "#cb6b2c",
            "line-width": 4,
            "line-dasharray": [1, 1.5],
          },
        });
      if (!map.getLayer("points"))
        map.addLayer({
          id: "points",
          type: "circle",
          source: "points",
          paint: {
            "circle-radius": 6,
            "circle-color": "#315aa9",
            "circle-stroke-width": 2,
            "circle-stroke-color": "#fff",
          },
        });
      if (!map.getLayer("alerts"))
        map.addLayer({
          id: "alerts",
          type: "circle",
          source: "alerts",
          paint: {
            "circle-radius": 8,
            "circle-color": "#b23b34",
            "circle-stroke-width": 2,
            "circle-stroke-color": "#fff",
          },
        });
      map.on("click", "paths-main", (event) => {
        if (
          handlers.current.interactionMode !== "view" &&
          handlers.current.interactionMode !== "select"
        )
          return;
        const id = event.features?.[0]?.properties?.id;
        if (id) {
          event.originalEvent.stopPropagation();
          handlers.current.onPath?.(String(id));
        }
      });
      map.on("click", "paths-shortcut", (event) => {
        if (
          handlers.current.interactionMode !== "view" &&
          handlers.current.interactionMode !== "select"
        )
          return;
        const id = event.features?.[0]?.properties?.id;
        if (id) {
          event.originalEvent.stopPropagation();
          handlers.current.onPath?.(String(id));
        }
      });
      map.on("click", "points", (event) => {
        if (
          handlers.current.interactionMode !== "view" &&
          handlers.current.interactionMode !== "select"
        )
          return;
        const id = event.features?.[0]?.properties?.id;
        if (id) {
          event.originalEvent.stopPropagation();
          handlers.current.onPoint?.(String(id));
        }
      });
      map.on("click", "alerts", (event) => {
        if (
          handlers.current.interactionMode !== "view" &&
          handlers.current.interactionMode !== "select"
        )
          return;
        const id = event.features?.[0]?.properties?.id;
        if (id) {
          event.originalEvent.stopPropagation();
          handlers.current.onAlert?.(String(id));
        }
      });
      if (!map.getSource("active-route"))
        map.addSource("active-route", { type: "geojson", data: emptyLine });
      if (!map.getLayer("active-route"))
        map.addLayer({
          id: "active-route",
          type: "line",
          source: "active-route",
          paint: {
            "line-color": "#182b49",
            "line-width": 7,
            "line-opacity": 0.9,
          },
        });
      if (!map.getSource("route-segments"))
        map.addSource("route-segments", {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });
      if (!map.getLayer("route-main"))
        map.addLayer({
          id: "route-main",
          type: "line",
          source: "route-segments",
          filter: ["==", ["get", "kind"], "main"],
          paint: { "line-color": "#123a67", "line-width": 7 },
        });
      if (!map.getLayer("route-shortcut"))
        map.addLayer({
          id: "route-shortcut",
          type: "line",
          source: "route-segments",
          filter: ["==", ["get", "kind"], "shortcut"],
          paint: {
            "line-color": "#e09a22",
            "line-width": 7,
            "line-dasharray": [1.2, 1.2],
          },
        });
      if (!map.getSource("route-approaches"))
        map.addSource("route-approaches", {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });
      if (!map.getLayer("route-approaches"))
        map.addLayer({
          id: "route-approaches",
          type: "circle",
          source: "route-approaches",
          paint: {
            "circle-radius": 7,
            "circle-color": "#f2a51a",
            "circle-stroke-color": "#fff",
            "circle-stroke-width": 2,
          },
        });
      if (!map.getSource("selection-highlight"))
        map.addSource("selection-highlight", {
          type: "geojson",
          data: emptyLine,
        });
      if (!map.getLayer("selection-highlight"))
        map.addLayer({
          id: "selection-highlight",
          type: "line",
          source: "selection-highlight",
          paint: {
            "line-color": "#f1b927",
            "line-width": 7,
            "line-opacity": 0.95,
          },
        });
      if (!didInitialFit.current) {
        const bounds = new LngLatBounds();
        data.buildings.features.forEach((feature) =>
          extendGeometry(bounds, feature.geometry),
        );
        if (!bounds.isEmpty()) {
          map.fitBounds(bounds, { padding: 45, maxZoom: 17.5, duration: 0 });
          didInitialFit.current = true;
        }
      }
      setFailed(false);
    };
    if (map.loaded()) install();
    else map.once("load", install);
  }, [data, attempt]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map?.getLayer("selected-building")) return;
    map.setFilter("selected-building", [
      "==",
      ["get", "id"],
      selectedBuildingId ?? "",
    ]);
    if (selectedBuildingId !== lastSelectedBuilding.current) {
      lastSelectedBuilding.current = selectedBuildingId;
    } else return;
    if (selectedBuildingId && data) {
      const building = data.buildings.features.find(
        (item) => item.properties.id === selectedBuildingId,
      );
      if (building) {
        const bounds = new LngLatBounds();
        extendGeometry(bounds, building.geometry);
        if (!bounds.isEmpty())
          map.fitBounds(bounds, { padding: 90, maxZoom: 19 });
      }
    }
  }, [selectedBuildingId, data]);

  useEffect(() => {
    const map = mapRef.current;
    const signature = Array.isArray(focus)
      ? JSON.stringify(focus)
      : focus
        ? JSON.stringify(focus.geometry)
        : undefined;
    if (!map || signature === lastFocusSignature.current) return;
    lastFocusSignature.current = signature;
    if (!focus) return;
    if (Array.isArray(focus)) map.flyTo({ center: focus, zoom: 19 });
    else {
      const bounds = new LngLatBounds();
      extendGeometry(bounds, focus.geometry);
      if (!bounds.isEmpty())
        map.fitBounds(bounds, { padding: 90, maxZoom: 19 });
    }
  }, [focus]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const update = () =>
      (
        map.getSource("selection-highlight") as GeoJSONSource | undefined
      )?.setData(highlight ?? emptyLine);
    if (map.loaded()) update();
    else map.once("load", update);
  }, [highlight]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    markers.current.forEach((marker) => marker.remove());
    markers.current = [];
    if (start)
      markers.current.push(
        new maplibregl.Marker({ color: "#156c54" }).setLngLat(start).addTo(map),
      );
    if (destination)
      markers.current.push(
        new maplibregl.Marker({ color: "#b23b34" })
          .setLngLat(destination)
          .addTo(map),
      );
    if (pending) {
      const marker = new maplibregl.Marker({
        color: "#d49316",
        draggable: Boolean(handlers.current.onPendingMove),
      })
        .setLngLat(pending)
        .addTo(map);
      marker.on("dragend", () => {
        const value = marker.getLngLat();
        handlers.current.onPendingMove?.([value.lng, value.lat]);
      });
      markers.current.push(marker);
    }
    for (const coordinate of snapPoints ?? [])
      markers.current.push(
        new maplibregl.Marker({ color: "#f2a51a" })
          .setLngLat(coordinate)
          .addTo(map),
      );
    const update = () => {
      const source = map.getSource("active-route") as GeoJSONSource | undefined;
      source?.setData(routeSegments ? emptyLine : (route ?? emptyLine));
      (map.getSource("route-segments") as GeoJSONSource | undefined)?.setData(
        routeSegments ?? { type: "FeatureCollection", features: [] },
      );
      (map.getSource("route-approaches") as GeoJSONSource | undefined)?.setData(
        approachPoints ?? { type: "FeatureCollection", features: [] },
      );
      if (route) {
        const bounds = new LngLatBounds();
        extendGeometry(bounds, route.geometry);
        if (!bounds.isEmpty())
          map.fitBounds(bounds, { padding: 80, maxZoom: 19 });
      }
    };
    if (map.loaded()) update();
    else map.once("load", update);
  }, [
    start,
    destination,
    pending,
    route,
    routeSegments,
    approachPoints,
    snapPoints,
  ]);

  return (
    <div className="campus-map-frame">
      <div
        ref={container}
        className="campus-map"
        aria-label="Interactive SGSITS campus map"
      />
      {failed && (
        <div className="map-error" role="alert">
          <span>The map could not finish loading.</span>
          <button
            type="button"
            onClick={() => setAttempt((value) => value + 1)}
          >
            Retry map
          </button>
        </div>
      )}
      <div className="map-legend" aria-label="Map layers">
        <span>
          <i className="legend-main" />
          Main path
        </span>
        <span>
          <i className="legend-shortcut" />
          Shortcut
        </span>
        <span>
          <i className="legend-alert" />
          Alert
        </span>
      </div>
    </div>
  );
}
