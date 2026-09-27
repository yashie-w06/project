import type { LonLat } from "../osm/types.js";
import type { RouteEdge, RouteNode } from "./types.js";

export type SavedPathJunction = {
  readonly parentFeatureId: string;
  readonly parentSegmentIndex: number;
  readonly parentSegmentFraction: number;
  readonly junctionNodeId: string;
  readonly coordinates: LonLat;
};

/** Derive connected arcs from stable parent features and durable snap records. */
export function splitEdgesAtSavedJunctions(
  edges: readonly RouteEdge[],
  nodes: readonly RouteNode[],
  junctions: readonly SavedPathJunction[],
): { nodes: RouteNode[]; edges: RouteEdge[] } {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const junctionsByParent = new Map<string, SavedPathJunction[]>();
  for (const junction of junctions) {
    const current = junctionsByParent.get(junction.parentFeatureId) ?? [];
    current.push(junction);
    junctionsByParent.set(junction.parentFeatureId, current);
    if (!nodeById.has(junction.junctionNodeId)) {
      const node = {
        id: junction.junctionNodeId,
        coordinates: junction.coordinates,
      };
      nodeById.set(node.id, node);
    }
  }
  const result: RouteEdge[] = [];
  for (const edge of edges) {
    const parentId = edge.parentFeatureId ?? edge.id;
    const cuts = (junctionsByParent.get(parentId) ?? [])
      .filter((cut) => cut.parentSegmentIndex < edge.coordinates.length - 1)
      .map((cut) => ({
        ...cut,
        position: cut.parentSegmentIndex + cut.parentSegmentFraction,
      }))
      .sort((a, b) => a.position - b.position);
    if (!cuts.length) {
      result.push(edge);
      continue;
    }
    const fromNode = nodeById.get(edge.fromNodeId);
    const toNode = nodeById.get(edge.toNodeId);
    if (!fromNode || !toNode) {
      result.push(edge);
      continue;
    }
    const endPosition = edge.coordinates.length - 1;
    const startCut = cuts.find((cut) => cut.position <= 1e-9);
    const endCut = cuts.find((cut) => cut.position >= endPosition - 1e-9);
    const anchors = [
      {
        position: 0,
        nodeId: startCut?.junctionNodeId ?? fromNode.id,
        coordinates: startCut?.coordinates ?? edge.coordinates[0]!,
      },
      ...cuts
        .filter(
          (cut) => cut.position > 1e-9 && cut.position < endPosition - 1e-9,
        )
        .map((cut) => ({
          position: cut.position,
          nodeId: cut.junctionNodeId,
          coordinates: cut.coordinates,
        })),
      {
        position: endPosition,
        nodeId: endCut?.junctionNodeId ?? toNode.id,
        coordinates: endCut?.coordinates ?? edge.coordinates.at(-1)!,
      },
    ].filter(
      (anchor, index, all) =>
        index === 0 ||
        (anchor.position > all[index - 1]!.position + 1e-9 &&
          anchor.nodeId !== all[index - 1]!.nodeId),
    );
    for (let index = 0; index < anchors.length - 1; index++) {
      const from = anchors[index]!;
      const to = anchors[index + 1]!;
      const coordinates: LonLat[] = [from.coordinates];
      for (
        let vertex = Math.floor(from.position) + 1;
        vertex < to.position;
        vertex++
      )
        coordinates.push(edge.coordinates[vertex]!);
      if (!same(coordinates.at(-1), to.coordinates))
        coordinates.push(to.coordinates);
      if (coordinates.length < 2 || from.nodeId === to.nodeId) continue;
      result.push({
        ...edge,
        id: `derived:${parentId}:${index}`,
        parentFeatureId: parentId,
        fromNodeId: from.nodeId,
        toNodeId: to.nodeId,
        coordinates,
      });
    }
  }
  return { nodes: [...nodeById.values()], edges: result };
}

function same(a: LonLat | undefined, b: LonLat): boolean {
  return Boolean(a && a[0] === b[0] && a[1] === b[1]);
}
