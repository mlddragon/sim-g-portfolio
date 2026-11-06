import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadEnvironmentConfig } from '../../src/runtime/configuration.js';

// The development QA templates (docs/engineering/2026-10-28-cloud-qa-readiness.md)
// must stay loadable by the real configuration loader and consistent with
// the Terraform and the host settings wrapper. They hold placeholders only.
const repository = join(import.meta.dirname, '..', '..');
const examples = join(repository, 'deploy', 'vm', 'examples', 'development');
const read = (path: string) => readFileSync(path, 'utf8');

describe('development QA templates', () => {
  it('loads through the real configuration loader', async () => {
    const config = await loadEnvironmentConfig('gateway.json', (path) =>
      path === 'gateway.json'
        ? Promise.resolve(read(join(examples, 'gateway.json')))
        : Promise.reject(new Error('unexpected path')),
    );
    expect(config.environment).toBe('development');
    expect(config.secrets.provider).toBe('google_secret_manager');
    expect(config.identity.issuer).toBe('https://accounts.google.com');
    // Every governed container has a fictional QA root in both providers.
    for (const roots of [
      config.providers.notion.roots,
      config.providers.drive.roots,
    ]) {
      expect(roots.map((root) => root.container).sort()).toEqual([
        'family_shared',
        'parent_and_stewardship',
        'protected',
      ]);
      for (const root of roots) {
        expect(root.displayPath).toMatch(/^SIM-G QA \(fictional\) \//u);
      }
    }
    expect(config.providers.drive.credential.kind).toBe('workload_identity');
  });

  it('binds exactly the secret containers Terraform creates', () => {
    const terraform = read(
      join(repository, 'infra', 'google', 'modules', 'vm', 'secrets.tf'),
    );
    const created = [
      ...terraform.matchAll(/^\s+"([a-z-]+)"\s+=\s+\{ purpose/gmu),
    ]
      .map((match) => `family-brain-${match[1] ?? ''}`)
      .sort();
    const template = JSON.parse(read(join(examples, 'gateway.json'))) as {
      secrets: { bindings: Record<string, string> };
    };
    expect(Object.values(template.secrets.bindings).sort()).toEqual(created);
  });

  it('names only the keys the host settings wrapper accepts', () => {
    const wrapper = read(
      join(repository, 'deploy', 'vm', 'host', 'bin', 'sim-g-host-env.sh'),
    );
    const accepted = (/^keys=\(([^)]*)\)/mu.exec(wrapper)?.[1] ?? '')
      .split(/\s+/u)
      .filter(Boolean);
    const lines = read(join(examples, 'host.env'))
      .split('\n')
      .filter((line) => line.length > 0 && !line.startsWith('#'));
    const keys = lines.map((line) => line.split('=')[0] ?? '');
    for (const key of keys) expect(accepted).toContain(key);
    // The terms flag stays commented until the owner accepts them.
    expect(keys).not.toContain('SIM_G_ACME_TERMS');
    for (const line of lines.filter((entry) => entry.includes('_IMAGE='))) {
      expect(line).toMatch(
        /^SIM_G_[A-Z]+_IMAGE=us-central1-docker\.pkg\.dev\/replace-dev-project\/sim-g\/[a-z-]+@sha256:0{64}$/u,
      );
    }
  });
});
