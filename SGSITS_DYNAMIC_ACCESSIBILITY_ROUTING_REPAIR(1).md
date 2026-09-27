# SGSITS Campus Access v2: repair routing and add dynamic accessibility-aware replanning

## 0. Task and boundaries

Work in the EXISTING Windows repository `C:\Users\yashw\Desktop\sgsits-campus-access-v2`, at the latest branch containing `1b77e33`. Implement and verify code, data migration and real browser behavior. Do not create a new project, produce only a design document, or reset the database. Keep the existing Railway PostgreSQL / Railway API / Vercel web deployment architecture and three public profiles: Healthy, Wheelchair, Heavy luggage. Keep outdoor routing only; floors are for viewing and ground-floor lift/stair advisory, not indoor route planning.

The owner says routing currently fails in actual use. Existing unit, isolated graph and browser tests are not proof that the live network supports a journey. Diagnose and fix this before calling the challenge complete. A prior report at `b408eff` said Central Library → LT rendered using OSM ways 202920189 and 202920186; a later report at `1b77e33` said the live database has no connected route between these buildings. Compare those actual implementations and live data. The old route could have relied on an invalid connector or the update could have regressed. Do not assume either answer. Never add a fictitious line, cross a building, claim a campus path was surveyed, or convert a decorative basemap line into a route to make a screenshot pass.

This request supersedes older simplification instructions only where they conflict with accessibility-aware behavior. Keep the public View / Routing / Send Note UI, simple floor Save, existing editor outdoor map, route note, alerts, points, visitor messages and shortcut drawing. Do not bring back Reviewed OSM, Verified Path, graph-readiness cards, floor selection in the routing form, or a field-survey approval gate. A **confidence/evidence** property is needed inside route data and explanations; it is not a verified-path publication system.

## 1. Efficient execution

1. Inspect git status, AGENTS.md, relevant package scripts, data importer, schema/migrations, route API, graph build, snapping, profile filtering, map drawing, editor block/alert operations and tests. Use `rg`; keep outputs small and avoid printing `.env` credentials. Do not rely on the older scratch prototype.
2. Make a short `docs/routing-repair-findings.md` with baseline live graph counts, components, candidate paths/blocked states and exact Central Library → LT failure. Record selected building IDs, endpoint approach coordinates rounded for reports, nearest eligible edge IDs, component IDs, OSM way IDs, and the first missing/disconnected junction. Keep sensitive values out. Document prior-commit comparison, actual cause, fix, tests and remaining real coverage gaps.
3. If subagents are supported, request two focused ones after mapping interfaces: one read-only data/topology investigation (report only), one frontend interaction investigation. Main agent owns routing contracts, graph changes, migration, integration and final acceptance. Assign nonoverlapping files; wait for results before editing shared modules. If they are unavailable, proceed alone.
4. Report after each major milestone `Completed: ...; estimated work remaining: ...%; next: ...`. Preserve unrelated editor data. Use a separate test database/transaction for synthetic graphs and blocks. Do not modify real campus path states solely to make a test pass.
5. When an isolated graph problem remains after targeted fixes, narrow it by exact edge IDs and coordinates rather than increasing snap tolerance or relaxing accessibility rules. Ask for a field observation only if the actual missing physical connection cannot be established from the available OSM/editor data; complete all independent software work first.

## 2. First repair the current route engine

Trace one real request end-to-end: public start/destination selection → actual IDs/GeoJSON → API validation → building boundary approach → graph build/cache → per-profile filtering → nearest eligible edge projection → shortest-path search → response ordered geometry → MapLibre line. Test Central Library → LT, another known connected pair, two points on the same edge, nearby outside points, building-to-point, and a genuinely disconnected pair. Check the live DB read-only before any migration.

### Source and graph invariants

