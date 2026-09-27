import assert from "node:assert/strict";
import test from "node:test";
import type { LonLat } from "../osm/types.js";
import { findRoute } from "./astar.js";
import {
  snapToEdge,
  snapToVerifiedEdges,
  splitEdgeAtSnap,
} from "./geometry.js";
import {
  buildRoutingGraph,
  connectedComponents,
  InvalidGraphError,
} from "./graph.js";
import { createLocalProjection, distanceMetres } from "./projection.js";
import type {
  ActiveBlock,
  RouteEdge,
  RouteNode,
  TravelProfile,
} from "./types.js";

const coordinate = (longitudeOffset: number, latitudeOffset = 0): LonLat =>
  [75.87 + longitudeOffset, 22.725 + latitudeOffset] as const;
const nodes: RouteNode[] = [
  { id: "a", coordinates: coordinate(0) },
  { id: "b", coordinates: coordinate(0.001) },
  { id: "c", coordinates: coordinate(0.002) },
];
const edges: RouteEdge[] = [
  {
    id: "main-ab",
    fromNodeId: "a",
    toNodeId: "b",
    coordinates: [nodes[0]!.coordinates, nodes[1]!.coordinates],
    kind: "main",
    verified: true,
  },
  {
    id: "shortcut-bc",
    fromNodeId: "b",
    toNodeId: "c",
    coordinates: [nodes[1]!.coordinates, nodes[2]!.coordinates],
    kind: "shortcut",
    verified: true,
  },
  {
    id: "unverified-ac",
    fromNodeId: "a",
    toNodeId: "c",
    coordinates: [nodes[0]!.coordinates, nodes[2]!.coordinates],
    kind: "main",
    verified: false,
  },
];

function route(
  profile: TravelProfile,
  activeBlocks: readonly ActiveBlock[] = [],
) {
  return findRoute(
    buildRoutingGraph({ nodes, edges, profile, activeBlocks }),
    "a",
    "c",
  );
}

test("legacy verification flags do not gate paths; wheelchair still excludes shortcuts", () => {
  assert.deepEqual(route("healthy")?.edgeIds, ["unverified-ac"]);
  assert.deepEqual(route("heavy_luggage")?.edgeIds, ["unverified-ac"]);
  assert.deepEqual(route("wheelchair")?.edgeIds, ["unverified-ac"]);
  assert.ok(
    findRoute(
      buildRoutingGraph({
        nodes,
        edges: edges.slice(0, 2),
        profile: "healthy",
      }),
      "a",
      "c",
    ),
  );
  assert.equal(
    findRoute(
      buildRoutingGraph({
        nodes,
        edges: edges.slice(0, 2),
        profile: "wheelchair",
      }),
      "a",
      "c",
    ),
    null,
  );

  const reverse = findRoute(
    buildRoutingGraph({ nodes, edges, profile: "healthy" }),
    "c",
    "a",
  );
  assert.deepEqual(reverse?.edgeIds, ["unverified-ac"]);
  assert.deepEqual(reverse?.geometry.coordinates[0], nodes[2]!.coordinates);
});

test("explicit path blocks exclude an edge for every profile and clearing restores it", () => {
  const active = [
    { active: true, edgeIds: ["unverified-ac", "main-ab", "shortcut-bc"] },
  ] as const;
  for (const profile of ["healthy", "wheelchair", "heavy_luggage"] as const) {
    assert.equal(route(profile, active), null);
  }
  assert.ok(
    route("healthy", [
      { active: false, edgeIds: ["unverified-ac", "main-ab", "shortcut-bc"] },
    ]),
  );
});

test("graph rejects dangling endpoints and geometry that merely crosses or approaches a node", () => {
  const dangling: RouteEdge = {
    ...edges[0]!,
    id: "dangling",
    toNodeId: "absent",
  };
  assert.throws(
    () => buildRoutingGraph({ nodes, edges: [dangling], profile: "healthy" }),
    InvalidGraphError,
  );
  const nearButNotExplicit: RouteEdge = {
    ...edges[0]!,
    id: "near",
    coordinates: [coordinate(0.00001), nodes[1]!.coordinates],
  };
  assert.throws(
    () =>
      buildRoutingGraph({
        nodes,
        edges: [nearButNotExplicit],
        profile: "healthy",
      }),
    /does not start/,
  );
});

