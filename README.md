# SGSITS Campus Access v2

An SGSITS walking map and indoor floor-layout prototype. The public app has exactly three routes: `/`, `/edit/login`, and protected `/edit`. Confirmed editor paths and conservatively eligible OSM geometry share one routing engine, but OSM-derived paths and approximate building approaches are always labelled provisional and unverified.

## Stack and workspace

- `apps/web`: React 19, TypeScript, Vite, React Router, MapLibre GL JS, React Konva
- `apps/api`: Express 5, TypeScript, PostgreSQL via `pg`, Zod, Jose, `fast-xml-parser`
- Hosting target: Vercel for the SPA and Railway for the API plus one Railway PostgreSQL service

The bundled `apps/api/data/campus.osm` is immutable source data. The deterministic importer finds 49 buildings and 15 highway reference candidates (60 adjacent pairs). The extract contains 12 private campus `service`, two `tertiary`, and one `tertiary_link` ways, but no `footway`, `path`, or `pedestrian` ways. The service ways may support suggested provisional routes; arterial roads and reviewer-rejected/needs-edit geometry are excluded.

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
    "buildingId": "osm-building-123",
    "floor": 1,
    "entranceDoorId": "door-main"
  }
}
```

Success returns `status: "ok"`, a GeoJSON `LineString`, snap corrections, and notices—never a displayed distance. Disconnected or unsnappable requests return a successful `status: "no_route"` payload. Public notes use `POST /api/messages` with `{ "coordinates": [lon, lat], "description": "..." }` and are rate limited.

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

Focused tests cover deterministic OSM import, provisional eligibility and provenance, metric snapping and edge splitting, confirmed/provisional graph composition, approximate approaches, blocks, all three profiles, concave floor containment, doors/exits, connectors, API health/auth/validation, and desktop/mobile SPA flows. Database integration tests require a real PostgreSQL URL and are performed after migrations.

## Accuracy and safety limits

- The OSM campus boundary is reference-only and may cross building footprints; buildings are not deleted because of it.
- A building footprint is only an approximate initial floor outline.
- Raster tiles are visual context, with OpenStreetMap attribution; they are never routing data.
- Indoor features and vertical-access notices are informational. No indoor turn-by-turn route is fabricated.
- Suggested routes based on OSM service geometry are not field-verified and do not establish wheelchair accessibility. Rejected, needs-edit, forbidden, arterial, barrier-blocked, and building-crossing geometry is excluded.

The current candidate checklist and exact endpoint coordinates are in [`docs/field-verification.md`](docs/field-verification.md). A later campus walk can promote suitable geometry to confirmed paths without blocking provisional software deployment.

The completed repair audit, root causes, live-data correction, browser coverage, and deployment handoff are documented in [`docs/repair-findings.md`](docs/repair-findings.md). The editor supports map-first building/floor selection, reloadable versioned drafts, guarded exit linking, and alert resolution. Central Library to LT is the live provisional acceptance route.
