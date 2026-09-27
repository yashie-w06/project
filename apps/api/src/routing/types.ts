import type { LonLat } from "../osm/types.js";

export type TravelProfile = "healthy" | "wheelchair" | "heavy_luggage";
export type RouteEdgeKind = "main" | "shortcut";
export type RouteEdgeStatus = "confirmed" | "provisional" | "draft";
export type RouteEdgeSource = "editor" | "osm" | "query";

export interface RouteNode {
  readonly id: string;
  readonly coordinates: LonLat;
}

export interface RouteEdge {
  readonly id: string;
  /** Stable displayed path identity shared by all derived subedges. */
  readonly parentFeatureId?: string;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly coordinates: readonly LonLat[];
  readonly kind: RouteEdgeKind;
  readonly verified: boolean;
  /** Explicit confidence. `verified` remains for stored editor-row compatibility. */
  readonly status?: RouteEdgeStatus;
  readonly source?: RouteEdgeSource;
  readonly blocked?: boolean;
  readonly oneWay?: boolean;
  readonly sourceOsmId?: string | null;
  readonly osmHighway?: string | null;
  readonly wheelchairEligible?: boolean;
  readonly name?: string | null;
  readonly note?: string | null;
  readonly version?: number;
}

export interface ActiveBlock {
  readonly active: boolean;
  readonly edgeIds: readonly string[];
}
