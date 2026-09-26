import { useEffect, useMemo, useState } from "react";
import type { Feature, LineString } from "geojson";
import { api } from "../api";
import { CampusMap } from "../map/CampusMap";
import type { CampusMapData, Coordinate } from "../types";
import "./outdoor-editor.css";

type Mode = "select" | "point" | "draw" | "review" | "alert";
type GraphData = {
  nodes: Array<{
    id: string;
    longitude: number;
    latitude: number;
    version: number;
  }>;
  edges: Array<{
    id: string;
    from_node_id: string;
    to_node_id: string;
    coordinates: Coordinate[];
    kind: "main" | "shortcut";
    verified: boolean;
    published: boolean;
    blocked: boolean;
    version: number;
  }>;
  candidates: Array<{
    id: string;
    source_way_id: string;
    reviewer_decision?: string;
    import_status?: string;
    version: number;
    coordinates: Coordinate[];
  }>;
  points: Array<{
    id: string;
    name: string;
    longitude: number;
    latitude: number;
    published: boolean;
    version: number;
  }>;
  alerts: Array<{
    id: string;
    description: string;
    active: boolean;
    edge_ids: string[];
  }>;
};

type ExitLinkRequest = { featureId: string; name: string };

const modeHelp: Record<Mode, string> = {
  select: "Click a building or choose an item in the inspector to examine it.",
  point:
    "Click the map to place a named outdoor dot, then drag the amber marker if needed.",
  draw: "Click short connected vertices in order; finish to save a non-routable draft.",
  review:
    "Select an OSM reference below to highlight it; review never publishes it.",
  alert:
    "Click a location for an alert. Blocking requires explicit route-edge selection.",
};

function countComponents(data?: GraphData) {
  if (!data) return 0;
  const published = data.edges.filter(
    (edge) => edge.verified && edge.published && !edge.blocked,
  );
  const adjacency = new Map<string, Set<string>>();
  for (const edge of published) {
    if (!adjacency.has(edge.from_node_id))
      adjacency.set(edge.from_node_id, new Set());
    if (!adjacency.has(edge.to_node_id))
      adjacency.set(edge.to_node_id, new Set());
    adjacency.get(edge.from_node_id)!.add(edge.to_node_id);
    adjacency.get(edge.to_node_id)!.add(edge.from_node_id);
  }
  let count = 0;
  const seen = new Set<string>();
  for (const id of adjacency.keys()) {
    if (seen.has(id)) continue;
    count++;
    const stack = [id];
    while (stack.length) {
      const current = stack.pop()!;
      if (seen.has(current)) continue;
      seen.add(current);
      adjacency.get(current)?.forEach((next) => stack.push(next));
    }
  }
  return count;
}

