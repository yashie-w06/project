import "dotenv/config";
import request from "supertest";
import { loadConfig } from "../src/config.js";
import { createDatabase } from "../src/db.js";
import { createApp } from "../src/server.js";

const config = loadConfig();
const db = createDatabase(config);
try {
  const schema = await db.query(
    `SELECT to_regclass('public.route_obstacles') AS obstacle_table,
      to_regclass('public.path_snap_connections') AS snap_table,
      (SELECT array_agg(filename ORDER BY filename) FROM schema_migrations) AS migrations`,
  );
  const map = await request(createApp(config, db)).get("/api/map");
  const buildings = await db.query(
    "SELECT id,name FROM buildings WHERE name=ANY($1::text[]) ORDER BY name",
    [["Central Library", "LT"]],
  );
  const byName = new Map(buildings.rows.map((row) => [row.name, row.id]));
  const route = await request(createApp(config, db))
    .post("/api/route")
    .send({
      profile: "healthy",
      start: { kind: "building", buildingId: byName.get("Central Library") },
      destination: { kind: "building", buildingId: byName.get("LT") },
    });
  const connectedPath = map.body.paths?.features?.find(
    (feature: { id: string }) => feature.id === "osm-202920189",
  );
  const connectedRoute = connectedPath
    ? await request(createApp(config, db))
        .post("/api/route")
        .send({
          profile: "healthy",
          start: {
            kind: "outdoor",
            coordinates: connectedPath.geometry.coordinates[0],
          },
          destination: {
            kind: "outdoor",
            coordinates: connectedPath.geometry.coordinates.at(-1),
          },
        })
    : undefined;
  console.log(
    JSON.stringify(
      {
        schema: schema.rows[0],
        map: {
          status: map.status,
          contentType: map.headers["content-type"],
          featureCounts:
            map.status === 200
              ? {
                  buildings: map.body.buildings?.features?.length,
                  paths: map.body.paths?.features?.length,
                  points: map.body.points?.features?.length,
                }
              : map.body,
        },
        centralLibraryToLt: { status: route.status, body: route.body },
        connectedCampusPath: connectedRoute
          ? { status: connectedRoute.status, body: connectedRoute.body }
          : { status: "missing-map-feature", id: "osm-202920189" },
      },
      null,
      2,
    ),
  );
} finally {
  await db.end();
}
