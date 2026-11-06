import { readFile } from 'node:fs/promises';

import { verifyPolicyBundle } from '../src/domain/policy/governance-validator.js';

const policyDirectory = new URL('../config/policy/', import.meta.url);

async function readPolicyFile(name: string): Promise<string> {
  return readFile(new URL(name, policyDirectory), 'utf8');
}

async function main(): Promise<void> {
  const [
    policyContent,
    governanceLockContent,
    projectRegistryContent,
    projectRegistryLockContent,
  ] = await Promise.all([
    readPolicyFile('family-brain-v1.yaml'),
    readPolicyFile('governance-lock.json'),
    readPolicyFile('project-registry.yaml'),
    readPolicyFile('project-registry-lock.json'),
  ]);

  const bundle = verifyPolicyBundle({
    policyContent,
    governanceLockContent,
    projectRegistryContent,
    projectRegistryLockContent,
  });

  process.stdout.write(
    `Policy verification passed (${bundle.policy.version}; ${bundle.projectRegistry.version}).\n`,
  );
}

await main();
