import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool, PoolClient } from "pg";
import { loadConfig } from "../config.js";
import { createDatabase } from "../db.js";
import type { OsmBuildingCandidate, OsmPathCandidate } from "./types.js";
import { parseOsmImportModel } from "./parse.js";

/** Adapter implemented by the database layer. Upserts must key on the stable IDs. */
export interface OsmImportStore {
  transaction<T>(work: (store: OsmImportStore) => Promise<T>): Promise<T>;
  upsertBuilding(building: OsmBuildingCandidate): Promise<void>;
  upsertPathCandidate(candidate: OsmPathCandidate): Promise<void>;
}

export async function importOsmXml(
  store: OsmImportStore,
  xml: string,
): Promise<{
  buildingCount: number;
  pathCandidateCount: number;
  pathSegmentCount: number;
}> {
  const model = parseOsmImportModel(xml);
  await store.transaction(async (transaction) => {
    for (const building of model.buildings)
      await transaction.upsertBuilding(building);
    for (const candidate of model.pathCandidates)
      await transaction.upsertPathCandidate(candidate);
  });
  return {
    buildingCount: model.buildings.length,
    pathCandidateCount: model.pathCandidates.length,
    pathSegmentCount: model.pathSegments.length,
  };
}

export async function readBundledOsm(): Promise<string> {
  // Both src/osm/import.ts and dist/osm/import.js are exactly two levels below
  // apps/api/data, so this works in tsx development and compiled deployments.
  const path = fileURLToPath(new URL("../../data/campus.osm", import.meta.url));
  return readFile(path, "utf8");
}

export async function inspectBundledOsm(): Promise<
  ReturnType<typeof parseOsmImportModel>
> {
  return parseOsmImportModel(await readBundledOsm());
}

type SqlClient = Pick<PoolClient, "query">;

class ClientOsmImportStore implements OsmImportStore {
  constructor(private readonly client: SqlClient) {}

  async transaction<T>(
    work: (store: OsmImportStore) => Promise<T>,
  ): Promise<T> {
    return work(this);
  }

  async upsertBuilding(building: OsmBuildingCandidate): Promise<void> {
    await this.client.query(
      `INSERT INTO buildings(id,name,footprint,mapped_level_count,source_osm_id)
       VALUES($1,$2,$3::jsonb,$4,$5)
       ON CONFLICT(source_osm_id) DO NOTHING`,
      [
        building.id,
        building.name ?? `Unnamed building (${building.sourceWayId})`,
        JSON.stringify(building.footprint.geometry),
        building.levels,
        building.sourceWayId,
      ],
    );
  }

  async upsertPathCandidate(candidate: OsmPathCandidate): Promise<void> {
    await this.client.query(
      `INSERT INTO osm_candidates(id,source_way_id,source_node_ids,coordinates,import_status,reviewer_decision)
       VALUES($1,$2,$3::jsonb,$4::jsonb,'imported',NULL)
       ON CONFLICT(source_way_id) DO NOTHING`,
      [
        candidate.id,
        candidate.sourceWayId,
        JSON.stringify(candidate.orderedNodeIds),
        JSON.stringify(candidate.coordinates),
      ],
    );
  }
}

export function createPgOsmImportStore(
  pool: Pick<Pool, "connect">,
): OsmImportStore {
  return {
    async transaction<T>(
      work: (store: OsmImportStore) => Promise<T>,
    ): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await work(new ClientOsmImportStore(client));
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    async upsertBuilding(): Promise<void> {
      throw new Error("OSM imports must run inside a transaction");
    },
    async upsertPathCandidate(): Promise<void> {
      throw new Error("OSM imports must run inside a transaction");
    },
  };
}

export async function importBundledOsmToPostgres(pool: Pick<Pool, "connect">) {
  return importOsmXml(createPgOsmImportStore(pool), await readBundledOsm());
}

export async function runOsmImportCli(): Promise<void> {
  const database = createDatabase(loadConfig());
  try {
    const counts = await importBundledOsmToPostgres(database);
    console.log(
      `Imported ${counts.buildingCount} buildings, ${counts.pathCandidateCount} OSM candidates, ${counts.pathSegmentCount} reference segments.`,
    );
  } finally {
    await database.end();
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  runOsmImportCli().catch(() => {
    // Never echo connection errors because driver messages can include environment details.
    console.error(
      "OSM import failed. Check the database connection and migration state.",
    );
    process.exitCode = 1;
  });
}
