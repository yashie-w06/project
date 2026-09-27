import {
  doorLocalPoint,
  pointInPolygon,
  polygonIsValid,
  roomContainedInBoundary,
  squareContainedInBoundary,
} from "./geometry";
import type { DoorFeature, FloorIssue, FloorLayout } from "./types";

/** Exit labels are optional and never participate in floor save readiness. */
export function isExitEligible(door: DoorFeature, floor: number): boolean {
  return floor === 0 && door.parent.kind === "exterior";
}

/** Only structural geometry is checked; legacy access metadata never gates Save. */
export function validateFloorLayout(layout: FloorLayout): FloorIssue[] {
  const issues: FloorIssue[] = [];
  if (!polygonIsValid(layout.boundary)) {
    return [
      {
        severity: "error",
        code: "invalid-boundary",
        message: "Floor boundary is invalid.",
      },
    ];
  }

  for (const feature of layout.features) {
    if (
      feature.kind === "room" &&
      !roomContainedInBoundary(feature, layout.boundary)
    ) {
      issues.push(outside(feature.id, feature.name));
    } else if (
      feature.kind === "point" &&
      !pointInPolygon(feature, layout.boundary)
    ) {
      issues.push(outside(feature.id, feature.name));
    } else if (
      (feature.kind === "stairs" || feature.kind === "lift") &&
      !squareContainedInBoundary(feature, feature.size, layout.boundary)
    ) {
      issues.push(outside(feature.id, feature.name));
    } else if (feature.kind === "door" && !doorLocalPoint(feature, layout)) {
      issues.push({
        severity: "error",
        code: "door-parent-missing",
        featureId: feature.id,
        message: `${feature.name || "Door"} has an invalid edge attachment; place it again on a room side or exterior boundary.`,
      });
    }
  }
  return issues;
}

function outside(featureId: string, name: string): FloorIssue {
  return {
    severity: "error",
    code: "feature-outside-boundary",
    featureId,
    message: `${name || "Feature"} is not fully inside the floor boundary.`,
  };
}
