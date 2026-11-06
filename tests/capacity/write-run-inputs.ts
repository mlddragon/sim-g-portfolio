/**
 * Writes one capacity run's synthetic inputs into a directory outside the
 * repository: a fresh RS256 key pair (private half for the load generator,
 * public half for the gateway) and a schema-valid development configuration.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { exportJWK, generateKeyPair } from 'jose';

import { syntheticConfigDocument } from '../support/environment-fixtures.js';

const directory = process.argv[2];
if (directory === undefined || directory.length === 0) {
  throw new TypeError('usage: write-run-inputs <directory>');
}

const { publicKey, privateKey } = await generateKeyPair('RS256', {
  extractable: true,
});
const kid = 'synthetic-capacity';
writeFileSync(
  join(directory, 'private.jwk.json'),
  JSON.stringify({ ...(await exportJWK(privateKey)), kid, alg: 'RS256' }),
  { mode: 0o600 },
);
writeFileSync(
  join(directory, 'public.jwk.json'),
  JSON.stringify({ ...(await exportJWK(publicKey)), kid, alg: 'RS256' }),
);
writeFileSync(
  join(directory, 'gateway.json'),
  JSON.stringify(syntheticConfigDocument('development'), null, 2),
);
