import "dotenv/config";
import assert from "node:assert/strict";
import request from "supertest";
import { loadConfig } from "../src/config.js";
import { createDatabase } from "../src/db.js";
import { createApp } from "../src/server.js";

const config = loadConfig();
const db = createDatabase(config);
try {
  const buildings = await db.query(
    "SELECT id,name FROM buildings WHERE name=ANY($1::text[]) ORDER BY name",
    [["Central Library", "LT"]],
  );
  assert.equal(buildings.rowCount, 2, "Central Library and LT must be mapped");
  const byName = new Map(buildings.rows.map((row) => [row.name, row.id]));
  const response = await request(createApp(config, db))
    .post("/api/route")
    .send({
      profile: "healthy",
      start: {
        kind: "building",
        buildingId: byName.get("Central Library"),
        floor: 0,
      },
      destination: { kind: "building", buildingId: byName.get("LT"), floor: 0 },
    });
  console.log(
    JSON.stringify(
      { statusCode: response.status, body: response.body },
      null,
      2,
    ),
  );
} finally {
  await db.end();
}
