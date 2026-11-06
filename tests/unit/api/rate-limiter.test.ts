import { describe, expect, it } from 'vitest';

import {
  clientAddressKey,
  FixedWindowLimiter,
} from '../../../src/api/rate-limiter.js';

describe('clientAddressKey', () => {
  it.each([
    ['192.0.2.7', 'v4:192.0.2.7'],
    ['::ffff:192.0.2.7', 'v4:192.0.2.7'],
    ['::FFFF:C000:0207', 'v4:192.0.2.7'],
    ['0:0:0:0:0:ffff:192.0.2.7', 'v4:192.0.2.7'],
    ['2001:db8:1:2::1', 'v6:2001:db8:1:2::/64'],
    ['2001:DB8:1:2:ffff:ffff:ffff:ffff', 'v6:2001:db8:1:2::/64'],
    ['2001:0db8:0001:0002:0:0:0:9', 'v6:2001:db8:1:2::/64'],
    ['fe80::1%en0', 'v6:fe80:0:0:0::/64'],
    ['::1', 'v6:0:0:0:0::/64'],
    ['::', 'v6:0:0:0:0::/64'],
    [undefined, 'unknown'],
    ['', 'unknown'],
    ['not-an-address', 'other:not-an-address'],
  ])('maps %s to %s', (address, key) => {
    expect(clientAddressKey(address)).toBe(key);
  });

  it('separates distinct /64 prefixes and distinct IPv4 hosts', () => {
    expect(clientAddressKey('2001:db8:1:2::1')).not.toBe(
      clientAddressKey('2001:db8:1:3::1'),
    );
    expect(clientAddressKey('192.0.2.7')).not.toBe(
      clientAddressKey('192.0.2.8'),
    );
  });
});

describe('FixedWindowLimiter', () => {
  it('reports the seconds left in the window, never less than one', () => {
    let now = 0;
    const limiter = new FixedWindowLimiter(1, 60_000, 10, {
      now: () => new Date(now),
    });

    expect(limiter.take('k')).toEqual({ allowed: true, retryAfterSeconds: 60 });
    now = 59_999;
    expect(limiter.take('k')).toEqual({ allowed: false, retryAfterSeconds: 1 });
    now = 60_000;
    expect(limiter.take('k')).toEqual({ allowed: true, retryAfterSeconds: 60 });
  });

  it('keeps a blocked key as most recently used so it is not evicted first', () => {
    const limiter = new FixedWindowLimiter(1, 60_000, 2, {
      now: () => new Date(0),
    });

    limiter.take('abuser');
    limiter.take('other');
    expect(limiter.take('abuser').allowed).toBe(false);
    limiter.take('fresh');

    expect(limiter.take('abuser').allowed).toBe(false);
  });
});
