import { randomUUID } from "node:crypto";
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import type { Config } from "../config.js";
import type { Database } from "../db.js";
import {
  createEditorToken,
  requireEditor,
  verifyEditorPassword,
} from "../auth.js";
import {
  campusCoordinateSchema,
  coordinateSchema,
  pointSchema,
} from "../schemas.js";
import { loadStoredPathFeatures } from "../paths.js";
import { createLocalProjection } from "../routing/projection.js";
import type { LonLat } from "../osm/types.js";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(200),
});
const edgeSchema = z.object({
  id: z.string().min(1),
  fromNodeId: z.string().min(1),
  toNodeId: z.string().min(1),
  coordinates: z.array(coordinateSchema).min(2),
  kind: z.enum(["main", "shortcut"]),
  verified: z.boolean(),
  published: z.boolean(),
  oneWay: z.boolean().default(false),
  sourceOsmId: z.string().optional(),
  version: z.number().int().positive(),
});
const floorSchema = z.object({
  id: z.string().min(1),
  buildingId: z.string().min(1),
  floorNumber: z.number().int(),
  boundary: z.record(z.string(), z.unknown()),
  localWidth: z.number().positive(),
  localHeight: z.number().positive(),
  mapTransform: z.record(z.string(), z.unknown()),
  status: z.enum(["draft", "published"]),
  version: z.number().int().positive(),
  features: z.array(
    z.object({
      id: z.string().min(1),
      kind: z.enum(["room", "door", "point", "stairs", "lift"]),
      name: z.string().max(120),
      geometry: z.record(z.string(), z.unknown()),
      parentFeatureId: z.string().nullable().optional(),
      parentEdge: z.number().int().nullable().optional(),
      edgePosition: z.number().min(0).max(1).nullable().optional(),
      connectorId: z.string().nullable().optional(),
      servedFloors: z.array(z.number().int()).nullable().optional(),
      isExit: z.boolean().default(false),
      outdoorPosition: coordinateSchema.nullable().optional(),
      linkedGraphNodeId: z.string().nullable().optional(),
      status: z.enum(["draft", "published"]),
    }),
  ),
});
const alertSchema = z.object({
  coordinates: campusCoordinateSchema,
  description: z.string().trim().min(1).max(500),
});
const nodeSchema = z.object({
  id: z.string().min(1).max(120),
  coordinates: coordinateSchema,
  version: z.number().int().positive().default(1),
});
const pathPatchSchema = z
  .object({
    blocked: z.boolean().optional(),
    note: z.string().trim().max(240).nullable().optional(),
    version: z.number().int().positive(),
  })
  .refine((value) => value.blocked !== undefined || value.note !== undefined);
const shortcutSchema = z.object({
  id: z.string().uuid(),
  coordinates: z.array(coordinateSchema).min(2).max(500),
  endpoints: z.tuple([
    z.object({
      parentId: z.string().min(1),
      coordinates: coordinateSchema,
      parentVersion: z.number().int().positive(),
    }),
    z.object({
      parentId: z.string().min(1),
      coordinates: coordinateSchema,
      parentVersion: z.number().int().positive(),
    }),
  ]),
});

function projectOnLine(point: LonLat, line: readonly LonLat[]) {
  const projection = createLocalProjection(point);
  const target = projection.project(point);
  let best:
    | {
        segmentIndex: number;
        fraction: number;
        coordinates: [number, number];
        distance: number;
      }
    | undefined;
  for (let index = 0; index < line.length - 1; index++) {
    const a = projection.project(line[index]!);
    const b = projection.project(line[index + 1]!);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const denominator = dx * dx + dy * dy;
    const fraction = denominator
      ? Math.max(
          0,
          Math.min(
            1,
            ((target.x - a.x) * dx + (target.y - a.y) * dy) / denominator,
          ),
        )
      : 0;
    const projected = { x: a.x + fraction * dx, y: a.y + fraction * dy };
    const distance = Math.hypot(target.x - projected.x, target.y - projected.y);
    if (!best || distance < best.distance)
      best = {
        segmentIndex: index,
        fraction,
        coordinates: [...projection.unproject(projected)],
        distance,
      };
  }
  if (best && best.fraction <= 1e-9 && best.segmentIndex > 0) {
    best.segmentIndex -= 1;
    best.fraction = 1;
  }
  return best;
}

