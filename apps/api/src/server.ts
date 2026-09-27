import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express, { type ErrorRequestHandler } from "express";
import type { Feature, LineString, Polygon } from "geojson";
import {
  suggestBuildingApproach,
  type BuildingApproach,
} from "./building-approach.js";
import { loadConfig, type Config } from "./config.js";
import { checkDatabase, createDatabase, type Database } from "./db.js";
import { loadEffectiveNetworkState } from "./obstacles.js";
import { buildProvisionalOsmGraph } from "./osm/provisional.js";
import type {
  LonLat,
  OsmBuildingCandidate,
  OsmPathCandidate,
} from "./osm/types.js";
import { validCampusLine } from "./paths.js";
import { editorRoutes } from "./routes/editor.js";
import {
  publicRoutes,
  type NoRouteCode,
  type RouteResolver,
} from "./routes/public.js";
import { findRoute } from "./routing/astar.js";
import {
  snapToEligibleEdges,
  splitEdgeAtSnap,
  type SegmentSnap,
} from "./routing/geometry.js";
import {
  buildRoutingGraph,
  connectedComponents,
  edgeEligibleForProfile,
  edgeIsRoutable,
} from "./routing/graph.js";
import { splitEdgesAtSavedJunctions } from "./routing/split-paths.js";
import type { RouteEdge, RouteNode, TravelProfile } from "./routing/types.js";

type Endpoint =
  | { kind: "outdoor"; coordinates: LonLat }
  | {
      kind: "building";
      buildingId: string;
      approachCoordinates?: LonLat;
    };

const noRouteMessage: Record<NoRouteCode, string> = {
  NO_WALKABLE_GRAPH: "No mapped walking paths are available in this area yet.",
  START_UNREACHABLE:
    "No mapped walking path can be reached from this start; adjust the point.",
  DEST_UNREACHABLE:
    "No mapped walking path reaches this destination; adjust the point.",
  NO_PLAUSIBLE_APPROACH:
    "No nearby mapped walking path reaches an approach to this building.",
  DIFFERENT_COMPONENTS:
    "The mapped walking paths do not connect these points yet.",
  BLOCKED_OR_INELIGIBLE: "No available route for this profile right now.",
  NO_SUITABLE_WHEELCHAIR_ROUTE:
    "No suitable wheelchair route was found with current map data.",
};

type EndpointResolution =
  | { nodeId: string; selectedDoorId?: string; approach?: BuildingApproach }
  | { code: NoRouteCode };

function polygonFeature(geometry: Polygon, id?: string): Feature<Polygon> {
  return { type: "Feature", id, properties: {}, geometry };
}

function mergeRouteNodes(
  ...groups: readonly (readonly RouteNode[])[]
): RouteNode[] {
  const nodes = new Map<string, RouteNode>();
  for (const group of groups) {
    for (const node of group) {
      const existing = nodes.get(node.id);
      if (existing) {
        if (
          existing.coordinates[0] !== node.coordinates[0] ||
          existing.coordinates[1] !== node.coordinates[1]
        )
          throw new Error(`Conflicting coordinates for route node ${node.id}`);
        continue;
      }
      nodes.set(node.id, node);
    }
  }
  return [...nodes.values()];
}

function joinRouteGeometry(
  startApproach: BuildingApproach | undefined,
  route: LineString,
  destinationApproach: BuildingApproach | undefined,
): LineString {
  const coordinates: number[][] = [];
  const append = (values: readonly (readonly number[])[]) => {
    for (const value of values) {
      const last = coordinates.at(-1);
      if (!last || last[0] !== value[0] || last[1] !== value[1])
        coordinates.push([...value]);
    }
  };
  if (startApproach) append([startApproach.boundary, startApproach.network]);
  append(route.coordinates);
  if (destinationApproach)
    append([destinationApproach.network, destinationApproach.boundary]);
  return { type: "LineString", coordinates };
}

interface RouteBaseGraph {
  nodes: RouteNode[];
  edges: RouteEdge[];
  buildingModels: OsmBuildingCandidate[];
}

