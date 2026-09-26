import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chromium } from "@playwright/test";

for (const line of readFileSync("apps/api/.env", "utf8").split(/\r?\n/)) {
  const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
  if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
}
const baseUrl = "http://localhost:5173";
const apiUrl = "http://127.0.0.1:3001";
const buildingsResponse = await fetch(`${apiUrl}/api/buildings`);
assert.equal(buildingsResponse.ok, true);
const { buildings } = await buildingsResponse.json();
assert.ok(buildings.some(({ name }) => name === "Central Library"));
assert.ok(buildings.some(({ name }) => name === "LT"));

const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
  });
  const browserErrors = [];
  const transparentPng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+XwZ6WQAAAABJRU5ErkJggg==",
    "base64",
  );
  await page.route("https://tile.openstreetmap.org/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "image/png",
      body: transparentPng,
    }),
  );
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  await page.goto(baseUrl);
  const search = page.getByLabel("Search mapped places");
  await search.fill("Central Library");
  await page.getByRole("button", { name: /Central Library/ }).click();
  await page.getByRole("button", { name: /Confirm start/i }).click();
  await search.fill("LT");
  await page.getByRole("button", { name: /^LT/ }).click();
  await page.getByRole("button", { name: /Confirm destination/i }).click();
  const routeResponsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/route") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: /^Find route$/i }).click();
  const routeResponse = await routeResponsePromise;
  assert.equal(routeResponse.ok(), true);
  const route = await routeResponse.json();
  assert.equal(route.status, "ok");
  assert.equal(route.containsProvisional, true);
  assert.equal(route.approaches.length, 2);
  assert.deepEqual(
    route.segments
      .filter(({ source }) => source === "osm")
      .map(({ sourceId }) => sourceId),
    ["202920189", "202920186"],
  );
  await page
    .getByText(/not been field-verified/i)
    .first()
    .waitFor();
  await page
    .getByText(/Approximate approach/i)
    .first()
    .waitFor();
  await page.waitForTimeout(500);
  await page.screenshot({
    path: "test-results/live-central-library-lt.png",
    fullPage: true,
  });

  assert.ok(process.env.EDITOR_EMAIL && process.env.EDITOR_PASSWORD);
  await page.goto(`${baseUrl}/edit/login`);
  await page.getByLabel("Email").fill(process.env.EDITOR_EMAIL);
  await page.getByLabel("Password").fill(process.env.EDITOR_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.locator(".maplibregl-canvas").first().waitFor();
  await page
    .locator("dt", { hasText: "Provisional OSM" })
    .locator("+ dd")
    .getByText("12", { exact: true })
    .waitFor();
  await page.screenshot({
    path: "test-results/live-outdoor-editor.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Floor canvas" }).click();
  await page.locator(".building-results button").first().click();
  await page.locator("canvas").first().waitFor();
  await page.screenshot({
    path: "test-results/live-floor-editor.png",
    fullPage: true,
  });
  assert.deepEqual(browserErrors, []);
  console.log(
    JSON.stringify({
      result: "Live browser smoke passed",
      publicRoute: "Central Library to LT",
      osmSegments: route.segments
        .filter(({ source }) => source === "osm")
        .map(({ sourceId }) => sourceId),
      approximateApproaches: route.approaches.length,
      editors: ["outdoor", "floor"],
      browserErrors: browserErrors.length,
    }),
  );
} finally {
  await browser.close();
}
