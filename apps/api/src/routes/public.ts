import { randomUUID } from "node:crypto";
import { Router } from "express";
import rateLimit from "express-rate-limit";
import type {
  Feature,
  FeatureCollection,
  Geometry,
  LineString,
  Polygon,
} from "geojson";
import type { Database } from "../db.js";
import { loadStoredPathFeatures, pathAsFeature } from "../paths.js";
import {
  messageSchema,
  routeRequestSchema,
  type TravelProfile,
} from "../schemas.js";

export type NoRouteCode =
  | "NO_WALKABLE_GRAPH"
  | "START_UNREACHABLE"
  | "DEST_UNREACHABLE"
  | "NO_PLAUSIBLE_APPROACH"
  | "DIFFERENT_COMPONENTS"
  | "BLOCKED_OR_INELIGIBLE";
type RouteResult =
  | {
      status: "ok";
      geometry: LineString;
      notices: string[];
      segments: Array<{
        geometry: LineString;
        pathId: string;
        kind: "main" | "shortcut";
        note: string | null;
      }>;
      approaches: Array<{
        role: "start" | "destination";
        buildingId: string;
        boundary: [number, number];
        network: [number, number];
        approximate: true;
      }>;
      selectedEntranceDoorId?: string;
      snaps?: unknown[];
    }
  | {
      status: "no_route";
      code: NoRouteCode;
      message: string;
      notices: string[];
    };
export type RouteResolver = (input: {
  profile: TravelProfile;
  start: unknown;
  destination: unknown;
}) => Promise<RouteResult>;

const collection = <G extends Geometry>(
  features: Feature<G>[],
): FeatureCollection<G> => ({ type: "FeatureCollection", features });

export function publicRoutes(
  db: Database,
  resolveRoute: RouteResolver,
): Router {
  const router = Router();

  router.get("/map", async (_request, response, next) => {
    try {
      const [buildings, paths, points, alerts] = await Promise.all([
        db.query("SELECT id, name, footprint FROM buildings ORDER BY name"),
        loadStoredPathFeatures(db),
        db.query(
          "SELECT id,name,longitude,latitude,description FROM outdoor_points ORDER BY name,id",
        ),
        db.query(
          "SELECT id,longitude,latitude,description FROM alerts ORDER BY created_at DESC",
        ),
      ]);
      const buildingFeatures = buildings.rows.map((row): Feature<Polygon> => ({
        type: "Feature",
        id: row.id,
        properties: { id: row.id, name: row.name },
        geometry: row.footprint,
      }));
      const pointFeatures = points.rows.map((row): Feature => ({
        type: "Feature",
        id: row.id,
        properties: { id: row.id, name: row.name, note: row.description },
        geometry: { type: "Point", coordinates: [row.longitude, row.latitude] },
      }));
      response.json({
        buildings: collection(buildingFeatures),
        paths: collection(paths.map(pathAsFeature)),
        points: collection(pointFeatures),
        alerts: alerts.rows.map((row) => ({
          id: row.id,
          coordinates: [row.longitude, row.latitude],
          description: row.description,
        })),
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/buildings", async (_request, response, next) => {
    try {
      const result = await db.query(
        "SELECT id, name, footprint, mapped_level_count FROM buildings ORDER BY name",
      );
      response.json({ buildings: result.rows });
    } catch (error) {
      next(error);
    }
  });

  router.get("/buildings/:id", async (request, response, next) => {
    try {
      const building = await db.query(
        "SELECT id,name,footprint,mapped_level_count FROM buildings WHERE id=$1",
        [request.params.id],
      );
      if (!building.rowCount)
        return response.status(404).json({ error: "Unknown building" });
      const floors = await db.query(
        `SELECT f.id,f.floor_number,
        COALESCE(json_agg(json_build_object('id',ff.id,'kind',ff.kind,'name',ff.name,'isExit',ff.is_exit,'linkedGraphNodeId',ff.linked_graph_node_id)) FILTER (WHERE ff.id IS NOT NULL),'[]') features
        FROM floors f LEFT JOIN floor_features ff ON ff.floor_id=f.id
        WHERE f.building_id=$1 GROUP BY f.id ORDER BY f.floor_number`,
        [request.params.id],
      );
      response.json({ building: building.rows[0], floors: floors.rows });
    } catch (error) {
      next(error);
    }
  });

  router.get(
    "/buildings/:id/floors/:number",
    async (request, response, next) => {
      try {
        const result = await db.query(
          `SELECT f.*, COALESCE(json_agg(ff ORDER BY ff.id) FILTER (WHERE ff.id IS NOT NULL), '[]') AS features
        FROM floors f LEFT JOIN floor_features ff ON ff.floor_id=f.id
        WHERE f.building_id=$1 AND f.floor_number=$2 GROUP BY f.id`,
          [request.params.id, Number(request.params.number)],
        );
        if (!result.rowCount)
          return response.status(404).json({ error: "No data available" });
        const floor = result.rows[0];
        response.json({
          id: floor.id,
          buildingId: floor.building_id,
          floorNumber: floor.floor_number,
          version: floor.version,
          boundary: floor.boundary,
          localWidth: floor.local_width,
          localHeight: floor.local_height,
          mapTransform: floor.map_transform,
          features: floor.features,
        });
      } catch (error) {
        next(error);
      }
    },
  );

  router.get("/search", async (request, response, next) => {
    try {
      const query = String(request.query.q ?? "").trim();
      if (query.length < 2) return response.json({ results: [] });
      const pattern = `%${query}%`;
      const result = await db.query(
        `SELECT * FROM (
        SELECT 'building' AS kind, b.id, b.name, b.id AS building_id, NULL::int AS floor_number, NULL::float8 AS longitude, NULL::float8 AS latitude, b.name AS context FROM buildings b WHERE b.name ILIKE $1
        UNION ALL SELECT 'point', p.id, p.name, NULL, NULL, p.longitude, p.latitude, 'Outdoor point' FROM outdoor_points p WHERE p.name ILIKE $1
      ) matches ORDER BY name LIMIT 20`,
        [pattern],
      );
      response.json({
        results: result.rows.map((row) => ({
          kind: row.kind,
          id: row.id,
          name: row.name,
          buildingId: row.building_id,
          floor: row.floor_number,
          longitude: row.longitude,
          latitude: row.latitude,
          context: row.context,
        })),
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/route", async (request, response, next) => {
    const parsed = routeRequestSchema.safeParse(request.body);
    if (!parsed.success)
      return response.status(400).json({
        error: "Invalid route request",
        details: parsed.error.flatten(),
      });
    try {
      response.json(await resolveRoute(parsed.data));
    } catch (error) {
      next(error);
    }
  });

  router.post(
    "/messages",
    rateLimit({
      windowMs: 15 * 60_000,
      limit: 5,
      standardHeaders: true,
      legacyHeaders: false,
    }),
    async (request, response, next) => {
      const parsed = messageSchema.safeParse(request.body);
      if (!parsed.success)
        return response
          .status(400)
          .json({ error: "Invalid message", details: parsed.error.flatten() });
      try {
        const id = randomUUID();
        await db.query(
          "INSERT INTO messages(id,longitude,latitude,description) VALUES($1,$2,$3,$4)",
          [id, ...parsed.data.coordinates, parsed.data.description],
        );
        response.status(201).json({ received: true });
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}
