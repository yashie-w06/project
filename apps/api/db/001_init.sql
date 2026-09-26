BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  filename text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS buildings (
  id text PRIMARY KEY,
  name text NOT NULL,
  footprint jsonb NOT NULL,
  mapped_level_count integer CHECK (mapped_level_count IS NULL OR mapped_level_count > 0),
  source_osm_id text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS osm_candidates (
  id text PRIMARY KEY,
  source_way_id text NOT NULL UNIQUE,
  source_node_ids jsonb NOT NULL,
  coordinates jsonb NOT NULL,
  import_status text NOT NULL DEFAULT 'imported' CHECK (import_status IN ('imported','reviewed')),
  reviewer_decision text CHECK (reviewer_decision IS NULL OR reviewer_decision IN ('approved','rejected','needs_edit')),
  version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS floors (
  id text PRIMARY KEY,
  building_id text NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
  floor_number integer NOT NULL,
  boundary jsonb NOT NULL,
  local_width double precision NOT NULL CHECK (local_width > 0),
  local_height double precision NOT NULL CHECK (local_height > 0),
  map_transform jsonb NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (building_id, floor_number)
);

CREATE TABLE IF NOT EXISTS route_nodes (
  id text PRIMARY KEY,
  longitude double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  latitude double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  version integer NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS route_edges (
  id text PRIMARY KEY,
  from_node_id text NOT NULL REFERENCES route_nodes(id),
  to_node_id text NOT NULL REFERENCES route_nodes(id),
  coordinates jsonb NOT NULL,
  kind text NOT NULL CHECK (kind IN ('main','shortcut')),
  verified boolean NOT NULL DEFAULT false,
  published boolean NOT NULL DEFAULT false,
  blocked boolean NOT NULL DEFAULT false,
  one_way boolean NOT NULL DEFAULT false,
  source_osm_id text,
  version integer NOT NULL DEFAULT 1,
  CHECK (from_node_id <> to_node_id)
);

CREATE INDEX IF NOT EXISTS route_edges_from_idx ON route_edges(from_node_id);
CREATE INDEX IF NOT EXISTS route_edges_to_idx ON route_edges(to_node_id);

CREATE TABLE IF NOT EXISTS floor_features (
  id text PRIMARY KEY,
  floor_id text NOT NULL REFERENCES floors(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('room','door','point','stairs','lift')),
  name text NOT NULL DEFAULT '',
  geometry jsonb NOT NULL,
  parent_feature_id text REFERENCES floor_features(id) ON DELETE SET NULL,
  parent_edge integer,
  edge_position double precision CHECK (edge_position IS NULL OR edge_position BETWEEN 0 AND 1),
  connector_id text,
  served_floors jsonb,
  is_exit boolean NOT NULL DEFAULT false,
  outdoor_position jsonb,
  linked_graph_node_id text REFERENCES route_nodes(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  version integer NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS floor_features_floor_idx ON floor_features(floor_id);

CREATE TABLE IF NOT EXISTS outdoor_points (
  id text PRIMARY KEY,
  name text NOT NULL,
  longitude double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  latitude double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  published boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS messages (
  id text PRIMARY KEY,
  longitude double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  latitude double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  description text NOT NULL CHECK (char_length(description) BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS alerts (
  id text PRIMARY KEY,
  longitude double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  latitude double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  description text NOT NULL CHECK (char_length(description) BETWEEN 1 AND 500),
  active boolean NOT NULL DEFAULT true,
  published boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS alert_route_edges (
  alert_id text NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  route_edge_id text NOT NULL REFERENCES route_edges(id) ON DELETE RESTRICT,
  PRIMARY KEY (alert_id, route_edge_id)
);

CREATE INDEX IF NOT EXISTS messages_created_idx ON messages(created_at DESC);
CREATE INDEX IF NOT EXISTS alerts_active_idx ON alerts(active) WHERE active;

COMMIT;
