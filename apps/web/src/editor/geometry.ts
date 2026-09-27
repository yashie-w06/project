import type {
  DoorFeature,
  DoorParent,
  FloorLayout,
  LocalPoint,
  RoomFeature,
} from "./types";

const EPSILON = 1e-7;

export type Segment = { start: LocalPoint; end: LocalPoint };
export type DoorSnap = {
  parent: DoorParent;
  position: number;
  point: LocalPoint;
  distance: number;
};

export type DoorDisplayGeometry = {
  point: LocalPoint;
  rotation: number;
  leafLength: number;
};

export type CentredLabel = {
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
};

export type PolygonLabelPlacement = CentredLabel & { x: number; y: number };

/** Geometry-derived text box; labels never acquire independently persisted coordinates. */
export function centredRoomLabel(
  room: RoomFeature,
  viewScale = 1,
): CentredLabel {
  const inset = Math.min(3, room.width * 0.08, room.height * 0.08);
  return {
    x: room.x + inset,
    y: room.y + inset,
    width: Math.max(0, room.width - inset * 2),
    height: Math.max(0, room.height - inset * 2),
    fontSize: Math.min(
      Math.max(3, room.height * 0.72),
      Math.max(
        11 / viewScale,
        Math.min(8, room.height * 0.24, room.width * 0.16),
      ),
    ),
  };
}

export function centredConnectorLabel(
  centre: LocalPoint,
  size: number,
  viewScale = 1,
): CentredLabel {
  const inset = Math.min(1.5, size * 0.1);
  return {
    x: centre.x - size / 2 + inset,
    y: centre.y - size / 2 + inset,
    width: Math.max(0, size - inset * 2),
    height: Math.max(0, size - inset * 2),
    fontSize: Math.min(
      Math.max(2.5, size * 0.72),
      Math.max(10 / viewScale, Math.min(5.5, size * 0.22)),
    ),
  };
}

