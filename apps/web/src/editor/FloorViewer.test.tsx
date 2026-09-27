// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FloorViewer } from "./FloorViewer";

describe("FloorViewer request states", () => {
  it("shows an explicit loading state", () => {
    render(<FloorViewer state="loading" onRetry={() => undefined} />);
    expect(screen.getByRole("status").textContent).toContain("Loading");
  });

  it("shows the exact unavailable copy for a floor with no saved data", () => {
    render(<FloorViewer state="unavailable" onRetry={() => undefined} />);
    expect(screen.getByText("No data available")).toBeTruthy();
  });

  it("shows request errors with a retry action", () => {
    const onRetry = vi.fn();
    render(
      <FloorViewer state="error" error="Request failed" onRetry={onRetry} />,
    );
    expect(screen.getByRole("alert").textContent).toContain("Request failed");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
