import { runMigrationCommand } from './migration-main.js';

// The migration command's only process side effects: run it, then exit with
// its status. It runs as a one-shot container of the gateway image digest.
process.exit(
  await runMigrationCommand({
    env: process.env,
    argv: process.argv.slice(2),
    stdout: process.stdout,
    stderr: process.stderr,
  }),
);
