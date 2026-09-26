import { expect, test, type Page } from "@playwright/test";

const emptyCollection = { type: "FeatureCollection", features: [] };
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
  referencePaths: emptyCollection,
  verifiedPaths: emptyCollection,
  points: emptyCollection,
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
      body = { nodes: [], edges: [], candidates: [], points: [], alerts: [] };
    else if (url.pathname === "/api/editor/messages") body = { messages: [] };
    else if (url.pathname === "/api/editor/floors") body = { floors: [] };
    else if (url.pathname === "/api/route")
      body = {
        status: "no_route",
        code: "NO_VERIFIED_PATHS",
        message:
          "No verified route available. Walking routes have not been verified yet.",
        notices: [],
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

test("public wizard confirms stable results and reports honest no-route", async ({
  page,
}, testInfo) => {
  await mockApi(page);
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Campus Access" }),
  ).toBeVisible();
  const search = page.getByLabel("Search mapped places");
  await search.fill("Test");
  await page.getByRole("button", { name: /Test Building/ }).click();
  await page.getByRole("button", { name: /Confirm start/i }).click();
  await search.fill("Test");
  await page.getByRole("button", { name: /Test Building/ }).click();
  await page.getByRole("button", { name: /Confirm destination/i }).click();
  await page.getByRole("button", { name: /Find verified route/i }).click();
  await expect(page.getByText(/No verified route available/i)).toBeVisible();
  await page.screenshot({
    path: `test-results/${testInfo.project.name}-public-no-route.png`,
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
