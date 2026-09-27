import type { Feature, LineString, Polygon } from "geojson";

export type LonLat = readonly [longitude: number, latitude: number];

export type OsmTags = Readonly<Record<string, string>>;

export interface OsmNode {
  readonly id: string;
  readonly coordinates: LonLat;
  readonly tags: OsmTags;
}

export interface OsmWay {
  readonly id: string;
  readonly nodeIds: readonly string[];
  readonly tags: OsmTags;
}

export interface OsmExtract {
  readonly bounds: Readonly<{
    minLongitude: number;
    minLatitude: number;
    maxLongitude: number;
    maxLatitude: number;
  }> | null;
  readonly nodes: ReadonlyMap<string, OsmNode>;
  readonly ways: readonly OsmWay[];
}

export interface OsmBuildingCandidate {
  readonly id: string;
  readonly sourceWayId: string;
  readonly name: string | null;
  readonly levels: number | null;
  readonly footprint: Feature<Polygon>;
}

export type OsmReviewDecision =
  "pending" | "approved" | "rejected" | "needs_edit";

/** Reference-only data. This shape deliberately has no `verified` property. */
export interface OsmPathCandidate {
  readonly id: string;
  readonly sourceWayId: string;
  readonly orderedNodeIds: readonly string[];
  readonly coordinates: readonly LonLat[];
  readonly tags: OsmTags;
  readonly barrierNodeIds: readonly string[];
  readonly importStatus: "imported";
  readonly reviewerDecision: OsmReviewDecision;
  readonly geometry: Feature<LineString>;
  readonly blocked?: boolean;
  readonly note?: string | null;
  readonly version?: number;
}

export interface OsmCandidateSegment {
  readonly id: string;
  readonly candidateId: string;
  readonly sourceWayId: string;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly coordinates: readonly [LonLat, LonLat];
}

export interface OsmImportModel {
  readonly buildings: readonly OsmBuildingCandidate[];
  readonly pathCandidates: readonly OsmPathCandidate[];
  readonly pathSegments: readonly OsmCandidateSegment[];
}
