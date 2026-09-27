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

const { mapData, search, route, message } = vi.hoisted(() => ({
  mapData: {
    buildings: { type: "FeatureCollection", features: [] },
    referencePaths: { type: "FeatureCollection", features: [] },
    provisionalPaths: { type: "FeatureCollection", features: [] },
    verifiedPaths: { type: "FeatureCollection", features: [] },
    paths: {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {
            id: "path-1",
            name: "Library Walk",
            kind: "main",
            blocked: false,
            note: "Quiet route",
            source: "osm",
          },
          geometry: {
            type: "LineString",
            coordinates: [
              [75.87, 22.72],
              [75.871, 22.721],
            ],
          },
        },
      ],
    },
    points: {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {
            id: "point-1",
            name: "Water point",
            note: "Near the gate",
          },
          geometry: { type: "Point", coordinates: [75.872, 22.722] },
        },
      ],
    },
    alerts: [
      {
        id: "alert-1",
        coordinates: [75.873, 22.723],
        description: "Temporary work",
      },
    ],
  } as unknown as CampusMapData,
  search: vi.fn(),
  route: vi.fn(),
  message: vi.fn(),
}));
vi.mock("../api", () => ({
  api: { map: () => Promise.resolve(mapData), search, route, message },
}));
vi.mock("../map/CampusMap", () => ({
  CampusMap: (props: any) => (
    <div data-testid="campus-map">
      <button onClick={() => props.onPick?.([75.87, 22.72])}>
        Pick map location
      </button>
      <button onClick={() => props.onPath?.("path-1")}>Select map path</button>
      <button onClick={() => props.onPoint?.("point-1")}>
        Select map point
      </button>
      <button onClick={() => props.onAlert?.("alert-1")}>
        Select map alert
      </button>
      <button onClick={() => props.onBuilding?.("building-1")}>
        Select map building
      </button>
    </div>
  ),
}));

import { PublicMap, routePresentation, visitorReason } from "./PublicMap";

afterEach(() => {
  cleanup();
  (mapData as any).paths.features[0].properties.blocked = false;
  vi.clearAllMocks();
});

describe("simplified public map", () => {
  it("starts in View and displays selected paths and map feature notes", async () => {
    render(<PublicMap />);
    expect(
      screen.getByRole("tab", { name: "View" }).getAttribute("aria-selected"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Select map path" }));
    expect(await screen.findByText("Quiet route")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Select map point" }));
    expect(screen.getByText("Near the gate")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Select map alert" }));
    expect(screen.getByText("Temporary work")).toBeTruthy();
  });

  it("sends a private note with an anonymous selected location and retains it on failure", async () => {
    message.mockRejectedValueOnce(new Error("Try again"));
    render(<PublicMap />);
    fireEvent.click(screen.getByRole("tab", { name: "Send Note" }));
    expect(document.querySelector(".location-selected")?.textContent).toBe(
      "Select a location on the map",
    );
    fireEvent.click(screen.getByRole("button", { name: "Pick map location" }));
    expect(document.querySelector(".location-selected")?.textContent).toBe(
      "Location: Selected",
    );
    expect(screen.queryByText(/75\.87/)).toBeNull();
    fireEvent.change(screen.getByLabelText(/What should the editor know/), {
      target: { value: "The west gate is closed" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Try again",
    );
    expect(screen.getByDisplayValue("The west gate is closed")).toBeTruthy();
    message.mockResolvedValueOnce({ received: true });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Message sent to editor")).toBeTruthy();
    expect(message).toHaveBeenLastCalledWith(
      [75.87, 22.72],
      "The west gate is closed",
    );
  });

  it("routes between outdoor map selections and shows a source-path note once", async () => {
    route.mockResolvedValue({
      status: "ok",
      geometry: {
        type: "LineString",
        coordinates: [
          [75.87, 22.72],
          [75.871, 22.721],
        ],
      },
      notices: [],
      segments: [
        {
          geometry: {
            type: "LineString",
            coordinates: [
              [75.87, 22.72],
              [75.871, 22.721],
            ],
          },
          source: "osm",
          sourceId: "path-1",
          note: "Quiet route",
        },
      ],
      approaches: [],
    });
    render(<PublicMap />);
    fireEvent.click(screen.getByRole("tab", { name: "Routing" }));
    fireEvent.click(screen.getByRole("button", { name: "Pick map location" }));
    fireEvent.click(screen.getByRole("button", { name: "Use as start" }));
    fireEvent.click(screen.getByRole("button", { name: "Pick map location" }));
    fireEvent.click(screen.getByRole("button", { name: "Use as destination" }));
    fireEvent.click(screen.getByRole("button", { name: "Find route" }));
    expect(await screen.findByText("Quiet route")).toBeTruthy();
    expect(route).toHaveBeenCalledOnce();
  });

  it("normalizes route source IDs and visitor-friendly no-route results", () => {
    const result = routePresentation({
      segments: [
        {
          coordinates: [
            [75.87, 22.72],
            [75.871, 22.721],
          ],
          source: "osm",
          sourceId: "path-1",
          note: "Use the shaded side",
        },
      ],
    });
    expect(result.segments.features[0]?.properties).toMatchObject({
      source: "osm",
      sourceId: "path-1",
      note: "Use the shaded side",
    });
    expect(visitorReason("DIFFERENT_COMPONENTS")).toContain("do not connect");
    expect(visitorReason("NO_VERIFIED_PATHS")).not.toContain("verified");
  });

  it("invalidates a displayed route when its path becomes blocked on refresh", async () => {
    route
      .mockResolvedValueOnce({
        status: "ok",
        geometry: {
          type: "LineString",
          coordinates: [
            [75.87, 22.72],
            [75.871, 22.721],
          ],
        },
        notices: [],
        segments: [
          {
            coordinates: [
              [75.87, 22.72],
              [75.871, 22.721],
            ],
            sourceId: "path-1",
          },
        ],
        approaches: [],
      })
      .mockResolvedValueOnce({
        status: "no_route",
        code: "DIFFERENT_COMPONENTS",
        message: "The mapped walking paths do not connect these points yet.",
        notices: [],
      });
    render(<PublicMap />);
    fireEvent.click(screen.getByRole("tab", { name: "Routing" }));
    fireEvent.click(screen.getByRole("button", { name: "Pick map location" }));
    fireEvent.click(screen.getByRole("button", { name: "Use as start" }));
    fireEvent.click(screen.getByRole("button", { name: "Pick map location" }));
    fireEvent.click(screen.getByRole("button", { name: "Use as destination" }));
    fireEvent.click(screen.getByRole("button", { name: "Find route" }));
    await screen.findByRole("button", { name: "Clear route" });
    const changed = mapData as any;
    changed.paths.features[0].properties.blocked = true;
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(route).toHaveBeenCalledTimes(2));
    expect(
      await screen.findByText(/do not connect these locations/),
    ).toBeTruthy();
  });
});
