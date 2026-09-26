import { useEffect, useMemo, useState } from "react";
import { Navigate } from "react-router-dom";
import { api } from "../api";
import {
  FloorCanvas,
  type DoorFeature,
  type FloorFeature,
  type FloorLayout,
} from "../editor";
import { OutdoorEditor } from "../editor/OutdoorEditor";
import { CampusMap } from "../map/CampusMap";
import type { CampusMapData, Coordinate } from "../types";
import "./editor-page.css";

type Tab = "outdoor" | "floor" | "messages";
type Building = { id: string; name: string };
type FloorSummary = {
  id: string;
  floor_number: number;
  status: "draft" | "published";
  version: number;
};
type SavedFeature = {
  id: string;
  kind: FloorFeature["kind"];
  name: string;
  geometry: Record<string, unknown>;
  connector_id?: string;
  served_floors?: number[];
  is_exit?: boolean;
  outdoor_position?: Coordinate;
  linked_graph_node_id?: string;
};
type SavedFloor = {
  id: string;
  building_id: string;
  floor_number: number;
  boundary: { coordinates?: number[][][] };
  local_width: number;
  local_height: number;
  map_transform: FloorLayout["transform"];
  status: "draft" | "published";
  version: number;
  features: SavedFeature[];
};
type VisitorMessage = {
  id: string;
  longitude: number;
  latitude: number;
  description: string;
  created_at: string;
};

const defaultLayout = (buildingId = "", floor = 0): FloorLayout => ({
  buildingId,
  floor,
  version: 1,
  localWidth: 1000,
  localHeight: 700,
  boundary: [
    { x: 40, y: 40 },
    { x: 960, y: 40 },
    { x: 960, y: 660 },
    { x: 40, y: 660 },
  ],
  transform: {
    origin: [75.8717, 22.7263],
    xAxis: [0.000001, 0],
    yAxis: [0, -0.000001],
  },
  features: [],
  status: "draft",
});

function toLayout(saved: SavedFloor): FloorLayout {
  const boundary = saved.boundary.coordinates?.[0] ?? [];
  return {
    buildingId: saved.building_id,
    floor: saved.floor_number,
    version: saved.version,
    localWidth: saved.local_width,
    localHeight: saved.local_height,
    transform: saved.map_transform,
    status: saved.status,
    boundary: boundary.slice(0, -1).map(([x = 0, y = 0]) => ({ x, y })),
    features: saved.features.map((feature) => {
      const geometry = feature.geometry;
      if (feature.kind === "room")
        return {
          id: feature.id,
          kind: "room",
          name: feature.name,
          x: Number(geometry.x),
          y: Number(geometry.y),
          width: Number(geometry.width),
          height: Number(geometry.height),
        };
      if (feature.kind === "door")
        return {
          id: feature.id,
          kind: "door",
          name: feature.name,
          parent: geometry.parent as DoorFeature["parent"],
          position: Number(geometry.position),
          isExit: Boolean(feature.is_exit),
          outdoorPosition: feature.outdoor_position,
          linkedGraphNodeId: feature.linked_graph_node_id,
          mainPathVerified: Boolean(feature.linked_graph_node_id),
        };
      if (feature.kind === "stairs" || feature.kind === "lift")
        return {
          id: feature.id,
          kind: feature.kind,
          name: feature.name,
          x: Number(geometry.x),
          y: Number(geometry.y),
          size: Number(geometry.size),
          connectorId: feature.connector_id ?? "",
          servedFloors: feature.served_floors ?? [],
        };
      return {
        id: feature.id,
        kind: "point",
        name: feature.name,
        x: Number(geometry.x),
        y: Number(geometry.y),
      };
    }),
  };
}

function floorPayload(next: FloorLayout, status: "draft" | "published") {
  const first = next.boundary[0];
  return {
    id: `${next.buildingId}:${next.floor}`,
    buildingId: next.buildingId,
    floorNumber: next.floor,
    boundary: {
      type: "Polygon",
      coordinates: [
        [
          ...next.boundary.map((point) => [point.x, point.y]),
          ...(first ? [[first.x, first.y]] : []),
        ],
      ],
    },
    localWidth: next.localWidth,
    localHeight: next.localHeight,
    mapTransform: next.transform,
    status,
    version: next.version,
    features: next.features.map((feature) => ({
      id: feature.id,
      kind: feature.kind,
      name: feature.name,
      geometry:
        feature.kind === "room"
          ? {
              x: feature.x,
              y: feature.y,
              width: feature.width,
              height: feature.height,
            }
          : feature.kind === "door"
            ? { parent: feature.parent, position: feature.position }
            : {
                x: feature.x,
                y: feature.y,
                ...(feature.kind === "stairs" || feature.kind === "lift"
                  ? { size: feature.size }
                  : {}),
              },
      parentFeatureId:
        feature.kind === "door" && feature.parent.kind === "room"
          ? feature.parent.roomId
          : null,
      parentEdge: feature.kind === "door" ? feature.parent.edgeIndex : null,
      edgePosition: feature.kind === "door" ? feature.position : null,
      connectorId:
        feature.kind === "stairs" || feature.kind === "lift"
          ? feature.connectorId
          : null,
      servedFloors:
        feature.kind === "stairs" || feature.kind === "lift"
          ? feature.servedFloors
          : null,
      isExit: feature.kind === "door" ? feature.isExit : false,
      outdoorPosition:
        feature.kind === "door" ? (feature.outdoorPosition ?? null) : null,
      linkedGraphNodeId:
        feature.kind === "door" ? (feature.linkedGraphNodeId ?? null) : null,
      status,
    })),
  };
}

