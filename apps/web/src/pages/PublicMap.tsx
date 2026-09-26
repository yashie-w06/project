import { useEffect, useMemo, useState } from "react";
import type { Feature, LineString } from "geojson";
import { api } from "../api";
import { CampusMap } from "../map/CampusMap";
import type {
  CampusMapData,
  Coordinate,
  RouteEndpoint,
  TravelProfile,
} from "../types";
import "./public-map.css";

type Step = "start" | "destination" | "profile";
type SearchResult = {
  kind: string;
  id: string;
  name: string;
  longitude?: number;
  latitude?: number;
  buildingId?: string;
  floor?: number;
};
type Choice = {
  label: string;
  context: string;
  endpoint: RouteEndpoint;
  buildingId?: string;
  coordinate?: Coordinate;
};

const profileLabels: Record<TravelProfile, string> = {
  healthy: "Healthy",
  wheelchair: "Wheelchair",
  heavy_luggage: "Heavy luggage",
};
const reasonText: Record<string, string> = {
  NO_VERIFIED_PATHS:
    "No verified route available. Walking routes have not been verified yet.",
  START_UNREACHABLE:
    "No verified route available. Start is not connected to a verified walking path; adjust it or choose a mapped exit.",
  DEST_UNREACHABLE:
    "No verified route available. Destination is not connected to a verified walking path; adjust it or choose a mapped entrance.",
  NO_LINKED_EXIT:
    "No verified route available. This building does not have a mapped route-ready exit yet.",
  NO_LINKED_ENTRANCE:
    "No verified route available. This building does not have a mapped route-ready entrance yet.",
  DIFFERENT_COMPONENTS:
    "No verified route available. No verified walking connection exists between these points yet.",
  BLOCKED_OR_INELIGIBLE:
    "No verified route available for this profile right now.",
};

export function visitorReason(reason: string) {
  const exact = reasonText[reason];
  if (exact) return exact;
  if (/not been verified|no verified paths/i.test(reason))
    return (
      reasonText.NO_VERIFIED_PATHS ??
      "Walking routes have not been verified yet."
    );
  if (/cannot both connect|not within/i.test(reason))
    return "No verified route available. One or both selected locations are not connected to a verified walking path.";
  if (/disconnected/i.test(reason))
    return (
      reasonText.DIFFERENT_COMPONENTS ??
      "No verified walking connection exists between these points yet."
    );
  return reason.startsWith("No verified route available")
    ? reason
    : "No verified route available for these locations.";
}

