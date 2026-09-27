import { expect, test, type Page } from "@playwright/test";

const building = {
  type: "Feature",
  properties: { id: "test-building", name: "Test Building" },
  geometry: {
    type: "Polygon",
    coordinates: [
      [
        [75.871, 22.726],
        [75.872, 22.726],
        [75.872, 22.727],
        [75.871, 22.727],
        [75.871, 22.726],
      ],
    ],
  },
};
const map = {
  buildings: { type: "FeatureCollection", features: [building] },
  paths: {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        id: "path-1",
        properties: {
          id: "path-1",
          name: "Library Walk",
          kind: "main",
          blocked: false,
          note: "Shaded path",
          source: "osm",
          version: 1,
        },
        geometry: {
          type: "LineString",
          coordinates: [
            [75.871, 22.726],
            [75.872, 22.726],
          ],
        },
      },
    ],
  },
  points: { type: "FeatureCollection", features: [] },
  alerts: [],
};

async function mockApi(page: Page) {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    let status = 200;
    let body: unknown = {};
    if (url.pathname === "/api/map") body = map;
    else if (url.pathname === "/api/buildings")
      body = {
        buildings: [
          {
            id: "test-building",
            name: "Test Building",
            footprint: building.geometry,
          },
        ],
      };
    else if (url.pathname === "/api/editor/login")
      body = { token: "test-token", expiresInSeconds: 7200 };
    else if (url.pathname === "/api/editor/graph")
      body = { paths: [], points: [], alerts: [] };
    else if (url.pathname === "/api/editor/messages") body = { messages: [] };
    else if (url.pathname === "/api/editor/floors") body = { floors: [] };
    else if (url.pathname.startsWith("/api/editor/floors/"))
      body = { version: 2 };
    else if (url.pathname.startsWith("/api/editor/paths"))
      body = { id: "fixture-shortcut", version: 1 };
    else if (url.pathname.startsWith("/api/editor/points"))
      body = { id: "fixture-point", version: 1 };
    else if (url.pathname === "/api/editor/alerts")
      body = { id: "fixture-alert" };
    else if (url.pathname === "/api/buildings/test-building")
      body = {
        floors: [{ id: "test-building:0", floor_number: 0, version: 1 }],
      };
    else if (url.pathname === "/api/buildings/test-building/floors/0")
      body = {
        id: "test-building:0",
        buildingId: "test-building",
        floorNumber: 0,
        version: 1,
        boundary: {
          coordinates: [
            [
              [0, 0],
              [1000, 0],
              [1000, 700],
              [0, 700],
              [0, 0],
            ],
          ],
        },
        localWidth: 1000,
        localHeight: 700,
        mapTransform: {
          origin: [75.871, 22.726],
          xAxis: [0.000001, 0],
          yAxis: [0, -0.000001],
        },
        features: [],
      };
    else if (url.pathname === "/api/route")
      body = {
        status: "ok",
        geometry: {
          type: "LineString",
          coordinates: [
            [75.8712, 22.7262],
            [75.8718, 22.7268],
          ],
        },
        segments: [
          {
            geometry: {
              type: "LineString",
              coordinates: [
                [75.8712, 22.7262],
                [75.8718, 22.7268],
              ],
            },
            pathId: "path-1",
            kind: "main",
            note: "Shaded path",
          },
        ],
        approaches: [],
        notices: ["Building approach."],
      };
    else if (url.pathname === "/api/search")
      body = {
        results: [
          {
            kind: "building",
            id: "test-building",
            name: "Test Building",
            context: "Mapped building",
          },
        ],
      };
    else {
      status = 404;
      body = { error: `Unhandled test route: ${url.pathname}` };
    }
    await route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
}

test("public routing draws a mapped route and shows its path note", async ({
  page,
}, testInfo) => {
  await mockApi(page);
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Campus Access" }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Routing" }).click();
  const start = page.getByLabel("Start");
  await start.fill("Test");
  await page.getByRole("button", { name: "Test Building" }).click();
  await page.getByRole("button", { name: "Use as start" }).click();
  await page.getByLabel("Destination").fill("Test");
  await page.getByRole("button", { name: "Test Building" }).click();
  await page.getByRole("button", { name: "Use as destination" }).click();
  await page.getByRole("button", { name: /^Find route$/i }).click();
  await expect(page.getByText("Shaded path")).toBeVisible();
  await expect(page.getByText("Building approach.")).toBeVisible();
  await page.screenshot({
    path: `test-results/${testInfo.project.name}-public-route.png`,
    fullPage: true,
  });
});

test("editor deep link supports map-first building and floor selection", async ({
  page,
}, testInfo) => {
  await mockApi(page);
  await page.goto("/edit/login");
  await page.getByLabel("Email").fill("editor@example.com");
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/edit$/);
  await page.getByRole("button", { name: "Floor canvas" }).click();
  await expect(
    page.getByRole("heading", { name: "Choose building and floor" }),
  ).toBeVisible();
  await page.getByRole("button", { name: /Test Building/ }).click();
  await expect(page.getByText(/Editing Test Building/)).toBeVisible();
  await expect(page.locator("canvas").first()).toBeVisible();
  await page.screenshot({
    path: `test-results/${testInfo.project.name}-floor-editor.png`,
    fullPage: true,
  });
});
