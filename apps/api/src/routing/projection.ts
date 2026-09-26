import type { LonLat } from "../osm/types.js";

export interface MetricPoint {
  readonly x: number;
  readonly y: number;
}

export interface LocalProjection {
  readonly origin: LonLat;
  project(coordinates: LonLat): MetricPoint;
  unproject(point: MetricPoint): LonLat;
}

const EARTH_RADIUS_METRES = 6_371_008.8;
const radians = (degrees: number): number => (degrees * Math.PI) / 180;
const degrees = (radiansValue: number): number => (radiansValue * 180) / Math.PI;

export function createLocalProjection(origin: LonLat): LocalProjection {
  const [originLongitude, originLatitude] = origin;
  const latitudeScale = EARTH_RADIUS_METRES;
  const longitudeScale = EARTH_RADIUS_METRES * Math.cos(radians(originLatitude));
  return Object.freeze({
    origin,
    project([longitude, latitude]: LonLat): MetricPoint {
      return Object.freeze({
        x: radians(longitude - originLongitude) * longitudeScale,
        y: radians(latitude - originLatitude) * latitudeScale,
      });
    },
    unproject({ x, y }: MetricPoint): LonLat {
      return Object.freeze([
        originLongitude + degrees(x / longitudeScale),
        originLatitude + degrees(y / latitudeScale),
      ]) as LonLat;
    },
  });
}

export function distanceMetres(a: LonLat, b: LonLat, projection: LocalProjection): number {
  const ap = projection.project(a);
  const bp = projection.project(b);
  return Math.hypot(bp.x - ap.x, bp.y - ap.y);
}

export function polylineLengthMetres(
  coordinates: readonly LonLat[],
  projection: LocalProjection,
): number {
  let length = 0;
  for (let index = 1; index < coordinates.length; index += 1) {
    length += distanceMetres(coordinates[index - 1]!, coordinates[index]!, projection);
  }
  return length;
}
