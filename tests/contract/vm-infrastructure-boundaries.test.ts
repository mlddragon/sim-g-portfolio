import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { telemetryMetricNames } from '../../src/ports/telemetry-sink.js';

const repository = join(import.meta.dirname, '..', '..');
const infrastructure = join(repository, 'infra', 'google');

function files(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === '.terraform' ? [] : files(path);
    }
    return [path];
  });
}

/**
 * Removes `#`, `//` and `/* *\/` comments outside strings, so prose never
 * hides or fakes a match. (The configuration uses no heredocs.)
 */
function withoutComments(text: string): string {
  let output = '';
  let index = 0;
  let inString = false;
  while (index < text.length) {
    const character = text[index] ?? '';
    const next = text[index + 1] ?? '';
    if (inString) {
      output += character;
      if (character === '\\') {
        output += next;
        index += 2;
        continue;
      }
      if (character === '"') inString = false;
      index += 1;
      continue;
    }
    if (character === '"') {
      inString = true;
      output += character;
      index += 1;
    } else if (character === '#' || (character === '/' && next === '/')) {
      while (index < text.length && text[index] !== '\n') index += 1;
    } else if (character === '/' && next === '*') {
      const end = text.indexOf('*/', index + 2);
      index = end === -1 ? text.length : end + 2;
    } else {
      output += character;
      index += 1;
    }
  }
  return output;
}

/** The body of the block whose opening brace ends at `start`. */
function bodyFrom(text: string, start: number): string {
  let depth = 1;
  let index = start;
  while (depth > 0 && index < text.length) {
    if (text[index] === '{') depth += 1;
    if (text[index] === '}') depth -= 1;
    index += 1;
  }
  return text.slice(start, index - 1);
}

interface Block {
  readonly type: string;
  readonly name: string;
  readonly body: string;
}

