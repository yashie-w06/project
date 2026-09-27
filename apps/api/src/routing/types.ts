import type { LonLat } from "../osm/types.js";

export type TravelProfile = "healthy" | "wheelchair" | "heavy_luggage";
export type RouteEdgeKind = "main" | "shortcut";
export type RouteEdgeStatus = "confirmed" | "provisional" | "draft";
export type RouteEdgeSource = "editor" | "osm" | "query";
export type AccessValue = "yes" | "no" | "unknown";
export type RouteConfidence = "osm_tag" | "editor_observation" | "condition_report" | "unknown";
export type SurfaceCondition = "excellent" | "good" | "intermediate" | "bad" | "very_bad" | "horrible" | "unknown";

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
  readonly lengthMeters?: number;
  readonly surface?: string | null;
  readonly surfaceCondition?: SurfaceCondition;
  readonly stairs?: AccessValue;
  readonly slopePercent?: number | null;
  readonly widthMeters?: number | null;
  readonly wheelchairAccess?: AccessValue;
  readonly confidence?: RouteConfidence;
  readonly observedAt?: string | null;
}

export interface ActiveBlock {
  readonly active: boolean;
  readonly edgeIds: readonly string[];
}