function cloneRouteBaseGraph(base: RouteBaseGraph): RouteBaseGraph {
  return {
    nodes: base.nodes.map((node) => ({
      ...node,
      coordinates: [...node.coordinates] as LonLat,
    })),
    edges: base.edges.map((edge) => ({
      ...edge,
      coordinates: edge.coordinates.map(
        (coordinate) => [...coordinate] as LonLat,
      ),
    })),
    buildingModels: base.buildingModels.map((building) => ({
      ...building,
      footprint: {
        ...building.footprint,
        geometry: {
          ...building.footprint.geometry,
          coordinates: building.footprint.geometry.coordinates.map((ring) =>
            ring.map((coordinate) => [...coordinate]),
          ),
        },
      },
    })),
  };
}

async function buildRouteBaseGraph(
  db: Database,
  blockedPathIds: ReadonlySet<string>,
): Promise<RouteBaseGraph> {
  const [nodeRows, edgeRows, candidateRows, buildingRows, snapRows] =
    await Promise.all([
      db.query("SELECT id,longitude,latitude FROM route_nodes"),
      db.query(
        "SELECT id,from_node_id,to_node_id,coordinates,kind,blocked,one_way,source_osm_id,name,note,version,surface,surface_condition,stairs,slope_percent,width_meters,wheelchair_access,confidence,observed_at FROM route_edges",
      ),
      db.query(
        "SELECT id,source_way_id,source_node_ids,coordinates,tags,reviewer_decision,provisional_exclusion_reason,blocked,note,version FROM osm_candidates",
      ),
      db.query(
        "SELECT id,name,source_osm_id,footprint,mapped_level_count FROM buildings",
      ),
      db.query(
        "SELECT * FROM path_snap_connections ORDER BY parent_feature_id,parent_segment_index,parent_segment_fraction",
      ),
    ]);
  const buildingModels: OsmBuildingCandidate[] = buildingRows.rows.map(
    (row) => ({
      id: row.id,
      sourceWayId: row.source_osm_id ?? row.id,
      name: row.name,
      levels: row.mapped_level_count,
      footprint: polygonFeature(row.footprint, row.id),
    }),
  );
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
    blocked: row.blocked || blockedPathIds.has(`osm-${row.source_way_id}`),
    note: row.note,
    version: row.version,
    geometry: {
      type: "Feature",
      properties: { sourceOsmWayId: row.source_way_id },
      geometry: { type: "LineString", coordinates: row.coordinates },
    },
  }));
  const promotedByWay = new Map(
    edgeRows.rows
      .filter((row) => row.source_osm_id)
      .map((row) => [row.source_osm_id as string, row]),
  );
  const graphCandidates = candidates.map((candidate) => {
    const promoted = promotedByWay.get(candidate.sourceWayId);
    return promoted
      ? {
          ...candidate,
          blocked:
            promoted.blocked ||
            blockedPathIds.has(`osm-${candidate.sourceWayId}`),
          note: promoted.note,
          version: promoted.version,
        }
      : candidate;
  });
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
  const osmJunctions = activeSnapRows
    .filter((row) => row.parent_source === "osm")
    .map((row) => {
      const node = nodeRows.rows.find(
        (item) => item.id === row.junction_node_id,
      );
      return {
        sourceWayId: row.parent_feature_id.replace(/^osm-/, ""),
        segmentIndex: row.parent_segment_index,
        segmentFraction: row.parent_segment_fraction,
        node: {
          id: row.junction_node_id,
          coordinates: (node
            ? [node.longitude, node.latitude]
            : row.coordinates) as LonLat,
        },
      };
    });
  const provisional = buildProvisionalOsmGraph({
    candidates: graphCandidates,
    buildings: buildingModels,
    junctions: osmJunctions,
  });
  const savedNodes: RouteNode[] = nodeRows.rows.map((row) => ({
    id: row.id,
    coordinates: [row.longitude, row.latitude] as LonLat,
  }));
  const nodes = mergeRouteNodes(savedNodes, provisional.nodes);
  const editorEdges: RouteEdge[] = edgeRows.rows
    .filter(
      (row) =>
        !row.source_osm_id &&
        validCampusLine(row.coordinates) &&
        (row.kind !== "shortcut" || validShortcutIds.has(row.id)),
    )
    .map((row) => ({
      id: row.id,
      parentFeatureId: row.id,
      fromNodeId: row.from_node_id,
      toNodeId: row.to_node_id,
      coordinates: row.coordinates,
      kind: row.kind,
      verified: false,
      status: "confirmed" as const,
      source: "editor" as const,
      blocked: row.blocked || blockedPathIds.has(row.id),
      oneWay: row.one_way,
      sourceOsmId: row.source_osm_id,
      name: row.name,
      note: row.note,
      version: row.version,
      surface: row.surface,
      surfaceCondition: row.surface_condition,
      stairs: row.stairs,
      slopePercent: row.slope_percent,
      widthMeters: row.width_meters,
      wheelchairAccess: row.wheelchair_access,
      confidence: row.confidence,
      observedAt: row.observed_at,
    }));
  const editorJunctions = activeSnapRows
    .filter((row) => row.parent_source === "editor")
    .map((row) => ({
      parentFeatureId: row.parent_feature_id as string,
      parentSegmentIndex: row.parent_segment_index as number,
      parentSegmentFraction: row.parent_segment_fraction as number,
      junctionNodeId: row.junction_node_id as string,
      coordinates: row.coordinates as LonLat,
    }));
  const splitEditor = splitEdgesAtSavedJunctions(
    editorEdges,
    savedNodes,
    editorJunctions,
  );
  return {
    nodes: mergeRouteNodes(nodes, splitEditor.nodes),
    edges: [...splitEditor.edges, ...provisional.edges],
    buildingModels,
  };
}

