import assert from "node:assert/strict";
import test from "node:test";
import type { Database } from "./db.js";
import { loadEffectiveNetworkState } from "./obstacles.js";

function database(activeObstacles: Array<Record<string, unknown>>) {
  const calls: string[] = [];
  const db = {
    query: async (sql: string) => {
      calls.push(sql);
      if (sql.includes("FROM route_edges"))
        return {
          rowCount: 1,
          rows: [
            {
              id: "manual-path",
              source_osm_id: null,
              version: 3,
              blocked: true,
            },
          ],
        };
      if (sql.includes("FROM osm_candidates"))
        return {
          rowCount: 1,
          rows: [{ source_way_id: "42", version: 7, blocked: false }],
        };
      if (sql.includes("FROM route_obstacles"))
        return { rowCount: activeObstacles.length, rows: activeObstacles };
      if (
        sql.includes("FROM route_nodes") ||
        sql.includes("FROM path_snap_connections") ||
        sql.includes("FROM buildings")
      )
        return { rowCount: 0, rows: [] };
      throw new Error("Unexpected query");
    },
  } as unknown as Database;
  return { db, calls };
}

test("effective network state merges manual and active temporary blocks", async () => {
  const active = database([
    {
      id: "obstacle-1",
      reason: "Maintenance",
      affected_path_ids: ["osm-42"],
      created_at: "2026-09-27T00:00:00.000Z",
      expires_at: "2026-09-27T01:00:00.000Z",
    },
  ]);
  const state = await loadEffectiveNetworkState(active.db);
  assert.deepEqual(state.blockedPathIds, ["manual-path", "osm-42"]);
  assert.equal(state.obstacles.length, 1);
  assert.ok(active.calls.some((sql) => sql.includes("expires_at > now()")));

  const expired = database([]);
  const afterExpiry = await loadEffectiveNetworkState(expired.db);
  assert.deepEqual(afterExpiry.blockedPathIds, ["manual-path"]);
  assert.notEqual(state.revision, afterExpiry.revision);
});

test("unrelated obstacle revisions preserve the current route path set", async () => {
  const state = database([
    {
      id: "other-obstacle",
      reason: "Closed",
      affected_path_ids: ["unrelated-path"],
      created_at: "2026-09-27T00:00:00.000Z",
      expires_at: null,
    },
  ]);
  const current = await loadEffectiveNetworkState(state.db);
  assert.equal(current.blockedPathIds.includes("route-path"), false);
  assert.equal(current.blockedPathIds.includes("unrelated-path"), true);
});
