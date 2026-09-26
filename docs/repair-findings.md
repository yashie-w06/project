# Complete application repair findings

## Outcome

The public route flow, outdoor editor, indoor floor editor, and routing engine now operate as one integrated application. Eligible OSM campus geometry may support a route only as **provisional** map data. It is visually distinct from confirmed paths and every such result states that paths and accessibility have not been field-verified.

Central Library to LT is the live acceptance route. It uses provisional OSM ways `202920189` and `202920186`, plus an approximate connector from each building boundary to the network. The API returns four provenance-bearing segments, the map draws the provisional route, and the UI labels both approaches as unconfirmed. No candidate or editor path was falsely marked verified.

Rejected and `needs_edit` candidates remain excluded. The quarantined carriageway `995119335` is still unverified and unpublished, and candidate `1264482101` remains rejected.

## Root causes and repairs

- The original graph considered only field-confirmed editor edges, leaving the campus unusable before a survey. The graph now combines confirmed editor edges with a conservative, separately labelled provisional OSM graph.
- OSM eligibility rejects arterial roads, explicit walking prohibitions, reviewer rejections, barriers, building-interior crossings, and unsupported classes. Campus service geometry with walking evidence is provisional, never confirmed.
- OSM ways connect only at shared source node IDs or their own endpoints. Close or visually crossing lines are not invented as junctions.
- Buildings without confirmed linked exits use a bounded nearest boundary/network approach. Connectors are rejected if too distant or if they cross a building interior.
- Route responses include per-segment source/confidence, approach metadata, typed no-route codes, and a stable provisional safety warning.
- Snapping uses the same profile/block eligibility rules as A*. Same-edge splits return only the requested continuous partial geometry.
- Public selection is an explicit Start to Destination to Profile/Route flow. Confirmed, provisional, approximate, and excluded geometry use distinct map styles.
- The outdoor editor is map-first and distinguishes confirmed edges, provisional candidates, drafts, and excluded references. Reviewer rejection or `needs_edit` invalidates provisional use immediately.
- Floor editing supports map-first building/floor selection, responsive canvas sizing, mouse/touch zoom, centered labels, geometry repair warnings, contained components, and versioned draft/publish persistence.
- Exit linking remains guarded: a confirmed exit link requires a verified, published main-path node. Provisional building approaches do not manufacture door verification.
- Raster basemap tile failure no longer hides usable campus vectors or routes.

## Live data and OSM observations

The Railway-backed database contains 49 buildings and 15 imported OSM highway candidates. Twelve private campus service ways are eligible for provisional use; the two tertiary carriageways and one tertiary link are excluded. The bundled extract and a fresh official OSM bbox inspection contained no `footway`, `path`, or `pedestrian` ways, so the software does not claim that these service ways are mapped pedestrian paths.

The importer is deterministic and idempotent, stores tags and eligibility reasons, and preserves reviewer decisions. Public map data currently exposes 12 provisional candidates and 3 excluded/reference candidates. The routing graph is rebuilt from current database state for each request, so reviews and active blocks do not wait on a stale cache.

## Verification performed

- TypeScript checks and production builds for API and web.
- 25 API unit tests and 22 web unit tests covering OSM eligibility, graph construction, profiles, snapping/splitting, provisional provenance, approaches, public state, and floor geometry.
- Railway-backed integration coverage for Central Library to LT, exact OSM provenance, two approaches, auth, confirmed fixture profiles, same-edge routing, reports, block/unblock, persistence/restart, floor save/reload, and public map counts.
- Playwright desktop and mobile public/editor flows (4 tests).
- Live Chromium verification against the Railway-backed data: Central Library to LT rendered on the map, the warning and approximate approaches were visible, outdoor/floor editors loaded, and no application console errors occurred.

Generated screenshots are ignored under `test-results/`. Start the local API and web services, then run `node tests/e2e/live-smoke.mjs` to reproduce live evidence.

## Deployment configuration

Railway uses repository-root `railway.toml`, runs migrations and the idempotent OSM import before starting the API, and checks `/api/health`. Production `DATABASE_URL` must use Railway's internal `${{Postgres.DATABASE_URL}}` reference; the public proxy URL is local-only.

Vercel uses `apps/web`, the Vite build and `dist` output, with SPA rewrites from `apps/web/vercel.json`. Set `VITE_API_URL` to the Railway API origin and Railway `WEB_ORIGIN` to the exact Vercel origin.

## Remaining field work

Physical verification is deliberately separate and does not block software deployment. The later survey in [`field-verification.md`](field-verification.md) can promote suitable geometry to confirmed editor paths and record accessibility. Until then, provisional results must keep their warning and must not claim wheelchair verification.
