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

describe("exit validation", () => {
  it("allows exit controls only for ground-floor exterior doors", () => {
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

  it("requires outdoor coordinates and a verified main-node link on publish", () => {
    const issues = validateFloorLayout(
      baseLayout([exteriorDoor({ isExit: true })]),
      [],
      true,
    );
    expect(issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "exit-outdoor-position-missing",
        "exit-main-path-missing",
      ]),
    );
    expect(issues.every((issue) => issue.severity === "error")).toBe(true);
  });

  it("rejects a room door marked as an exit", () => {
    const room = {
      id: "r1",
      kind: "room" as const,
      name: "R",
      x: 10,
      y: 10,
      width: 20,
      height: 20,
    };
    const door = exteriorDoor({
      isExit: true,
      parent: { kind: "room", roomId: room.id, edgeIndex: 0 },
    });
    const codes = validateFloorLayout(baseLayout([room, door]), [], true).map(
      (issue) => issue.code,
    );
    expect(codes).toContain("invalid-exit-parent");
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

describe("connector completeness", () => {
  it("keeps incomplete connectors as draft warnings but blocks publication", () => {
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
    const draft = validateFloorLayout(baseLayout([lift]), [], false);
    const publishing = validateFloorLayout(baseLayout([lift]), [], true);
    expect(
      draft.filter((issue) => issue.code === "connector-placement-missing"),
    ).toHaveLength(2);
    expect(
      draft.find((issue) => issue.code === "connector-placement-missing")
        ?.severity,
    ).toBe("warning");
    expect(
      publishing.find((issue) => issue.code === "connector-placement-missing")
        ?.severity,
    ).toBe("error");
  });
});
