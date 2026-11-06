ALTER TABLE approval_requests
  ADD COLUMN projection_sync_status text NOT NULL DEFAULT 'pending'
  CHECK (projection_sync_status IN ('pending', 'synced'));

CREATE INDEX approval_requests_projection_sync_idx
  ON approval_requests (updated_at, id)
  WHERE projection_sync_status = 'pending';
