import { FloorCanvas } from "./FloorCanvas";
import type { FloorLayout } from "./types";
import "./floor-viewer.css";

export type FloorViewerState = "loading" | "unavailable" | "error" | "ready";

export type FloorViewerProps = {
  state: FloorViewerState;
  layout?: FloorLayout;
  buildingName?: string;
  error?: string;
  onRetry: () => void;
};

export function FloorViewer({
  state,
  layout,
  buildingName,
  error,
  onRetry,
}: FloorViewerProps) {
  if (state === "loading") {
    return (
      <section className="floor-viewer__state" role="status">
        Loading floor layout…
      </section>
    );
  }
  if (state === "unavailable") {
    return <section className="floor-viewer__state">No data available</section>;
  }
  if (state === "error" || !layout) {
    return (
      <section
        className="floor-viewer__state floor-viewer__state--error"
        role="alert"
      >
        <p>{error || "The floor layout could not be loaded."}</p>
        <button type="button" onClick={onRetry}>
          Retry
        </button>
      </section>
    );
  }

  return (
    <div className="floor-viewer">
      <h3 className="floor-viewer__heading">
        {buildingName ? `${buildingName} · ` : ""}
        {layout.floor === 0 ? "Ground floor" : `Floor ${layout.floor}`}
      </h3>
      <FloorCanvas
        value={layout}
        onChange={() => undefined}
        onSave={() => undefined}
        buildingName={buildingName}
        readOnly
      />
      <p className="floor-viewer__hint">
        Drag to pan. Use the wheel or trackpad to zoom.
      </p>
    </div>
  );
}
