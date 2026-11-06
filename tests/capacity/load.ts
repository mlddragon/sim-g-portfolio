/**
 * Synthetic load generator for the F13b capacity runs. Runs on the host,
 * outside the resource-limited VM, and talks HTTPS to the TLS proxy in front
 * of the gateway. Prints one JSON summary to stdout.
 *
 *   tsx tests/capacity/load.ts --url https://127.0.0.1:8443 --ca edge.crt \
 *     --servername capacity.sim-g.test \
 *     --private-jwk key.json --audience gateway-development.example.invalid \
 *     --vus 4 --seconds 60 --think-ms 500
 */
import { readFileSync } from 'node:fs';
import { Agent, request } from 'node:https';
import { parseArgs } from 'node:util';

import { importJWK, SignJWT, type JWK } from 'jose';

import {
  pickOperation,
  summarizeSamples,
  syntheticGoogleClaims,
  type CapacityOperation,
  type OperationMix,
  type Sample,
} from './load-model.js';
import { syntheticVocabulary } from './synthetic-corpus.js';

const { values } = parseArgs({
  options: {
    url: { type: 'string' },
    ca: { type: 'string' },
    // The ingress refuses a handshake without its name (SNI).
    servername: { type: 'string' },
    'private-jwk': { type: 'string' },
    audience: {
      type: 'string',
      default: 'gateway-development.example.invalid',
    },
    vus: { type: 'string', default: '2' },
    seconds: { type: 'string', default: '30' },
    'think-ms': { type: 'string', default: '500' },
    mix: {
      type: 'string',
      default:
        'search_brain=5,fetch_record=3,persist_knowledge=1,list_approvals=1',
    },
    label: { type: 'string', default: 'run' },
  },
});

function option(name: keyof typeof values): string {
  const value = values[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`missing --${name}`);
  }
  return value;
}

const target = new URL(option('url'));
const servername = option('servername');
const agent = new Agent({
  keepAlive: true,
  maxSockets: 64,
  ca: readFileSync(option('ca')),
  servername,
});
const vus = Number(option('vus'));
const seconds = Number(option('seconds'));
const thinkMs = Number(option('think-ms'));
const label = option('label');
const mix: OperationMix = Object.fromEntries(
  option('mix')
    .split(',')
    .map((pair): [string, number] => {
      const [name = '', weight = ''] = pair.split('=');
      return [name, Number(weight)];
    }),
);

const principals = [
  {
    subject: 'synthetic-subject-operator',
    email: 'operator@example.invalid',
    weight: 0.5,
  },
  {
    subject: 'synthetic-subject-steward',
    email: 'steward@example.invalid',
    weight: 0.35,
  },
  {
    subject: 'synthetic-subject-participant',
    email: 'participant@example.invalid',
    weight: 0.15,
  },
] as const;

const privateKey = await importJWK(
  JSON.parse(readFileSync(option('private-jwk'), 'utf8')) as JWK,
  'RS256',
);
const tokens = new Map<string, { token: string; expires: number }>();

async function tokenFor(subject: string, email: string): Promise<string> {
  // Backdated slightly: the verifier rejects a token issued in its future,
  // and the VM clock may trail the host's.
  const now = Math.floor(Date.now() / 1_000) - 30;
  const cached = tokens.get(subject);
  if (cached !== undefined && cached.expires - 60 > now) return cached.token;
  const claims = syntheticGoogleClaims({
    subject,
    email,
    audience: option('audience'),
    hostedDomain: 'example.invalid',
    issuedAt: now,
    lifetimeSeconds: 600,
  });
  const token = await new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'synthetic-capacity', typ: 'JWT' })
    .sign(privateKey);
  tokens.set(subject, { token, expires: claims.exp });
  return token;
}

function post(
  operation: string,
  token: string,
  body: unknown,
): Promise<{ status: number; json: unknown }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve) => {
    const call = request(
      new URL(`/v1/operations/${operation}`, target),
      {
        method: 'POST',
        agent,
        servername,
        timeout: 30_000,
        headers: {
          host: servername,
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          let json: unknown = null;
          try {
            json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            // Non-JSON bodies only matter as a status.
          }
          resolve({ status: response.statusCode ?? 0, json });
        });
        response.on('error', () => {
          resolve({ status: 0, json: null });
        });
      },
    );
    call.on('timeout', () => call.destroy());
    call.on('error', () => {
      resolve({ status: 0, json: null });
    });
    call.end(payload);
  });
}

const knownRecords: string[] = [];
let serial = 0;
const runId = `${label}_${String(Date.now())}`;

function word(): string {
  return syntheticVocabulary[
    Math.floor(Math.random() * syntheticVocabulary.length)
  ] as string;
}

async function once(samples: Sample[]): Promise<void> {
  const roll = Math.random();
  const principal =
    roll < 0.5 ? principals[0] : roll < 0.85 ? principals[1] : principals[2];
  let operation: CapacityOperation = pickOperation(mix, Math.random);
  if (operation === 'fetch_record' && knownRecords.length === 0) {
    operation = 'search_brain';
  }
  // Participant may only write to Family Shared; keep writes to the parents.
  const writer = principal === principals[2] ? principals[0] : principal;
  const actor = operation === 'persist_knowledge' ? writer : principal;
  const token = await tokenFor(actor.subject, actor.email);
  let body: unknown;
  switch (operation) {
    case 'search_brain':
      body = { query: word(), limit: 10 };
      break;
    case 'fetch_record':
      body = {
        brainRecordId:
          knownRecords[Math.floor(Math.random() * knownRecords.length)],
      };
      break;
    case 'persist_knowledge':
      serial += 1;
      body = {
        requestId: `req_capacity_${runId}_${String(serial)}`,
        title: `Synthetic capacity ${word()} note ${String(serial)}`,
        content: 'Fictional synthetic capacity body. '.repeat(60),
        semanticMetadata: {
          subject: `synthetic ${word()} procedure`,
          recordType: 'knowledge',
          durability: 'durable',
          sensitivity: 'family_shared',
        },
      };
      break;
    case 'list_approvals':
      body = {};
      break;
  }
  const started = performance.now();
  const response = await post(operation, token, body);
  const reason = (
    response.json as { error?: { details?: { reason?: unknown } } } | null
  )?.error?.details?.reason;
  samples.push({
    operation,
    status: response.status,
    milliseconds: Math.round(performance.now() - started),
    ...(typeof reason === 'string' && /^[a-z_]{1,96}$/u.test(reason)
      ? { reason }
      : {}),
  });
  if (operation === 'search_brain' && response.status === 200) {
    const results = (
      response.json as { results?: { brainRecordId?: unknown }[] }
    ).results;
    for (const result of results ?? []) {
      if (
        typeof result.brainRecordId === 'string' &&
        knownRecords.length < 500
      ) {
        knownRecords.push(result.brainRecordId);
      }
    }
  }
}

const samples: Sample[] = [];
const started = Date.now();
const deadline = started + seconds * 1_000;
await Promise.all(
  Array.from({ length: vus }, async () => {
    while (Date.now() < deadline) {
      await once(samples);
      if (thinkMs > 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, thinkMs * (0.5 + Math.random())),
        );
      }
    }
  }),
);
agent.destroy();
process.stdout.write(
  `${JSON.stringify({ label, vus, seconds, thinkMs, ...summarizeSamples(samples, Date.now() - started) })}\n`,
);
