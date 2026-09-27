import "dotenv/config";
import { loadConfig } from "../src/config.js";
import { createDatabase } from "../src/db.js";
import { buildProvisionalOsmGraph } from "../src/osm/provisional.js";
import type { OsmPathCandidate } from "../src/osm/types.js";

const db = createDatabase(loadConfig());
try {
  const [candidateRows, buildingRows, edgeCounts] = await Promise.all([
    db.query("SELECT id,source_way_id,source_node_ids,coordinates,tags,reviewer_decision,provisional_eligible,provisional_exclusion_reason,blocked,note,version FROM osm_candidates ORDER BY source_way_id"),
    db.query("SELECT id,name,source_osm_id,footprint,mapped_level_count FROM buildings ORDER BY name"),
    db.query("SELECT count(*)::int AS count FROM route_edges"),
  ]);
  const candidates: OsmPathCandidate[] = candidateRows.rows.map((row) => ({
    id: row.id, sourceWayId: row.source_way_id, orderedNodeIds: row.source_node_ids,
    coordinates: row.coordinates, tags: row.tags ?? {}, barrierNodeIds: row.provisional_exclusion_reason === "blocked_by_barrier" ? ["barrier"] : [],
    importStatus: "imported", reviewerDecision: row.reviewer_decision ?? "pending", blocked: row.blocked, note: row.note, version: row.version,
    geometry: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: row.coordinates } },
  }));
  const buildings = buildingRows.rows.map((row) => ({ id: row.id, sourceWayId: row.source_osm_id ?? row.id, name: row.name, levels: row.mapped_level_count, footprint: { type: "Feature" as const, id: row.id, properties: {}, geometry: row.footprint } }));
  const graph = buildProvisionalOsmGraph({ candidates, buildings });
  const parent = new Map<string, string>();
  const find = (id: string): string => { const p = parent.get(id) ?? id; if (p === id) return id; const root = find(p); parent.set(id, root); return root; };
  for (const edge of graph.edges) { parent.set(edge.fromNodeId, edge.fromNodeId); parent.set(edge.toNodeId, edge.toNodeId); parent.set(find(edge.fromNodeId), find(edge.toNodeId)); }
  const targetIds = new Set(["202920189", "202920186"]);
  const relevantWays = candidates.filter((candidate) => targetIds.has(candidate.sourceWayId) || candidate.sourceWayId.startsWith("202920"));
  console.log(JSON.stringify({ buildings: buildingRows.rows.filter((row) => ["Central Library", "LT"].includes(row.name)).map(({ id, name }) => ({ id, name })), routeEdgeCount: edgeCounts.rows[0].count, graphNodeCount: graph.nodes.length, graphEdgeCount: graph.edges.length, components: new Set(graph.edges.map((edge) => find(edge.fromNodeId))).size, ways: relevantWays.map(({ sourceWayId, orderedNodeIds, coordinates, tags, reviewerDecision, blocked, provisional_eligible, provisional_exclusion_reason }) => ({ wayId: sourceWayId, nodes: orderedNodeIds, coordinates, tags, reviewerDecision, blocked, legacyEligible: provisional_eligible, legacyReason: provisional_exclusion_reason, graphComponents: graph.edges.filter((edge) => edge.sourceOsmId === sourceWayId).map((edge) => find(edge.fromNodeId)) })), excluded: graph.excluded.filter((way) => targetIds.has(way.sourceWayId)), componentsForTargetEdges: graph.edges.filter((edge) => targetIds.has(edge.sourceOsmId ?? "")).map((edge) => ({ wayId: edge.sourceOsmId, from: edge.fromNodeId, to: edge.toNodeId, component: find(edge.fromNodeId) })) }, null, 2));
} finally { await db.end(); }
