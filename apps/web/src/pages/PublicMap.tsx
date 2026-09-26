import { useEffect, useMemo, useState } from "react";
import type { Feature, LineString } from "geojson";
import { api } from "../api";
import { CampusMap } from "../map/CampusMap";
import type { CampusMapData, Coordinate, FloorDetails, RouteEndpoint, TravelProfile } from "../types";

const profileLabels: Record<TravelProfile,string> = { healthy: "Healthy", wheelchair: "Wheelchair", heavy_luggage: "Heavy luggage" };

export function PublicMap() {
  const [mapData,setMapData]=useState<CampusMapData>(); const [error,setError]=useState(""); const [mode,setMode]=useState<"start"|"destination"|"report">("start");
  const [pending,setPending]=useState<Coordinate>(); const [start,setStart]=useState<RouteEndpoint>(); const [destination,setDestination]=useState<RouteEndpoint>(); const [profile,setProfile]=useState<TravelProfile>("healthy");
  const [route,setRoute]=useState<Feature<LineString>>(); const [result,setResult]=useState<string[]>([]); const [selectedBuilding,setSelectedBuilding]=useState<string>(); const [floor,setFloor]=useState(0); const [floorData,setFloorData]=useState<FloorDetails>();
  const [query,setQuery]=useState(""); const [results,setResults]=useState<Array<{kind:string;id:string;name:string;longitude?:number;latitude?:number}>>([]); const [report,setReport]=useState("");
  useEffect(()=>{api.map().then(setMapData).catch(e=>setError(e.message));},[]);
  useEffect(()=>{if(selectedBuilding)api.floor(selectedBuilding,floor).then(setFloorData).catch(()=>setFloorData(undefined));},[selectedBuilding,floor]);
  useEffect(()=>{const id=setTimeout(()=>{if(query.trim().length>=2)api.search(query).then(r=>setResults(r.results)).catch(()=>setResults([]));else setResults([]);},250);return()=>clearTimeout(id);},[query]);
  const startCoordinate=start?.kind==="outdoor"?start.coordinates:undefined; const destinationCoordinate=destination?.kind==="outdoor"?destination.coordinates:undefined;
  const instruction=useMemo(()=>mode==="start"?"Choose your current location":mode==="destination"?"Choose your destination":"Tap the issue location",[mode]);
  function chooseCoordinate(coordinates: Coordinate){setPending(coordinates);}
  function confirm(){if(!pending)return;if(mode==="start"){setStart({kind:"outdoor",coordinates:pending});setMode("destination");}else if(mode==="destination")setDestination({kind:"outdoor",coordinates:pending});setPending(undefined);setRoute(undefined);setResult([]);}
  function locate(){navigator.geolocation?.getCurrentPosition(p=>{const c:Coordinate=[p.coords.longitude,p.coords.latitude];setPending(c);setResult([`GPS accuracy is approximately ${Math.round(p.coords.accuracy)} m. Confirm or correct the marker; GPS does not prove you are inside a building.`]);},()=>setError("Location permission was not available. Tap the map instead."),{enableHighAccuracy:true});}
  async function requestRoute(){if(!start||!destination)return;setError("");try{const response=await api.route(profile,start,destination);if(response.status==="ok"){setRoute({type:"Feature",properties:{},geometry:response.geometry});setResult(response.notices);}else{setRoute(undefined);setResult([response.reason,...response.notices]);}}catch(e){setError(e instanceof Error?e.message:"Route request failed");}}
  async function sendReport(){if(!pending||!report.trim())return;try{await api.message(pending,report);setReport("");setPending(undefined);setMode(start?"destination":"start");setResult(["Your note was received by the campus editor."]);}catch(e){setError(e instanceof Error?e.message:"Could not send note");}}
  return <main className="app-shell">
    <header className="topbar"><div><span className="eyebrow">SGSITS · Indore</span><h1>Campus Access</h1></div><a href="/edit/login">Editor sign in</a></header>
    <section className="workspace"><div className="map-wrap"><CampusMap data={mapData} start={startCoordinate} destination={destinationCoordinate} route={route} onPick={chooseCoordinate} onBuilding={id=>setSelectedBuilding(id)} /><div className="map-prompt"><b>{instruction}</b><span>{pending?`${pending[1].toFixed(6)}, ${pending[0].toFixed(6)} — confirm this marker`:"Tap anywhere on the map"}</span></div></div>
      <aside className="panel">
        <div className="steps"><span className={start?"done":"active"}>1 Start</span><span className={start&&!destination?"active":destination?"done":""}>2 Destination</span><span className={destination?"active":""}>3 Profile</span></div>
        <h2>{selectedBuilding?"Building details":instruction}</h2>
        {!selectedBuilding&&<><label className="field">Search a building, room, facility, gate, or point<input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Try Main gate" /></label>{results.length>0&&<ul className="search-results">{results.map(r=><li key={`${r.kind}-${r.id}`}><button onClick={()=>{if(r.kind==="building")setSelectedBuilding(r.id);else if(r.longitude!=null&&r.latitude!=null)setPending([r.longitude,r.latitude]);setQuery(r.name);setResults([]);}}><b>{r.name}</b><small>{r.kind}</small></button></li>)}</ul>}<div className="button-row"><button onClick={locate}>Use phone GPS</button><button className="quiet" onClick={()=>setMode("report")}>Send a map note</button></div>{pending&&mode!=="report"&&<button className="primary full" onClick={confirm}>Confirm this {mode}</button>}</>}
        {selectedBuilding&&<div className="building-panel"><button className="back" onClick={()=>setSelectedBuilding(undefined)}>← Back to route</button><label className="field">Floor<input type="number" value={floor} onChange={e=>setFloor(Number(e.target.value))}/></label>{floorData?<><p>{floorData.features.length} mapped items on this floor.</p><ul>{floorData.features.map(f=><li key={f.id}><span className={`feature-dot ${f.kind}`}/>{f.name||f.kind}</li>)}</ul><p className="muted">Indoor features are informational; no indoor turn-by-turn line is calculated.</p></>:<p className="empty">No floor layout mapped.</p>}</div>}
        {mode==="report"&&<div><label className="field">What should the editor know?<textarea maxLength={1000} value={report} onChange={e=>setReport(e.target.value)} /></label><button className="primary full" disabled={!pending||!report.trim()} onClick={sendReport}>Send note at marker</button></div>}
        {start&&destination&&mode!=="report"&&<div className="route-controls"><h3>Travel profile</h3><div className="profiles">{(Object.keys(profileLabels) as TravelProfile[]).map(p=><button key={p} className={profile===p?"selected":""} onClick={()=>setProfile(p)}>{profileLabels[p]}</button>)}</div><button className="primary full" onClick={requestRoute}>Find verified route</button></div>}
        {result.length>0&&<div className="notice">{result.map((n,i)=><p key={i}>{n}</p>)}</div>}{error&&<p className="error" role="alert">{error}</p>}
        <div className="legend"><span><i className="main-path"/>Verified main path</span><span><i className="shortcut-path"/>Shortcut</span><span><i className="reference-path"/>OSM reference only</span></div>
      </aside></section>
  </main>;
}
