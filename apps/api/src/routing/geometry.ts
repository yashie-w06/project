import type { LonLat } from "../osm/types.js";
import { createLocalProjection, type LocalProjection } from "./projection.js";
import {
  edgeEligibleForProfile,
  edgeIsRoutable,
  effectiveBlockedEdgeIds,
} from "./graph.js";
import type {
  ActiveBlock,
  RouteEdge,
  RouteNode,
  TravelProfile,
} from "./types.js";

export interface SegmentSnap {
  readonly edgeId: string;
  readonly segmentIndex: number;
  readonly segmentFraction: number;
  readonly coordinates: LonLat;
  readonly distanceMetres: number;
  readonly endpointNodeId: string | null;
}

export function snapToEdge(
  point: LonLat,
  edge: RouteEdge,
  nodes: ReadonlyMap<string, RouteNode>,
  maxDistanceMetres: number,
  projection: LocalProjection = createLocalProjection(point),
): SegmentSnap | null {
  if (
    !isFiniteCoordinate(point) ||
    !Number.isFinite(maxDistanceMetres) ||
    maxDistanceMetres < 0 ||
    edge.coordinates.length < 2
  )
    return null;
  if (edge.coordinates.some((coordinate) => !isFiniteCoordinate(coordinate)))
    return null;
  const target = projection.project(point);
  let best: Omit<SegmentSnap, "endpointNodeId"> | null = null;
  for (let index = 0; index < edge.coordinates.length - 1; index += 1) {
    const start = projection.project(edge.coordinates[index]!);
    const end = projection.project(edge.coordinates[index + 1]!);
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const denominator = dx * dx + dy * dy;
    const fraction =
      denominator === 0
        ? 0
        : Math.max(
            0,
            Math.min(
              1,
              ((target.x - start.x) * dx + (target.y - start.y) * dy) /
                denominator,
            ),
          );
    const projected = {
      x: start.x + fraction * dx,
      y: start.y + fraction * dy,
    };
    const distance = Math.hypot(target.x - projected.x, target.y - projected.y);
    if (!best || distance < best.distanceMetres) {
      best = {
        edgeId: edge.id,
        segmentIndex: index,
        segmentFraction: fraction,
        coordinates: projection.unproject(projected),
        distanceMetres: distance,
      };
    }
  }
  if (!best || best.distanceMetres > maxDistanceMetres) return null;
  const from = nodes.get(edge.fromNodeId);
  const to = nodes.get(edge.toNodeId);
  const endpointEpsilon = 0.05;
  const endpointNodeId =
    from &&
    projectionDistance(best.coordinates, from.coordinates, projection) <=
      endpointEpsilon
      ? from.id
      : to &&
          projectionDistance(best.coordinates, to.coordinates, projection) <=
            endpointEpsilon
        ? to.id
        : null;
  return Object.freeze({ ...best, endpointNodeId });
}

function projectionDistance(
  a: LonLat,
  b: LonLat,
  projection: LocalProjection,
): number {
  const ap = projection.project(a);
  const bp = projection.project(b);
  return Math.hypot(ap.x - bp.x, ap.y - bp.y);
}

export interface SplitEdgeResult {
  readonly node: RouteNode;
  readonly edges: readonly [RouteEdge, RouteEdge];
  readonly replacedEdgeId: string;
}

export function snapToVerifiedEdges(
  point: LonLat,
  edges: readonly RouteEdge[],
  nodes: ReadonlyMap<string, RouteNode>,
  maxDistanceMetres: number,
  options: {
    readonly profile?: TravelProfile;
    readonly activeBlocks?: readonly ActiveBlock[];
  } = {},
): SegmentSnap | null {
  const projection = createLocalProjection(point);
  const blocked = effectiveBlockedEdgeIds(edges, options.activeBlocks ?? []);
  let best: SegmentSnap | null = null;
  for (const edge of edges) {
    if (
      !edgeIsRoutable(edge) ||
      blocked.has(edge.id) ||
      (options.profile && !edgeEligibleForProfile(edge, options.profile))
    )
      continue;
    const snap = snapToEdge(point, edge, nodes, maxDistanceMetres, projection);
    if (
      snap &&
      (!best ||
        snap.distanceMetres < best.distanceMetres ||
        (snap.distanceMetres === best.distanceMetres &&
          snap.edgeId.localeCompare(best.edgeId) < 0))
    ) {
      best = snap;
    }
  }
  return best;
}

/** Preferred name: provisional OSM edges are eligible too. */
export const snapToEligibleEdges = snapToVerifiedEdges;

/** Pure helper; callers persist node creation, edge replacement, and attachments atomically. */
export function splitEdgeAtSnap(
  edge: RouteEdge,
  snap: SegmentSnap,
  newNodeId: string,
  firstEdgeId: string,
  secondEdgeId: string,
): SplitEdgeResult {
  if (snap.edgeId !== edge.id) throw new Error("Snap does not belong to edge");
  if (snap.endpointNodeId)
    throw new Error("An endpoint snap does not require an edge split");
  if (
    snap.segmentIndex < 0 ||
    snap.segmentIndex >= edge.coordinates.length - 1
  ) {
    throw new Error("Snap segment is outside edge geometry");
  }
  const split = snap.coordinates;
  const firstBase = edge.coordinates.slice(0, snap.segmentIndex + 1);
  const secondBase = edge.coordinates.slice(snap.segmentIndex + 1);
  const firstCoordinates = Object.freeze(
    sameCoordinate(firstBase.at(-1), split) ? firstBase : [...firstBase, split],
  );
  const secondCoordinates = Object.freeze(
    sameCoordinate(secondBase[0], split) ? secondBase : [split, ...secondBase],
  );
  const firstEdge: RouteEdge = Object.freeze({
    ...edge,
    id: firstEdgeId,
    parentFeatureId: edge.parentFeatureId ?? edge.id,
    fromNodeId: edge.fromNodeId,
    toNodeId: newNodeId,
    coordinates: firstCoordinates,
  });
  const secondEdge: RouteEdge = Object.freeze({
    ...edge,
    id: secondEdgeId,
    parentFeatureId: edge.parentFeatureId ?? edge.id,
    fromNodeId: newNodeId,
    toNodeId: edge.toNodeId,
    coordinates: secondCoordinates,
  });
  return Object.freeze({
    node: Object.freeze({ id: newNodeId, coordinates: split }),
    edges: Object.freeze([firstEdge, secondEdge] as const),
    replacedEdgeId: edge.id,
  });
}

function sameCoordinate(a: LonLat | undefined, b: LonLat): boolean {
  return a?.[0] === b[0] && a[1] === b[1];
}

function isFiniteCoordinate(coordinate: LonLat): boolean {
  return Number.isFinite(coordinate[0]) && Number.isFinite(coordinate[1]);
}
