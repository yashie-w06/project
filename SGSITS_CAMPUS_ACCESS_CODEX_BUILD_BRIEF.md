# SGSITS Campus Access v2 — complete Codex implementation task

Model: GPT-5.6 Sol, Medium reasoning. Execute this task in a **completely new** Windows project at `C:\Users\yashw\Desktop\sgsits-campus-access-v2`. Do not modify `C:\Users\yashw\Desktop\sgsits-campus-access` or the older `New folder (3)` prototype. The output must be working code, tests, and Railway/Vercel deployment configuration, not a plan or more paste-by-paste instructions. Give concise milestone updates. Continue autonomously after each milestone.

## 0. Do these setup actions first

1. Create the new folder, initialize git and a pnpm workspace with `apps/web` and `apps/api`. Use React + TypeScript + Vite, MapLibre GL JS, React Konva, React Router, Express 5 + TypeScript, `pg`, Zod, Jose, and `fast-xml-parser`. No Next.js, PostGIS, ORM requirement, separate routing service, visitor accounts, or additional hosted service.
2. Copy the latest `SGSITS-campus-complete(2).osm` into `apps/api/data/campus.osm` from the old project's `apps/api/data/campus.osm` if it exists. Check its content and size; the known extract is about 178,674 bytes. If neither copy exists, ask the user to put the file at that precise path, then resume.
3. Create `.gitignore` and these example and local environment files immediately. The local files contain **dummy data**; do not try to connect with it. Never commit local `.env` files, print secrets, or copy real values into examples.

```dotenv
# apps/api/.env.example and initial apps/api/.env
DATABASE_URL=postgresql://REPLACE_USER:REPLACE_PASSWORD@REPLACE_RAILWAY_PUBLIC_HOST:REPLACE_PORT/railway
EDITOR_EMAIL=editor@example.com
EDITOR_PASSWORD=REPLACE_WITH_PRIVATE_PASSWORD
EDITOR_TOKEN_SECRET=REPLACE_WITH_32_OR_MORE_RANDOM_CHARACTERS
WEB_ORIGIN=http://localhost:5173
PORT=3001
```

```dotenv
# apps/web/.env.example and initial apps/web/.env
VITE_API_URL=http://localhost:3001
```

4. Build all code, migrations, interfaces, and independent tests before requesting Railway credentials. When actual database connection is the remaining blocker, give the user exact manual steps to create/select a Railway PostgreSQL service and enter its **public** connection URL into their local `apps/api/.env`. Ask them to say “done,” then check the connection without printing it and run migrations/tests. A `postgres.railway.internal` hostname is for Railway services, not the user's Windows machine. If a local PostgreSQL instance is available, use it for earlier development tests without delaying work.
5. For Vercel/Railway account actions that cannot be performed automatically, pause only at the relevant checkpoint with precise dashboard steps. After the user completes them, resume the same task through deployment checks. Do not repeatedly ask for permission on ordinary code edits.

## 1. Agent roles and token discipline

Spawn **two bounded subagents**, with nonoverlapping ownership:

- **OSM/routing subagent:** inspect the provided extract and screenshots/context, implement importer/graph/routing modules and focused graph tests. Own only `apps/api/src/osm/**`, `apps/api/src/routing/**`, and their tests. Report factual data limitations concisely.
- **Floor editor subagent:** implement the limited React Konva floor editor and focused editor tests. Own only `apps/web/src/editor/**` and its tests.
- **Main agent:** own workspace setup, SQL schema/migrations, Express endpoints/auth, public map/user flow, outdoor editor, deployment configuration, and integration. Integrate both subagent outputs; do not have agents edit the same file. Keep at most these two subagents active. Give each the requirements from this document relevant to its ownership.

Inspect installed versions and actual files before changes. Use existing official library APIs and fix compatibility issues by testing. Avoid lengthy speculative research and repeated full-suite runs. Make a git checkpoint after each working milestone. Continue until acceptance checks pass or a clearly identified user-owned setup step blocks progress.

