# SGSITS Campus Access v2 — feature simplification and update

## 0. Execution instructions

Implement this in the EXISTING `sgsits-campus-access-v2` repository, normally at `C:\Users\yashw\Desktop\sgsits-campus-access-v2`. Do not create another project or replace the working application. Target model: GPT-6 Luna, High reasoning when available. Work in the small milestones below. This is an implementation request, not a request to write another plan.

This document supersedes conflicting product requirements in earlier build/repair briefs, particularly verification gates, OSM review, graph-readiness UI, multi-floor connector validation, floor publishing, and floor selection during routing. Preserve working features not explicitly changed here. Follow applicable repository instructions; distinguish old product specifications from security/tool instructions.

Keep React/TypeScript/Vite, MapLibre, React Konva, Express, PostgreSQL, existing pnpm workspace, Railway API/database and Vercel web setup. No PostGIS, separate routing service, new public accounts, AI service or framework migration. Keep the existing editor authentication. Existing OSM import and editor data are assets to preserve.

The user reports that the app now works. Previous reported reference: commit `b408eff`, Central Library → LT routing repaired. Inspect actual HEAD and current behavior; do not reset to that commit or treat old test counts as current evidence.

### Efficient execution and subagents

1. Read AGENTS.md, relevant package scripts and current git status. Locate relevant code with targeted `rg` searches. Read only files needed for the current milestone; avoid dumping lockfiles, generated assets or full database contents.
2. Write a short file/contract map in `docs/simplification-update-status.md`: actual modules, current schema, planned changes, completed checks, next step. Keep it under about 100 lines. Use it to resume without rediscovering the project.
3. Main agent owns schema, shared types, graph changes, migration, integration and final tests. Once contracts are settled, use up to TWO focused subagents if supported: one for the floor editor/viewer; one for outdoor/public UI and messages. Give exact file ownership, the relevant sections and acceptance IDs. Shared types, shared CSS, migration files and map core have one owner. Do not spawn recursive agent trees. If unavailable, work sequentially without stopping.
4. Prefer small vertical changes with focused checks. Do not repeatedly run the entire suite after cosmetic edits. Run the full applicable suite/build once after integration, then rerun affected checks for fixes.
5. Do not invent file paths, API behavior, passed tests or screenshots. Reuse existing endpoints where possible. The logical contracts below are requirements, not a demand to rename the whole codebase.
6. Continue through all milestones without asking permission for routine edits. Ask only for an actually missing credential/manual account action; give exact steps and continue independent work. Never print secrets or overwrite working .env files with examples.
7. After each major milestone report: `Completed: <specific result>. Estimated work remaining: <N>%. Next: <step>.` Estimate honestly; do not claim completion with broken interactions or unrun required checks. Keep updates short.

## 1. Fixed product decisions

| Topic | Required behavior |
|---|---|
| Verification | Remove Verified Path, Review OSM, review queues, approval gates, confidence legends and verification/provisional banners from product UI and routing eligibility. |
| Default paths | Every valid path in the application's campus route dataset is enabled by default unless blocked. This is a prototype eligibility policy; do not fabricate survey records or verification claims. |
| Blocks | Editor selects an actual route segment and chooses Block or Good for Routing. Block excludes it from all profiles. |
| Shortcuts | All NEW editor-drawn paths are shortcuts; usable by Healthy and Heavy luggage, excluded for Wheelchair. |
| Floor data | Editable layouts with one Save action; public viewing loads the latest successful save. |
| Lift/stairs | Availability is tracked only using ground-floor data. No upper-floor counterpart checks or served-floor logic. |
| Routing | Outdoor only. No floor/room selection, indoor path calculation or mandatory mapped door. |
| Public modes | Exactly View, Routing, Send Note. Send Note is the requested send-message function. |
| Messages | Private incoming list for editor, map location and note, keep or delete. No workflow/status system. |

“All paths” means the app's stored campus route features, not every line in a basemap tile or building outlines. Do not expand the campus boundary, import surrounding vehicle-only roads, convert malformed geometry to routes, or connect unrelated lines to satisfy this rule. Stop using old verification/review statuses to filter otherwise valid stored paths. Preserve explicit blocks and real structural exclusions such as malformed geometry, an out-of-campus way or a known inaccessible segment. Keep old provenance internally if needed; it must not gate the simplified product or become a false approval record.

