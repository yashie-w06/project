# SGSITS Campus Access v2

An SGSITS campus map with provisional OSM walking routes, approximate outdoor building approaches, informational campus points/alerts, and saved floor-plan viewing. The public map has three modes: View, Routing, and Send Note. OSM-derived routes are presented as provisional; this is not a field-verified accessibility service.

## Stack and workspace

- `apps/web`: React 19, TypeScript, Vite, React Router, MapLibre GL JS, React Konva
- `apps/api`: Express 5, TypeScript, PostgreSQL via `pg`, Zod, Jose, `fast-xml-parser`
- Hosting target: Vercel for the SPA and Railway for the API plus one Railway PostgreSQL service

The bundled `apps/api/data/campus.osm` is immutable source data. The deterministic importer finds 49 buildings and 15 candidate ways. Structurally eligible paths are routed from OSM geometry without requiring legacy reviewer approval. Forbidden access, arterial-only geometry, barriers, and lines crossing building interiors remain excluded. Explicit path blocks and wheelchair-ineligible shortcuts are respected.

## Local setup

Prerequisites: Node 24+, pnpm 12+, and PostgreSQL 15+ (local or Railway public connection).

```sh
pnpm install
pnpm typecheck
pnpm test:unit
pnpm build
```

Copying is unnecessary in this repository because ignored dummy `.env` files are created during initial setup. For a fresh clone, copy each `.env.example` to `.env` and replace dummy values locally. Never put database credentials in a `VITE_*` variable.

API variables:

| Variable               | Purpose                                                                                             |
| ---------------------- | --------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`         | PostgreSQL URL; use Railway's public URL from Windows and Railway's service reference in production |
| `EDITOR_EMAIL`         | Single designated editor account                                                                    |
| `EDITOR_PASSWORD`      | Local-only password; production should prefer `EDITOR_PASSWORD_HASH`                                |
| `EDITOR_PASSWORD_HASH` | Optional Argon2 hash, preferred in production                                                       |
| `EDITOR_TOKEN_SECRET`  | Random secret of at least 32 characters                                                             |
| `WEB_ORIGIN`           | Exact allowed frontend origin, such as `http://localhost:5173`                                      |
| `PORT`                 | API listener port; Railway supplies this                                                            |
| `SNAP_RADIUS_METRES`   | Optional outdoor pick snap limit, default 25                                                        |

Web variable: `VITE_API_URL=http://localhost:3001`.

With a real database configured:

```sh
pnpm --filter @campus-access/api migrate
pnpm --filter @campus-access/api import:osm
pnpm dev
```

The API listens on `0.0.0.0`. `GET /api/health` returns process and database readiness without echoing configuration.

## API examples

Public route request (coordinate arrays are always `[longitude, latitude]`):

```json
{
  "profile": "wheelchair",
  "start": { "kind": "outdoor", "coordinates": [75.8717, 22.7263] },
  "destination": {
    "kind": "building",
    "buildingId": "osm-building-123"
  }
}
```

Success returns `status: "ok"`, a GeoJSON `LineString`, path segments/notes, and building-approach notices. Disconnected or unsnappable requests return a `status: "no_route"` payload with a clear no-route message. The interface does not display route distance or indoor turn-by-turn guidance. Public notes use `POST /api/messages` with `{ "coordinates": [lon, lat], "description": "..." }` and are rate limited; they remain private to authenticated editors.

Editor login uses `POST /api/editor/login`. Send its short-lived token as `Authorization: Bearer <token>` for all `/api/editor/*` mutations. Anonymous writes return 401; validation, missing IDs, and optimistic-version conflicts return 400, 404, and 409 respectively.

## Railway deployment (API and PostgreSQL)

1. Create a Railway project and add PostgreSQL.
2. Add this GitHub repository as a service. Keep the service root at repository root `/` so the workspace lockfile is available; Railway reads `railway.toml`.
3. Set the API service's `DATABASE_URL` to the Railway reference `${{Postgres.DATABASE_URL}}` (adjust `Postgres` only if the database service has a different name), not to the public proxy URL. Also set `EDITOR_EMAIL`, `EDITOR_PASSWORD_HASH` or `EDITOR_PASSWORD`, `EDITOR_TOKEN_SECRET`, and the exact Vercel origin in `WEB_ORIGIN`. Do not set `PORT` manually.
4. The build runs the API TypeScript build. Pre-deploy runs controlled SQL migrations and the idempotent OSM import. Start runs the compiled Express server.
5. Generate a public Railway domain and verify `https://<domain>/api/health` reports both values ready.

For local Windows migration/testing, Railway's `postgres.railway.internal` hostname will not resolve. Use the PostgreSQL service's **public connection URL** only in ignored `apps/api/.env`.

## Vercel deployment (web)

1. Import the same repository and set Root Directory to `apps/web`.
2. Framework preset: Vite. Install command: `cd ../.. && pnpm install`. Build command: `pnpm build`. Output directory: `dist`.
3. Set `VITE_API_URL` to the public Railway API origin, with no trailing path.
4. Deploy, then set Railway `WEB_ORIGIN` to the exact production Vercel origin and redeploy the API.
5. `vercel.json` rewrites SPA routes. Smoke-test `/`, `/edit/login`, and a direct refresh of `/edit`.

## Verification

```sh
pnpm typecheck
pnpm test:unit
pnpm build
pnpm test:e2e
```

Focused tests cover deterministic OSM import, structural routing eligibility, metric snapping and durable split topology, path blocks/notes, all three profiles, approximate approaches, floor geometry/viewer states, API health/auth/validation, and desktop/mobile SPA flows. Database integration tests require a real PostgreSQL URL and run after migrations.

## Accuracy and safety limits

- OSM-derived outdoor lines are provisional map data, not proof of physical walkability; approximate building approaches are not surveyed entrances.
- A building footprint is only an approximate initial floor outline. Saved indoor layouts are read-only and do not provide room-level routing.
- Ground-floor lift/stairs information is informational. Shortcuts are excluded from wheelchair routing; OSM wheelchair tags are not a verified accessibility assessment.
- Informational alerts do not block or reroute paths. Editors block a path explicitly when needed.
- Raster tiles are visual context, with OpenStreetMap attribution; they are never routing data.

The deferred campus survey task is documented in [`docs/field-verification.md`](docs/field-verification.md). Field verification is separate from software completion and does not block deployment of the provisional routing experience.

The simplified product implementation, current checks, and remaining field task are tracked in [`docs/simplification-update-status.md`](docs/simplification-update-status.md). The editor supports named/blocked paths, 5 m server-validated snapped shortcuts, public points and informational alerts, one-step public floor saves, and private visitor-message deletion.
