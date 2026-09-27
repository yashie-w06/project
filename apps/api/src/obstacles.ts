import { createHash } from "node:crypto";
import type { Database } from "./db.js";

export interface EffectiveObstacle {
  id: string;
  reason: string;
  affected_path_ids: string[];
  expires_at: string | null;
  created_at: string;
}

export async function loadEffectiveNetworkState(db: Database) {
  const [paths, candidates, obstacles, nodes, junctions, buildings] =
    await Promise.all([
      db.query(
        "SELECT id,source_osm_id,version,blocked FROM route_edges ORDER BY id",
      ),
      db.query(
        "SELECT source_way_id,version,blocked FROM osm_candidates ORDER BY source_way_id",
      ),
      db.query(
        "SELECT id,reason,affected_path_ids,created_at,expires_at FROM route_obstacles WHERE deactivated_at IS NULL AND (expires_at IS NULL OR expires_at > now()) ORDER BY id",
      ),
      db.query(
        "SELECT id,longitude,latitude,version FROM route_nodes ORDER BY id",
      ),
      db.query(
        "SELECT shortcut_path_id,endpoint_index,parent_feature_id,parent_source,parent_version,parent_segment_index,parent_segment_fraction,junction_node_id,coordinates FROM path_snap_connections ORDER BY shortcut_path_id,endpoint_index",
      ),
      db.query(
        "SELECT id,source_osm_id,footprint,mapped_level_count FROM buildings ORDER BY id",
      ),
    ]);
  const revision = createHash("sha256")
    .update(
      JSON.stringify({
        paths: paths.rows.map((row) => [row.id, row.version, row.blocked]),
        candidates: candidates.rows.map((row) => [
          row.source_way_id,
          row.version,
          row.blocked,
        ]),
        obstacles: obstacles.rows.map((row) => [
          row.id,
          row.affected_path_ids,
          row.expires_at,
        ]),
        nodes: nodes.rows.map((row) => [
          row.id,
          row.longitude,
          row.latitude,
          row.version,
        ]),
        junctions: junctions.rows.map((row) => [
          row.shortcut_path_id,
          row.endpoint_index,
          row.parent_feature_id,
          row.parent_source,
          row.parent_version,
          row.parent_segment_index,
          row.parent_segment_fraction,
          row.junction_node_id,
          row.coordinates,
        ]),
        buildings: buildings.rows.map((row) => [
          row.id,
          row.source_osm_id,
          row.footprint,
          row.mapped_level_count,
        ]),
      }),
    )
    .digest("hex")
    .slice(0, 24);
  const blockedPathIds = new Set<string>();
  for (const row of paths.rows) {
    if (!row.blocked) continue;
    blockedPathIds.add(row.source_osm_id ? `osm-${row.source_osm_id}` : row.id);
  }
  for (const row of candidates.rows) {
    if (row.blocked) blockedPathIds.add(`osm-${row.source_way_id}`);
  }
  for (const obstacle of obstacles.rows as EffectiveObstacle[])
    for (const pathId of obstacle.affected_path_ids) blockedPathIds.add(pathId);
  return {
    revision,
    obstacles: obstacles.rows as EffectiveObstacle[],
    blockedPathIds: [...blockedPathIds].sort(),
  };
}
