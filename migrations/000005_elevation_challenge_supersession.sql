ALTER TABLE elevation_challenges
  ADD COLUMN superseded_at timestamptz,
  ADD CONSTRAINT elevation_challenges_single_settlement CHECK (
    consumed_at IS NULL OR superseded_at IS NULL
  );

CREATE UNIQUE INDEX elevation_challenges_live_idx
  ON elevation_challenges (operation_id)
  WHERE consumed_at IS NULL AND superseded_at IS NULL;

COMMENT ON COLUMN elevation_challenges.superseded_at IS
  'Set when a newer challenge is issued for the operation; a superseded challenge can never be consumed.';
