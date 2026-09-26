import { useEffect, useRef, useState } from "react";
import maplibregl, {
  GeoJSONSource,
  LngLatBounds,
  Map,
  Marker,
} from "maplibre-gl";
import type { Feature, Geometry, LineString } from "geojson";
import type { CampusMapData, Coordinate } from "../types";
import "./campus-map.css";

interface Props {
  data?: CampusMapData;
  start?: Coordinate;
  destination?: Coordinate;
  pending?: Coordinate;
  route?: Feature<LineString>;
  selectedBuildingId?: string;
  focus?: Feature<Geometry> | Coordinate;
  highlight?: Feature<Geometry>;
  onPick?: (coordinate: Coordinate) => void;
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
  start,
  destination,
  pending,
  route,
  selectedBuildingId,
  focus,
  highlight,
  onPick,
  onBuilding,
  onPendingMove,
}: Props) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<Map | undefined>(undefined);
  const handlers = useRef({ onPick, onBuilding, onPendingMove });
  const markers = useRef<Marker[]>([]);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  handlers.current = { onPick, onBuilding, onPendingMove };

  useEffect(() => {
    if (!container.current) return;
    setFailed(false);
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
    map.on("click", (event) =>
      handlers.current.onPick?.([event.lngLat.lng, event.lngLat.lat]),
    );
    map.on("error", (event) => {
      if (event.error) setFailed(true);
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
      const sources: Array<[string, object]> = [
        ["buildings", data.buildings],
        ["references", data.referencePaths],
        ["verified", data.verifiedPaths],
        ["points", data.points],
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
      if (!map.getLayer("references"))
        map.addLayer({
          id: "references",
          type: "line",
          source: "references",
          paint: {
            "line-color": "#60707a",
            "line-width": 2,
            "line-dasharray": [2, 2],
            "line-opacity": 0.55,
          },
        });
      if (!map.getLayer("verified-main"))
        map.addLayer({
          id: "verified-main",
          type: "line",
          source: "verified",
          filter: ["==", ["get", "kind"], "main"],
          paint: { "line-color": "#157a58", "line-width": 5 },
        });
      if (!map.getLayer("verified-shortcut"))
        map.addLayer({
          id: "verified-shortcut",
          type: "line",
          source: "verified",
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
      const bounds = new LngLatBounds();
      data.buildings.features.forEach((feature) =>
        extendGeometry(bounds, feature.geometry),
      );
      if (!bounds.isEmpty())
        map.fitBounds(bounds, { padding: 45, maxZoom: 17.5, duration: 0 });
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
    if (!map || !focus) return;
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
    const update = () => {
      const source = map.getSource("active-route") as GeoJSONSource | undefined;
      source?.setData(route ?? emptyLine);
      if (route) {
        const bounds = new LngLatBounds();
        extendGeometry(bounds, route.geometry);
        if (!bounds.isEmpty())
          map.fitBounds(bounds, { padding: 80, maxZoom: 19 });
      }
    };
    if (map.loaded()) update();
    else map.once("load", update);
  }, [start, destination, pending, route]);

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
          Verified
        </span>
        <span>
          <i className="legend-shortcut" />
          Shortcut
        </span>
        <span>
          <i className="legend-reference" />
          Reference only
        </span>
      </div>
    </div>
  );
}
