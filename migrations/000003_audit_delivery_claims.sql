ALTER TABLE audit_outbox
  ADD COLUMN claim_token uuid,
  ADD COLUMN claim_expires_at timestamptz,
  ADD CONSTRAINT audit_outbox_claim_pair CHECK (
    (claim_token IS NULL AND claim_expires_at IS NULL)
    OR (claim_token IS NOT NULL AND claim_expires_at IS NOT NULL AND delivered_at IS NULL)
  );

COMMENT ON COLUMN audit_outbox.claim_token IS
  'Fresh ownership token per delivery acquisition; acknowledgement and retry must fence on it.';
COMMENT ON COLUMN audit_outbox.claim_expires_at IS
  'Database-time lease; expired claims are eligible for recovery without a cleanup job.';
COMMENT ON COLUMN audit_outbox.attempts IS
  'Acquisition count, including abandoned claims; historical counts before migration 000003 counted failures.';
