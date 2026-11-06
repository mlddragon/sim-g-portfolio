-- Run by the migration job as gateway_migrator (the schema owner) after every
-- migration run, so new tables are covered. Idempotent. The runtime gets only
-- what the gateway uses: no DELETE, TRUNCATE or sequence changes, and nothing
-- on the migration ledger.
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO gateway_runtime;
REVOKE ALL ON TABLE gateway_schema_migrations FROM gateway_runtime;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO gateway_runtime;
