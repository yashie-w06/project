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
    rows: [],
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
