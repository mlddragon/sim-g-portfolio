import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { containerInvocations } from './shell.js';

// Target-independent deployment artifact boundaries. The Cloud Run/Cloud SQL
// Terraform checks were retired with that topology (2026-10-24 e2-micro
// hosting decision) and are preserved on archive/f13-cloud-run-cloud-sql.
const repository = join(import.meta.dirname, '..', '..');

describe('deployment state and variable files', () => {
  it('can commit no Terraform variable values, plans or state', () => {
    const listed = spawnSync(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard'],
      { cwd: repository, encoding: 'utf8' },
    );
    expect(listed.status).toBe(0);
    const candidates = listed.stdout.split('\n').filter(Boolean);
    expect(candidates.length).toBeGreaterThan(0);
    for (const path of candidates) {
      expect(path).not.toMatch(/\.tfvars(\.json)?$|\.tfstate|\.tfplan$/u);
    }
    const ignored = spawnSync(
      'git',
      ['check-ignore', '--no-index', '--stdin'],
      {
        cwd: repository,
        input:
          'infra/google/dev.tfplan\ninfra/google/x.tfvars\ninfra/google/x.tfvars.json\ninfra/google/terraform.tfstate\n',
        encoding: 'utf8',
      },
    );
    expect(ignored.stdout.trim().split('\n')).toHaveLength(4);
  });
});

describe('container image boundaries', () => {
  const dockerfile = existsSync(join(repository, 'Dockerfile'))
    ? readFileSync(join(repository, 'Dockerfile'), 'utf8')
    : '';
  const ignore = existsSync(join(repository, '.dockerignore'))
    ? readFileSync(join(repository, '.dockerignore'), 'utf8')
    : '';

  it('pins every base image by digest and runs as a non-root user', () => {
    const stages = new Set<string>();
    const bases: string[] = [];
    let parsed = 0;
    for (const match of dockerfile.matchAll(
      /^FROM\s+(\S+)(?:\s+AS\s+(\S+))?\s*$/gimu,
    )) {
      parsed += 1;
      const from = match[1] ?? '';
      // A FROM naming an earlier stage reuses it; anything else is pulled.
      if (!stages.has(from)) bases.push(from);
      if (match[2] !== undefined) stages.add(match[2]);
    }
    // Every FROM line was understood, so none can slip past the digest check.
    expect(parsed).toBe([...dockerfile.matchAll(/^FROM\s/gimu)].length);
    expect(bases.length).toBeGreaterThan(0);
    expect(stages.has('runtime')).toBe(true);
    for (const image of bases) {
      expect(image).toMatch(/@sha256:[0-9a-f]{64}$/u);
    }
    const users = [...dockerfile.matchAll(/^USER\s+(\S+)/gmu)].map(
      (match) => match[1] ?? '',
    );
    expect(users.at(-1)).toMatch(/^[1-9][0-9]*(:[1-9][0-9]*)?$/u);
    expect(dockerfile).toMatch(/^ENV\s+NODE_ENV=production/mu);
    expect(dockerfile).toMatch(/^EXPOSE\s+8080$/mu);
    expect(dockerfile).toMatch(/^CMD\s+\["node",\s*"dist\/cli\.js"\]$/mu);
    expect(dockerfile).toMatch(/--frozen-lockfile/u);
    expect(dockerfile).not.toMatch(/^ADD\s/mu);
  });

  it('keeps local credentials, state and data out of the build context', () => {
    const entries = ignore.split('\n').map((line) => line.trim());
    for (const required of [
      '.git',
      '.env',
      '.env.*',
      'node_modules',
      'dist',
      'coverage',
      '**/.terraform',
      '**/*.tfstate*',
      '**/*.tfvars',
      '**/*.tfvars.json',
      '**/*.log',
      '**/*.key',
      '**/*.pem',
      'secrets',
      '.pnpm-store',
    ]) {
      expect(entries, required).toContain(required);
    }
  });
});