- Keep ordered OSM/editor path geometry with stable parent feature IDs and GeoJSON `[longitude, latitude]`. Import once/idempotently. Segments connect at shared OSM source nodes or intentionally saved editor junctions, including a snapped shortcut endpoint to an existing segment interior. Preserve bridge/tunnel/layer and barriers; a visual crossing does not prove a walkable junction.
- A segment can be subdivided by starts, destinations, shortcuts or obstacles. Derived subedges inherit parent feature ID, path kind, block state, access properties, note and provenance. Split multiple projections on the same parent by path position in order. Zero-length subdivisions are removed. Routes stay continuous through the correct geometry direction.
- Select the nearest **eligible** segment using a bounded projected/metre-scale distance. Never compare raw lat/lon degrees to metres; never snap through a footprint, wall or known blocked edge. If the nearest main segment is in a disconnected component, consider other plausible eligible approach candidates and choose a reachable one only when its connector is geometrically valid. Do not invent a long straight connector to another component.
- For buildings, prefer a mapped exterior door/approach if present. Otherwise route to a short plausible point on the outer building boundary facing the graph. Only a visible short connector outside the footprint is allowed. Never require a mapped ground-floor door, floor selection or graph approval for outdoor routing.
- Distinguish `no_nearby_path`, `missing_building_approach`, `disconnected_components`, `profile_ineligible` and `all_currently_obstructed` from API/system errors. Show a useful reason without saying every failure is “out of reach.” Log sanitized IDs and diagnostic context server-side.
- Current selection controls, fast-changing selections and map mode switching must not allow an old route response to overwrite a newer one. Clear or mark an obsolete line immediately after a changed start/destination/profile.

Compare `b408eff` and HEAD: inspect way 202920189/202920186 availability/geometry, filtering after simplification, importer, component topology, approach connectors and the rendering response. If the old route was valid and current behavior regressed, repair the regression and prove it against live DB. If the old route traversed an impossible physical gap, leave it disconnected and identify the exact missing link(s) for editor mapping/field survey. The software should still route every actually connected pair. Do not label the latter conclusion “routing solved everywhere.”

## 3. Accessibility graph and data contract

Extend existing route segments/edges and importer, without parallel graph services. The following values are logical fields; adapt names to existing schema and API. Existing data must be migrated safely, preserving IDs, notes, blocks, shortcut/main classification and geometry.

| Field | Values and rule |
|---|---|
| `lengthMeters` | Derived from geometry; finite, positive, recomputed on geometry edit. |
| `surface`, `surfaceCondition` | Known material and condition where tagged/editor recorded; otherwise `unknown`. Keep original tag/source. |
| `stairs` | `yes`, `no`, `unknown`; explicit OSM steps ⇒ yes. Do not infer no from missing tags. |
| `slopePercent` | Finite signed or magnitude as documented; otherwise null/unknown. Normalize OSM `incline` only when numeric and safely parsed. |
| `widthMeters` | Finite positive measured/reported value; otherwise null/unknown. Do not invent a default width. |
| `wheelchairAccess` | `yes`, `no`, `unknown`; honor explicit OSM/editor restrictions. Do not infer yes merely because it is a footway. |
| `confidence` | Evidence category such as OSM tag, editor observation, recent condition report or unknown; optional observedAt. Never invent field confirmation. |
| `kind` | Main or editor shortcut. Shortcuts stay excluded from Wheelchair under the existing product rule. |
| `manualBlocked` | Existing editor Block / Good for Routing persistent state. |

Use recognized OSM pedestrian and accessibility tags when present, such as `highway`, `access`/`foot`, `wheelchair`, `surface`, `smoothness`, `incline`, `width` and steps; preserve source values and handle malformed/missing values as unknown. Do not conflate surface material with condition, or the smoothness of individual steps with the traversability of the staircase. Existing application paths remain routable for Healthy by default unless blocked or explicitly inaccessible. For Wheelchair, a path with missing accessibility attributes can be a **conditional suggested route** but never a claim of confirmed accessibility. Known hard incompatibilities are excluded.

