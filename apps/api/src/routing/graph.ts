import type { LonLat } from "../osm/types.js";
import { createLocalProjection, distanceMetres, polylineLengthMetres } from "./projection.js";
import type { ActiveBlock, RouteEdge, RouteNode, TravelProfile } from "./types.js";

export interface GraphArc {
  readonly edgeId: string;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly coordinates: readonly LonLat[];
  readonly cost: number;
}

export interface RoutingGraph {
  readonly nodes: ReadonlyMap<string, RouteNode>;
  readonly edges: ReadonlyMap<string, RouteEdge>;
  readonly adjacency: ReadonlyMap<string, readonly GraphArc[]>;
}

export class InvalidGraphError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidGraphError";
  }
}

export function effectiveBlockedEdgeIds(
  edges: readonly RouteEdge[],
  blocks: readonly ActiveBlock[],
): ReadonlySet<string> {
  const blocked = new Set(edges.filter((edge) => edge.blocked).map((edge) => edge.id));
  for (const block of blocks) if (block.active) for (const edgeId of block.edgeIds) blocked.add(edgeId);
  return blocked;
}

function allowedForProfile(edge: RouteEdge, profile: TravelProfile): boolean {
  return edge.kind === "main" || profile !== "wheelchair";
}

/** Builds solely from explicit, verified edges. OSM candidates are a different type and cannot enter here. */
export function buildRoutingGraph(input: {
  readonly nodes: readonly RouteNode[];
  readonly edges: readonly RouteEdge[];
  readonly profile: TravelProfile;
  readonly activeBlocks?: readonly ActiveBlock[];
  readonly endpointToleranceMetres?: number;
}): RoutingGraph {
  const nodes = new Map<string, RouteNode>();
  for (const node of input.nodes) {
    if (nodes.has(node.id)) throw new InvalidGraphError(`Duplicate route node ${node.id}`);
    nodes.set(node.id, node);
  }
  const allEdgeIds = new Set<string>();
  for (const edge of input.edges) {
    if (allEdgeIds.has(edge.id)) throw new InvalidGraphError(`Duplicate route edge ${edge.id}`);
    allEdgeIds.add(edge.id);
  }
  const blocks = input.activeBlocks ?? [];
  for (const block of blocks) {
    for (const edgeId of block.edgeIds) {
      if (!allEdgeIds.has(edgeId)) throw new InvalidGraphError(`Block references unknown edge ${edgeId}`);
    }
  }
  const blocked = effectiveBlockedEdgeIds(input.edges, blocks);
  const edges = new Map<string, RouteEdge>();
  const adjacency = new Map<string, GraphArc[]>();
  for (const node of nodes.values()) adjacency.set(node.id, []);
  const tolerance = input.endpointToleranceMetres ?? 0.25;

  for (const edge of input.edges) {
    if (!edge.verified || blocked.has(edge.id) || !allowedForProfile(edge, input.profile)) continue;
    const from = nodes.get(edge.fromNodeId);
    const to = nodes.get(edge.toNodeId);
    if (!from || !to) throw new InvalidGraphError(`Edge ${edge.id} has a dangling endpoint`);
    if (edge.coordinates.length < 2) throw new InvalidGraphError(`Edge ${edge.id} has insufficient geometry`);
    const projection = createLocalProjection(from.coordinates);
    if (distanceMetres(from.coordinates, edge.coordinates[0]!, projection) > tolerance) {
      throw new InvalidGraphError(`Edge ${edge.id} geometry does not start at its from-node`);
    }
    if (distanceMetres(to.coordinates, edge.coordinates.at(-1)!, projection) > tolerance) {
      throw new InvalidGraphError(`Edge ${edge.id} geometry does not end at its to-node`);
    }
    const cost = polylineLengthMetres(edge.coordinates, projection);
    if (!(cost > 0)) throw new InvalidGraphError(`Edge ${edge.id} has zero length`);
    edges.set(edge.id, edge);
    adjacency.get(from.id)!.push(Object.freeze({
      edgeId: edge.id,
      fromNodeId: from.id,
      toNodeId: to.id,
      coordinates: edge.coordinates,
      cost,
    }));
    if (!edge.oneWay) {
      adjacency.get(to.id)!.push(Object.freeze({
        edgeId: edge.id,
        fromNodeId: to.id,
        toNodeId: from.id,
        coordinates: Object.freeze([...edge.coordinates].reverse()),
        cost,
      }));
    }
  }
  for (const arcs of adjacency.values()) arcs.sort((a, b) => a.edgeId.localeCompare(b.edgeId));
  return Object.freeze({ nodes, edges, adjacency });
}
