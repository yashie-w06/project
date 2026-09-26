import type { CampusMapData, Coordinate, FloorDetails, RouteEndpoint, RouteResponse, TravelProfile } from "./types";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3001";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  const data = response.status === 204 ? undefined : await response.json();
  if (!response.ok) throw new Error(data?.error ?? `Request failed (${response.status})`);
  return data as T;
}

export const api = {
  map: () => request<CampusMapData>("/api/map"),
  buildings: () => request<{ buildings: Array<{ id: string; name: string; footprint: Record<string, unknown>; mapped_level_count?: number }> }>("/api/buildings"),
  floor: (id: string, floor: number) => request<FloorDetails>(`/api/buildings/${encodeURIComponent(id)}/floors/${floor}`),
  search: (q: string) => request<{ results: Array<{ kind: string; id: string; name: string; longitude?: number; latitude?: number }> }>(`/api/search?q=${encodeURIComponent(q)}`),
  route: (profile: TravelProfile, start: RouteEndpoint, destination: RouteEndpoint) => request<RouteResponse>("/api/route", { method: "POST", body: JSON.stringify({ profile, start, destination }) }),
  message: (coordinates: Coordinate, description: string) => request<{ received: true }>("/api/messages", { method: "POST", body: JSON.stringify({ coordinates, description }) }),
  login: (email: string, password: string) => request<{ token: string; expiresInSeconds: number }>("/api/editor/login", { method: "POST", body: JSON.stringify({ email, password }) }),
  editor: <T>(path: string, token: string, init?: RequestInit) => request<T>(`/api/editor${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) } }),
};
