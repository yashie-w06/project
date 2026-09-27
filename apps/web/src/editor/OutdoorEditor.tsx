import { useEffect, useMemo, useState } from "react";
import type { Feature, LineString } from "geojson";
import { api } from "../api";
import { CampusMap } from "../map/CampusMap";
import type { CampusMapData, Coordinate } from "../types";
import "./outdoor-editor.css";

type Mode = "select" | "draw" | "point" | "alert";
type PathFeature = {
  id: string;
  name: string;
  coordinates: Coordinate[];
  kind: "main" | "shortcut";
  source: "osm" | "editor";
  blocked: boolean;
  note: string | null;
  version: number;
  alertIds?: string[];
};
type PathSnap = {
  parentId: string;
  parentVersion: number;
  coordinates: Coordinate;
  distanceMetres: number;
  screenPixels: number;
};
type DrawVertex = { coordinate: Coordinate; snap?: PathSnap };
type OutdoorPoint = {
  id: string;
  name?: string;
  coordinates: Coordinate;
  note: string;
  version: number;
};
type OutdoorAlert = {
  id: string;
  coordinates: Coordinate;
  description: string;
  version: number;
  pathIds?: string[];
};
type ActiveObstacle = {
  id: string;
  reason: string;
  affected_path_ids: string[];
  created_at: string;
  expires_at: string | null;
};
type GraphData = {
  paths: PathFeature[];
  points: OutdoorPoint[];
  alerts: OutdoorAlert[];
};
type PickMetadata = { snap?: PathSnap };
type MapData = CampusMapData & {
  paths?: {
    type: "FeatureCollection";
    features: Feature<
      LineString,
      Omit<PathFeature, "coordinates" | "version">
    >[];
  };
};

const emptyGraph: GraphData = { paths: [], points: [], alerts: [] };
const maximumPointNote = 500;
const maximumPathNote = 240;
const snapPixelTolerance = 12;
const snapMetreTolerance = 5;

