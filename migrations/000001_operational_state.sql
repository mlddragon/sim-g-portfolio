CREATE TABLE principals (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 512),
  principal_key text NOT NULL UNIQUE CHECK (length(principal_key) BETWEEN 1 AND 128),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 256),
  role text NOT NULL CHECK (role IN ('owner_operator', 'parent_steward', 'family_participant')),
  status text NOT NULL CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE identity_bindings (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 512),
  principal_id text NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
  issuer text NOT NULL CHECK (length(issuer) BETWEEN 1 AND 2048),
  external_subject text NOT NULL CHECK (length(external_subject) BETWEEN 1 AND 512),
  email text NOT NULL CHECK (length(email) BETWEEN 3 AND 320),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (issuer, external_subject)
);

CREATE TABLE operations (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 512),
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 512),
  principal_id text NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
  client_id text CHECK (client_id IS NULL OR length(client_id) BETWEEN 1 AND 512),
  operation_type text NOT NULL CHECK (
    operation_type IN (
      'search_brain',
      'fetch_record',
      'persist_knowledge',
      'update_record',
      'append_to_record',
      'delete_record',
      'list_approvals',
      'resolve_approval'
    )
  ),
  state text NOT NULL CHECK (
    state IN (
      'RECEIVED',
      'AUTHORIZATION_REQUIRED',
      'APPROVAL_PENDING',
      'ELEVATION_PENDING',
      'EXECUTING',
      'COMPLETED',
      'FAILED',
      'OUTCOME_UNKNOWN',
      'CANCELLED',
      'SUPERSEDED'
    )
  ),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  semantic_metadata jsonb CHECK (
    semantic_metadata IS NULL OR jsonb_typeof(semantic_metadata) = 'object'
  ),
  mutation_payload jsonb CHECK (
    mutation_payload IS NULL OR jsonb_typeof(mutation_payload) = 'object'
  ),
  target_brain_record_id text CHECK (
    target_brain_record_id IS NULL OR length(target_brain_record_id) BETWEEN 1 AND 512
  ),
  provider text CHECK (provider IS NULL OR provider IN ('notion', 'drive', 'github')),
  provider_record_id text CHECK (
    provider_record_id IS NULL OR length(provider_record_id) BETWEEN 1 AND 512
  ),
  provider_version text CHECK (
    provider_version IS NULL OR length(provider_version) BETWEEN 1 AND 1024
  ),
  result_metadata jsonb CHECK (
    result_metadata IS NULL OR jsonb_typeof(result_metadata) = 'object'
  ),
  error_code text CHECK (
    error_code IS NULL OR error_code IN (
      'unauthenticated',
      'unauthorized',
      'insufficient_metadata',
      'routing_ambiguous',
      'not_found',
      'provider_unavailable',
      'partial_results',
      'approval_required',
      'elevation_required',
      'protected_record',
      'idempotency_conflict',
      'outcome_unknown',
      'policy_drift',
      'provider_capability_unsupported',
      'environment_boundary_violation',
      'invalid_request',
      'internal_error'
    )
  ),
  policy_version text CHECK (
    policy_version IS NULL OR length(policy_version) BETWEEN 1 AND 256
  ),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (principal_id, operation_type, request_id)
);

CREATE INDEX operations_state_updated_at_idx ON operations (state, updated_at);

CREATE TABLE approval_requests (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 512),
  operation_id text NOT NULL UNIQUE REFERENCES operations(id) ON DELETE RESTRICT,
  family_inbox_record_id text UNIQUE CHECK (
    family_inbox_record_id IS NULL OR length(family_inbox_record_id) BETWEEN 1 AND 512
  ),
  requested_by_principal_id text NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
  status text NOT NULL CHECK (
    status IN ('pending', 'approved', 'declined', 'cancelled', 'superseded', 'impossible')
  ),
  safe_summary jsonb NOT NULL CHECK (jsonb_typeof(safe_summary) = 'object'),
  resolved_by_principal_id text REFERENCES principals(id) ON DELETE RESTRICT,
  resolution_reason text,
  created_at timestamptz NOT NULL,
  resolved_at timestamptz,
  updated_at timestamptz NOT NULL,
  CHECK (
    (status = 'pending' AND resolved_at IS NULL AND resolved_by_principal_id IS NULL)
    OR (status <> 'pending' AND resolved_at IS NOT NULL)
  )
);

