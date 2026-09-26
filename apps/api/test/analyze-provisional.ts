import { readFile } from "node:fs/promises";
import { parseOsmXml } from "../src/osm/parse.js";
import type { LonLat, OsmWay } from "../src/osm/types.js";

const xml = await readFile("data/campus.osm", "utf8");
const extract = parseOsmXml(xml);
const coordinates = (way: OsmWay) =>
  way.nodeIds.map((id) => extract.nodes.get(id)!.coordinates);
const services = extract.ways.filter(
  (way) => way.tags.highway === "service" && way.tags.foot !== "no",
);
const buildings = extract.ways.filter(
  (way) => way.tags.building && way.tags.building !== "no",
);
const targetBuildings = buildings.filter((way) =>
  ["Central Library", "LT"].includes(way.tags.name ?? ""),
);

const parent = new Map<string, string>();
const find = (id: string): string => {
  const value = parent.get(id) ?? id;
  if (value === id) return id;
  const root = find(value);
  parent.set(id, root);
  return root;
};
const join = (a: string, b: string) => {
  const left = find(a),
    right = find(b);
  if (left !== right) parent.set(right, left);
};
for (const way of services) {
  way.nodeIds.forEach((id) => parent.set(id, parent.get(id) ?? id));
  for (let index = 1; index < way.nodeIds.length; index++)
    join(way.nodeIds[index - 1]!, way.nodeIds[index]!);
}

const origin: LonLat = [75.8717, 22.7263];
const project = ([lon, lat]: LonLat) => ({
  x: (lon - origin[0]) * 111_320 * Math.cos((origin[1] * Math.PI) / 180),
  y: (lat - origin[1]) * 110_540,
});
function closestOnSegment(point: LonLat, a: LonLat, b: LonLat) {
  const p = project(point),
    start = project(a),
    end = project(b);
  const dx = end.x - start.x,
    dy = end.y - start.y;
  const t = Math.max(
    0,
    Math.min(
      1,
      ((p.x - start.x) * dx + (p.y - start.y) * dy) / (dx * dx + dy * dy || 1),
    ),
  );
  const x = start.x + t * dx,
    y = start.y + t * dy;
  return {
    distance: Math.hypot(p.x - x, p.y - y),
    point: [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])] as LonLat,
  };
}
function nearestApproach(building: OsmWay) {
  let best:
    | {
        distance: number;
        boundary: LonLat;
        path: LonLat;
        wayId: string;
        component: string;
      }
    | undefined;
  const ring = coordinates(building);
  for (
    let boundaryIndex = 0;
    boundaryIndex < ring.length - 1;
    boundaryIndex++
  ) {
    const a = ring[boundaryIndex]!,
      b = ring[boundaryIndex + 1]!;
    for (let sample = 0; sample <= 20; sample++) {
      const t = sample / 20;
      const boundary = [
        a[0] + t * (b[0] - a[0]),
        a[1] + t * (b[1] - a[1]),
      ] as LonLat;
      for (const way of services) {
        const line = coordinates(way);
        for (let index = 0; index < line.length - 1; index++) {
          const candidate = closestOnSegment(
            boundary,
            line[index]!,
            line[index + 1]!,
          );
          if (!best || candidate.distance < best.distance)
            best = {
              distance: candidate.distance,
              boundary,
              path: candidate.point,
              wayId: way.id,
              component: find(way.nodeIds[0]!),
            };
        }
      }
    }
  }
  return best;
}

const components = new Set(services.flatMap((way) => way.nodeIds).map(find));
console.log(
  JSON.stringify(
    {
      source: "bundled campus.osm",
      serviceWays: services.map((way) => ({
        id: way.id,
        access: way.tags.access ?? null,
        nodes: way.nodeIds.length,
        component: find(way.nodeIds[0]!),
      })),
      components: components.size,
      approaches: targetBuildings.map((building) => ({
        building: building.tags.name,
        osmWayId: building.id,
        nearest: nearestApproach(building),
      })),
    },
    null,
    2,
  ),
);
