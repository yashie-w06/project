import { polylineLengthMetres, createLocalProjection } from "./projection.js";
import type { RouteEdge, SurfaceCondition, TravelProfile } from "./types.js";

/** Prototype wheelchair limits: clear width >= 0.90 m and absolute slope <= 6%.
 * These conservative software filters are not a medical/legal accessibility guarantee. */
export const WHEELCHAIR_LIMITS = Object.freeze({ minimumWidthMetres: 0.9, maximumSlopePercent: 6 });

export interface EdgePolicy {
  eligible: boolean;
  cost: number;
  unknown: string[];
  constraints: string[];
}

const poorConditions = new Set<SurfaceCondition>(["bad", "very_bad", "horrible"]);

export function evaluateEdge(edge: RouteEdge, profile: TravelProfile, allowUnknownWheelchair = true): EdgePolicy {
  if (edge.coordinates.length < 2 || edge.coordinates.some((coordinate) => !Number.isFinite(coordinate[0]) || !Number.isFinite(coordinate[1]))) return { eligible: false, cost: Infinity, unknown: [], constraints: ["invalid geometry"] };
  const length = edge.lengthMeters ?? polylineLengthMetres(edge.coordinates, createLocalProjection(edge.coordinates[0]!));
  if (!(length > 0) || !Number.isFinite(length) || edge.blocked) return { eligible: false, cost: Infinity, unknown: [], constraints: [edge.blocked ? "blocked" : "invalid geometry"] };
  const unknown: string[] = [];
  const constraints: string[] = [];
  if (profile === "wheelchair") {
    if (edge.kind !== "main" || edge.stairs === "yes" || edge.wheelchairAccess === "no" || (edge.widthMeters != null && edge.widthMeters < WHEELCHAIR_LIMITS.minimumWidthMetres) || (edge.slopePercent != null && Math.abs(edge.slopePercent) > WHEELCHAIR_LIMITS.maximumSlopePercent) || (edge.surfaceCondition && poorConditions.has(edge.surfaceCondition))) {
      if (edge.kind !== "main") constraints.push("shortcut");
      if (edge.stairs === "yes") constraints.push("stairs");
      if (edge.wheelchairAccess === "no") constraints.push("wheelchair access is no");
      if (edge.widthMeters != null && edge.widthMeters < WHEELCHAIR_LIMITS.minimumWidthMetres) constraints.push("narrow width");
      if (edge.slopePercent != null && Math.abs(edge.slopePercent) > WHEELCHAIR_LIMITS.maximumSlopePercent) constraints.push("steep slope");
      if (edge.surfaceCondition && poorConditions.has(edge.surfaceCondition)) constraints.push("poor surface condition");
      return { eligible: false, cost: Infinity, unknown, constraints };
    }
    if (edge.stairs === "unknown") unknown.push("stairs");
    if (edge.wheelchairAccess === "unknown") unknown.push("wheelchair access");
    if (edge.widthMeters == null) unknown.push("width");
    if (edge.slopePercent == null) unknown.push("slope");
    if (!edge.surface) unknown.push("surface material");
    if (!edge.surfaceCondition || edge.surfaceCondition === "unknown") unknown.push("surface condition");
    if (!allowUnknownWheelchair && unknown.length) return { eligible: false, cost: Infinity, unknown, constraints };
    return { eligible: true, cost: length * (unknown.length ? 4 : 1), unknown, constraints };
  }
  let cost = length;
  if (edge.surfaceCondition && poorConditions.has(edge.surfaceCondition)) cost += length * (profile === "heavy_luggage" ? 2 : 0.35);
  if (edge.slopePercent != null && Math.abs(edge.slopePercent) > 5) cost += length * (profile === "heavy_luggage" ? 1.5 : 0.2);
  if (profile === "heavy_luggage") {
    if (edge.stairs === "yes") cost += length * 2.5;
    else if (edge.stairs === "unknown") cost += length * 0.15;
  }
  return { eligible: true, cost, unknown, constraints };
}

export function normalizeSurfaceCondition(smoothness: string | undefined): SurfaceCondition {
  if (smoothness && ["excellent", "good", "intermediate", "bad", "very_bad", "horrible"].includes(smoothness)) return smoothness as SurfaceCondition;
  return "unknown";
}

export function parseInclinePercent(value: string | undefined): number | null {
  if (!value) return null;
  const match = /^\s*([+-]?\d+(?:\.\d+)?)\s*(%|°)?\s*$/.exec(value);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || Math.abs(amount) > 100) return null;
  return match[2] === "°" ? Math.tan((amount * Math.PI) / 180) * 100 : amount;
}
