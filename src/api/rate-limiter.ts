import { isIP } from 'node:net';

import type { Clock } from '../ports/clock.js';

export interface RateLimitDecision {
  readonly allowed: boolean;
  /** Whole seconds until the current window ends; at least 1. */
  readonly retryAfterSeconds: number;
}

interface Window {
  readonly startedAt: number;
  count: number;
}

/**
 * In-process fixed-window counter with a hard bound on tracked keys. When the
 * bound is reached the least recently used key is evicted, so memory stays
 * bounded under key flooding at the cost of resetting that key's count.
 */
export class FixedWindowLimiter {
  readonly #windows = new Map<string, Window>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxTrackedKeys: number,
    private readonly clock: Clock,
  ) {}

  take(key: string): RateLimitDecision {
    const now = this.clock.now().getTime();
    let window = this.#windows.get(key);
    // A clock that moved backwards starts a fresh window rather than trusting it.
    if (
      window === undefined ||
      now >= window.startedAt + this.windowMs ||
      now < window.startedAt
    ) {
      window = { startedAt: now, count: 0 };
    }
    // Reinsert so iteration order is least recently used first.
    this.#windows.delete(key);
    this.#windows.set(key, window);
    while (this.#windows.size > this.maxTrackedKeys) {
      const oldest = this.#windows.keys().next();
      if (oldest.done === true) break;
      this.#windows.delete(oldest.value);
    }
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((window.startedAt + this.windowMs - now) / 1_000),
    );
    if (window.count >= this.limit) {
      return { allowed: false, retryAfterSeconds };
    }
    window.count += 1;
    return { allowed: true, retryAfterSeconds };
  }
}

/** Expands an IPv6 literal (optionally with a dotted IPv4 tail) to 8 groups. */
function ipv6Groups(address: string): number[] | undefined {
  let text = address;
  const tail: number[] = [];
  const dotted = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(text);
  if (dotted !== null) {
    const octets = dotted.slice(1).map(Number);
    tail.push(
      ((octets[0] ?? 0) << 8) | (octets[1] ?? 0),
      ((octets[2] ?? 0) << 8) | (octets[3] ?? 0),
    );
    text = text.slice(0, dotted.index) + '0:0';
  }
  const halves = text.split('::');
  if (halves.length > 2) return undefined;
  const parse = (part: string | undefined): number[] =>
    part === undefined || part === ''
      ? []
      : part.split(':').map((group) => Number.parseInt(group, 16));
  const head = parse(halves[0]);
  const rest = parse(halves[1]);
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  const groups = [
    ...head,
    ...new Array<number>(Math.max(fill, 0)).fill(0),
    ...rest,
  ];
  if (tail.length === 2) groups.splice(6, 2, ...tail);
  return groups.length === 8 &&
    groups.every((group) => group >= 0 && group <= 0xffff)
    ? groups
    : undefined;
}

/**
 * The rate-limit key for a client address. Every form of one IPv4 address
 * maps to the same key, and an IPv6 client is keyed by its /64, the smallest
 * block one subscriber normally controls, so address rotation inside it cannot
 * evade the limit.
 */
export function clientAddressKey(address: string | undefined): string {
  if (address === undefined || address.length === 0) return 'unknown';
  const bare = address.split('%')[0] ?? address;
  if (isIP(bare) === 4) return `v4:${bare}`;
  if (isIP(bare) !== 6) return `other:${bare}`;
  const groups = ipv6Groups(bare.toLowerCase());
  if (groups === undefined) return `other:${bare}`;
  const mapped =
    groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  if (mapped) {
    const high = groups[6] ?? 0;
    const low = groups[7] ?? 0;
    return `v4:${String(high >> 8)}.${String(high & 0xff)}.${String(low >> 8)}.${String(low & 0xff)}`;
  }
  return `v6:${groups
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(':')}::/64`;
}
