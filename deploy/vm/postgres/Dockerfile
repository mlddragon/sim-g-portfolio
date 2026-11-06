# SIM-G PostgreSQL image for the e2-micro VM (design sections 6 and 8): the
# pinned upstream image plus `age` for backup encryption and the two job
# users that peer authentication maps to database roles. Built and scanned in
# CI, promoted by digest like the gateway image.
FROM postgres:17.11-alpine@sha256:eee6c6e1b0894fa4fe0075eb054af9fd1cf39a35321c2d4110626cfe506411fb
# The server always starts as postgres (uid 70), so the entrypoint never needs
# gosu to drop privileges; removing it also removes its outdated Go runtime.
RUN rm -f /usr/local/bin/gosu \
  && apk add --no-cache age=1.3.2-r1 \
  && addgroup -S -g 9001 sim_g_backup \
  && adduser -S -D -H -u 9001 -G sim_g_backup sim_g_backup \
  && addgroup -S -g 9002 sim_g_migrator \
  && adduser -S -D -H -u 9002 -G sim_g_migrator sim_g_migrator
COPY pg_hba.conf pg_ident.conf grant-runtime.sql bootstrap-roles.sql /etc/sim-g/
# Safe by default, without relying on run-time flags: initdb never writes a
# trust rule, and the server has no TCP listener and uses the shipped rules.
ENV POSTGRES_INITDB_ARGS="--auth-local=peer --auth-host=reject"
CMD ["postgres", "-c", "listen_addresses=", "-c", "hba_file=/etc/sim-g/pg_hba.conf", "-c", "ident_file=/etc/sim-g/pg_ident.conf"]
# A no-role default user: a container started without --user cannot peer as
# the superuser. The server runs with --user 70:70; jobs pass 9001 or 9002.
USER 65534:65534