## 2. Persistence and API contracts

Inspect the existing schema first. Extend/reuse it with small migrations; do not create duplicate route/floor/message systems. The following are logical fields, adaptable to existing names:

| Entity | Required persisted information |
|---|---|
| Path segment | Stable ID, display name/fallback, ordered geometry, source, main/shortcut kind, blocked flag, optional public note, connected endpoint identity. |
| Alert | Stable ID, geographic point, plain-text note. Exists until editor removes it. |
| Outdoor point | Stable ID, geographic point, existing name if supported, note. |
| Floor layout | Building ID, floor number, boundary/local coordinate system, components with stable IDs, labels and attachments, saved timestamp. |
| Building access | Has lift / has stairs derived ONLY from saved ground-floor lift/stair components; distinguish ground floor never saved from saved with neither. |
| Visitor message | ID, geographic point, plain-text note, created timestamp. Remains until deleted by editor. |

Use existing route grouping if present. Otherwise a “route” in the note dropdown means a stored selectable path segment, not a temporary calculated start-to-destination journey. Label unnamed items `Path 01`, `Path 02`, etc. with stable ordering; do not invent building names. Dropdown and map selection must reference the same stable IDs. A note applies to the selected feature's whole stored geometry and therefore to all graph subedges created from it.

Editor mutations require server-side authentication and validation. Public reads expose saved layouts, route notes/status, points and alerts. Public message submission stays anonymous with existing limits. Never render notes as HTML. Use a 240-character route-note limit and a 500-character point/alert/message limit, enforced on client and API; trim whitespace and reject empty required text. Preserve existing longer data until edited, show a concise preview with full text available. Do not automatically rewrite a user's note or introduce an AI summarizer.

Coordinate conventions: geographic GeoJSON is [longitude, latitude]; canvas components remain in stable floor-local coordinates. Hide raw latitude/longitude from the simplified UI, especially Send Note, but store and transmit them internally.

Writes must persist in PostgreSQL. Update client caches after success. Rebuild/invalidate the routing graph after path geometry, path addition or block changes. A note-only change refreshes note data without needing to rebuild topology. Public views refresh on focus/tab entry and after own mutations; while open, poll lightweight map metadata about every 30 seconds using existing query facilities. Do not add WebSockets. Preserve viewport and selections during refresh. If a displayed route becomes blocked, mark it outdated and recompute; never silently leave it as a usable route.

## 3. Editor — outdoor map

Keep an interactive campus map as the primary workspace, with a compact inspector. Retain building selection/search and clear selected-feature highlighting. Keep map resizing correct when changing tabs/panels. Remove Graph Readiness cards, node counts, component diagnostics, raw coordinate forms, OSM review lists and verification wording from normal product UI. Developer diagnostics may remain in logs/tests.

### 3.1 Select segment → routing status

- Make stored road/path segments selectable with a comfortable transparent hit area, independent of their visible stroke width. Selecting the map's decorative basemap road must not pretend to select a stored feature.
- Selected segment highlights and shows its name, current state and exactly two state choices: **Block** and **Good for Routing**. Use one clear save/apply action; persist before displaying success.
- Blocked segments remain visible in a red dashed style and can be selected to restore them. Good for Routing restores ordinary eligibility, but NEVER overrides the shortcut exclusion for Wheelchair or an existing explicit stairs/access constraint.
- If one displayed feature maps to several graph subedges, blocking it blocks ALL of them, including portions created by snapping. Repeated block/unblock requests are idempotent. Other segments are unaffected.

### 3.2 Notes in Route

- A dropdown lists stored routes/path segments. Choosing an item highlights it and loads its existing note.
- Inspector has a short plain-text note field with character count, Save and Remove note. No separate approval/publish workflow.
- Public View shows this note when that path is selected. Calculated routes show notes for traversed path IDs once each, in travel order. Route notes themselves do not block a path.

### 3.3 Alerts

- Choose Add alert → click/tap map → marker preview → enter note → Publish.
- Saved alerts are visible to public viewers. Selecting an alert shows its note. Editor can remove it and the public marker disappears after refresh.
- A point alert is informational; it does not block every nearby road. Blocking uses explicit segment selection above. Do not infer obstruction radius from note text.
- For a selected path, show attached route note, blocked state and any explicitly linked existing alerts. General point alerts remain selectable on the map; do not invent proximity associations.

