import { main } from './main.js';

// The only module with process side effects: run the gateway, then exit with
// its status so no leftover handle can keep a stopped or failed process alive.
process.exit(await main({ env: process.env }));
