import type { FeatureCollection, LineString, Polygon } from "geojson";

export type Coordinate = [number, number];
export type TravelProfile = "healthy" | "wheelchair" | "heavy_luggage";
export type RouteEndpoint =
  | { kind: "outdoor"; coordinates: Coordinate }
  | {
      kind: "building";
      buildingId: string;
      floor: number;
      exitDoorId?: string;
      entranceDoorId?: string;
      roomId?: string;
    };
export interface CampusMapData {
  buildings: FeatureCollection<Polygon, { id: string; name: string }>;
  referencePaths: FeatureCollection<LineString>;
  verifiedPaths: FeatureCollection<
    LineString,
    { id: string; kind: "main" | "shortcut"; blocked: boolean }
  >;
  points: FeatureCollection;
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
  | "NO_VERIFIED_PATHS"
  | "START_UNREACHABLE"
  | "DEST_UNREACHABLE"
  | "NO_LINKED_EXIT"
  | "NO_LINKED_ENTRANCE"
  | "DIFFERENT_COMPONENTS"
  | "BLOCKED_OR_INELIGIBLE";
export type RouteResponse =
  | {
      status: "ok";
      geometry: LineString;
      notices: string[];
      selectedEntranceDoorId?: string;
      snaps?: Array<{
        original: Coordinate;
        snapped: Coordinate;
        distanceMetres?: number;
      }>;
    }
  | {
      status: "no_route";
      code: NoRouteCode;
      message: string;
      notices: string[];
      reason?: string;
    };
