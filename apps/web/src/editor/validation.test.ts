import { describe, expect, it } from "vitest";
import type { DoorFeature, FloorLayout } from "./types";
import {
  floorToMap,
  mapToFloor,
  screenToFloorPoint,
  zoomViewAtPoint,
} from "./transform";
import { isExitEligible, validateFloorLayout } from "./validation";

function baseLayout(features: FloorLayout["features"] = []): FloorLayout {
  return {
    buildingId: "b1",
    floor: 0,
    version: 2,
    localWidth: 100,
    localHeight: 80,
    boundary: [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 80 },
      { x: 0, y: 80 },
    ],
    transform: {
      origin: [75.867, 22.725],
      xAxis: [0.000001, 0.0000002],
      yAxis: [-0.0000001, -0.000001],
    },
    features,
    status: "draft",
  };
}

function exteriorDoor(overrides: Partial<DoorFeature> = {}): DoorFeature {
  return {
    id: "d1",
    kind: "door",
    name: "North exit",
    parent: { kind: "exterior", edgeIndex: 0 },
    position: 0.4,
    isExit: false,
    ...overrides,
  };
}

describe("floor-to-map transform", () => {
  it("round-trips stable local coordinates independent of view zoom", () => {
    const layout = baseLayout();
    const local = { x: 42.25, y: 17.5 };
    const map = floorToMap(local, layout.transform);
    // WGS84 double precision is comfortably sub-millimetre at this local scale.
    expect(mapToFloor(map, layout.transform)?.x).toBeCloseTo(local.x, 7);
    expect(mapToFloor(map, layout.transform)?.y).toBeCloseTo(local.y, 7);
  });

  it("inverse-transforms pointer positions after simultaneous pan and zoom", () => {
    const local = screenToFloorPoint(
      { x: 330, y: 245 },
      { x: 30, y: -5, scale: 2.5 },
    );
    expect(local).toEqual({ x: 120, y: 100 });
    expect(
      screenToFloorPoint({ x: 1, y: 1 }, { x: 0, y: 0, scale: 0 }),
    ).toBeUndefined();
  });

  it("keeps the floor coordinate beneath a wheel or pinch zoom stationary", () => {
    const pointer = { x: 175, y: 90 };
    const before = { x: 25, y: -30, scale: 1.5 };
    const after = zoomViewAtPoint(before, pointer, 3)!;
    expect(screenToFloorPoint(pointer, after)).toEqual(
      screenToFloorPoint(pointer, before),
    );
  });
});

describe("optional exit labels", () => {
  it("allows optional exit labels only for ground-floor exterior doors", () => {
    expect(isExitEligible(exteriorDoor(), 0)).toBe(true);
    expect(isExitEligible(exteriorDoor(), 1)).toBe(false);
    expect(
      isExitEligible(
        {
          ...exteriorDoor(),
          parent: { kind: "room", roomId: "r1", edgeIndex: 0 },
        },
        0,
      ),
    ).toBe(false);
  });

  it("does not gate saving on exit coordinates or routing links", () => {
    expect(
      validateFloorLayout(baseLayout([exteriorDoor({ isExit: true })])),
    ).toEqual([]);
  });

  it("reports a saved door whose normalized edge position is invalid", () => {
    const issues = validateFloorLayout(
      baseLayout([exteriorDoor({ position: -0.1 })]),
    );
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "door-parent-missing",
          featureId: "d1",
        }),
      ]),
    );
  });
});

describe("saved access metadata", () => {
  it("retains legacy upper floor markers without counterpart validation", () => {
    const lift = {
      id: "lift-1",
      kind: "lift" as const,
      name: "Main lift",
      x: 50,
      y: 40,
      size: 8,
      connectorId: "main-core",
      servedFloors: [0, 1, 2],
    };
    const upperFloor = { ...baseLayout([lift]), floor: 2 };
    expect(validateFloorLayout(upperFloor)).toEqual([]);
  });
});
