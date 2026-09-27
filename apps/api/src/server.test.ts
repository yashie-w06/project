import assert from "node:assert/strict";
import test from "node:test";
import request from "supertest";
import { createApp } from "./server.js";
import { createEditorToken } from "./auth.js";
import type { Config } from "./config.js";
import type { Database } from "./db.js";

const config: Config = {
  DATABASE_URL: "postgresql://unused",
  EDITOR_EMAIL: "editor@example.com",
  EDITOR_PASSWORD: "testing-password",
  EDITOR_TOKEN_SECRET: "this-is-a-test-secret-with-more-than-32-characters",
  WEB_ORIGIN: "http://localhost:5173",
  PORT: 3001,
  NODE_ENV: "test",
  SNAP_RADIUS_METRES: 25,
};
const db = {
  query: async (sql: string) => ({
    rowCount: sql === "SELECT 1" ? 1 : 0,
    rows: sql.includes("to_regclass") ? [{ ready: true }] : [],
  }),
  connect: async () => {
    throw new Error("not expected");
  },
  end: async () => undefined,
} as unknown as Database;
const app = createApp(config, db);

test("health distinguishes a ready database without exposing configuration", async () => {
  const response = await request(app).get("/api/health");
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { process: "ok", database: "ready" });
  assert.equal(JSON.stringify(response.body).includes("postgresql"), false);
});
test("health reports an unmigrated obstacle schema as unavailable", async () => {
  const unmigratedDb = {
    query: async (sql: string) => ({
      rowCount: 1,
      rows: sql === "SELECT 1" ? [] : [{ ready: false }],
    }),
    connect: async () => {
      throw new Error("not expected");
    },
    end: async () => undefined,
  } as unknown as Database;
  const response = await request(createApp(config, unmigratedDb)).get(
    "/api/health",
  );
  assert.equal(response.status, 503);
  assert.deepEqual(response.body, { process: "ok", database: "unavailable" });
});
test("editor writes reject an anonymous request", async () => {
  const response = await request(app)
    .put("/api/editor/nodes/example")
    .send({ coordinates: [75.87, 22.72], version: 1 });
  assert.equal(response.status, 401);
});
test("public message validation rejects out-of-campus coordinates before persistence", async () => {
  const response = await request(app)
    .post("/api/messages")
    .send({ coordinates: [0, 0], description: "test" });
  assert.equal(response.status, 400);
});

test("public map data loads a valid feature collection and effective network state", async () => {
  const response = await request(app).get("/api/map");
  assert.equal(response.status, 200);
  assert.equal(response.body.buildings.type, "FeatureCollection");
  assert.equal(response.body.paths.type, "FeatureCollection");
  assert.deepEqual(response.body.paths.features, []);
  assert.equal(typeof response.body.revision, "string");
});

test("duplicate editor node rows do not turn a connected OSM route into no-route", async () => {
  const way = {
    id: "candidate-42",
    source_way_id: "42",
    source_node_ids: ["n1", "n2"],
    coordinates: [
      [75.871, 22.726],
      [75.872, 22.726],
    ],
    tags: { highway: "footway" },
    reviewer_decision: null,
    blocked: false,
    version: 1,
  };
  const fixtureDb = {
    query: async (sql: string) => {
      if (sql.includes("FROM route_nodes"))
        return {
          rowCount: 1,
          rows: [{ id: "unrelated-node", longitude: 75.87, latitude: 22.725 }],
        };
      if (sql.includes("FROM osm_candidates"))
        return { rowCount: 1, rows: [way] };
      return { rowCount: 0, rows: [] };
    },
    connect: async () => {
      throw new Error("not expected");
    },
    end: async () => undefined,
  } as unknown as Database;
  const response = await request(createApp(config, fixtureDb))
    .post("/api/route")
    .send({
      profile: "healthy",
      start: { kind: "outdoor", coordinates: [75.871, 22.726] },
      destination: { kind: "outdoor", coordinates: [75.872, 22.726] },
    });
  assert.equal(response.status, 200);
  assert.equal(response.body.status, "ok");
  assert.deepEqual(
    response.body.segments.map((segment: { pathId: string }) => segment.pathId),
    ["osm-42"],
  );
  assert.equal(response.body.geometry.type, "LineString");
  assert.ok(response.body.geometry.coordinates.length >= 2);
});

