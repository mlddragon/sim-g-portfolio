ALTER TABLE brain_record_aliases
  ADD COLUMN creator_principal_id text REFERENCES principals(id) ON DELETE RESTRICT;

COMMENT ON COLUMN brain_record_aliases.creator_principal_id IS
  'Authenticated principal that created the record through the gateway; NULL for records discovered by retrieval. Never client input.';
