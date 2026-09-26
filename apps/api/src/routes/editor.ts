import { randomUUID } from "node:crypto";
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import type { Config } from "../config.js";
import type { Database } from "../db.js";
import { createEditorToken, requireEditor, verifyEditorPassword } from "../auth.js";
import { coordinateSchema, pointSchema } from "../schemas.js";

const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1).max(200) });
const edgeSchema = z.object({ id: z.string().min(1), fromNodeId: z.string().min(1), toNodeId: z.string().min(1), coordinates: z.array(coordinateSchema).min(2), kind: z.enum(["main", "shortcut"]), verified: z.boolean(), published: z.boolean(), oneWay: z.boolean().default(false), sourceOsmId: z.string().optional(), version: z.number().int().positive() });
const floorSchema = z.object({ id: z.string().min(1), buildingId: z.string().min(1), floorNumber: z.number().int(), boundary: z.record(z.string(), z.unknown()), localWidth: z.number().positive(), localHeight: z.number().positive(), mapTransform: z.record(z.string(), z.unknown()), status: z.enum(["draft", "published"]), version: z.number().int().positive(), features: z.array(z.object({ id: z.string().min(1), kind: z.enum(["room","door","point","stairs","lift"]), name: z.string().max(120), geometry: z.record(z.string(), z.unknown()), parentFeatureId: z.string().nullable().optional(), parentEdge: z.number().int().nullable().optional(), edgePosition: z.number().min(0).max(1).nullable().optional(), connectorId: z.string().nullable().optional(), servedFloors: z.array(z.number().int()).nullable().optional(), isExit: z.boolean().default(false), outdoorPosition: coordinateSchema.nullable().optional(), linkedGraphNodeId: z.string().nullable().optional(), status: z.enum(["draft","published"]) })) });
const alertSchema = z.object({ coordinates: coordinateSchema, description: z.string().trim().min(1).max(500), edgeIds: z.array(z.string()).max(50).default([]) });
const nodeSchema = z.object({ id: z.string().min(1).max(120), coordinates: coordinateSchema, version: z.number().int().positive().default(1) });

