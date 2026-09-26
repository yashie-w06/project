import {
  doorLocalPoint,
  pointInPolygon,
  polygonIsValid,
  roomContainedInBoundary,
  squareContainedInBoundary,
} from "./geometry";
import { floorToMap } from "./transform";
import type { FloorLayout, LocalPoint } from "./types";

export type BoundaryCorrection = {
  layout: FloorLayout;
  /** Exterior exits whose reproducible WGS84 position moved with the boundary edge. */
  affectedExitIds: string[];
};

/**
 * Moves one boundary vertex without changing the stable local frame or its map
 * transform. The correction is rejected when it would invalidate the polygon or
 * place any complete feature outside it.
 */
export function correctBoundaryVertex(
  layout: FloorLayout,
  vertexIndex: number,
  nextPoint: LocalPoint,
): BoundaryCorrection | undefined {
  if (!layout.boundary[vertexIndex]) return undefined;
  const boundary = layout.boundary.map((point, index) =>
    index === vertexIndex ? nextPoint : point,
  );
  if (!polygonIsValid(boundary)) return undefined;

  const invalid = layout.features.some((feature) => {
    if (feature.kind === "room")
      return !roomContainedInBoundary(feature, boundary);
    if (feature.kind === "point") return !pointInPolygon(feature, boundary);
    if (feature.kind === "stairs" || feature.kind === "lift") {
      return !squareContainedInBoundary(feature, feature.size, boundary);
    }
    return false;
  });
  if (invalid) return undefined;

  const withBoundary: FloorLayout = { ...layout, boundary };
  const affectedExitIds: string[] = [];
  const features = layout.features.map((feature) => {
    if (
      feature.kind !== "door" ||
      !feature.isExit ||
      feature.parent.kind !== "exterior"
    ) {
      return feature;
    }
    const oldPoint = doorLocalPoint(feature, layout);
    const point = doorLocalPoint(feature, withBoundary);
    if (!point) return feature;
    if (
      !oldPoint ||
      Math.hypot(point.x - oldPoint.x, point.y - oldPoint.y) > 1e-7
    ) {
      affectedExitIds.push(feature.id);
    }
    return { ...feature, outdoorPosition: floorToMap(point, layout.transform) };
  });
  return { layout: { ...withBoundary, features }, affectedExitIds };
}