/** Finds a broad interior text box, including for concave building outlines. */
export function polygonLabelPlacement(
  polygon: LocalPoint[],
  viewScale = 1,
): PolygonLabelPlacement | undefined {
  if (polygon.length < 3) return undefined;
  const minX = Math.min(...polygon.map((point) => point.x));
  const maxX = Math.max(...polygon.map((point) => point.x));
  const minY = Math.min(...polygon.map((point) => point.y));
  const maxY = Math.max(...polygon.map((point) => point.y));
  const step = Math.max(1, Math.min(maxX - minX, maxY - minY) / 30);
  let anchor: LocalPoint | undefined;
  let bestClearance = -1;
  const edges = boundaryEdges(polygon);
  for (let y = minY; y <= maxY; y += step) {
    for (let x = minX; x <= maxX; x += step) {
      const point = { x, y };
      if (!pointInPolygon(point, polygon)) continue;
      const clearance = Math.min(
        ...edges.map((edge) => projectPointToSegment(point, edge).distance),
      );
      if (clearance > bestClearance) {
        anchor = point;
        bestClearance = clearance;
      }
    }
  }
  if (!anchor) return undefined;
  const sampleStep = Math.max(step / 3, 0.25);
  let left = anchor.x;
  let right = anchor.x;
  for (let x = anchor.x; x >= minX; x -= sampleStep) {
    if (!pointInPolygon({ x, y: anchor.y }, polygon)) break;
    left = x;
  }
  for (let x = anchor.x; x <= maxX; x += sampleStep) {
    if (!pointInPolygon({ x, y: anchor.y }, polygon)) break;
    right = x;
  }
  const width = Math.max(sampleStep, (right - left) * 0.92);
  const height = Math.max(
    sampleStep,
    Math.min(bestClearance * 1.5, width * 0.2),
  );
  return {
    x: anchor.x - width / 2,
    y: anchor.y - height / 2,
    width,
    height,
    fontSize: Math.min(
      Math.max(3, height * 0.72),
      14 / viewScale,
      width * 0.08,
    ),
  };
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function boundaryEdges(boundary: LocalPoint[]): Segment[] {
  return boundary.map((start, index) => ({
    start,
    end: boundary[(index + 1) % boundary.length]!,
  }));
}

export function roomCorners(room: RoomFeature): LocalPoint[] {
  return [
    { x: room.x, y: room.y },
    { x: room.x + room.width, y: room.y },
    { x: room.x + room.width, y: room.y + room.height },
    { x: room.x, y: room.y + room.height },
  ];
}

export function roomEdges(room: RoomFeature): Segment[] {
  return boundaryEdges(roomCorners(room));
}

function cross(a: LocalPoint, b: LocalPoint, c: LocalPoint): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function pointOnSegment(point: LocalPoint, segment: Segment): boolean {
  return (
    Math.abs(cross(segment.start, segment.end, point)) <= EPSILON &&
    point.x >= Math.min(segment.start.x, segment.end.x) - EPSILON &&
    point.x <= Math.max(segment.start.x, segment.end.x) + EPSILON &&
    point.y >= Math.min(segment.start.y, segment.end.y) - EPSILON &&
    point.y <= Math.max(segment.start.y, segment.end.y) + EPSILON
  );
}

/** Boundary-inclusive point-in-polygon for a simple, possibly concave polygon. */
export function pointInPolygon(
  point: LocalPoint,
  polygon: LocalPoint[],
): boolean {
  if (polygon.length < 3) return false;
  if (boundaryEdges(polygon).some((edge) => pointOnSegment(point, edge)))
    return true;

  let inside = false;
  for (
    let index = 0, previous = polygon.length - 1;
    index < polygon.length;
    previous = index++
  ) {
    const a = polygon[index]!;
    const b = polygon[previous]!;
    if (
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

function properIntersection(a: Segment, b: Segment): boolean {
  const a1 = cross(a.start, a.end, b.start);
  const a2 = cross(a.start, a.end, b.end);
  const b1 = cross(b.start, b.end, a.start);
  const b2 = cross(b.start, b.end, a.end);
  return (
    ((a1 > EPSILON && a2 < -EPSILON) || (a1 < -EPSILON && a2 > EPSILON)) &&
    ((b1 > EPSILON && b2 < -EPSILON) || (b1 < -EPSILON && b2 > EPSILON))
  );
}

/**
 * Verifies the whole rectangle, rather than its centre or just a clipped picture.
 * Corner containment plus absence of a proper edge crossing is sufficient for a
 * simple polygon and catches rectangles spanning a concave notch.
 */
export function roomContainedInBoundary(
  room: RoomFeature,
  boundary: LocalPoint[],
): boolean {
  if (room.width <= 0 || room.height <= 0 || boundary.length < 3) return false;
  const corners = roomCorners(room);
  if (!corners.every((corner) => pointInPolygon(corner, boundary)))
    return false;
  return !roomEdges(room).some((roomEdge) =>
    boundaryEdges(boundary).some((boundaryEdge) =>
      properIntersection(roomEdge, boundaryEdge),
    ),
  );
}

export function squareContainedInBoundary(
  centre: LocalPoint,
  size: number,
  boundary: LocalPoint[],
): boolean {
  return roomContainedInBoundary(
    {
      id: "containment-probe",
      name: "",
      kind: "room",
      x: centre.x - size / 2,
      y: centre.y - size / 2,
      width: size,
      height: size,
    },
    boundary,
  );
}

export function projectPointToSegment(point: LocalPoint, segment: Segment) {
  const dx = segment.end.x - segment.start.x;
  const dy = segment.end.y - segment.start.y;
  const lengthSquared = dx * dx + dy * dy;
  const position =
    lengthSquared <= EPSILON
      ? 0
      : clamp(
          ((point.x - segment.start.x) * dx +
            (point.y - segment.start.y) * dy) /
            lengthSquared,
          0,
          1,
        );
  const projected = {
    x: segment.start.x + dx * position,
    y: segment.start.y + dy * position,
  };
  return {
    point: projected,
    position,
    distance: Math.hypot(point.x - projected.x, point.y - projected.y),
  };
}

export function doorParentSegment(
  parent: DoorParent,
  layout: Pick<FloorLayout, "boundary" | "features">,
): Segment | undefined {
  if (parent.kind === "exterior")
    return boundaryEdges(layout.boundary)[parent.edgeIndex];
  const room = layout.features.find(
    (feature): feature is RoomFeature =>
      feature.kind === "room" && feature.id === parent.roomId,
  );
  return room ? roomEdges(room)[parent.edgeIndex] : undefined;
}

export function doorLocalPoint(
  door: DoorFeature,
  layout: Pick<FloorLayout, "boundary" | "features">,
): LocalPoint | undefined {
  const segment = doorParentSegment(door.parent, layout);
  if (
    !segment ||
    !Number.isFinite(door.position) ||
    door.position < 0 ||
    door.position > 1
  )
    return undefined;
  const position = door.position;
  return {
    x: segment.start.x + (segment.end.x - segment.start.x) * position,
    y: segment.start.y + (segment.end.y - segment.start.y) * position,
  };
}

export function doorDisplayGeometry(
  door: DoorFeature,
  layout: Pick<
    FloorLayout,
    "boundary" | "features" | "localWidth" | "localHeight"
  >,
): DoorDisplayGeometry | undefined {
  const point = doorLocalPoint(door, layout);
  const segment = doorParentSegment(door.parent, layout);
  if (!point || !segment) return undefined;
  return {
    point,
    rotation:
      (Math.atan2(
        segment.end.y - segment.start.y,
        segment.end.x - segment.start.x,
      ) *
        180) /
      Math.PI,
    leafLength: Math.max(
      3,
      Math.min(8, Math.min(layout.localWidth, layout.localHeight) * 0.08),
    ),
  };
}

export function nearestDoorSnap(
  point: LocalPoint,
  layout: Pick<FloorLayout, "boundary" | "features">,
  maximumDistance = Number.POSITIVE_INFINITY,
): DoorSnap | undefined {
  const candidates: DoorSnap[] = [];
  boundaryEdges(layout.boundary).forEach((segment, edgeIndex) => {
    candidates.push({
      parent: { kind: "exterior", edgeIndex },
      ...projectPointToSegment(point, segment),
    });
  });
  layout.features.forEach((feature) => {
    if (feature.kind !== "room") return;
    roomEdges(feature).forEach((segment, edgeIndex) => {
      candidates.push({
        parent: { kind: "room", roomId: feature.id, edgeIndex },
        ...projectPointToSegment(point, segment),
      });
    });
  });
  const nearest = candidates.sort((a, b) => a.distance - b.distance)[0];
  return nearest && nearest.distance <= maximumDistance ? nearest : undefined;
}

/** Keeps a drag inside a concave polygon, stopping at the last valid position. */
export function containedRoomTranslation(
  room: RoomFeature,
  desired: LocalPoint,
  boundary: LocalPoint[],
): LocalPoint {
  const target = { ...room, x: desired.x, y: desired.y };
  if (roomContainedInBoundary(target, boundary)) return desired;
  let low = 0;
  let high = 1;
  for (let index = 0; index < 24; index += 1) {
    const amount = (low + high) / 2;
    const probe = {
      ...room,
      x: room.x + (desired.x - room.x) * amount,
      y: room.y + (desired.y - room.y) * amount,
    };
    if (roomContainedInBoundary(probe, boundary)) low = amount;
    else high = amount;
  }
  return {
    x: room.x + (desired.x - room.x) * low,
    y: room.y + (desired.y - room.y) * low,
  };
}

export function polygonIsValid(boundary: LocalPoint[]): boolean {
  if (boundary.length < 3) return false;
  const area = boundary.reduce((sum, point, index) => {
    const next = boundary[(index + 1) % boundary.length]!;
    return sum + point.x * next.y - next.x * point.y;
  }, 0);
  if (Math.abs(area) <= EPSILON) return false;
  const edges = boundaryEdges(boundary);
  return !edges.some((edge, index) =>
    edges.some((other, otherIndex) => {
      const adjacent =
        index === otherIndex ||
        (index + 1) % edges.length === otherIndex ||
        (otherIndex + 1) % edges.length === index;
      return !adjacent && properIntersection(edge, other);
    }),
  );
}
