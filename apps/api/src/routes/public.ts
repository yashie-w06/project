import { randomUUID } from "node:crypto";
import { Router } from "express";
import rateLimit from "express-rate-limit";
import type { Feature, FeatureCollection, GeoJsonProperties, Geometry, LineString, Polygon } from "geojson";
import type { Database } from "../db.js";
import { messageSchema, routeRequestSchema, type TravelProfile } from "../schemas.js";

type RouteResult = { status: "ok"; geometry: LineString; notices: string[]; selectedEntranceDoorId?: string; snaps?: unknown[] } | { status: "no_route"; reason: string; notices: string[] };
export type RouteResolver = (input: { profile: TravelProfile; start: unknown; destination: unknown }) => Promise<RouteResult>;

const collection = <G extends Geometry>(features: Feature<G>[]): FeatureCollection<G> => ({ type: "FeatureCollection", features });

export function publicRoutes(db: Database, resolveRoute: RouteResolver): Router {
  const router = Router();

  router.get("/map", async (_request, response, next) => {
    try {
      const [buildings, candidates, edges, points, alerts] = await Promise.all([
        db.query("SELECT id, name, footprint FROM buildings ORDER BY name"),
        db.query("SELECT id, source_way_id, coordinates, reviewer_decision FROM osm_candidates ORDER BY source_way_id"),
        db.query("SELECT id, kind, coordinates, blocked FROM route_edges WHERE verified AND published ORDER BY id"),
        db.query("SELECT id, name, longitude, latitude FROM outdoor_points WHERE published ORDER BY name"),
        db.query("SELECT id, longitude, latitude, description FROM alerts WHERE active AND published ORDER BY created_at DESC"),
      ]);
      const buildingFeatures = buildings.rows.map((row): Feature<Polygon> => ({
        type: "Feature", id: row.id, properties: { id: row.id, name: row.name }, geometry: row.footprint,
      }));
      const referenceFeatures = candidates.rows.map((row): Feature<LineString> => ({
        type: "Feature", id: row.id, properties: { sourceWayId: row.source_way_id, decision: row.reviewer_decision },
        geometry: { type: "LineString", coordinates: row.coordinates },
      }));
      const verifiedFeatures = edges.rows.map((row): Feature<LineString> => ({
        type: "Feature", id: row.id, properties: { id: row.id, kind: row.kind, blocked: row.blocked },
        geometry: { type: "LineString", coordinates: row.coordinates },
      }));
      const pointFeatures = points.rows.map((row): Feature => ({
        type: "Feature", id: row.id, properties: { id: row.id, name: row.name },
        geometry: { type: "Point", coordinates: [row.longitude, row.latitude] },
      }));
      response.json({
        buildings: collection(buildingFeatures), referencePaths: collection(referenceFeatures),
        verifiedPaths: collection(verifiedFeatures), points: collection(pointFeatures),
        alerts: alerts.rows.map((row) => ({ id: row.id, coordinates: [row.longitude, row.latitude], description: row.description })),
      });
    } catch (error) { next(error); }
  });

  router.get("/buildings", async (_request, response, next) => {
    try {
      const result = await db.query("SELECT id, name, footprint, mapped_level_count FROM buildings ORDER BY name");
      response.json({ buildings: result.rows });
    } catch (error) { next(error); }
  });

  router.get("/buildings/:id/floors/:number", async (request, response, next) => {
    try {
      const result = await db.query(`SELECT f.*, COALESCE(json_agg(ff ORDER BY ff.id) FILTER (WHERE ff.id IS NOT NULL), '[]') AS features
        FROM floors f LEFT JOIN floor_features ff ON ff.floor_id=f.id AND ff.status='published'
        WHERE f.building_id=$1 AND f.floor_number=$2 AND f.status='published' GROUP BY f.id`, [request.params.id, Number(request.params.number)]);
      if (!result.rowCount) return response.status(404).json({ error: "No floor layout mapped" });
      const floor = result.rows[0];
      const connectors = floor.features.filter((f: { kind: string; connector_id?: string }) => (f.kind === "lift" || f.kind === "stairs") && f.connector_id);
      response.json({ boundary: floor.boundary, localWidth: floor.local_width, localHeight: floor.local_height, mapTransform: floor.map_transform, features: floor.features, connectors });
    } catch (error) { next(error); }
  });

  router.get("/search", async (request, response, next) => {
    try {
      const query = String(request.query.q ?? "").trim();
      if (query.length < 2) return response.json({ results: [] });
      const pattern = `%${query}%`;
      const result = await db.query(`SELECT * FROM (
        SELECT 'building' AS kind, id, name, NULL::float8 AS longitude, NULL::float8 AS latitude FROM buildings WHERE name ILIKE $1
        UNION ALL SELECT 'point', id, name, longitude, latitude FROM outdoor_points WHERE published AND name ILIKE $1
        UNION ALL SELECT 'feature', ff.id, ff.name, NULL, NULL FROM floor_features ff JOIN floors f ON f.id=ff.floor_id WHERE ff.status='published' AND f.status='published' AND ff.name ILIKE $1
      ) matches ORDER BY name LIMIT 20`, [pattern]);
      response.json({ results: result.rows });
    } catch (error) { next(error); }
  });

  router.post("/route", async (request, response, next) => {
    const parsed = routeRequestSchema.safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: "Invalid route request", details: parsed.error.flatten() });
    try { response.json(await resolveRoute(parsed.data)); } catch (error) { next(error); }
  });

  router.post("/messages", rateLimit({ windowMs: 15 * 60_000, limit: 5, standardHeaders: true, legacyHeaders: false }), async (request, response, next) => {
    const parsed = messageSchema.safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: "Invalid message", details: parsed.error.flatten() });
    try {
      const id = randomUUID();
      await db.query("INSERT INTO messages(id,longitude,latitude,description) VALUES($1,$2,$3,$4)", [id, ...parsed.data.coordinates, parsed.data.description]);
      response.status(201).json({ received: true });
    } catch (error) { next(error); }
  });

  return router;
}
