import type { Feature, Polygon } from "geojson";
import type { LonLat } from "./osm/types.js";
import { polylineCrossesBuildingInterior } from "./osm/provisional.js";
import { createLocalProjection } from "./routing/projection.js";
import type { SegmentSnap } from "./routing/geometry.js";
import type { RouteEdge, RouteNode } from "./routing/types.js";

export interface BuildingApproach {
  readonly buildingId: string;
  readonly boundary: LonLat;
  readonly network: LonLat;
  readonly distanceMetres: number;
  readonly snap: SegmentSnap;
}

type Metric = { x: number; y: number };

function projectPointToSegment(point: Metric, start: Metric, end: Metric) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const denominator = dx * dx + dy * dy;
  const fraction = denominator
    ? Math.max(
        0,
        Math.min(
          1,
          ((point.x - start.x) * dx + (point.y - start.y) * dy) / denominator,
        ),
      )
    : 0;
  const projected = {
    x: start.x + fraction * dx,
    y: start.y + fraction * dy,
  };
  return {
    fraction,
    projected,
    distance: Math.hypot(point.x - projected.x, point.y - projected.y),
  };
}

function finiteRing(footprint: Feature<Polygon>): LonLat[] {
  return (footprint.geometry.coordinates[0] ?? []).flatMap((coordinate) =>
    coordinate.length >= 2 && coordinate.every(Number.isFinite)
      ? [[coordinate[0]!, coordinate[1]!] as LonLat]
      : [],
  );
}

function safeConnector(
  boundary: LonLat,
  network: LonLat,
  footprints: readonly Feature<Polygon>[],
): boolean {
  return !footprints.some((footprint) =>
    polylineCrossesBuildingInterior([boundary, network], footprint),
  );
}

function endpointNodeId(
  edge: RouteEdge,
  coordinates: LonLat,
  nodes: ReadonlyMap<string, RouteNode>,
): string | null {
  const epsilon = 1e-10;
  const from = nodes.get(edge.fromNodeId)?.coordinates;
  if (
    from &&
    Math.abs(from[0] - coordinates[0]) <= epsilon &&
    Math.abs(from[1] - coordinates[1]) <= epsilon
  )
    return edge.fromNodeId;
  const to = nodes.get(edge.toNodeId)?.coordinates;
  if (
    to &&
    Math.abs(to[0] - coordinates[0]) <= epsilon &&
    Math.abs(to[1] - coordinates[1]) <= epsilon
  )
    return edge.toNodeId;
  return null;
}

export function suggestBuildingApproach(input: {
  readonly buildingId: string;
  readonly footprint: Feature<Polygon>;
  readonly allFootprints: readonly Feature<Polygon>[];
  readonly edges: readonly RouteEdge[];
  readonly nodes: ReadonlyMap<string, RouteNode>;
  readonly requestedBoundary?: LonLat;
  readonly maxGapMetres?: number;
}): BuildingApproach | null {
  const ring = finiteRing(input.footprint);
  if (ring.length < 4) return null;
  const projection = createLocalProjection(ring[0]!);
  const projectedRing = ring.map(projection.project);
  const boundaryCandidates: Array<{
    boundary: LonLat;
    edge: RouteEdge;
    segmentIndex: number;
    segmentFraction: number;
    network: LonLat;
    distanceMetres: number;
  }> = [];

  let requested: LonLat | undefined;
  if (input.requestedBoundary) {
    const point = projection.project(input.requestedBoundary);
    let closest: { point: LonLat; distance: number } | undefined;
    for (let index = 0; index < projectedRing.length - 1; index += 1) {
      const value = projectPointToSegment(
        point,
        projectedRing[index]!,
        projectedRing[index + 1]!,
      );
      if (!closest || value.distance < closest.distance)
        closest = {
          point: projection.unproject(value.projected),
          distance: value.distance,
        };
    }
    if (!closest || closest.distance > 15) return null;
    requested = closest.point;
  }

  for (const edge of input.edges) {
    for (
      let segmentIndex = 0;
      segmentIndex < edge.coordinates.length - 1;
      segmentIndex += 1
    ) {
      const networkStart = edge.coordinates[segmentIndex]!;
      const networkEnd = edge.coordinates[segmentIndex + 1]!;
      const projectedStart = projection.project(networkStart);
      const projectedEnd = projection.project(networkEnd);
      const boundaryPoints = requested ? [requested] : ring.slice(0, -1);
      for (const boundary of boundaryPoints) {
        const value = projectPointToSegment(
          projection.project(boundary),
          projectedStart,
          projectedEnd,
        );
        boundaryCandidates.push({
          boundary,
          edge,
          segmentIndex,
          segmentFraction: value.fraction,
          network: projection.unproject(value.projected),
          distanceMetres: value.distance,
        });
      }
      if (!requested) {
        for (const [network, fraction] of [
          [networkStart, 0],
          [networkEnd, 1],
        ] as const) {
          const projectedNetwork = projection.project(network);
          for (
            let boundaryIndex = 0;
            boundaryIndex < projectedRing.length - 1;
            boundaryIndex += 1
          ) {
            const value = projectPointToSegment(
              projectedNetwork,
              projectedRing[boundaryIndex]!,
              projectedRing[boundaryIndex + 1]!,
            );
            boundaryCandidates.push({
              boundary: projection.unproject(value.projected),
              edge,
              segmentIndex,
              segmentFraction: fraction,
              network,
              distanceMetres: value.distance,
            });
          }
        }
      }
    }
  }

  const maximum = input.maxGapMetres ?? 30;
  const best = boundaryCandidates
    .filter(
      (candidate) =>
        candidate.distanceMetres <= maximum &&
        safeConnector(
          candidate.boundary,
          candidate.network,
          input.allFootprints,
        ),
    )
    .sort(
      (left, right) =>
        left.distanceMetres - right.distanceMetres ||
        left.edge.id.localeCompare(right.edge.id),
    )[0];
  if (!best) return null;
  return Object.freeze({
    buildingId: input.buildingId,
    boundary: best.boundary,
    network: best.network,
    distanceMetres: best.distanceMetres,
    snap: Object.freeze({
      edgeId: best.edge.id,
      segmentIndex: best.segmentIndex,
      segmentFraction: best.segmentFraction,
      coordinates: best.network,
      distanceMetres: best.distanceMetres,
      endpointNodeId: endpointNodeId(best.edge, best.network, input.nodes),
    }),
  });
}