CREATE INDEX approval_requests_pending_idx
  ON approval_requests (created_at, id)
  WHERE status = 'pending';

CREATE TABLE elevation_challenges (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 512),
  operation_id text NOT NULL REFERENCES operations(id) ON DELETE RESTRICT,
  principal_id text NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
  confirmation_token_hash text NOT NULL UNIQUE CHECK (
    confirmation_token_hash ~ '^[0-9a-f]{64}$'
  ),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  policy_version text NOT NULL CHECK (length(policy_version) BETWEEN 1 AND 256),
  frozen_target_ids jsonb NOT NULL CHECK (
    jsonb_typeof(frozen_target_ids) = 'array'
    AND jsonb_array_length(frozen_target_ids) > 0
  ),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CHECK (expires_at > created_at),
  CHECK (
    consumed_at IS NULL OR consumed_at BETWEEN created_at AND expires_at
  )
);

CREATE INDEX elevation_challenges_operation_idx
  ON elevation_challenges (operation_id, created_at DESC);

CREATE TABLE brain_record_aliases (
  brain_record_id text PRIMARY KEY CHECK (length(brain_record_id) BETWEEN 1 AND 512),
  provider text NOT NULL CHECK (provider IN ('notion', 'drive', 'github')),
  provider_record_id text NOT NULL CHECK (length(provider_record_id) BETWEEN 1 AND 512),
  canonical_location jsonb NOT NULL CHECK (jsonb_typeof(canonical_location) = 'object'),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (provider, provider_record_id)
);

CREATE TABLE policy_versions (
  kind text NOT NULL CHECK (kind IN ('canonical_governance', 'executable_policy')),
  version text NOT NULL CHECK (length(version) BETWEEN 1 AND 256),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  source_reference text NOT NULL CHECK (length(source_reference) BETWEEN 1 AND 2048),
  canonical_marker text NOT NULL CHECK (length(canonical_marker) BETWEEN 1 AND 1024),
  activated_at timestamptz NOT NULL,
  PRIMARY KEY (kind, version)
);

CREATE INDEX policy_versions_active_idx
  ON policy_versions (kind, activated_at DESC, version DESC);

CREATE TABLE project_registry_versions (
  version text PRIMARY KEY CHECK (length(version) BETWEEN 1 AND 256),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  source_reference text NOT NULL CHECK (length(source_reference) BETWEEN 1 AND 2048),
  canonical_marker text NOT NULL CHECK (length(canonical_marker) BETWEEN 1 AND 1024),
  activated_at timestamptz NOT NULL
);

CREATE INDEX project_registry_versions_active_idx
  ON project_registry_versions (activated_at DESC, version DESC);

CREATE TABLE reconciliation_attempts (
  operation_id text NOT NULL REFERENCES operations(id) ON DELETE RESTRICT,
  attempt integer NOT NULL CHECK (attempt > 0),
  outcome text NOT NULL CHECK (outcome IN ('completed', 'not_found', 'inconclusive', 'failed')),
  safe_metadata jsonb CHECK (
    safe_metadata IS NULL OR jsonb_typeof(safe_metadata) = 'object'
  ),
  attempted_at timestamptz NOT NULL,
  PRIMARY KEY (operation_id, attempt)
);

CREATE TABLE audit_outbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event jsonb NOT NULL CHECK (jsonb_typeof(event) = 'object'),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  last_error_code text CHECK (
    last_error_code IS NULL OR length(last_error_code) BETWEEN 1 AND 256
  ),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_outbox_pending_idx
  ON audit_outbox (available_at, id)
  WHERE delivered_at IS NULL;

COMMENT ON TABLE operations IS
  'Minimum gateway execution state only; this table is not a Family Brain content mirror.';
COMMENT ON COLUMN operations.mutation_payload IS
  'Minimum payload required for idempotent pending execution; minimize and encrypt at rest.';
COMMENT ON TABLE audit_outbox IS
  'Metadata-only normalized audit events awaiting delivery.';