describe('continuous integration for the image', () => {
  const workflow = readFileSync(
    join(repository, '.github', 'workflows', 'ci.yml'),
    'utf8',
  );

  it('runs the container checks and dependency audit with pinned tools', () => {
    expect(workflow).toContain('pnpm audit --prod --audit-level=high');
    expect(workflow).toContain('bash scripts/check-container.sh');
    expect(workflow).toContain('bash scripts/check-backup-roundtrip.sh');
    for (const match of workflow.matchAll(/uses:\s*(\S+)/gu)) {
      expect(match[1]).toMatch(/@[0-9a-f]{40}$/u);
    }
    const script = readFileSync(
      join(repository, 'scripts', 'check-container.sh'),
      'utf8',
    );
    expect(script).toMatch(/aquasec\/trivy:[0-9.]+@sha256:[0-9a-f]{64}/u);
  });

  it('cannot silently skip or soften the container gate', () => {
    // No CI step or job may be allowed to fail or be conditionally skipped.
    expect(workflow).not.toMatch(/continue-on-error/u);
    expect(workflow).not.toMatch(/^\s+if:/mu);
    const script = readFileSync(
      join(repository, 'scripts', 'check-container.sh'),
      'utf8',
    );
    expect(script).toMatch(/^set -euo pipefail$/mu);
    for (const flag of [
      '--read-only',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '--network=none',
    ]) {
      expect(script, flag).toContain(flag);
    }
    expect(script).toMatch(/--exit-code 1/u);
    const scans = [...script.matchAll(/^scan (image|config|fs)\b.*$/gmu)];
    // Both images (gateway and the VM's PostgreSQL derivative), the
    // configuration and the lockfile.
    expect(scans.map((match) => match[1])).toEqual([
      'image',
      'image',
      'config',
      'fs',
    ]);
    for (const [line] of scans) {
      expect(line).toContain('--severity HIGH,CRITICAL');
    }
  });
});