## 2. Nonnegotiable data facts

The old attempt parsed 49 building outlines and 45 path segments from 15 OSM highway ways. Its dark path overlay crossed building areas and had disconnected ends; the initial graph had two components. The OSM campus boundary also cut across several building shapes. A prior “empty allowlist” that merely hid all OSM routes was rejected. **Do not copy that workaround or claim blank routes are a fix.**

Build a separate, editor-correctable **verified walking graph**. Import OSM ways as reference candidates with source IDs, not automatically trusted route edges. Inspect their actual coordinates and geometry against the OSM basemap. Allow the editor to correct/approve useful main paths, draw missing main paths, and add unofficial shortcuts. No route is suggested across an unverified gap. Never automatically join lines merely because they are close if that could cross a wall, building, or inaccessible area. A physical route still requires editor/site verification; report remaining unverified coverage honestly.

Keep raw OSM immutable. Static building polygons and names may be imported, but a building footprint is only an approximate floor outline. Do not silently delete buildings outside the imperfect campus boundary. Use the boundary as a display/reference layer until corrected. Keep OpenStreetMap attribution on the map. Raster tiles are only a visual background, never routing data.

## 3. Pages and public flow

Only three page routes:

- `/` — public campus map and route form, building/floor side panel, and issue/note submission.
- `/edit/login` — designated editor login.
- `/edit` — protected editor with map, outdoor tools, building/floor editor, visitor messages, and alerts. No separate building page; use a side panel.

**Current location**: choose phone GPS, search a building/place, or click/tap the map. Show a marker and confirmation step. GPS provides lat/lon and estimated accuracy but does not prove a user is inside a building; suggest a building when appropriate and allow correction. If inside, ask for the building, current floor, and which mapped ground-floor exit will be used. If outside, connect the selected point only to a plausible verified route; present a no-route state if not connectable.

**Destination**: search building, room, facility, gate, or named saved point, or tap the map. Highlight and confirm it. For a building, choose floor and room/facility when mapped or “building entrance only.” Suggest an entrance connected to the walking graph and let the user override it. Do not draw a straight line to a building centroid through walls. The map may show any chosen spot's coordinates; OSM does not need a node at that spot.

**Floor display**: clicking a building opens the panel beside the map. Its floor selector shows saved room rectangles, doors, special dots, stairs, and lifts. It lists mapped vertical access. **No indoor turn-by-turn route calculation** in this prototype.

**Report**: any visitor can tap a map spot, enter a description, and send lat/lon plus description to the editor. No visitor login, public ticket, status, history, or tracking process. Use basic input validation and rate limiting for this public write.

## 4. Travel profiles and routing

Exactly three choices: **Healthy**, **Wheelchair**, **Heavy luggage**.

- Run A* in the Express API on the editor-verified outdoor graph. Use internal geographic length for edge weight, but never display distance metres to the user. A* must use stable node/edge IDs and recompute after an edit or block.
- `main` path edges are available to all three profiles unless blocked. For the prototype, treat verified ordinary mapped outdoor paths as wheelchair usable. `shortcut` edges are usable by Healthy and Heavy luggage, **never Wheelchair**. Exclude blocked edges for all profiles. If no connected route exists, return a clear no-route result; do not fabricate a straight connector.
- For an upper-floor destination: Healthy sees the mapped stairs/lifts; Wheelchair sees “compatible” if a mapped lift serves the selected floor, otherwise a warning; Heavy luggage prefers the lift and receives a warning when only stairs are mapped. Use “not mapped” for missing data, not a claim that no physical lift exists. Apply relevant availability notices to an indoor start as well.
- The route starts from the selected exit when the start is inside a building and ends at the selected/suggested entrance for an indoor destination. Floors and rooms provide information only, not an indoor route line.
- Snapping a user-picked outdoor start/destination or a route endpoint to a segment must use a bounded threshold in a local metric projection and expose the snap to the user/editor. Splitting an edge at a snap point must preserve topology. Intersections only connect when explicitly represented as a shared graph node; lines that cross at different levels or without a junction remain separate.
- The editor may draw an unofficial shortcut whose line crosses a building footprint. It remains an outdoor graph edge and **does not mutate or create floor features**. The editor confirms it is physically walkable. Wheelchair routing excludes it.