### 3.4 Draw Path — real endpoint connections

- Draw a polyline with click/tap vertices; keep existing drag-to-adjust, Undo last vertex, Finish and Cancel controls. All newly saved paths are `shortcut` without asking the editor to classify them.
- BOTH endpoints must snap to existing saved route geometry before Save is enabled. They may connect to existing OSM routes or saved editor paths. Interior vertices may trace any needed shortcut, including across a building footprint, without altering that building or its floor data.
- Use a named snapping tolerance, starting at 12 screen pixels for interaction with a maximum physical distance of 5 metres. Compute distances correctly in projected/metre space. Show a clear snap marker. Require both conditions; never silently extend a distant endpoint to a route. Keep these constants internal, not extra editor settings.
- Snap to segment interiors as well as existing junctions. Persist the projection and parent-segment identity. Server independently validates the snap and campus scope using current geometry; return a clear error if the parent changed/disappeared.
- Atomically split the parent graph edge at a new junction, preserve full geometry and inherit the parent's block/profile/note metadata. Preserve stable parent feature IDs so dropdowns and blocks keep working. Both endpoints on one parent edge must split in correct order. Existing junctions must be reused rather than duplicated.
- Reuse the graph's current persisted or deterministic derived topology architecture. Do not persist a second graph just for this feature. A valid UI snap must result in the SAME connected junction in the routing graph after restart.
- A parent can currently be blocked: the new path stays connected but must not reset that parent's state. Normal route filtering decides whether the shortcut is reachable. A shortcut legitimately bypassing a blocked segment between usable junctions is allowed for eligible profiles.
- Crossings of the new path's interior with another path do not automatically create junctions. Only the explicitly snapped endpoints create connections in this update. Never connect different bridge/tunnel levels from a 2D overlap; respect existing layer/topology rules.
- Reject detached endpoints, zero-length geometry, nonfinite coordinates and self-intersecting new paths with a short actionable message. No detached drafts or readiness/publish workflow. After Save, show the path publicly and include it in the next eligible route calculation without manual import or server restart.

### 3.5 Add Points

Keep the working interaction: click map, adjust/drag dot, name if supported, enter note, Save. Public viewers see the saved point and note. Allow existing edit/remove actions. Remove Graph Readiness details and coordinate boxes; retain a simple Selected indicator. Do not make points new routing junctions automatically.

## 4. Floor canvas and public floor viewer

### 4.1 Selection and tools

Select/search a building on the editor map → select an existing floor or Add floor → canvas. Show building name and floor number; ground floor is numeric 0, displayed as Ground floor. Prevent duplicate floor numbers. Reuse existing supported floor numbering.

Allowed editing remains limited: rectangular rooms, doors attached to a room/building edge, named special dots, and ground-floor stairs/lift squares. Keep move/resize/rename/delete, wheel/trackpad zoom, pan and existing undo if already implemented. No percentage zoom selectors, new CAD tools, indoor routing, floor-to-floor connections or exit-to-network linking workflow.

Keep existing boundary geometry, room containment, inverse pointer transforms and edge attachment validation. Shapes must remain inside the floor boundary during movement/resizing and at server save. Labels do not intercept shape interaction. Do not resize the geographic building footprint just because a canvas component is resized.

### 4.2 Ground-floor access only

- Show stairs and lift tools ONLY on ground floor. Use the existing distinct square colors/icons.
- Compute building lift/stairs availability from the last SAVED ground-floor components. Unsaved edits must not affect public routing. Deleting the last lift changes availability after successful Save.
- Remove counterpart warnings, served-floor selectors, required connector IDs across floors, floor coverage validation and associated publication gates.
- Do not silently erase old upper-floor components. Render legacy stairs/lift shapes as layout annotations if present; they do not count toward availability or require counterparts. Allow removal. New stairs/lift placement is ground-floor-only and server-validated; preserve existing legacy objects on unrelated saves.
- No ground-floor data means availability unknown, not confirmed absent. A saved ground floor with no lift means no lift recorded. No inference from an upper-floor legacy marker.

### 4.3 Door appearance and placement

