// Stand-in for the gateway behind nginx (scripts/check-edge.sh). Counts every
// request that reaches it and records the forwarding headers it received.
// GET /__seen (on the internal bridge only) returns the record.
import { createServer } from 'node:http';

const seen = [];
createServer((request, response) => {
  if (request.url === '/__seen') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(seen));
    return;
  }
  if (request.url === '/__reset') {
    seen.length = 0;
    response.end('ok');
    return;
  }
  seen.push({
    path: request.url,
    host: request.headers.host ?? null,
    forwardedFor: request.headers['x-forwarded-for'] ?? null,
    forwardedProto: request.headers['x-forwarded-proto'] ?? null,
    forwardedHost: request.headers['x-forwarded-host'] ?? null,
    forwarded: request.headers.forwarded ?? null,
    realIp: request.headers['x-real-ip'] ?? null,
  });
  request.resume();
  request.on('end', () => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"ok":true}');
  });
}).listen(8080, '0.0.0.0');
