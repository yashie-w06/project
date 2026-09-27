import type { LineString } from "geojson";
import type { LonLat } from "../osm/types.js";
import { createLocalProjection, distanceMetres } from "./projection.js";
import type { GraphArc, RoutingGraph } from "./graph.js";

export interface RouteResult {
  readonly nodeIds: readonly string[];
  readonly edgeIds: readonly string[];
  readonly geometry: Readonly<LineString>;
  readonly internalCostMetres: number;
  readonly segments: readonly RouteSegment[];
}

export interface RouteSegment {
  readonly edgeId: string;
  readonly pathId: string;
  readonly kind: "main" | "shortcut";
  readonly note: string | null;
  readonly status: "confirmed" | "provisional";
  readonly source: "editor" | "osm" | "query";
  readonly sourceOsmId: string | null;
  readonly unknown: readonly string[];
  readonly constraints: readonly string[];
  readonly accessibility: GraphArc["accessibility"];
  readonly geometry: Readonly<LineString>;
}

function reconstruct(
  graph: RoutingGraph,
  startId: string,
  goalId: string,
  cameFrom: ReadonlyMap<string, { nodeId: string; arc: GraphArc }>,
  cost: number,
): RouteResult {
  const reversedArcs: GraphArc[] = [];
  const reversedNodes = [goalId];
  let current = goalId;
  while (current !== startId) {
    const previous = cameFrom.get(current);
    if (!previous) throw new Error("Broken A* predecessor chain");
    reversedArcs.push(previous.arc);
    current = previous.nodeId;
    reversedNodes.push(current);
  }
  const arcs = reversedArcs.reverse();
  const coordinates: LonLat[] = [];
  for (const arc of arcs) {
    if (coordinates.length > 0) {
      const previous = coordinates.at(-1)!;
      const next = arc.coordinates[0]!;
      if (previous[0] !== next[0] || previous[1] !== next[1]) {
        throw new Error(
          `Discontinuous route geometry at node ${arc.fromNodeId}`,
        );
      }
    }
    coordinates.push(
      ...(coordinates.length === 0
        ? arc.coordinates
        : arc.coordinates.slice(1)),
    );
  }
  if (coordinates.length === 0)
    coordinates.push(graph.nodes.get(startId)!.coordinates);
  return Object.freeze({
    nodeIds: Object.freeze(reversedNodes.reverse()),
    edgeIds: Object.freeze(arcs.map((arc) => arc.edgeId)),
    geometry: Object.freeze({
      type: "LineString",
      coordinates: coordinates.map(([longitude, latitude]) => [
        longitude,
        latitude,
      ]),
    }),
    internalCostMetres: cost,
    segments: Object.freeze(
      arcs.map((arc) =>
        Object.freeze({
          edgeId: arc.edgeId,
          pathId: arc.parentFeatureId,
          kind: arc.kind,
          note: arc.note,
          status: arc.status,
          source: arc.source,
          sourceOsmId: arc.sourceOsmId,
          unknown: arc.unknown,
          constraints: arc.constraints,
          accessibility: arc.accessibility,
          geometry: Object.freeze({
            type: "LineString" as const,
            coordinates: arc.coordinates.map(([longitude, latitude]) => [
              longitude,
              latitude,
            ]),
          }),
        }),
      ),
    ),
  });
}

export function findRoute(
  graph: RoutingGraph,
  startId: string,
  goalId: string,
): RouteResult | null {
  const start = graph.nodes.get(startId);
  const goal = graph.nodes.get(goalId);
  if (!start || !goal) return null;
  const projection = createLocalProjection(goal.coordinates);
  const heuristic = (nodeId: string): number =>
    distanceMetres(
      graph.nodes.get(nodeId)!.coordinates,
      goal.coordinates,
      projection,
    );
  const open = new Set([startId]);
  const cameFrom = new Map<string, { nodeId: string; arc: GraphArc }>();
  const gScore = new Map<string, number>([[startId, 0]]);
  const fScore = new Map<string, number>([[startId, heuristic(startId)]]);

  while (open.size > 0) {
    const current = [...open].sort((a, b) => {
      const difference =
        (fScore.get(a) ?? Infinity) - (fScore.get(b) ?? Infinity);
      return difference || a.localeCompare(b);
    })[0]!;
    if (current === goalId)
      return reconstruct(
        graph,
        startId,
        goalId,
        cameFrom,
        gScore.get(current)!,
      );
    open.delete(current);
    for (const arc of graph.adjacency.get(current) ?? []) {
      const tentative = gScore.get(current)! + arc.cost;
      if (tentative < (gScore.get(arc.toNodeId) ?? Infinity)) {
        cameFrom.set(arc.toNodeId, { nodeId: current, arc });
        gScore.set(arc.toNodeId, tentative);
        fScore.set(arc.toNodeId, tentative + heuristic(arc.toNodeId));
        open.add(arc.toNodeId);
      }
    }
  }
  return null;
}
