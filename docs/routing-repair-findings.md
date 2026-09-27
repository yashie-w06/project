# Dynamic routing repair findings

## Live database baseline

The first live API check reproduced both reported symptoms. `GET /api/map` returned HTTP 500 with `{"error":"Internal server error"}`. `POST /api/route` for Central Library to LT returned HTTP 200 with `no_route / DIFFERENT_COMPONENTS`.

The database had migrations only through `003`; `to_regclass('public.route_obstacles')` returned null. The additive `004_accessibility_obstacles.sql` migration was applied to the configured Railway database. The map then returned HTTP 200 with 49 buildings, 16 path features and 2 outdoor points. API health now reports the database unavailable if that schema migration is missing.

## Disconnected route diagnosis

After the migration, the route still returned the disconnected result. The route loader supplied persisted `route_nodes` and also supplied those same nodes through the saved editor split graph. `buildRoutingGraph` rejected duplicate node ID `osm-995119335-start`; a broad catch turned that invalid-graph exception into `DIFFERENT_COMPONENTS`.

The resolver now merges identical node IDs with identical coordinates and fails on conflicting coordinates. Graph validation exceptions reach the 500 handler instead of becoming a normal no-route result. Unit regressions cover duplicate rows and conflicting coordinates.

Live route data connects the two buildings through actual OSM ways `202920189` and `202920186`, which share source node `2128649115`. The live route now returns `status: ok`; its geometry starts and ends at building boundary approaches and follows those two ways. No connector or campus path was added to make the journey connect.

The `b408eff` resolver filtered editor paths to `verified AND published` and loaded alerts. The later `1b77e33` resolver loaded editor paths without that filter and included persisted split connections. Those differences do not explain the current OSM junction: its two source ways already share an OSM node. The later path loader could include a persisted route node twice through the editor split graph; that is the reproduced failure fixed here.

## Rendering diagnosis and browser evidence

The route API returned segment `kind`, but `routePresentation()` dropped it. MapLibre's main-route layer filters by `kind`, so the valid route geometry was not painted. The presentation now preserves the field.

Playwright against the live API and local web app passed the desktop journey test: the map loaded live data, Central Library to LT returned the connected two-way route, and the browser rendered the route line. The same browser test then selected Wheelchair and received a conditional route with the missing-accessibility notice. A second browser test injected one map 500, checked that it remained a map-data error rather than a disconnected-route message, and retried successfully against live map data. Screenshot: `test-results/desktop-live-central-library-lt.png`.

## Routing and obstacle behavior

Healthy uses distance plus mild penalties for explicitly poor surface and steep slope. Heavy luggage adds larger penalties for stairs, poor surface and steep slope. Wheelchair first searches known-compliant main paths, then retries only when necessary with unknown attributes allowed; known stairs, explicit wheelchair restrictions, unsuitable known width/slope/surface condition, and shortcuts stay excluded. The prototype thresholds are width at least 0.90 m and absolute slope at most 6%; they are not a safety guarantee.

Temporary obstacles are stored with stable path IDs and server-side expiry. Effective state combines persistent blocks and active obstacles; expired/deactivated obstacles are excluded by the database clock. The map and route APIs return a shared effective-state revision, and the immutable base graph is cached against that revision. The browser checks state while a route is visible and on focus, and requests the selected route again only when a current path is blocked. Unit tests cover expiry, unrelated blocks, graph cache reuse, profile costs, and route snapping against an active obstacle. Live campus obstacle state was not changed to manufacture a reroute.

## Limits and remaining acceptance

The connected live route uses provisional OSM geometry and does not mean its pavement or building approaches were field-surveyed. The wheelchair result is explicitly conditional because path attributes are missing. No claim is made that this route is physically accessible.

Final validation passed: `pnpm qa` (typecheck, 71 unit tests and production builds), `pnpm lint`, and six Playwright browser checks across desktop and mobile. The browsers used the live API/database for map loading and the connected Central Library → LT route, including the conditional wheelchair route. Map retry recovered from an injected one-time 500. For obstacle replanning, the browser used a controlled network-state change and a simulated no-route response; the API's active-obstacle behavior and revision cache were independently covered by integration-style unit tests. A fully isolated PostgreSQL staging copy was not available, so dynamic obstacle routing was not exercised end-to-end against a separate database. No live campus path state was changed.
