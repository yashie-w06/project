import assert from "node:assert/strict";
import test from "node:test";
import type { LonLat } from "../osm/types.js";
import { findRoute } from "./astar.js";
import { snapToEdge, snapToVerifiedEdges, splitEdgeAtSnap } from "./geometry.js";
import { buildRoutingGraph, InvalidGraphError } from "./graph.js";
import { createLocalProjection, distanceMetres } from "./projection.js";
import type { ActiveBlock, RouteEdge, RouteNode, TravelProfile } from "./types.js";

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

function route(profile: TravelProfile, activeBlocks: readonly ActiveBlock[] = []) {
  return findRoute(buildRoutingGraph({ nodes, edges, profile, activeBlocks }), "a", "c");
}

test("A* uses verified bidirectional main and profile-compatible shortcut edges", () => {
  assert.deepEqual(route("healthy")?.edgeIds, ["main-ab", "shortcut-bc"]);
  assert.deepEqual(route("heavy_luggage")?.edgeIds, ["main-ab", "shortcut-bc"]);
  assert.equal(route("wheelchair"), null);

  const reverse = findRoute(buildRoutingGraph({ nodes, edges, profile: "healthy" }), "c", "a");
  assert.deepEqual(reverse?.edgeIds, ["shortcut-bc", "main-ab"]);
  assert.deepEqual(reverse?.geometry.coordinates[0], nodes[2]!.coordinates);
});

test("effective active blocks exclude an edge for every profile and unblocking restores it", () => {
  const active = [{ active: true, edgeIds: ["main-ab"] }] as const;
  for (const profile of ["healthy", "wheelchair", "heavy_luggage"] as const) {
    assert.equal(route(profile, active), null);
  }
  assert.ok(route("healthy", [{ active: false, edgeIds: ["main-ab"] }]));
});

test("graph rejects dangling endpoints and geometry that merely crosses or approaches a node", () => {
  const dangling: RouteEdge = { ...edges[0]!, id: "dangling", toNodeId: "absent" };
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
    () => buildRoutingGraph({ nodes, edges: [nearButNotExplicit], profile: "healthy" }),
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
  assert.deepEqual(findRoute(graph, "a", "c")?.edgeIds, ["ab-1", "ab-2", "shortcut-bc"]);
});

test("multi-edge snapping ignores unverified graph material", () => {
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const point = coordinate(0.0015, 0.00001);
  const snapped = snapToVerifiedEdges(point, edges, nodeMap, 3);
  assert.equal(snapped?.edgeId, "shortcut-bc");
  assert.equal(
    snapToVerifiedEdges(point, [edges[2]!], nodeMap, 10),
    null,
  );
});

test("local projection round trips and reports campus-scale distance", () => {
  const projection = createLocalProjection(nodes[0]!.coordinates);
  const projected = projection.project(nodes[1]!.coordinates);
  const roundTrip = projection.unproject(projected);
  assert.ok(distanceMetres(roundTrip, nodes[1]!.coordinates, projection) < 1e-6);
  assert.ok(distanceMetres(nodes[0]!.coordinates, nodes[1]!.coordinates, projection) > 100);
});
