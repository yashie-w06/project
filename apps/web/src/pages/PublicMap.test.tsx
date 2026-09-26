// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CampusMapData } from "../types";

const { mapData, search, route } = vi.hoisted(() => ({
  mapData: {
    buildings: { type: "FeatureCollection", features: [] },
    referencePaths: { type: "FeatureCollection", features: [] },
    verifiedPaths: { type: "FeatureCollection", features: [] },
    points: { type: "FeatureCollection", features: [] },
    alerts: [],
  } as CampusMapData,
  search: vi.fn(),
  route: vi.fn(),
}));
vi.mock("../api", () => ({
  api: { map: () => Promise.resolve(mapData), search, route, message: vi.fn() },
}));
vi.mock("../map/CampusMap", () => ({
  CampusMap: () => <div data-testid="campus-map" />,
}));

import { PublicMap, visitorReason } from "./PublicMap";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("public route wizard", () => {
  it("requires selecting and confirming a stable search result and keeps GPS on Start", async () => {
    search.mockResolvedValue({
      results: [{ kind: "building", id: "pharmacy", name: "PHARMACY DEPT" }],
    });
    render(<PublicMap />);
    expect(screen.getByRole("button", { name: "Use phone GPS" })).toBeTruthy();
    fireEvent.change(
      screen.getByPlaceholderText("Building, gate, room or point"),
      { target: { value: "PHARMACY DEPT" } },
    );
    const result = await screen.findByRole("button", {
      name: /PHARMACY DEPT/i,
    });
    fireEvent.click(result);
    expect(screen.getByText("Selected — not yet confirmed")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm start" }));
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Choose your destination" }),
      ).toBeTruthy(),
    );
    expect(screen.queryByRole("button", { name: "Use phone GPS" })).toBeNull();
    expect(screen.getByText("PHARMACY DEPT")).toBeTruthy();
  });

  it("turns typed no-route outcomes into visitor-ready text", () => {
    expect(visitorReason("NO_VERIFIED_PATHS")).toBe(
      "No verified route available. Walking routes have not been verified yet.",
    );
    expect(visitorReason("DIFFERENT_COMPONENTS")).toContain(
      "No verified walking connection",
    );
  });
});
