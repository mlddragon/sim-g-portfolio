import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { code, containerInvocations } from './shell.js';

const repository = join(import.meta.dirname, '..', '..');
const host = join(repository, 'deploy', 'vm', 'host');
const units = join(host, 'systemd');
const scripts = join(host, 'bin');
const backupScript = join(
  repository,
  'deploy',
  'vm',
  'backup',
  'sim-g-backup.sh',
);

const list = (directory: string) =>
  existsSync(directory) ? readdirSync(directory).sort() : [];
const read = (path: string) => readFileSync(path, 'utf8');
const hostScripts = () => [
  ...list(scripts).map((name) => join(scripts, name)),
  backupScript,
];

const containerUnits: Readonly<Record<string, string>> = {
  'sim-g-deploy-watch.service': 'sim-g-deploy-watch.sh',
  'sim-g-postgres.service': 'sim-g-postgres.sh',
  'sim-g-gateway.service': 'sim-g-gateway.sh',
  'sim-g-migrate.service': 'sim-g-migrate.sh',
  'sim-g-backup.service': 'sim-g-backup.sh',
  'sim-g-backup-recent.service': 'sim-g-backup.sh recent',
  'sim-g-edge.service': 'sim-g-edge.sh',
  'sim-g-certificate.service': 'sim-g-certificate.sh',
};
const edge = join(repository, 'deploy', 'vm', 'edge');

