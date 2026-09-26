import type { LonLat } from "../osm/types.js";

export type TravelProfile = "healthy" | "wheelchair" | "heavy_luggage";
export type RouteEdgeKind = "main" | "shortcut";

export interface RouteNode {
  readonly id: string;
  readonly coordinates: LonLat;
}

export interface RouteEdge {
  readonly id: string;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly coordinates: readonly LonLat[];
  readonly kind: RouteEdgeKind;
  readonly verified: boolean;
  readonly blocked?: boolean;
  readonly oneWay?: boolean;
  readonly sourceOsmId?: string | null;
}

export interface ActiveBlock {
  readonly active: boolean;
  readonly edgeIds: readonly string[];
}