function resources(text: string): Block[] {
  const header = /^\s*resource\s+"([^"]+)"\s+"([^"]+)"\s*\{/gmu;
  return [...text.matchAll(header)].map((match) => ({
    type: match[1] ?? '',
    name: match[2] ?? '',
    body: bodyFrom(text, match.index + match[0].length),
  }));
}

/** Nested blocks such as `allow { ... }` inside a resource body. */
function nested(body: string, name: string): string[] {
  const header = new RegExp(`(^|\\n)\\s*${name}\\s*\\{`, 'gu');
  return [...body.matchAll(header)].map((match) =>
    bodyFrom(body, match.index + match[0].length),
  );
}

const paths = files(infrastructure);
const sources = paths
  .filter((path) => path.endsWith('.tf'))
  .map((path) => withoutComments(readFileSync(path, 'utf8')));
const all = sources.join('\n');
const blocks = resources(all);
const ofType = (type: string) => blocks.filter((block) => block.type === type);
const one = (type: string) => {
  const found = ofType(type);
  expect(found, type).toHaveLength(1);
  return found[0]?.body ?? '';
};
const iapRange = '35.235.240.0/20';
/** The bodies of IAM members that grant `role`. */
const iamGrants = (role: string) =>
  blocks
    .filter(({ type }) => type.endsWith('_iam_member'))
    .map(({ body }) => body)
    .filter((body) => body.includes(`"${role}"`));

describe('e2-micro VM infrastructure boundaries', () => {
  it('accepts only the reviewed scanner exception: the public IPv4', () => {
    const ignores = paths
      .filter((path) => path.endsWith('.tf'))
      .flatMap((path) =>
        [...readFileSync(path, 'utf8').matchAll(/trivy:ignore:(\S+)/gu)].map(
          (match) =>
            `${path.slice(infrastructure.length + 1)} ${match[1] ?? ''}`,
        ),
      );
    expect(ignores).toEqual(['modules/vm/compute.tf AVD-GCP-0031']);
  });

  it('reads every resource: no JSON configuration, no unparsed header', () => {
    expect(sources.length).toBeGreaterThan(0);
    expect(paths.filter((path) => path.endsWith('.tf.json'))).toEqual([]);
    expect(blocks.length).toBe([...all.matchAll(/^\s*resource\b/gmu)].length);
  });

  it('defines exactly one e2-micro VM and nothing of the retired target', () => {
    const instance = one('google_compute_instance');
    expect(instance).not.toMatch(/^\s*(count|for_each)\s*=/mu);
    expect(instance).toMatch(/machine_type\s*=\s*"e2-micro"/u);
    for (const match of all.matchAll(/machine_type\s*=\s*([^\n]+)/gu)) {
      expect(match[1]?.trim()).toBe('"e2-micro"');
    }
    for (const forbidden of [
      'google_compute_instance_from_template',
      'google_compute_instance_from_machine_image',
      'google_compute_instance_template',
      'google_compute_region_instance_template',
      'google_compute_instance_group_manager',
      'google_compute_region_instance_group_manager',
      'google_sql_database_instance',
      'google_cloud_run_v2_service',
      'google_cloud_run_service',
      'google_compute_router_nat',
      'google_compute_forwarding_rule',
      'google_compute_global_forwarding_rule',
    ]) {
      expect(ofType(forbidden), forbidden).toEqual([]);
    }
    for (const match of all.matchAll(/\btype\s*=\s*"(pd-[a-z-]+)"/gu)) {
      expect(match[1]).toBe('pd-standard');
    }
  });

  it('keeps the VM shielded and free of metadata secrets', () => {
    const body = one('google_compute_instance');
    expect(body).toMatch(/preemptible\s*=\s*false/u);
    expect(body).toMatch(/provisioning_model\s*=\s*"STANDARD"/u);
    for (const flag of [
      'enable_secure_boot',
      'enable_vtpm',
      'enable_integrity_monitoring',
    ]) {
      expect(body, flag).toMatch(new RegExp(`${flag}\\s*=\\s*true`, 'u'));
    }
    expect(body).toMatch(/enable-oslogin\s*=\s*"TRUE"/u);
    expect(body).toMatch(/block-project-ssh-keys\s*=\s*"TRUE"/u);
    expect(body).toMatch(/serial-port-enable\s*=\s*"FALSE"/u);
    // cloud-init user-data arrives in a later slice; secrets never do.
    expect(body).not.toMatch(/startup.script|password|token|secret/iu);
    expect(ofType('google_compute_project_metadata')).toEqual([]);
    expect(ofType('google_compute_project_metadata_item')).toEqual([]);
  });

  it('protects production from destruction and lets development be torn down', () => {
    expect(all).toMatch(
      /production\s*=\s*var\.environment\s*==\s*"production"/u,
    );
    expect(all).toMatch(
      /protection\s*=\s*local\.production\s*\?\s*"PREVENT"\s*:\s*"DELETE"/u,
    );
    expect(one('google_compute_instance')).toMatch(
      /deletion_protection\s*=\s*local\.production\b/u,
    );
    for (const type of [
      'google_compute_disk',
      'google_logging_project_bucket_config',
    ]) {
      expect(one(type), type).toMatch(
        /deletion_policy\s*=\s*local\.protection\b/u,
      );
    }
    for (const { name, body } of ofType('google_storage_bucket')) {
      expect(body, name).toMatch(/deletion_policy\s*=\s*local\.protection\b/u);
      expect(body, name).not.toMatch(/force_destroy\s*=\s*true/u);
    }
    const address = one('google_compute_address');
    expect(address).toMatch(/count\s*=\s*local\.production\s*\?\s*1\s*:\s*0/u);
    expect(address).toMatch(/deletion_policy\s*=\s*"PREVENT"/u);
  });

  it('takes every project from the environment-guarded data source', () => {
    expect(all).toMatch(
      /project\s*=\s*data\.google_project\.this\.project_id/u,
    );
    for (const { type, name, body } of blocks) {
      for (const match of body.matchAll(/^\s*project\s*=\s*([^\n]+)/gmu)) {
        expect(match[1]?.trim(), `${type}.${name}`).toBe('local.project');
      }
    }
  });

  it('opens only HTTPS (and optional HTTP) publicly, and SSH only from IAP', () => {
    const firewalls = ofType('google_compute_firewall');
    expect(firewalls.length).toBeGreaterThan(0);
    for (const { name, body } of firewalls) {
      expect(body, name).not.toMatch(/direction\s*=\s*"EGRESS"/u);
      expect(body, name).not.toMatch(/\bdeny\s*\{/u);
      const ranges = /source_ranges\s*=\s*\[([^\]]*)\]/u.exec(body)?.[1];
      expect(ranges, `${name} has literal source ranges`).toBeDefined();
      const listed = (ranges ?? '').split(',').map((value) => value.trim());
      for (const value of listed) {
        expect(value, name).toMatch(/^"[0-9./]+"$/u);
      }
      const allows = nested(body, 'allow');
      expect(allows.length, name).toBeGreaterThan(0);
      const iapOnly = listed.length === 1 && listed[0] === `"${iapRange}"`;
      const port = iapOnly ? '22' : name === 'http' ? '80' : '443';
      expect(iapOnly || ['https', 'http'].includes(name), name).toBe(true);
      for (const allow of allows) {
        expect(allow, name).toMatch(/protocol\s*=\s*"tcp"/u);
        expect(allow, name).toMatch(
          new RegExp(`ports\\s*=\\s*\\["${port}"\\]`, 'u'),
        );
      }
    }
  });

  it('grants no keys, no primitive or public IAM, and only per-resource members', () => {
    expect(ofType('google_service_account_key')).toEqual([]);
    expect(ofType('google_project_default_service_accounts')).toEqual([]);
    expect(all).not.toMatch(/roles\/(owner|editor|viewer)"/u);
    expect(all).not.toMatch(/allUsers|allAuthenticatedUsers/u);
    expect(ofType('google_secret_manager_secret_version')).toEqual([]);
    expect(all).not.toMatch(/data\s+"google_secret_manager_secret_version/u);
    // Additive members only: never a policy or binding that replaces others.
    const iam = blocks.filter(({ type }) =>
      /_iam_(member|binding|policy|audit_config)$/u.test(type),
    );
    expect(iam.filter(({ type }) => !type.endsWith('_iam_member'))).toEqual([]);
    expect([...new Set(iam.map(({ type }) => type))].sort()).toEqual([
      'google_artifact_registry_repository_iam_member',
      'google_compute_instance_iam_member',
      'google_iap_tunnel_instance_iam_member',
      'google_project_iam_member',
      'google_secret_manager_secret_iam_member',
      'google_service_account_iam_member',
      'google_storage_bucket_iam_member',
    ]);
    for (const match of all.matchAll(
      /module\s+"[^"]+"\s*\{[^}]*?source\s*=\s*"([^"]+)"/gu,
    )) {
      expect(match[1]).toMatch(/^\.\.?\//u);
    }
  });

  it("holds exactly one project-level role: the runtime's log writer", () => {
    // Owner decision 2026-10-27: the one approved exception (VM design
    // section 5); Google grants logging.logWriter only at project level.
    const project = one('google_project_iam_member');
    expect(project).toMatch(/role\s*=\s*"roles\/logging\.logWriter"/u);
    expect(project).toMatch(
      /member\s*=\s*"serviceAccount:\$\{google_service_account\.runtime\.email\}"/u,
    );
  });

  it('gives the deployer no way to act as the runtime or change the VM', () => {
    const deployer = blocks.filter(({ body }) =>
      /google_service_account\.deployer\.email/u.test(body),
    );
    expect(deployer.length).toBeGreaterThan(0);
    for (const { type, name, body } of deployer) {
      expect(body, `${type}.${name}`).not.toMatch(
        /roles\/(iam\.serviceAccountUser|iam\.serviceAccountTokenCreator|compute\.|iap\.)/u,
      );
      expect(type, name).toMatch(
        /^google_(artifact_registry_repository|storage_bucket)_iam_member$/u,
      );
    }
    // Only the named human operator may act as the runtime (OS Login on an
    // instance with a service account needs it), and only it may log in.
    for (const role of [
      'roles/iam.serviceAccountUser',
      'roles/compute.osAdminLogin',
      'roles/iap.tunnelResourceAccessor',
    ]) {
      const grants = iamGrants(role);
      expect(grants.length, role).toBe(1);
      expect(grants[0], role).toMatch(
        /member\s*=\s*"user:\$\{var\.operator_email\}"/u,
      );
    }
  });

  it('federates only the exact repository, branch, environment and workflow', () => {
    const provider = one('google_iam_workload_identity_pool_provider');
    for (const clause of [
      'assertion.repository_id == \\"${var.github_repository_id}\\"',
      'assertion.repository == \\"${var.github_repository}\\"',
      'assertion.ref == \\"refs/heads/main\\"',
      'assertion.environment == \\"${local.github_environment}\\"',
      'assertion.job_workflow_ref == \\"${var.github_repository}/.github/workflows/deploy.yml@refs/heads/main\\"',
    ]) {
      expect(provider, clause).toContain(clause);
    }
    // Development also deploys after CI passes on main; production only by hand.
    expect(all).toContain(
      'github_deploy_events = local.production ? ["workflow_dispatch"] : ["workflow_dispatch", "workflow_run"]',
    );
    expect(all).toContain(
      'github_event_clause  = "(${join(" || ", [for event in local.github_deploy_events : "assertion.event_name == \\"${event}\\""])})"',
    );
    expect(provider).toContain('local.github_event_clause,');
    expect(provider).toContain(
      'issuer_uri = "https://token.actions.githubusercontent.com"',
    );
    const federated = iamGrants('roles/iam.workloadIdentityUser');
    expect(federated).toHaveLength(1);
    expect(federated[0]).toMatch(/google_service_account\.deployer\.name/u);
  });

  it('ties the GitHub environment to the Terraform environment', () => {
    // Never a free input: a prod root set to "development" would let the
    // development workflow and its reviewers push to production.
    expect(all).not.toMatch(/variable\s+"github_environment"/u);
    expect(all).toMatch(
      /github_environment\s*=\s*local\.production\s*\?\s*"production"\s*:\s*"development"/u,
    );
    const federated = iamGrants('roles/iam.workloadIdentityUser');
    expect(federated[0]).toContain(
      '/attribute.environment/${local.github_environment}"',
    );
    // The federated principal set holds that one grant and nothing else.
    const viaPrincipalSet = blocks.filter(
      ({ type, body }) =>
        type.endsWith('_iam_member') && body.includes('principalSet://'),
    );
    expect(viaPrincipalSet).toHaveLength(1);
    // Secrets are readable by the runtime only.
    for (const body of iamGrants('roles/secretmanager.secretAccessor')) {
      expect(body).toMatch(
        /member\s*=\s*"serviceAccount:\$\{google_service_account\.runtime\.email\}"/u,
      );
    }
  });

  it('requires OS Login with two-step verification', () => {
    const instance = one('google_compute_instance');
    expect(instance).toMatch(/enable-oslogin\s*=\s*"TRUE"/u);
    expect(instance).toMatch(/enable-oslogin-2fa\s*=\s*"TRUE"/u);
  });

  it('recreates the instance-level grants with the instance (COS replacement)', () => {
    // Deleting an instance deletes its IAM policy; the name is unchanged, so
    // without a trigger Terraform would keep believing the grants exist.
    for (const type of [
      'google_compute_instance_iam_member',
      'google_iap_tunnel_instance_iam_member',
    ]) {
      expect(nested(one(type), 'lifecycle')[0] ?? '', type).toMatch(
        /replace_triggered_by\s*=\s*\[\s*google_compute_instance\.gateway\.id\s*\]/u,
      );
    }
  });

  it('names the recent backup bucket exactly as the VM derives it', () => {
    const recent = ofType('google_storage_bucket').find(
      ({ name }) => name === 'recent_backups',
    );
    expect(recent?.body).toMatch(
      /name\s*=\s*"\$\{var\.project_id\}-sim-g-recent-backups"/u,
    );
    expect(
      readFileSync(
        join(repository, 'deploy', 'vm', 'host', 'bin', 'sim-g-host-env.sh'),
        'utf8',
      ),
    ).toMatch(
      /^export SIM_G_RECENT_BACKUP_BUCKET="\$\{project\}-sim-g-recent-backups"$/mu,
    );
  });

  it('keeps buckets private and the audit trail explicit', () => {
    for (const { name, body } of ofType('google_storage_bucket')) {
      expect(body, name).toMatch(/uniform_bucket_level_access\s*=\s*true/u);
      expect(body, name).toMatch(/public_access_prevention\s*=\s*"enforced"/u);
    }
    expect(one('google_logging_project_bucket_config')).toMatch(
      /retention_days\s*=\s*var\.audit_retention_days/u,
    );
    expect(one('google_logging_project_sink')).toMatch(/family_brain_audit/u);
    for (const metric of telemetryMetricNames) {
      expect(all, metric).toContain(`"${metric}"`);
    }
  });
});
