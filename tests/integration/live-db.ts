import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { loadConfig } from "../../apps/api/src/config.js";
import { createDatabase } from "../../apps/api/src/db.js";
import { createApp } from "../../apps/api/src/server.js";

const prefix = `integration-${Date.now()}`;
const nodeA = `${prefix}-a`,
  nodeB = `${prefix}-b`,
  nodeC = `${prefix}-c`;
const mainAB = `${prefix}-main-ab`,
  mainBC = `${prefix}-main-bc`,
  shortcut = randomUUID();
const pointId = `${prefix}-point`;
const floorId = `${prefix}-floor`;
const messageText = `${prefix} visitor message`;
const a: [number, number] = [75.8671, 22.7221],
  b: [number, number] = [75.8672, 22.7221],
  c: [number, number] = [75.8673, 22.7221];
const config = loadConfig();
let db = createDatabase(config);
let alertId: string | undefined;
async function cleanup() {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    if (alertId)
      await client.query("DELETE FROM alerts WHERE id=$1", [alertId]);
    await client.query("DELETE FROM messages WHERE description=$1", [
      messageText,
    ]);
    await client.query("DELETE FROM floors WHERE id=$1", [floorId]);
    await client.query("DELETE FROM outdoor_points WHERE id=$1", [pointId]);
    await client.query("DELETE FROM route_edges WHERE id=ANY($1::text[])", [
      [mainAB, mainBC, shortcut],
    ]);
    await client.query("DELETE FROM route_nodes WHERE id=ANY($1::text[])", [
      [nodeA, nodeB, nodeC],
    ]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

try {
  await cleanup();
  const counts = await db.query(
    "SELECT (SELECT count(*)::int FROM buildings) buildings,(SELECT count(*)::int FROM osm_candidates) candidates",
  );
  assert.equal(counts.rows[0].buildings, 49);
  assert.equal(counts.rows[0].candidates, 15);
  const campusBuildings = await db.query(
    "SELECT id,name FROM buildings WHERE name=ANY($1::text[])",
    [["Central Library", "LT"]],
  );
  assert.equal(campusBuildings.rowCount, 2);
  const campusBuildingId = new Map(
    campusBuildings.rows.map((row) => [row.name as string, row.id as string]),
  );
  const provisionalCampusRoute = await request(createApp(config, db))
    .post("/api/route")
    .send({
      profile: "healthy",
      start: {
        kind: "building",
        buildingId: campusBuildingId.get("Central Library"),
        floor: 0,
      },
      destination: {
        kind: "building",
        buildingId: campusBuildingId.get("LT"),
        floor: 0,
      },
    });
  assert.equal(provisionalCampusRoute.body.status, "no_route");
  assert.equal(provisionalCampusRoute.body.code, "DIFFERENT_COMPONENTS");
  assert.equal(provisionalCampusRoute.body.approaches, undefined);
  assert.match(provisionalCampusRoute.body.message, /do not connect/);
  await db.query(
    "INSERT INTO route_nodes(id,longitude,latitude) VALUES($1,$2,$3),($4,$5,$6),($7,$8,$9)",
    [nodeA, ...a, nodeB, ...b, nodeC, ...c],
  );
  await db.query(
    `INSERT INTO route_edges(id,from_node_id,to_node_id,coordinates,kind,verified,published) VALUES
    ($1,$2,$3,$4,'main',true,true),($5,$3,$6,$7,'main',true,true)`,
    [
      mainAB,
      nodeA,
      nodeB,
      JSON.stringify([a, b]),
      mainBC,
      nodeC,
      JSON.stringify([b, c]),
    ],
  );
  let app = createApp(config, db);
  assert.equal((await request(app).get("/api/health")).status, 200);
  assert.equal(
    (
      await request(app)
        .put(`/api/editor/nodes/${prefix}-anonymous`)
        .send({ coordinates: a, version: 1 })
    ).status,
    401,
  );
  const login = await request(app)
    .post("/api/editor/login")
    .send({ email: config.EDITOR_EMAIL, password: config.EDITOR_PASSWORD });
  assert.equal(login.status, 200);
  const token = login.body.token as string;
  const auth = { Authorization: `Bearer ${token}` };
  const createdShortcut = await request(app)
    .post("/api/editor/paths")
    .set(auth)
    .send({
      id: shortcut,
      coordinates: [a, c],
      endpoints: [
        { parentId: mainAB, coordinates: a, parentVersion: 1 },
        { parentId: mainBC, coordinates: c, parentVersion: 1 },
      ],
    });
  assert.equal(
    createdShortcut.status,
    201,
    JSON.stringify(createdShortcut.body),
  );
  const persistedShortcut = await db.query(
    "SELECT e.id,e.from_node_id,e.to_node_id,e.coordinates,s.parent_feature_id,s.parent_source,s.parent_version,s.junction_node_id FROM route_edges e LEFT JOIN path_snap_connections s ON s.shortcut_path_id=e.id WHERE e.id=$1 ORDER BY s.endpoint_index",
    [shortcut],
  );
  assert.equal(persistedShortcut.rowCount, 2);
  assert.ok(persistedShortcut.rows.every((row) => row.parent_version === 1));
  const message = await request(app)
    .post("/api/messages")
    .send({ coordinates: b, description: messageText });
  assert.equal(message.status, 201);
  const listed = await request(app).get("/api/editor/messages").set(auth);
  const savedMessage = listed.body.messages.find(
    (entry: { description: string }) => entry.description === messageText,
  );
  assert.ok(savedMessage);
  assert.equal(
    (
      await request(app)
        .delete(`/api/editor/messages/${savedMessage.id}`)
        .set(auth)
    ).status,
    204,
  );
  const alert = await request(app)
    .post("/api/editor/alerts")
    .set(auth)
    .send({
      coordinates: b,
      description: "Integration-only block",
      edgeIds: [shortcut],
    });
  assert.equal(alert.status, 201);
  alertId = alert.body.id;
  const blockedShortcut = await request(app)
    .patch(`/api/editor/paths/${shortcut}`)
    .set(auth)
    .send({ blocked: true, version: 1 });
  assert.equal(blockedShortcut.status, 200);
  assert.equal(blockedShortcut.body.blocked, true);
  const unblockedShortcut = await request(app)
    .patch(`/api/editor/paths/${shortcut}`)
    .set(auth)
    .send({ blocked: false, version: 2 });
  assert.equal(unblockedShortcut.status, 200);
  assert.equal(unblockedShortcut.body.blocked, false);
  const point = await request(app)
    .put(`/api/editor/points/${pointId}`)
    .set(auth)
    .send({
      name: "Integration point",
      coordinates: b,
      note: "Informational campus point",
      version: 1,
    });
  assert.equal(point.status, 200);
  assert.equal(point.body.description, "Informational campus point");
  const building = (
    await db.query("SELECT id FROM buildings ORDER BY id LIMIT 1")
  ).rows[0].id as string;
  const floor = await request(app)
    .put(`/api/editor/floors/${floorId}`)
    .set(auth)
    .send({
      buildingId: building,
      floorNumber: 99,
      boundary: {
        type: "Polygon",
        coordinates: [
          [
            [0, 0],
            [100, 0],
            [100, 100],
            [0, 100],
            [0, 0],
          ],
        ],
      },
      localWidth: 100,
      localHeight: 100,
      mapTransform: { origin: a, xAxis: [0.000001, 0], yAxis: [0, -0.000001] },
      status: "draft",
      version: 1,
      features: [
        {
          id: `${prefix}-room`,
          kind: "room",
          name: "Test room",
          geometry: { x: 10, y: 10, width: 20, height: 20 },
          isExit: false,
          status: "draft",
        },
      ],
    });
  assert.equal(floor.status, 200);
  const floorList = await request(app)
    .get(`/api/editor/floors?buildingId=${encodeURIComponent(building)}`)
    .set(auth);
  assert.ok(
    floorList.body.floors.some((entry: { id: string }) => entry.id === floorId),
  );
  const floorDetail = await request(app)
    .get(`/api/editor/floors/${encodeURIComponent(floorId)}`)
    .set(auth);
  assert.equal(floorDetail.body.features[0].name, "Test room");
  await db.end();
  db = createDatabase(config);
  app = createApp(config, db);
  const persisted = await db.query(
    "SELECT (SELECT count(*)::int FROM outdoor_points WHERE id=$1) point,(SELECT count(*)::int FROM floors WHERE id=$2) floor",
    [pointId, floorId],
  );
  assert.deepEqual(persisted.rows[0], { point: 1, floor: 1 });
  const publicMap = await request(app).get("/api/map");
  assert.equal(publicMap.status, 200);
  assert.ok(
    publicMap.body.paths.features.some(
      (feature: { properties?: { id?: string } }) =>
        feature.properties?.id === "osm-202920189",
    ),
  );
  assert.equal("provisionalPaths" in publicMap.body, false);
  assert.equal("referencePaths" in publicMap.body, false);
  console.log(
    "Live integration passed: disconnected campus route outcome, unified paths, authenticated shortcut persistence/blocking, point notes, floors, restart persistence and message deletion.",
  );
} finally {
  await cleanup();
  await db.end();
}
