// Client side of scripts/check-edge.sh. Usage:
//   node client.mjs burst <edge-ip> <domain> <count> <concurrency>
//   node client.mjs get <edge-ip> <domain> <path>
//   node client.mjs tls <edge-ip> <servername|->
//   node client.mjs http <edge-ip> <path> <host-header>
//   node client.mjs post <edge-ip> <domain> <path> <bytes> [host-header]
//   node client.mjs limited <edge-ip> <domain>
// Each prints one JSON line. Requests carry forged forwarding headers, so
// a limit keyed on a header would see a different client every time.
import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { Agent, request } from 'node:https';
import { connect } from 'node:tls';

const [mode, edge, ...rest] = process.argv.slice(2);
const ca = readFileSync('/check/ca.pem');

function forged(index) {
  const octet = (index % 250) + 1;
  return {
    'x-forwarded-for': `203.0.113.${octet}, 198.51.100.${octet}`,
    'x-real-ip': `192.0.2.${octet}`,
    forwarded: `for=192.0.2.${octet}`,
    'x-forwarded-host': 'attacker.example',
  };
}

function exchange(
  agent,
  domain,
  path,
  body,
  host = domain,
  index = 0,
  method = 'POST',
) {
  return new Promise((resolve) => {
    const call = request(
      {
        host: edge,
        port: 8443,
        servername: domain,
        path,
        method,
        agent,
        headers: {
          host,
          'content-type': 'application/json',
          ...forged(index),
        },
      },
      (response) => {
        let text = '';
        response.on('data', (chunk) => (text += chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode,
            retryAfter: response.headers['retry-after'] ?? null,
            contentType: response.headers['content-type'] ?? null,
            body: text,
          }),
        );
      },
    );
    call.on('error', (error) =>
      resolve({ status: 'error', code: error.code ?? null }),
    );
    call.end(body);
  });
}
async function once(agent, domain, path, index) {
  return (await exchange(agent, domain, path, '{}', domain, index)).status;
}

if (mode === 'burst') {
  const [domain, count, concurrency] = rest;
  const agent = new Agent({
    keepAlive: true,
    maxSockets: Number(concurrency),
    ca,
  });
  const statuses = {};
  let next = 0;
  const started = Date.now();
  await Promise.all(
    Array.from({ length: Number(concurrency) }, async () => {
      while (next < Number(count)) {
        const index = next++;
        const status = await once(
          agent,
          domain,
          '/v1/operations/search_brain',
          index,
        );
        statuses[status] = (statuses[status] ?? 0) + 1;
      }
    }),
  );
  agent.destroy();
  console.log(
    JSON.stringify({ statuses, seconds: (Date.now() - started) / 1000 }),
  );
} else if (mode === 'get') {
  const [domain, path, method = 'POST'] = rest;
  const agent = new Agent({ ca });
  const result = await exchange(
    agent,
    domain,
    path,
    method === 'GET' ? undefined : '{}',
    domain,
    0,
    method,
  );
  console.log(JSON.stringify({ status: result.status }));
} else if (mode === 'post') {
  const [domain, path, bytes, host = domain] = rest;
  const agent = new Agent({ ca });
  const body = `{"padding":"${'x'.repeat(Math.max(0, Number(bytes) - 15))}"}`;
  const result = await exchange(agent, domain, path, body, host);
  console.log(
    JSON.stringify({ status: result.status, code: result.code ?? null }),
  );
} else if (mode === 'limited') {
  // Until the first 429, which must carry the gateway's shape.
  const [domain] = rest;
  const agent = new Agent({ keepAlive: true, ca });
  let result = { status: 'none' };
  for (let index = 0; index < 100 && result.status !== 429; index += 1) {
    result = await exchange(
      agent,
      domain,
      '/v1/operations/search_brain',
      '{}',
      domain,
      index,
    );
  }
  agent.destroy();
  console.log(JSON.stringify(result));
} else if (mode === 'tls') {
  const [servername] = rest;
  const socket = connect({
    host: edge,
    port: 8443,
    ca,
    ...(servername === '-' ? {} : { servername }),
  });
  socket.on('secureConnect', () => {
    console.log(
      JSON.stringify({ handshake: 'ok', authorized: socket.authorized }),
    );
    socket.end();
  });
  socket.on('error', (error) => {
    console.log(
      JSON.stringify({ handshake: 'refused', code: error.code ?? null }),
    );
  });
} else if (mode === 'http') {
  const [path, host] = rest;
  const call = httpRequest(
    { host: edge, port: 8080, path, headers: { host, ...forged(0) } },
    (response) => {
      let body = '';
      response.on('data', (chunk) => (body += chunk));
      response.on('end', () =>
        console.log(
          JSON.stringify({
            status: response.statusCode,
            location: response.headers.location ?? null,
            body,
          }),
        ),
      );
    },
  );
  call.on('error', (error) =>
    console.log(JSON.stringify({ status: 'error', code: error.code })),
  );
  call.end();
} else {
  console.error('unknown mode');
  process.exit(2);
}
