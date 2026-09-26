import pg from "pg";
import type { Config } from "./config.js";

export type Database = pg.Pool;

export function createDatabase(config: Config): Database {
  return new pg.Pool({
    connectionString: config.DATABASE_URL,
    max: config.NODE_ENV === "production" ? 10 : 4,
    connectionTimeoutMillis: 15_000,
    idleTimeoutMillis: 30_000,
    ssl: config.DATABASE_URL.includes("localhost")
      ? false
      : { rejectUnauthorized: false },
  });
}

export async function checkDatabase(db: Database): Promise<boolean> {
  try {
    await db.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}
