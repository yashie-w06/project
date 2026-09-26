# Complete application repair findings

## Outcome

The public route flow, outdoor editor, indoor floor editor, and routing engine were repaired as one integrated application. Browser verification was performed at desktop and mobile sizes with labelled test fixtures, followed by a live local-browser smoke test against the Railway-backed database.

No campus route was approved during this work. The previously published OSM carriageway (`995119335`) was safely changed to `verified=false`, `published=false`, and its candidate was changed to `needs_edit`. Its geometry and nodes remain available for later review. The live database now has zero verified/published real-campus route edges, so unconnected real locations display **“No verified route available.”**

## Root causes and repairs

- Route snapping did not consistently use the same profile/block eligibility rules as A*. Snapping now filters the same eligible edge set and rejects non-finite coordinates.
- Two points snapped to the same edge could create incorrect full-edge geometry. Ordered, topology-preserving edge splitting now returns only the requested partial segment.
- Graph inputs could contain slightly mismatched edge endpoints. Graph construction normalizes tolerated offsets, validates continuity, and reports deterministic connected components.
- Public location selection mixed search, map picks, and confirmation state. It is now an explicit Start → Destination → Profile/Route flow with stable result selection, edit/back actions, and GPS only on Start.
- No-route behavior depended on parsing free-form text. The API now returns typed reason codes and the UI maps every failure to visitor-safe language beginning with “No verified route available.”
- The outdoor editor was form-led and obscured spatial context. It is now map-first with explicit point, path, OSM-review, and alert/block tools; detached paths remain non-routable drafts.
- OSM review and publication are separated. Reference approval never publishes a route; publication requires an explicit physical-verification confirmation and server-side graph checks.
- Floor editing used a raw building ID and fixed-size canvas. It now provides mapped-building search/map selection, saved floor selection, responsive canvas sizing, centered labels, reliable inverse transforms, geometry containment checks, and versioned draft/publish persistence.
- Exit linking was incomplete. A ground-floor exterior exit can now be linked only to a node on an already verified, published main path, in a transaction.
- Alert management could create blocks but did not expose a complete resolution workflow. Active/resolved alerts and their affected edges are now returned to the editor and can be toggled safely.

## Data observations

The sanitized live audit found 49 buildings and 15 OSM reference candidates. There are no floors or floor features yet. After quarantine, the one retained route edge is a non-routable draft/reference. Candidate decisions are 13 pending, one needs-edit, and one rejected. On-site classification remains the task in [`field-verification.md`](field-verification.md).

## Verification performed

- TypeScript typecheck for API and web.
- API and web unit tests, including routing profiles, block/unblock, same-edge splitting, disconnected components, finite geometry, floor containment, door/exit validation, and public wizard state.
- Railway-backed integration fixtures with unique IDs and cleanup for auth, routing profiles, same-edge output, messages, alerts, persistence/restart, and floor save/reload.
- Playwright desktop and mobile flows for the public no-route path and map-first floor editor.
- Live Chromium smoke test using real mapped buildings, the real local API/Railway data, editor authentication, honest no-route output, and floor canvas loading. It performs no persistent editor mutation.

Generated review screenshots are written to ignored `test-results/` by the browser suites. Run `pnpm test:e2e` for fixture screenshots and `node tests/e2e/live-smoke.mjs` while local API/web servers are running for live screenshots.

## Deployment configuration

Railway uses the repository-root `railway.toml`, builds the API, runs migrations plus the idempotent OSM reference import before deployment, starts the compiled server, and checks `/api/health`. Production `DATABASE_URL` must use Railway’s internal `${{Postgres.DATABASE_URL}}` reference; never use the local public proxy URL there.

Vercel uses `apps/web` as its root, the Vite build, `dist` output, and `apps/web/vercel.json` SPA rewrites. Set `VITE_API_URL` to the public Railway API origin. Set Railway `WEB_ORIGIN` to the exact Vercel production origin.

## Remaining non-software work

Physical route verification is deliberately deferred and does not block deployment. Until the survey is completed, leave all candidates unapproved and all real campus paths excluded from public routing. Do not infer junctions from imagery or use OSM lines as trusted walking paths.