Replace dot doors with a visible door symbol: a short wall opening/line plus a perpendicular leaf and simple swing arc (or equivalent stick-like door icon). Rotate with the parent edge. Provide a larger transparent selection hit area. Use the same rendering in editor and viewer.

Keep edge snapping and parent-edge/normalized-position attachment so moving/resizing the room moves its door. Only ground-floor outer-boundary doors may retain an optional Exit label. No exit publishing, graph linking or exit-readiness gate. A mapped exit is optional for outdoor routing. Room-side and upper-floor doors cannot be marked Exit.

### 4.4 Labels

- Center the building name in the floor boundary's usable interior, fitting its available width; for a concave footprint use an interior point rather than an outside centroid. Keep it as subdued background text behind components so room labels remain readable.
- Center room names horizontally and vertically inside their rectangles. Center stairs/lift names inside their squares. Recompute available text box and font size from geometry whenever a block resizes; do not store unrelated label coordinates.
- Fit text with wrapping and sensible minimum/maximum sizes. If a label cannot fit, use ellipsis and expose the full name on selection/tooltip; never let it spill across neighboring rooms. Readability must be checked at initial fit-to-floor zoom and after resize.
- Points and doors need appropriately sized adjacent name badges/labels, not microscopic text; avoid obscuring the door symbol. Use a readable screen-size minimum with a restrained maximum during zoom. Full text remains available in the inspector/viewer popup.
- Names remain correctly placed after drag, resize, zoom, pan, save and reload. Share renderer/helpers between editor and public viewer to prevent divergent appearance.

### 4.5 One Save

One primary **Save** button saves the chosen floor and makes it immediately available to public viewing. Remove Save Draft/Publish/approval/readiness steps. Show Saving, Saved or a useful error; do not claim success before API persistence. Keep edits on failure. Warn before switching floor/building or leaving with unsaved changes. Existing saved layouts must remain visible after migration, including prior draft-only layouts if those contain the latest saved edits; choose latest saved content deterministically and preserve older data/history rather than destructively clearing it.

Use an atomic floor write, ideally existing updatedAt/version conflict handling, to prevent a stale browser tab overwriting a newer save. Public viewer is read-only with usable pan/zoom. Unsaved floors show exactly **No data available**; a deliberately saved empty floor may display its saved boundary. API/network failure must show Retry/error rather than masquerading as missing data.

## 5. Visitor messages

Editor tab shows a simple newest-first message list with a short note preview and optional received time. Click a message → highlight marker, center map to its location, show complete note. Keep the map visible or readily accessible on mobile.

Keep means leave the message in the list; it needs no database status or extra workflow. Delete removes that message only after server success. Provide one lightweight confirmation/undo safeguard using existing UI patterns. Deleting a message must not delete independently published alerts. Message submission never auto-publishes a public alert or blocks a path. Editor can use the existing alert tool at that location if desired.

## 6. Campus Access — public map

Use three obvious tabs/modes: **View**, **Routing**, **Send Note**. Only one active map interaction mode at a time; clicking a feature must not also place a start/message marker. Clean up stale event handlers and previews when switching. Retain OSM attribution, working mobile layout and normal map zoom/pan.

### 6.1 View (default)

- Select a path by map click or compact route dropdown to highlight it and read its concise note/blocked state. Alerts and saved outdoor points open their notes on selection.
- Select a building → popup with **View floor layout** → floor selector → saved read-only canvas. Keep the selected building context visible and provide Close/Back to map.
- No saved layout for the requested floor/building: **No data available**. Loading and request errors have separate states.

### 6.2 Routing

