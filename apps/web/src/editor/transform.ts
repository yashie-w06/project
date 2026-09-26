import type { FloorToMapTransform, LocalPoint, MapPosition } from "./types";

export function floorToMap(point: LocalPoint, transform: FloorToMapTransform): MapPosition {
  return [
    transform.origin[0] + point.x * transform.xAxis[0] + point.y * transform.yAxis[0],
    transform.origin[1] + point.x * transform.xAxis[1] + point.y * transform.yAxis[1],
  ];
}

export function mapToFloor(
  position: MapPosition,
  transform: FloorToMapTransform,
): LocalPoint | undefined {
  const determinant =
    transform.xAxis[0] * transform.yAxis[1] - transform.xAxis[1] * transform.yAxis[0];
  if (Math.abs(determinant) < 1e-15) return undefined;
  const dx = position[0] - transform.origin[0];
  const dy = position[1] - transform.origin[1];
  return {
    x: (dx * transform.yAxis[1] - dy * transform.yAxis[0]) / determinant,
    y: (dy * transform.xAxis[0] - dx * transform.xAxis[1]) / determinant,
  };
}

