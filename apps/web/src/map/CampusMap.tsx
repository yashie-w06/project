import { useEffect, useRef } from "react";
import maplibregl, { GeoJSONSource, Map, Marker } from "maplibre-gl";
import type { Feature, LineString } from "geojson";
import type { CampusMapData, Coordinate } from "../types";

interface Props { data?: CampusMapData; start?: Coordinate; destination?: Coordinate; route?: Feature<LineString>; onPick?: (coordinate: Coordinate) => void; onBuilding?: (id: string) => void; }

export function CampusMap({ data, start, destination, route, onPick, onBuilding }: Props) {
  const container = useRef<HTMLDivElement>(null); const mapRef = useRef<Map | undefined>(undefined); const markers = useRef<Marker[]>([]);
  useEffect(() => {
    if (!container.current || mapRef.current) return;
    const map = new maplibregl.Map({ container: container.current, center: [75.8717, 22.7263], zoom: 16.5, style: { version: 8, sources: { osm: { type: "raster", tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"], tileSize: 256, attribution: "© OpenStreetMap contributors" } }, layers: [{ id: "osm", type: "raster", source: "osm" }] } });
    map.addControl(new maplibregl.NavigationControl(), "top-right"); map.addControl(new maplibregl.AttributionControl({ compact: true }));
    map.on("click", (event) => onPick?.([event.lngLat.lng, event.lngLat.lat])); mapRef.current = map;
    return () => { map.remove(); mapRef.current = undefined; };
  }, []);
  useEffect(() => {
    const map = mapRef.current; if (!map || !data) return;
    const install = () => {
      const sources: Array<[string, object]> = [["buildings",data.buildings],["references",data.referencePaths],["verified",data.verifiedPaths],["points",data.points]];
      for (const [id,value] of sources) { const existing=map.getSource(id) as GeoJSONSource|undefined; if(existing) existing.setData(value as never); else map.addSource(id,{type:"geojson",data:value as never}); }
      if(!map.getLayer("buildings-fill")) { map.addLayer({id:"buildings-fill",type:"fill",source:"buildings",paint:{"fill-color":"#d6a756","fill-opacity":0.38}}); map.addLayer({id:"buildings-line",type:"line",source:"buildings",paint:{"line-color":"#754d1d","line-width":2}}); map.on("click","buildings-fill",(e)=>{e.originalEvent.stopPropagation();const id=e.features?.[0]?.properties?.id;if(id)onBuilding?.(id);}); map.on("mouseenter","buildings-fill",()=>map.getCanvas().style.cursor="pointer"); map.on("mouseleave","buildings-fill",()=>map.getCanvas().style.cursor=""); }
      if(!map.getLayer("references")) map.addLayer({id:"references",type:"line",source:"references",paint:{"line-color":"#60707a","line-width":2,"line-dasharray":[2,2],"line-opacity":0.55}});
      if(!map.getLayer("verified-main")) map.addLayer({id:"verified-main",type:"line",source:"verified",filter:["==",["get","kind"],"main"],paint:{"line-color":"#157a58","line-width":5}});
      if(!map.getLayer("verified-shortcut")) map.addLayer({id:"verified-shortcut",type:"line",source:"verified",filter:["==",["get","kind"],"shortcut"],paint:{"line-color":"#cb6b2c","line-width":4,"line-dasharray":[1,1.5]}});
      if(!map.getLayer("points")) map.addLayer({id:"points",type:"circle",source:"points",paint:{"circle-radius":6,"circle-color":"#315aa9","circle-stroke-width":2,"circle-stroke-color":"#fff"}});
    }; if(map.loaded())install();else map.once("load",install);
  },[data,onBuilding]);
  useEffect(()=>{const map=mapRef.current;if(!map)return;markers.current.forEach(m=>m.remove());markers.current=[];if(start)markers.current.push(new maplibregl.Marker({color:"#156c54"}).setLngLat(start).addTo(map));if(destination)markers.current.push(new maplibregl.Marker({color:"#b23b34"}).setLngLat(destination).addTo(map));if(route){const source=map.getSource("active-route") as GeoJSONSource|undefined;if(source)source.setData(route);else if(map.loaded()){map.addSource("active-route",{type:"geojson",data:route});map.addLayer({id:"active-route",type:"line",source:"active-route",paint:{"line-color":"#182b49","line-width":7,"line-opacity":0.85}});}}},[start,destination,route]);
  return <div ref={container} className="campus-map" aria-label="Interactive SGSITS campus map" />;
}
