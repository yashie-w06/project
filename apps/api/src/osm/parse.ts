import { XMLParser } from "fast-xml-parser";
import type { Feature, LineString, Polygon } from "geojson";
import type {
  LonLat,
  OsmBuildingCandidate,
  OsmCandidateSegment,
  OsmExtract,
  OsmImportModel,
  OsmNode,
  OsmPathCandidate,
  OsmTags,
  OsmWay,
} from "./types.js";

type XmlRecord = Record<string, unknown>;

const asArray = <T>(value: T | readonly T[] | undefined): readonly T[] => {
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value]) as readonly T[];
};

const stringAttribute = (record: XmlRecord, key: string): string => {
  const value = record[`@_${key}`];
  if (value === undefined || value === null)
    throw new Error(`Missing OSM attribute ${key}`);
  return String(value);
};

const finiteAttribute = (record: XmlRecord, key: string): number => {
  const value = Number(stringAttribute(record, key));
  if (!Number.isFinite(value))
    throw new Error(`Invalid OSM numeric attribute ${key}`);
  return value;
};

function parseTags(value: unknown): OsmTags {
  const tags: Record<string, string> = {};
  for (const raw of asArray(
    value as XmlRecord | readonly XmlRecord[] | undefined,
  )) {
    const key = stringAttribute(raw, "k");
    tags[key] = stringAttribute(raw, "v");
  }
  return Object.freeze(tags);
}

export function parseOsmXml(xml: string): OsmExtract {
  const parser = new XMLParser({
    ignoreAttributes: false,
    parseAttributeValue: false,
  });
  const parsed = parser.parse(xml) as { osm?: XmlRecord };
  if (!parsed.osm) throw new Error("Invalid OSM XML: missing osm root");
  const root = parsed.osm;
  const nodes = new Map<string, OsmNode>();
  for (const raw of asArray(
    root.node as XmlRecord | readonly XmlRecord[] | undefined,
  )) {
    const node: OsmNode = Object.freeze({
      id: stringAttribute(raw, "id"),
      coordinates: Object.freeze([
        finiteAttribute(raw, "lon"),
        finiteAttribute(raw, "lat"),
      ]) as LonLat,
      tags: parseTags(raw.tag),
    });
    if (nodes.has(node.id)) throw new Error(`Duplicate OSM node ${node.id}`);
    nodes.set(node.id, node);
  }

  const ways: OsmWay[] = asArray(
    root.way as XmlRecord | readonly XmlRecord[] | undefined,
  ).map((raw) =>
    Object.freeze({
      id: stringAttribute(raw, "id"),
      nodeIds: Object.freeze(
        asArray(raw.nd as XmlRecord | readonly XmlRecord[] | undefined).map(
          (nd) => stringAttribute(nd, "ref"),
        ),
      ),
      tags: parseTags(raw.tag),
    }),
  );
  ways.sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));

  const rawBounds = asArray(
    root.bounds as XmlRecord | readonly XmlRecord[] | undefined,
  )[0];
  const bounds = rawBounds
    ? Object.freeze({
        minLongitude: finiteAttribute(rawBounds, "minlon"),
        minLatitude: finiteAttribute(rawBounds, "minlat"),
        maxLongitude: finiteAttribute(rawBounds, "maxlon"),
        maxLatitude: finiteAttribute(rawBounds, "maxlat"),
      })
    : null;
  return Object.freeze({ bounds, nodes, ways: Object.freeze(ways) });
}

function coordinatesForWay(
  extract: OsmExtract,
  way: OsmWay,
): readonly LonLat[] {
  return Object.freeze(
    way.nodeIds.map((id) => {
      const node = extract.nodes.get(id);
      if (!node)
        throw new Error(`OSM way ${way.id} references missing node ${id}`);
      return node.coordinates;
    }),
  );
}

function numericLevels(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

export function extractOsmImportModel(extract: OsmExtract): OsmImportModel {
  const buildings: OsmBuildingCandidate[] = [];
  const pathCandidates: OsmPathCandidate[] = [];
  const pathSegments: OsmCandidateSegment[] = [];

  for (const way of extract.ways) {
    if (way.tags.building && way.tags.building !== "no") {
      const coordinates = coordinatesForWay(extract, way);
      if (coordinates.length >= 4 && way.nodeIds[0] === way.nodeIds.at(-1)) {
        const footprint: Feature<Polygon> = {
          type: "Feature",
          properties: { sourceOsmWayId: way.id },
          geometry: {
            type: "Polygon",
            coordinates: [coordinates.map(([lon, lat]) => [lon, lat])],
          },
        };
        Object.freeze(footprint.geometry.coordinates[0]);
        Object.freeze(footprint.geometry.coordinates);
        Object.freeze(footprint.geometry);
        Object.freeze(footprint.properties);
        Object.freeze(footprint);
        buildings.push(
          Object.freeze({
            id: `osm-building-${way.id}`,
            sourceWayId: way.id,
            name: way.tags.name ?? null,
            levels: numericLevels(
              way.tags["building:levels"] ?? way.tags.levels,
            ),
            footprint,
          }),
        );
      }
    }

    if (way.tags.highway && way.nodeIds.length >= 2) {
      const coordinates = coordinatesForWay(extract, way);
      const id = `osm-path-${way.id}`;
      const geometry: Feature<LineString> = {
        type: "Feature",
        properties: { sourceOsmWayId: way.id, referenceOnly: true },
        geometry: {
          type: "LineString",
          coordinates: coordinates.map(([lon, lat]) => [lon, lat]),
        },
      };
      Object.freeze(geometry.geometry.coordinates);
      Object.freeze(geometry.geometry);
      Object.freeze(geometry.properties);
      Object.freeze(geometry);
      pathCandidates.push(
        Object.freeze({
          id,
          sourceWayId: way.id,
          orderedNodeIds: way.nodeIds,
          coordinates,
          tags: way.tags,
          barrierNodeIds: Object.freeze(
            way.nodeIds.filter((nodeId) => {
              const tags = extract.nodes.get(nodeId)?.tags;
              return Boolean(
                tags?.barrier &&
                !["entrance", "gate", "lift_gate", "sally_port"].includes(
                  tags.barrier,
                ) &&
                !["yes", "permissive", "designated"].includes(
                  tags.foot ?? tags.access ?? "",
                ),
              );
            }),
          ),
          importStatus: "imported",
          reviewerDecision: "pending",
          geometry,
        }),
      );
      for (let index = 0; index < coordinates.length - 1; index += 1) {
        pathSegments.push(
          Object.freeze({
            id: `${id}:segment:${index}`,
            candidateId: id,
            sourceWayId: way.id,
            fromNodeId: way.nodeIds[index]!,
            toNodeId: way.nodeIds[index + 1]!,
            coordinates: Object.freeze([
              coordinates[index]!,
              coordinates[index + 1]!,
            ] as const),
          }),
        );
      }
    }
  }
  return Object.freeze({
    buildings: Object.freeze(buildings),
    pathCandidates: Object.freeze(pathCandidates),
    pathSegments: Object.freeze(pathSegments),
  });
}

export function parseOsmImportModel(xml: string): OsmImportModel {
  return extractOsmImportModel(parseOsmXml(xml));
}
