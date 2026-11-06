// Unauthenticated request flood for the capacity run's ingress phase. Plain
// JavaScript with no dependencies, so it runs in the capacity image as is:
//   node flood.mjs <url> <servername> <ca.pem> <connections> <seconds>
// Prints one JSON line of status counts. Requests carry forged forwarding
// headers, which must not change how the ingress limits them.
import { readFileSync } from 'node:fs';
import { Agent, request } from 'node:https';

const [url, servername, caPath, connections, seconds] = process.argv.slice(2);
const target = new URL(url);
const agent = new Agent({
  keepAlive: true,
  maxSockets: Number(connections),
  ca: readFileSync(caPath),
  servername,
});
const statuses = {};
const deadline = Date.now() + Number(seconds) * 1000;
let sent = 0;

function once() {
  return new Promise((resolve) => {
    sent += 1;
    const call = request(
      new URL('/v1/operations/search_brain', target),
      {
        method: 'POST',
        agent,
        servername,
        headers: {
          host: servername,
          'content-type': 'application/json',
          'x-forwarded-for': `203.0.113.${(sent % 250) + 1}`,
        },
        timeout: 10_000,
      },
      (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode));
      },
    );
    call.on('timeout', () => call.destroy());
    call.on('error', () => resolve('error'));
    call.end('{"query":"synthetic"}');
  });
}

await Promise.all(
  Array.from({ length: Number(connections) }, async () => {
    while (Date.now() < deadline) {
      const status = await once();
      statuses[status] = (statuses[status] ?? 0) + 1;
    }
  }),
);
agent.destroy();
console.log(JSON.stringify({ sent, seconds: Number(seconds), statuses }));