test("bounded segment snapping uses metres and topology-preserving split geometry", () => {
  const edge = edges[0]!;
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const nearby = coordinate(0.0005, 0.00002);
  const snap = snapToEdge(nearby, edge, nodeMap, 3);
  assert.ok(snap);
  assert.equal(snap.endpointNodeId, null);
  assert.ok(snap.distanceMetres > 2 && snap.distanceMetres < 3);
  assert.equal(snapToEdge(nearby, edge, nodeMap, 2), null);

  const split = splitEdgeAtSnap(edge, snap, "mid", "ab-1", "ab-2");
  assert.deepEqual(split.edges[0].coordinates.at(-1), snap.coordinates);
  assert.deepEqual(split.edges[1].coordinates[0], snap.coordinates);
  assert.equal(split.edges[0].toNodeId, "mid");
  assert.equal(split.edges[1].fromNodeId, "mid");
  const graph = buildRoutingGraph({
    nodes: [...nodes, split.node],
    edges: [...split.edges, edges[1]!],
    profile: "healthy",
  });
  assert.deepEqual(findRoute(graph, "a", "c")?.edgeIds, [
    "ab-1",
    "ab-2",
    "shortcut-bc",
  ]);
});

test("multi-edge snapping accepts stored graph paths regardless of legacy verification", () => {
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const point = coordinate(0.0015, 0.00001);
  const snapped = snapToVerifiedEdges(point, edges, nodeMap, 3);
  assert.equal(snapped?.edgeId, "shortcut-bc");
  assert.equal(
    snapToVerifiedEdges(point, [edges[2]!], nodeMap, 10)?.edgeId,
    "unverified-ac",
  );
});

test("combined graph routes provisional OSM edges and returns provenance", () => {
  const provisional: RouteEdge = {
    ...edges[2]!,
    id: "osm-edge:42:0-1",
    status: "provisional",
    source: "osm",
    sourceOsmId: "42",
  };
  const graph = buildRoutingGraph({
    nodes,
    edges: [edges[0]!, provisional],
    profile: "healthy",
  });
  const result = findRoute(graph, "a", "c");
  assert.ok(result);
  assert.equal(result.segments[0]?.status, "provisional");
  assert.equal(result.segments[0]?.source, "osm");
  assert.equal(result.segments[0]?.sourceOsmId, "42");
  assert.equal(
    snapToVerifiedEdges(
      coordinate(0.0015),
      [provisional],
      new Map(nodes.map((node) => [node.id, node])),
      2,
    )?.edgeId,
    provisional.id,
  );
});

test("provisional steps are unavailable to wheelchair but ordinary map paths remain eligible", () => {
  const path: RouteEdge = {
    ...edges[2]!,
    id: "osm-path",
    status: "provisional",
    source: "osm",
    wheelchairEligible: true,
  };
  const steps: RouteEdge = {
    ...path,
    id: "osm-steps",
    wheelchairEligible: false,
  };
  assert.ok(
    findRoute(
      buildRoutingGraph({ nodes, edges: [path], profile: "wheelchair" }),
      "a",
      "c",
    ),
  );
  assert.equal(
    findRoute(
      buildRoutingGraph({ nodes, edges: [steps], profile: "wheelchair" }),
      "a",
      "c",
    ),
    null,
  );
});

test("two interior snaps on the same edge produce only the partial continuous route", () => {
  let mutableNodes = nodes.slice(0, 2);
  let mutableEdges = [edges[0]!];
  const startPoint = coordinate(0.00025, 0.00001);
  const destinationPoint = coordinate(0.00075, -0.00001);

  const addVirtualNode = (point: LonLat, role: string): string => {
    const map = new Map(mutableNodes.map((node) => [node.id, node]));
    const snap = snapToVerifiedEdges(point, mutableEdges, map, 3, {
      profile: "healthy",
    });
    assert.ok(snap);
    const source = mutableEdges.find((edge) => edge.id === snap.edgeId)!;
    const split = splitEdgeAtSnap(
      source,
      snap,
      role,
      `${source.id}-${role}-a`,
      `${source.id}-${role}-b`,
    );
    mutableNodes = [...mutableNodes, split.node];
    mutableEdges = [
      ...mutableEdges.filter((edge) => edge.id !== source.id),
      ...split.edges,
    ];
    return role;
  };

  const startId = addVirtualNode(startPoint, "start");
  const destinationId = addVirtualNode(destinationPoint, "destination");
  const result = findRoute(
    buildRoutingGraph({
      nodes: mutableNodes,
      edges: mutableEdges,
      profile: "healthy",
    }),
    startId,
    destinationId,
  );
  assert.ok(result);
  assert.deepEqual(
    result.geometry.coordinates[0],
    mutableNodes.find((node) => node.id === startId)!.coordinates,
  );
  assert.deepEqual(
    result.geometry.coordinates.at(-1),
    mutableNodes.find((node) => node.id === destinationId)!.coordinates,
  );
  assert.ok(result.internalCostMetres > 50 && result.internalCostMetres < 60);
  assert.equal(result.edgeIds.length, 1);

  const reverse = findRoute(
    buildRoutingGraph({
      nodes: mutableNodes,
      edges: mutableEdges,
      profile: "healthy",
    }),
    destinationId,
    startId,
  );
  assert.ok(reverse);
  assert.deepEqual(
    reverse.geometry.coordinates[0],
    result.geometry.coordinates.at(-1),
  );
  assert.deepEqual(
    reverse.geometry.coordinates.at(-1),
    result.geometry.coordinates[0],
  );
  assert.equal(reverse.edgeIds.length, 1);
});