export function PublicMap() {
  const [mapData, setMapData] = useState<CampusMapData>();
  const [mapError, setMapError] = useState("");
  const [step, setStep] = useState<Step>("start");
  const [pending, setPending] = useState<Choice>();
  const [start, setStart] = useState<Choice>();
  const [destination, setDestination] = useState<Choice>();
  const [profile, setProfile] = useState<TravelProfile>("healthy");
  const [route, setRoute] = useState<Feature<LineString>>();
  const [messages, setMessages] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [routeLoading, setRouteLoading] = useState(false);
  const [requestError, setRequestError] = useState("");
  const [floor, setFloor] = useState(0);
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteCoordinate, setNoteCoordinate] = useState<Coordinate>();
  const [note, setNote] = useState("");

  useEffect(() => {
    api
      .map()
      .then(setMapData)
      .catch((error) =>
        setMapError(
          error instanceof Error ? error.message : "Map data is unavailable",
        ),
      );
  }, []);
  useEffect(() => {
    let active = true;
    const timer = setTimeout(async () => {
      if (query.trim().length < 2) {
        setResults([]);
        setSearching(false);
        return;
      }
      setSearching(true);
      try {
        const response = await api.search(query);
        if (active) setResults(response.results);
      } catch {
        if (active) setResults([]);
      } finally {
        if (active) setSearching(false);
      }
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [query]);

  const confirmedStartCoordinate = start?.coordinate;
  const confirmedDestinationCoordinate = destination?.coordinate;
  const selectedBuildingId =
    pending?.buildingId ??
    (step === "start" ? start?.buildingId : destination?.buildingId);
  const instruction =
    step === "start"
      ? "Choose your current location"
      : step === "destination"
        ? "Choose your destination"
        : "Choose a travel profile";
  const canRoute = Boolean(start && destination);
  const stepNumber = step === "start" ? 1 : step === "destination" ? 2 : 3;
  const currentChoice = step === "start" ? start : destination;
  const noMatches =
    query.trim().length >= 2 && !searching && results.length === 0 && !pending;
  const prompt = useMemo(
    () =>
      pending
        ? `${pending.label} is selected. Confirm it in the panel.`
        : step === "profile"
          ? "Confirmed locations are ready."
          : "Search or tap the map.",
    [pending, step],
  );

  function clearRouteFeedback() {
    setRoute(undefined);
    setMessages([]);
    setRequestError("");
  }
  function chooseMapCoordinate(coordinates: Coordinate) {
    if (noteOpen) {
      setNoteCoordinate(coordinates);
      return;
    }
    if (step === "profile") return;
    setPending({
      label: "Dropped pin",
      context: `${coordinates[1].toFixed(6)}, ${coordinates[0].toFixed(6)}`,
      endpoint: { kind: "outdoor", coordinates },
      coordinate: coordinates,
    });
    setQuery("");
    setResults([]);
  }
  function chooseBuilding(id: string) {
    if (noteOpen || step === "profile") return;
    const building = mapData?.buildings.features.find(
      (feature) => feature.properties.id === id,
    );
    setPending({
      label: building?.properties.name ?? "Mapped building",
      context: `Building · floor ${floor}`,
      endpoint: { kind: "building", buildingId: id, floor },
      buildingId: id,
    });
    setQuery(building?.properties.name ?? "");
    setResults([]);
  }
  function chooseResult(result: SearchResult) {
    if (result.kind === "building" || result.buildingId) {
      const buildingId =
        result.kind === "building" ? result.id : result.buildingId!;
      const selectedFloor = result.floor ?? floor;
      setFloor(selectedFloor);
      setPending({
        label: result.name,
        context: `${result.kind === "building" ? "Building" : "Mapped room or facility"} · floor ${selectedFloor}`,
        endpoint: {
          kind: "building",
          buildingId,
          floor: selectedFloor,
          ...(result.kind === "room" ? { roomId: result.id } : {}),
        },
        buildingId,
        coordinate:
          result.longitude != null && result.latitude != null
            ? [result.longitude, result.latitude]
            : undefined,
      });
    } else if (result.longitude != null && result.latitude != null) {
      const coordinate: Coordinate = [result.longitude, result.latitude];
      setPending({
        label: result.name,
        context: result.kind === "point" ? "Mapped outdoor point" : result.kind,
        endpoint: { kind: "outdoor", coordinates: coordinate },
        coordinate,
      });
    } else {
      setPending({
        label: result.name,
        context: `${result.kind} · not route-ready because its building/floor link is missing`,
        endpoint: { kind: "outdoor", coordinates: [Number.NaN, Number.NaN] },
      });
    }
    setQuery(result.name);
    setResults([]);
  }
  function confirmChoice() {
    if (
      !pending ||
      (pending.endpoint.kind === "outdoor" &&
        pending.endpoint.coordinates.some(Number.isNaN))
    )
      return;
    const choice =
      pending.endpoint.kind === "building"
        ? {
            ...pending,
            context: `Building · floor ${floor}`,
            endpoint: { ...pending.endpoint, floor },
          }
        : pending;
    if (step === "start") {
      setStart(choice);
      setStep("destination");
    } else {
      setDestination(choice);
      setStep("profile");
    }
    setPending(undefined);
    setQuery("");
    clearRouteFeedback();
  }
  function edit(which: "start" | "destination") {
    setStep(which);
    setPending(undefined);
    setQuery("");
    clearRouteFeedback();
  }
  function locate() {
    navigator.geolocation?.getCurrentPosition(
      (position) => {
        const coordinate: Coordinate = [
          position.coords.longitude,
          position.coords.latitude,
        ];
        setPending({
          label: "Phone location",
          context: `Accuracy about ${Math.round(position.coords.accuracy)} m · confirm or move the marker`,
          endpoint: { kind: "outdoor", coordinates: coordinate },
          coordinate,
        });
        setMessages([
          "GPS does not prove that you are inside a building. If you are indoors, select the mapped building and its ground-floor exit instead.",
        ]);
      },
      () =>
        setRequestError(
          "Location permission was unavailable. Search or tap the map instead.",
        ),
      { enableHighAccuracy: true },
    );
  }
  async function requestRoute() {
    if (!start || !destination) return;
    setRouteLoading(true);
    setRequestError("");
    setMessages([]);
    try {
      const response = await api.route(
        profile,
        start.endpoint,
        destination.endpoint,
      );
      if (response.status === "ok") {
        setRoute({
          type: "Feature",
          properties: {},
          geometry: response.geometry,
        });
        setMessages(response.notices);
      } else {
        const outcome = response as typeof response & {
          code?: string;
          message?: string;
          reason?: string;
        };
        setRoute(undefined);
        setMessages([
          outcome.code
            ? visitorReason(outcome.code)
            : outcome.message
              ? visitorReason(outcome.message)
              : visitorReason(outcome.reason ?? ""),
          ...response.notices,
        ]);
      }
    } catch (error) {
      setRoute(undefined);
      setRequestError(
        error instanceof Error
          ? error.message
          : "The route service could not complete this request.",
      );
    } finally {
      setRouteLoading(false);
    }
  }
  async function sendNote() {
    if (!noteCoordinate || !note.trim()) return;
    try {
      await api.message(noteCoordinate, note);
      setNote("");
      setNoteCoordinate(undefined);
      setNoteOpen(false);
      setMessages(["Your map note was sent to the campus editor."]);
    } catch (error) {
      setRequestError(
        error instanceof Error ? error.message : "The note could not be sent.",
      );
    }
  }

  return (
    <main className="app-shell public-map-page">
      <header className="topbar">
        <div>
          <span className="eyebrow">SGSITS · Indore</span>
          <h1>Campus Access</h1>
        </div>
        <a href="/edit/login">Editor sign in</a>
      </header>
      <section className="workspace">
        <div className="map-wrap">
          <CampusMap
            data={mapData}
            start={confirmedStartCoordinate}
            destination={confirmedDestinationCoordinate}
            pending={noteOpen ? noteCoordinate : pending?.coordinate}
            route={route}
            selectedBuildingId={selectedBuildingId}
            onPick={chooseMapCoordinate}
            onBuilding={chooseBuilding}
          />
          <div className="map-prompt">
            <b>{noteOpen ? "Place your note" : instruction}</b>
            <span>
              {noteOpen
                ? noteCoordinate
                  ? "Marker placed — write the note in the panel."
                  : "Tap the issue location."
                : prompt}
            </span>
          </div>
        </div>
        <aside className="panel public-route-panel">
          <div className="steps" aria-label={`Step ${stepNumber} of 3`}>
            <button
              className={step === "start" ? "active" : start ? "done" : ""}
              onClick={() => edit("start")}
            >
              1 Start
            </button>
            <button
              className={
                step === "destination" ? "active" : destination ? "done" : ""
              }
              onClick={() => start && edit("destination")}
              disabled={!start}
            >
              2 Destination
            </button>
            <span className={step === "profile" ? "active" : ""}>
              3 Profile / Route
            </span>
          </div>
          <div className="confirmed-summary">
            {start && (
              <div>
                <span>
                  <b>Start</b>
                  {start.label}
                </span>
                <button onClick={() => edit("start")}>Edit</button>
              </div>
            )}
            {destination && (
              <div>
                <span>
                  <b>Destination</b>
                  {destination.label}
                </span>
                <button onClick={() => edit("destination")}>Edit</button>
              </div>
            )}
          </div>
          {!noteOpen && step !== "profile" && (
            <section className="choice-step">
              <h2>{instruction}</h2>
              <label className="field">
                Search mapped places
                <input
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setPending(undefined);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && results.length === 1)
                      chooseResult(results[0]!);
                  }}
                  placeholder={
                    step === "start"
                      ? "Building, gate, room or point"
                      : "Where do you want to go?"
                  }
                  autoComplete="off"
                />
              </label>
              {results.length > 0 && (
                <ul className="search-results">
                  {results.map((result) => (
                    <li key={`${result.kind}-${result.id}`}>
                      <button onClick={() => chooseResult(result)}>
                        <span>
                          <b>{result.name}</b>
                          <small>
                            {result.kind === "feature"
                              ? "Mapped room or facility"
                              : result.kind}
                          </small>
                        </span>
                        <span aria-hidden>›</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {searching && <p className="muted">Searching mapped places…</p>}
              {noMatches && <p className="empty">No matching mapped place.</p>}
              {step === "start" && (
                <button className="gps-button" onClick={locate}>
                  Use phone GPS
                </button>
              )}
              {pending && (
                <div className="selection-card">
                  <span className="selection-kicker">
                    Selected — not yet confirmed
                  </span>
                  <h3>{pending.label}</h3>
                  <p>{pending.context}</p>
                  {pending.buildingId && (
                    <label className="field">
                      Floor
                      <input
                        type="number"
                        value={floor}
                        onChange={(event) =>
                          setFloor(Number(event.target.value))
                        }
                      />
                    </label>
                  )}
                  {pending.endpoint.kind === "outdoor" &&
                  pending.endpoint.coordinates.some(Number.isNaN) ? (
                    <p className="selection-warning">
                      Choose its mapped building first; this result has no safe
                      outdoor route endpoint.
                    </p>
                  ) : (
                    <button className="primary full" onClick={confirmChoice}>
                      Confirm {step}
                    </button>
                  )}
                </div>
              )}
              {currentChoice && !pending && (
                <button
                  className="primary full"
                  onClick={() =>
                    setStep(step === "start" ? "destination" : "profile")
                  }
                >
                  Keep {currentChoice.label}
                </button>
              )}
              {step === "destination" && (
                <button className="back" onClick={() => edit("start")}>
                  ← Back to start
                </button>
              )}
            </section>
          )}
          {!noteOpen && step === "profile" && (
            <section className="route-controls">
              <h2>Profile and route</h2>
              <div className="profiles">
                {(Object.keys(profileLabels) as TravelProfile[]).map(
                  (value) => (
                    <button
                      key={value}
                      className={profile === value ? "selected" : ""}
                      onClick={() => {
                        setProfile(value);
                        clearRouteFeedback();
                      }}
                    >
                      {profileLabels[value]}
                    </button>
                  ),
                )}
              </div>
              <button
                className="primary full"
                disabled={!canRoute || routeLoading}
                onClick={requestRoute}
              >
                {routeLoading
                  ? "Checking verified paths…"
                  : "Find verified route"}
              </button>
              <button className="back" onClick={() => edit("destination")}>
                ← Back to destination
              </button>
            </section>
          )}
          <section className="map-note">
            <button
              className="quiet note-toggle"
              onClick={() => {
                setNoteOpen((value) => !value);
                setPending(undefined);
              }}
            >
              {noteOpen ? "Cancel map note" : "Send a map note"}
            </button>
            {noteOpen && (
              <div>
                <p className="muted">
                  Tap the map where the issue is. Notes do not automatically
                  block a route.
                </p>
                <label className="field">
                  What should the editor know?
                  <textarea
                    maxLength={1000}
                    value={note}
                    onChange={(event) => setNote(event.target.value)}
                  />
                </label>
                <button
                  className="primary full"
                  disabled={!noteCoordinate || !note.trim()}
                  onClick={sendNote}
                >
                  Send note at marker
                </button>
              </div>
            )}
          </section>
          {messages.length > 0 && (
            <div className="notice" role="status">
              {messages.map((message, index) => (
                <p key={index}>{message}</p>
              ))}
            </div>
          )}
          {requestError && (
            <p className="error" role="alert">
              {requestError}
            </p>
          )}
          {mapError && (
            <p className="error" role="alert">
              Map data: {mapError}
            </p>
          )}
        </aside>
      </section>
    </main>
  );
}
