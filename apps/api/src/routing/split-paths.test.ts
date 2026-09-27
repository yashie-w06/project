import assert from "node:assert/strict";
import test from "node:test";
import { splitEdgesAtSavedJunctions } from "./split-paths.js";
import type { RouteEdge, RouteNode } from "./types.js";

const a = [75.87, 22.725] as const;
const b = [75.871, 22.725] as const;
const c = [75.872, 22.725] as const;

test("saved snaps derive stable parent arcs, including both parent endpoints", () => {
  const parent: RouteEdge = {
    id: "stable-parent",
    fromNodeId: "a",
    toNodeId: "c",
    coordinates: [a, b, c],
    kind: "main",
    verified: false,
    blocked: true,
    name: "West walk",
    note: "Narrow near the gate",
    version: 4,
  };
  const nodes: RouteNode[] = [
    { id: "a", coordinates: a },
    { id: "c", coordinates: c },
  ];
  const junctions = [
    {
      parentFeatureId: "stable-parent",
      parentSegmentIndex: 0,
      parentSegmentFraction: 0,
      junctionNodeId: "a",
      coordinates: a,
    },
    {
      parentFeatureId: "stable-parent",
      parentSegmentIndex: 0,
      parentSegmentFraction: 1,
      junctionNodeId: "middle",
      coordinates: b,
    },
    {
      parentFeatureId: "stable-parent",
      parentSegmentIndex: 1,
      parentSegmentFraction: 1,
      junctionNodeId: "c",
      coordinates: c,
    },
  ];

  const first = splitEdgesAtSavedJunctions([parent], nodes, junctions);
  const afterRestart = splitEdgesAtSavedJunctions(
    [parent],
    nodes,
    structuredClone(junctions),
  );
  assert.deepEqual(first, afterRestart);
  assert.deepEqual(
    first.edges.map(({ fromNodeId, toNodeId }) => [fromNodeId, toNodeId]),
    [
      ["a", "middle"],
      ["middle", "c"],
    ],
  );
  assert.ok(
    first.edges.every(
      (edge) =>
        edge.parentFeatureId === "stable-parent" &&
        edge.blocked &&
        edge.note === parent.note,
    ),
  );
});

test("a junction crossing unrelated geometry does not connect the crossing line", () => {
  const horizontal: RouteEdge = {
    id: "horizontal",
    fromNodeId: "a",
    toNodeId: "c",
    coordinates: [a, c],
    kind: "main",
    verified: false,
  };
  const vertical: RouteEdge = {
    id: "vertical",
    fromNodeId: "v1",
    toNodeId: "v2",
    coordinates: [
      [75.871, 22.724],
      [75.871, 22.726],
    ],
    kind: "main",
    verified: false,
  };
  const result = splitEdgesAtSavedJunctions(
    [horizontal, vertical],
    [
      { id: "a", coordinates: a },
      { id: "c", coordinates: c },
      { id: "v1", coordinates: [75.871, 22.724] },
      { id: "v2", coordinates: [75.871, 22.726] },
    ],
    [
      {
        parentFeatureId: "horizontal",
        parentSegmentIndex: 0,
        parentSegmentFraction: 0.5,
        junctionNodeId: "junction",
        coordinates: b,
      },
    ],
  );
  assert.equal(
    result.edges.filter((edge) => edge.parentFeatureId === "horizontal").length,
    2,
  );
  assert.equal(
    result.edges.find((edge) => edge.id === "vertical")?.fromNodeId,
    "v1",
  );
  assert.equal(
    result.edges.find((edge) => edge.id === "vertical")?.toNodeId,
    "v2",
  );
});
