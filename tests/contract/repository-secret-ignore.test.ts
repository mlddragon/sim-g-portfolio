import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

function ignored(paths: readonly string[]) {
  return spawnSync('git', ['check-ignore', '--no-index', '--stdin'], {
    input: paths.join('\n') + '\n',
    encoding: 'utf8',
  });
}

describe('repository secret-path boundary', () => {
  it('allows only explicitly intended secret-adapter source and tests to be tracked', () => {
    const result = ignored([
      'src/adapters/secrets/environment-secret-provider.ts',
      'src/adapters/secrets/google-secret-manager-provider.ts',
      'tests/unit/secrets/environment-secret-provider.test.ts',
      'tests/unit/secrets/google-secret-manager-provider.test.ts',
    ]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it('tracks runtime composition source while still ignoring runtime data', () => {
    const tracked = ignored([
      'src/runtime/configuration.ts',
      'src/runtime/main.ts',
      'tests/unit/runtime/configuration.test.ts',
    ]);
    expect(tracked.status).toBe(1);
    expect(tracked.stdout).toBe('');

    const data = ['runtime/state.json', 'var/runtime/cache.bin'];
    const excluded = ignored(data);
    expect(excluded.status).toBe(0);
    expect(excluded.stdout.trim().split('\n')).toEqual(data);
  });

  it('still ignores credential files, exports and unapproved files inside secret directories', () => {
    const paths = [
      '.env',
      '.env.development',
      '.env.production',
      'provider.key',
      'service-account-dev.json',
      'credentials.json',
      'secrets/synthetic.json',
      'some/nested/secrets/synthetic.ts',
      'src/adapters/secrets/synthetic-credential.json',
      'src/adapters/secrets/provider.key',
      'src/adapters/secrets/credentials.json',
      'tests/unit/secrets/.env',
      'tests/unit/secrets/synthetic-export.json',
      'tests/unit/secrets/unapproved.ts',
      'family.dump',
      'gateway.log',
      'terraform.tfstate',
    ];
    const result = ignored(paths);
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual(paths);
    expect(result.stderr).toBe('');
  });
});
