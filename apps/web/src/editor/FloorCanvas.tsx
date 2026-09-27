import Konva from "konva";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  Arc,
  Circle,
  Group,
  Layer,
  Line,
  Rect,
  Stage,
  Text,
  Transformer,
} from "react-konva";
import { correctBoundaryVertex } from "./boundary";
import {
  containedRoomTranslation,
  centredConnectorLabel,
  centredRoomLabel,
  doorDisplayGeometry,
  nearestDoorSnap,
  pointInPolygon,
  polygonLabelPlacement,
  roomContainedInBoundary,
  squareContainedInBoundary,
} from "./geometry";
import { screenToFloorPoint, zoomViewAtPoint } from "./transform";
import type {
  FloorFeature,
  FloorIssue,
  FloorLayout,
  LocalPoint,
  RoomFeature,
} from "./types";
import { validateFloorLayout } from "./validation";
import "./floor-canvas.css";

type Tool =
  "select" | "boundary" | "room" | "door" | "point" | "stairs" | "lift";

export type FloorCanvasProps = {
  value: FloorLayout;
  onChange: (next: FloorLayout) => void;
  onSave: (layout: FloorLayout) => void | Promise<void>;
  buildingName?: string;
  width?: number;
  height?: number;
  disabled?: boolean;
  readOnly?: boolean;
};

type View = { x: number; y: number; scale: number };

const MIN_SCALE = 0.15;
const MAX_SCALE = 8;

function uid(prefix: string): string {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
}

function replaceFeature(
  layout: FloorLayout,
  replacement: FloorFeature,
): FloorLayout {
  return {
    ...layout,
    features: layout.features.map((feature) =>
      feature.id === replacement.id ? replacement : feature,
    ),
  };
}

function fitView(layout: FloorLayout, width: number, height: number): View {
  const scale =
    Math.min(width / layout.localWidth, height / layout.localHeight) * 0.86;
  return {
    x: (width - layout.localWidth * scale) / 2,
    y: (height - layout.localHeight * scale) / 2,
    scale: Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale)),
  };
}

