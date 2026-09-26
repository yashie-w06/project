import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { createDatabase } from "./db.js";

export async function migrate(): Promise<void> {
  const db = createDatabase(loadConfig());
  const directory = join(dirname(fileURLToPath(import.meta.url)), "../db");
  try {
    await db.query("CREATE TABLE IF NOT EXISTS schema_migrations (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    for (const filename of (await readdir(directory)).filter((f) => /^\d+.*\.sql$/.test(f)).sort()) {
      const exists = await db.query("SELECT 1 FROM schema_migrations WHERE filename = $1", [filename]);
      if (exists.rowCount) continue;
      const sql = await readFile(join(directory, filename), "utf8");
      const client = await db.connect();
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations(filename) VALUES ($1) ON CONFLICT DO NOTHING", [filename]);
      } finally {
        client.release();
      }
    }
  } finally {
    await db.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  migrate().then(() => console.log("Migrations complete")).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Migration failed");
    process.exitCode = 1;
  });
}
