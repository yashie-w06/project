import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { importOsmXml, type OsmImportStore } from "./import.js";
import { parseOsmImportModel, parseOsmXml } from "./parse.js";
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
