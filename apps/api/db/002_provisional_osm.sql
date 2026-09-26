BEGIN;

ALTER TABLE osm_candidates
  ADD COLUMN IF NOT EXISTS tags jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS provisional_eligible boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS provisional_exclusion_reason text;

CREATE INDEX IF NOT EXISTS osm_candidates_provisional_idx
  ON osm_candidates(provisional_eligible)
  WHERE provisional_eligible;

COMMIT;
