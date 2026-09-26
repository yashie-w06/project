import Konva from "konva";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { Circle, Group, Layer, Line, Rect, Stage, Text, Transformer } from "react-konva";
import { correctBoundaryVertex } from "./boundary";
import {
  containedRoomTranslation,
  doorLocalPoint,
  nearestDoorSnap,
  pointInPolygon,
  roomContainedInBoundary,
  squareContainedInBoundary,
} from "./geometry";
import { floorToMap } from "./transform";
import type {
  ConnectorFeature,
  ConnectorPlacement,
  DoorFeature,
  FloorFeature,
  FloorIssue,
  FloorLayout,
  LocalPoint,
  RoomFeature,
} from "./types";
import { isExitEligible, validateFloorLayout } from "./validation";
import "./floor-canvas.css";

type Tool = "select" | "boundary" | "room" | "door" | "point" | "stairs" | "lift";

export type VerifiedMainNodeOption = {
  nodeId: string;
  label: string;
};

export type FloorCanvasProps = {
  value: FloorLayout;
  onChange: (next: FloorLayout) => void;
  onSaveDraft: (draft: FloorLayout) => void | Promise<void>;
  onPublish: (published: FloorLayout) => void | Promise<void>;
  onReloadDraft?: () => FloorLayout | undefined | Promise<FloorLayout | undefined>;
  connectorPlacements?: ConnectorPlacement[];
  verifiedMainNodes?: VerifiedMainNodeOption[];
  width?: number;
  height?: number;
  disabled?: boolean;
};

type View = { x: number; y: number; scale: number };

const MIN_SCALE = 0.15;
const MAX_SCALE = 8;

function uid(prefix: string): string {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
}

function replaceFeature(layout: FloorLayout, replacement: FloorFeature): FloorLayout {
  return {
    ...layout,
    features: layout.features.map((feature) =>
      feature.id === replacement.id ? replacement : feature,
    ),
  };
}

function fitView(layout: FloorLayout, width: number, height: number): View {
  const scale = Math.min(width / layout.localWidth, height / layout.localHeight) * 0.86;
  return {
    x: (width - layout.localWidth * scale) / 2,
    y: (height - layout.localHeight * scale) / 2,
    scale: Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale)),
  };
}

function stagePoint(stage: Konva.Stage): LocalPoint | undefined {
  const pointer = stage.getPointerPosition();
  if (!pointer) return undefined;
  return {
    x: (pointer.x - stage.x()) / stage.scaleX(),
    y: (pointer.y - stage.y()) / stage.scaleY(),
  };
}

function firstRoomAt(
  point: LocalPoint,
  width: number,
  height: number,
  layout: FloorLayout,
): RoomFeature | undefined {
  const candidates: LocalPoint[] = [point];
  const step = Math.max(2, Math.min(width, height) / 3);
  for (let y = height / 2; y <= layout.localHeight - height / 2; y += step) {
    for (let x = width / 2; x <= layout.localWidth - width / 2; x += step) {
      candidates.push({ x, y });
    }
  }
  for (const centre of candidates) {
    const room: RoomFeature = {
      id: uid("room"),
      kind: "room",
      name: "New room",
      x: centre.x - width / 2,
      y: centre.y - height / 2,
      width,
      height,
    };
    if (roomContainedInBoundary(room, layout.boundary)) return room;
  }
  return undefined;
}