The editor's selected-segment inspector may add compact optional fields for these attributes; leave the existing Block / Good for Routing and notes flow easy to use. Server validates ranges/enum values and editor permission. No need to enter data for every path before ordinary routing works. Public route details show only relevant constraints and missing evidence, not raw schema fields or graph diagnostics.

## 4. Dynamic obstacle state

Use two separate mechanisms: existing persistent `manualBlocked` on a segment, and a new editor-published temporary obstacle associated with one or more exact stable segment IDs, with ID, short reason, createdAt, optional `expiresAt`, active/deactivatedAt, affected segment IDs. Optional expiry can be chosen from simple presets (e.g. 30 minutes, 2 hours, 1 day) or no expiry. If the UI already has an alert at a map point, choosing a location alone is informational; an obstacle blocks routing ONLY after editor explicitly selects affected route segment(s) and publishes it. Public user Send Note never automatically blocks a path. An obstacle can coexist with a public alert, but deleting a message/alert must not implicitly unblock it.

At request time, edge blocked iff `manualBlocked` OR at least one associated obstacle has `active = true` AND (`expiresAt is null` OR current server time `< expiresAt`). An expiry releases only that obstacle's effect, never the manual block or another active obstacle. Removing a temporary obstacle has the same scoped behavior. Make time comparisons on server/DB UTC. Existing active routes carry a network state/revision token or hash of currently effective conditions; ensure expiry changes the effective state even when no write occurs. Keep cache invalidation correct on create/edit/remove/expiry, graph edit and manual block. Restart must not resurrect expired obstacles.

While a public route is displayed, lightweight polling (about 10–15 seconds, plus on tab/window focus) checks the effective network state. When an event affects the currently displayed route, show a brief `Route changed; finding another way` notice and re-request with the SAME profile and latest known start position. If GPS was explicitly enabled, use a fresh permitted position when available; otherwise use the user's selected static start. Avoid silently moving start using inaccurate GPS, and never initiate GPS without the user's action. If an obstacle expired on the route or an alternative becomes available, permit recalculation or offer Refresh route. Do not reroute unnecessarily on unrelated graph changes; avoid loops or duplicate requests. If no route remains, clear the stale line, keep selected endpoints and explain the obstruction. A user can recalculate manually at any time.

The API response should include ordered GeoJSON geometry, source feature IDs for each traversed segment, accessibility summaries, conditional/known status, relevant notices, and effective network revision. Keep list and map layers synchronized so new obstacles/notes appear without requiring full page reload. No WebSocket service is required.

## 5. Route policy: constraints before distance

Create a deterministic centralized profile policy, not scattered `if` statements in UI and SQL. Evaluate *hard exclusions* before graph search. Then minimize a nonnegative cost on eligible edges. Dijkstra is sufficient at campus scale; A* is fine with an admissible straight-line heuristic in metres (base walking length when penalties are nonnegative). Never use a heuristic scaled larger than the minimum actual edge cost per metre. Stable tie breaks, deterministic edge iteration and explicit no-route reasons are required.

| Profile | Hard exclusions | Preferences |
|---|---|---|
| Healthy | Active obstacle, manual block, no pedestrian access, structurally invalid edge. | Shorter route; mild penalty for explicitly poor surface or steep slope. |
| Heavy luggage | Same universal exclusions. | Larger penalty for stairs, poor surface, steep slope; may still traverse stairs if needed; prefer smoother alternative even if longer. |
| Wheelchair | Universal exclusions + all editor shortcuts + known stairs + explicit wheelchair=no + known width/slope/surface condition outside documented conservative configurable prototype limits. | Prefer documented suitable main paths; strongly penalize missing/uncertain attributes without claiming safety. |

Choose one clearly documented set of provisional width/slope thresholds and unit tests; do not present them as a medical or legal guarantee. Missing values are UNKNOWN, not zero slope, infinite width or smooth pavement. For wheelchair: first try a route using only edges known to satisfy every required property; if none exists, search a second time allowing unknown attributes while still excluding known incompatible edges. Label the second result `Accessibility details are missing on some paths` and list which attributes/segments need checking. Never call it a fully accessible route. If neither result exists, say `No suitable wheelchair route found with current map data` and show a concise reason; explain that another path may need mapping/inspection. Do not draw a known blocked or stair route as a wheelchair solution merely to avoid an empty result. A contrasting alternative may be described as unavailable for this profile without a “go anyway” button.

