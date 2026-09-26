import "dotenv/config";
import pg from "pg";

const db = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15_000,
});
const rows = async (sql: string) => (await db.query(sql)).rows;
try {
  const state = {
    counts: (
      await rows(`SELECT
      (SELECT count(*)::int FROM buildings) buildings,
      (SELECT count(*)::int FROM osm_candidates) candidates,
      (SELECT count(*)::int FROM osm_candidates WHERE provisional_eligible) provisional_candidates,
      (SELECT count(*)::int FROM osm_candidates WHERE NOT provisional_eligible) excluded_candidates,
      (SELECT count(*)::int FROM route_nodes) nodes,
      (SELECT count(*)::int FROM route_edges) edges,
      (SELECT count(*)::int FROM outdoor_points) points,
      (SELECT count(*)::int FROM floors) floors,
      (SELECT count(*)::int FROM floor_features) features,
      (SELECT count(*)::int FROM messages) messages,
      (SELECT count(*)::int FROM alerts WHERE active) active_alerts`)
    )[0],
    candidateDecisions: await rows(
      `SELECT COALESCE(reviewer_decision,'pending') decision,count(*)::int FROM osm_candidates GROUP BY 1 ORDER BY 1`,
    ),
    edgeStates: await rows(
      `SELECT kind,verified,published,blocked,count(*)::int FROM route_edges GROUP BY 1,2,3,4 ORDER BY 1,2,3,4`,
    ),
    edgeDetails: await rows(
      `SELECT id,from_node_id,to_node_id,kind,verified,published,blocked,source_osm_id,jsonb_array_length(coordinates) vertices FROM route_edges ORDER BY id`,
    ),
    orphanNodes: await rows(
      `SELECT n.id FROM route_nodes n WHERE NOT EXISTS (SELECT 1 FROM route_edges e WHERE e.from_node_id=n.id OR e.to_node_id=n.id) ORDER BY n.id`,
    ),
    reviewedCandidates: await rows(
      `SELECT source_way_id,reviewer_decision,provisional_eligible,provisional_exclusion_reason FROM osm_candidates WHERE reviewer_decision IS NOT NULL ORDER BY source_way_id`,
    ),
    floorStates: await rows(
      `SELECT status,count(*)::int FROM floors GROUP BY status ORDER BY status`,
    ),
    exitLinks: (
      await rows(
        `SELECT count(*)::int exits,count(*) FILTER(WHERE linked_graph_node_id IS NOT NULL)::int linked FROM floor_features WHERE kind='door' AND is_exit`,
      )
    )[0],
  };
  console.log(JSON.stringify(state, null, 2));
} finally {
  await db.end();
}
