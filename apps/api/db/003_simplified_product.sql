BEGIN;

-- Keep the existing path stores and stable IDs; these fields add lightweight
-- visitor/editor metadata instead of introducing another route subsystem.
ALTER TABLE route_edges
  ADD COLUMN IF NOT EXISTS name text,
  ADD COLUMN IF NOT EXISTS note text;
ALTER TABLE osm_candidates
  ADD COLUMN IF NOT EXISTS note text,
  ADD COLUMN IF NOT EXISTS blocked boolean NOT NULL DEFAULT false;
ALTER TABLE outdoor_points
  ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '';

-- A shortcut endpoint is a durable junction on a parent path. Geometry is
-- split deterministically in the route graph; the parent feature retains its
-- ID, block and note metadata.
CREATE TABLE IF NOT EXISTS path_snap_connections (
  shortcut_path_id text NOT NULL REFERENCES route_edges(id) ON DELETE CASCADE,
  endpoint_index smallint NOT NULL CHECK (endpoint_index IN (0,1)),
  parent_feature_id text NOT NULL,
  parent_source text NOT NULL CHECK (parent_source IN ('osm','editor')),
  parent_segment_index integer NOT NULL CHECK (parent_segment_index >= 0),
  parent_segment_fraction double precision NOT NULL CHECK (parent_segment_fraction BETWEEN 0 AND 1),
  parent_version integer NOT NULL,
  junction_node_id text NOT NULL REFERENCES route_nodes(id),
  coordinates jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (shortcut_path_id, endpoint_index)
);
CREATE INDEX IF NOT EXISTS path_snap_parent_idx
  ON path_snap_connections(parent_source, parent_feature_id);

-- Record ambiguous legacy review flags for developer follow-up. They remain
-- in the original rows, while current routing re-evaluates actual geometry and
-- access tags instead of treating review state as an approval gate.
CREATE TABLE IF NOT EXISTS simplification_review_audit (
  source_way_id text PRIMARY KEY,
  legacy_decision text,
  legacy_reason text,
  tags jsonb NOT NULL DEFAULT '{}'::jsonb,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO simplification_review_audit(source_way_id,legacy_decision,legacy_reason,tags)
SELECT source_way_id, reviewer_decision, provisional_exclusion_reason, tags
FROM osm_candidates
WHERE reviewer_decision IS NOT NULL
   OR provisional_exclusion_reason LIKE 'review_%'
ON CONFLICT(source_way_id) DO NOTHING;

COMMIT;
