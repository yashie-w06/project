import type { LonLat } from "../osm/types.js";
import { createLocalProjection, distanceMetres } from "./projection.js";
import type {
  ActiveBlock,
  RouteEdge,
  RouteNode,
  TravelProfile,
} from "./types.js";
import { evaluateEdge } from "./policy.js";

export interface GraphArc {
  readonly edgeId: string;
  readonly parentFeatureId: string;
  readonly kind: RouteEdge["kind"];
  readonly note: string | null;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly coordinates: readonly LonLat[];
  readonly cost: number;
  readonly status: "confirmed" | "provisional";
  readonly source: "editor" | "osm" | "query";
  readonly sourceOsmId: string | null;
  readonly unknown: readonly string[];
  readonly constraints: readonly string[];
  readonly accessibility: {
    surface: string | null;
    surfaceCondition: string;
    stairs: string;
    slopePercent: number | null;
    widthMeters: number | null;
    wheelchairAccess: string;
    confidence: string;
  };
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
  const blocked = new Set(
    edges.filter((edge) => edge.blocked).map((edge) => edge.id),
  );
  for (const block of blocks)
    if (block.active) for (const edgeId of block.edgeIds) blocked.add(edgeId);
  return blocked;
}

export function edgeEligibleForProfile(
  edge: RouteEdge,
  profile: TravelProfile,
): boolean {
  return evaluateEdge(edge, profile).eligible;
}

export function edgeIsRoutable(_edge: RouteEdge): boolean {
  // Verification/publish columns are legacy workflow state. Current path
  // eligibility is structural and explicit blocks are applied separately.
  return true;
}

function finiteCoordinate(coordinate: LonLat): boolean {
  return Number.isFinite(coordinate[0]) && Number.isFinite(coordinate[1]);
}

function normalizedCoordinates(
  edge: RouteEdge,
  from: RouteNode,
  to: RouteNode,
): readonly LonLat[] {
  return Object.freeze([
    from.coordinates,
    ...edge.coordinates.slice(1, -1),
    to.coordinates,
  ]);
}

/** Builds a combined graph from confirmed editor edges and explicit provisional OSM edges. */
export function buildRoutingGraph(input: {
  readonly nodes: readonly RouteNode[];
  readonly edges: readonly RouteEdge[];
  readonly profile: TravelProfile;
  readonly activeBlocks?: readonly ActiveBlock[];
  readonly endpointToleranceMetres?: number;
  readonly provisionalPenaltyMetres?: number;
  readonly allowUnknownWheelchair?: boolean;
}): RoutingGraph {
  const nodes = new Map<string, RouteNode>();
  for (const node of input.nodes) {
    if (nodes.has(node.id))
      throw new InvalidGraphError(`Duplicate route node ${node.id}`);
    if (!finiteCoordinate(node.coordinates))
      throw new InvalidGraphError(
        `Route node ${node.id} has invalid coordinates`,
      );
    nodes.set(node.id, node);
  }
  const allEdgeIds = new Set<string>();
  for (const edge of input.edges) {
    if (allEdgeIds.has(edge.id))
      throw new InvalidGraphError(`Duplicate route edge ${edge.id}`);
    allEdgeIds.add(edge.id);
  }
  const blocks = input.activeBlocks ?? [];
  for (const block of blocks) {
    for (const edgeId of block.edgeIds) {
      if (!allEdgeIds.has(edgeId))
        throw new InvalidGraphError(`Block references unknown edge ${edgeId}`);
    }
  }
  const blocked = effectiveBlockedEdgeIds(input.edges, blocks);
  const edges = new Map<string, RouteEdge>();
  const adjacency = new Map<string, GraphArc[]>();
  for (const node of nodes.values()) adjacency.set(node.id, []);
  const tolerance = input.endpointToleranceMetres ?? 0.25;

  for (const edge of input.edges) {
    if (
      !edgeIsRoutable(edge) ||
      blocked.has(edge.id) ||
      !edgeEligibleForProfile(edge, input.profile)
    )
      continue;
    const policy = evaluateEdge(
      edge,
      input.profile,
      input.allowUnknownWheelchair ?? true,
    );
    if (!policy.eligible) continue;
    const from = nodes.get(edge.fromNodeId);
    const to = nodes.get(edge.toNodeId);
    if (!from || !to)
      throw new InvalidGraphError(`Edge ${edge.id} has a dangling endpoint`);
    if (edge.coordinates.length < 2)
      throw new InvalidGraphError(`Edge ${edge.id} has insufficient geometry`);
    if (edge.coordinates.some((coordinate) => !finiteCoordinate(coordinate))) {
      throw new InvalidGraphError(`Edge ${edge.id} has invalid coordinates`);
    }
    const projection = createLocalProjection(from.coordinates);
    if (
      distanceMetres(from.coordinates, edge.coordinates[0]!, projection) >
      tolerance
    ) {
      throw new InvalidGraphError(
        `Edge ${edge.id} geometry does not start at its from-node`,
      );
    }
    if (
      distanceMetres(to.coordinates, edge.coordinates.at(-1)!, projection) >
      tolerance
    ) {
      throw new InvalidGraphError(
        `Edge ${edge.id} geometry does not end at its to-node`,
      );
    }
    // Endpoint discrepancies within the editor tolerance are normalized to the shared node.
    // This guarantees exact GeoJSON continuity without inventing a topological connection.
    const coordinates = normalizedCoordinates(edge, from, to);
    const status = edge.status === "provisional" ? "provisional" : "confirmed";
    const cost =
      policy.cost +
      (status === "provisional" ? (input.provisionalPenaltyMetres ?? 2) : 0);
    if (!(cost > 0))
      throw new InvalidGraphError(`Edge ${edge.id} has zero length`);
    edges.set(edge.id, edge);
    adjacency.get(from.id)!.push(
      Object.freeze({
        edgeId: edge.id,
        parentFeatureId: edge.parentFeatureId ?? edge.sourceOsmId ?? edge.id,
        kind: edge.kind,
        note: edge.note ?? null,
        fromNodeId: from.id,
        toNodeId: to.id,
        coordinates,
        cost,
        status,
        source: edge.source ?? (status === "provisional" ? "osm" : "editor"),
        sourceOsmId: edge.sourceOsmId ?? null,
        unknown: policy.unknown,
        constraints: policy.constraints,
        accessibility: accessibilitySummary(edge),
      }),
    );
    if (!edge.oneWay) {
      adjacency.get(to.id)!.push(
        Object.freeze({
          edgeId: edge.id,
          parentFeatureId: edge.parentFeatureId ?? edge.sourceOsmId ?? edge.id,
          kind: edge.kind,
          note: edge.note ?? null,
          fromNodeId: to.id,
          toNodeId: from.id,
          coordinates: Object.freeze([...coordinates].reverse()),
          cost,
          status,
          source: edge.source ?? (status === "provisional" ? "osm" : "editor"),
          sourceOsmId: edge.sourceOsmId ?? null,
          unknown: policy.unknown,
          constraints: policy.constraints,
          accessibility: accessibilitySummary(edge),
        }),
      );
    }
  }
  for (const arcs of adjacency.values())
    arcs.sort((a, b) => a.edgeId.localeCompare(b.edgeId));
  return Object.freeze({ nodes, edges, adjacency });
}

