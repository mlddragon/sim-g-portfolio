-- Run once by the bootstrap superuser (peer, via docker exec as uid 70) on a
-- new server. The runtime password is set afterwards, out of band, with
-- \password gateway_runtime; it is never written to a file.
CREATE ROLE gateway_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE ROLE gateway_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE ROLE gateway_backup LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
GRANT pg_read_all_data TO gateway_backup;
CREATE DATABASE family_brain_gateway OWNER gateway_migrator;
-- No implicit CONNECT or TEMPORARY for PUBLIC; only the three roles connect.
REVOKE ALL ON DATABASE family_brain_gateway FROM PUBLIC;
GRANT CONNECT ON DATABASE family_brain_gateway TO gateway_migrator, gateway_runtime, gateway_backup;
-- The superuser keeps peer access only; the initdb password is discarded.
ALTER ROLE postgres PASSWORD NULL;
\connect family_brain_gateway
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO gateway_migrator;
GRANT USAGE ON SCHEMA public TO gateway_runtime, gateway_backup;