## 5. Editor interactions — exact scope

**Outdoor editor**:

- Search or click a building, or click the outdoor map to place a small draggable named special point. Save exact lat/lon; GeoJSON uses `[longitude, latitude]`.
- A route-drawing tool creates a polyline from short connected segments with movable vertices. Endpoints snap visibly to existing verified path nodes/segments. The editor can classify and save it as `main` or `shortcut`. New detached lines remain drafts/nonroutable until connected. Allow editing and removing lines and correcting/approving OSM reference candidates. Distinguish a route's visual crossing from a real junction.
- The editor receives visitor messages with location and description. They may publish an alert marker visible to all. A blocking alert requires the editor to select the exact affected path edge(s); the graph excludes them immediately. A normal alert has no routing effect. The editor can unblock or remove the alert. No ticket workflow.

**Interior editor**: select building by map click or search, select floor, then open a bounded floor canvas. Limit drawable component types to the later agreed list below (do not reintroduce generic triangles/circles/polygons):

- Named **rectangular room**; drag/resize within the floor boundary.
- **Door** dragged from toolbar onto a room side or building outer boundary; snap to that edge, persist parent edge/space and position. Only a **ground-floor door on the outer building boundary** exposes “Mark as exit.” A marked exit must have outdoor coordinates and a selected verified main path connection before it can be used for routing. A room door or upper-floor door cannot be marked exit.
- Named small **special-point dot**, with floor-local coordinates.
- **Stairs** and **lift** as differently coloured square boxes. Matching boxes on the floors they serve share a connector ID. Warn when an expected upper/lower placement is missing; do not claim that floor is lift served without a matching saved marker.

The OSM footprint starts the editable floor boundary, but the editor may correct it. Every complete shape must remain within the floor boundary on creation, drag, resize, and save; checking only its centre or clipping the picture is insufficient. Use a single stable floor coordinate system, independent of zoom/pan. React Konva supports selection, drag, resize, pointer-centred wheel zoom, and pan by dragging empty space. No fixed 50%, 100%, 150% buttons. Add Undo, Save, reloadable draft, and a user-view preview. Persist edits across refresh and API restart. Keep the interaction simple and avoid the prototype's previous shape-boundary bugs.

## 6. Suggested file ownership and database contract

Use a pnpm workspace with these modules; names can vary only when they improve clarity without changing responsibility:

```text
sgsits-campus-access-v2/
  pnpm-workspace.yaml
  package.json
  README.md
  .gitignore
  apps/
    api/
      .env.example
      data/campus.osm
      db/001_init.sql
      src/server.ts
      src/config.ts
      src/db.ts
      src/auth.ts
      src/osm/import.ts
      src/routing/graph.ts
      src/routing/astar.ts
      src/routes/{public,editor}.ts
    web/
      .env.example
      vercel.json
      src/App.tsx
      src/map/CampusMap.tsx
      src/pages/{PublicMap,EditorLogin,Editor}.tsx
      src/editor/FloorCanvas.tsx
      src/editor/OutdoorEditor.tsx
```

One PostgreSQL database. Use migration SQL with primary/foreign keys, checks, and indexes. Minimum persisted entities:

