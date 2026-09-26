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
assert.ok(buildings.length > 0);
const buildingName = buildings[0].name;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
  });
  await page.goto(baseUrl);
  const search = page.getByLabel("Search mapped places");
  await search.fill(buildingName);
  await page.locator(".search-results button").first().click();
  await page.getByRole("button", { name: /Confirm start/i }).click();
  await search.fill(buildingName);
  await page.locator(".search-results button").first().click();
  await page.getByRole("button", { name: /Confirm destination/i }).click();
  await page.getByRole("button", { name: /Find verified route/i }).click();
  await page.getByText(/No verified route available/i).waitFor();
  await page.screenshot({
    path: "test-results/live-public-no-route.png",
    fullPage: true,
  });

  assert.ok(process.env.EDITOR_EMAIL && process.env.EDITOR_PASSWORD);
  await page.goto(`${baseUrl}/edit/login`);
  await page.getByLabel("Email").fill(process.env.EDITOR_EMAIL);
  await page.getByLabel("Password").fill(process.env.EDITOR_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("button", { name: "Floor canvas" }).click();
  await page.locator(".building-results button").first().click();
  await page.locator("canvas").first().waitFor();
  await page.screenshot({
    path: "test-results/live-floor-editor.png",
    fullPage: true,
  });
  console.log(
    "Live browser smoke passed: real search/no-route and authenticated map-first floor editor.",
  );
} finally {
  await browser.close();
}