export function editorRoutes(db: Database, config: Config, onGraphChange: () => void): Router {
  const router = Router();
  router.post("/login", rateLimit({ windowMs: 15 * 60_000, limit: 8 }), async (request, response) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success || parsed.data.email.toLowerCase() !== config.EDITOR_EMAIL.toLowerCase() || !(await verifyEditorPassword(config, parsed.data.password))) {
      return response.status(401).json({ error: "Invalid editor credentials" });
    }
    response.json({ token: await createEditorToken(config), expiresInSeconds: 7200 });
  });

  router.use(requireEditor(config));
  router.get("/messages", async (_request, response, next) => { try { response.json({ messages: (await db.query("SELECT * FROM messages ORDER BY created_at DESC LIMIT 200")).rows }); } catch (e) { next(e); } });
  router.get("/graph", async (_request, response, next) => { try { const [nodes, edges, candidates, points] = await Promise.all([db.query("SELECT * FROM route_nodes ORDER BY id"), db.query("SELECT * FROM route_edges ORDER BY id"), db.query("SELECT * FROM osm_candidates ORDER BY source_way_id"), db.query("SELECT * FROM outdoor_points ORDER BY name")]); response.json({ nodes: nodes.rows, edges: edges.rows, candidates: candidates.rows, points: points.rows }); } catch (e) { next(e); } });

  router.put("/nodes/:id", async (request, response, next) => {
    const parsed=nodeSchema.safeParse({...request.body,id:request.params.id});if(!parsed.success)return response.status(400).json({error:"Invalid route node",details:parsed.error.flatten()});
    try{const result=await db.query(`INSERT INTO route_nodes(id,longitude,latitude,version) VALUES($1,$2,$3,1)
      ON CONFLICT(id) DO UPDATE SET longitude=$2,latitude=$3,version=route_nodes.version+1 WHERE route_nodes.version=$4 RETURNING *`,[parsed.data.id,...parsed.data.coordinates,parsed.data.version]);if(!result.rowCount)return response.status(409).json({error:"Graph was changed elsewhere",affectedIds:[parsed.data.id]});onGraphChange();response.json(result.rows[0]);}catch(e){next(e);}
  });

  router.put("/points/:id", async (request, response, next) => {
    const parsed = pointSchema.safeParse({ ...request.body, id: request.params.id });
    if (!parsed.success) return response.status(400).json({ error: "Invalid point", details: parsed.error.flatten() });
    const { id, name, coordinates, published, version } = parsed.data;
    try {
      const result = await db.query(`INSERT INTO outdoor_points(id,name,longitude,latitude,published,version) VALUES($1,$2,$3,$4,$5,1)
        ON CONFLICT(id) DO UPDATE SET name=$2,longitude=$3,latitude=$4,published=$5,version=outdoor_points.version+1 WHERE outdoor_points.version=$6 RETURNING *`, [id,name,...coordinates,published,version]);
      if (!result.rowCount) return response.status(409).json({ error: "Point was changed elsewhere", affectedIds: [id] });
      response.json(result.rows[0]);
    } catch (e) { next(e); }
  });

  router.put("/edges/:id", async (request, response, next) => {
    const parsed = edgeSchema.safeParse({ ...request.body, id: request.params.id });
    if (!parsed.success) return response.status(400).json({ error: "Invalid edge", details: parsed.error.flatten() });
    const edge = parsed.data;
    try {
      const result = await db.query(`INSERT INTO route_edges(id,from_node_id,to_node_id,coordinates,kind,verified,published,one_way,source_osm_id,version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,1)
        ON CONFLICT(id) DO UPDATE SET from_node_id=$2,to_node_id=$3,coordinates=$4,kind=$5,verified=$6,published=$7,one_way=$8,source_osm_id=$9,version=route_edges.version+1 WHERE route_edges.version=$10 RETURNING *`, [edge.id,edge.fromNodeId,edge.toNodeId,JSON.stringify(edge.coordinates),edge.kind,edge.verified,edge.published,edge.oneWay,edge.sourceOsmId ?? null,edge.version]);
      if (!result.rowCount) return response.status(409).json({ error: "Graph was changed elsewhere", affectedIds: [edge.id] });
      onGraphChange(); response.json(result.rows[0]);
    } catch (e) { next(e); }
  });

  router.delete("/edges/:id", async (request, response, next) => { try { const result = await db.query("DELETE FROM route_edges WHERE id=$1 RETURNING id", [request.params.id]); if (!result.rowCount) return response.status(404).json({ error: "Unknown edge" }); onGraphChange(); response.status(204).end(); } catch (e: unknown) { if (typeof e === "object" && e && "code" in e && e.code === "23503") return response.status(409).json({ error: "Edge is still linked to an exit or alert", affectedIds: [request.params.id] }); next(e); } });

  router.patch("/candidates/:id", async (request, response, next) => { const parsed = z.object({ decision: z.enum(["approved","rejected","needs_edit"]), version: z.number().int().positive() }).safeParse(request.body); if (!parsed.success) return response.status(400).json({ error: "Invalid review" }); try { const result = await db.query("UPDATE osm_candidates SET reviewer_decision=$1,import_status='reviewed',version=version+1,updated_at=now() WHERE id=$2 AND version=$3 RETURNING *", [parsed.data.decision,request.params.id,parsed.data.version]); if (!result.rowCount) return response.status(409).json({ error: "Candidate was changed elsewhere", affectedIds: [request.params.id] }); response.json(result.rows[0]); } catch (e) { next(e); } });

  router.put("/floors/:id", async (request, response, next) => {
    const parsed = floorSchema.safeParse({ ...request.body, id: request.params.id });
    if (!parsed.success) return response.status(400).json({ error: "Invalid floor", details: parsed.error.flatten() });
    const floor = parsed.data; const client = await db.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(`INSERT INTO floors(id,building_id,floor_number,boundary,local_width,local_height,map_transform,status,version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,1)
        ON CONFLICT(id) DO UPDATE SET boundary=$4,local_width=$5,local_height=$6,map_transform=$7,status=$8,version=floors.version+1,updated_at=now() WHERE floors.version=$9 RETURNING *`, [floor.id,floor.buildingId,floor.floorNumber,JSON.stringify(floor.boundary),floor.localWidth,floor.localHeight,JSON.stringify(floor.mapTransform),floor.status,floor.version]);
      if (!result.rowCount) { await client.query("ROLLBACK"); return response.status(409).json({ error: "Floor was changed elsewhere", affectedIds: [floor.id] }); }
      await client.query("DELETE FROM floor_features WHERE floor_id=$1", [floor.id]);
      for (const feature of floor.features) await client.query(`INSERT INTO floor_features(id,floor_id,kind,name,geometry,parent_feature_id,parent_edge,edge_position,connector_id,served_floors,is_exit,outdoor_position,linked_graph_node_id,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, [feature.id,floor.id,feature.kind,feature.name,JSON.stringify(feature.geometry),feature.parentFeatureId ?? null,feature.parentEdge ?? null,feature.edgePosition ?? null,feature.connectorId ?? null,feature.servedFloors ? JSON.stringify(feature.servedFloors) : null,feature.isExit,feature.outdoorPosition ? JSON.stringify(feature.outdoorPosition) : null,feature.linkedGraphNodeId ?? null,feature.status]);
      await client.query("COMMIT"); response.json(result.rows[0]);
    } catch (e) { await client.query("ROLLBACK"); next(e); } finally { client.release(); }
  });

  router.post("/alerts", async (request, response, next) => {
    const parsed = alertSchema.safeParse(request.body); if (!parsed.success) return response.status(400).json({ error: "Invalid alert", details: parsed.error.flatten() });
    const client = await db.connect(); const id = randomUUID();
    try { await client.query("BEGIN"); const edgeCheck = await client.query("SELECT id FROM route_edges WHERE id=ANY($1::text[])", [parsed.data.edgeIds]); if (edgeCheck.rowCount !== parsed.data.edgeIds.length) { await client.query("ROLLBACK"); return response.status(404).json({ error: "One or more route edges are unknown" }); } await client.query("INSERT INTO alerts(id,longitude,latitude,description) VALUES($1,$2,$3,$4)", [id,...parsed.data.coordinates,parsed.data.description]); for (const edgeId of parsed.data.edgeIds) await client.query("INSERT INTO alert_route_edges(alert_id,route_edge_id) VALUES($1,$2)", [id,edgeId]); await client.query("COMMIT"); onGraphChange(); response.status(201).json({ id }); } catch (e) { await client.query("ROLLBACK"); next(e); } finally { client.release(); }
  });
  router.patch("/alerts/:id/active", async (request, response, next) => { const parsed=z.object({active:z.boolean()}).safeParse(request.body); if(!parsed.success)return response.status(400).json({error:"Invalid alert state"}); try { const result=await db.query("UPDATE alerts SET active=$1 WHERE id=$2 RETURNING *",[parsed.data.active,request.params.id]); if(!result.rowCount)return response.status(404).json({error:"Unknown alert"}); onGraphChange();response.json(result.rows[0]); } catch(e){next(e);} });
  router.delete("/alerts/:id", async (request,response,next)=>{try{const result=await db.query("DELETE FROM alerts WHERE id=$1 RETURNING id",[request.params.id]);if(!result.rowCount)return response.status(404).json({error:"Unknown alert"});onGraphChange();response.status(204).end();}catch(e){next(e);}});
  return router;
}
