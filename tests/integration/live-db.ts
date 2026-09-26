import assert from "node:assert/strict";
import request from "supertest";
import { loadConfig } from "../../apps/api/src/config.js";
import { createDatabase } from "../../apps/api/src/db.js";
import { createApp } from "../../apps/api/src/server.js";

const prefix=`integration-${Date.now()}`;const nodeA=`${prefix}-a`,nodeB=`${prefix}-b`,nodeC=`${prefix}-c`;const mainAB=`${prefix}-main-ab`,mainBC=`${prefix}-main-bc`,shortcut=`${prefix}-shortcut`;const pointId=`${prefix}-point`;const floorId=`${prefix}-floor`;const messageText=`${prefix} visitor message`;
const a:[number,number]=[75.871,22.726],b:[number,number]=[75.8711,22.726],c:[number,number]=[75.8712,22.726];
const config=loadConfig();let db=createDatabase(config);let alertId:string|undefined;
async function cleanup(){const client=await db.connect();try{await client.query("BEGIN");if(alertId)await client.query("DELETE FROM alerts WHERE id=$1",[alertId]);await client.query("DELETE FROM messages WHERE description=$1",[messageText]);await client.query("DELETE FROM floors WHERE id=$1",[floorId]);await client.query("DELETE FROM outdoor_points WHERE id=$1",[pointId]);await client.query("DELETE FROM route_edges WHERE id=ANY($1::text[])",[[mainAB,mainBC,shortcut]]);await client.query("DELETE FROM route_nodes WHERE id=ANY($1::text[])",[[nodeA,nodeB,nodeC]]);await client.query("COMMIT");}catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}}

try{
  await cleanup();
  const counts=await db.query("SELECT (SELECT count(*)::int FROM buildings) buildings,(SELECT count(*)::int FROM osm_candidates) candidates");assert.equal(counts.rows[0].buildings,49);assert.equal(counts.rows[0].candidates,15);
  const honestNoRoute=await request(createApp(config,db)).post("/api/route").send({profile:"healthy",start:{kind:"outdoor",coordinates:a},destination:{kind:"outdoor",coordinates:c}});assert.equal(honestNoRoute.body.status,"no_route");assert.match(honestNoRoute.body.reason,/^No verified route available/);
  await db.query("INSERT INTO route_nodes(id,longitude,latitude) VALUES($1,$2,$3),($4,$5,$6),($7,$8,$9)",[nodeA,...a,nodeB,...b,nodeC,...c]);
  await db.query(`INSERT INTO route_edges(id,from_node_id,to_node_id,coordinates,kind,verified,published) VALUES
    ($1,$2,$3,$4,'main',true,true),($5,$3,$6,$7,'main',true,true),($8,$2,$6,$9,'shortcut',true,true)`,[mainAB,nodeA,nodeB,JSON.stringify([a,b]),mainBC,nodeC,JSON.stringify([b,c]),shortcut,JSON.stringify([a,c])]);
  let app=createApp(config,db);assert.equal((await request(app).get("/api/health")).status,200);assert.equal((await request(app).put(`/api/editor/nodes/${prefix}-anonymous`).send({coordinates:a,version:1})).status,401);
  const login=await request(app).post("/api/editor/login").send({email:config.EDITOR_EMAIL,password:config.EDITOR_PASSWORD});assert.equal(login.status,200);const token=login.body.token as string;const auth={Authorization:`Bearer ${token}`};
  const route=async(profile:string)=>request(app).post("/api/route").send({profile,start:{kind:"outdoor",coordinates:a},destination:{kind:"outdoor",coordinates:c}});
  const healthy=await route("healthy"),wheelchair=await route("wheelchair"),luggage=await route("heavy_luggage");assert.equal(healthy.body.status,"ok");assert.equal(wheelchair.body.status,"ok");assert.equal(luggage.body.status,"ok");assert.equal(healthy.body.geometry.coordinates.length,2);assert.equal(luggage.body.geometry.coordinates.length,2);assert.equal(wheelchair.body.geometry.coordinates.length,3);
  const message=await request(app).post("/api/messages").send({coordinates:b,description:messageText});assert.equal(message.status,201);const listed=await request(app).get("/api/editor/messages").set(auth);assert.ok(listed.body.messages.some((entry:{description:string})=>entry.description===messageText));
  const alert=await request(app).post("/api/editor/alerts").set(auth).send({coordinates:b,description:"Integration-only block",edgeIds:[shortcut]});assert.equal(alert.status,201);alertId=alert.body.id;const blocked=await route("healthy");assert.equal(blocked.body.geometry.coordinates.length,3);await request(app).patch(`/api/editor/alerts/${alertId}/active`).set(auth).send({active:false});const unblocked=await route("healthy");assert.equal(unblocked.body.geometry.coordinates.length,2);
  const point=await request(app).put(`/api/editor/points/${pointId}`).set(auth).send({name:"Integration point",coordinates:b,published:true,version:1});assert.equal(point.status,200);
  const building=(await db.query("SELECT id FROM buildings ORDER BY id LIMIT 1")).rows[0].id as string;const floor=await request(app).put(`/api/editor/floors/${floorId}`).set(auth).send({buildingId:building,floorNumber:99,boundary:{type:"Polygon",coordinates:[[[0,0],[100,0],[100,100],[0,100],[0,0]]]},localWidth:100,localHeight:100,mapTransform:{origin:a,xAxis:[.000001,0],yAxis:[0,-.000001]},status:"draft",version:1,features:[{id:`${prefix}-room`,kind:"room",name:"Test room",geometry:{x:10,y:10,width:20,height:20},isExit:false,status:"draft"}]});assert.equal(floor.status,200);
  await db.end();db=createDatabase(config);app=createApp(config,db);const persisted=await db.query("SELECT (SELECT count(*)::int FROM outdoor_points WHERE id=$1) point,(SELECT count(*)::int FROM floors WHERE id=$2) floor",[pointId,floorId]);assert.deepEqual(persisted.rows[0],{point:1,floor:1});assert.equal((await request(app).get("/api/map")).status,200);
  console.log("Live integration passed: counts, auth, persistence, restart, profiles, reports, block/unblock.");
}finally{await cleanup();await db.end();}