export function Editor() {
  const token = sessionStorage.getItem("editorToken");
  const [tab, setTab] = useState<Tab>("outdoor");
  const [mapData, setMapData] = useState<CampusMapData>();
  const [buildings, setBuildings] = useState<Building[]>([]);
  const [buildingId, setBuildingId] = useState("");
  const [buildingQuery, setBuildingQuery] = useState("");
  const [floors, setFloors] = useState<FloorSummary[]>([]);
  const [layout, setLayout] = useState<FloorLayout>(() => defaultLayout());
  const [messages, setMessages] = useState<VisitorMessage[]>([]);
  const [selectedMessage, setSelectedMessage] = useState<VisitorMessage>();
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [linkExit, setLinkExit] = useState<{
    featureId: string;
    name: string;
  }>();

  useEffect(() => {
    if (!token) return;
    Promise.all([api.map(), api.buildings()])
      .then(([map, result]) => {
        setMapData(map);
        setBuildings(result.buildings);
        setError("");
      })
      .catch((cause) =>
        setError(
          cause instanceof Error
            ? cause.message
            : "Editor data could not be loaded",
        ),
      );
  }, [token]);
  useEffect(() => {
    if (!token || tab !== "messages") return;
    api
      .editor<{ messages: VisitorMessage[] }>("/messages", token)
      .then((result) => setMessages(result.messages))
      .catch((cause) =>
        setError(
          cause instanceof Error
            ? cause.message
            : "Messages could not be loaded",
        ),
      );
  }, [token, tab]);

  const visibleBuildings = useMemo(
    () =>
      buildings
        .filter((building) =>
          `${building.name} ${building.id}`
            .toLowerCase()
            .includes(buildingQuery.toLowerCase()),
        )
        .slice(0, 12),
    [buildings, buildingQuery],
  );
  const selectedBuilding = buildings.find(
    (building) => building.id === buildingId,
  );

  if (!token) return <Navigate to="/edit/login" replace />;

  async function chooseBuilding(id: string) {
    setBuildingId(id);
    setBuildingQuery(buildings.find((item) => item.id === id)?.name ?? "");
    setStatus("");
    try {
      const result = await api.editor<{ floors: FloorSummary[] }>(
        `/floors?buildingId=${encodeURIComponent(id)}`,
        token!,
      );
      setFloors(result.floors);
      if (result.floors[0]) await loadFloor(result.floors[0].id);
      else setLayout(defaultLayout(id, 0));
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Floors could not be loaded",
      );
    }
  }

  async function loadFloor(id: string) {
    try {
      const saved = await api.editor<SavedFloor>(
        `/floors/${encodeURIComponent(id)}`,
        token!,
      );
      setLayout(toLayout(saved));
      setStatus(`Loaded floor ${saved.floor_number} (${saved.status}).`);
      setError("");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Floor could not be loaded",
      );
    }
  }

  function addFloor() {
    if (!buildingId) return;
    const used = new Set(floors.map((floor) => floor.floor_number));
    let number = 0;
    while (used.has(number)) number++;
    setLayout(defaultLayout(buildingId, number));
    setStatus(`New floor ${number}; save it as a draft when ready.`);
  }

  async function save(next: FloorLayout, target: "draft" | "published") {
    if (!next.buildingId) {
      setError("Choose a mapped building first.");
      return false;
    }
    try {
      const result = await api.editor<{ version: number }>(
        `/floors/${encodeURIComponent(`${next.buildingId}:${next.floor}`)}`,
        token!,
        { method: "PUT", body: JSON.stringify(floorPayload(next, target)) },
      );
      const saved = { ...next, status: target, version: result.version };
      setLayout(saved);
      setStatus(
        target === "draft"
          ? "Draft saved and reloadable."
          : "Published floor saved.",
      );
      setError("");
      const list = await api.editor<{ floors: FloorSummary[] }>(
        `/floors?buildingId=${encodeURIComponent(next.buildingId)}`,
        token!,
      );
      setFloors(list.floors);
      return true;
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Floor could not be saved",
      );
      return false;
    }
  }

  async function beginExitLink(door: DoorFeature) {
    const saved = await save(layout, "draft");
    if (!saved) return;
    setLinkExit({ featureId: door.id, name: door.name });
    setTab("outdoor");
    setStatus("Choose a verified main-path node for the exit.");
  }

  return (
    <main className="editor-page">
      <header className="topbar">
        <div>
          <span className="eyebrow">Protected workspace</span>
          <h1>Campus editor</h1>
        </div>
        <a href="/">Public map</a>
      </header>
      <nav className="editor-nav" aria-label="Editor sections">
        {(["outdoor", "floor", "messages"] as Tab[]).map((value) => (
          <button
            key={value}
            className={tab === value ? "active" : ""}
            onClick={() => setTab(value)}
          >
            {value === "floor"
              ? "Floor canvas"
              : value === "messages"
                ? "Visitor messages"
                : "Outdoor"}
          </button>
        ))}
        <button
          onClick={() => {
            sessionStorage.removeItem("editorToken");
            location.href = "/edit/login";
          }}
        >
          Sign out
        </button>
      </nav>
      {(error || status) && (
        <div className="editor-flash">
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          {status && (
            <p className="notice" role="status">
              {status}
            </p>
          )}
        </div>
      )}
      <div className="editor-content">
        {tab === "outdoor" && (
          <OutdoorEditor
            token={token}
            linkExit={linkExit}
            onExitLinked={() => {
              setLinkExit(undefined);
              void loadFloor(`${layout.buildingId}:${layout.floor}`).then(() =>
                setTab("floor"),
              );
            }}
          />
        )}
        {tab === "floor" && (
          <section className="floor-workspace">
            <aside className="building-picker">
              <h2>Choose building and floor</h2>
              <label className="field">
                Search mapped buildings
                <input
                  value={buildingQuery}
                  onChange={(event) => setBuildingQuery(event.target.value)}
                  placeholder="Building name"
                />
              </label>
              <div className="building-results">
                {visibleBuildings.map((building) => (
                  <button
                    key={building.id}
                    className={building.id === buildingId ? "selected" : ""}
                    onClick={() => void chooseBuilding(building.id)}
                  >
                    <b>{building.name}</b>
                    <small>{building.id}</small>
                  </button>
                ))}
              </div>
              {buildingId && (
                <>
                  <div className="floor-tabs">
                    {floors.map((floor) => (
                      <button
                        key={floor.id}
                        className={
                          layout.floor === floor.floor_number ? "selected" : ""
                        }
                        onClick={() => void loadFloor(floor.id)}
                      >
                        Floor {floor.floor_number}
                        <small>{floor.status}</small>
                      </button>
                    ))}
                    <button onClick={addFloor}>+ Add floor</button>
                  </div>
                  <p className="muted">
                    Editing {selectedBuilding?.name ?? buildingId}. Drafts
                    remain private until published.
                  </p>
                </>
              )}
            </aside>
            <div className="building-map">
              <CampusMap
                data={mapData}
                selectedBuildingId={buildingId}
                onBuilding={(id) => void chooseBuilding(id)}
              />
            </div>
            {buildingId && (
              <div className="floor-canvas-region">
                <FloorCanvas
                  value={layout}
                  onChange={setLayout}
                  onSaveDraft={(value) => void save(value, "draft")}
                  onPublish={(value) => void save(value, "published")}
                  onLinkExit={(door) => void beginExitLink(door)}
                />
              </div>
            )}
          </section>
        )}
        {tab === "messages" && (
          <section className="message-workspace">
            <div className="message-map">
              <CampusMap
                data={mapData}
                pending={
                  selectedMessage
                    ? [selectedMessage.longitude, selectedMessage.latitude]
                    : undefined
                }
                focus={
                  selectedMessage
                    ? [selectedMessage.longitude, selectedMessage.latitude]
                    : undefined
                }
              />
            </div>
            <div className="message-list">
              <h2>Visitor messages</h2>
              {messages.map((message) => (
                <button
                  key={message.id}
                  className={
                    selectedMessage?.id === message.id ? "selected" : ""
                  }
                  onClick={() => setSelectedMessage(message)}
                >
                  <b>
                    {message.latitude.toFixed(6)},{" "}
                    {message.longitude.toFixed(6)}
                  </b>
                  <span>{message.description}</span>
                  <small>{new Date(message.created_at).toLocaleString()}</small>
                </button>
              ))}
              {messages.length === 0 && <p>No visitor messages yet.</p>}
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
