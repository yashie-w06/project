// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { editor, map, mapData } = vi.hoisted(() => ({
  editor: vi.fn(),
  map: vi.fn(),
  mapData: {
    buildings: { type: "FeatureCollection", features: [] },
    paths: { type: "FeatureCollection", features: [] },
    points: { type: "FeatureCollection", features: [] },
    alerts: [],
  },
}));
vi.mock("../api", () => ({ api: { editor, map } }));
vi.mock("../map/CampusMap", () => ({
  CampusMap: (props: any) => (
    <div data-testid="outdoor-map">
      <button onClick={() => props.onPath?.("p-main")}>
        Select path on map
      </button>
      <button
        onClick={() =>
          props.onPick?.([75.87, 22.72], {
            snap: {
              parentId: "p-main",
              parentVersion: 7,
              coordinates: [75.8701, 22.7201],
              distanceMetres: 1,
              screenPixels: 4,
            },
          })
        }
      >
        Pick snapped vertex
      </button>
      <button
        onClick={() =>
          props.onPick?.([75.871, 22.721], {
            snap: {
              parentId: "p-main",
              parentVersion: 9,
              coordinates: [75.8709, 22.7209],
              distanceMetres: 2,
              screenPixels: 8,
            },
          })
        }
      >
        Pick second snapped vertex
      </button>
      <button onClick={() => props.onPick?.([75.872, 22.722])}>
        Pick unsnapped vertex
      </button>
    </div>
  ),
}));

import { OutdoorEditor } from "./OutdoorEditor";

const makeGraph = () => ({
  paths: [
    {
      id: "p-main",
      name: "Library walk",
      coordinates: [
        [75.87, 22.72],
        [75.871, 22.721],
      ],
      kind: "main",
      source: "osm",
      blocked: false,
      note: "",
      version: 3,
    },
  ],
  points: [],
  alerts: [],
});
let graph = makeGraph();

afterEach(() => {
  cleanup();
  graph = makeGraph();
  vi.clearAllMocks();
});

function renderEditor() {
  editor.mockImplementation(
    async (path: string, _token: string, init?: RequestInit) => {
      if (path === "/graph") return graph;
      if (path === "/obstacles") return { obstacles: [] };
      if (path.startsWith("/paths/p-main") && init?.body) {
        const patch = JSON.parse(String(init.body));
        Object.assign(graph.paths[0]!, patch, {
          version: graph.paths[0]!.version + 1,
        });
      }
      return {};
    },
  );
  map.mockResolvedValue(mapData);
  return render(<OutdoorEditor token="editor-token" />);
}

describe("outdoor editor", () => {
  it("selects a stored path and persists Block or Good for Routing", async () => {
    renderEditor();
    await screen.findByRole("option", { name: "Library walk" });
    fireEvent.change(screen.getByRole("combobox", { name: "Select path" }), {
      target: { value: "p-main" },
    });
    fireEvent.click(screen.getByLabelText("Block"));
    fireEvent.click(
      screen.getByRole("button", { name: "Save routing status" }),
    );
    await waitFor(() =>
      expect(editor).toHaveBeenCalledWith(
        "/paths/p-main",
        "editor-token",
        expect.objectContaining({
          method: "PATCH",
          body: expect.stringContaining('"blocked":true'),
        }),
      ),
    );
    expect((await screen.findByRole("status")).textContent).toContain(
      "Path blocked",
    );
  });

  it("saves and removes a route note through the same stable path id", async () => {
    renderEditor();
    await screen.findByRole("option", { name: "Library walk" });
    fireEvent.change(screen.getByRole("combobox", { name: "Select path" }), {
      target: { value: "p-main" },
    });
    fireEvent.change(screen.getByLabelText(/Note in Route/), {
      target: { value: "Keep right at the library" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save note" }));
    await waitFor(() =>
      expect(editor).toHaveBeenCalledWith(
        "/paths/p-main",
        "editor-token",
        expect.objectContaining({
          method: "PATCH",
          body: expect.stringContaining('"note":"Keep right at the library"'),
        }),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove note" }));
    await waitFor(() =>
      expect(editor).toHaveBeenLastCalledWith(
        "/paths/p-main",
        "editor-token",
        expect.objectContaining({ body: expect.stringContaining('"note":""') }),
      ),
    );
  });

  it("does not enable shortcut saving until both endpoint snaps meet the limits", async () => {
    renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "Draw path" }));
    const save = screen.getByRole("button", { name: "Finish and save" });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(
      screen.getByRole("button", { name: "Pick snapped vertex" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Pick unsnapped vertex" }),
    );
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Pick snapped vertex" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Pick second snapped vertex" }),
    );
    expect((save as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() =>
      expect(editor).toHaveBeenCalledWith(
        "/paths",
        "editor-token",
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining('"endpoints"'),
        }),
      ),
    );
    const body = JSON.parse(
      editor.mock.calls.find(([path]) => path === "/paths")![2].body,
    );
    expect(body.kind).toBeUndefined();
    expect(body.endpoints).toEqual([
      { parentId: "p-main", parentVersion: 7, coordinates: [75.8701, 22.7201] },
      { parentId: "p-main", parentVersion: 9, coordinates: [75.8709, 22.7209] },
    ]);
  });

  it("publishes a point alert without using it to block edges", async () => {
    renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "Add alert" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Pick unsnapped vertex" }),
    );
    fireEvent.change(screen.getByLabelText(/Note/), {
      target: { value: "Work near the south gate" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Publish alert" }));
    await waitFor(() =>
      expect(editor).toHaveBeenCalledWith(
        "/alerts",
        "editor-token",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    const body = JSON.parse(
      editor.mock.calls.find(([path]) => path === "/alerts")![2].body,
    );
    expect(body).toEqual({
      coordinates: [75.872, 22.722],
      description: "Work near the south gate",
    });
    expect(body.edgeIds).toBeUndefined();
  });
});
