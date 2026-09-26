import { describe, expect, it } from "vitest";
import {
  containedRoomTranslation,
  doorLocalPoint,
  nearestDoorSnap,
  pointInPolygon,
  roomContainedInBoundary,
} from "./geometry";
import type { FloorFeature, FloorLayout, RoomFeature } from "./types";

const concaveBoundary = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 10 },
  { x: 6, y: 10 },
  { x: 6, y: 4 },
  { x: 4, y: 4 },
  { x: 4, y: 10 },
  { x: 0, y: 10 },
];

function room(overrides: Partial<RoomFeature> = {}): RoomFeature {
  return {
    id: "room-a",
    kind: "room",
    name: "A",
    x: 1,
    y: 1,
    width: 2,
    height: 2,
    ...overrides,
  };
}

function layout(features: FloorFeature[] = [room()]): FloorLayout {
  return {
    buildingId: "building-a",
    floor: 0,
    version: 1,
    localWidth: 10,
    localHeight: 10,
    boundary: concaveBoundary,
    transform: { origin: [75, 22], xAxis: [0.00001, 0], yAxis: [0, -0.00001] },
    features,
    status: "draft",
  };
}

describe("concave floor containment", () => {
  it("includes boundary points and rejects points in the concave notch", () => {
    expect(pointInPolygon({ x: 4, y: 6 }, concaveBoundary)).toBe(true);
    expect(pointInPolygon({ x: 5, y: 6 }, concaveBoundary)).toBe(false);
  });

  it("rejects a rectangle whose corners are inside but whose edge spans the notch", () => {
    const spanningNotch = room({ x: 3, y: 5, width: 4, height: 2 });
    expect(
      [
        { x: 3, y: 5 },
        { x: 7, y: 5 },
        { x: 7, y: 7 },
        { x: 3, y: 7 },
      ].every((point) => pointInPolygon(point, concaveBoundary)),
    ).toBe(true);
    expect(roomContainedInBoundary(spanningNotch, concaveBoundary)).toBe(false);
  });

  it("stops a room drag at the last fully contained position", () => {
    const original = room({ x: 1, y: 5, width: 2, height: 2 });
    const resolved = containedRoomTranslation(original, { x: 4.5, y: 5 }, concaveBoundary);
    expect(resolved.x).toBeCloseTo(2, 5);
    expect(roomContainedInBoundary({ ...original, ...resolved }, concaveBoundary)).toBe(true);
  });
});

describe("door attachment", () => {
  it("stores normalized room-edge attachment and follows a resized room", () => {
    const base = layout();
    const snap = nearestDoorSnap({ x: 2, y: 1.1 }, base, 1);
    expect(snap?.parent).toEqual({ kind: "room", roomId: "room-a", edgeIndex: 0 });
    expect(snap?.position).toBeCloseTo(0.5);

    const door = {
      id: "door-a",
      kind: "door" as const,
      name: "Door",
      parent: snap!.parent,
      position: snap!.position,
      isExit: false,
    };
    expect(doorLocalPoint(door, base)).toEqual({ x: 2, y: 1 });
    const resized = layout([room({ width: 4 }), door]);
    expect(doorLocalPoint(door, resized)).toEqual({ x: 3, y: 1 });
  });
});
