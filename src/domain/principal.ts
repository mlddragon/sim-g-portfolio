import type { PrincipalId } from './identifiers.js';

export const principalRoles = [
  'owner_operator',
  'parent_steward',
  'family_participant',
] as const;

export type PrincipalRole = (typeof principalRoles)[number];
export type PrincipalStatus = 'active' | 'disabled';

/** Claims proven by an external identity provider, before local authorization. */
export interface VerifiedExternalIdentity {
  readonly issuer: string;
  readonly externalSubject: string;
  readonly email: string;
  readonly clientId?: string;
  readonly authenticatedAt: Date;
}

/** Verified claims after an immutable server-side principal binding is applied. */
export interface AuthenticatedIdentity extends VerifiedExternalIdentity {
  readonly principalId: PrincipalId;
}

export interface BrainPrincipal {
  readonly id: PrincipalId;
  readonly key: string;
  readonly displayName: string;
  readonly role: PrincipalRole;
  readonly status: PrincipalStatus;
}

export interface AuthenticatedPrincipal {
  readonly principal: BrainPrincipal;
  readonly identity: AuthenticatedIdentity;
}
