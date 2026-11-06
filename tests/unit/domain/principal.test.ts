import { describe, expectTypeOf, it } from 'vitest';

import type {
  AuthenticatedIdentity,
  BrainPrincipal,
} from '../../../src/domain/principal.js';

describe('principal contracts', () => {
  it('keeps verified external identity distinct from authorization role', () => {
    expectTypeOf<AuthenticatedIdentity>().toHaveProperty('issuer');
    expectTypeOf<AuthenticatedIdentity>().toHaveProperty('externalSubject');
    expectTypeOf<AuthenticatedIdentity>().not.toHaveProperty('role');
    expectTypeOf<BrainPrincipal>().toHaveProperty('role');
    expectTypeOf<BrainPrincipal>().not.toHaveProperty('externalSubject');
  });
});