export function OutdoorEditor({ token }: { token: string }) {
  const [data, setData] = useState<GraphData>(emptyGraph);
  const [mapData, setMapData] = useState<MapData>();
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [mode, setMode] = useState<Mode>("select");
  const [selectedPathId, setSelectedPathId] = useState("");
  const [blockedChoice, setBlockedChoice] = useState<boolean>();
  const [pathNote, setPathNote] = useState("");
  const [vertices, setVertices] = useState<DrawVertex[]>([]);
  const [saving, setSaving] = useState(false);
  const [pointPosition, setPointPosition] = useState<Coordinate>();
  const [pointName, setPointName] = useState("");
  const [pointNote, setPointNote] = useState("");
  const [selectedPointId, setSelectedPointId] = useState("");
  const [alertPosition, setAlertPosition] = useState<Coordinate>();
  const [alertNote, setAlertNote] = useState("");
  const [selectedAlertId, setSelectedAlertId] = useState("");
  const [obstacles, setObstacles] = useState<ActiveObstacle[]>([]);
  const [obstacleReason, setObstacleReason] = useState("");
  const [obstacleExpiry, setObstacleExpiry] = useState("120");

  const reload = async () => {
    try {
      const [graph, map, activeObstacles] = await Promise.all([
        api.editor<GraphData>("/graph", token),
        api.map(),
        api.editor<{ obstacles: ActiveObstacle[] }>("/obstacles", token),
      ]);
      setData(graph);
      setMapData(map as MapData);
      setObstacles(activeObstacles.obstacles);
      setError("");
      return graph;
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Outdoor data could not be loaded",
      );
      return undefined;
    }
  };

  useEffect(() => {
    void reload();
    // Refresh after returning to the editor tab and while the editor is open.
    const refresh = () => {
      if (document.visibilityState === "visible") void reload();
    };
    window.addEventListener("focus", refresh);
    const timer = window.setInterval(refresh, 30_000);
    return () => {
      window.removeEventListener("focus", refresh);
      window.clearInterval(timer);
    };
  }, [token]);

  const selectedPath = data.paths.find((path) => path.id === selectedPathId);
  const selectedPoint = data.points.find(
    (point) => point.id === selectedPointId,
  );
  const selectedAlert = data.alerts.find(
    (alert) => alert.id === selectedAlertId,
  );
  const selectedPathFeature: Feature<LineString> | undefined = selectedPath
    ? {
        type: "Feature",
        properties: { id: selectedPath.id },
        geometry: { type: "LineString", coordinates: selectedPath.coordinates },
      }
    : undefined;
  const pathOptions = useMemo(
    () =>
      [...data.paths]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((path, index) => ({
          ...path,
          displayName:
            path.name || `Path ${String(index + 1).padStart(2, "0")}`,
        })),
    [data.paths],
  );
  const validSnaps = [vertices[0]?.snap, vertices.at(-1)?.snap].every(
    (snap) =>
      snap &&
      snap.screenPixels <= snapPixelTolerance &&
      snap.distanceMetres <= snapMetreTolerance,
  );
  const snapPoints = [
    vertices[0]?.snap?.coordinates,
    vertices.at(-1)?.snap?.coordinates,
  ].filter((coordinate): coordinate is Coordinate => Boolean(coordinate));
  const drawFeature: Feature<LineString> | undefined =
    vertices.length > 1
      ? {
          type: "Feature",
          properties: {},
          geometry: {
            type: "LineString",
            coordinates: vertices.map((vertex) => vertex.coordinate),
          },
        }
      : undefined;

  function setModeAndClear(next: Mode) {
    setMode(next);
    setStatus("");
    setError("");
    if (next !== "draw") setVertices([]);
    if (next !== "point") setPointPosition(undefined);
    if (next !== "alert") setAlertPosition(undefined);
  }

  function onMapPick(coordinate: Coordinate, metadata?: PickMetadata) {
    setError("");
    setStatus("");
    if (mode === "draw") {
      setVertices((current) => [
        ...current,
        { coordinate, snap: metadata?.snap },
      ]);
    } else if (mode === "point") {
      setPointPosition(coordinate);
      setSelectedPointId("");
    } else if (mode === "alert") {
      setAlertPosition(coordinate);
      setSelectedAlertId("");
    }
  }

  function choosePath(id: string) {
    setSelectedPathId(id);
    const path = data.paths.find((item) => item.id === id);
    setBlockedChoice(path?.blocked ?? false);
    setPathNote(path?.note ?? "");
    setSelectedPointId("");
    setSelectedAlertId("");
    setStatus("");
  }

  async function savePathStatus() {
    if (!selectedPath || blockedChoice === undefined) return;
    setSaving(true);
    setError("");
    try {
      await api.editor(`/paths/${encodeURIComponent(selectedPath.id)}`, token, {
        method: "PATCH",
        body: JSON.stringify({
          blocked: blockedChoice,
          version: selectedPath.version,
        }),
      });
      await reload();
      setStatus(blockedChoice ? "Path blocked." : "Path is good for routing.");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Path status could not be saved",
      );
    } finally {
      setSaving(false);
    }
  }

  async function publishObstacle() {
    if (!selectedPath || !obstacleReason.trim()) return;
    setSaving(true);
    setError("");
    try {
      await api.editor("/obstacles", token, {
        method: "POST",
        body: JSON.stringify({
          reason: obstacleReason.trim(),
          affectedPathIds: [selectedPath.id],
          expiresInMinutes:
            obstacleExpiry === "never" ? null : Number(obstacleExpiry),
        }),
      });
      await reload();
      setObstacleReason("");
      setStatus("Temporary obstruction published for this path.");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Obstruction could not be published",
      );
    } finally {
      setSaving(false);
    }
  }

  async function deactivateObstacle(id: string) {
    setSaving(true);
    setError("");
    try {
      await api.editor(`/obstacles/${encodeURIComponent(id)}`, token, {
        method: "DELETE",
      });
      await reload();
      setStatus("Temporary obstruction removed.");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Obstruction could not be removed",
      );
    } finally {
      setSaving(false);
    }
  }

  async function savePathNote(remove = false) {
    if (!selectedPath) return;
    const trimmed = remove ? "" : pathNote.trim();
    if (!remove && (!trimmed || trimmed.length > maximumPathNote)) return;
    setSaving(true);
    setError("");
    try {
      await api.editor(`/paths/${encodeURIComponent(selectedPath.id)}`, token, {
        method: "PATCH",
        body: JSON.stringify({ note: trimmed, version: selectedPath.version }),
      });
      const next = await reload();
      setPathNote(
        next?.paths.find((path) => path.id === selectedPath.id)?.note ?? "",
      );
      setStatus(remove ? "Path note removed." : "Path note saved.");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Path note could not be saved",
      );
    } finally {
      setSaving(false);
    }
  }

  async function saveDrawnPath() {
    if (vertices.length < 2 || !validSnaps) return;
    const first = vertices[0]!.snap!;
    const last = vertices.at(-1)!.snap!;
    setSaving(true);
    setError("");
    try {
      await api.editor("/paths", token, {
        method: "POST",
        body: JSON.stringify({
          id: crypto.randomUUID(),
          coordinates: vertices.map((vertex) => vertex.coordinate),
          endpoints: [
            {
              parentId: first.parentId,
              parentVersion: first.parentVersion,
              coordinates: first.coordinates,
            },
            {
              parentId: last.parentId,
              parentVersion: last.parentVersion,
              coordinates: last.coordinates,
            },
          ],
        }),
      });
      setVertices([]);
      await reload();
      setMode("select");
      setStatus("Shortcut path saved and connected.");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Path could not be saved",
      );
    } finally {
      setSaving(false);
    }
  }

  async function savePoint() {
    if (
      !pointPosition ||
      !pointNote.trim() ||
      pointNote.trim().length > maximumPointNote
    )
      return;
    const existing = selectedPoint;
    const id = existing?.id ?? crypto.randomUUID();
    setSaving(true);
    setError("");
    try {
      await api.editor(`/points/${encodeURIComponent(id)}`, token, {
        method: "PUT",
        body: JSON.stringify({
          name: pointName.trim() || undefined,
          coordinates: pointPosition,
          note: pointNote.trim(),
          version: existing?.version ?? 1,
        }),
      });
      await reload();
      setSelectedPointId(id);
      setPointPosition(undefined);
      setStatus("Outdoor point saved.");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Point could not be saved",
      );
    } finally {
      setSaving(false);
    }
  }

  async function removePoint() {
    if (!selectedPoint || !window.confirm("Remove this outdoor point?")) return;
    try {
      await api.editor(
        `/points/${encodeURIComponent(selectedPoint.id)}`,
        token,
        { method: "DELETE" },
      );
      setSelectedPointId("");
      setPointPosition(undefined);
      await reload();
      setStatus("Outdoor point removed.");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Point could not be removed",
      );
    }
  }

  async function saveAlert() {
    if (
      !alertPosition ||
      !alertNote.trim() ||
      alertNote.trim().length > maximumPointNote
    )
      return;
    setSaving(true);
    setError("");
    try {
      await api.editor("/alerts", token, {
        method: "POST",
        body: JSON.stringify({
          coordinates: alertPosition,
          description: alertNote.trim(),
        }),
      });
      setAlertNote("");
      setAlertPosition(undefined);
      await reload();
      setStatus("Alert added.");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Alert could not be added",
      );
    } finally {
      setSaving(false);
    }
  }

  async function removeAlert(alert: OutdoorAlert) {
    if (!window.confirm("Remove this alert?")) return;
    try {
      await api.editor(`/alerts/${encodeURIComponent(alert.id)}`, token, {
        method: "DELETE",
      });
      setSelectedAlertId("");
      await reload();
      setStatus("Alert removed.");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Alert could not be removed",
      );
    }
  }

  return (
    <section className="outdoor-workspace" aria-label="Outdoor map editor">
      <div
        className="outdoor-toolbar"
        role="toolbar"
        aria-label="Outdoor tools"
      >
        {(
          [
            ["select", "Select"],
            ["draw", "Draw path"],
            ["point", "Add point"],
            ["alert", "Add alert"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            className={mode === value ? "active" : ""}
            aria-pressed={mode === value}
            onClick={() => setModeAndClear(value)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="outdoor-layout">
        <div className="outdoor-map">
          <CampusMap
            data={mapData}
            interactionMode={mode}
            pending={
              mode === "point"
                ? pointPosition
                : mode === "alert"
                  ? alertPosition
                  : undefined
            }
            snapPoints={mode === "draw" ? snapPoints : []}
            route={drawFeature}
            focus={selectedPathFeature}
            highlight={selectedPathFeature}
            onPick={onMapPick}
            onPath={(id) => choosePath(id)}
            onPoint={(id) => {
              setSelectedPointId(id);
              setSelectedAlertId("");
              const point = data.points.find((item) => item.id === id);
              setPointPosition(point?.coordinates);
              setPointName(point?.name ?? "");
              setPointNote(point?.note ?? "");
            }}
            onAlert={(id) => {
              setSelectedAlertId(id);
              setSelectedPointId("");
            }}
            onPendingMove={(coordinate) => {
              if (mode === "point") setPointPosition(coordinate);
              if (mode === "alert") setAlertPosition(coordinate);
            }}
          />
        </div>
        <aside className="outdoor-inspector">
          {error && (
            <p className="error" role="alert">
              {error} <button onClick={() => void reload()}>Retry</button>
            </p>
          )}
          {status && (
            <p className="editor-status" role="status">
              {status}
            </p>
          )}
          <label className="field">
            Route or path
            <select
              value={selectedPathId}
              onChange={(event) => choosePath(event.target.value)}
              aria-label="Select path"
            >
              <option value="">Choose a path</option>
              {pathOptions.map((path) => (
                <option key={path.id} value={path.id}>
                  {path.displayName}
                </option>
              ))}
            </select>
          </label>
          {mode === "select" && selectedPath && (
            <section aria-label="Selected path">
              <h3>
                {
                  pathOptions.find((path) => path.id === selectedPath.id)
                    ?.displayName
                }
              </h3>
              <p className="muted">
                {selectedPath.kind === "shortcut" ? "Shortcut" : "Main path"}
              </p>
              <fieldset className="path-state-choices">
                <legend>Routing status</legend>
                <label>
                  <input
                    type="radio"
                    name="path-state"
                    checked={blockedChoice === true}
                    onChange={() => setBlockedChoice(true)}
                  />{" "}
                  Block
                </label>
                <label>
                  <input
                    type="radio"
                    name="path-state"
                    checked={blockedChoice === false}
                    onChange={() => setBlockedChoice(false)}
                  />{" "}
                  Good for Routing
                </label>
              </fieldset>
              <button
                className="primary full"
                disabled={
                  saving ||
                  blockedChoice === undefined ||
                  blockedChoice === selectedPath.blocked
                }
                onClick={() => void savePathStatus()}
              >
                {saving ? "Saving…" : "Save routing status"}
              </button>
              <label className="field">
                Note in Route{" "}
                <small>
                  {pathNote.length}/{maximumPathNote}
                </small>
                <textarea
                  maxLength={maximumPathNote}
                  value={pathNote}
                  onChange={(event) => setPathNote(event.target.value)}
                />
              </label>
              <div className="button-row">
                <button
                  disabled={
                    saving ||
                    !pathNote.trim() ||
                    pathNote.trim() === (selectedPath.note ?? "")
                  }
                  onClick={() => void savePathNote()}
                >
                  Save note
                </button>
                <button
                  disabled={saving || !selectedPath.note}
                  onClick={() => void savePathNote(true)}
                >
                  Remove note
                </button>
              </div>
              <section
                className="path-obstacle"
                aria-label="Temporary obstruction"
              >
                <h4>Temporary obstruction</h4>
                <p className="muted">
                  This publishes a route block for the selected path. A map
                  alert or visitor note alone never blocks routing.
                </p>
                <label className="field">
                  Reason
                  <input
                    value={obstacleReason}
                    maxLength={240}
                    onChange={(event) => setObstacleReason(event.target.value)}
                    placeholder="Path closed for maintenance"
                  />
                </label>
                <label className="field">
                  Expires
                  <select
                    aria-label="Obstruction expiry"
                    value={obstacleExpiry}
                    onChange={(event) => setObstacleExpiry(event.target.value)}
                  >
                    <option value="30">30 minutes</option>
                    <option value="120">2 hours</option>
                    <option value="1440">1 day</option>
                    <option value="never">No expiry</option>
                  </select>
                </label>
                <button
                  className="primary full"
                  disabled={saving || !obstacleReason.trim()}
                  onClick={() => void publishObstacle()}
                >
                  {saving ? "Publishing…" : "Publish obstruction"}
                </button>
                {obstacles
                  .filter((obstacle) =>
                    obstacle.affected_path_ids.includes(selectedPath.id),
                  )
                  .map((obstacle) => (
                    <div className="active-obstacle" key={obstacle.id}>
                      <div>
                        <strong>{obstacle.reason}</strong>
                        <span>
                          {obstacle.expires_at
                            ? `Expires ${new Date(obstacle.expires_at).toLocaleString()}`
                            : "No expiry"}
                        </span>
                      </div>
                      <button
                        disabled={saving}
                        onClick={() => void deactivateObstacle(obstacle.id)}
                      >
                        Remove
                      </button>
                    </div>
                  ))}
              </section>
              {selectedPath.alertIds?.length ? (
                <p className="muted">
                  Linked alerts: {selectedPath.alertIds.join(", ")}
                </p>
              ) : null}
            </section>
          )}
          {mode === "draw" && (
            <section aria-label="Draw shortcut path">
              <h3>Draw shortcut</h3>
              <p className="muted">
                Click to add vertices. Snap both ends to a saved path before
                saving.
              </p>
              <p>
                {vertices.length} vertices ·{" "}
                {validSnaps
                  ? "Both ends connected"
                  : "Both ends need a path snap"}
              </p>
              <div className="button-row">
                <button
                  disabled={!vertices.length}
                  onClick={() => setVertices((items) => items.slice(0, -1))}
                >
                  Undo last vertex
                </button>
                <button
                  disabled={!vertices.length}
                  onClick={() => setVertices([])}
                >
                  Cancel
                </button>
              </div>
              <button
                className="primary full"
                disabled={saving || vertices.length < 2 || !validSnaps}
                onClick={() => void saveDrawnPath()}
              >
                {saving ? "Saving…" : "Finish and save"}
              </button>
              {vertices.length > 0 && !validSnaps && (
                <p className="selection-warning">
                  Snap the first and last vertices within 12 pixels and 5 metres
                  of saved paths.
                </p>
              )}
            </section>
          )}
          {mode === "point" && (
            <section aria-label="Outdoor point editor">
              <h3>{selectedPoint ? "Outdoor point" : "Add point"}</h3>
              <p className="muted">
                {pointPosition
                  ? "Location selected"
                  : "Click the map to place a point."}
              </p>
              <label className="field">
                Name{" "}
                <input
                  maxLength={120}
                  value={pointName}
                  onChange={(event) => setPointName(event.target.value)}
                />
              </label>
              <label className="field">
                Note{" "}
                <small>
                  {pointNote.length}/{maximumPointNote}
                </small>
                <textarea
                  maxLength={maximumPointNote}
                  value={pointNote}
                  onChange={(event) => setPointNote(event.target.value)}
                />
              </label>
              <button
                className="primary full"
                disabled={saving || !pointPosition || !pointNote.trim()}
                onClick={() => void savePoint()}
              >
                {saving ? "Saving…" : "Save point"}
              </button>
              {selectedPoint && (
                <button
                  className="danger full"
                  onClick={() => void removePoint()}
                >
                  Remove point
                </button>
              )}
            </section>
          )}
          {mode === "alert" && (
            <section aria-label="Alert editor">
              <h3>Add alert</h3>
              <p className="muted">
                {alertPosition
                  ? "Location selected"
                  : "Click the map to place an alert."}
              </p>
              <label className="field">
                Note{" "}
                <small>
                  {alertNote.length}/{maximumPointNote}
                </small>
                <textarea
                  maxLength={maximumPointNote}
                  value={alertNote}
                  onChange={(event) => setAlertNote(event.target.value)}
                />
              </label>
              <button
                className="primary full"
                disabled={saving || !alertPosition || !alertNote.trim()}
                onClick={() => void saveAlert()}
              >
                {saving ? "Publishing…" : "Publish alert"}
              </button>
              <h3>Saved alerts</h3>
              <div className="compact-candidates">
                {data.alerts.map((alert) => (
                  <div
                    key={alert.id}
                    className={`saved-alert ${selectedAlertId === alert.id ? "selected" : ""}`}
                  >
                    <button onClick={() => setSelectedAlertId(alert.id)}>
                      {alert.description}
                    </button>
                    <button
                      aria-label="Remove alert"
                      onClick={() => void removeAlert(alert)}
                    >
                      Remove
                    </button>
                  </div>
                ))}
                {!data.alerts.length && (
                  <p className="muted">No alerts have been added.</p>
                )}
              </div>
              {selectedAlert && (
                <p className="alert-detail">{selectedAlert.description}</p>
              )}
            </section>
          )}
          {mode === "select" && !selectedPath && (
            <section>
              <h3>Outdoor map</h3>
              <p>Select a stored path on the map or from the list.</p>
              <p className="muted">
                Buildings, paths, points and alerts remain visible while you
                edit.
              </p>
            </section>
          )}
          {mode === "select" && selectedPoint && (
            <section aria-label="Selected outdoor point">
              <h3>{selectedPoint.name || "Outdoor point"}</h3>
              <p>{selectedPoint.note || "No note."}</p>
              <button onClick={() => setModeAndClear("point")}>
                Edit point
              </button>
            </section>
          )}
          {mode === "select" && selectedAlert && (
            <section aria-label="Selected alert">
              <h3>Alert</h3>
              <p>{selectedAlert.description}</p>
              <button
                className="danger"
                onClick={() => void removeAlert(selectedAlert)}
              >
                Remove alert
              </button>
            </section>
          )}
        </aside>
      </div>
    </section>
  );
}
