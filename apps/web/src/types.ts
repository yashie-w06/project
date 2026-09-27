import type { FeatureCollection, LineString, Polygon } from "geojson";

export type Coordinate = [number, number];
export type TravelProfile = "healthy" | "wheelchair" | "heavy_luggage";
export type RouteEndpoint =
  | { kind: "outdoor"; coordinates: Coordinate }
  | {
      kind: "building";
      buildingId: string;
      approachCoordinates?: Coordinate;
    };
export interface CampusMapData {
  buildings: FeatureCollection<Polygon, { id: string; name: string }>;
  paths: FeatureCollection<
    LineString,
    {
      id: string;
      name: string;
      kind: "main" | "shortcut";
      blocked: boolean;
      note: string | null;
      source: "osm" | "editor";
      version: number;
    }
  >;
  points: FeatureCollection<
    import("geojson").Point,
    { id: string; name: string; note: string }
  >;
  alerts: Array<{ id: string; coordinates: Coordinate; description: string }>;
}
export interface FloorFeature {
  id: string;
  kind: "room" | "door" | "point" | "stairs" | "lift";
  name: string;
  geometry: Record<string, unknown>;
  connector_id?: string;
  served_floors?: number[];
  is_exit?: boolean;
  outdoor_position?: Coordinate;
  linked_graph_node_id?: string;
}
export interface FloorDetails {
  boundary: Record<string, unknown>;
  localWidth: number;
  localHeight: number;
  mapTransform: Record<string, unknown>;
  features: FloorFeature[];
  connectors: FloorFeature[];
}
export type NoRouteCode =
  | "NO_WALKABLE_GRAPH"
  | "START_UNREACHABLE"
  | "DEST_UNREACHABLE"
  | "NO_PLAUSIBLE_APPROACH"
  | "DIFFERENT_COMPONENTS"
  | "BLOCKED_OR_INELIGIBLE"
  | "NO_SUITABLE_WHEELCHAIR_ROUTE";
export interface RouteSegment {
  geometry: LineString;
  pathId: string;
  kind: "main" | "shortcut";
  note: string | null;
  source?: "editor" | "osm" | "query";
  sourceId?: string;
  accessibility?: {
    surface: string | null;
    surfaceCondition: string;
    stairs: string;
    slopePercent: number | null;
    widthMeters: number | null;
    wheelchairAccess: string;
    confidence: string;
  };
  unknown?: string[];
  constraints?: string[];
}
export interface RouteApproach {
  role: "start" | "destination";
  buildingId: string;
  boundary: Coordinate;
  network: Coordinate;
  approximate: true;
}
export type RouteResponse =
  | {
      status: "ok";
      geometry: LineString;
      notices: string[];
      segments: RouteSegment[];
      approaches: RouteApproach[];
      snaps?: Array<{
        original: Coordinate;
        snapped: Coordinate;
        distanceMetres?: number;
      }>;
      networkRevision?: string;
    }
  | {
      status: "no_route";
      code: NoRouteCode;
      message: string;
      notices: string[];
      reason?: string;
      networkRevision?: string;
    }
  | {
      status: "route_changed";
      message: string;
      networkRevision: string;
    };