describe('VM database and backup boundaries', () => {
  const read = (...path: string[]) =>
    readFileSync(join(repository, ...path), 'utf8');
  const meaningful = (text: string) =>
    text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'));

  it('allows PostgreSQL connections over the local socket only', () => {
    const rules = meaningful(read('deploy', 'vm', 'postgres', 'pg_hba.conf'));
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) expect(rule).toMatch(/^local\s/u);
    expect(rules).toContainEqual(
      expect.stringMatching(
        /^local\s+family_brain_gateway\s+gateway_runtime\s+scram-sha-256$/u,
      ),
    );
    for (const rule of rules)
      expect(rule).not.toMatch(/\b(trust|password|md5)\b/u);
  });

  it('maps only the two job users to job roles', () => {
    const maps = meaningful(read('deploy', 'vm', 'postgres', 'pg_ident.conf'));
    expect(maps.map((line) => line.split(/\s+/u))).toEqual([
      ['sim_g_jobs', 'sim_g_migrator', 'gateway_migrator'],
      ['sim_g_jobs', 'sim_g_backup', 'gateway_backup'],
    ]);
    const image = read('deploy', 'vm', 'postgres', 'Dockerfile');
    expect(image).toMatch(/^FROM \S+@sha256:[0-9a-f]{64}$/mu);
    expect(image).toMatch(/apk add --no-cache age=[0-9][^\s]*/u);
    expect(image).toMatch(/-u 9001 -G sim_g_backup sim_g_backup/u);
    expect(image).toMatch(/-u 9002 -G sim_g_migrator sim_g_migrator/u);
    // The server starts as postgres; no privilege-drop helper ships.
    expect(image).toMatch(/rm -f \/usr\/local\/bin\/gosu/u);
    // A no-role default user, and safe defaults that need no run-time flags.
    expect(image).toMatch(/^USER 65534:65534$/mu);
    expect(image).toMatch(/--auth-local=peer --auth-host=reject/u);
    expect(image).toMatch(/"listen_addresses="/u);
    expect(image).toMatch(/"hba_file=\/etc\/sim-g\/pg_hba\.conf"/u);
  });

  it('bootstraps least-privilege roles with no password in the file', () => {
    const sql = read('deploy', 'vm', 'postgres', 'bootstrap-roles.sql');
    // No password literal; the only PASSWORD clause discards initdb's.
    expect(sql).not.toMatch(/PASSWORD\s+'/u);
    for (const role of [
      'gateway_migrator',
      'gateway_runtime',
      'gateway_backup',
    ]) {
      expect(sql).toMatch(
        new RegExp(
          `CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;`,
          'u',
        ),
      );
    }
    expect(sql).toMatch(/GRANT pg_read_all_data TO gateway_backup;/u);
    expect(sql).not.toMatch(/GRANT [^;]*CREATE[^;]*TO [^;]*gateway_runtime/u);
    expect(sql).not.toMatch(/ALTER DEFAULT PRIVILEGES/u);
    expect(sql).toMatch(
      /REVOKE ALL ON DATABASE family_brain_gateway FROM PUBLIC;/u,
    );
    expect(sql).toMatch(/ALTER ROLE postgres PASSWORD NULL;/u);
    const grants = read('deploy', 'vm', 'postgres', 'grant-runtime.sql');
    expect(grants).toMatch(
      /GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO gateway_runtime;/u,
    );
    expect(grants).toMatch(
      /REVOKE ALL ON TABLE gateway_schema_migrations FROM gateway_runtime;/u,
    );
    expect(grants).not.toMatch(/\b(DELETE|TRUNCATE)\b[^\n]*gateway_runtime/u);
  });

  it('keeps backups encrypted, offline-keyed, isolated and never overwritten', () => {
    const backup = read('deploy', 'vm', 'backup', 'sim-g-backup.sh');
    const restore = read('deploy', 'vm', 'backup', 'sim-g-restore-check.sh');
    for (const script of [backup, restore]) {
      expect(script).toMatch(/^set -euo pipefail$/mu);
      expect(script).toMatch(/^umask 077$/mu);
      expect(script).not.toMatch(/^\s*set -x/mu);
      expect(script).toContain('--network none');
      expect(script).toMatch(/\(\^sha256:\|@sha256:\)\[0-9a-f\]\{64\}/u);
    }
    expect(backup).toContain('ifGenerationMatch=0');
    expect(backup).toContain('age --encrypt');
    expect(backup).toMatch(/\^age1\[0-9a-z\]\{58\}\$/u);
    expect(backup).toContain('--user 9001:9001');
    // The token goes only into the Authorization header, never to output.
    expect(backup).not.toMatch(/(echo)[^\n]*\$\{token\}/u);
    expect(backup).not.toMatch(/-H "Authorization/u);
    expect(backup).toContain('--config -');
    expect(backup).toContain('fail backup_endpoint_refused');
    expect(backup).toContain('age-encryption.org/v1');
    expect(backup).toMatch(/^unset token$/mu);
    expect(restore).toContain('target=/run/age-identity,readonly');
    expect(restore).toContain('--user 70:70');
  });

  it('never lets a dump or a restore stream reach container logs', () => {
    // Docker's log driver records a container's stdout even when it is piped:
    // a plaintext dump, its ciphertext or restored rows would land on the
    // boot disk and, through the logging agent, in Cloud Logging.
    for (const [script, count] of [
      ['sim-g-backup.sh', 2],
      ['sim-g-restore-check.sh', 4],
    ] as const) {
      const invocations = containerInvocations(
        read('deploy', 'vm', 'backup', script),
      );
      expect(invocations, script).toHaveLength(count);
      for (const invocation of invocations) {
        expect(invocation.match(/--log-driver[= ]\S+/gu), script).toEqual([
          '--log-driver none',
        ]);
      }
    }
  });

  it('validates a restore in isolation, as the migrator, never as the superuser', () => {
    const restore = read('deploy', 'vm', 'backup', 'sim-g-restore-check.sh');
    // The dump's SQL runs only as gateway_migrator (peer, uid 9002).
    const restores = [...restore.matchAll(/pg_restore -h[^\n]*\n[^\n]*/gu)];
    expect(restores).toHaveLength(1);
    expect(restores[0]?.[0]).toContain('-U gateway_migrator');
    expect(restores[0]?.[0]).toContain(
      '--no-owner --no-privileges --exit-on-error',
    );
    expect(restore).not.toMatch(/pg_restore[^\n]*-U postgres/u);
    expect(restore).not.toMatch(/POSTGRES_HOST_AUTH_METHOD|trust/u);
    expect(restore).toContain('--user 9002:9002');
    expect(restore).toContain('--tmpfs /var/lib/postgresql/data');
    // The authoritative catalog inspection and the quarantine contract.
    for (const catalog of [
      'pg_proc',
      'pg_trigger',
      'pg_rewrite',
      'pg_policy',
      'pg_extension',
      'pg_event_trigger',
      'pg_db_role_setting',
    ]) {
      expect(restore, catalog).toContain(catalog);
    }
    // Its own superuser sessions cannot be steered by the restored
    // database: shared catalogs first, then a pinned search_path.
    expect(restore).toContain('pgoptions="-c search_path=pg_catalog,pg_temp');
    expect(restore).toMatch(/pg_db_role_setting\)[^\n]*'setting'/u);
    expect(restore.match(/docker exec "\$1" psql/gu) ?? []).toEqual([]);
    expect(restore).toContain('--log-driver none');
    expect(restore).toContain('cat >/dev/null');
    expect(restore).toMatch(/^ {2}exit 3$/mu);
    expect(restore).toContain('"quarantine":%s');
    // It prints digests and counts, never table contents.
    expect(restore).not.toMatch(
      /SELECT \* FROM (principals|identity_bindings)/u,
    );
  });
});