| Entity         | Required fields                                                                                                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| buildings      | stable OSM/string ID, name, footprint GeoJSON, optional mapped level count                                                                                                      |
| floors         | building ID + floor number, editable boundary, draft/published layout version                                                                                                   |
| floor_features | stable ID, building/floor, kind (room/door/point/stairs/lift), name, local geometry, door parent/edge, connector ID, exit flag, optional outdoor position and linked graph node |
| outdoor_points | ID, name, longitude/latitude as double precision                                                                                                                                |
| route_nodes    | ID, longitude/latitude                                                                                                                                                          |
| route_edges    | ID, from/to node IDs, polyline coordinates, `main` or `shortcut`, verified flag, blocked flag, optional source OSM ID                                                           |
| messages       | ID, longitude/latitude, description, created timestamp; no user-facing status                                                                                                   |
| alerts         | ID, longitude/latitude, description, active flag, affected route-edge IDs                                                                                                       |

Store structured coordinates as JSONB where appropriate; never use one database row per map pixel. Use transactions for endpoint snaps/edge splits, exit linking, and block changes. Validate all payloads with Zod and reject invalid ranges, off-boundary room shapes, invalid exit placement, and unauthorized writes. Allow incomplete stairs/lift placements and detached lines to persist as **drafts with warnings**. Reject missing served-floor matches or dangling route endpoints only when publishing them as route-compatible/verified; drafts never enter A*. Keep editor auth on the API with a signed short-lived token; the editor credentials and signing secret are server environment variables. Rate limit login and public message submission. Never expose `DATABASE_URL` to the frontend.

Minimum API endpoints (use the JSON contracts below and document examples in README):

- Public: `GET /api/health`, `GET /api/map`, `GET /api/buildings` and floor details, `GET /api/search?q=`, `POST /api/route` with confirmed start/destination/profile, `POST /api/messages`.
- Editor: `POST /api/editor/login`; authenticated list/save/update/delete for floors/features, outdoor points, route nodes/edges and OSM candidate verification; authenticated message list, alert publishing, block/unblock.
- Return 400 for bad input, 401 for missing/invalid editor token, 404 for unknown IDs, 409 for conflicting graph edits, and a distinct successful “no route” response when disconnected. Do not expose stack traces.

### Concrete contracts and invariants

Use these shapes as the shared frontend/backend contract. Add `apps/web/src/types.ts` and matching Zod schemas in the API; coordinate arrays are always GeoJSON `[longitude, latitude]`. The server is authoritative for spatial checks and graph edits. Persist JSONB GeoJSON in WGS84; for snapping, length, and pointer conversion use a local metre-scale projection around campus, then transform back. Do not calculate metres from raw degrees. A floor has one stable `localWidth`/`localHeight` coordinate frame derived from its editable footprint; zoom and pan transform only the view. Keep an explicit floor-to-map transform so an exit's boundary position maps to a reproducible outdoor lat/lon. On a footprint correction, preserve/recompute this transform and explicitly preview affected features/exits before publishing.

