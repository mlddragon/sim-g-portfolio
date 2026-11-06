/**
 * Summarizes one capacity run directory (written by
 * scripts/capacity/run-e2-micro.sh) into summary.json and prints it.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  parseMebibytes,
  summarizeResourceSamples,
  type ResourceSample,
} from './resource-model.js';

const argument = process.argv[2];
if (argument === undefined || argument.length === 0) {
  throw new TypeError('usage: summarize <run directory>');
}
const directory: string = argument;

function json(name: string): unknown {
  return JSON.parse(readFileSync(join(directory, name), 'utf8')) as unknown;
}

const lines = readFileSync(join(directory, 'samples.txt'), 'utf8')
  .split('\n')
  .filter(Boolean);
const resources = summarizeResourceSamples(
  lines.flatMap((line): ResourceSample[] => {
    const [, phase = '', kind, name = '', first = '', second = ''] =
      line.split('|');
    if (kind === 'container') {
      const memory = parseMebibytes(first.split('/')[0]?.trim() ?? '');
      const cpu = Number.parseFloat(second);
      return Number.isFinite(memory) && Number.isFinite(cpu)
        ? [
            {
              phase,
              kind: 'container' as const,
              name,
              memoryMiB: memory,
              cpuPercent: cpu,
            },
          ]
        : [];
    }
    if (kind === 'vm') {
      const totalKiB = Number(name);
      const availableKiB = Number(first);
      return Number.isFinite(totalKiB) && Number.isFinite(availableKiB)
        ? [
            {
              phase,
              kind: 'vm' as const,
              usedMiB: (totalKiB - availableKiB) / 1024,
              availableMiB: availableKiB / 1024,
            },
          ]
        : [];
    }
    return [];
  }),
);

const load = readFileSync(join(directory, 'load.jsonl'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line) as unknown);

interface CpuStat {
  readonly label: string;
  readonly cpuMax: string;
  readonly before: Readonly<Record<string, number>>;
  readonly after: Readonly<Record<string, number>>;
}
const delta = (stat: CpuStat, key: string): number =>
  (stat.after[key] ?? 0) - (stat.before[key] ?? 0);
const cpu = readFileSync(join(directory, 'cpu.jsonl'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line) as CpuStat)
  .map((stat) => {
    const periods = delta(stat, 'nr_periods');
    return {
      label: stat.label,
      cpuMax: stat.cpuMax,
      usageSeconds: delta(stat, 'usage_usec') / 1e6,
      periods,
      throttledPeriods: delta(stat, 'nr_throttled'),
      throttledFraction:
        periods > 0 ? delta(stat, 'nr_throttled') / periods : 0,
      throttledSeconds: delta(stat, 'throttled_usec') / 1e6,
    };
  });

const summary = {
  cpu,
  startup: json('startup.json'),
  restart: json('restart.json'),
  load,
  audit: json('audit.json'),
  backup: json('backup.json'),
  resources,
};
writeFileSync(
  join(directory, 'summary.json'),
  JSON.stringify(summary, null, 2),
);
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
