# Simplification update status

## Current status

- Starting repository head: `b408eff` (`Add provisional campus routing and editor repairs`). Existing records and stable path IDs have been preserved.
- The live database audit after the additive migration observed 49 buildings, 15 OSM candidates (11 structurally routable, 4 excluded), 20 route nodes, 9 stored route edges, 1 point, and no saved floors/messages. One pre-existing alert remains informational and does not block routing. Candidate review decisions remain stored as legacy audit context.
- Software implementation is in final verification. The later on-site walk remains separate and is documented in [`field-verification.md`](field-verification.md).

## Current module and persistence map

- `apps/api/db/001_init.sql`, `002_provisional_osm.sql`: buildings, OSM candidate source rows, editor route nodes/edges, floors/features, points, alerts, visitor messages.
- `apps/api/src/osm/{parse,import,provisional}.ts`: stable OSM import and provisional candidate graph.
- `apps/api/src/routing/{graph,astar,geometry,projection,types}.ts`, `server.ts`: graph eligibility, snap/routing and building approaches.
- `apps/api/src/routes/{public,editor}.ts`, `schemas.ts`: public map/search/floor/route/message APIs and authenticated editor APIs.
- `apps/web/src/pages/{PublicMap,Editor}.tsx`: public flow and editor tabs/message list/floor integration.
- `apps/web/src/editor/{OutdoorEditor,FloorCanvas,geometry,validation,types}.ts`: outdoor tools and floor editing.
- `apps/web/src/map/CampusMap.tsx`: shared MapLibre map layers, interactions, resize handling.
- `apps/web/src/types.ts`, `api.ts`: shared web contracts and API client.

## Implemented contract

- Keep existing `route_edges` and `osm_candidates` as the stored parent path records; preserve their stable IDs and provenance. A public/editor `PathFeature` is their normalized API union with `id`, `name`, `coordinates`, `source`, `kind`, `blocked`, `note`, and version.
- Add bounded path/point/alert notes and durable `path_snap_connections` linking each shortcut endpoint to a stable parent path, projected position, parent version, and deterministic junction node ID. Derive split graph arcs from stored snaps at request time; parent blocks/notes remain attached to stable IDs.
- Shortcut creation validates both snaps (12 screen pixels in the editor, 5 m server bound), line geometry/campus scope, and current parent versions inside one transaction. Stale parent attachments are omitted from public routing until corrected.
- Public `GET /api/map` returns one `paths` collection plus buildings, points and alerts. Editor `/graph` returns the same path IDs/status with editor-only versions. Existing clients are migrated together.
- Floors keep existing IDs/history and optimistic versions. Editor has one save operation; public reads include saved legacy drafts. Floor view is read-only. Ground-floor lift/stairs notices use floor 0 only; no indoor routing is implied.
- Visitor messages remain private to authenticated editors and can be deleted there. Limits are 240 characters for path notes and 500 for point/alert/message text.

## Milestones

1. Scope and data audit — complete.
2. Additive schema and routing/API simplification — complete. `003_simplified_product.sql` is applied; data tables were not reset or reseeded.
3. Outdoor editor and three-mode public map — complete, including path note/block controls, snapped shortcut creation, point notes, informational alerts, route notes, and route invalidation.
4. Floor save/view simplification — complete, including one public save action, legacy marker preservation, ground-floor-only access notes, and read-only floor viewing.
5. Shared map/editor integration — complete. Railway/Vercel config files and workspace build scripts are retained.
6. Final checks and handoff — complete: live DB integration, all unit tests, typechecks, builds, lint, formatting, desktop/mobile browser checks, and deployment configuration review pass.

## Verification evidence

- `pnpm qa`: typecheck, all unit tests, and both production builds pass (API 28 tests; web 32 tests).
- Focused UI suite: 30 tests pass.
- `pnpm test:e2e`: 4/4 desktop and 390px-mobile browser checks pass, including public routing/path notes and editor floor selection.
- Migration applied successfully; subsequent live-state inspection retains 49 buildings and 15 candidates.
- Live campus routing check: Central Library and LT each receive approximate building approaches, but the current map graph has no connecting route; the API correctly returns `DIFFERENT_COMPONENTS`. Connected routing is exercised with isolated fixtures rather than claiming the live campus network connects them.
- Final verification: `pnpm qa` passes (28 API tests, 32 web tests, both typechecks and production builds); `pnpm lint`, `pnpm format:check`, `pnpm test:integration`, and `pnpm test:e2e` pass. Browser coverage is 4/4 across desktop and 390px mobile.

Railway remains configured to use its internal `${{Postgres.DATABASE_URL}}` reference in production; local migrations use only the ignored `apps/api/.env`. Vercel serves `apps/web` with the existing SPA rewrite.
