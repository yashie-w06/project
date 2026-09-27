export type LocalPoint = { x: number; y: number };
export type MapPosition = [longitude: number, latitude: number];

export type FloorToMapTransform = {
  origin: MapPosition;
  /** WGS84 delta produced by moving one local unit along the floor x axis. */
  xAxis: MapPosition;
  /** WGS84 delta produced by moving one local unit along the floor y axis. */
  yAxis: MapPosition;
};

type FeatureBase = {
  id: string;
  name: string;
};

export type RoomFeature = FeatureBase & {
  kind: "room";
  x: number;
  y: number;
  width: number;
  height: number;
};

export type DoorParent =
  | { kind: "exterior"; edgeIndex: number }
  | { kind: "room"; roomId: string; edgeIndex: number };

export type DoorFeature = FeatureBase & {
  kind: "door";
  parent: DoorParent;
  /** Position from the start to the end of the parent edge, clamped to [0, 1]. */
  position: number;
  isExit: boolean;
  outdoorPosition?: MapPosition;
  linkedGraphNodeId?: string;
  /** Set only after the API confirms that the linked node belongs to a verified main path. */
  mainPathVerified?: boolean;
};

export type SpecialPointFeature = FeatureBase & {
  kind: "point";
  x: number;
  y: number;
};

export type ConnectorFeature = FeatureBase & {
  kind: "stairs" | "lift";
  x: number;
  y: number;
  size: number;
  connectorId: string;
  servedFloors: number[];
};

export type FloorFeature =
  RoomFeature | DoorFeature | SpecialPointFeature | ConnectorFeature;

export type FloorLayout = {
  buildingId: string;
  floor: number;
  version: number;
  localWidth: number;
  localHeight: number;
  boundary: LocalPoint[];
  transform: FloorToMapTransform;
  features: FloorFeature[];
  status: "draft" | "published";
};

export type ConnectorPlacement = {
  connectorId: string;
  kind: "stairs" | "lift";
  floor: number;
};

export type FloorIssue = {
  severity: "error" | "warning";
  code: "invalid-boundary" | "feature-outside-boundary" | "door-parent-missing";
  message: string;
  featureId?: string;
};
