import type { Feature, LineString, Polygon } from "geojson";
import type { Database } from "./db.js";
import { buildProvisionalOsmGraph } from "./osm/provisional.js";
import type {
  LonLat,
  OsmBuildingCandidate,
  OsmPathCandidate,
} from "./osm/types.js";

export type StoredPathFeature = {
  id: string;
  name: string;
  coordinates: LonLat[];
  source: "osm" | "editor";
  kind: "main" | "shortcut";
  blocked: boolean;
  note: string | null;
  version: number;
  sourceOsmId: string | null;
  sourceNodeIds: string[];
  tags: Record<string, string>;
  oneWay: boolean;
  /** OSM geometries can have internal source junctions. */
  parentCandidate?: OsmPathCandidate;
};

export function validCampusLine(coordinates: readonly LonLat[]): boolean {
  if (coordinates.length < 2) return false;
  return coordinates.every(
    ([longitude, latitude]) =>
      Number.isFinite(longitude) &&
      Number.isFinite(latitude) &&
      longitude >= 75.867 &&
      longitude <= 75.877 &&
      latitude >= 22.722 &&
      latitude <= 22.73,
  );
}

function buildingModels(
  rows: Array<Record<string, any>>,
): OsmBuildingCandidate[] {
  return rows.map((row) => ({
    id: row.id,
    sourceWayId: row.source_osm_id ?? row.id,
    name: row.name,
    levels: row.mapped_level_count,
    footprint: {
      type: "Feature",
      id: row.id,
      properties: {},
      geometry: row.footprint as Polygon,
    } satisfies Feature<Polygon>,
  }));
}

export async function loadStoredPathFeatures(
  db: Database,
): Promise<StoredPathFeature[]> {
  const [candidateRows, edgeRows, buildings, snapRows] = await Promise.all([
    db.query(
      "SELECT id,source_way_id,source_node_ids,coordinates,tags,reviewer_decision,provisional_exclusion_reason,blocked,note,version FROM osm_candidates ORDER BY source_way_id",
    ),
    db.query(
      "SELECT id,from_node_id,to_node_id,coordinates,kind,blocked,one_way,source_osm_id,name,note,version FROM route_edges ORDER BY id",
    ),
    db.query(
      "SELECT id,name,source_osm_id,footprint,mapped_level_count FROM buildings",
    ),
    db.query(
      "SELECT shortcut_path_id,parent_feature_id,parent_source,parent_version FROM path_snap_connections",
    ),
  ]);

  const candidates: OsmPathCandidate[] = candidateRows.rows.map((row) => ({
    id: row.id,
    sourceWayId: row.source_way_id,
    orderedNodeIds: row.source_node_ids,
    coordinates: row.coordinates,
    tags: row.tags ?? {},
    barrierNodeIds:
      row.provisional_exclusion_reason === "blocked_by_barrier"
        ? ["legacy-barrier-exclusion"]
        : [],
    importStatus: "imported",
    reviewerDecision: row.reviewer_decision ?? "pending",
    geometry: {
      type: "Feature",
      properties: { sourceOsmWayId: row.source_way_id },
      geometry: { type: "LineString", coordinates: row.coordinates },
    },
  }));
  const models = buildingModels(buildings.rows);
  const graph = buildProvisionalOsmGraph({ candidates, buildings: models });
  const eligibleWayIds = new Set(
    graph.edges.map((edge) => edge.sourceOsmId).filter(Boolean),
  );
  const activeSnapRows = snapRows.rows.filter((snap) => {
    if (snap.parent_source === "editor") {
      const parent = edgeRows.rows.find(
        (edge) => edge.id === snap.parent_feature_id,
      );
      return parent?.version === snap.parent_version;
    }
    const way = String(snap.parent_feature_id).replace(/^osm-/, "");
    const promoted = edgeRows.rows.find((edge) => edge.source_osm_id === way);
    const candidate = candidateRows.rows.find(
      (row) => row.source_way_id === way,
    );
    return (promoted?.version ?? candidate?.version) === snap.parent_version;
  });
  const validShortcutIds = new Set(
    [...new Set(activeSnapRows.map((snap) => snap.shortcut_path_id))].filter(
      (id) =>
        activeSnapRows.filter((snap) => snap.shortcut_path_id === id).length ===
        2,
    ),
  );
  const editorFeatures: StoredPathFeature[] = [];
  const editorIds = new Set<string>();
  for (const row of edgeRows.rows) {
    if (row.kind === "shortcut" && !validShortcutIds.has(row.id)) continue;
    const coordinates = row.coordinates as LonLat[];
    if (!validCampusLine(coordinates)) continue;
    const sourceOsmId = row.source_osm_id as string | null;
    if (sourceOsmId && !eligibleWayIds.has(sourceOsmId)) continue;
    editorIds.add(row.id);
    if (sourceOsmId) editorIds.add(`osm-${sourceOsmId}`);
    editorFeatures.push({
      id: row.id,
      name: row.name ?? "",
      coordinates,
      source: sourceOsmId ? "osm" : "editor",
      kind: row.kind,
      blocked: row.blocked,
      note: row.note,
      version: row.version,
      sourceOsmId,
      sourceNodeIds: [],
      tags: {},
      oneWay: row.one_way,
    });
  }

  const osmFeatures: StoredPathFeature[] = candidateRows.rows.flatMap((row) => {
    const id = `osm-${row.source_way_id}`;
    if (!eligibleWayIds.has(row.source_way_id) || editorIds.has(id)) return [];
    const candidate = candidates.find(
      (item) => item.sourceWayId === row.source_way_id,
    )!;
    return [
      {
        id,
        name: candidate.tags.name ?? "",
        coordinates: [...candidate.coordinates],
        source: "osm" as const,
        kind: "main" as const,
        blocked: row.blocked,
        note: row.note,
        version: row.version,
        sourceOsmId: row.source_way_id,
        sourceNodeIds: [...candidate.orderedNodeIds],
        tags: { ...candidate.tags },
        oneWay: candidate.tags["oneway:foot"] === "yes",
        parentCandidate: candidate,
      },
    ];
  });

  const paths = [...editorFeatures, ...osmFeatures].sort((a, b) =>
    a.id.localeCompare(b.id, "en", { numeric: true }),
  );
  let unnamed = 0;
  return paths.map((path) => ({
    ...path,
    name: path.name.trim() || `Path ${String(++unnamed).padStart(2, "0")}`,
  }));
}

export function pathAsFeature(path: StoredPathFeature) {
  return {
    type: "Feature" as const,
    id: path.id,
    properties: {
      id: path.id,
      name: path.name,
      kind: path.kind,
      blocked: path.blocked,
      note: path.note,
      source: path.source,
      version: path.version,
    },
    geometry: {
      type: "LineString" as const,
      coordinates: path.coordinates.map(([lon, lat]) => [lon, lat]),
    },
  } satisfies Feature<LineString>;
}