- `GET /api/map` returns `{buildings: FeatureCollection, referencePaths: FeatureCollection, verifiedPaths: FeatureCollection, points: FeatureCollection, alerts: [...]}`. Reference paths use a subdued dashed style and are not route edges; verified main and shortcut paths have distinct styles. Apply a consistent published-only filter for visitor-visible paths, floor layouts, points, and alerts.
- `GET /api/buildings/:id/floors/:number` returns the published boundary, stable local dimensions, features, and available matching lift/stair connector IDs. A building without floor data shows “No floor layout mapped” rather than an invented floor.
- `POST /api/route` accepts `{profile:"healthy"|"wheelchair"|"heavy_luggage", start:{kind:"outdoor",coordinates:[lon,lat]}|{kind:"building",buildingId,floor,exitDoorId}, destination:{kind:"outdoor",coordinates:[lon,lat]}|{kind:"building",buildingId,floor,entranceDoorId,roomId?}}`. Resolve building endpoints only through saved valid exterior ground-floor doors linked to verified graph nodes. Validate that optional room belongs to selected floor, but do not pretend to route through it. Respond `{status:"ok",geometry:LineString,notices:[...],selectedEntranceDoorId?}` or `{status:"no_route",reason,notices:[...]}`; no distance displayed. A picked outdoor location connects only within the configured bounded snap radius to verified outdoor edges, never across a building merely because a node is nearby. Show the snap/location correction in the UI.
- `POST /api/messages` accepts `{coordinates:[lon,lat],description}`; require a bounded campus-area coordinate, trimmed nonempty description with maximum length, and basic server-side rate limiting. Public response is a simple received acknowledgement. Editor can list messages and place an alert using a message location, without creating visitor ticket status.
- Editor authentication is one configured editor email/password. Hash and verify the password server-side (a password hash env variable is preferable to a plaintext password in production); use an HttpOnly, Secure-in-production, SameSite-compatible session cookie or documented short-lived signed token. CORS and credentials settings must match the chosen method. Every mutation endpoint checks authorization on the server. Do not make the editor password a frontend build variable.
- Editor writes use stable IDs and an optimistic `version` on a floor or graph object. Save a floor and all its features in one transaction; saving a draft is allowed even if connector matches or edge links are incomplete. Publishing validates the whole floor, connectors serving the marked floors, exit doors, and graph references. Return 409 with affected IDs on stale versions. A successful edit appears after reloading the endpoint and restarting the API.
- An OSM candidate has its source way ID, ordered node IDs/coordinates, import status, and reviewer decision. The importer upserts using stable OSM IDs; a second run yields the same entities without duplicating editor edits or erasing corrections. A candidate becomes a verified main edge only after a deliberate editor review. Expose an endpoint and UI to review, split, reshape, or reject it. Use source geometry for comparison, not as a hidden graph input.
- Route edges join stored graph nodes only. When an editor endpoint snaps to the middle of an existing verified edge, atomically split that edge into two geometry-preserving edges at a new node and attach the new route there. When the editor connects two touching routes, make the shared node explicit. Ensure reverse travel works unless an edge is deliberately specified as one-way; the prototype defaults to two-way walking. Graph changes invalidate or rebuild in-memory routing state immediately.
- Blocks reference stable route-edge IDs. A block flag or active alert-edge relation is sufficient, but both editor API and routing must use one effective-block calculation. An alert may cover several selected edge IDs. Deleting/unpublishing an edge updates dependent blocks and exit links transactionally or reports a conflict for editor repair; never leave a route pointing to a vanished edge.

UI state order: public user chooses and confirms **start**, chooses and confirms **destination**, chooses one of the three profiles, then requests a route. Building start requires floor plus ground-floor mapped exit choice; building destination requires floor plus suggested/overridden ground-floor entrance, with optional room. If GPS suggests an interior building, confirm it rather than auto-selecting it. If there is no valid entrance/exit link, explain this before or in the no-route response. The map remains visible beside the side panel on desktop and under/behind a usable drawer on narrow screens.

Editor state order: login → find building/outdoor location → select outdoor or floor tool → make edit → preview warnings → save draft or publish valid change. Room drag and resize must validate all four corners plus edge containment against the actual floor polygon, including concave boundaries. Door placement projects the pointer to an eligible parent edge and stores a normalized position along that edge; moving/resizing the parent recalculates the door or warns for repair. Only a door whose parent is the ground-floor **building exterior boundary** can have `isExit=true`. A floor special dot remains in local floor coordinates; an outdoor special dot remains in WGS84. For stairs/lifts, editor assigns a shared connector ID and served-floor list; warn when any listed floor is missing its marker. A draft may be incomplete, but public accessibility claims use only complete published connectors.

Manual environment checkpoints are strictly scoped: creating Railway PostgreSQL and supplying the local `DATABASE_URL` when DB execution becomes necessary; completing Railway and Vercel dashboard/repository links and production secrets when deployment becomes necessary; and confirming physical walkability of questionable campus routes before marking them verified. The agent must perform all other code, configuration, and tests without sending a sequence of paste commands to the user. Give one exact action list at each checkpoint and wait for “done”; do not ask the user to paste a connection string or password into chat.

## 7. Implementation order and manual checkpoints