function simplePolyline(line: readonly LonLat[]): boolean {
  if (line.length < 2) return false;
  const projection = createLocalProjection(line[0]!);
  const points = line.map((point) => projection.project(point));
  if (
    points.some(
      (point, index) =>
        index > 0 &&
        Math.hypot(
          point.x - points[index - 1]!.x,
          point.y - points[index - 1]!.y,
        ) < 0.05,
    )
  )
    return false;
  const intersects = (
    a: (typeof points)[number],
    b: (typeof points)[number],
    c: (typeof points)[number],
    d: (typeof points)[number],
  ) => {
    const orient = (p: typeof a, q: typeof a, r: typeof a) =>
      Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
    return (
      orient(a, b, c) * orient(a, b, d) < 0 &&
      orient(c, d, a) * orient(c, d, b) < 0
    );
  };
  for (let i = 0; i < points.length - 1; i++)
    for (let j = i + 2; j < points.length - 1; j++)
      if (intersects(points[i]!, points[i + 1]!, points[j]!, points[j + 1]!))
        return false;
  return true;
}

type Point = { x: number; y: number };
function polygonFromBoundary(boundary: Record<string, unknown>): Point[] {
  const coordinates = (boundary as { coordinates?: unknown }).coordinates;
  if (!Array.isArray(coordinates) || !Array.isArray(coordinates[0])) return [];
  return (coordinates[0] as unknown[]).flatMap((value) =>
    Array.isArray(value) &&
    typeof value[0] === "number" &&
    typeof value[1] === "number"
      ? [{ x: value[0], y: value[1] }]
      : [],
  );
}
function pointInPolygon(point: Point, polygon: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!,
      b = polygon[j]!;
    const cross = (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x);
    if (
      Math.abs(cross) < 1e-7 &&
      point.x >= Math.min(a.x, b.x) - 1e-7 &&
      point.x <= Math.max(a.x, b.x) + 1e-7 &&
      point.y >= Math.min(a.y, b.y) - 1e-7 &&
      point.y <= Math.max(a.y, b.y) + 1e-7
    )
      return true;
    if (
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
    )
      inside = !inside;
  }
  return inside;
}
function orientation(a: Point, b: Point, c: Point): number {
  return Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
}
function properIntersection(a: Point, b: Point, c: Point, d: Point): boolean {
  return (
    orientation(a, b, c) * orientation(a, b, d) < 0 &&
    orientation(c, d, a) * orientation(c, d, b) < 0
  );
}
function rectangleInside(
  rect: { x: number; y: number; width: number; height: number },
  polygon: Point[],
): boolean {
  if (!(rect.width > 0 && rect.height > 0)) return false;
  const corners = [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x + rect.width, y: rect.y + rect.height },
    { x: rect.x, y: rect.y + rect.height },
  ];
  if (!corners.every((p) => pointInPolygon(p, polygon))) return false;
  for (let i = 0; i < 4; i++) {
    const a = corners[i]!,
      b = corners[(i + 1) % 4]!;
    for (let j = 0; j < polygon.length - 1; j++)
      if (properIntersection(a, b, polygon[j]!, polygon[j + 1]!)) return false;
  }
  return true;
}
function validateFloorGeometry(floor: z.infer<typeof floorSchema>): string[] {
  const errors: string[] = [];
  const polygon = polygonFromBoundary(floor.boundary);
  if (polygon.length < 4) return ["Floor boundary must be a closed polygon"];
  for (const feature of floor.features) {
    const geometry = feature.geometry as {
      x?: unknown;
      y?: unknown;
      width?: unknown;
      height?: unknown;
      parent?: { kind?: unknown };
    };
    if (feature.kind === "room") {
      if (
        ![geometry.x, geometry.y, geometry.width, geometry.height].every(
          (v) => typeof v === "number",
        ) ||
        !rectangleInside(
          geometry as { x: number; y: number; width: number; height: number },
          polygon,
        )
      )
        errors.push(
          `Room ${feature.id} is not fully contained by the floor boundary`,
        );
    }
    if (feature.kind === "door" && feature.isExit) {
      if (floor.floorNumber !== 0)
        errors.push(
          `Door ${feature.id}: only a ground-floor door can be an exit`,
        );
      if (geometry.parent?.kind !== "exterior")
        errors.push(
          `Door ${feature.id}: a room door cannot be marked as a campus exit`,
        );
    }
  }
  return errors;
}

