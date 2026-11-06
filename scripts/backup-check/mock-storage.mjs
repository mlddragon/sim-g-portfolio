// Local stand-in for the metadata token endpoint and the Cloud Storage
// upload API, for the synthetic backup round trip only. Records each upload
// under the output directory, one subdirectory per bucket, and refuses to
// overwrite (ifGenerationMatch=0).
import { createServer } from 'node:http';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [port, directory] = process.argv.slice(2);
const token = 'synthetic-check-token';
createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (request.method === 'GET' && url.pathname === '/token') {
    if (request.headers['metadata-flavor'] !== 'Google') {
      response.writeHead(403).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ access_token: token, expires_in: 3599 }));
    return;
  }
  const upload =
    /^\/upload\/storage\/v1\/b\/([a-z0-9][a-z0-9._-]{1,61}[a-z0-9])\/o$/u.exec(
      url.pathname,
    );
  if (request.method === 'POST' && upload !== null) {
    const bucket = join(directory, upload[1] ?? '');
    const name = url.searchParams.get('name') ?? '';
    if (
      request.headers.authorization !== `Bearer ${token}` ||
      url.searchParams.get('uploadType') !== 'media' ||
      url.searchParams.get('ifGenerationMatch') !== '0' ||
      !/^[A-Za-z0-9/._-]+$/u.test(name)
    ) {
      response.writeHead(400).end();
      return;
    }
    const target = join(bucket, name.replaceAll('/', '__'));
    if (existsSync(target) || existsSync(join(directory, '.refuse-all'))) {
      response.writeHead(412).end();
      return;
    }
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      mkdirSync(bucket, { recursive: true, mode: 0o700 });
      writeFileSync(target, Buffer.concat(chunks), { mode: 0o600 });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
    return;
  }
  response.writeHead(404).end();
}).listen(Number(port), '127.0.0.1');