test("active temporary obstacle removes its OSM path from route snapping", async () => {
  const way = {
    id: "candidate-42",
    source_way_id: "42",
    source_node_ids: ["n1", "n2"],
    coordinates: [
      [75.871, 22.726],
      [75.872, 22.726],
    ],
    tags: { highway: "footway" },
    reviewer_decision: null,
    blocked: false,
    version: 1,
  };
  const fixtureDb = {
    query: async (sql: string) => {
      if (sql.includes("FROM osm_candidates"))
        return { rowCount: 1, rows: [way] };
      if (sql.includes("FROM route_obstacles"))
        return {
          rowCount: 1,
          rows: [
            {
              id: "obstacle-1",
              reason: "Maintenance",
              affected_path_ids: ["osm-42"],
              created_at: "2026-09-27T00:00:00.000Z",
              expires_at: "2026-09-27T01:00:00.000Z",
            },
          ],
        };
      return { rowCount: 0, rows: [] };
    },
    connect: async () => {
      throw new Error("not expected");
    },
    end: async () => undefined,
  } as unknown as Database;
  const response = await request(createApp(config, fixtureDb))
    .post("/api/route")
    .send({
      profile: "healthy",
      start: { kind: "outdoor", coordinates: [75.871, 22.726] },
      destination: { kind: "outdoor", coordinates: [75.872, 22.726] },
    });
  assert.equal(response.status, 200);
  assert.equal(response.body.status, "no_route");
  assert.equal(response.body.code, "BLOCKED_OR_INELIGIBLE");
});

test("route base graph is reused for the same effective network revision", async () => {
  let graphCandidateReads = 0;
  const way = {
    id: "candidate-42",
    source_way_id: "42",
    source_node_ids: ["n1", "n2"],
    coordinates: [
      [75.871, 22.726],
      [75.872, 22.726],
    ],
    tags: { highway: "footway" },
    reviewer_decision: null,
    blocked: false,
    version: 1,
  };
  const fixtureDb = {
    query: async (sql: string) => {
      if (sql.startsWith("SELECT id,source_way_id,source_node_ids")) {
        graphCandidateReads += 1;
        return { rowCount: 1, rows: [way] };
      }
      if (sql.includes("FROM osm_candidates"))
        return {
          rowCount: 1,
          rows: [{ source_way_id: "42", version: 1, blocked: false }],
        };
      return { rowCount: 0, rows: [] };
    },
    connect: async () => {
      throw new Error("not expected");
    },
    end: async () => undefined,
  } as unknown as Database;
  const routeApp = createApp(config, fixtureDb);
  const first = await request(routeApp)
    .post("/api/route")
    .send({
      profile: "healthy",
      start: { kind: "outdoor", coordinates: [75.871, 22.726] },
      destination: { kind: "outdoor", coordinates: [75.872, 22.726] },
    });
  const second = await request(routeApp)
    .post("/api/route")
    .send({
      profile: "healthy",
      start: { kind: "outdoor", coordinates: [75.871, 22.726] },
      destination: { kind: "outdoor", coordinates: [75.872, 22.726] },
    });
  assert.equal(first.body.status, "ok");
  assert.equal(second.body.status, "ok");
  assert.equal(graphCandidateReads, 1);
});

test("graph validation errors are server failures, never disconnected-route results", async () => {
  const fixtureDb = {
    query: async (sql: string) => {
      if (sql.includes("FROM route_nodes"))
        return {
          rowCount: 2,
          rows: [
            {
              id: "conflicting-node",
              longitude: 75.871,
              latitude: 22.726,
            },
            {
              id: "conflicting-node",
              longitude: 75.872,
              latitude: 22.726,
            },
          ],
        };
      return { rowCount: 0, rows: [] };
    },
    connect: async () => {
      throw new Error("not expected");
    },
    end: async () => undefined,
  } as unknown as Database;
  const response = await request(createApp(config, fixtureDb))
    .post("/api/route")
    .send({
      profile: "healthy",
      start: { kind: "outdoor", coordinates: [75.871, 22.726] },
      destination: { kind: "outdoor", coordinates: [75.872, 22.726] },
    });
  assert.equal(response.status, 500);
  assert.notEqual(response.body.status, "no_route");
});
test("bad editor credentials receive 401", async () => {
  const response = await request(app)
    .post("/api/editor/login")
    .send({ email: "editor@example.com", password: "wrong" });
  assert.equal(response.status, 401);
});

test("unlinked buildings use provisional OSM geometry and approximate boundary approaches", async () => {
  const footprint = (west: number, east: number) => ({
    type: "Polygon",
    coordinates: [
      [
        [west, 22.72605],
        [east, 22.72605],
        [east, 22.72615],
        [west, 22.72615],
        [west, 22.72605],
      ],
    ],
  });
  const fixtureDb = {
    query: async (sql: string) => {
      if (sql.includes("FROM osm_candidates"))
        return {
          rowCount: 1,
          rows: [
            {
              id: "osm-path-test",
              source_way_id: "test",
              source_node_ids: ["a", "b"],
              coordinates: [
                [75.871, 22.726],
                [75.872, 22.726],
              ],
              tags: { highway: "service", access: "private" },
              reviewer_decision: null,
            },
          ],
        };
      if (sql.includes("FROM buildings"))
        return {
          rowCount: 2,
          rows: [
            {
              id: "library",
              name: "Library",
              source_osm_id: "library",
              footprint: footprint(75.8711, 75.8712),
              mapped_level_count: 1,
            },
            {
              id: "lt",
              name: "LT",
              source_osm_id: "lt",
              footprint: footprint(75.8718, 75.8719),
              mapped_level_count: 1,
            },
          ],
        };
      return { rowCount: 0, rows: [] };
    },
    connect: async () => {
      throw new Error("not expected");
    },
    end: async () => undefined,
  } as unknown as Database;
  const response = await request(createApp(config, fixtureDb))
    .post("/api/route")
    .send({
      profile: "healthy",
      start: { kind: "building", buildingId: "library", floor: 0 },
      destination: { kind: "building", buildingId: "lt", floor: 0 },
    });
  assert.equal(response.status, 200);
  assert.equal(response.body.status, "ok");
  assert.equal(response.body.approaches.length, 2);
  assert.ok(response.body.segments.length > 0);
  assert.ok(
    response.body.segments.every(
      (segment: { pathId: string; kind: string }) =>
        Boolean(segment.pathId) && segment.kind === "main",
    ),
  );
  assert.ok(response.body.notices.includes("Building approach."));
  assert.deepEqual(
    response.body.geometry.coordinates[0],
    response.body.approaches[0].boundary,
  );
  assert.deepEqual(
    response.body.geometry.coordinates.at(-1),
    response.body.approaches[1].boundary,
  );
});

