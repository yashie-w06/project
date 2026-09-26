import { describe, expect, it } from "vitest";
import {
  centredConnectorLabel,
  centredRoomLabel,
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
    const resolved = containedRoomTranslation(
      original,
      { x: 4.5, y: 5 },
      concaveBoundary,
    );
    expect(resolved.x).toBeCloseTo(2, 5);
    expect(
      roomContainedInBoundary({ ...original, ...resolved }, concaveBoundary),
    ).toBe(true);
  });
});

describe("geometry-derived labels", () => {
  it("centres a room label box inside the room after move and resize", () => {
    const moved = room({
      x: 17,
      y: 23,
      width: 40,
      height: 18,
      name: "A long room name",
    });
    const label = centredRoomLabel(moved);
    expect(label.x + label.width / 2).toBeCloseTo(moved.x + moved.width / 2);
    expect(label.y + label.height / 2).toBeCloseTo(moved.y + moved.height / 2);
    expect(label.x).toBeGreaterThanOrEqual(moved.x);
    expect(label.x + label.width).toBeLessThanOrEqual(moved.x + moved.width);
  });

  it("centres stairs and lift labels within their square", () => {
    const label = centredConnectorLabel({ x: 35, y: 42 }, 12);
    expect(label.x + label.width / 2).toBeCloseTo(35);
    expect(label.y + label.height / 2).toBeCloseTo(42);
  });
});

describe("door attachment", () => {
  it("stores normalized room-edge attachment and follows a resized room", () => {
    const base = layout();
    const snap = nearestDoorSnap({ x: 2, y: 1.1 }, base, 1);
    expect(snap?.parent).toEqual({
      kind: "room",
      roomId: "room-a",
      edgeIndex: 0,
    });
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

  it("refuses a door drop outside the eligible edge distance", () => {
    expect(nearestDoorSnap({ x: 5, y: 5 }, layout(), 0.25)).toBeUndefined();
  });

  it("recognises an exterior edge as an eligible normalized attachment", () => {
    const snap = nearestDoorSnap({ x: 8, y: 0.15 }, layout(), 0.25);
    expect(snap?.parent).toEqual({ kind: "exterior", edgeIndex: 0 });
    expect(snap?.position).toBeCloseTo(0.8);
  });
});
