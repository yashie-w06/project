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
  const [paths, candidates, obstacles] = await Promise.all([
    db.query("SELECT id,version,blocked FROM route_edges ORDER BY id"),
    db.query("SELECT source_way_id,version,blocked FROM osm_candidates ORDER BY source_way_id"),
    db.query("SELECT id,reason,affected_path_ids,created_at,expires_at FROM route_obstacles WHERE deactivated_at IS NULL AND (expires_at IS NULL OR expires_at > now()) ORDER BY id"),
  ]);
  const revision = createHash("sha256").update(JSON.stringify({
    paths: paths.rows.map((row) => [row.id, row.version, row.blocked]),
    candidates: candidates.rows.map((row) => [row.source_way_id, row.version, row.blocked]),
    obstacles: obstacles.rows.map((row) => [row.id, row.affected_path_ids, row.expires_at]),
  })).digest("hex").slice(0, 24);
  return { revision, obstacles: obstacles.rows as EffectiveObstacle[] };
}