- Put Start and Destination inputs and all route controls in this section. Retain start GPS, searchable building/place selection, map-point selection and clear confirmed markers. GPS belongs only to Start. Handle permission denied without breaking manual selection.
- Remove floor, room, inside-building confirmation, exit selection and vertical navigation steps from the routing form and API requirements. Selecting a building means outdoor routing to that building.
- If a chosen geographic point lies inside a known building, resolve the building and route to its boundary approach. Prefer a suitable existing mapped entrance; otherwise reuse the already working nearest plausible boundary approach logic. Missing doors, floors or old verification statuses MUST NOT cause “no route-ready exit.” Do not draw a line through building interiors to a centroid or across a blocked path to bypass routing rules.
- For outdoor points, preserve current bounded snap/partial-edge routing. Search connected eligible paths, not a straight-line substitute. Preserve disconnected/no-route explanations and actual graph topology.
- Keep exactly Healthy, Wheelchair, Heavy luggage. All use enabled main paths; Healthy and Heavy luggage may use shortcuts. Wheelchair excludes ALL shortcuts, including paths split into graph subedges. Preserve explicit steps/non-accessibility exclusions already represented in data. “Good for Routing” does not override those profile rules.
- For Wheelchair with destination building: draw the available outdoor route regardless of lift metadata. Saved ground floor with no lift → **No lift is recorded in this building. Access to upper floors may be limited.** No ground-floor data → **Lift information is not available for this building.** Lift present → optional **Lift available**. Do not claim it serves every floor or refuse the outdoor route. Apply this also to map-point destinations resolved inside a building.
- Keep building-level stairs/lift info available from ground-floor data only. Do not introduce a floor picker or guessed upper-floor access into Healthy/Heavy luggage routing.
- Remove provisional/verified terminology, confidence color splits and warnings that require a survey before software use. Button text is **Find route**. Approximate boundary endpoints may use a compact **Building approach** label without mandatory entrance confirmation.
- Returned calculated-route notes are concise, ordered and deduplicated by source path/alert ID. Do not show graph internals, coordinates or long diagnostic prose. Point alerts remain on the map; only explicitly associated alerts need appear in route details.
- Change middle-of-road/path node dots to muted teal `#0F766E` with a light outline, selected dots to amber `#F59E0B`. If these dots are merely developer graph debug nodes, hide them by default on the public map; retain necessary selectable points in the requested new style. Calculated route stays clearly distinct (e.g. blue), start green, destination red. Use icons/line patterns as well as colors.
- Changing start/destination/profile invalidates the old route until recalculated. Clear route removes route overlays, not campus paths/alerts. A response from an older request must not overwrite newer selection results.

### 6.3 Send Note

Click/tap a point → visible movable marker → **Location: Selected** → note field → **Send**. Before selecting show **Select a location on the map**. Do not display latitude/longitude. Send is disabled until both location and nonblank note exist. On success show **Message sent to editor**, reset form; on failure retain it with Retry. Prevent duplicate submits while sending. Message is private to editor, not a public point.

## 7. Migration and deployment preservation

- Use a forward migration/compatibility change. Preserve IDs, geometry, notes, floors, attached doors, authentication and existing user data. No database reset, mass deletion, overwriting OSM import or synthetic paths in live data.
- Remove verification gating end-to-end: query filters, graph assembly, floor reads/writes, API validation, UI and stale tests. Do not just hide buttons while backend still refuses routes/saves. Retain legacy columns if dropping them is unnecessary; new queries ignore their old approval semantics.
- Backfill missing block state as false; retain true blocks. Preserve source kind: existing shortcuts remain shortcuts, existing main paths remain main. All new drawn paths are shortcuts. Do not classify every old editor path as main to bypass Wheelchair exclusions.
- Reconcile legacy rejected/review rows using actual reason: an approval-only status must not gate a valid stored campus path; an explicit obstruction/block or structural geometry exclusion must be preserved. Log ambiguous legacy reasons for developer review instead of wiping all restrictions blindly.
- Ensure graph splitting retains parent metadata, public feature IDs and attached notes/alerts. Make import idempotent without resetting editor blocks or notes. Persist new paths so reimport/restart does not discard them.
- Keep Railway/Vercel config, scripts and working env names. Local API uses reachable public database URL; deployed API keeps Railway internal DB reference. Never put database/editor secrets in VITE variables.
- No new paid services or account setup should be needed. If manual setup is genuinely necessary, give one exact checkpoint and proceed with independent work. Deliver deployable code with existing build/start/migration commands intact. Honor any existing user authorization for commit/push/deployment; otherwise provide the reviewed local change and exact next deployment step without assuming it is live.

## 8. Milestones

| Stage | Deliverable | Suggested estimated remaining |
|---|---|---|
| 1 | Inspect current code/data, establish contract and scoped migration | 90% |
| 2 | Remove gates; implement blocks, notes, atomic shortcut connectivity | 65% |
| 3 | Outdoor editor, alerts, points and simple visitor messages | 45% |
| 4 | Ground-floor availability, one-save floor canvas, labels and viewer | 25% |
| 5 | Public modes, simplified outdoor routing and messages integrated | 10% |
| 6 | Regression/browser/build checks, findings fixed, handoff | 0% software only when passed |