function stagePoint(stage: Konva.Stage): LocalPoint | undefined {
  const pointer = stage.getPointerPosition();
  if (!pointer) return undefined;
  return screenToFloorPoint(pointer, {
    x: stage.x(),
    y: stage.y(),
    scale: stage.scaleX(),
  });
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
  onSave,
  buildingName,
  width,
  height,
  disabled = false,
  readOnly = false,
}: FloorCanvasProps) {
  const initialWidth = width ?? 920;
  const initialHeight = height ?? 620;
  const canvasHostRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Konva.Stage>(null);
  const transformerRef = useRef<Konva.Transformer>(null);
  const historyRef = useRef<FloorLayout[]>([]);
  const panStartRef = useRef<View | null>(null);
  const canvasSizeRef = useRef({ width: initialWidth, height: initialHeight });
  const pinchRef = useRef<{ distance: number; centre: LocalPoint } | undefined>(
    undefined,
  );
  const [tool, setTool] = useState<Tool>("select");
  const [selectedId, setSelectedId] = useState<string>();
  const [view, setView] = useState<View>(() =>
    fitView(value, initialWidth, initialHeight),
  );
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [measuredWidth, setMeasuredWidth] = useState(initialWidth);

  useEffect(() => {
    const host = canvasHostRef.current;
    if (!host || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      setMeasuredWidth(Math.max(280, Math.floor(entry.contentRect.width)));
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  const canvasWidth = width ? Math.min(width, measuredWidth) : measuredWidth;
  const canvasHeight = Math.max(
    360,
    Math.min(height ?? 680, Math.round(canvasWidth * 0.68)),
  );

  const issues = useMemo(() => validateFloorLayout(value), [value]);
  const selected = value.features.find((feature) => feature.id === selectedId);

  useEffect(() => {
    setView(fitView(value, canvasWidth, canvasHeight));
    canvasSizeRef.current = { width: canvasWidth, height: canvasHeight };
    historyRef.current = [];
    setSelectedId(undefined);
  }, [value.buildingId, value.floor, value.localHeight, value.localWidth]);

  useEffect(() => {
    const previous = canvasSizeRef.current;
    if (previous.width === canvasWidth && previous.height === canvasHeight)
      return;
    setView((current) => {
      const centre = screenToFloorPoint(
        { x: previous.width / 2, y: previous.height / 2 },
        current,
      );
      return centre
        ? {
            ...current,
            x: canvasWidth / 2 - centre.x * current.scale,
            y: canvasHeight / 2 - centre.y * current.scale,
          }
        : fitView(value, canvasWidth, canvasHeight);
    });
    canvasSizeRef.current = { width: canvasWidth, height: canvasHeight };
  }, [canvasHeight, canvasWidth, value]);

  useEffect(() => {
    const transformer = transformerRef.current;
    const stage = stageRef.current;
    if (!transformer || !stage || !selectedId || readOnly) {
      transformer?.nodes([]);
      return;
    }
    const node = stage.findOne(`#feature-${selectedId}`);
    const feature = value.features.find((item) => item.id === selectedId);
    transformer.nodes(node && feature?.kind === "room" ? [node] : []);
    transformer.getLayer()?.batchDraw();
  }, [readOnly, selectedId, value.features]);

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
    if (disabled || readOnly || tool === "select" || tool === "boundary")
      return;
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
      if (value.floor !== 0) {
        setNotice(
          "Stairs and lift markers can only be added on the ground floor.",
        );
        return;
      }
      const size = Math.max(
        5,
        Math.min(value.localWidth, value.localHeight) * 0.065,
      );
      if (squareContainedInBoundary(point, size, value.boundary)) {
        feature = {
          id: uid(tool),
          kind: tool,
          name: tool === "lift" ? "Lift" : "Stairs",
          ...point,
          size,
          connectorId: "",
          servedFloors: [],
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
    const direction = event.evt.deltaY > 0 ? -1 : 1;
    const scale = Math.max(
      MIN_SCALE,
      Math.min(MAX_SCALE, oldScale * (direction > 0 ? 1.08 : 1 / 1.08)),
    );
    const next = zoomViewAtPoint(view, pointer, scale);
    if (next) setView(next);
  };

  const handleTouchMove = (event: Konva.KonvaEventObject<TouchEvent>) => {
    if (event.evt.touches.length !== 2) return;
    event.evt.preventDefault();
    const stage = stageRef.current;
    if (!stage) return;
    stage.stopDrag();
    const bounds = stage.container().getBoundingClientRect();
    const first = event.evt.touches[0]!;
    const second = event.evt.touches[1]!;
    const centre = {
      x: (first.clientX + second.clientX) / 2 - bounds.left,
      y: (first.clientY + second.clientY) / 2 - bounds.top,
    };
    const distance = Math.hypot(
      second.clientX - first.clientX,
      second.clientY - first.clientY,
    );
    const previous = pinchRef.current;
    pinchRef.current = { centre, distance };
    if (!previous || previous.distance <= 0) return;
    const current = {
      x: stage.x(),
      y: stage.y(),
      scale: stage.scaleX(),
    };
    const translated = {
      ...current,
      x: current.x + centre.x - previous.centre.x,
      y: current.y + centre.y - previous.centre.y,
    };
    const scale = Math.max(
      MIN_SCALE,
      Math.min(MAX_SCALE, current.scale * (distance / previous.distance)),
    );
    const next = zoomViewAtPoint(translated, centre, scale);
    if (!next) return;
    stage.position({ x: next.x, y: next.y });
    stage.scale({ x: next.scale, y: next.scale });
    stage.batchDraw();
    setView(next);
  };

  const save = async () => {
    setBusy(true);
    try {
      await onSave(value);
      setNotice("Saved.");
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : "Floor could not be saved.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className={`floor-editor${readOnly ? " floor-editor--readonly" : ""}`}
      aria-label={`${buildingName ? `${buildingName}, ` : ""}${value.floor === 0 ? "Ground floor" : `Floor ${value.floor}`} ${readOnly ? "viewer" : "editor"}`}
    >
      {!readOnly && (
        <h3 className="floor-editor__heading">
          {buildingName ? `${buildingName} · ` : ""}
          {value.floor === 0 ? "Ground floor" : `Floor ${value.floor}`}
        </h3>
      )}
      {!readOnly && (
        <div className="floor-editor__toolbar" aria-label="Floor drawing tools">
          {(
            [
              "select",
              "boundary",
              "room",
              "door",
              "point",
              ...(value.floor === 0 ? (["stairs", "lift"] as const) : []),
            ] as const
          ).map((item) => (
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
          <button
            type="button"
            onClick={undo}
            disabled={!historyRef.current.length || disabled}
          >
            Undo
          </button>
          <button type="button" onClick={save} disabled={busy || disabled}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      )}

      <div className="floor-editor__workspace">
        <div ref={canvasHostRef} className="floor-editor__canvas-host">
          <div
            className="floor-editor__canvas"
            style={{ height: canvasHeight }}
          >
            <Stage
              ref={stageRef}
              width={canvasWidth}
              height={canvasHeight}
              x={view.x}
              y={view.y}
              scaleX={view.scale}
              scaleY={view.scale}
              draggable={readOnly || (!disabled && tool === "select")}
              onWheel={handleWheel}
              onTouchMove={handleTouchMove}
              onTouchEnd={() => {
                pinchRef.current = undefined;
              }}
              onDragStart={(event) => {
                if (event.target === event.target.getStage())
                  panStartRef.current = view;
              }}
              onDragEnd={(event) => {
                if (event.target === event.target.getStage()) {
                  setView((current) => ({
                    ...current,
                    x: event.target.x(),
                    y: event.target.y(),
                  }));
                  panStartRef.current = null;
                }
              }}
              onMouseDown={(event) => {
                const stage = event.target.getStage();
                if (
                  stage &&
                  event.target === stage &&
                  (readOnly || tool === "select")
                )
                  setSelectedId(undefined);
              }}
              onClick={(event) => {
                const stage = event.target.getStage();
                if (!stage || event.target !== stage) return;
                const point = stagePoint(stage);
                if (!readOnly && point) addAt(point);
              }}
              onTap={(event) => {
                const stage = event.target.getStage();
                if (!stage || event.target !== stage) return;
                if (!readOnly && tool === "select") setSelectedId(undefined);
                const point = stagePoint(stage);
                if (!readOnly && point) addAt(point);
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
                {buildingName &&
                  (() => {
                    const label = polygonLabelPlacement(
                      value.boundary,
                      view.scale,
                    );
                    return label ? (
                      <Text
                        {...label}
                        text={buildingName}
                        align="center"
                        verticalAlign="middle"
                        wrap="word"
                        ellipsis
                        fill="#64748b"
                        opacity={0.38}
                        listening={false}
                      />
                    ) : null;
                  })()}
                {tool === "boundary" &&
                  !readOnly &&
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
                    preview={readOnly}
                    viewScale={view.scale}
                    onSelect={() => setSelectedId(feature.id)}
                    onChange={updateFeature}
                    onInvalid={setNotice}
                  />
                ))}
                {!readOnly && (
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
        </div>

        {!readOnly && selected && (
          <FeatureInspector
            feature={selected}
            floor={value.floor}
            issues={issues.filter((issue) => issue.featureId === selected.id)}
            onChange={(feature) => {
              updateFeature(feature);
            }}
            onDelete={() => {
              commit({
                ...value,
                features: value.features.filter(
                  (feature) => feature.id !== selected.id,
                ),
              });
              setSelectedId(undefined);
            }}
          />
        )}
        {!readOnly && !selected && (
          <aside className="floor-editor__empty-inspector">
            <strong>Component inspector</strong>
            <p>Select a room, door, special dot, stairs, or lift to edit it.</p>
            <p>Wheel or trackpad to zoom. Drag empty canvas space to pan.</p>
          </aside>
        )}
      </div>

      {readOnly && selected && (
        <aside className="floor-editor__viewer-popup" aria-live="polite">
          <strong>{selected.name}</strong>
          <span>
            {selected.kind === "point" ? "Special dot" : selected.kind}
          </span>
        </aside>
      )}

      {!readOnly && (
        <IssueList
          issues={issues}
          notice={notice}
          onFocus={(featureId) => setSelectedId(featureId)}
        />
      )}
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
  const {
    feature,
    layout,
    selected,
    preview,
    viewScale,
    onSelect,
    onChange,
    onInvalid,
  } = props;
  const [hovered, setHovered] = useState(false);
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
    onMouseEnter: () => setHovered(true),
    onMouseLeave: () => setHovered(false),
  };
  const legacyUpperConnector =
    layout.floor !== 0 &&
    (feature.kind === "stairs" || feature.kind === "lift");

  if (feature.kind === "room") {
    const label = centredRoomLabel(feature, viewScale);
    return (
      <Group
        {...common}
        x={feature.x}
        y={feature.y}
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
            width: Math.max(3, feature.width * node.scaleX()),
            height: Math.max(3, feature.height * node.scaleY()),
          };
          node.scale({ x: 1, y: 1 });
          if (roomContainedInBoundary(candidate, layout.boundary))
            onChange(candidate);
          else {
            node.position({ x: feature.x, y: feature.y });
            onInvalid(
              "The complete room must remain inside the floor boundary.",
            );
          }
        }}
      >
        <Rect
          x={0}
          y={0}
          width={feature.width}
          height={feature.height}
          fill={selected && !preview ? "#dbeafe" : "#eef2ff"}
          stroke="#4f46e5"
          strokeWidth={1.4 / viewScale}
        />
        <Text
          {...label}
          x={label.x - feature.x}
          y={label.y - feature.y}
          text={feature.name}
          align="center"
          verticalAlign="middle"
          wrap="word"
          ellipsis
          lineHeight={1.05}
          fill="#312e81"
          listening={false}
        />
      </Group>
    );
  }

  if (feature.kind === "door") {
    const display = doorDisplayGeometry(feature, layout);
    if (!display) return null;
    const { point, rotation, leafLength: doorLength } = display;
    return (
      <Group
        {...common}
        x={point.x}
        y={point.y}
        rotation={rotation}
        draggable={!preview}
        onDragEnd={(event) => {
          const snap = nearestDoorSnap(
            { x: event.target.x(), y: event.target.y() },
            layout,
            Math.max(layout.localWidth, layout.localHeight) * 0.07,
          );
          event.target.position(point);
          if (!snap) {
            onInvalid(
              "Door must stay attached to a room side or exterior edge.",
            );
            return;
          }
          const staysExit =
            feature.isExit &&
            snap.parent.kind === "exterior" &&
            layout.floor === 0;
          onChange({
            ...feature,
            parent: snap.parent,
            position: snap.position,
            isExit: staysExit,
            outdoorPosition: staysExit ? feature.outdoorPosition : undefined,
            linkedGraphNodeId: staysExit
              ? feature.linkedGraphNodeId
              : undefined,
            mainPathVerified: staysExit ? feature.mainPathVerified : undefined,
          });
        }}
      >
        <Circle radius={10 / viewScale} fill="transparent" />
        <Line
          points={[-doorLength / 2, 0, doorLength / 2, 0]}
          stroke="#334155"
          strokeWidth={2 / viewScale}
          listening={false}
        />
        <Line
          points={[0, 0, 0, -doorLength]}
          stroke="#c2410c"
          strokeWidth={2.2 / viewScale}
          listening={false}
        />
        <Arc
          x={0}
          y={0}
          innerRadius={doorLength - 0.7 / viewScale}
          outerRadius={doorLength}
          angle={90}
          rotation={-90}
          fill="#c2410c"
          listening={false}
        />
        <CompactNameBadge
          name={feature.name}
          offsetY={-(doorLength + 24 / viewScale)}
          viewScale={viewScale}
          active={selected || hovered}
          rotation={-rotation}
        />
      </Group>
    );
  }

  const size = feature.kind === "point" ? 0 : feature.size;
  const connectorLabel =
    feature.kind === "stairs" || feature.kind === "lift"
      ? centredConnectorLabel(feature, size, viewScale)
      : undefined;
  return (
    <Group
      {...common}
      x={feature.x}
      y={feature.y}
      draggable={!preview && !legacyUpperConnector}
      onDragEnd={(event) => {
        const point = { x: event.target.x(), y: event.target.y() };
        const valid =
          feature.kind === "point"
            ? pointInPolygon(point, layout.boundary)
            : squareContainedInBoundary(point, size, layout.boundary);
        if (valid) onChange({ ...feature, ...point });
        else {
          event.target.position({ x: feature.x, y: feature.y });
          onInvalid(
            "The complete feature must remain inside the floor boundary.",
          );
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
      {connectorLabel && (
        <Text
          x={connectorLabel.x - feature.x}
          y={connectorLabel.y - feature.y}
          width={connectorLabel.width}
          height={connectorLabel.height}
          text={feature.name}
          fontSize={connectorLabel.fontSize}
          align="center"
          verticalAlign="middle"
          wrap="word"
          ellipsis
          lineHeight={1.02}
          fill="#ffffff"
          listening={false}
        />
      )}
      {feature.kind === "point" && (
        <CompactNameBadge
          name={feature.name}
          offsetY={-24 / viewScale}
          viewScale={viewScale}
          active={selected || hovered}
        />
      )}
    </Group>
  );
}

function CompactNameBadge({
  name,
  offsetY = 0,
  viewScale = 1,
  active = false,
  rotation = 0,
}: {
  name: string;
  offsetY?: number;
  viewScale?: number;
  active?: boolean;
  rotation?: number;
}) {
  const width = Math.min(180, Math.max(48, name.length * 7.2)) / viewScale;
  const height = 22 / viewScale;
  return (
    <Group x={-width / 2} y={offsetY} rotation={rotation} listening={false}>
      <Rect
        width={width}
        height={height}
        cornerRadius={4 / viewScale}
        fill={active ? "#fffbeb" : "rgba(255,255,255,0.96)"}
        stroke={active ? "#d97706" : "#94a3b8"}
        strokeWidth={1 / viewScale}
      />
      <Text
        x={4 / viewScale}
        width={width - 8 / viewScale}
        height={height}
        text={name}
        fontSize={12 / viewScale}
        align="center"
        verticalAlign="middle"
        wrap="none"
        ellipsis
        fill="#0f172a"
      />
    </Group>
  );
}

function FeatureInspector({
  feature,
  floor,
  issues,
  onChange,
  onDelete,
}: {
  feature: FloorFeature;
  floor: number;
  issues: FloorIssue[];
  onChange: (feature: FloorFeature) => void;
  onDelete: () => void;
}) {
  const eligibleExit =
    feature.kind === "door" &&
    floor === 0 &&
    feature.parent.kind === "exterior";
  return (
    <div className="floor-editor__inspector">
      <strong>
        {feature.kind === "point" ? "Special point" : feature.kind}
      </strong>
      {floor !== 0 &&
        (feature.kind === "stairs" || feature.kind === "lift") && (
          <span className="floor-editor__hint">
            Legacy annotation. Access availability is based on the saved ground
            floor.
          </span>
        )}
      <label>
        Name
        <input
          value={feature.name}
          onChange={(event) =>
            onChange({ ...feature, name: event.target.value })
          }
        />
      </label>
      {feature.kind === "door" && eligibleExit && (
        <>
          <label className="floor-editor__check">
            <input
              type="checkbox"
              checked={feature.isExit}
              onChange={(event) =>
                onChange({ ...feature, isExit: event.target.checked })
              }
            />
            Label as exit (optional)
          </label>
        </>
      )}
      <button type="button" className="floor-editor__delete" onClick={onDelete}>
        Delete
      </button>
      {issues.map((issue) => (
        <button
          type="button"
          className="floor-editor__feature-warning"
          key={`${issue.code}-${issue.message}`}
          onClick={() => undefined}
        >
          {issue.severity === "error" ? "Error" : "Needs attention"}:{" "}
          {issue.message}
        </button>
      ))}
    </div>
  );
}

function IssueList({
  issues,
  notice,
  onFocus,
}: {
  issues: FloorIssue[];
  notice?: string;
  onFocus: (featureId: string) => void;
}) {
  if (!notice && !issues.length) return null;
  return (
    <div className="floor-editor__issues" aria-live="polite">
      {notice && <p>{notice}</p>}
      {issues.map((issue, index) =>
        issue.featureId ? (
          <button
            type="button"
            key={`${issue.featureId}-${issue.code}-${index}`}
            data-severity={issue.severity}
            onClick={() => onFocus(issue.featureId!)}
          >
            {issue.severity === "error" ? "Error" : "Warning"}: {issue.message}{" "}
            Focus feature
          </button>
        ) : (
          <p
            key={`floor-${issue.code}-${index}`}
            data-severity={issue.severity}
          >
            {issue.severity === "error" ? "Error" : "Warning"}: {issue.message}
          </p>
        ),
      )}
    </div>
  );
}

export const floorCanvasHostStyle: CSSProperties = {
  minWidth: 0,
  overflow: "auto",
};