describe('e2-micro VM host layer boundaries', () => {
  it('ships the reviewed units and scripts', () => {
    expect(list(units)).toEqual([
      'sim-g-backup-recent.service',
      'sim-g-backup-recent.timer',
      'sim-g-backup-stale.service',
      'sim-g-backup-stale.timer',
      'sim-g-backup.service',
      'sim-g-backup.timer',
      'sim-g-certificate.service',
      'sim-g-certificate.timer',
      'sim-g-data-disk.service',
      'sim-g-deploy-watch.service',
      'sim-g-deploy-watch.timer',
      'sim-g-edge.service',
      'sim-g-firewall.service',
      'sim-g-gateway.service',
      'sim-g-log-ship.service',
      'sim-g-log-ship.timer',
      'sim-g-migrate.service',
      'sim-g-networks.service',
      'sim-g-postgres.service',
      'sim-g-recover.service',
      'sim-g-recover.timer',
      'sim-g.target',
    ]);
    expect(list(scripts)).toEqual([
      'sim-g-backup-stale.sh',
      'sim-g-certificate.sh',
      'sim-g-data-disk.sh',
      'sim-g-deploy-watch.sh',
      'sim-g-edge.sh',
      'sim-g-firewall.sh',
      'sim-g-gateway.sh',
      'sim-g-host-env.sh',
      'sim-g-log-ship.sh',
      'sim-g-migrate.sh',
      'sim-g-networks.sh',
      'sim-g-postgres-ready.sh',
      'sim-g-postgres.sh',
      'sim-g-recover.sh',
    ]);
  });

  it('starts no container before the metadata rules, nor with unvalidated settings', () => {
    for (const [unit, script] of Object.entries(containerUnits)) {
      const text = read(join(units, unit));
      expect(text, unit).toMatch(/^Requires=.*\bsim-g-firewall\.service\b/mu);
      expect(text, unit).toMatch(/^After=.*\bsim-g-firewall\.service\b/mu);
      expect(text, unit).toContain(
        `ExecStart=/bin/bash /etc/sim-g/bin/sim-g-host-env.sh /etc/sim-g/bin/${script}\n`,
      );
    }
    for (const name of list(units)) {
      expect(read(join(units, name)), name).not.toMatch(
        /^(EnvironmentFile|Environment|PassEnvironment)=/mu,
      );
    }
  });

  it('runs every container read-only, unprivileged, bounded and without new privileges', () => {
    const invocations = hostScripts().flatMap((path) =>
      containerInvocations(read(path)).map((invocation) => ({
        path,
        invocation,
      })),
    );
    // postgres, gateway, migrations, grants, dump, encryption, nginx and
    // certbot.
    expect(invocations).toHaveLength(8);
    for (const { path, invocation } of invocations) {
      expect(invocation, path).toContain('--read-only');
      expect(invocation, path).toContain('--cap-drop=ALL');
      expect(invocation, path).toContain('--security-opt=no-new-privileges');
      expect(invocation, path).toMatch(/--user (70|101|1000|9001|9002):\1\b/u);
      expect(invocation, path).toMatch(/--memory \d+m --memory-swap \d+m/u);
      expect(invocation, path).toMatch(/--pids-limit \d+/u);
      expect(invocation, path).toMatch(
        /"\$\{SIM_G_(GATEWAY|POSTGRES|EDGE|CERTBOT)_IMAGE\}"/u,
      );
      expect(invocation.match(/--network[= ]/gu) ?? [], path).toHaveLength(1);
      expect(invocation, path).not.toMatch(
        /--privileged|--network[= ]host|--pid[= ]host|--ipc[= ]host|--cap-add|docker\.sock|seccomp=unconfined/u,
      );
      // Only nginx publishes ports: exactly 443 and 80.
      const published = invocation.match(/(?:^|\s)(?:-p|--publish)[\s=]\S+/gu);
      if (path.endsWith('sim-g-edge.sh')) {
        expect(published?.map((flag) => flag.trim())).toEqual([
          '--publish 443:8443',
          '--publish 80:8080',
        ]);
      } else {
        expect(published, path).toBeNull();
      }
    }
  });

  it('starts no long-running container during operator maintenance', () => {
    for (const name of [
      'sim-g-postgres.sh',
      'sim-g-gateway.sh',
      'sim-g-recover.sh',
    ]) {
      expect(code(read(join(scripts, name))), name).toContain(
        '/run/sim-g/maintenance',
      );
    }
    expect(read(join(units, 'sim-g-postgres.service'))).toContain(
      'ExecStartPost=/bin/bash /etc/sim-g/bin/sim-g-postgres-ready.sh\n',
    );
  });

  it('keeps PostgreSQL and the job containers off every network', () => {
    for (const path of [
      join(scripts, 'sim-g-postgres.sh'),
      join(scripts, 'sim-g-migrate.sh'),
      backupScript,
    ]) {
      for (const invocation of containerInvocations(read(path))) {
        expect(invocation, path).toContain('--network none');
      }
    }
    expect(code(read(join(scripts, 'sim-g-postgres.sh')))).toMatch(
      /listen_addresses=(\s|"|$)/u,
    );
  });

  it('requires the local database socket for the gateway on the VM', () => {
    // Owner decision 2026-10-27 (Option A): the VM deployment is socket-only,
    // so the gateway refuses any TCP database URL there.
    const [gateway] = containerInvocations(
      read(join(scripts, 'sim-g-gateway.sh')),
    );
    expect(gateway).toContain('--env GATEWAY_DATABASE_TRANSPORT=unix_socket');
    // Docker keeps the last value, so nothing may set it again or load an
    // environment file, and no PG* variable may sit behind the URL.
    expect(gateway?.match(/GATEWAY_DATABASE_TRANSPORT/gu)).toHaveLength(1);
    expect(gateway).not.toMatch(/--env-file|\s-e\s|--env\s+PG/u);
    expect(gateway).toContain('--volume "${socket}:/run/postgresql:ro"');
    expect(code(read(join(scripts, 'sim-g-gateway.sh')))).toContain(
      'socket=/run/sim-g/postgresql',
    );
  });

  it('bounds the long-running containers as designed', () => {
    for (const [name, memory] of [
      ['sim-g-postgres.sh', '256m'],
      ['sim-g-gateway.sh', '384m'],
    ] as const) {
      const [invocation] = containerInvocations(read(join(scripts, name)));
      expect(invocation, name).toContain(
        `--memory ${memory} --memory-swap ${memory}`,
      );
      expect(invocation, name).toContain('--log-opt max-size=10m');
    }
    // The server keeps a log, but never row values: no DETAIL or CONTEXT
    // lines, and no failing statements with their literals.
    const [postgres] = containerInvocations(
      read(join(scripts, 'sim-g-postgres.sh')),
    );
    expect(postgres).toContain('-c log_error_verbosity=terse');
    expect(postgres).toContain('-c log_min_error_statement=panic');
  });

  it('takes images only from this project, pinned by digest', () => {
    const settings = code(read(join(scripts, 'sim-g-host-env.sh')));
    expect(settings).toContain(
      '-docker\\\\.pkg\\\\.dev)/${project}/[a-z0-9._/-]+@sha256:[0-9a-f]{64}',
    );
    expect(settings).toContain('"${project}-sim-g-backups"');
    expect(settings).toMatch(/^exec \/bin\/bash "\$@"$/mu);
  });

  it('formats the data disk only when it has no signature and reads as zeros', () => {
    const text = code(read(join(scripts, 'sim-g-data-disk.sh')));
    expect(text.match(/mkfs\./gu)).toHaveLength(1);
    expect(text).toMatch(/blkid -p/u);
    expect(text).toMatch(
      /blank_disk "\$\{device\}" \|\| fail data_disk_not_blank/u,
    );
    expect(text).toMatch(/cmp -s -n .* - \/dev\/zero/u);
    expect(text).not.toMatch(/wipefs|--force|\s-F\b|dd if=\/dev\/zero/u);
  });

  it('lets only the gateway bridge and subnet reach the metadata server', () => {
    const text = code(read(join(scripts, 'sim-g-firewall.sh')));
    expect(text).toContain('"! -i sim-g-gw0 -j DROP"');
    expect(text).toContain('"! -s 172.31.250.16/28 -j DROP"');
    expect(text).toContain(
      'metadata_jump=(DOCKER-USER -d 169.254.169.254/32 -j SIM-G-METADATA)',
    );
    expect(text).toContain('ensure_jump 1 "${metadata_jump[@]}"');
    // nginx and certbot share the edge bridge, which is not the gateway's.
    for (const name of ['sim-g-edge.sh', 'sim-g-certificate.sh']) {
      const [invocation] = containerInvocations(read(join(scripts, name)));
      expect(invocation, name).toContain('--network sim-g-edge-egress');
    }
    expect(code(read(join(scripts, 'sim-g-networks.sh')))).toContain(
      'ensure sim-g-gateway-egress 172.31.250.16/28 false sim-g-gw0',
    );
  });

  it('limits requests and connections before the gateway', () => {
    const nginx = read(join(edge, 'nginx.conf'));
    const site = read(join(edge, 'site.conf'));
    // Every request zone is keyed on the TCP peer or the server, never a
    // header a client controls.
    const zones = [...nginx.matchAll(/^\s*limit_req_zone\s+(\S+)\s/gmu)].map(
      (match) => match[1],
    );
    expect(zones).toEqual([
      '$binary_remote_addr',
      '$server_name',
      '$binary_remote_addr',
    ]);
    expect(nginx).toContain(
      'limit_conn_zone $binary_remote_addr zone=conn_per_ip:2m;',
    );
    expect(nginx).not.toMatch(/\$http_|\$proxy_add_x_forwarded_for|real_ip/u);
    // X-Forwarded-For is replaced with the peer; the rest are cleared.
    expect(nginx).toContain('proxy_set_header X-Forwarded-For $remote_addr;');
    for (const header of [
      'X-Forwarded-Host',
      'X-Forwarded-Port',
      'X-Real-IP',
      'Forwarded',
    ]) {
      expect(nginx).toContain(`proxy_set_header ${header} "";`);
    }
    // The gateway is served only on 443, behind both request limits.
    expect(nginx).not.toMatch(/proxy_pass/u);
    expect(site.match(/proxy_pass http:\/\/gateway;/gu)).toHaveLength(3);
    // Every proxied location applies the shared cap.
    expect(
      site.match(/limit_req zone=all_clients burst=60 nodelay;/gu),
    ).toHaveLength(3);
    // Only the content mutations accept 2 MiB, streamed.
    expect(site.match(/client_max_body_size 2m;/gu)).toHaveLength(1);
    expect(site).toContain(
      'location ~ ^/v1/operations/(persist_knowledge|update_record|append_to_record)$ {',
    );
    expect(nginx).toContain('client_max_body_size 64k;');
    expect(nginx).toContain('error_page 429 = @rate_limited;');
    expect(site).toContain('limit_req zone=per_ip burst=30 nodelay;');
    expect(site).toContain('limit_req zone=all_clients burst=60 nodelay;');
    expect(site).toContain('limit_req zone=health_per_ip burst=10 nodelay;');
    expect(nginx).toContain('ssl_reject_handshake on;\n    return 444;');
    // Port 80 answers only certificate validation and the redirect.
    expect(nginx).toContain('return 301 https://@DOMAIN@$request_uri;');
    // The firewall bounds new and open connections per source to nginx.
    const firewall = code(read(join(scripts, 'sim-g-firewall.sh')));
    expect(firewall).toContain('--hashlimit-mode srcip');
    expect(firewall).toContain('--connlimit-above 32 --connlimit-mask 32');
    expect(firewall).toContain(
      'ingress_jump=(DOCKER-USER -d 172.31.250.32/28 -p tcp -m multiport --dports 8080,8443 -j SIM-G-INGRESS)',
    );
    // Both containers on the internal bridge have fixed, distinct addresses,
    // so nginx can never take the gateway's (its upstream).
    expect(code(read(join(scripts, 'sim-g-gateway.sh')))).toContain(
      'docker network connect --ip 172.31.250.2 sim-g-internal sim-g-gateway',
    );
    expect(code(read(join(scripts, 'sim-g-edge.sh')))).toContain(
      'docker network connect --ip 172.31.250.3 sim-g-internal sim-g-edge',
    );
    expect(code(read(join(scripts, 'sim-g-edge.sh')))).toContain(
      'upstream=172.31.250.2:8080',
    );
    // The gateway trusts exactly that one proxy.
    const [gateway] = containerInvocations(
      read(join(scripts, 'sim-g-gateway.sh')),
    );
    expect(gateway).toContain('--env GATEWAY_TRUSTED_PROXY_HOPS=1');
  });

  it('deploys only a bare digest of the running repository, migrated before it runs', () => {
    const text = code(read(join(scripts, 'sim-g-deploy-watch.sh')));
    expect(text).toContain(
      '[[ "${pointer}" =~ ^sha256:[0-9a-f]{64}$ ]] || fail deploy_pointer_malformed',
    );
    expect(text).toContain('target="${repository}@${pointer}"');
    expect(text).toContain('repository="${current%@*}"');
    // The token reaches curl on stdin only.
    expect(text).toContain('curl -s --max-time 10 --config -');
    expect(text).not.toMatch(/(-H|--header)\s*=?\s*["']?Authorization/iu);
    const migrate = text.indexOf(
      'SIM_G_GATEWAY_IMAGE="${target}" bash /etc/sim-g/bin/sim-g-migrate.sh',
    );
    const record = text.lastIndexOf('set_image "${target}"');
    expect(migrate).toBeGreaterThan(0);
    expect(record).toBeGreaterThan(migrate);
    const marker = text.indexOf('replace "${pending}"');
    expect(marker).toBeGreaterThan(-1);
    expect(marker).toBeLessThan(record);
    expect(text).toContain('/run/sim-g/maintenance');
    // Pruning touches only this repository, never the new or previous image,
    // and only once the deploy is complete.
    expect(text).toContain(
      '[[ "${image%@*}" == "${repository}" && "${image}" != "$1" && "${image}" != "$2" ]] || continue',
    );
    const finishing = text.slice(text.indexOf('finish() {'));
    expect(finishing.indexOf('prune "$1" "$2"')).toBeGreaterThan(
      finishing.indexOf('if healthy "$2"; then'),
    );
    expect(finishing.indexOf('prune "$1" "$2"')).toBeGreaterThan(
      finishing.indexOf('rm -f "${pending}"'),
    );
    expect(code(read(join(scripts, 'sim-g-migrate.sh')))).toContain(
      'flock -n 9 || fail migrate_busy 4',
    );
  });

  it('runs the recent backup tier every 15 minutes, bounded, as the daily one', () => {
    const service = read(join(units, 'sim-g-backup-recent.service'));
    expect(service).toMatch(/^Requisite=sim-g-postgres\.service$/mu);
    expect(service).toMatch(/^After=.*\bsim-g-postgres\.service\b/mu);
    expect(service).toMatch(/^Requires=.*\bdocker\.service\b/mu);
    expect(service).toMatch(/^Type=oneshot$/mu);
    expect(service).toMatch(/^TimeoutStartSec=5min$/mu);
    const timer = read(join(units, 'sim-g-backup-recent.timer'));
    expect(timer).toMatch(/^OnCalendar=\*:00\/15$/mu);
    expect(timer).toMatch(/^AccuracySec=1s$/mu);
    expect(timer).toMatch(/^Persistent=false$/mu);
    expect(timer).not.toMatch(/RandomizedDelaySec/u);
    expect(read(join(units, 'sim-g.target'))).toMatch(
      /^Wants=.*\bsim-g-backup-recent\.timer\b/mu,
    );
    expect(code(read(join(scripts, 'sim-g-recover.sh')))).toMatch(
      /systemctl start --no-block .*\bsim-g-backup-recent\.timer\b/u,
    );
    // The daily unit, which migrations start, is unchanged.
    expect(read(join(units, 'sim-g-backup.service'))).toContain(
      'ExecStart=/bin/bash /etc/sim-g/bin/sim-g-host-env.sh /etc/sim-g/bin/sim-g-backup.sh\n',
    );
  });

  it('reports a stale recent backup after two missed runs, even in maintenance', () => {
    const script = code(read(join(scripts, 'sim-g-backup-stale.sh')));
    // 35 minutes, both for staleness and for the quiet period after boot.
    expect(script).toMatch(/^threshold=2100$/mu);
    expect(script).toMatch(/^grace=2100$/mu);
    expect(script).toContain('/var/lib/sim-g/backup-recent.last');
    expect(script).toContain('"backup_stale"');
    // A forgotten maintenance file must never silence it.
    expect(script).not.toMatch(/maintenance/u);
    expect(containerInvocations(script)).toEqual([]);
    const timer = read(join(units, 'sim-g-backup-stale.timer'));
    expect(timer).toMatch(/^OnCalendar=\*:07\/15$/mu);
    expect(timer).toMatch(/^AccuracySec=1s$/mu);
    expect(timer).toMatch(/^Persistent=false$/mu);
    expect(read(join(units, 'sim-g-backup-stale.service'))).toContain(
      'ExecStart=/bin/bash /etc/sim-g/bin/sim-g-backup-stale.sh\n',
    );
    expect(read(join(units, 'sim-g.target'))).toMatch(
      /^Wants=.*\bsim-g-backup-stale\.timer\b/mu,
    );
    expect(code(read(join(scripts, 'sim-g-recover.sh')))).toMatch(
      /systemctl start --no-block .*\bsim-g-backup-stale\.timer\b/u,
    );
  });

  it('has no in-place update reboot timer (COS replacement instead)', () => {
    // Owner decision 2026-10-30: COS cannot update in place with Secure
    // Boot, so patching replaces the VM; the timer was removed once the
    // replacement was rehearsed.
    expect(
      list(units).filter((name) => name.startsWith('sim-g-reboot')),
    ).toEqual([]);
    expect(read(join(units, 'sim-g.target'))).not.toContain('sim-g-reboot');
  });

  it("ships the host units' structured lines that COS leaves behind, once", () => {
    // F13d Stage A: COS's agent ships the journal only at priority warning
    // or worse, and the host scripts print JSON at priority info.
    const script = code(read(join(scripts, 'sim-g-log-ship.sh')));
    expect(script).toContain('--priority=5..7');
    expect(script).toContain("--unit='sim-g-*.service'");
    expect(script).toContain('https://logging.googleapis.com/v2/entries:write');
    expect(script).toContain('"type":"gce_instance"');
    // The token reaches curl on stdin only, and the shipper's own failures
    // are journal priority err, which COS's agent ships (not re-read here).
    expect(script).toMatch(/--config -/u);
    expect(script).not.toMatch(
      /Authorization: Bearer \$\{?token\}?"[^\n]*\bcurl\b/u,
    );
    expect(script).toContain(
      'printf \'<3>{"severity":"ERROR","msg":"log_ship_failed"',
    );
    expect(containerInvocations(script)).toEqual([]);
    expect(read(join(units, 'sim-g-log-ship.service'))).toContain(
      'ExecStart=/bin/bash /etc/sim-g/bin/sim-g-log-ship.sh\n',
    );
    expect(read(join(units, 'sim-g-log-ship.service'))).toMatch(
      /^TimeoutStartSec=\d+s$/mu,
    );
    const timer = read(join(units, 'sim-g-log-ship.timer'));
    expect(timer).toMatch(/^OnCalendar=\*:\*:30$/mu);
    expect(timer).toMatch(/^Persistent=false$/mu);
    expect(read(join(units, 'sim-g.target'))).toMatch(
      /^Wants=.*\bsim-g-log-ship\.timer\b/mu,
    );
    expect(code(read(join(scripts, 'sim-g-recover.sh')))).toMatch(
      /systemctl start --no-block .*\bsim-g-log-ship\.timer\b/u,
    );
    // The gateway's own lines (stdout and stderr) reach Cloud Logging
    // through json-file only; copied into the journal they would ship twice.
    expect(code(read(join(scripts, 'sim-g-gateway.sh')))).toMatch(
      /^exec docker start --attach sim-g-gateway >\/dev\/null 2>&1$/mu,
    );
  });

  it('stops retrying a gateway without its configuration every 5 seconds, not every 5 minutes', () => {
    // A missing gateway.json cannot fix itself in 5 seconds; the recovery
    // timer still starts the gateway every 5 minutes, so it still pages.
    const unit = read(join(units, 'sim-g-gateway.service'));
    expect(unit).toMatch(/^Restart=always$/mu);
    expect(unit).toMatch(/^RestartPreventExitStatus=3$/mu);
    expect(code(read(join(scripts, 'sim-g-gateway.sh')))).toMatch(
      /\|\| fail gateway_config_missing 3$/mu,
    );
    expect(code(read(join(scripts, 'sim-g-recover.sh')))).toMatch(
      /systemctl start --no-block .*\bsim-g-gateway\.service\b/u,
    );
  });

  it('lets PostgreSQL pull its image on a new boot disk before readiness counts', () => {
    // COS replacement rehearsal (2026-10-30): the pull took 160 s.
    const unit = read(join(units, 'sim-g-postgres.service'));
    const timeout = /^TimeoutStartSec=(\d+)min$/mu.exec(unit);
    expect(Number(timeout?.[1] ?? 0)).toBeGreaterThanOrEqual(12);
    expect(code(read(join(scripts, 'sim-g-postgres-ready.sh')))).toContain(
      'docker container inspect sim-g-postgres',
    );
  });

  it('carries no secret into the host layer', () => {
    for (const directory of [units, scripts]) {
      for (const name of list(directory)) {
        const text = read(join(directory, name));
        expect(text, name).not.toMatch(
          /POSTGRES_PASSWORD|PRIVATE KEY|AGE-SECRET-KEY|BEGIN [A-Z ]*KEY/u,
        );
        expect(text, name).not.toMatch(/:\/\/[^@\s/]+:[^@\s/]+@/u);
      }
    }
  });
});
