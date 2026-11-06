import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';

import {
  EnvironmentSecretProvider,
  type EnvironmentSecretProviderOptions,
} from '../../../src/adapters/secrets/environment-secret-provider.js';
import type {
  SecretProvider,
  SecretReference,
} from '../../../src/ports/secret-provider.js';

const reference: SecretReference = {
  environment: 'development',
  name: 'synthetic_notion',
};
const signal = () => new AbortController().signal;
function options(
  overrides: Partial<EnvironmentSecretProviderOptions> = {},
): EnvironmentSecretProviderOptions {
  return {
    environment: 'development',
    bindings: { synthetic_notion: 'SYNTHETIC_NOTION_CREDENTIAL' },
    environmentValues: {
      SYNTHETIC_NOTION_CREDENTIAL: 'SYNTHETIC_NOT_A_REAL_SECRET',
    },
    ...overrides,
  };
}

describe('development-only EnvironmentSecretProvider', () => {
  it.each(['development', 'test'] as const)(
    'resolves only a registered %s secret through the existing port',
    async (environment) => {
      const provider: SecretProvider = new EnvironmentSecretProvider(
        options({ environment }),
      );
      await expect(
        provider.get({ ...reference, environment }, signal()),
      ).resolves.toEqual({
        value: 'SYNTHETIC_NOT_A_REAL_SECRET',
        version: 'environment',
      });
    },
  );

  it('refuses production construction before accessing secret values', () => {
    let reads = 0;
    const values = new Proxy(
      {},
      {
        getOwnPropertyDescriptor: () => {
          reads++;
          throw new Error('SYNTHETIC_PRIVATE_FAILURE');
        },
      },
    );
    expect(
      () =>
        new EnvironmentSecretProvider(
          options({ environment: 'production', environmentValues: values }),
        ),
    ).toThrow(
      expect.objectContaining({ code: 'environment_boundary_violation' }),
    );
    expect(reads).toBe(0);
  });

  it.each(['production', 'test'] as const)(
    'rejects a %s reference in development before reading a value',
    async (environment) => {
      let reads = 0;
      const values = new Proxy(
        {},
        {
          getOwnPropertyDescriptor: () => {
            reads++;
            return undefined;
          },
        },
      );
      const provider = new EnvironmentSecretProvider(
        options({ environmentValues: values }),
      );
      await expect(
        provider.get({ ...reference, environment }, signal()),
      ).rejects.toMatchObject({
        code: 'environment_boundary_violation',
        retryable: false,
      });
      expect(reads).toBe(0);
    },
  );

  it('does not resolve arbitrary environment-variable names or unregistered logical names', async () => {
    const provider = new EnvironmentSecretProvider(
      options({
        environmentValues: {
          SYNTHETIC_NOTION_CREDENTIAL: 'SYNTHETIC_NOT_A_REAL_SECRET',
          unregistered_secret: 'SYNTHETIC_UNREGISTERED_SECRET',
        },
      }),
    );
    for (const name of [
      'SYNTHETIC_NOTION_CREDENTIAL',
      'unregistered_secret',
      'constructor',
      '__proto__',
    ]) {
      const error: unknown = await provider
        .get({ ...reference, name }, signal())
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect(JSON.stringify(error)).not.toMatch(
        /SYNTHETIC_NOT_A_REAL_SECRET|SYNTHETIC_UNREGISTERED_SECRET/u,
      );
    }
  });

  it.each([undefined, '', '   ', '\n\t'])(
    'rejects a missing or blank value (%#)',
    async (value) => {
      const provider = new EnvironmentSecretProvider(
        options({ environmentValues: { SYNTHETIC_NOTION_CREDENTIAL: value } }),
      );
      await expect(provider.get(reference, signal())).rejects.toMatchObject({
        code: 'not_found',
        retryable: false,
        details: { reason: 'secret_not_configured' },
      });
    },
  );

  it('does not trim or alter a valid multiline credential', async () => {
    const value = '  SYNTHETIC_MULTILINE\nNOT_A_REAL_KEY\n';
    const provider = new EnvironmentSecretProvider(
      options({ environmentValues: { SYNTHETIC_NOTION_CREDENTIAL: value } }),
    );
    await expect(provider.get(reference, signal())).resolves.toEqual({
      value,
      version: 'environment',
    });
  });

  it.each(['1', 'latest', 'environment', ''])(
    'rejects unsupported explicit version %j without reading a value',
    async (version) => {
      let reads = 0;
      const values = new Proxy(
        {},
        {
          getOwnPropertyDescriptor: () => {
            reads++;
            return undefined;
          },
        },
      );
      const provider = new EnvironmentSecretProvider(
        options({ environmentValues: values }),
      );
      await expect(
        provider.get({ ...reference, version }, signal()),
      ).rejects.toMatchObject({
        code: 'invalid_request',
        details: { reason: 'invalid_environment_secret_reference' },
      });
      expect(reads).toBe(0);
    },
  );

  it('observes operator rotation and revocation without caching a secret value', async () => {
    const values: Record<string, string | undefined> = {
      SYNTHETIC_NOTION_CREDENTIAL: 'SYNTHETIC_FIRST',
    };
    const provider = new EnvironmentSecretProvider(
      options({ environmentValues: values }),
    );
    expect((await provider.get(reference, signal())).value).toBe(
      'SYNTHETIC_FIRST',
    );
    values['SYNTHETIC_NOTION_CREDENTIAL'] = 'SYNTHETIC_ROTATED';
    expect((await provider.get(reference, signal())).value).toBe(
      'SYNTHETIC_ROTATED',
    );
    delete values['SYNTHETIC_NOTION_CREDENTIAL'];
    await expect(provider.get(reference, signal())).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('snapshots configuration so later registry/options edits cannot broaden access', async () => {
    const bindings = { synthetic_notion: 'SYNTHETIC_NOTION_CREDENTIAL' };
    const input = { ...options(), bindings };
    const provider = new EnvironmentSecretProvider(input);
    bindings.synthetic_notion = 'SYNTHETIC_UNRELATED';
    Object.assign(bindings, { unrelated: 'SYNTHETIC_UNRELATED' });
    input.environment = 'production';
    input.environmentValues = {
      SYNTHETIC_NOTION_CREDENTIAL: 'SYNTHETIC_REPLACED_SOURCE',
    };
    await expect(provider.get(reference, signal())).resolves.toEqual({
      value: 'SYNTHETIC_NOT_A_REAL_SECRET',
      version: 'environment',
    });
    await expect(
      provider.get({ ...reference, name: 'unrelated' }, signal()),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      provider.get({ ...reference, environment: 'production' }, signal()),
    ).rejects.toMatchObject({ code: 'environment_boundary_violation' });
  });

  it('does not enumerate or read unregistered environment values', async () => {
    let accessed = false;
    const values = {
      SYNTHETIC_NOTION_CREDENTIAL: 'SYNTHETIC_NOT_A_REAL_SECRET',
      get UNRELATED(): string {
        accessed = true;
        throw new Error('SYNTHETIC_UNRELATED_SECRET');
      },
    };
    const provider = new EnvironmentSecretProvider(
      options({ environmentValues: values }),
    );
    await expect(provider.get(reference, signal())).resolves.toHaveProperty(
      'value',
      'SYNTHETIC_NOT_A_REAL_SECRET',
    );
    expect(accessed).toBe(false);
  });

  it('rejects inherited values and getter-based values without invoking a getter', async () => {
    let invoked = false;
    const inherited = Object.create({
      SYNTHETIC_NOTION_CREDENTIAL: 'SYNTHETIC_INHERITED_SECRET',
    }) as Record<string, string>;
    const getter = {
      get SYNTHETIC_NOTION_CREDENTIAL() {
        invoked = true;
        return 'SYNTHETIC_GETTER_SECRET';
      },
    };
    for (const values of [inherited, getter]) {
      const provider = new EnvironmentSecretProvider(
        options({ environmentValues: values }),
      );
      await expect(provider.get(reference, signal())).rejects.toMatchObject({
        code: 'not_found',
      });
    }
    expect(invoked).toBe(false);
  });

  it('rejects non-string values without coercion or serialization hooks', async () => {
    let invoked = false;
    const value = {
      toString: () => {
        invoked = true;
        return 'SYNTHETIC_SECRET';
      },
      toJSON: () => {
        invoked = true;
        return 'SYNTHETIC_SECRET';
      },
    };
    const environmentValues = {
      SYNTHETIC_NOTION_CREDENTIAL: value,
    } as unknown as Record<string, string>;
    await expect(
      new EnvironmentSecretProvider(options({ environmentValues })).get(
        reference,
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(invoked).toBe(false);
  });

  it('cancels before lookup without leaking the caller abort reason', async () => {
    let reads = 0;
    const values = new Proxy(
      {},
      {
        getOwnPropertyDescriptor: () => {
          reads++;
          return undefined;
        },
      },
    );
    const provider = new EnvironmentSecretProvider(
      options({ environmentValues: values }),
    );
    const controller = new AbortController();
    controller.abort(new Error('SYNTHETIC_PRIVATE_ABORT_REASON'));
    const error: unknown = await provider
      .get(reference, controller.signal)
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ name: 'AbortError' });
    expect(String(error)).not.toContain('SYNTHETIC_PRIVATE_ABORT_REASON');
    expect(reads).toBe(0);
  });

  it('does not release a value when cancellation occurs during source access', async () => {
    const controller = new AbortController();
    const values = new Proxy(
      {},
      {
        getOwnPropertyDescriptor: () => {
          controller.abort('SYNTHETIC_ABORT_SECRET');
          return {
            configurable: true,
            enumerable: true,
            writable: true,
            value: 'SYNTHETIC_CANCELLED_SECRET',
          };
        },
      },
    );
    const provider = new EnvironmentSecretProvider(
      options({ environmentValues: values }),
    );
    const error: unknown = await provider
      .get(reference, controller.signal)
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ name: 'AbortError' });
    expect(JSON.stringify(error)).not.toMatch(
      /SYNTHETIC_ABORT_SECRET|SYNTHETIC_CANCELLED_SECRET/u,
    );
  });

  it('sanitizes unexpected source failures and does not serialize provider configuration or values', async () => {
    const provider = new EnvironmentSecretProvider(
      options({
        environmentValues: new Proxy(
          {},
          {
            getOwnPropertyDescriptor: () => {
              throw new Error('SYNTHETIC_PRIVATE_SOURCE_ERROR');
            },
          },
        ),
      }),
    );
    const error: unknown = await provider
      .get(reference, signal())
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: 'provider_unavailable',
      retryable: true,
      details: { reason: 'environment_secret_read_failed' },
    });
    expect(JSON.stringify(error)).not.toContain(
      'SYNTHETIC_PRIVATE_SOURCE_ERROR',
    );
    const configured = new EnvironmentSecretProvider(options());
    expect(JSON.stringify(configured)).not.toContain(
      'SYNTHETIC_NOT_A_REAL_SECRET',
    );
    expect(inspect(configured, { showHidden: true })).not.toContain(
      'SYNTHETIC_NOT_A_REAL_SECRET',
    );
  });

  it.each([
    { environment: 'staging' },
    { environmentValues: undefined },
    { bindings: { 'bad name': 'VALID_VAR' } },
    { bindings: { valid_name: 'invalid-variable' } },
    {
      bindings: { valid_name: { toString: (): string => 'SYNTHETIC_SECRET' } },
    },
    {
      bindings: Object.create({
        synthetic_notion: 'SYNTHETIC_NOTION_CREDENTIAL',
      }) as Record<string, string>,
    },
  ])(
    'rejects malformed constructor configuration (%#) with safe errors',
    (override) => {
      const input = {
        ...options(),
        ...override,
      } as unknown as EnvironmentSecretProviderOptions;
      expect(() => new EnvironmentSecretProvider(input)).toThrow(
        expect.objectContaining({
          code: 'invalid_request',
          details: { reason: 'invalid_environment_secret_configuration' },
        }),
      );
    },
  );

  it('rejects accessor-based bindings without invoking them', () => {
    let invoked = false;
    const bindings = {
      get synthetic_notion(): string {
        invoked = true;
        throw new Error('SYNTHETIC_GETTER_SECRET');
      },
    };
    expect(() => new EnvironmentSecretProvider(options({ bindings }))).toThrow(
      expect.objectContaining({ code: 'invalid_request' }),
    );
    expect(invoked).toBe(false);
  });

  it.each([
    { environment: 'staging' },
    { name: '' },
    { name: 'bad name' },
    { name: { toString: (): string => 'synthetic_notion' } },
    { version: null },
  ])('rejects malformed runtime references (%#)', async (override) => {
    const provider = new EnvironmentSecretProvider(options());
    const invalid = { ...reference, ...override } as unknown as SecretReference;
    await expect(provider.get(invalid, signal())).rejects.toMatchObject({
      code: 'invalid_request',
    });
  });
});
