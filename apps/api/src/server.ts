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
import { buildProvisionalOsmGraph } from "./osm/provisional.js";
import type {
  LonLat,
  OsmBuildingCandidate,
  OsmPathCandidate,
  OsmReviewDecision,
} from "./osm/types.js";
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
import type { RouteEdge, RouteNode, TravelProfile } from "./routing/types.js";

type Endpoint =
  | { kind: "outdoor"; coordinates: LonLat }
  | {
      kind: "building";
      buildingId: string;
      floor: number;
      exitDoorId?: string;
      entranceDoorId?: string;
      roomId?: string;
      approachCoordinates?: LonLat;
    };

const noRouteMessage: Record<NoRouteCode, string> = {
  NO_WALKABLE_GRAPH: "No mapped walking paths are available in this area yet.",
  START_UNREACHABLE:
    "No mapped walking path can be reached from this start; adjust the point or exit side.",
  DEST_UNREACHABLE:
    "No mapped walking path reaches this destination; adjust the point or entrance side.",
  NO_PLAUSIBLE_APPROACH:
    "Choose an entrance/exit side on the building boundary to continue.",
  DIFFERENT_COMPONENTS:
    "The mapped walking paths do not connect these points yet.",
  BLOCKED_OR_INELIGIBLE: "No available route for this profile right now.",
};

type EndpointResolution =
  | { nodeId: string; selectedDoorId?: string; approach?: BuildingApproach }
  | { code: NoRouteCode };