These are estimates, not forced reporting values. Use two agents only after Stage 1 contract is stable; integrate their work before completion. If a graph/migration failure remains after two targeted evidence-based fixes, summarize the failing test/cause and suggest GPT-6 Sol for that isolated task; do not silently switch models or start a rewrite. Continue unrelated work.

## 9. Required acceptance checks

Use isolated fixtures/transactions or a separate test database for destructive tests. Never mark real campus roads blocked or seed fictitious shortcuts into live data just to make a test pass. Use existing test/browser tooling.

| ID | Scenario | Required result |
|---|---|---|
| A01 | Public + editor navigation | No Verified Path, Review OSM, Graph Readiness, provisional confidence UI, floor publishing or routing floor picker. |
| A02 | Central Library → LT; building lacks saved doors | Visible connected outdoor route without verification/exit-readiness gate. |
| A03 | Block a selected parent path; recompute all profiles | Every derived subedge excluded; alternative or accurate no-route. Good for Routing restores main eligibility. |
| A04 | Route note save/edit/remove; reload | Viewer sees persisted note; calculated journey deduplicates it and updates after removal. |
| A05 | Add/delete a point alert | Public visibility updates; alert alone does not block a route. |
| A06 | Draw path with one/both detached ends | Save refused with endpoint-specific message; no partial DB records. |
| A07 | Snap new shortcut to two segment interiors, including same parent | Actual continuous graph connection, preserved parent notes/blocks, correct partial routing and restart persistence. |
| A08 | Shortcut eligibility | Healthy/Heavy luggage can use it when suitable; Wheelchair never uses it, including derived subedges. |
| A09 | Block status around split junction | Split does not unblock parent or leak blocked subedges into routing; rollback works on invalid save. |
| A10 | Outdoor point click/drag/note/save | Public marker/note survives refresh; no readiness panel or coordinate form. |
| A11 | Building/floor select, Add floor, duplicate floor | Existing layout loads; duplicate rejected; no raw building ID entry. |
| A12 | Room/door/dot edits at zoom; resize + labels | Bounds/attachments remain correct; labels center/fit; door is clearly door-shaped in both views. |
| A13 | Ground-floor lift add/save/delete; upper legacy marker | Availability follows saved ground floor only; no upper-floor counterpart warning; legacy layout data preserved. |
| A14 | Save floor and view publicly in another session | One Save publishes latest saved data; refresh persists it; failed save retains edits. |
| A15 | Missing floor vs server failure | Exact No data available for missing layout; useful error/Retry for failed requests. |
| A16 | Wheelchair destination building with/without/unknown lift | Outdoor route still displays; correct building-level notice; no floor selector. |
| A17 | Send Note then editor select/keep/delete | Selected indicator without coordinates; private persisted message; correct map highlight; delete affects only message. |
| A18 | Switch modes, rapid route requests, map resize | No stale click handlers/overlays, wrong markers, stale response overwrite or blank map. |
| A19 | Existing blocked/disconnected and same-edge routing | Proper no-route/partial geometry; no straight-line teleport or bypass connector. |
| A20 | Editor authorization | Anonymous reads work; unauthorized edits/deletes rejected; public message submission remains supported. |
| A21 | Migration/reimport/restart | Existing notes, blocks, geometry, floors and saved shortcuts preserved without duplicates. |

Cover graph/filter/migration cases with focused automated tests. Exercise UI workflows in a real browser at desktop (~1440px) and narrow/mobile (~390px) widths, including save then reload. Capture useful screenshots of public tabs, selected blocked path, snapped shortcut and floor labels/door symbols. Run typecheck, lint and production builds through existing package scripts; fix actual console/network errors. Update stale tests to reflect these decisions rather than deleting tests to turn the suite green.

## 10. Final handoff

Update concise README instructions and `docs/simplification-update-status.md`. Report implemented changes, migration impact, checks actually run, screenshot paths, remaining issues and whether changes are local/committed/pushed/deployed. Do not guarantee bug-free behavior or count previous-run tests as current results. A completed build is not evidence of a successful deployment; check deployed URLs only if available and deployment is authorized.

Start with Stage 1, then implement all stages. Do not stop after producing a plan.
