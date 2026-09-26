import express, { type ErrorRequestHandler } from "express";
import cors from "cors";
import { randomUUID } from "node:crypto";
import type { LineString } from "geojson";
import { loadConfig, type Config } from "./config.js";
import { checkDatabase, createDatabase, type Database } from "./db.js";
import { publicRoutes, type RouteResolver } from "./routes/public.js";
import { editorRoutes } from "./routes/editor.js";
import { buildRoutingGraph } from "./routing/graph.js";
import { findRoute } from "./routing/astar.js";
import { snapToVerifiedEdges, splitEdgeAtSnap } from "./routing/geometry.js";
import type { RouteEdge, RouteNode, TravelProfile } from "./routing/types.js";
import type { LonLat } from "./osm/types.js";

type Endpoint = { kind: "outdoor"; coordinates: LonLat } | { kind: "building"; buildingId: string; floor: number; exitDoorId?: string; entranceDoorId?: string; roomId?: string };

function createRouteResolver(db: Database, config: Config): RouteResolver {
  return async (raw) => {
    const profile = raw.profile as TravelProfile; const start = raw.start as Endpoint; const destination = raw.destination as Endpoint;
    const [nodeRows, edgeRows, blockRows] = await Promise.all([
      db.query("SELECT id,longitude,latitude FROM route_nodes"),
      db.query("SELECT id,from_node_id,to_node_id,coordinates,kind,verified,blocked,one_way,source_osm_id FROM route_edges WHERE verified AND published"),
      db.query("SELECT a.id,a.active,COALESCE(array_agg(are.route_edge_id) FILTER (WHERE are.route_edge_id IS NOT NULL),'{}') edge_ids FROM alerts a LEFT JOIN alert_route_edges are ON are.alert_id=a.id GROUP BY a.id"),
    ]);
    let nodes: RouteNode[] = nodeRows.rows.map((r) => ({ id:r.id, coordinates:[r.longitude,r.latitude] }));
    let edges: RouteEdge[] = edgeRows.rows.map((r) => ({ id:r.id, fromNodeId:r.from_node_id, toNodeId:r.to_node_id, coordinates:r.coordinates, kind:r.kind, verified:r.verified, blocked:r.blocked, oneWay:r.one_way, sourceOsmId:r.source_osm_id }));
    const activeBlocks = blockRows.rows.map((r) => ({ active:r.active, edgeIds:r.edge_ids }));
    const effectivelyBlocked = new Set<string>(); for (const edge of edges) if(edge.blocked) effectivelyBlocked.add(edge.id); for(const block of activeBlocks)if(block.active)for(const id of block.edgeIds)effectivelyBlocked.add(id);
    edges=edges.map(e=>effectivelyBlocked.has(e.id)?{...e,blocked:true}:e);
    const notices:string[]=[]; const snaps:Array<{original:LonLat;snapped:LonLat;distanceMetres:number}>=[];

    async function resolveEndpoint(endpoint:Endpoint, role:"start"|"destination"):Promise<string|null>{
      if(endpoint.kind==="building"){
        if(endpoint.roomId){const room=await db.query("SELECT 1 FROM floor_features ff JOIN floors f ON f.id=ff.floor_id WHERE ff.id=$1 AND ff.kind='room' AND f.building_id=$2 AND f.floor_number=$3 AND ff.status='published'",[endpoint.roomId,endpoint.buildingId,endpoint.floor]);if(!room.rowCount)return null;}
        const requested=role==="start"?endpoint.exitDoorId:endpoint.entranceDoorId;
        const door=await db.query(`SELECT ff.id,ff.linked_graph_node_id FROM floor_features ff JOIN floors f ON f.id=ff.floor_id
          WHERE f.building_id=$1 AND f.floor_number=0 AND ff.kind='door' AND ff.is_exit AND ff.status='published' AND f.status='published'
          AND ff.linked_graph_node_id IS NOT NULL AND ($2::text IS NULL OR ff.id=$2) ORDER BY ff.id LIMIT 1`,[endpoint.buildingId,requested??null]);
        if(!door.rowCount){notices.push(`No valid mapped ground-floor ${role==="start"?"exit":"entrance"} is linked to the verified walking graph.`);return null;}
        if(endpoint.floor!==0){const connectors=await db.query(`SELECT kind,connector_id,served_floors FROM floor_features ff JOIN floors f ON f.id=ff.floor_id WHERE f.building_id=$1 AND ff.status='published' AND f.status='published' AND kind IN ('lift','stairs')`,[endpoint.buildingId]);const lift=connectors.rows.some(c=>c.kind==="lift"&&Array.isArray(c.served_floors)&&c.served_floors.includes(endpoint.floor));const stairs=connectors.rows.some(c=>c.kind==="stairs"&&Array.isArray(c.served_floors)&&c.served_floors.includes(endpoint.floor));if(profile==="wheelchair")notices.push(lift?"A complete mapped lift connector serves the selected floor (compatible).":"Lift access for the selected floor is not mapped; verify accessibility before travel.");else if(profile==="heavy_luggage")notices.push(lift?"A mapped lift serves the selected floor and is preferred.":stairs?"Only mapped stairs serve this floor; heavy luggage may be difficult.":"Vertical access for this floor is not mapped.");else notices.push([lift&&"lift",stairs&&"stairs"].filter(Boolean).length?`Mapped vertical access: ${[lift&&"lift",stairs&&"stairs"].filter(Boolean).join(" and ")}.`:"Vertical access for this floor is not mapped.");}
        if(role==="destination"&&!endpoint.entranceDoorId)notices.push("A graph-linked entrance was suggested; you may override it before routing.");
        return door.rows[0].linked_graph_node_id;
      }
      const nodeMap=new Map(nodes.map(n=>[n.id,n]));const snap=snapToVerifiedEdges(endpoint.coordinates,edges,nodeMap,config.SNAP_RADIUS_METRES);if(!snap){notices.push(`${role === "start" ? "Start" : "Destination"} is not within the verified-route connection limit.`);return null;}snaps.push({original:endpoint.coordinates,snapped:snap.coordinates,distanceMetres:snap.distanceMetres});if(snap.endpointNodeId)return snap.endpointNodeId;
      const source=edges.find(e=>e.id===snap.edgeId)!;const nodeId=`route-pick-${role}-${randomUUID()}`;const split=splitEdgeAtSnap(source,snap,nodeId,`${source.id}-${role}-a-${randomUUID()}`,`${source.id}-${role}-b-${randomUUID()}`);edges=edges.filter(e=>e.id!==source.id);edges.push(...split.edges);nodes.push(split.node);return nodeId;
    }
    const startId=await resolveEndpoint(start,"start");const destinationId=await resolveEndpoint(destination,"destination");
    if(!startId||!destinationId)return {status:"no_route" as const,reason:"The selected locations cannot both connect to the verified walking graph.",notices};
    let graph;try{graph=buildRoutingGraph({nodes,edges,profile});}catch{return {status:"no_route" as const,reason:"The verified graph currently contains an invalid or disconnected edit.",notices};}
    const route=findRoute(graph,startId,destinationId);if(!route)return {status:"no_route" as const,reason:"No verified route connects these locations for the selected profile.",notices};
    notices.push(...snaps.map(s=>`A selected outdoor point was snapped ${s.distanceMetres.toFixed(1)} m to the verified path; the correction is shown on the map.`));
    const selectedEntranceDoorId=destination.kind==="building"?destination.entranceDoorId:undefined;
    return {status:"ok" as const,geometry:route.geometry as LineString,notices,selectedEntranceDoorId,snaps};
  };
}