export function FloorCanvas({
  value,
  onChange,
  onSaveDraft,
  onPublish,
  onReloadDraft,
  connectorPlacements = [],
  verifiedMainNodes = [],
  width = 920,
  height = 620,
  disabled = false,
}: FloorCanvasProps) {
  const stageRef = useRef<Konva.Stage>(null);
  const transformerRef = useRef<Konva.Transformer>(null);
  const historyRef = useRef<FloorLayout[]>([]);
  const panStartRef = useRef<View | null>(null);
  const [tool, setTool] = useState<Tool>("select");
  const [selectedId, setSelectedId] = useState<string>();
  const [preview, setPreview] = useState(false);
  const [view, setView] = useState<View>(() => fitView(value, width, height));
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();

  const issues = useMemo(
    () => validateFloorLayout(value, connectorPlacements, false),
    [connectorPlacements, value],
  );
  const selected = value.features.find((feature) => feature.id === selectedId);

  useEffect(() => {
    setView(fitView(value, width, height));
    historyRef.current = [];
    setSelectedId(undefined);
  }, [value.buildingId, value.floor, width, height]);

  useEffect(() => {
    const transformer = transformerRef.current;
    const stage = stageRef.current;
    if (!transformer || !stage || !selectedId || preview) {
      transformer?.nodes([]);
      return;
    }
    const node = stage.findOne(`#feature-${selectedId}`);
    const feature = value.features.find((item) => item.id === selectedId);
    transformer.nodes(node && feature?.kind === "room" ? [node] : []);
    transformer.getLayer()?.batchDraw();
  }, [preview, selectedId, value.features]);

  const commit = useCallback(
    (next: FloorLayout, record = true) => {
      if (record) historyRef.current.push(value);
      onChange({ ...next, status: "draft" });
      setNotice(undefined);
    },
    [onChange, value],
  );

  const updateFeature = useCallback(
    (feature: FloorFeature) => commit(replaceFeature(value, feature)),
    [commit, value],
  );

  const undo = () => {
    const previous = historyRef.current.pop();
    if (previous) onChange(previous);
  };

  const addAt = (point: LocalPoint) => {
    if (disabled || preview || tool === "select" || tool === "boundary") return;
    let feature: FloorFeature | undefined;
    if (tool === "room") {
      feature = firstRoomAt(
        point,
        Math.max(8, value.localWidth * 0.16),
        Math.max(7, value.localHeight * 0.12),
        value,
      );
    } else if (tool === "door") {
      const snap = nearestDoorSnap(
        point,
        value,
        Math.max(value.localWidth, value.localHeight) * 0.07,
      );
      if (snap) {
        feature = {
          id: uid("door"),
          kind: "door",
          name: "Door",
          parent: snap.parent,
          position: snap.position,
          isExit: false,
        };
      }
    } else if (tool === "point" && pointInPolygon(point, value.boundary)) {
      feature = { id: uid("point"), kind: "point", name: "Point", ...point };
    } else if (tool === "stairs" || tool === "lift") {
      const size = Math.max(5, Math.min(value.localWidth, value.localHeight) * 0.065);
      if (squareContainedInBoundary(point, size, value.boundary)) {
        feature = {
          id: uid(tool),
          kind: tool,
          name: tool === "lift" ? "Lift" : "Stairs",
          ...point,
          size,
          connectorId: "",
          servedFloors: [value.floor],
        };
      }
    }
    if (!feature) {
      setNotice(
        tool === "door"
          ? "Drop the door close to a room side or exterior edge."
          : "That complete feature would leave the floor boundary.",
      );
      return;
    }
    commit({ ...value, features: [...value.features, feature] });
    setSelectedId(feature.id);
    setTool("select");
  };

  const handleWheel = (event: Konva.KonvaEventObject<WheelEvent>) => {
    event.evt.preventDefault();
    const stage = stageRef.current;
    const pointer = stage?.getPointerPosition();
    if (!stage || !pointer) return;
    const oldScale = view.scale;
    const local = { x: (pointer.x - view.x) / oldScale, y: (pointer.y - view.y) / oldScale };
    const direction = event.evt.deltaY > 0 ? -1 : 1;
    const scale = Math.max(
      MIN_SCALE,
      Math.min(MAX_SCALE, oldScale * (direction > 0 ? 1.08 : 1 / 1.08)),
    );
    setView({
      scale,
      x: pointer.x - local.x * scale,
      y: pointer.y - local.y * scale,
    });
  };

  const saveDraft = async () => {
    setBusy(true);
    try {
      await onSaveDraft({ ...value, status: "draft" });
      setNotice("Draft saved.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Draft could not be saved.");
    } finally {
      setBusy(false);
    }
  };

  const publish = async () => {
    const publishIssues = validateFloorLayout(value, connectorPlacements, true);
    const errors = publishIssues.filter((issue) => issue.severity === "error");
    if (errors.length) {
      setNotice(errors.map((issue) => issue.message).join(" "));
      return;
    }
    setBusy(true);
    try {
      await onPublish({ ...value, status: "published" });
      setNotice("Floor published.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Floor could not be published.");
    } finally {
      setBusy(false);
    }
  };

  const reloadDraft = async () => {
    if (!onReloadDraft) return;
    setBusy(true);
    try {
      const draft = await onReloadDraft();
      if (draft) {
        historyRef.current.push(value);
        onChange(draft);
        setNotice("Saved draft reloaded.");
      } else setNotice("No saved draft is available.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Draft could not be reloaded.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="floor-editor" aria-label={`Floor ${value.floor} editor`}>
      {!preview && (
        <div className="floor-editor__toolbar" aria-label="Floor drawing tools">
          {(["select", "boundary", "room", "door", "point", "stairs", "lift"] as const).map((item) => (
            <button
              type="button"
              key={item}
              className={tool === item ? "is-active" : ""}
              aria-pressed={tool === item}
              disabled={disabled}
              onClick={() => setTool(item)}
            >
              {item === "point"
                ? "Special dot"
                : item === "boundary"
                  ? "Correct boundary"
                  : item[0]!.toUpperCase() + item.slice(1)}
            </button>
          ))}
          <span className="floor-editor__toolbar-spacer" />
          <button type="button" onClick={undo} disabled={!historyRef.current.length || disabled}>
            Undo
          </button>
          {onReloadDraft && (
            <button type="button" onClick={reloadDraft} disabled={busy || disabled}>
              Reload draft
            </button>
          )}
          <button type="button" onClick={saveDraft} disabled={busy || disabled}>
            Save draft
          </button>
          <button type="button" onClick={publish} disabled={busy || disabled}>
            Publish
          </button>
          <button type="button" onClick={() => setPreview(true)}>
            User preview
          </button>
        </div>
      )}
      {preview && (
        <div className="floor-editor__preview-banner">
          User-view preview: editing handles and draft-only controls are hidden.
          <button type="button" onClick={() => setPreview(false)}>
            Exit preview
          </button>
        </div>
      )}

      <div className="floor-editor__canvas" style={{ width, height }}>
        <Stage
          ref={stageRef}
          width={width}
          height={height}
          x={view.x}
          y={view.y}
          scaleX={view.scale}
          scaleY={view.scale}
          draggable={!disabled && tool === "select"}
          onWheel={handleWheel}
          onDragStart={(event) => {
            if (event.target === event.target.getStage()) panStartRef.current = view;
          }}
          onDragEnd={(event) => {
            if (event.target === event.target.getStage()) {
              setView((current) => ({ ...current, x: event.target.x(), y: event.target.y() }));
              panStartRef.current = null;
            }
          }}
          onMouseDown={(event) => {
            const stage = event.target.getStage();
            if (stage && event.target === stage && tool === "select") setSelectedId(undefined);
          }}
          onClick={(event) => {
            const stage = event.target.getStage();
            if (!stage || event.target !== stage) return;
            const point = stagePoint(stage);
            if (point) addAt(point);
          }}
        >
          <Layer>
            <Line
              points={value.boundary.flatMap((point) => [point.x, point.y])}
              closed
              fill="#f8fafc"
              stroke="#334155"
              strokeWidth={2 / view.scale}
              listening={false}
            />
            {tool === "boundary" &&
              !preview &&
              value.boundary.map((point, index) => (
                <Circle
                  key={`boundary-${index}`}
                  x={point.x}
                  y={point.y}
                  radius={3.5}
                  fill="#ffffff"
                  stroke="#dc2626"
                  strokeWidth={1.2 / view.scale}
                  draggable
                  onDragEnd={(event) => {
                    const correction = correctBoundaryVertex(value, index, {
                      x: event.target.x(),
                      y: event.target.y(),
                    });
                    if (!correction) {
                      event.target.position(point);
                      setNotice(
                        "Boundary correction rejected: it would invalidate the polygon or leave a complete feature outside.",
                      );
                      return;
                    }
                    commit(correction.layout);
                    if (correction.affectedExitIds.length) {
                      setNotice(
                        `Review changed outdoor positions for exits: ${correction.affectedExitIds.join(", ")}.`,
                      );
                    }
                  }}
                />
              ))}
            {value.features.map((feature) => (
              <FloorFeatureShape
                key={feature.id}
                feature={feature}
                layout={value}
                selected={feature.id === selectedId}
                preview={preview}
                viewScale={view.scale}
                onSelect={() => setSelectedId(feature.id)}
                onChange={updateFeature}
                onInvalid={setNotice}
              />
            ))}
            {!preview && (
              <Transformer
                ref={transformerRef}
                rotateEnabled={false}
                flipEnabled={false}
                enabledAnchors={[
                  "top-left",
                  "top-right",
                  "bottom-left",
                  "bottom-right",
                  "middle-left",
                  "middle-right",
                  "top-center",
                  "bottom-center",
                ]}
                boundBoxFunc={(oldBox, newBox) => {
                  if (!selected || selected.kind !== "room") return oldBox;
                  const stage = stageRef.current;
                  if (!stage) return oldBox;
                  const candidate = {
                    ...selected,
                    x: (newBox.x - stage.x()) / stage.scaleX(),
                    y: (newBox.y - stage.y()) / stage.scaleY(),
                    width: newBox.width / stage.scaleX(),
                    height: newBox.height / stage.scaleY(),
                  };
                  return candidate.width >= 3 &&
                    candidate.height >= 3 &&
                    roomContainedInBoundary(candidate, value.boundary)
                    ? newBox
                    : oldBox;
                }}
              />
            )}
          </Layer>
        </Stage>
      </div>

      {!preview && selected && (
        <FeatureInspector
          feature={selected}
          floor={value.floor}
          verifiedMainNodes={verifiedMainNodes}
          onChange={(feature) => {
            if (feature.kind === "door" && feature.isExit) {
              const point = doorLocalPoint(feature, value);
              feature = point ? { ...feature, outdoorPosition: floorToMap(point, value.transform) } : feature;
            }
            updateFeature(feature);
          }}
          onDelete={() => {
            commit({
              ...value,
              features: value.features.filter((feature) => feature.id !== selected.id),
            });
            setSelectedId(undefined);
          }}
        />
      )}

      {!preview && <IssueList issues={issues} notice={notice} />}
    </section>
  );
}

type ShapeProps = {
  feature: FloorFeature;
  layout: FloorLayout;
  selected: boolean;
  preview: boolean;
  viewScale: number;
  onSelect: () => void;
  onChange: (feature: FloorFeature) => void;
  onInvalid: (message: string) => void;
};

function FloorFeatureShape(props: ShapeProps) {
  const { feature, layout, selected, preview, viewScale, onSelect, onChange, onInvalid } = props;
  const common = {
    id: `feature-${feature.id}`,
    onClick: (event: Konva.KonvaEventObject<MouseEvent>) => {
      event.cancelBubble = true;
      onSelect();
    },
    onTap: (event: Konva.KonvaEventObject<TouchEvent>) => {
      event.cancelBubble = true;
      onSelect();
    },
  };

  if (feature.kind === "room") {
    return (
      <Group>
        <Rect
          {...common}
          x={feature.x}
          y={feature.y}
          width={feature.width}
          height={feature.height}
          fill={selected && !preview ? "#dbeafe" : "#eef2ff"}
          stroke="#4f46e5"
          strokeWidth={1.4 / viewScale}
          draggable={!preview}
          onDragMove={(event) => {
            const resolved = containedRoomTranslation(
              feature,
              { x: event.target.x(), y: event.target.y() },
              layout.boundary,
            );
            event.target.position(resolved);
          }}
          onDragEnd={(event) => {
            onChange({ ...feature, x: event.target.x(), y: event.target.y() });
          }}
          onTransformEnd={(event) => {
            const node = event.target;
            const candidate = {
              ...feature,
              x: node.x(),
              y: node.y(),
              width: Math.max(3, node.width() * node.scaleX()),
              height: Math.max(3, node.height() * node.scaleY()),
            };
            node.scale({ x: 1, y: 1 });
            if (roomContainedInBoundary(candidate, layout.boundary)) onChange(candidate);
            else {
              node.position({ x: feature.x, y: feature.y });
              onInvalid("The complete room must remain inside the floor boundary.");
            }
          }}
        />
        <Text
          x={feature.x + 3}
          y={feature.y + 3}
          width={Math.max(0, feature.width - 6)}
          text={feature.name}
          fontSize={Math.max(3, Math.min(7, feature.height / 4))}
          fill="#312e81"
          listening={false}
        />
      </Group>
    );
  }

  if (feature.kind === "door") {
    const point = doorLocalPoint(feature, layout);
    if (!point) return null;
    return (
      <Group
        {...common}
        x={point.x}
        y={point.y}
        draggable={!preview}
        onDragEnd={(event) => {
          const snap = nearestDoorSnap(
            { x: event.target.x(), y: event.target.y() },
            layout,
            Math.max(layout.localWidth, layout.localHeight) * 0.07,
          );
          event.target.position(point);
          if (!snap) {
            onInvalid("Door must stay attached to a room side or exterior edge.");
            return;
          }
          const staysExit = feature.isExit && snap.parent.kind === "exterior" && layout.floor === 0;
          onChange({
            ...feature,
            parent: snap.parent,
            position: snap.position,
            isExit: staysExit,
            outdoorPosition: staysExit ? feature.outdoorPosition : undefined,
            linkedGraphNodeId: staysExit ? feature.linkedGraphNodeId : undefined,
            mainPathVerified: staysExit ? feature.mainPathVerified : undefined,
          });
        }}
      >
        <Circle
          radius={4}
          fill={feature.isExit ? "#16a34a" : "#f97316"}
          stroke={selected && !preview ? "#0f172a" : "white"}
          strokeWidth={1.2 / viewScale}
        />
        {feature.isExit && (
          <Text x={5} y={-4} text="EXIT" fontSize={4} fill="#166534" listening={false} />
        )}
      </Group>
    );
  }

  const size = feature.kind === "point" ? 0 : feature.size;
  return (
    <Group
      {...common}
      x={feature.x}
      y={feature.y}
      draggable={!preview}
      onDragEnd={(event) => {
        const point = { x: event.target.x(), y: event.target.y() };
        const valid =
          feature.kind === "point"
            ? pointInPolygon(point, layout.boundary)
            : squareContainedInBoundary(point, size, layout.boundary);
        if (valid) onChange({ ...feature, ...point });
        else {
          event.target.position({ x: feature.x, y: feature.y });
          onInvalid("The complete feature must remain inside the floor boundary.");
        }
      }}
    >
      {feature.kind === "point" ? (
        <Circle
          radius={3.2}
          fill="#e11d48"
          stroke={selected && !preview ? "#0f172a" : "white"}
          strokeWidth={1 / viewScale}
        />
      ) : (
        <Rect
          x={-size / 2}
          y={-size / 2}
          width={size}
          height={size}
          cornerRadius={1.5}
          fill={feature.kind === "lift" ? "#0891b2" : "#7c3aed"}
          stroke={selected && !preview ? "#0f172a" : "white"}
          strokeWidth={1 / viewScale}
        />
      )}
      <Text
        x={feature.kind === "point" ? 5 : size / 2 + 2}
        y={-3}
        text={feature.name}
        fontSize={4}
        fill="#0f172a"
        listening={false}
      />
    </Group>
  );
}

function FeatureInspector({
  feature,
  floor,
  verifiedMainNodes,
  onChange,
  onDelete,
}: {
  feature: FloorFeature;
  floor: number;
  verifiedMainNodes: VerifiedMainNodeOption[];
  onChange: (feature: FloorFeature) => void;
  onDelete: () => void;
}) {
  const eligibleExit = feature.kind === "door" && isExitEligible(feature, floor);
  return (
    <div className="floor-editor__inspector">
      <strong>{feature.kind === "point" ? "Special point" : feature.kind}</strong>
      <label>
        Name
        <input
          value={feature.name}
          onChange={(event) => onChange({ ...feature, name: event.target.value })}
        />
      </label>
      {(feature.kind === "stairs" || feature.kind === "lift") && (
        <>
          <label>
            Connector ID
            <input
              value={feature.connectorId}
              onChange={(event) => onChange({ ...feature, connectorId: event.target.value })}
              placeholder="e.g. north-core"
            />
          </label>
          <label>
            Served floors (comma separated)
            <input
              value={feature.servedFloors.join(", ")}
              onChange={(event) => {
                const floors = [...new Set(event.target.value.split(",").map(Number).filter(Number.isInteger))];
                onChange({ ...feature, servedFloors: floors });
              }}
            />
          </label>
        </>
      )}
      {feature.kind === "door" && eligibleExit && (
        <>
          <label className="floor-editor__check">
            <input
              type="checkbox"
              checked={feature.isExit}
              onChange={(event) =>
                onChange({
                  ...feature,
                  isExit: event.target.checked,
                  outdoorPosition: event.target.checked ? feature.outdoorPosition : undefined,
                  linkedGraphNodeId: event.target.checked ? feature.linkedGraphNodeId : undefined,
                  mainPathVerified: event.target.checked ? feature.mainPathVerified : undefined,
                })
              }
            />
            Mark as exit
          </label>
          {feature.isExit && (
            <label>
              Verified main-path connection
              <select
                value={feature.linkedGraphNodeId ?? ""}
                onChange={(event) =>
                  onChange({
                    ...feature,
                    linkedGraphNodeId: event.target.value || undefined,
                    mainPathVerified: Boolean(event.target.value),
                  })
                }
              >
                <option value="">Select a verified node</option>
                {verifiedMainNodes.map((node) => (
                  <option key={node.nodeId} value={node.nodeId}>
                    {node.label}
                  </option>
                ))}
              </select>
            </label>
          )}
        </>
      )}
      {feature.kind === "door" && !eligibleExit && (
        <span className="floor-editor__hint">
          Only a ground-floor door attached to the exterior boundary can be an exit.
        </span>
      )}
      <button type="button" className="floor-editor__delete" onClick={onDelete}>
        Delete
      </button>
    </div>
  );
}

function IssueList({ issues, notice }: { issues: FloorIssue[]; notice?: string }) {
  if (!notice && !issues.length) return null;
  return (
    <div className="floor-editor__issues" aria-live="polite">
      {notice && <p>{notice}</p>}
      {issues.map((issue, index) => (
        <p key={`${issue.featureId ?? "floor"}-${issue.code}-${index}`} data-severity={issue.severity}>
          {issue.severity === "error" ? "Error" : "Warning"}: {issue.message}
        </p>
      ))}
    </div>
  );
}

export const floorCanvasHostStyle: CSSProperties = { minWidth: 0, overflow: "auto" };