export function OutdoorEditor({
  token,
  linkExit,
  onExitLinked,
}: {
  token: string;
  linkExit?: ExitLinkRequest;
  onExitLinked?: (result: {
    linkedGraphNodeId: string;
    outdoorPosition: Coordinate;
  }) => void;
}) {
  const [data, setData] = useState<GraphData>();
  const [mapData, setMapData] = useState<CampusMapData>();
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [mode, setMode] = useState<Mode>("select");
  const [selectedCandidateId, setSelectedCandidateId] = useState<string>();
  const [filter, setFilter] = useState("");
  const [decisionFilter, setDecisionFilter] = useState("all");
  const [pointPosition, setPointPosition] = useState<Coordinate>();
  const [pointName, setPointName] = useState("");
  const [pointPublished, setPointPublished] = useState(false);
  const [vertices, setVertices] = useState<Coordinate[]>([]);
  const [pathKind, setPathKind] = useState<"main" | "shortcut">("main");
  const [fieldVerified, setFieldVerified] = useState(false);
  const [alertPosition, setAlertPosition] = useState<Coordinate>();
  const [alertText, setAlertText] = useState("");
  const [blockedEdgeIds, setBlockedEdgeIds] = useState<string[]>([]);

  const reload = async () => {
    try {
      const [graph, map] = await Promise.all([
        api.editor<GraphData>("/graph", token),
        api.map(),
      ]);
      setData(graph);
      setMapData(map);
      setError("");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Outdoor data could not be loaded",
      );
    }
  };
  useEffect(() => {
    void reload();
  }, [token]);

  const selectedCandidate = data?.candidates.find(
    (candidate) => candidate.id === selectedCandidateId,
  );
  const selectedFeature: Feature<LineString> | undefined = selectedCandidate
    ? {
        type: "Feature",
        properties: { id: selectedCandidate.id },
        geometry: {
          type: "LineString",
          coordinates: selectedCandidate.coordinates,
        },
      }
    : undefined;
  const draftFeature: Feature<LineString> | undefined =
    vertices.length > 1
      ? {
          type: "Feature",
          properties: {},
          geometry: { type: "LineString", coordinates: vertices },
        }
      : undefined;
  const filteredCandidates = useMemo(
    () =>
      data?.candidates.filter((candidate) => {
        const decision = candidate.reviewer_decision ?? "pending";
        return (
          (decisionFilter === "all" || decision === decisionFilter) &&
          `${candidate.source_way_id} ${decision}`
            .toLowerCase()
            .includes(filter.toLowerCase())
        );
      }) ?? [],
    [data, decisionFilter, filter],
  );
  const publishedEdges =
    data?.edges.filter((edge) => edge.verified && edge.published).length ?? 0;
  const drafts =
    data?.edges.filter((edge) => !edge.verified || !edge.published).length ?? 0;
  const blocked = data?.edges.filter((edge) => edge.blocked).length ?? 0;
  const pendingMarker =
    mode === "point"
      ? pointPosition
      : mode === "alert"
        ? alertPosition
        : vertices.at(-1);

  function onMapPick(coordinate: Coordinate) {
    setStatus("");
    if (mode === "point") setPointPosition(coordinate);
    else if (mode === "draw")
      setVertices((current) => [...current, coordinate]);
    else if (mode === "alert") setAlertPosition(coordinate);
  }
  async function savePoint() {
    if (!pointPosition || !pointName.trim()) return;
    try {
      const id = crypto.randomUUID();
      await api.editor(`/points/${id}`, token, {
        method: "PUT",
        body: JSON.stringify({
          name: pointName.trim(),
          coordinates: pointPosition,
          published: pointPublished,
          version: 1,
        }),
      });
      setPointName("");
      setPointPosition(undefined);
      setStatus(
        pointPublished
          ? "Published outdoor point saved."
          : "Outdoor point saved as a draft.",
      );
      await reload();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Point could not be saved",
      );
    }
  }
  async function savePath(publish: boolean) {
    if (vertices.length < 2) return;
    if (publish && !fieldVerified) {
      setError(
        "Physical walkability confirmation is required before publishing.",
      );
      return;
    }
    try {
      const fromId = crypto.randomUUID(),
        toId = crypto.randomUUID(),
        edgeId = crypto.randomUUID();
      await api.editor(`/nodes/${fromId}`, token, {
        method: "PUT",
        body: JSON.stringify({ coordinates: vertices[0], version: 1 }),
      });
      await api.editor(`/nodes/${toId}`, token, {
        method: "PUT",
        body: JSON.stringify({ coordinates: vertices.at(-1), version: 1 }),
      });
      const result = await api.editor<{ warning?: string }>(
        `/edges/${edgeId}`,
        token,
        {
          method: "PUT",
          body: JSON.stringify({
            fromNodeId: fromId,
            toNodeId: toId,
            coordinates: vertices,
            kind: pathKind,
            verified: publish,
            published: publish,
            oneWay: false,
            version: 1,
          }),
        },
      );
      setVertices([]);
      setFieldVerified(false);
      setStatus(
        result.warning ??
          (publish
            ? "Verified connected path published."
            : "Detached path saved safely as a non-routable draft."),
      );
      await reload();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Path could not be saved",
      );
    }
  }
  async function review(decision: "approved" | "rejected" | "needs_edit") {
    if (!selectedCandidate) return;
    try {
      await api.editor(`/candidates/${selectedCandidate.id}`, token, {
        method: "PATCH",
        body: JSON.stringify({ decision, version: selectedCandidate.version }),
      });
      setStatus(
        decision === "approved"
          ? "Reference approved for review only; it was not published."
          : `Reference marked ${decision.replace("_", " ")}.`,
      );
      await reload();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Review could not be saved",
      );
    }
  }
  async function promote() {
    if (
      !selectedCandidate ||
      !fieldVerified ||
      !window.confirm(
        "Publish only if you physically walked and verified the entire candidate. Continue?",
      )
    )
      return;
    try {
      await api.editor(`/candidates/${selectedCandidate.id}/promote`, token, {
        method: "POST",
        body: JSON.stringify({
          version: selectedCandidate.version,
          confirmWalkable: true,
        }),
      });
      setFieldVerified(false);
      setStatus(
        "Field-verified candidate published. Verify graph junctions and coverage before public use.",
      );
      await reload();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Candidate could not be published",
      );
    }
  }
  async function saveAlert() {
    if (!alertPosition || !alertText.trim()) return;
    try {
      await api.editor("/alerts", token, {
        method: "POST",
        body: JSON.stringify({
          coordinates: alertPosition,
          description: alertText.trim(),
          edgeIds: blockedEdgeIds,
        }),
      });
      setAlertText("");
      setAlertPosition(undefined);
      setBlockedEdgeIds([]);
      setStatus(
        blockedEdgeIds.length
          ? "Blocking alert published for the selected edges."
          : "Normal alert published; routing is unchanged.",
      );
      await reload();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Alert could not be saved",
      );
    }
  }

  async function linkExitToNode(nodeId: string) {
    if (!linkExit) return;
    try {
      const result = await api.editor<{
        linkedGraphNodeId: string;
        outdoorPosition: Coordinate;
      }>(
        `/features/${encodeURIComponent(linkExit.featureId)}/exit-link`,
        token,
        {
          method: "PATCH",
          body: JSON.stringify({ nodeId }),
        },
      );
      setStatus(
        `${linkExit.name || "Exit"} is linked to the verified main graph.`,
      );
      onExitLinked?.(result);
      await reload();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Exit could not be linked",
      );
    }
  }

  async function setAlertActive(id: string, active: boolean) {
    try {
      await api.editor(`/alerts/${encodeURIComponent(id)}/active`, token, {
        method: "PATCH",
        body: JSON.stringify({ active }),
      });
      setStatus(
        active
          ? "Alert reactivated."
          : "Alert resolved; affected routes are available again.",
      );
      await reload();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Alert could not be updated",
      );
    }
  }

  return (
    <section className="outdoor-workspace" aria-label="Outdoor graph editor">
      <div
        className="outdoor-toolbar"
        role="toolbar"
        aria-label="Outdoor tools"
      >
        {(["select", "point", "draw", "review", "alert"] as Mode[]).map(
          (value) => (
            <button
              key={value}
              className={mode === value ? "active" : ""}
              onClick={() => {
                setMode(value);
                setStatus("");
              }}
            >
              {value === "point"
                ? "Add point"
                : value === "draw"
                  ? "Draw path"
                  : value === "review"
                    ? "Review OSM"
                    : value === "alert"
                      ? "Alert / block"
                      : "Select"}
            </button>
          ),
        )}
      </div>
      <p className="tool-help">
        <b>
          {mode === "review"
            ? "Reference review:"
            : `${mode[0]!.toUpperCase()}${mode.slice(1)}:`}
        </b>{" "}
        {modeHelp[mode]}
      </p>
      <div className="outdoor-layout">
        <div className="outdoor-map">
          <CampusMap
            data={mapData}
            pending={pendingMarker}
            route={draftFeature}
            focus={selectedFeature}
            highlight={selectedFeature}
            onPick={onMapPick}
            onPendingMove={(coordinate) => {
              if (mode === "point") setPointPosition(coordinate);
              else if (mode === "alert") setAlertPosition(coordinate);
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
          {linkExit && (
            <section className="candidate-card" aria-label="Link floor exit">
              <h3>Link exit: {linkExit.name || "Unnamed exit"}</h3>
              <p>
                Select a node that already belongs to a verified, published main
                path.
              </p>
              <div className="compact-candidates">
                {data?.nodes
                  .filter((node) =>
                    data.edges.some(
                      (edge) =>
                        edge.kind === "main" &&
                        edge.verified &&
                        edge.published &&
                        (edge.from_node_id === node.id ||
                          edge.to_node_id === node.id),
                    ),
                  )
                  .map((node) => (
                    <button
                      key={node.id}
                      onClick={() => void linkExitToNode(node.id)}
                    >
                      <b>{node.id}</b>
                      <span>
                        {node.latitude.toFixed(6)}, {node.longitude.toFixed(6)}
                      </span>
                    </button>
                  ))}
              </div>
              {!data?.edges.some(
                (edge) =>
                  edge.kind === "main" && edge.verified && edge.published,
              ) && (
                <p className="error">
                  No verified published main-path node is available. The exit
                  cannot be linked yet.
                </p>
              )}
            </section>
          )}
          <div className="readiness">
            <h3>Graph readiness</h3>
            <dl>
              <div>
                <dt>Published edges</dt>
                <dd>{publishedEdges}</dd>
              </div>
              <div>
                <dt>Draft edges</dt>
                <dd>{drafts}</dd>
              </div>
              <div>
                <dt>Components</dt>
                <dd>{countComponents(data)}</dd>
              </div>
              <div>
                <dt>Blocked edges</dt>
                <dd>{blocked}</dd>
              </div>
            </dl>
            {publishedEdges < 2 && (
              <p>
                No broad campus coverage yet. Public routing will honestly
                report no verified route where locations are unconnected.
              </p>
            )}
          </div>
          {mode === "point" && (
            <section>
              <h3>Outdoor point</h3>
              <p className="muted">
                {pointPosition
                  ? `${pointPosition[1].toFixed(6)}, ${pointPosition[0].toFixed(6)}`
                  : "Click the map to place the dot."}
              </p>
              <label className="field">
                Name
                <input
                  value={pointName}
                  onChange={(event) => setPointName(event.target.value)}
                />
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={pointPublished}
                  onChange={(event) => setPointPublished(event.target.checked)}
                />{" "}
                Publish for visitors
              </label>
              <button
                className="primary full"
                disabled={!pointPosition || !pointName.trim()}
                onClick={savePoint}
              >
                Save point
              </button>
            </section>
          )}
          {mode === "draw" && (
            <section>
              <h3>Path draft</h3>
              <p>{vertices.length} vertices</p>
              <div className="button-row">
                <button
                  disabled={!vertices.length}
                  onClick={() => setVertices((value) => value.slice(0, -1))}
                >
                  Undo vertex
                </button>
                <button
                  disabled={!vertices.length}
                  onClick={() => setVertices([])}
                >
                  Cancel
                </button>
              </div>
              <label className="field">
                Classification
                <select
                  value={pathKind}
                  onChange={(event) =>
                    setPathKind(event.target.value as typeof pathKind)
                  }
                >
                  <option value="main">Main path</option>
                  <option value="shortcut">Unofficial shortcut</option>
                </select>
              </label>
              <button
                className="primary full"
                disabled={vertices.length < 2}
                onClick={() => void savePath(false)}
              >
                Finish and save draft
              </button>
              <label className="check caution">
                <input
                  type="checkbox"
                  checked={fieldVerified}
                  onChange={(event) => setFieldVerified(event.target.checked)}
                />{" "}
                I physically verified the whole path and its graph junctions.
              </label>
              <button
                className="publish-button"
                disabled={vertices.length < 2 || !fieldVerified}
                onClick={() => void savePath(true)}
              >
                Publish connected path
              </button>
              <p className="muted">
                Detached or invalid geometry remains a non-routable draft even
                after confirmation.
              </p>
            </section>
          )}
          {mode === "review" && (
            <section>
              <h3>OSM references</h3>
              <div className="candidate-filters">
                <input
                  placeholder="Way or status"
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                />
                <select
                  value={decisionFilter}
                  onChange={(event) => setDecisionFilter(event.target.value)}
                >
                  <option value="all">All statuses</option>
                  <option value="pending">Pending</option>
                  <option value="approved">Approved reference</option>
                  <option value="needs_edit">Needs edit</option>
                  <option value="rejected">Rejected</option>
                </select>
              </div>
              <div className="compact-candidates">
                {filteredCandidates.map((candidate) => (
                  <button
                    key={candidate.id}
                    className={
                      candidate.id === selectedCandidateId ? "selected" : ""
                    }
                    onClick={() => setSelectedCandidateId(candidate.id)}
                  >
                    <b>Way {candidate.source_way_id}</b>
                    <span>
                      {candidate.reviewer_decision ?? "pending"} ·{" "}
                      {candidate.coordinates.length} vertices
                    </span>
                  </button>
                ))}
              </div>
              {selectedCandidate && (
                <div className="candidate-card">
                  <h4>Way {selectedCandidate.source_way_id}</h4>
                  <p>
                    {selectedCandidate.coordinates.length} vertices ·{" "}
                    {selectedCandidate.reviewer_decision ?? "pending"}
                  </p>
                  <div className="decision-buttons">
                    <button onClick={() => void review("needs_edit")}>
                      Needs edit
                    </button>
                    <button onClick={() => void review("rejected")}>
                      Reject
                    </button>
                    <button onClick={() => void review("approved")}>
                      Approve reference
                    </button>
                  </div>
                  <label className="check caution">
                    <input
                      type="checkbox"
                      checked={fieldVerified}
                      onChange={(event) =>
                        setFieldVerified(event.target.checked)
                      }
                    />{" "}
                    Entire geometry physically verified and junctions checked.
                  </label>
                  <button
                    className="publish-button"
                    disabled={!fieldVerified}
                    onClick={() => void promote()}
                  >
                    Field-verified: publish main
                  </button>
                </div>
              )}
            </section>
          )}
          {mode === "alert" && (
            <section>
              <h3>Alert / block</h3>
              <p className="muted">
                {alertPosition
                  ? `${alertPosition[1].toFixed(6)}, ${alertPosition[0].toFixed(6)}`
                  : "Click the affected location."}
              </p>
              <label className="field">
                Visitor message
                <textarea
                  value={alertText}
                  onChange={(event) => setAlertText(event.target.value)}
                />
              </label>
              <fieldset>
                <legend>Edges to block (optional)</legend>
                <div className="edge-checks">
                  {data?.edges
                    .filter((edge) => edge.verified && edge.published)
                    .map((edge) => (
                      <label key={edge.id}>
                        <input
                          type="checkbox"
                          checked={blockedEdgeIds.includes(edge.id)}
                          onChange={(event) =>
                            setBlockedEdgeIds((ids) =>
                              event.target.checked
                                ? [...ids, edge.id]
                                : ids.filter((id) => id !== edge.id),
                            )
                          }
                        />{" "}
                        {edge.id} · {edge.kind}
                      </label>
                    ))}
                </div>
              </fieldset>
              <button
                className="primary full"
                disabled={!alertPosition || !alertText.trim()}
                onClick={saveAlert}
              >
                {blockedEdgeIds.length
                  ? "Publish blocking alert"
                  : "Publish normal alert"}
              </button>
              <h4>Existing alerts</h4>
              <div className="compact-candidates">
                {data?.alerts.map((alert) => (
                  <button
                    key={alert.id}
                    onClick={() => void setAlertActive(alert.id, !alert.active)}
                  >
                    <b>
                      {alert.active ? "Active" : "Resolved"}:{" "}
                      {alert.description}
                    </b>
                    <span>
                      {alert.edge_ids.length
                        ? `${alert.edge_ids.length} blocked edge(s)`
                        : "Information only"}
                      {" · click to "}
                      {alert.active ? "resolve" : "reactivate"}
                    </span>
                  </button>
                ))}
                {!data?.alerts.length && (
                  <p className="muted">No alerts have been published.</p>
                )}
              </div>
            </section>
          )}
          {mode === "select" && (
            <section>
              <h3>Map workspace</h3>
              <p>
                Select a tool above. Named buildings, published routes,
                shortcuts, outdoor points and dashed OSM references stay visible
                together.
              </p>
              <p className="muted">
                OSM candidates are reference geometry only and never enter
                public routing from this view without explicit field
                verification.
              </p>
            </section>
          )}
        </aside>
      </div>
    </section>
  );
}