For wheelchair destination buildings, keep the existing ground-floor lift notice separate from outdoor path eligibility: no recorded lift/unknown lift never suppresses a valid outdoor route. No new floor picker or indoor route. Route detail should explain a longer accessible/conditional path was chosen because the shorter candidate had stairs, narrow width, rough surface or an obstruction, but only for factors actually present in the data. No distance number needs to appear on public UI.

Explain the weights/thresholds and override precedence in code/tests. Splitting an edge must inherit access properties and shortcut kind; blocking a parent affects all children. Do not change healthy route topology when only a surface note changes. OSM importer and editor updates must not wipe saved observations/blocks.

## 6. Demonstrate expected challenge outcomes

1. Build a small isolated but realistic graph with two paths: short path has stairs/rough surface/narrow segment; longer path has known acceptable accessibility attributes. Healthy chooses the short path, wheelchair chooses the longer main path, Heavy luggage favors a smooth route if its weighted cost is lower.
2. Add a temporary obstacle to one chosen route edge: active route invalidates, map redraws the alternative using same start/destination/profile. An unrelated obstacle must not cause needless visible rerouting. Remove or expire it with controlled clock and verify original option becomes eligible again, including after API restart.
3. Block a parent segment after it has been split at start/destination/shortcut junction: every derived edge is excluded. Restoring Good for Routing does not override a still-active temporary obstacle or wheelchair shortcut restriction.
4. Simulate unknown width/slope on all candidate main paths: wheelchair receives a conditional route with explanation, not an unqualified accessible claim. Simulate known incompatible paths only: no wheelchair route and a helpful reason. No route through an obstruction for any profile.
5. Validate snapping along an edge and near buildings, same-edge subpath, disconnected components, missing approach, reversed coordinate/geometry direction, real OSM tags and idempotent import. The same true graph must be queried by all profiles.
6. Real campus acceptance: show one connected live journey with an actual plotted line and a real edit or isolated staging copy of a block causing rerouting/no-route; compare Central Library → LT with `b408eff` as specified above. If no alternate live path exists, demonstrate dynamic replanning on an isolated fixture and report exact coverage limitation, without modifying real campus truth.
7. Browser acceptance: desktop and mobile; public route changes after obstacle and expiry without full page reload; profile selection; clear stale lines; editor segment selection and obstacle expiry; normal alerts remain informational; existing floor, View, Send Note and shortcuts still work. Capture sanitized screenshots/logs.

## 7. Test, deploy, handoff

Run focused API graph and DB integration checks for topology, policy, TTL, cache/revision and geometry. Run frontend interaction tests for stale requests, live updates and explanatory UI. Then run existing `pnpm qa`, lint, formatting and production builds. Use a controlled clock for expiry tests instead of sleeps. Check the live DB read-only except safe migrations that preserve editor data; use staging/transactional fixtures for changing blocks or adding obstacles.

Keep existing Railway/Vercel environment variable contract and deployment settings. Do not require a new external routing service, PostGIS, paid service or extra account. Commit and push under existing authorization after review. If deployment is connected, run deployed health/web smoke after build and report separate deployment status; do not call a push proof of deployment. Include test counts, changed files, migration impact, commit, screenshots, limitations, and honest remaining software percentage.

The final report must answer plainly: **Why did routing fail in the live app? What was changed? Does Central Library → LT have a connected factual route now? Which paths are known or only conditionally suitable for wheelchair use? Does a new/expired obstacle trigger a new route?** If Central Library → LT remains genuinely disconnected, identify the exact missing path/junction and preserve that as a future campus mapping/survey task; do not claim it is fixed by algorithm changes.

Begin implementation now.