1. Create the fresh repository/env placeholders and inspect source OSM. Build both packages and a public health/map view. Confirm MapLibre's import/worker compatibility with installed versions. Render buildings and reference geometry without treating inaccurate ways as verified routes.
2. Build SQL migrations, importer, candidate/reference-path review, graph editor, A*, and persistence. Subagents work in parallel within their owned files. Integrate with public start/destination/profile flow.
3. Build protected editor login, outdoor editing, reports/alerts/blocks, then limited floor editor. Reload every saved object to prove persistence. Implement search, floor panel, and upper-floor notices.
4. Use local PostgreSQL if available to test persistence. Otherwise finish code and graph/UI tests first, then ask the user to set up Railway PostgreSQL and fill `apps/api/.env` locally. Resume after “done”; test connection, migrations, insert/read/restart persistence, routing edits, and blocked edges. Ask for any physical path verification needed to make the live campus graph trustworthy; show the exact map area/route candidate and resume after the user marks it.
5. Prepare Railway API service and Vercel web project. If account login, repository connection, variables, or publication requires the user's manual action, state exact steps once at that point, then continue after completion. Never claim deployment or path accuracy without testing.

## 8. Deployment configuration

**Railway:** configure root directory `apps/api` (or a documented workspace-aware build), lockfile-aware install, TypeScript build and Node start, migrations as a controlled deploy step, `PORT` supplied by Railway and listener bound to `0.0.0.0`. Use Railway PostgreSQL `DATABASE_URL` reference inside Railway; editor secrets and `WEB_ORIGIN` are service variables. Health endpoint reports both process and DB readiness without revealing secrets. Ensure the OSM-derived static files required at runtime are included in the deployment. Do not use a Windows-local path in deployed code.

**Vercel:** configure root directory `apps/web`, build to `dist`, `VITE_API_URL` set to the public Railway API URL, and `vercel.json` SPA rewrite so refreshing `/edit/login` and `/edit` works. The API CORS allowlist must include the exact Vercel origin. Keep editor writes protected regardless of frontend routing. README must list exact dashboard settings, local run commands, migration command, env variables, and deployment smoke-test URLs.

Production tile usage must respect the map provider's policy and display OSM attribution. Do not put a Railway DB secret in any Vite variable.

## 9. Acceptance checks — all must pass before calling it complete

- Fresh clone/install, typecheck, production builds, and API health succeed. The importer is deterministic and retains 49 building footprints from this extract unless a documented data issue explains a different count. Wrong/disconnected OSM road candidates never silently become trusted routes.
- Search and map click identify the same saved building/point after refresh; GPS can be corrected. Start inside selects floor and real exit; destination floor/room/entrance selection works. A floor panel renders saved features.
- Editor-only writes reject anonymous requests. Rooms cannot leave floor boundary. A room door or upper-floor exterior door cannot be marked exit; a valid ground-floor exterior exit needs a verified path link. Stairs/lifts warn on missing connected-floor placements.
- A saved outdoor point retains coordinates; a connected editor main route changes the graph. A shortcut is suggested for Healthy/Heavy luggage but never Wheelchair. A blocked edge is excluded for every profile and becomes available again when unblocked. An unconnected destination returns no route rather than a straight line.
- Visitor message reaches editor with description and coordinates. Publishing an ordinary alert leaves routing unchanged; choosing specific blocked edge(s) changes routing. Refresh/API restart retains edits.
- Upper-floor notices reflect mapped lifts/stairs; no indoor route line is fabricated. The public UI does not display distance in metres.
- A browser check covers desktop and mobile map/side panel, smooth floor zoom, drag and save, and Vercel SPA deep-link refresh. Railway API/database and Vercel frontend smoke checks are performed once real setup is supplied.

At completion, report working URL(s) if actually deployed, changed files, concise test evidence, and any campus-path areas still awaiting field verification. If external setup remains incomplete, state the exact blocker and next manual action; do not call it bug-free or deployed merely because code compiled.