function polygonFeature(geometry: Polygon, id?: string): Feature<Polygon> {
  return { type: "Feature", id, properties: {}, geometry };
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

function createRouteResolver(db: Database, config: Config): RouteResolver {
  return async (raw) => {
    const profile = raw.profile as TravelProfile;
    const start = raw.start as Endpoint;
    const destination = raw.destination as Endpoint;
    const [nodeRows, edgeRows, candidateRows, buildingRows, blockRows] =
      await Promise.all([
        db.query("SELECT id,longitude,latitude FROM route_nodes"),
        db.query(
          "SELECT id,from_node_id,to_node_id,coordinates,kind,verified,blocked,one_way,source_osm_id FROM route_edges WHERE verified AND published",
        ),
        db.query(
          "SELECT id,source_way_id,source_node_ids,coordinates,tags,reviewer_decision FROM osm_candidates",
        ),
        db.query(
          "SELECT id,name,source_osm_id,footprint,mapped_level_count FROM buildings",
        ),
        db.query(
          "SELECT a.id,a.active,COALESCE(array_agg(are.route_edge_id) FILTER (WHERE are.route_edge_id IS NOT NULL),'{}') edge_ids FROM alerts a LEFT JOIN alert_route_edges are ON are.alert_id=a.id GROUP BY a.id",
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
    const decisions = new Map<string, OsmReviewDecision | null>(
      candidateRows.rows.map((row) => [
        row.source_way_id,
        row.reviewer_decision,
      ]),
    );
    const candidates: OsmPathCandidate[] = candidateRows.rows.map((row) => ({
      id: row.id,
      sourceWayId: row.source_way_id,
      orderedNodeIds: row.source_node_ids,
      coordinates: row.coordinates,
      tags: row.tags ?? {},
      barrierNodeIds: [],
      importStatus: "imported",
      reviewerDecision: row.reviewer_decision ?? "pending",
      geometry: {
        type: "Feature",
        properties: { sourceOsmWayId: row.source_way_id, referenceOnly: true },
        geometry: { type: "LineString", coordinates: row.coordinates },
      },
    }));
    const provisional = buildProvisionalOsmGraph({
      candidates,
      buildings: buildingModels,
      decisions,
    });
    let nodes: RouteNode[] = [
      ...nodeRows.rows.map((row) => ({
        id: row.id,
        coordinates: [row.longitude, row.latitude] as LonLat,
      })),
      ...provisional.nodes,
    ];
    const duplicateNodeIds = new Set<string>();
    nodes = nodes.filter((node) => {
      if (duplicateNodeIds.has(node.id)) return false;
      duplicateNodeIds.add(node.id);
      return true;
    });
    let edges: RouteEdge[] = [
      ...edgeRows.rows.map((row) => ({
        id: row.id,
        fromNodeId: row.from_node_id,
        toNodeId: row.to_node_id,
        coordinates: row.coordinates,
        kind: row.kind,
        verified: true,
        status: "confirmed" as const,
        source: "editor" as const,
        blocked: row.blocked,
        oneWay: row.one_way,
        sourceOsmId: row.source_osm_id,
      })),
      ...provisional.edges,
    ];
    const activeBlocks = blockRows.rows.map((row) => ({
      active: row.active,
      edgeIds: row.edge_ids,
    }));
    const blockedIds = new Set<string>();
    for (const edge of edges) if (edge.blocked) blockedIds.add(edge.id);
    for (const block of activeBlocks)
      if (block.active) for (const id of block.edgeIds) blockedIds.add(id);
    edges = edges.map((edge) =>
      blockedIds.has(edge.id) ? { ...edge, blocked: true } : edge,
    );

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
    });
    if (
      !edges.some(
        (edge) =>
          edgeIsRoutable(edge) &&
          edgeEligibleForProfile(edge, profile) &&
          !edge.blocked,
      )
    )
      return fail("NO_WALKABLE_GRAPH");

    async function addVerticalAccessNotice(
      endpoint: Extract<Endpoint, { kind: "building" }>,
    ) {
      if (endpoint.floor === 0) return;
      const connectors = await db.query(
        "SELECT kind,connector_id,served_floors FROM floor_features ff JOIN floors f ON f.id=ff.floor_id WHERE f.building_id=$1 AND ff.status='published' AND f.status='published' AND kind IN ('lift','stairs')",
        [endpoint.buildingId],
      );
      const serves = (kind: string) =>
        connectors.rows.some(
          (item) =>
            item.kind === kind &&
            Array.isArray(item.served_floors) &&
            item.served_floors.includes(endpoint.floor),
        );
      const lift = serves("lift"),
        stairs = serves("stairs");
      if (profile === "wheelchair")
        notices.push(
          lift
            ? "A published lift marker serves the selected floor; provisional outdoor accessibility is still unverified."
            : "Lift access for the selected floor is not mapped; verify accessibility before travel.",
        );
      else if (profile === "heavy_luggage")
        notices.push(
          lift
            ? "A mapped lift serves the selected floor and is preferred."
            : stairs
              ? "Only mapped stairs serve this floor; heavy luggage may be difficult."
              : "Vertical access for this floor is not mapped.",
        );
      else
        notices.push(
          lift || stairs
            ? `Mapped vertical access: ${[lift && "lift", stairs && "stairs"].filter(Boolean).join(" and ")}.`
            : "Vertical access for this floor is not mapped.",
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

      await addVerticalAccessNotice(endpoint);
      const requestedDoorId =
        role === "start" ? endpoint.exitDoorId : endpoint.entranceDoorId;
      const door = await db.query(
        `SELECT ff.id,ff.linked_graph_node_id FROM floor_features ff JOIN floors f ON f.id=ff.floor_id
         JOIN route_nodes n ON n.id=ff.linked_graph_node_id
         WHERE f.building_id=$1 AND f.floor_number=0 AND ff.kind='door' AND ff.is_exit
         AND ff.status='published' AND f.status='published' AND ff.outdoor_position IS NOT NULL
         AND ff.geometry->'parent'->>'kind'='exterior'
         AND EXISTS (SELECT 1 FROM route_edges e WHERE e.kind='main' AND e.verified AND e.published AND (e.from_node_id=n.id OR e.to_node_id=n.id))
         AND ($2::text IS NULL OR ff.id=$2) ORDER BY ff.id LIMIT 1`,
        [endpoint.buildingId, requestedDoorId ?? null],
      );
      if (door.rowCount && nodeMap.has(door.rows[0].linked_graph_node_id)) {
        return {
          nodeId: door.rows[0].linked_graph_node_id,
          selectedDoorId: door.rows[0].id,
        };
      }

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
      const approach = suggestBuildingApproach({
        buildingId: endpoint.buildingId,
        footprint: building.footprint,
        allFootprints: buildingModels.map((item) => item.footprint),
        edges: routableEdges,
        nodes: nodeMap,
        requestedBoundary: endpoint.approachCoordinates,
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
      notices.push(
        `${role === "start" ? "Exit" : "Entrance"} is an approximate building-boundary approach; the ${role === "start" ? "exit" : "entrance"} is unconfirmed.`,
      );
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
    let graph;
    try {
      graph = buildRoutingGraph({ nodes, edges, profile });
    } catch {
      return fail("DIFFERENT_COMPONENTS");
    }
    const route = findRoute(
      graph,
      startResolution.nodeId,
      destinationResolution.nodeId,
    );
    if (!route) {
      const components = connectedComponents(graph);
      return components.componentByNodeId.get(startResolution.nodeId) !==
        components.componentByNodeId.get(destinationResolution.nodeId)
        ? fail("DIFFERENT_COMPONENTS")
        : fail("BLOCKED_OR_INELIGIBLE");
    }

    const containsProvisional =
      route.segments.some((segment) => segment.status === "provisional") ||
      approaches.length > 0;
    if (containsProvisional)
      notices.unshift(
        "Suggested route based on map data; paths and accessibility have not been field-verified.",
      );
    notices.push(
      ...snaps.map(
        (snap) =>
          `A selected outdoor point was snapped ${snap.distanceMetres.toFixed(1)} m to the mapped path; the correction is shown on the map.`,
      ),
    );
    const approachGeometry = (from: LonLat, to: LonLat): LineString => ({
      type: "LineString",
      coordinates: [[...from], [...to]],
    });
    const segments = [
      ...(startResolution.approach
        ? [
            {
              geometry: approachGeometry(
                startResolution.approach.boundary,
                startResolution.approach.network,
              ),
              source: "approach" as const,
              confidence: "approximate" as const,
            },
          ]
        : []),
      ...route.segments.map((segment) => ({
        geometry: segment.geometry as LineString,
        source:
          segment.source === "osm" ? ("osm" as const) : ("editor" as const),
        confidence: segment.status,
        sourceId: segment.sourceOsmId ?? segment.edgeId,
      })),
      ...(destinationResolution.approach
        ? [
            {
              geometry: approachGeometry(
                destinationResolution.approach.network,
                destinationResolution.approach.boundary,
              ),
              source: "approach" as const,
              confidence: "approximate" as const,
            },
          ]
        : []),
    ];
    return {
      status: "ok" as const,
      geometry: joinRouteGeometry(
        startResolution.approach,
        route.geometry as LineString,
        destinationResolution.approach,
      ),
      segments,
      approaches,
      containsProvisional,
      notices,
      selectedEntranceDoorId:
        destination.kind === "building"
          ? destinationResolution.selectedDoorId
          : undefined,
      snaps,
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
