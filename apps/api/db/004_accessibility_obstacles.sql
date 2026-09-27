BEGIN;

ALTER TABLE route_edges
  ADD COLUMN IF NOT EXISTS surface text,
  ADD COLUMN IF NOT EXISTS surface_condition text NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS stairs text NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS slope_percent double precision,
  ADD COLUMN IF NOT EXISTS width_meters double precision,
  ADD COLUMN IF NOT EXISTS wheelchair_access text NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS confidence text NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS observed_at timestamptz;

ALTER TABLE route_edges
  ADD CONSTRAINT route_edges_surface_condition_check CHECK (surface_condition IN ('excellent','good','intermediate','bad','very_bad','horrible','unknown')),
  ADD CONSTRAINT route_edges_stairs_check CHECK (stairs IN ('yes','no','unknown')),
  ADD CONSTRAINT route_edges_slope_check CHECK (slope_percent IS NULL OR (slope_percent BETWEEN -100 AND 100)),
  ADD CONSTRAINT route_edges_width_check CHECK (width_meters IS NULL OR (width_meters > 0 AND width_meters <= 20)),
  ADD CONSTRAINT route_edges_wheelchair_access_check CHECK (wheelchair_access IN ('yes','no','unknown')),
  ADD CONSTRAINT route_edges_confidence_check CHECK (confidence IN ('osm_tag','editor_observation','condition_report','unknown'));

CREATE TABLE IF NOT EXISTS route_obstacles (
  id text PRIMARY KEY,
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 240),
  affected_path_ids text[] NOT NULL CHECK (cardinality(affected_path_ids) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  deactivated_at timestamptz,
  CHECK (expires_at IS NULL OR expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS route_obstacles_active_expiry_idx
  ON route_obstacles(expires_at) WHERE deactivated_at IS NULL;

COMMIT;