test("component diagnostics distinguish disconnected verified paths", () => {
  const isolated: RouteNode = {
    id: "isolated",
    coordinates: coordinate(0.003),
  };
  const graph = buildRoutingGraph({
    nodes: [...nodes.slice(0, 2), isolated],
    edges: [edges[0]!],
    profile: "healthy",
  });
  const diagnostics = connectedComponents(graph);
  assert.equal(diagnostics.components.length, 2);
  assert.equal(
    diagnostics.componentByNodeId.get("a"),
    diagnostics.componentByNodeId.get("b"),
  );
  assert.notEqual(
    diagnostics.componentByNodeId.get("a"),
    diagnostics.componentByNodeId.get("isolated"),
  );
  assert.equal(findRoute(graph, "a", "isolated"), null);
});

test("snapping applies shortcut profile eligibility and explicit path blocks", () => {
  const map = new Map(nodes.map((node) => [node.id, node]));
  const nearShortcut = coordinate(0.0015, 0.00001);
  assert.equal(
    snapToVerifiedEdges(nearShortcut, [edges[1]!], map, 3, {
      profile: "wheelchair",
    }),
    null,
  );
  assert.equal(
    snapToVerifiedEdges(nearShortcut, [edges[1]!], map, 3, {
      profile: "healthy",
      activeBlocks: [{ active: true, edgeIds: ["shortcut-bc"] }],
    }),
    null,
  );
  assert.equal(
    snapToVerifiedEdges(nearShortcut, [edges[1]!], map, 3, {
      profile: "heavy_luggage",
      activeBlocks: [{ active: false, edgeIds: ["shortcut-bc"] }],
    })?.edgeId,
    "shortcut-bc",
  );
});

test("graph normalizes tolerated endpoint offsets so multi-edge output is exactly continuous", () => {
  const tinyOffset = coordinate(0.001, 0.000001);
  const offsetEdge: RouteEdge = {
    ...edges[1]!,
    coordinates: [tinyOffset, nodes[2]!.coordinates],
  };
  const graph = buildRoutingGraph({
    nodes,
    edges: [edges[0]!, offsetEdge],
    profile: "healthy",
    endpointToleranceMetres: 0.2,
  });
  const result = findRoute(graph, "a", "c");
  assert.ok(result);
  const junctionOccurrences = result.geometry.coordinates.filter(
    ([longitude, latitude]) =>
      longitude === nodes[1]!.coordinates[0] &&
      latitude === nodes[1]!.coordinates[1],
  );
  assert.equal(junctionOccurrences.length, 1);
});

test("non-finite graph and snap coordinates are rejected instead of emitting invalid GeoJSON", () => {
  const invalidNode: RouteNode = {
    id: "bad",
    coordinates: [Number.NaN, 22.725],
  };
  assert.throws(
    () =>
      buildRoutingGraph({
        nodes: [invalidNode],
        edges: [],
        profile: "healthy",
      }),
    /invalid coordinates/,
  );
  const map = new Map(nodes.map((node) => [node.id, node]));
  assert.equal(snapToEdge([Number.NaN, 22.725], edges[0]!, map, 10), null);
});

test("local projection round trips and reports campus-scale distance", () => {
  const projection = createLocalProjection(nodes[0]!.coordinates);
  const projected = projection.project(nodes[1]!.coordinates);
  const roundTrip = projection.unproject(projected);
  assert.ok(
    distanceMetres(roundTrip, nodes[1]!.coordinates, projection) < 1e-6,
  );
  assert.ok(
    distanceMetres(nodes[0]!.coordinates, nodes[1]!.coordinates, projection) >
      100,
  );
});
