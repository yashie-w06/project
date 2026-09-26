import {
  doorLocalPoint,
  pointInPolygon,
  polygonIsValid,
  roomContainedInBoundary,
  squareContainedInBoundary,
} from "./geometry";
import type {
  ConnectorPlacement,
  DoorFeature,
  FloorIssue,
  FloorLayout,
} from "./types";

export function isExitEligible(door: DoorFeature, floor: number): boolean {
  return floor === 0 && door.parent.kind === "exterior";
}

export function validateFloorLayout(
  layout: FloorLayout,
  connectorPlacements: ConnectorPlacement[] = [],
  forPublish = false,
): FloorIssue[] {
  const issues: FloorIssue[] = [];
  if (!polygonIsValid(layout.boundary)) {
    issues.push({
      severity: "error",
      code: "invalid-boundary",
      message: "Floor boundary is invalid.",
    });
    return issues;
  }

  layout.features.forEach((feature) => {
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
    } else if (feature.kind === "door") {
      if (!doorLocalPoint(feature, layout)) {
        issues.push({
          severity: "error",
          code: "door-parent-missing",
          featureId: feature.id,
          message: `${feature.name || "Door"} has an invalid edge attachment; place it again on a room side or exterior boundary.`,
        });
      }
      if (feature.isExit && layout.floor !== 0) {
        issues.push({
          severity: "error",
          code: "invalid-exit-floor",
          featureId: feature.id,
          message: "Only a ground-floor door can be an exit.",
        });
      }
      if (feature.isExit && feature.parent.kind !== "exterior") {
        issues.push({
          severity: "error",
          code: "invalid-exit-parent",
          featureId: feature.id,
          message: "A room door cannot be an exit.",
        });
      }
      if (feature.isExit && !feature.outdoorPosition) {
        issues.push({
          severity: forPublish ? "error" : "warning",
          code: "exit-outdoor-position-missing",
          featureId: feature.id,
          message:
            "Exit needs reproducible outdoor coordinates before publishing.",
        });
      }
      if (
        feature.isExit &&
        (!feature.linkedGraphNodeId || !feature.mainPathVerified)
      ) {
        issues.push({
          severity: forPublish ? "error" : "warning",
          code: "exit-main-path-missing",
          featureId: feature.id,
          message:
            "Exit must link to a verified main-path node before publishing.",
        });
      }
    }

    if (feature.kind === "stairs" || feature.kind === "lift") {
      if (!feature.connectorId.trim()) {
        issues.push({
          severity: forPublish ? "error" : "warning",
          code: "connector-id-missing",
          featureId: feature.id,
          message: `${feature.name || feature.kind} needs a shared connector ID.`,
        });
      } else {
        feature.servedFloors.forEach((floor) => {
          const presentHere = floor === layout.floor;
          const matchingSavedMarker = connectorPlacements.some(
            (placement) =>
              placement.connectorId === feature.connectorId &&
              placement.kind === feature.kind &&
              placement.floor === floor,
          );
          if (!presentHere && !matchingSavedMarker) {
            issues.push({
              severity: forPublish ? "error" : "warning",
              code: "connector-placement-missing",
              featureId: feature.id,
              message: `${feature.kind === "lift" ? "Lift" : "Stairs"} ${feature.connectorId} is missing its floor ${floor} marker.`,
            });
          }
        });
      }
    }
  });
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