function createRouteResolver(db: Database, config: Config): RouteResolver {
  let cachedBaseGraph: { revision: string; graph: RouteBaseGraph } | undefined;
  return async (raw) => {
    const profile = raw.profile as TravelProfile;
    const start = raw.start as Endpoint;
    const destination = raw.destination as Endpoint;
    const network = await loadEffectiveNetworkState(db);
    if (!cachedBaseGraph || cachedBaseGraph.revision !== network.revision)
      cachedBaseGraph = {
        revision: network.revision,
        graph: await buildRouteBaseGraph(db, new Set(network.blockedPathIds)),
      };
    const baseGraph = cloneRouteBaseGraph(cachedBaseGraph.graph);
    let nodes = baseGraph.nodes;
    let edges = baseGraph.edges;
    const buildingModels = baseGraph.buildingModels;
    const notices: string[] = [];
    const snaps: Array<{
      original: LonLat;
      snapped: LonLat;
      distanceMetres: number;
    }> = [];
    const approaches: Array<{
      role: "start" | "destination";
      buildingId: string;
      boundary: [number, number];
      network: [number, number];
      approximate: true;
    }> = [];
    const fail = (code: NoRouteCode) => ({
      status: "no_route" as const,
      code,
      message: noRouteMessage[code],
      notices,
      networkRevision: network.revision,
    });
    if (
      !edges.some(
        (edge) =>
          edgeIsRoutable(edge) &&
          edgeEligibleForProfile(edge, profile) &&
          !edge.blocked,
      )
    )
      return fail(
        profile === "wheelchair"
          ? "NO_SUITABLE_WHEELCHAIR_ROUTE"
          : edges.some((edge) => edge.blocked)
            ? "BLOCKED_OR_INELIGIBLE"
            : "NO_WALKABLE_GRAPH",
      );

    async function addBuildingAccessNotice(buildingId: string) {
      if (profile !== "wheelchair") return;
      const result = await db.query(
        `SELECT EXISTS(SELECT 1 FROM floors WHERE building_id=$1 AND floor_number=0) AS ground_floor_saved,
          EXISTS(SELECT 1 FROM floor_features ff JOIN floors f ON f.id=ff.floor_id WHERE f.building_id=$1 AND f.floor_number=0 AND ff.kind='lift') AS has_lift`,
        [buildingId],
      );
      const access = result.rows[0];
      notices.push(
        !access?.ground_floor_saved
          ? "Lift information is not available for this building."
          : access.has_lift
            ? "Lift available."
            : "No lift is recorded in this building. Access to upper floors may be limited.",
      );
    }

    function splitAt(snap: SegmentSnap, role: "start" | "destination") {
      if (snap.endpointNodeId) return snap.endpointNodeId;
      const source = edges.find((edge) => edge.id === snap.edgeId);
      if (!source)
        throw new Error("Selected route segment is no longer available");
      const nodeId = `route-pick-${role}-${randomUUID()}`;
      const split = splitEdgeAtSnap(
        source,
        snap,
        nodeId,
        `${source.id}-${role}-a-${randomUUID()}`,
        `${source.id}-${role}-b-${randomUUID()}`,
      );
      edges = edges.filter((edge) => edge.id !== source.id);
      edges.push(...split.edges);
      nodes.push(split.node);
      return nodeId;
    }

    async function resolveEndpoint(
      endpoint: Endpoint,
      role: "start" | "destination",
    ): Promise<EndpointResolution> {
      const nodeMap = new Map(nodes.map((node) => [node.id, node]));
      if (endpoint.kind === "outdoor") {
        const snap = snapToEligibleEdges(
          endpoint.coordinates,
          edges,
          nodeMap,
          config.SNAP_RADIUS_METRES,
          { profile },
        );
        if (!snap) {
          const unblocked = edges.map((edge) => ({ ...edge, blocked: false }));
          const alternate = snapToEligibleEdges(
            endpoint.coordinates,
            unblocked,
            nodeMap,
            config.SNAP_RADIUS_METRES,
          );
          if (alternate) return { code: "BLOCKED_OR_INELIGIBLE" };
          return {
            code: role === "start" ? "START_UNREACHABLE" : "DEST_UNREACHABLE",
          };
        }
        snaps.push({
          original: endpoint.coordinates,
          snapped: snap.coordinates,
          distanceMetres: snap.distanceMetres,
        });
        return { nodeId: splitAt(snap, role) };
      }

      if (role === "destination")
        await addBuildingAccessNotice(endpoint.buildingId);
      const building = buildingModels.find(
        (item) => item.id === endpoint.buildingId,
      );
      if (!building) return { code: "NO_PLAUSIBLE_APPROACH" };
      const routableEdges = edges.filter(
        (edge) =>
          edgeIsRoutable(edge) &&
          edgeEligibleForProfile(edge, profile) &&
          !edge.blocked,
      );
      const savedDoor = await db.query(
        `SELECT outdoor_position FROM floor_features ff JOIN floors f ON f.id=ff.floor_id
         WHERE f.building_id=$1 AND f.floor_number=0 AND ff.kind='door'
           AND ff.outdoor_position IS NOT NULL
         ORDER BY CASE WHEN $2='start' AND ff.is_exit THEN 0 ELSE 1 END,ff.id LIMIT 1`,
        [endpoint.buildingId, role],
      );
      const preferredBoundary =
        endpoint.approachCoordinates ??
        (savedDoor.rows[0]?.outdoor_position as LonLat | undefined);
      const approach = suggestBuildingApproach({
        buildingId: endpoint.buildingId,
        footprint: building.footprint,
        allFootprints: buildingModels.map((item) => item.footprint),
        edges: routableEdges,
        nodes: nodeMap,
        requestedBoundary: preferredBoundary,
        maxGapMetres: 30,
      });
      if (!approach) return { code: "NO_PLAUSIBLE_APPROACH" };
      approaches.push({
        role,
        buildingId: endpoint.buildingId,
        boundary: [...approach.boundary],
        network: [...approach.network],
        approximate: true,
      });
      notices.push("Building approach.");
      return { nodeId: splitAt(approach.snap, role), approach };
    }

    const startResolution = await resolveEndpoint(start, "start");
    if ("code" in startResolution) return fail(startResolution.code);
    const destinationResolution = await resolveEndpoint(
      destination,
      "destination",
    );
    if ("code" in destinationResolution)
      return fail(destinationResolution.code);
    let graph = buildRoutingGraph({
      nodes,
      edges,
      profile,
      allowUnknownWheelchair: profile !== "wheelchair",
    });
    let route = findRoute(
      graph,
      startResolution.nodeId,
      destinationResolution.nodeId,
    );
    let conditionalWheelchairRoute = false;
    if (profile === "wheelchair" && !route) {
      graph = buildRoutingGraph({
        nodes,
        edges,
        profile,
        allowUnknownWheelchair: true,
      });
      route = findRoute(
        graph,
        startResolution.nodeId,
        destinationResolution.nodeId,
      );
      conditionalWheelchairRoute = Boolean(route);
    }
    if (!route) {
      if (profile === "wheelchair") return fail("NO_SUITABLE_WHEELCHAIR_ROUTE");
      const components = connectedComponents(graph);
      return components.componentByNodeId.get(startResolution.nodeId) !==
        components.componentByNodeId.get(destinationResolution.nodeId)
        ? fail("DIFFERENT_COMPONENTS")
        : fail("BLOCKED_OR_INELIGIBLE");
    }

    notices.push(
      ...snaps.map(
        () =>
          "The selected location was adjusted to the nearest connected path.",
      ),
    );
    if (route.segments.some((segment) => segment.status === "provisional"))
      notices.unshift(
        "Suggested route from map data; its paths and accessibility have not been field-verified.",
      );
    if (conditionalWheelchairRoute)
      notices.push("Accessibility details are missing on some paths.");
    const segments = route.segments.map((segment) => ({
      geometry: segment.geometry as LineString,
      pathId: segment.pathId,
      kind: segment.kind,
      note: segment.note,
      source: segment.source,
      sourceId: segment.pathId,
      accessibility: segment.accessibility,
      unknown: segment.unknown,
      constraints: segment.constraints,
    }));
    const currentNetwork = await loadEffectiveNetworkState(db);
    if (currentNetwork.revision !== network.revision)
      return {
        status: "route_changed" as const,
        message: "The mapped paths changed while this route was calculated.",
        networkRevision: currentNetwork.revision,
      };
    return {
      status: "ok" as const,
      geometry: joinRouteGeometry(
        startResolution.approach,
        route.geometry as LineString,
        destinationResolution.approach,
      ),
      segments,
      approaches,
      notices,
      snaps,
      networkRevision: network.revision,
    };
  };
}

