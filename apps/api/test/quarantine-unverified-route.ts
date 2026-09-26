import "dotenv/config";
import pg from "pg";

const db = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15_000,
});

const sourceWayId = "995119335";
const edgeId = `osm-${sourceWayId}`;
const client = await db.connect();
try {
  await client.query("BEGIN");
  const edge = await client.query(
    "SELECT id,source_osm_id,verified,published FROM route_edges WHERE id=$1 FOR UPDATE",
    [edgeId],
  );
  const candidate = await client.query(
    "SELECT id,source_way_id,reviewer_decision FROM osm_candidates WHERE source_way_id=$1 FOR UPDATE",
    [sourceWayId],
  );
  if (
    edge.rowCount !== 1 ||
    candidate.rowCount !== 1 ||
    edge.rows[0].source_osm_id !== sourceWayId
  ) {
    throw new Error(
      "Expected imported route/candidate pair was not found; no changes applied",
    );
  }
  await client.query(
    "UPDATE route_edges SET verified=false,published=false,version=version+1 WHERE id=$1",
    [edgeId],
  );
  await client.query(
    "UPDATE osm_candidates SET reviewer_decision='needs_edit',import_status='reviewed',version=version+1,updated_at=now() WHERE source_way_id=$1",
    [sourceWayId],
  );
  await client.query("COMMIT");
  console.log(
    "Quarantined the known unverified imported route; geometry was preserved as draft/reference data.",
  );
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await db.end();
}
