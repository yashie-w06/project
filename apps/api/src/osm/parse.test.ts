import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { importOsmXml, type OsmImportStore } from "./import.js";
import { parseOsmImportModel, parseOsmXml } from "./parse.js";
import {
  buildProvisionalOsmGraph,
  osmWalkingEligibility,
  polylineCrossesBuildingInterior,
} from "./provisional.js";
import type { OsmBuildingCandidate, OsmPathCandidate } from "./types.js";

const fixturePath = fileURLToPath(
  new URL("../../data/campus.osm", import.meta.url),
);

test("campus extract produces the known deterministic reference model", async () => {
  const xml = await readFile(fixturePath, "utf8");
  const first = parseOsmImportModel(xml);
  const second = parseOsmImportModel(xml);

  assert.equal(first.buildings.length, 49);
  assert.equal(first.pathCandidates.length, 15);
  // This corrected 178,674-byte file has 60 adjacent node pairs. The brief's
  // 45 figure describes the older parser output, not every segment in this file.
  assert.equal(first.pathSegments.length, 60);
  assert.deepEqual(first, second);
  assert.ok(
    first.pathCandidates.every(
      (candidate) => candidate.reviewerDecision === "pending",
    ),
  );
  assert.ok(
    first.pathCandidates.every(
      (candidate) => candidate.geometry.properties?.referenceOnly === true,
    ),
  );
  assert.ok(
    first.buildings.every(
      (building) =>
        (building.footprint.geometry.coordinates[0]?.length ?? 0) >= 4,
    ),
  );
});

test("parser rejects missing way nodes rather than inventing geometry", () => {
  const xml = `<osm version="0.6"><node id="1" lat="22" lon="75"/><way id="1"><nd ref="1"/><nd ref="missing"/><tag k="highway" v="footway"/></way></osm>`;
  assert.throws(() => parseOsmImportModel(xml), /missing node/);
});

test("stable upserts make repeated imports non-duplicating and retain reviewer decisions", async () => {
  const xml = await readFile(fixturePath, "utf8");
  const buildings = new Map<string, OsmBuildingCandidate>();
  const candidates = new Map<string, OsmPathCandidate>();
  const store: OsmImportStore = {
    async transaction<T>(
      work: (transaction: OsmImportStore) => Promise<T>,
    ): Promise<T> {
      return work(this);
    },
    async upsertBuilding(building) {
      buildings.set(building.id, building);
    },
    async upsertPathCandidate(candidate) {
      const existing = candidates.get(candidate.id);
      candidates.set(
        candidate.id,
        existing
          ? { ...candidate, reviewerDecision: existing.reviewerDecision }
          : candidate,
      );
    },
  };
  await importOsmXml(store, xml);
  const firstId = [...candidates.keys()][0]!;
  candidates.set(firstId, {
    ...candidates.get(firstId)!,
    reviewerDecision: "approved",
  });
  await importOsmXml(store, xml);

  assert.equal(buildings.size, 49);
  assert.equal(candidates.size, 15);
  assert.equal(candidates.get(firstId)?.reviewerDecision, "approved");
});

test("raw parse model is immutable at its public collection boundaries", () => {
  const parsed = parseOsmXml(
    `<osm version="0.6"><node id="1" lat="22" lon="75"/></osm>`,
  );
  assert.ok(Object.isFrozen(parsed));
  assert.ok(Object.isFrozen(parsed.ways));
  assert.ok(Object.isFrozen(parsed.nodes.get("1")));
});

test("walking eligibility is conservative about access, roads, and steps", () => {
  assert.deepEqual(osmWalkingEligibility({ highway: "footway" }), {
    eligible: true,
    wheelchairEligible: true,
  });
  assert.deepEqual(osmWalkingEligibility({ highway: "steps" }), {
    eligible: true,
    wheelchairEligible: false,
  });
  assert.equal(osmWalkingEligibility({ highway: "service" }).eligible, false);
  assert.equal(
    osmWalkingEligibility({ highway: "service", foot: "designated" }).eligible,
    true,
  );
  assert.equal(
    osmWalkingEligibility({ highway: "service", access: "private" }).eligible,
    true,
  );
  assert.equal(
    osmWalkingEligibility({ highway: "path", access: "private" }).eligible,
    false,
  );
});

test("provisional graph splits deterministically only at shared OSM nodes", () => {
  const xml = `<osm version="0.6">
    <node id="1" lat="22" lon="75"/><node id="2" lat="22" lon="75.001"/>
    <node id="3" lat="22" lon="75.002"/><node id="4" lat="21.999" lon="75.001"/>
    <node id="5" lat="22.001" lon="75.0015"/><node id="6" lat="21.999" lon="75.0015"/>
    <way id="10"><nd ref="1"/><nd ref="2"/><nd ref="3"/><tag k="highway" v="footway"/></way>
    <way id="11"><nd ref="4"/><nd ref="2"/><tag k="highway" v="path"/></way>
    <way id="12"><nd ref="5"/><nd ref="6"/><tag k="highway" v="footway"/></way>
  </osm>`;
  const model = parseOsmImportModel(xml);
  const first = buildProvisionalOsmGraph({ candidates: model.pathCandidates });
  const second = buildProvisionalOsmGraph({ candidates: model.pathCandidates });
  assert.deepEqual(first, second);
  assert.deepEqual(
    first.edges.map((edge) => edge.id),
    [
      "osm-edge:10:0-1",
      "osm-edge:10:1-2",
      "osm-edge:11:0-1",
      "osm-edge:12:0-1",
    ],
  );
  assert.equal(
    first.nodes.some((node) => node.id === "osm-node:2"),
    true,
  );
  // Way 12 crosses way 10 geometrically, but has no shared source node.
  assert.equal(
    first.nodes.some((node) => node.id.includes("intersection")),
    false,
  );
});

test("review decisions, barriers, and building interiors exclude provisional ways", () => {
  const xml = `<osm version="0.6">
    <node id="1" lat="0" lon="-1"/><node id="2" lat="0" lon="1"/>
    <node id="3" lat="2" lon="-1"/><node id="4" lat="2" lon="1"><tag k="barrier" v="wall"/></node>
    <node id="5" lat="3" lon="-1"/><node id="6" lat="3" lon="1"/>
    <way id="10"><nd ref="1"/><nd ref="2"/><tag k="highway" v="footway"/></way>
    <way id="11"><nd ref="3"/><nd ref="4"/><tag k="highway" v="path"/></way>
    <way id="12"><nd ref="5"/><nd ref="6"/><tag k="highway" v="footway"/></way>
  </osm>`;
  const candidates = parseOsmImportModel(xml).pathCandidates;
  const footprint = {
    type: "Feature" as const,
    properties: {},
    geometry: {
      type: "Polygon" as const,
      coordinates: [
        [
          [-0.5, -0.5],
          [0.5, -0.5],
          [0.5, 0.5],
          [-0.5, 0.5],
          [-0.5, -0.5],
        ],
      ],
    },
  };
  assert.equal(
    polylineCrossesBuildingInterior(candidates[0]!.coordinates, footprint),
    true,
  );
  const graph = buildProvisionalOsmGraph({
    candidates,
    buildings: [
      { id: "b", sourceWayId: "b", name: null, levels: null, footprint },
    ],
    decisions: new Map([["12", "needs_edit"]]),
  });
  assert.equal(graph.edges.length, 0);
  assert.deepEqual(graph.excluded, [
    { sourceWayId: "10", reason: "crosses_building" },
    { sourceWayId: "11", reason: "blocked_by_barrier" },
    { sourceWayId: "12", reason: "review_needs_edit" },
  ]);
});