export function createApp(
  config: Config = loadConfig(),
  db: Database = createDatabase(config),
) {
  const app = express();
  app.disable("x-powered-by");
  app.use(cors({ origin: config.WEB_ORIGIN, credentials: false }));
  app.use(express.json({ limit: "1mb" }));
  app.get("/api/health", async (_request, response) => {
    const database = await checkDatabase(db);
    response
      .status(database ? 200 : 503)
      .json({ process: "ok", database: database ? "ready" : "unavailable" });
  });
  let graphRevision = 0;
  app.use("/api", publicRoutes(db, createRouteResolver(db, config)));
  app.use(
    "/api/editor",
    editorRoutes(db, config, () => {
      graphRevision += 1;
    }),
  );
  app.get("/api/editor/graph-revision", (_request, response) =>
    response.json({ revision: graphRevision }),
  );
  app.use((_request, response) =>
    response.status(404).json({ error: "Not found" }),
  );
  const errors: ErrorRequestHandler = (error, _request, response, _next) => {
    console.error(config.NODE_ENV === "production" ? "Request failed" : error);
    response.status(500).json({ error: "Internal server error" });
  };
  app.use(errors);
  return app;
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  const config = loadConfig();
  const db = createDatabase(config);
  const app = createApp(config, db);
  const server = app.listen(config.PORT, "0.0.0.0", () =>
    console.log(`API listening on port ${config.PORT}`),
  );
  const close = () =>
    server.close(() => db.end().finally(() => process.exit(0)));
  process.on("SIGTERM", close);
  process.on("SIGINT", close);
}