function accessibilitySummary(edge: RouteEdge) {
  return Object.freeze({
    surface: edge.surface ?? null,
    surfaceCondition: edge.surfaceCondition ?? "unknown",
    stairs: edge.stairs ?? "unknown",
    slopePercent: edge.slopePercent ?? null,
    widthMeters: edge.widthMeters ?? null,
    wheelchairAccess: edge.wheelchairAccess ?? "unknown",
    confidence: edge.confidence ?? "unknown",
  });
}

export interface GraphComponents {
  readonly componentByNodeId: ReadonlyMap<string, number>;
  readonly components: readonly (readonly string[])[];
}

/** Deterministic diagnostics over eligible graph arcs; isolated nodes are their own components. */
export function connectedComponents(graph: RoutingGraph): GraphComponents {
  const componentByNodeId = new Map<string, number>();
  const components: (readonly string[])[] = [];
  const nodeIds = [...graph.nodes.keys()].sort();
  const neighbors = new Map(
    nodeIds.map((nodeId) => [nodeId, new Set<string>()]),
  );
  for (const arcs of graph.adjacency.values()) {
    for (const arc of arcs) {
      // Component diagnostics describe physical graph membership. Direction remains
      // enforced by A*, but must not make the component numbering order-dependent.
      neighbors.get(arc.fromNodeId)!.add(arc.toNodeId);
      neighbors.get(arc.toNodeId)!.add(arc.fromNodeId);
    }
  }
  for (const seed of nodeIds) {
    if (componentByNodeId.has(seed)) continue;
    const index = components.length;
    const members: string[] = [];
    const pending = [seed];
    componentByNodeId.set(seed, index);
    while (pending.length > 0) {
      const current = pending.shift()!;
      members.push(current);
      for (const neighbor of [...(neighbors.get(current) ?? [])].sort()) {
        if (!componentByNodeId.has(neighbor)) {
          componentByNodeId.set(neighbor, index);
          pending.push(neighbor);
        }
      }
    }
    members.sort();
    components.push(Object.freeze(members));
  }
  return Object.freeze({
    componentByNodeId,
    components: Object.freeze(components),
  });
}
