import type { Feature, Polygon } from "geojson";
import type { RouteEdge, RouteNode } from "../routing/types.js";
import type {
  LonLat,
  OsmBuildingCandidate,
  OsmPathCandidate,
  OsmReviewDecision,
  OsmTags,
} from "./types.js";

export type OsmExclusionReason =
  | "review_rejected"
  | "review_needs_edit"
  | "ineligible_highway"
  | "access_forbidden"
  | "vehicle_only_service"
  | "blocked_by_barrier"
  | "crosses_building";

export interface ProvisionalOsmGraph {
  readonly nodes: readonly RouteNode[];
  readonly edges: readonly RouteEdge[];
  readonly excluded: readonly {
    sourceWayId: string;
    reason: OsmExclusionReason;
  }[];
}

const WALKABLE_HIGHWAYS = new Set([
  "footway",
  "path",
  "pedestrian",
  "living_street",
]);
const POSITIVE_ACCESS = new Set(["yes", "designated", "permissive"]);
const FORBIDDEN_ACCESS = new Set(["no", "private"]);

export function osmWalkingEligibility(tags: OsmTags):
  | { eligible: true; wheelchairEligible: boolean }
  | {
      eligible: false;
      reason: OsmExclusionReason;
    } {
  const highway = tags.highway;
  const foot = tags.foot;
  const access = tags.access;
  if (
    FORBIDDEN_ACCESS.has(foot ?? "") ||
    access === "no" ||
    (access === "private" &&
      highway !== "service" &&
      !POSITIVE_ACCESS.has(foot ?? ""))
  ) {
    return { eligible: false, reason: "access_forbidden" };
  }
  if (highway === "steps") return { eligible: true, wheelchairEligible: false };
  if (highway === "service") {
    const walkingEvidence =
      POSITIVE_ACCESS.has(foot ?? "") ||
      access === "private" ||
      tags.sidewalk === "yes" ||
      tags.sidewalk === "both" ||
      tags.sidewalk === "left" ||
      tags.sidewalk === "right";
    return walkingEvidence
      ? { eligible: true, wheelchairEligible: tags.wheelchair !== "no" }
      : { eligible: false, reason: "vehicle_only_service" };
  }
  if (!highway || !WALKABLE_HIGHWAYS.has(highway))
    return { eligible: false, reason: "ineligible_highway" };
  return {
    eligible: true,
    wheelchairEligible:
      tags.wheelchair !== "no" &&
      tags.incline !== "up" &&
      tags.incline !== "down",
  };
}

function orientation(a: LonLat, b: LonLat, c: LonLat): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function properIntersection(
  a: LonLat,
  b: LonLat,
  c: LonLat,
  d: LonLat,
): boolean {
  const abC = orientation(a, b, c);
  const abD = orientation(a, b, d);
  const cdA = orientation(c, d, a);
  const cdB = orientation(c, d, b);
  const epsilon = 1e-14;
  return (
    Math.abs(abC) > epsilon &&
    Math.abs(abD) > epsilon &&
    Math.abs(cdA) > epsilon &&
    Math.abs(cdB) > epsilon &&
    Math.sign(abC) !== Math.sign(abD) &&
    Math.sign(cdA) !== Math.sign(cdB)
  );
}

function pointStrictlyInsideRing(
  point: LonLat,
  ring: readonly number[][],
): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const a = ring[i]!;
    const b = ring[j]!;
    const cross =
      (point[0] - a[0]!) * (b[1]! - a[1]!) -
      (point[1] - a[1]!) * (b[0]! - a[0]!);
    if (
      Math.abs(cross) <= 1e-14 &&
      point[0] >= Math.min(a[0]!, b[0]!) &&
      point[0] <= Math.max(a[0]!, b[0]!) &&
      point[1] >= Math.min(a[1]!, b[1]!) &&
      point[1] <= Math.max(a[1]!, b[1]!)
    )
      return false;
    const crosses =
      a[1]! > point[1] !== b[1]! > point[1] &&
      point[0] <
        ((b[0]! - a[0]!) * (point[1] - a[1]!)) / (b[1]! - a[1]!) + a[0]!;
    if (crosses) inside = !inside;
  }
  return inside;
}

function pointStrictlyInsidePolygon(
  point: LonLat,
  rings: readonly (readonly number[][])[],
): boolean {
  const outer = rings[0];
  if (!outer || !pointStrictlyInsideRing(point, outer)) return false;
  return !rings.slice(1).some((hole) => pointStrictlyInsideRing(point, hole));
}

function ringPosition(ring: readonly number[][], index: number): LonLat {
  const position = ring[index];
  if (!position || position.length < 2)
    throw new Error("Invalid building ring");
  return [position[0]!, position[1]!];
}

