import { expect, test } from "@playwright/test";

const transparentPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+XwZ6WQAAAABJRU5ErkJggg==",
  "base64",
);

async function useStaticTiles(page: import("@playwright/test").Page) {
  await page.route("https://tile.openstreetmap.org/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "image/png",
      body: transparentPng,
    }),
  );
}

test("live map data loads and Central Library to LT draws a connected route", async ({
  page,
}, testInfo) => {
  page.on("request", (request) => {
    if (request.url().includes("/api/route"))
      console.log("Live route request", request.method(), request.url());
  });
  page.on("requestfailed", (request) => {
    if (request.url().includes("/api/route"))
      console.log("Live route request failed", request.failure()?.errorText);
  });
  await useStaticTiles(page);
  const mapResponsePromise = page.waitForResponse((response) =>
    response.url().endsWith("/api/map"),
  );
  await page.goto("/");
  const mapResponse = await mapResponsePromise;
  expect(mapResponse.status()).toBe(200);
  const mapData = await mapResponse.json();
  expect(mapData.buildings.features.length).toBeGreaterThan(0);
  expect(mapData.paths.features.length).toBeGreaterThan(0);
  await expect(page.locator(".maplibregl-canvas").first()).toBeVisible();
  await expect(page.getByText(/^Map data:/)).toHaveCount(0);

  await page.getByRole("tab", { name: "Routing" }).click();
  const start = page.getByLabel("Start");
  await start.fill("Central Library");
  await page.getByRole("button", { name: "Central Library" }).click();
  await page.getByRole("button", { name: "Use as start" }).click();
  await page.getByLabel("Destination").fill("LT");
  await page.getByRole("button", { name: "LT", exact: true }).click();
  await page.getByRole("button", { name: "Use as destination" }).click();

  const routeResponsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/route") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: /^Find route$/i }).click();
  const routeResponse = await routeResponsePromise;
  expect(routeResponse.status()).toBe(200);
  const route = await routeResponse.json();
  expect(route.status).toBe("ok");
  expect(route.geometry.type).toBe("LineString");
  expect(route.geometry.coordinates.length).toBeGreaterThan(2);
  expect(
    route.segments.map((segment: { pathId: string }) => segment.pathId),
  ).toEqual(["osm-202920189", "osm-202920186"]);
  expect(route.geometry.coordinates.flat().every(Number.isFinite)).toBe(true);
  await expect(page.getByText("Building approach.").first()).toBeVisible();
  await page.waitForTimeout(700);
  await page.screenshot({
    path: `test-results/${testInfo.project.name}-live-central-library-lt.png`,
    fullPage: true,
  });

  await page.getByRole("button", { name: "Wheelchair", exact: true }).click();
  const wheelchairRoutePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/route") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: /^Find route$/i }).click();
  const wheelchairResponse = await wheelchairRoutePromise;
  expect(wheelchairResponse.status()).toBe(200);
  const wheelchairRoute = await wheelchairResponse.json();
  expect(wheelchairRoute.status).toBe("ok");
  expect(wheelchairRoute.geometry.type).toBe("LineString");
  expect(wheelchairRoute.segments.length).toBeGreaterThan(0);
  expect(wheelchairRoute.notices).toContain(
    "Accessibility details are missing on some paths.",
  );
  await expect(
    page.getByText("Accessibility details are missing on some paths."),
  ).toBeVisible();
});

test("a simulated map API 500 stays distinct from no-route and Retry recovers live data", async ({
  page,
}) => {
  await useStaticTiles(page);
  let failedOnce = false;
  await page.route("**/api/map", async (route) => {
    if (!failedOnce) {
      failedOnce = true;
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "Internal server error" }),
      });
      return;
    }
    await route.continue();
  });
  await page.goto("/");
  await expect(page.getByText("Map data: Internal server error")).toBeVisible();
  await expect(
    page.getByText(
      "The mapped walking paths do not connect these locations yet.",
    ),
  ).toHaveCount(0);

  const recoveredMapPromise = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/map") && response.status() === 200,
  );
  await page.getByRole("button", { name: "Retry" }).click();
  const recoveredMap = await recoveredMapPromise;
  const data = await recoveredMap.json();
  expect(data.buildings.features.length).toBeGreaterThan(0);
  await expect(page.getByText(/^Map data:/)).toHaveCount(0);
  await expect(page.locator(".maplibregl-canvas").first()).toBeVisible();
});

test("a changed effective network invalidates the shown route and requests it again", async ({
  page,
}) => {
  await useStaticTiles(page);
  await page.goto("/");
  await page.getByRole("tab", { name: "Routing" }).click();
  await page.getByLabel("Start").fill("Central Library");
  await page.getByRole("button", { name: "Central Library" }).click();
  await page.getByRole("button", { name: "Use as start" }).click();
  await page.getByLabel("Destination").fill("LT");
  await page.getByRole("button", { name: "LT", exact: true }).click();
  await page.getByRole("button", { name: "Use as destination" }).click();
  const firstRoutePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/route") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: /^Find route$/i }).click();
  const firstRoute = await firstRoutePromise;
  const firstResult = await firstRoute.json();
  expect(firstResult.status).toBe("ok");

  let nextRouteRequest: import("@playwright/test").Request | undefined;
  await page.route("**/api/network-state", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        revision: "isolated-obstacle-revision",
        blockedPathIds: [firstResult.segments[0].pathId],
        obstacles: [],
      }),
    }),
  );
  const replanPromise = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/route") &&
      response.request().method() === "POST",
  );
  await page.route("**/api/route", async (route) => {
    nextRouteRequest = route.request();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: "no_route",
        code: "BLOCKED_OR_INELIGIBLE",
        message: "No available route for this profile right now.",
        notices: [],
        networkRevision: "isolated-obstacle-revision",
      }),
    });
  });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  const replanned = await replanPromise;
  expect(replanned.status()).toBe(200);
  expect(nextRouteRequest?.postDataJSON()).toMatchObject({
    profile: "healthy",
    start: { kind: "building" },
    destination: { kind: "building" },
  });
  await expect(
    page.getByText("Route changed; finding another way."),
  ).toBeVisible();
  await expect(
    page.getByText("No available route for this profile right now."),
  ).toBeVisible();
});