describe('the development deploy workflow', () => {
  const workflow = readFileSync(
    join(repository, '.github', 'workflows', 'deploy.yml.example'),
    'utf8',
  );
  const script = readFileSync(
    join(repository, 'scripts', 'deploy', 'push-images.sh'),
    'utf8',
  );

  it('runs from main, by hand or after CI passed on a push to main, for the exact commit', () => {
    // A manual dispatch, or CI completing (owner ruling 2026-11-04); federation
    // accepts only these two events, and production only the first.
    expect(workflow).toMatch(
      /^on:\n {2}workflow_dispatch: \{\}\n {2}workflow_run:\n {4}workflows: \[CI\]\n {4}types: \[completed\]\n {4}branches: \[main\]\n\n/mu,
    );
    expect(workflow).not.toMatch(/pull_request|push:|schedule:/u);
    // An automatic run needs CI's own success on a push to main in this
    // repository, never a pull request or a fork's branch named main.
    for (const guard of [
      "github.event_name == 'workflow_dispatch'",
      "github.event.workflow_run.conclusion == 'success'",
      "github.event.workflow_run.event == 'push'",
      "github.event.workflow_run.head_branch == 'main'",
      'github.event.workflow_run.head_repository.full_name == github.repository',
    ]) {
      expect(workflow, guard).toContain(guard);
    }
    // The commit is CI's, not whatever main points to when the run starts.
    expect(workflow).toContain(
      'DEPLOY_SHA: ${{ github.event.workflow_run.head_sha || github.sha }}',
    );
    expect(workflow).toContain('ref: ${{ env.DEPLOY_SHA }}');
    expect(workflow).toContain("if: github.ref != 'refs/heads/main'");
    expect(workflow).toContain('--workflow ci.yml');
    expect(workflow).toContain(
      '--commit "${DEPLOY_SHA}" --branch main --event push',
    );
    expect(workflow).toContain('if [[ "${conclusion}" != success ]]; then');
    // A commit main has moved past is skipped; the newer commit deploys.
    expect(workflow).toContain('if [[ "${tip}" != "${DEPLOY_SHA}" ]]; then');
    expect(workflow).not.toContain('GITHUB_SHA');
    expect(workflow).toMatch(/^ {4}environment: development$/mu);
    expect(workflow).not.toMatch(/production/u);
  });

  it('uses short-lived federation, minimal permissions and pinned actions', () => {
    expect(workflow).toMatch(/^permissions:\n {2}contents: read\n/mu);
    expect(workflow.match(/id-token: write/gu)).toHaveLength(1);
    expect(workflow).not.toMatch(/contents: write|packages: write/u);
    for (const match of workflow.matchAll(/uses:\s*(\S+)/gu)) {
      expect(match[1]).toMatch(/@[0-9a-f]{40}$/u);
    }
    expect(workflow).toContain('token_format: access_token');
    expect(workflow).toContain('create_credentials_file: false');
    expect(workflow).toContain('persist-credentials: false');
    // No key, password or JSON credential anywhere.
    expect(workflow).not.toMatch(/credentials_json|secrets\./u);
  });

  it('pushes by digest to its own project and writes only the pointer', () => {
    expect(script).toContain('[[ "${bucket}" == "${project}-sim-g-deploy" ]]');
    expect(script).toContain('name=family-brain-gateway%2Fgateway.digest');
    expect(script).toContain('[[ "${digest}" =~ ^sha256:[0-9a-f]{64}$ ]]');
    // The token never appears on a command line.
    expect(script).toContain('--password-stdin');
    expect(script).toContain(
      '--config <(printf \'header = "Authorization: Bearer %s"\\n\'',
    );
    expect(script).not.toMatch(/gcloud auth|--password[= ][^s]/u);
    expect(script).toContain('--platform linux/amd64');
  });
});