test("shortcut creation validates both snaps and persists durable parent connections", async () => {
  const calls: string[] = [];
  const candidate = {
    id: "candidate-42",
    source_way_id: "42",
    source_node_ids: ["n1", "n2"],
    coordinates: [
      [75.871, 22.726],
      [75.872, 22.726],
    ],
    tags: { highway: "footway" },
    version: 1,
  };
  const fixtureDb = {
    query: async (sql: string) => {
      if (sql.includes("FROM osm_candidates"))
        return { rowCount: 1, rows: [candidate] };
      return { rowCount: 0, rows: [] };
    },
    connect: async () => ({
      query: async (sql: string) => {
        calls.push(sql);
        if (sql.includes("SELECT version FROM route_edges"))
          return { rowCount: 0, rows: [] };
        if (sql.includes("SELECT version FROM osm_candidates"))
          return { rowCount: 1, rows: [{ version: 1 }] };
        return { rowCount: 1, rows: [] };
      },
      release: () => undefined,
    }),
    end: async () => undefined,
  } as unknown as Database;
  const token = await createEditorToken(config);
  const response = await request(createApp(config, fixtureDb))
    .post("/api/editor/paths")
    .set("Authorization", `Bearer ${token}`)
    .send({
      id: "123e4567-e89b-42d3-a456-426614174000",
      coordinates: [
        [75.871, 22.726],
        [75.8715, 22.7262],
        [75.872, 22.726],
      ],
      endpoints: [
        { parentId: "osm-42", coordinates: [75.871, 22.726], parentVersion: 1 },
        { parentId: "osm-42", coordinates: [75.872, 22.726], parentVersion: 1 },
      ],
    });
  assert.equal(response.status, 201);
  assert.equal(
    calls.filter((sql) => sql.includes("INSERT INTO path_snap_connections"))
      .length,
    2,
  );
  assert.ok(
    calls.findIndex((sql) => sql.includes("INSERT INTO route_edges")) <
      calls.findIndex((sql) =>
        sql.includes("INSERT INTO path_snap_connections"),
      ),
  );
});

test("editor publishes an expiring obstacle only for an existing stable path id", async () => {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const fixtureDb = {
    query: async (sql: string, values?: unknown[]) => {
      calls.push({ sql, values });
      if (sql.includes("FROM osm_candidates"))
        return {
          rowCount: 1,
          rows: [
            {
              id: "candidate-42",
              source_way_id: "42",
              source_node_ids: ["n1", "n2"],
              coordinates: [
                [75.871, 22.726],
                [75.872, 22.726],
              ],
              tags: { highway: "footway" },
              reviewer_decision: null,
              blocked: false,
              note: null,
              version: 1,
            },
          ],
        };
      if (sql.includes("INSERT INTO route_obstacles"))
        return {
          rowCount: 1,
          rows: [
            {
              id: "temporary-1",
              reason: "Path maintenance",
              affected_path_ids: values?.[2],
              expires_at: "2026-09-27T02:00:00.000Z",
            },
          ],
        };
      return { rowCount: 0, rows: [] };
    },
    connect: async () => {
      throw new Error("not expected");
    },
    end: async () => undefined,
  } as unknown as Database;
  const token = await createEditorToken(config);
  const response = await request(createApp(config, fixtureDb))
    .post("/api/editor/obstacles")
    .set("Authorization", `Bearer ${token}`)
    .send({
      reason: "Path maintenance",
      affectedPathIds: ["osm-42"],
      expiresInMinutes: 120,
    });
  assert.equal(response.status, 201);
  assert.deepEqual(response.body.affected_path_ids, ["osm-42"]);
  const insert = calls.find((call) =>
    call.sql.includes("INSERT INTO route_obstacles"),
  );
  assert.ok(insert);
  assert.deepEqual(insert.values?.slice(1, 4), [
    "Path maintenance",
    ["osm-42"],
    120,
  ]);
});
