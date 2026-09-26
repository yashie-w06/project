import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  EDITOR_EMAIL: z.string().email(),
  EDITOR_PASSWORD: z.string().min(8).optional(),
  EDITOR_PASSWORD_HASH: z.string().min(20).optional(),
  EDITOR_TOKEN_SECRET: z.string().min(32),
  WEB_ORIGIN: z.string().url(),
  PORT: z.coerce.number().int().positive().default(3001),
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  SNAP_RADIUS_METRES: z.coerce.number().positive().max(100).default(25),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success)
    throw new Error(
      `Invalid server configuration: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`,
    );
  if (!parsed.data.EDITOR_PASSWORD && !parsed.data.EDITOR_PASSWORD_HASH) {
    throw new Error(
      "Invalid server configuration: EDITOR_PASSWORD or EDITOR_PASSWORD_HASH is required",
    );
  }
  return parsed.data;
}
