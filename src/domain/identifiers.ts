type BrandedIdentifier<Brand extends string> = string & {
  readonly __brand: Brand;
};

export type PrincipalId = BrandedIdentifier<'PrincipalId'>;
export type RequestId = BrandedIdentifier<'RequestId'>;
export type OperationId = BrandedIdentifier<'OperationId'>;
export type BrainRecordId = BrandedIdentifier<'BrainRecordId'>;
export type ProviderRecordId = BrandedIdentifier<'ProviderRecordId'>;
export type ApprovalRequestId = BrandedIdentifier<'ApprovalRequestId'>;
export type ElevationChallengeId = BrandedIdentifier<'ElevationChallengeId'>;

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) {
      return true;
    }
  }

  return false;
}

function identifier<Brand extends string>(
  value: string,
  kind: string,
): BrandedIdentifier<Brand> {
  if (
    value.length === 0 ||
    value.length > 512 ||
    value.trim() !== value ||
    containsControlCharacter(value)
  ) {
    throw new TypeError(`invalid_${kind}`);
  }

  return value as BrandedIdentifier<Brand>;
}

export const principalId = (value: string): PrincipalId =>
  identifier<'PrincipalId'>(value, 'principal_id');

export const requestId = (value: string): RequestId =>
  identifier<'RequestId'>(value, 'request_id');

export const operationId = (value: string): OperationId =>
  identifier<'OperationId'>(value, 'operation_id');

export const brainRecordId = (value: string): BrainRecordId =>
  identifier<'BrainRecordId'>(value, 'brain_record_id');

export const providerRecordId = (value: string): ProviderRecordId =>
  identifier<'ProviderRecordId'>(value, 'provider_record_id');

export const approvalRequestId = (value: string): ApprovalRequestId =>
  identifier<'ApprovalRequestId'>(value, 'approval_request_id');

export const elevationChallengeId = (value: string): ElevationChallengeId =>
  identifier<'ElevationChallengeId'>(value, 'elevation_challenge_id');
