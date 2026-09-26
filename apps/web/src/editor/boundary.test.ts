import { describe, expect, it } from "vitest";
import { correctBoundaryVertex } from "./boundary";
import type { FloorLayout } from "./types";

function layout(): FloorLayout {
  return {
    buildingId: "b",
    floor: 0,
    version: 1,
    localWidth: 100,
    localHeight: 100,
    boundary: [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ],
    transform: { origin: [75, 22], xAxis: [0.00001, 0], yAxis: [0, -0.00001] },
    features: [
      {
        id: "r",
        kind: "room",
        name: "Room",
        x: 10,
        y: 10,
        width: 20,
        height: 20,
      },
      {
        id: "exit",
        kind: "door",
        name: "Exit",
        parent: { kind: "exterior", edgeIndex: 0 },
        position: 0.5,
        isExit: true,
        outdoorPosition: [75.0005, 22],
        linkedGraphNodeId: "node-1",
        mainPathVerified: true,
      },
    ],
    status: "draft",
  };
}

describe("floor boundary correction", () => {
  it("preserves the local transform and recomputes affected exit map positions", () => {
    const original = layout();
    const correction = correctBoundaryVertex(original, 0, { x: 0, y: 10 });
    expect(correction?.layout.transform).toBe(original.transform);
    expect(correction?.affectedExitIds).toEqual(["exit"]);
    const exit = correction?.layout.features.find(
      (feature) => feature.id === "exit",
    );
    expect(exit?.kind === "door" && exit.outdoorPosition).toEqual([
      75.0005, 21.99995,
    ]);
  });

  it("rejects a correction that would leave a complete room outside", () => {
    expect(
      correctBoundaryVertex(layout(), 0, { x: 40, y: 40 }),
    ).toBeUndefined();
  });
});