export function editorRoutes(
  db: Database,
  config: Config,
  onGraphChange: () => void,
): Router {
  const router = Router();
  router.post(
    "/login",
    rateLimit({ windowMs: 15 * 60_000, limit: 8 }),
    async (request, response) => {
      const parsed = loginSchema.safeParse(request.body);
      if (
        !parsed.success ||
        parsed.data.email.toLowerCase() !== config.EDITOR_EMAIL.toLowerCase() ||
        !(await verifyEditorPassword(config, parsed.data.password))
      ) {
        return response
          .status(401)
          .json({ error: "Invalid editor credentials" });
      }
      response.json({
        token: await createEditorToken(config),
        expiresInSeconds: 7200,
      });
    },
  );

  router.use(requireEditor(config));
  router.get("/messages", async (_request, response, next) => {
    try {
      response.json({
        messages: (
          await db.query(
            "SELECT * FROM messages ORDER BY created_at DESC LIMIT 200",
          )
        ).rows,
      });
    } catch (e) {
      next(e);
    }
  });
  router.delete("/messages/:id", async (request, response, next) => {
    try {
      const result = await db.query(
        "DELETE FROM messages WHERE id=$1 RETURNING id",
        [request.params.id],
      );
      if (!result.rowCount)
        return response.status(404).json({ error: "Unknown message" });
      response.status(204).end();
    } catch (e) {
      next(e);
    }
  });
  router.get("/graph", async (_request, response, next) => {
    try {
      const [paths, points, alerts] = await Promise.all([
        loadStoredPathFeatures(db),
        db.query(
          "SELECT id,name,longitude,latitude,description,version FROM outdoor_points ORDER BY name,id",
        ),
        db.query(
          "SELECT id,longitude,latitude,description,version FROM alerts ORDER BY created_at DESC",
        ),
      ]);
      response.json({
        paths: paths.map((path) => ({
          id: path.id,
          name: path.name,
          coordinates: path.coordinates,
          kind: path.kind,
          source: path.source,
          blocked: path.blocked,
          note: path.note,
          version: path.version,
        })),
        points: points.rows.map((row) => ({
          id: row.id,
          name: row.name,
          coordinates: [row.longitude, row.latitude],
          note: row.description,
          version: row.version,
        })),
        alerts: alerts.rows.map((row) => ({
          id: row.id,
          coordinates: [row.longitude, row.latitude],
          description: row.description,
          version: row.version ?? 1,
        })),
      });
    } catch (e) {
      next(e);
    }
  });

  router.patch("/paths/:id", async (request, response, next) => {
    const parsed = pathPatchSchema.safeParse(request.body);
    if (!parsed.success)
      return response.status(400).json({
        error: "Invalid path update",
        details: parsed.error.flatten(),
      });
    const id = request.params.id;
    const value = parsed.data;
    try {
      const edge = await db.query(
        `UPDATE route_edges SET blocked=COALESCE($1,blocked),note=CASE WHEN $2 THEN $3 ELSE note END,version=version+1
         WHERE id=$4 AND version=$5 RETURNING id,blocked,note,version`,
        [
          value.blocked ?? null,
          value.note !== undefined,
          value.note ?? null,
          id,
          value.version,
        ],
      );
      const updated = edge.rowCount
        ? edge
        : await db.query(
            `UPDATE osm_candidates SET blocked=COALESCE($1,blocked),note=CASE WHEN $2 THEN $3 ELSE note END,version=version+1,updated_at=now()
         WHERE (id=$4 OR 'osm-'||source_way_id=$4) AND version=$5 RETURNING 'osm-'||source_way_id AS id,blocked,note,version`,
            [
              value.blocked ?? null,
              value.note !== undefined,
              value.note ?? null,
              id,
              value.version,
            ],
          );
      if (!updated.rowCount) {
        const exists = await db.query(
          "SELECT 1 FROM route_edges WHERE id=$1 UNION ALL SELECT 1 FROM osm_candidates WHERE id=$1 OR 'osm-'||source_way_id=$1 LIMIT 1",
          [id],
        );
        return response.status(exists.rowCount ? 409 : 404).json({
          error: exists.rowCount ? "Path changed elsewhere" : "Unknown path",
          affectedIds: [id],
        });
      }
      if (value.blocked !== undefined) onGraphChange();
      response.json(updated.rows[0]);
    } catch (e) {
      next(e);
    }
  });

  router.post("/paths", async (request, response, next) => {
    const parsed = shortcutSchema.safeParse(request.body);
    if (!parsed.success)
      return response.status(400).json({
        error: "Invalid shortcut path",
        details: parsed.error.flatten(),
      });
    const shortcut = parsed.data;
    const paths = await loadStoredPathFeatures(db);
    const resolved = shortcut.endpoints.map((endpoint) => {
      const path = paths.find((item) => item.id === endpoint.parentId);
      const projection = path
        ? projectOnLine(endpoint.coordinates, path.coordinates)
        : undefined;
      return { endpoint, path, projection };
    });
    if (
      resolved.some(
        ({ path, projection }) =>
          !path || !projection || projection.distance > 5,
      )
    )
      return response.status(400).json({
        error:
          "Both shortcut endpoints must snap within 5 metres of an eligible campus path",
      });
    if (
      resolved.some(
        ({ path, endpoint }) => path!.version !== endpoint.parentVersion,
      )
    )
      return response.status(409).json({
        error: "A parent path changed after it was selected",
        affectedIds: shortcut.endpoints.map((endpoint) => endpoint.parentId),
      });
    const first = resolved[0]!;
    const last = resolved[1]!;
    const firstProjection = first.projection!;
    const lastProjection = last.projection!;
    const start = firstProjection.coordinates;
    const end = lastProjection.coordinates;
    const line = shortcut.coordinates.map((coordinate, index, coordinates) =>
      index === 0 ? start : index === coordinates.length - 1 ? end : coordinate,
    );
    if (
      line.some(
        ([lon, lat]) =>
          lon < 75.867 || lon > 75.877 || lat < 22.722 || lat > 22.73,
      ) ||
      !simplePolyline(line)
    )
      return response.status(400).json({
        error:
          "Shortcut geometry must be a simple campus line without self-crossings",
      });
    const local = createLocalProjection(start);
    if (
      Math.hypot(
        local.project(start).x - local.project(end).x,
        local.project(start).y - local.project(end).y,
      ) < 0.5
    )
      return response
        .status(400)
        .json({ error: "Shortcut endpoints must be distinct" });
    const junctionIds = await Promise.all(
      resolved.map(async ({ path, projection }) => {
        const lastIndex = path!.coordinates.length - 2;
        if (path!.source === "osm") {
          if (projection!.segmentIndex === 0 && projection!.fraction <= 1e-9)
            return `osm-node:${path!.sourceNodeIds[0]}`;
          if (
            projection!.segmentIndex === lastIndex &&
            projection!.fraction >= 1 - 1e-9
          )
            return `osm-node:${path!.sourceNodeIds.at(-1)}`;
        } else {
          const endpoints = await db.query(
            "SELECT from_node_id,to_node_id FROM route_edges WHERE id=$1",
            [path!.id],
          );
          if (
            endpoints.rowCount &&
            projection!.segmentIndex === 0 &&
            projection!.fraction <= 1e-9
          )
            return endpoints.rows[0]!.from_node_id as string;
          if (
            endpoints.rowCount &&
            projection!.segmentIndex === lastIndex &&
            projection!.fraction >= 1 - 1e-9
          )
            return endpoints.rows[0]!.to_node_id as string;
        }
        const parentId =
          path!.source === "osm" ? `osm-${path!.sourceOsmId}` : path!.id;
        const fraction = Math.round(projection!.fraction * 1_000_000_000);
        return `junction:${parentId}:${projection!.segmentIndex}:${fraction}`;
      }),
    );
    if (junctionIds[0] === junctionIds[1])
      return response.status(400).json({
        error: "Shortcut endpoints must attach to distinct path locations",
      });
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const snapValues: unknown[][] = [];
      for (let index = 0; index < 2; index++) {
        const { path, projection, endpoint } = resolved[index]!;
        let currentVersion =
          path!.source === "osm"
            ? await client.query(
                "SELECT version FROM route_edges WHERE id=$1 AND source_osm_id=$2",
                [path!.id, path!.sourceOsmId],
              )
            : await client.query(
                "SELECT version FROM route_edges WHERE id=$1",
                [path!.id],
              );
        if (path!.source === "osm" && !currentVersion.rowCount)
          currentVersion = await client.query(
            "SELECT version FROM osm_candidates WHERE source_way_id=$1",
            [path!.sourceOsmId],
          );
        if (
          !currentVersion.rowCount ||
          currentVersion.rows[0]!.version !== endpoint.parentVersion
        ) {
          await client.query("ROLLBACK");
          return response.status(409).json({
            error: "A parent path changed while saving",
            affectedIds: [endpoint.parentId],
          });
        }
        const junctionId = junctionIds[index]!;
        await client.query(
          "INSERT INTO route_nodes(id,longitude,latitude,version) VALUES($1,$2,$3,1) ON CONFLICT(id) DO UPDATE SET longitude=EXCLUDED.longitude,latitude=EXCLUDED.latitude,version=route_nodes.version+1",
          [junctionId, ...projection!.coordinates],
        );
        const featureId =
          path!.source === "osm" ? `osm-${path!.sourceOsmId}` : path!.id;
        snapValues.push([
          shortcut.id,
          index,
          featureId,
          path!.source,
          projection!.segmentIndex,
          projection!.fraction,
          endpoint.parentVersion,
          junctionId,
          JSON.stringify(projection!.coordinates),
        ]);
      }
      await client.query(
        `INSERT INTO route_edges(id,from_node_id,to_node_id,coordinates,kind,verified,published,blocked,one_way,version)
         VALUES($1,$2,$3,$4,'shortcut',true,true,false,false,1)`,
        [shortcut.id, junctionIds[0], junctionIds[1], JSON.stringify(line)],
      );
      for (const values of snapValues)
        await client.query(
          `INSERT INTO path_snap_connections(shortcut_path_id,endpoint_index,parent_feature_id,parent_source,parent_segment_index,parent_segment_fraction,parent_version,junction_node_id,coordinates)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          values,
        );
      await client.query("COMMIT");
      onGraphChange();
      response.status(201).json({ id: shortcut.id, version: 1 });
    } catch (e) {
      await client.query("ROLLBACK");
      next(e);
    } finally {
      client.release();
    }
  });

  router.get("/floors", async (request, response, next) => {
    const buildingId =
      typeof request.query.buildingId === "string"
        ? request.query.buildingId
        : "";
    if (!buildingId)
      return response.status(400).json({ error: "buildingId is required" });
    try {
      const result = await db.query(
        "SELECT id,building_id,floor_number,status,version,updated_at FROM floors WHERE building_id=$1 ORDER BY floor_number",
        [buildingId],
      );
      response.json({ floors: result.rows });
    } catch (e) {
      next(e);
    }
  });

  router.get("/floors/:id", async (request, response, next) => {
    try {
      const [floor, features] = await Promise.all([
        db.query("SELECT * FROM floors WHERE id=$1", [request.params.id]),
        db.query(
          "SELECT * FROM floor_features WHERE floor_id=$1 ORDER BY kind,name,id",
          [request.params.id],
        ),
      ]);
      if (!floor.rowCount)
        return response.status(404).json({ error: "Unknown floor" });
      response.json({ ...floor.rows[0], features: features.rows });
    } catch (e) {
      next(e);
    }
  });

  router.patch("/features/:id/exit-link", async (request, response, next) => {
    const parsed = z
      .object({ nodeId: z.string().min(1) })
      .safeParse(request.body);
    if (!parsed.success)
      return response.status(400).json({ error: "A route node is required" });
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const feature = await client.query(
        `SELECT ff.id,ff.kind,ff.is_exit,ff.geometry,f.floor_number,f.id AS floor_id
         FROM floor_features ff JOIN floors f ON f.id=ff.floor_id
         WHERE ff.id=$1 FOR UPDATE`,
        [request.params.id],
      );
      if (!feature.rowCount) {
        await client.query("ROLLBACK");
        return response.status(404).json({ error: "Unknown floor feature" });
      }
      const row = feature.rows[0];
      const parent = (row.geometry as { parent?: { kind?: string } }).parent;
      if (
        row.kind !== "door" ||
        !row.is_exit ||
        row.floor_number !== 0 ||
        parent?.kind !== "exterior"
      ) {
        await client.query("ROLLBACK");
        return response
          .status(400)
          .json({ error: "Only an exterior ground-floor exit can be linked" });
      }
      const node = await client.query(
        `SELECT n.id,n.longitude,n.latitude FROM route_nodes n
         WHERE n.id=$1 AND EXISTS (
           SELECT 1 FROM route_edges e WHERE e.kind='main' AND e.verified AND e.published
           AND (e.from_node_id=n.id OR e.to_node_id=n.id)
         )`,
        [parsed.data.nodeId],
      );
      if (!node.rowCount) {
        await client.query("ROLLBACK");
        return response
          .status(400)
          .json({ error: "Select a node on a verified published main path" });
      }
      const selected = node.rows[0];
      const outdoorPosition = [selected.longitude, selected.latitude];
      await client.query(
        "UPDATE floor_features SET linked_graph_node_id=$1,outdoor_position=$2,version=version+1 WHERE id=$3",
        [selected.id, JSON.stringify(outdoorPosition), row.id],
      );
      await client.query(
        "UPDATE floors SET version=version+1,updated_at=now() WHERE id=$1",
        [row.floor_id],
      );
      await client.query("COMMIT");
      response.json({
        id: row.id,
        linkedGraphNodeId: selected.id,
        outdoorPosition,
        mainPathVerified: true,
      });
    } catch (e) {
      await client.query("ROLLBACK");
      next(e);
    } finally {
      client.release();
    }
  });

  router.put("/nodes/:id", async (request, response, next) => {
    const parsed = nodeSchema.safeParse({
      ...request.body,
      id: request.params.id,
    });
    if (!parsed.success)
      return response
        .status(400)
        .json({ error: "Invalid route node", details: parsed.error.flatten() });
    try {
      const result = await db.query(
        `INSERT INTO route_nodes(id,longitude,latitude,version) VALUES($1,$2,$3,1)
      ON CONFLICT(id) DO UPDATE SET longitude=$2,latitude=$3,version=route_nodes.version+1 WHERE route_nodes.version=$4 RETURNING *`,
        [parsed.data.id, ...parsed.data.coordinates, parsed.data.version],
      );
      if (!result.rowCount)
        return response.status(409).json({
          error: "Graph was changed elsewhere",
          affectedIds: [parsed.data.id],
        });
      onGraphChange();
      response.json(result.rows[0]);
    } catch (e) {
      next(e);
    }
  });

  router.put("/points/:id", async (request, response, next) => {
    const parsed = pointSchema.safeParse({
      ...request.body,
      id: request.params.id,
    });
    if (!parsed.success)
      return response
        .status(400)
        .json({ error: "Invalid point", details: parsed.error.flatten() });
    const { id, name, coordinates, version } = parsed.data;
    const description = parsed.data.note ?? parsed.data.description;
    try {
      const result = await db.query(
        `INSERT INTO outdoor_points(id,name,longitude,latitude,description,published,version) VALUES($1,$2,$3,$4,$5,true,1)
        ON CONFLICT(id) DO UPDATE SET name=$2,longitude=$3,latitude=$4,description=$5,published=true,version=outdoor_points.version+1 WHERE outdoor_points.version=$6 RETURNING *`,
        [id, name, ...coordinates, description, version],
      );
      if (!result.rowCount)
        return response
          .status(409)
          .json({ error: "Point was changed elsewhere", affectedIds: [id] });
      response.json(result.rows[0]);
    } catch (e) {
      next(e);
    }
  });

  router.delete("/points/:id", async (request, response, next) => {
    try {
      const result = await db.query(
        "DELETE FROM outdoor_points WHERE id=$1 RETURNING id",
        [request.params.id],
      );
      if (!result.rowCount)
        return response.status(404).json({ error: "Unknown point" });
      response.status(204).end();
    } catch (e) {
      next(e);
    }
  });

  router.delete("/points/:id", async (request, response, next) => {
    try {
      const result = await db.query(
        "DELETE FROM outdoor_points WHERE id=$1 RETURNING id",
        [request.params.id],
      );
      if (!result.rowCount)
        return response.status(404).json({ error: "Unknown point" });
      response.status(204).end();
    } catch (e) {
      next(e);
    }
  });

  router.put("/edges/:id", async (request, response, next) => {
    const parsed = edgeSchema.safeParse({
      ...request.body,
      id: request.params.id,
    });
    if (!parsed.success)
      return response
        .status(400)
        .json({ error: "Invalid edge", details: parsed.error.flatten() });
    const edge = parsed.data;
    try {
      let verified = edge.verified,
        published = edge.published;
      let warning: string | undefined;
      if (verified && published) {
        const connected = await db.query(
          `SELECT 1 FROM route_edges WHERE verified AND published AND id<>$1 AND (from_node_id=ANY($2::text[]) OR to_node_id=ANY($2::text[])) LIMIT 1`,
          [edge.id, [edge.fromNodeId, edge.toNodeId]],
        );
        const anyGraph = await db.query(
          "SELECT 1 FROM route_edges WHERE verified AND published AND id<>$1 LIMIT 1",
          [edge.id],
        );
        if (!anyGraph.rowCount || !connected.rowCount) {
          verified = false;
          published = false;
          warning =
            "Detached line saved as a non-routable draft. Connect it to an existing verified node or seed the graph from a physically verified OSM candidate.";
        }
      }
      const result = await db.query(
        `INSERT INTO route_edges(id,from_node_id,to_node_id,coordinates,kind,verified,published,one_way,source_osm_id,version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,1)
        ON CONFLICT(id) DO UPDATE SET from_node_id=$2,to_node_id=$3,coordinates=$4,kind=$5,verified=$6,published=$7,one_way=$8,source_osm_id=$9,version=route_edges.version+1 WHERE route_edges.version=$10 RETURNING *`,
        [
          edge.id,
          edge.fromNodeId,
          edge.toNodeId,
          JSON.stringify(edge.coordinates),
          edge.kind,
          verified,
          published,
          edge.oneWay,
          edge.sourceOsmId ?? null,
          edge.version,
        ],
      );
      if (!result.rowCount)
        return response.status(409).json({
          error: "Graph was changed elsewhere",
          affectedIds: [edge.id],
        });
      onGraphChange();
      response.json({ ...result.rows[0], warning });
    } catch (e) {
      next(e);
    }
  });

  router.delete("/edges/:id", async (request, response, next) => {
    try {
      const result = await db.query(
        "DELETE FROM route_edges WHERE id=$1 RETURNING id",
        [request.params.id],
      );
      if (!result.rowCount)
        return response.status(404).json({ error: "Unknown edge" });
      onGraphChange();
      response.status(204).end();
    } catch (e: unknown) {
      if (typeof e === "object" && e && "code" in e && e.code === "23503")
        return response.status(409).json({
          error: "Edge is still linked to an exit or alert",
          affectedIds: [request.params.id],
        });
      next(e);
    }
  });

  router.patch("/candidates/:id", async (request, response, next) => {
    const parsed = z
      .object({
        decision: z.enum(["approved", "rejected", "needs_edit"]),
        version: z.number().int().positive(),
      })
      .safeParse(request.body);
    if (!parsed.success)
      return response.status(400).json({ error: "Invalid review" });
    try {
      const result = await db.query(
        `UPDATE osm_candidates SET reviewer_decision=$1,import_status='reviewed',
          provisional_eligible=CASE WHEN $1 IN ('rejected','needs_edit') THEN false ELSE provisional_eligible END,
          provisional_exclusion_reason=CASE WHEN $1 IN ('rejected','needs_edit') THEN 'review_' || $1 ELSE provisional_exclusion_reason END,
          version=version+1,updated_at=now() WHERE id=$2 AND version=$3 RETURNING *`,
        [parsed.data.decision, request.params.id, parsed.data.version],
      );
      if (!result.rowCount)
        return response.status(409).json({
          error: "Candidate was changed elsewhere",
          affectedIds: [request.params.id],
        });
      onGraphChange();
      response.json(result.rows[0]);
    } catch (e) {
      next(e);
    }
  });

  router.post("/candidates/:id/promote", async (request, response, next) => {
    const parsed = z
      .object({
        version: z.number().int().positive(),
        confirmWalkable: z.literal(true),
      })
      .safeParse(request.body);
    if (!parsed.success)
      return response
        .status(400)
        .json({ error: "Physical walkability confirmation is required" });
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const candidate = await client.query(
        "SELECT * FROM osm_candidates WHERE id=$1 AND version=$2 FOR UPDATE",
        [request.params.id, parsed.data.version],
      );
      if (!candidate.rowCount) {
        await client.query("ROLLBACK");
        return response.status(409).json({
          error: "Candidate was changed elsewhere",
          affectedIds: [request.params.id],
        });
      }
      const row = candidate.rows[0];
      const coordinates = row.coordinates as [number, number][];
      if (coordinates.length < 2) {
        await client.query("ROLLBACK");
        return response
          .status(400)
          .json({ error: "Candidate geometry is incomplete" });
      }
      const fromId = `osm-${row.source_way_id}-start`,
        toId = `osm-${row.source_way_id}-end`,
        edgeId = `osm-${row.source_way_id}`;
      await client.query(
        "INSERT INTO route_nodes(id,longitude,latitude) VALUES($1,$2,$3),($4,$5,$6) ON CONFLICT(id) DO NOTHING",
        [fromId, ...coordinates[0]!, toId, ...coordinates.at(-1)!],
      );
      await client.query(
        `INSERT INTO route_edges(id,from_node_id,to_node_id,coordinates,kind,verified,published,source_osm_id) VALUES($1,$2,$3,$4,'main',true,true,$5) ON CONFLICT(id) DO NOTHING`,
        [edgeId, fromId, toId, JSON.stringify(coordinates), row.source_way_id],
      );
      await client.query(
        "UPDATE osm_candidates SET reviewer_decision='approved',import_status='reviewed',version=version+1,updated_at=now() WHERE id=$1",
        [request.params.id],
      );
      await client.query("COMMIT");
      onGraphChange();
      response.status(201).json({
        edgeId,
        warning:
          "Published only from the editor's explicit physical-walkability confirmation.",
      });
    } catch (e) {
      await client.query("ROLLBACK");
      next(e);
    } finally {
      client.release();
    }
  });

  router.put("/floors/:id", async (request, response, next) => {
    const parsed = floorSchema.safeParse({
      ...request.body,
      id: request.params.id,
    });
    if (!parsed.success)
      return response
        .status(400)
        .json({ error: "Invalid floor", details: parsed.error.flatten() });
    const floor = parsed.data;
    const geometryErrors = validateFloorGeometry(floor);
    if (geometryErrors.length)
      return response
        .status(400)
        .json({ error: "Floor geometry is invalid", details: geometryErrors });
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `INSERT INTO floors(id,building_id,floor_number,boundary,local_width,local_height,map_transform,status,version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,1)
        ON CONFLICT(id) DO UPDATE SET boundary=$4,local_width=$5,local_height=$6,map_transform=$7,status=$8,version=floors.version+1,updated_at=now() WHERE floors.version=$9 RETURNING *`,
        [
          floor.id,
          floor.buildingId,
          floor.floorNumber,
          JSON.stringify(floor.boundary),
          floor.localWidth,
          floor.localHeight,
          JSON.stringify(floor.mapTransform),
          floor.status,
          floor.version,
        ],
      );
      if (!result.rowCount) {
        await client.query("ROLLBACK");
        return response.status(409).json({
          error: "Floor was changed elsewhere",
          affectedIds: [floor.id],
        });
      }
      await client.query("DELETE FROM floor_features WHERE floor_id=$1", [
        floor.id,
      ]);
      for (const feature of floor.features)
        await client.query(
          `INSERT INTO floor_features(id,floor_id,kind,name,geometry,parent_feature_id,parent_edge,edge_position,connector_id,served_floors,is_exit,outdoor_position,linked_graph_node_id,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [
            feature.id,
            floor.id,
            feature.kind,
            feature.name,
            JSON.stringify(feature.geometry),
            feature.parentFeatureId ?? null,
            feature.parentEdge ?? null,
            feature.edgePosition ?? null,
            feature.connectorId ?? null,
            feature.servedFloors ? JSON.stringify(feature.servedFloors) : null,
            feature.isExit,
            feature.outdoorPosition
              ? JSON.stringify(feature.outdoorPosition)
              : null,
            feature.linkedGraphNodeId ?? null,
            feature.status,
          ],
        );
      await client.query("COMMIT");
      response.json(result.rows[0]);
    } catch (e) {
      await client.query("ROLLBACK");
      next(e);
    } finally {
      client.release();
    }
  });

  router.post("/alerts", async (request, response, next) => {
    const parsed = alertSchema.safeParse(request.body);
    if (!parsed.success)
      return response
        .status(400)
        .json({ error: "Invalid alert", details: parsed.error.flatten() });
    const id = randomUUID();
    try {
      await db.query(
        "INSERT INTO alerts(id,longitude,latitude,description) VALUES($1,$2,$3,$4)",
        [id, ...parsed.data.coordinates, parsed.data.description],
      );
      onGraphChange();
      response.status(201).json({ id });
    } catch (e) {
      next(e);
    }
  });
  router.patch("/alerts/:id/active", async (request, response, next) => {
    const parsed = z.object({ active: z.boolean() }).safeParse(request.body);
    if (!parsed.success)
      return response.status(400).json({ error: "Invalid alert state" });
    try {
      const result = await db.query(
        "UPDATE alerts SET active=$1 WHERE id=$2 RETURNING *",
        [parsed.data.active, request.params.id],
      );
      if (!result.rowCount)
        return response.status(404).json({ error: "Unknown alert" });
      onGraphChange();
      response.json(result.rows[0]);
    } catch (e) {
      next(e);
    }
  });
  router.delete("/alerts/:id", async (request, response, next) => {
    try {
      const result = await db.query(
        "DELETE FROM alerts WHERE id=$1 RETURNING id",
        [request.params.id],
      );
      if (!result.rowCount)
        return response.status(404).json({ error: "Unknown alert" });
      onGraphChange();
      response.status(204).end();
    } catch (e) {
      next(e);
    }
  });
  return router;
}
