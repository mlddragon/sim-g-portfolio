import { describe, expect, it } from 'vitest';

import {
  parseMebibytes,
  summarizeResourceSamples,
} from '../../capacity/resource-model.js';

describe('capacity resource model', () => {
  it('parses docker stats memory figures into MiB', () => {
    expect(parseMebibytes('512KiB')).toBe(0.5);
    expect(parseMebibytes('45.5MiB')).toBe(45.5);
    expect(parseMebibytes('1.5GiB')).toBe(1536);
    expect(parseMebibytes('2097152B')).toBe(2);
    expect(parseMebibytes('12kB')).toBeCloseTo(0.0114, 3);
    expect(parseMebibytes('garbage')).toBeNaN();
  });

  it('reports per-phase peaks for containers, the stack and the VM', () => {
    const summary = summarizeResourceSamples([
      {
        phase: 'p',
        kind: 'container',
        name: 'cap-gateway',
        memoryMiB: 90,
        cpuPercent: 10,
      },
      {
        phase: 'p',
        kind: 'container',
        name: 'cap-db',
        memoryMiB: 40,
        cpuPercent: 4,
      },
      {
        phase: 'p',
        kind: 'container',
        name: 'cap-gateway',
        memoryMiB: 110,
        cpuPercent: 30,
      },
      {
        phase: 'p',
        kind: 'container',
        name: 'cap-db',
        memoryMiB: 35,
        cpuPercent: 2,
      },
      { phase: 'p', kind: 'vm', usedMiB: 500, availableMiB: 456 },
      { phase: 'p', kind: 'vm', usedMiB: 560, availableMiB: 396 },
      { phase: 'q', kind: 'vm', usedMiB: 300, availableMiB: 656 },
    ]);

    expect(summary['p']).toEqual({
      containers: {
        'cap-gateway': {
          peakMemoryMiB: 110,
          meanCpuPercent: 20,
          peakCpuPercent: 30,
        },
        'cap-db': { peakMemoryMiB: 40, meanCpuPercent: 3, peakCpuPercent: 4 },
      },
      // Sum per sampling instant would need timestamps; the conservative
      // bound is the sum of per-container peaks.
      stackPeakMemoryMiBUpperBound: 150,
      vmPeakUsedMiB: 560,
      vmMinimumAvailableMiB: 396,
    });
    expect(summary['q']).toMatchObject({ vmPeakUsedMiB: 300, containers: {} });
  });
});