export function polylineCrossesBuildingInterior(
  coordinates: readonly LonLat[],
  footprint: Feature<Polygon>,
): boolean {
  const rings = footprint.geometry.coordinates;
  const outer = rings[0];
  if (!outer || outer.length < 4) return false;
  for (let index = 0; index < coordinates.length - 1; index += 1) {
    const start = coordinates[index]!;
    const end = coordinates[index + 1]!;
    const middle: LonLat = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2];
    if (
      pointStrictlyInsidePolygon(start, rings) ||
      pointStrictlyInsidePolygon(end, rings) ||
      pointStrictlyInsidePolygon(middle, rings)
    )
      return true;
    for (let ringIndex = 0; ringIndex < outer.length - 1; ringIndex += 1) {
      if (
        properIntersection(
          start,
          end,
          ringPosition(outer, ringIndex),
          ringPosition(outer, ringIndex + 1),
        )
      )
        return true;
    }
  }
  return false;
}

/**
 * Converts actual ordered OSM ways into queryable provisional topology.
 * Ways split only at endpoints and source node IDs shared by eligible ways;
 * geometric crossings never become junctions.
 */
export function buildProvisionalOsmGraph(input: {
  readonly candidates: readonly OsmPathCandidate[];
  readonly buildings?: readonly OsmBuildingCandidate[];
  readonly decisions?: ReadonlyMap<string, OsmReviewDecision | null>;
}): ProvisionalOsmGraph {
  const excluded: { sourceWayId: string; reason: OsmExclusionReason }[] = [];
  const eligible: {
    candidate: OsmPathCandidate;
    wheelchairEligible: boolean;
  }[] = [];
  for (const candidate of [...input.candidates].sort((a, b) =>
    a.sourceWayId.localeCompare(b.sourceWayId, "en", { numeric: true }),
  )) {
    const decision =
      input.decisions?.get(candidate.sourceWayId) ?? candidate.reviewerDecision;
    if (decision === "rejected" || decision === "needs_edit") {
      excluded.push({
        sourceWayId: candidate.sourceWayId,
        reason:
          decision === "rejected" ? "review_rejected" : "review_needs_edit",
      });
      continue;
    }
    const classification = osmWalkingEligibility(candidate.tags);
    if (!classification.eligible) {
      excluded.push({
        sourceWayId: candidate.sourceWayId,
        reason: classification.reason,
      });
      continue;
    }
    if (candidate.barrierNodeIds.length > 0) {
      excluded.push({
        sourceWayId: candidate.sourceWayId,
        reason: "blocked_by_barrier",
      });
      continue;
    }
    if (
      (input.buildings ?? []).some((building) =>
        polylineCrossesBuildingInterior(
          candidate.coordinates,
          building.footprint,
        ),
      )
    ) {
      excluded.push({
        sourceWayId: candidate.sourceWayId,
        reason: "crosses_building",
      });
      continue;
    }
    eligible.push({
      candidate,
      wheelchairEligible: classification.wheelchairEligible,
    });
  }

  const nodeReferenceCount = new Map<string, number>();
  for (const { candidate } of eligible) {
    for (const nodeId of candidate.orderedNodeIds)
      nodeReferenceCount.set(nodeId, (nodeReferenceCount.get(nodeId) ?? 0) + 1);
  }
  const nodes = new Map<string, RouteNode>();
  const edges: RouteEdge[] = [];
  for (const { candidate, wheelchairEligible } of eligible) {
    const last = candidate.orderedNodeIds.length - 1;
    const breakIndexes = candidate.orderedNodeIds
      .map((nodeId, index) => ({ nodeId, index }))
      .filter(
        ({ nodeId, index }) =>
          index === 0 ||
          index === last ||
          (nodeReferenceCount.get(nodeId) ?? 0) > 1,
      )
      .map(({ index }) => index);
    for (let part = 0; part < breakIndexes.length - 1; part += 1) {
      const fromIndex = breakIndexes[part]!;
      const toIndex = breakIndexes[part + 1]!;
      if (toIndex <= fromIndex) continue;
      const fromOsmId = candidate.orderedNodeIds[fromIndex]!;
      const toOsmId = candidate.orderedNodeIds[toIndex]!;
      const fromNodeId = `osm-node:${fromOsmId}`;
      const toNodeId = `osm-node:${toOsmId}`;
      nodes.set(fromNodeId, {
        id: fromNodeId,
        coordinates: candidate.coordinates[fromIndex]!,
      });
      nodes.set(toNodeId, {
        id: toNodeId,
        coordinates: candidate.coordinates[toIndex]!,
      });
      edges.push(
        Object.freeze({
          id: `osm-edge:${candidate.sourceWayId}:${fromIndex}-${toIndex}`,
          fromNodeId,
          toNodeId,
          coordinates: Object.freeze(
            candidate.coordinates.slice(fromIndex, toIndex + 1),
          ),
          kind: "main",
          verified: false,
          status: "provisional",
          source: "osm",
          sourceOsmId: candidate.sourceWayId,
          osmHighway: candidate.tags.highway ?? null,
          wheelchairEligible,
          oneWay: candidate.tags["oneway:foot"] === "yes",
        }),
      );
    }
  }
  return Object.freeze({
    nodes: Object.freeze(
      [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)),
    ),
    edges: Object.freeze(edges),
    excluded: Object.freeze(excluded),
  });
}
