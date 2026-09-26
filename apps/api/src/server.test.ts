import assert from "node:assert/strict";
import test from "node:test";
import request from "supertest";
import { createApp } from "./server.js";
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
  assert.equal(response.body.containsProvisional, true);
  assert.equal(response.body.approaches.length, 2);
  assert.ok(
    response.body.segments.some(
      (segment: { source: string }) => segment.source === "osm",
    ),
  );
  assert.deepEqual(
    response.body.geometry.coordinates[0],
    response.body.approaches[0].boundary,
  );
  assert.deepEqual(
    response.body.geometry.coordinates.at(-1),
    response.body.approaches[1].boundary,
  );
});