export function createApp(config:Config=loadConfig(),db:Database=createDatabase(config)){
  const app=express();app.disable("x-powered-by");app.use(cors({origin:config.WEB_ORIGIN,credentials:false}));app.use(express.json({limit:"1mb"}));
  app.get("/api/health",async(_req,res)=>{const database=await checkDatabase(db);res.status(database?200:503).json({process:"ok",database:database?"ready":"unavailable"});});
  let graphRevision=0;app.use("/api",publicRoutes(db,createRouteResolver(db,config)));app.use("/api/editor",editorRoutes(db,config,()=>{graphRevision++;}));app.get("/api/editor/graph-revision",(_req,res)=>res.json({revision:graphRevision}));
  app.use((_req,res)=>res.status(404).json({error:"Not found"}));
  const errors:ErrorRequestHandler=(error,_req,res,_next)=>{console.error(config.NODE_ENV==="production"?"Request failed":error);res.status(500).json({error:"Internal server error"});};app.use(errors);return app;
}

if(process.env.NODE_ENV!=="test"){
  const config=loadConfig();const db=createDatabase(config);const app=createApp(config,db);const server=app.listen(config.PORT,"0.0.0.0",()=>console.log(`API listening on port ${config.PORT}`));
  const close=()=>server.close(()=>db.end().finally(()=>process.exit(0)));process.on("SIGTERM",close);process.on("SIGINT",close);
}
