/** Pure helpers that turn sampled docker/VM figures into per-phase peaks. */

const units: Readonly<Record<string, number>> = {
  B: 1 / (1024 * 1024),
  kB: 1000 / (1024 * 1024),
  KiB: 1 / 1024,
  MB: 1_000_000 / (1024 * 1024),
  MiB: 1,
  GB: 1_000_000_000 / (1024 * 1024),
  GiB: 1024,
};

/** Parses a docker stats size such as `45.5MiB`; NaN if unrecognized. */
export function parseMebibytes(value: string): number {
  const match = /^([0-9]+(?:\.[0-9]+)?)\s*(B|kB|KiB|MB|MiB|GB|GiB)$/u.exec(
    value.trim(),
  );
  if (match === null) return Number.NaN;
  const [, amount = '', unit = ''] = match;
  const factor = units[unit];
  return factor === undefined ? Number.NaN : Number(amount) * factor;
}

export type ResourceSample =
  | {
      readonly phase: string;
      readonly kind: 'container';
      readonly name: string;
      readonly memoryMiB: number;
      readonly cpuPercent: number;
    }
  | {
      readonly phase: string;
      readonly kind: 'vm';
      readonly usedMiB: number;
      readonly availableMiB: number;
    };

export interface ContainerPeak {
  readonly peakMemoryMiB: number;
  readonly meanCpuPercent: number;
  readonly peakCpuPercent: number;
}

export interface PhaseResources {
  readonly containers: Readonly<Record<string, ContainerPeak>>;
  /** Sum of per-container peaks: never below the true simultaneous peak. */
  readonly stackPeakMemoryMiBUpperBound: number;
  readonly vmPeakUsedMiB: number;
  readonly vmMinimumAvailableMiB: number;
}

export function summarizeResourceSamples(
  samples: readonly ResourceSample[],
): Record<string, PhaseResources> {
  const phases = new Map<
    string,
    {
      containers: Map<string, { memory: number; cpu: number[] }>;
      used: number;
      available: number;
    }
  >();
  for (const sample of samples) {
    const phase = phases.get(sample.phase) ?? {
      containers: new Map<string, { memory: number; cpu: number[] }>(),
      used: Number.NaN,
      available: Number.NaN,
    };
    phases.set(sample.phase, phase);
    if (sample.kind === 'vm') {
      phase.used = Number.isNaN(phase.used)
        ? sample.usedMiB
        : Math.max(phase.used, sample.usedMiB);
      phase.available = Number.isNaN(phase.available)
        ? sample.availableMiB
        : Math.min(phase.available, sample.availableMiB);
      continue;
    }
    const container = phase.containers.get(sample.name) ?? {
      memory: 0,
      cpu: [],
    };
    container.memory = Math.max(container.memory, sample.memoryMiB);
    container.cpu.push(sample.cpuPercent);
    phase.containers.set(sample.name, container);
  }
  const result: Record<string, PhaseResources> = {};
  for (const [name, phase] of phases) {
    const containers: Record<string, ContainerPeak> = {};
    let stack = 0;
    for (const [container, figures] of phase.containers) {
      containers[container] = {
        peakMemoryMiB: figures.memory,
        meanCpuPercent:
          figures.cpu.reduce((sum, value) => sum + value, 0) /
          figures.cpu.length,
        peakCpuPercent: figures.cpu.reduce(
          (peak, value) => (value > peak ? value : peak),
          Number.NEGATIVE_INFINITY,
        ),
      };
      stack += figures.memory;
    }
    result[name] = {
      containers,
      stackPeakMemoryMiBUpperBound: stack,
      vmPeakUsedMiB: phase.used,
      vmMinimumAvailableMiB: phase.available,
    };
  }
  return result;
}
