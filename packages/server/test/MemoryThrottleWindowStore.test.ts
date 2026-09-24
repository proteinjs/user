import { MemoryThrottleWindowStore } from '../src/throttle/MemoryThrottleWindowStore';

/**
 * The library's own window store (the default when no shared store is registered): a count per
 * key inside a window that opens at the key's first count and lasts the window it was given (its
 * TTL), then is gone. `increment` answers the count including this one; `read` only reads;
 * `clear` forgets. Bounded like `SlidingWindow`: at the bound the oldest-touched key goes first.
 */
describe('MemoryThrottleWindowStore', () => {
  const MINUTE = 60 * 1000;
  let now = 1_700_000_000_000;
  const clock = () => now;

  it('counts each attempt inside the window, this one included; read only reads', async () => {
    const store = new MemoryThrottleWindowStore({ now: clock });

    expect(await store.read('a')).toBe(0);
    expect([
      await store.increment('a', 10 * MINUTE),
      await store.increment('a', 10 * MINUTE),
      await store.increment('a', 10 * MINUTE),
    ]).toEqual([1, 2, 3]);
    expect(await store.read('a')).toBe(3);
    expect(await store.read('a')).toBe(3);
  });

  it('keeps each key in its own window', async () => {
    const store = new MemoryThrottleWindowStore({ now: clock });
    await store.increment('a', 10 * MINUTE);
    await store.increment('a', 10 * MINUTE);

    expect(await store.increment('b', 10 * MINUTE)).toBe(1);
    expect(await store.read('a')).toBe(2);
  });

  it('the window is a TTL from the first count: counts inside it add up, and at its end the key is gone', async () => {
    const store = new MemoryThrottleWindowStore({ now: clock });
    const start = now;
    await store.increment('a', 10 * MINUTE);
    now = start + 9 * MINUTE;
    expect(await store.increment('a', 10 * MINUTE)).toBe(2); // a later count never extends the window

    now = start + 10 * MINUTE;
    expect(await store.read('a')).toBe(0);
    expect(await store.increment('a', 10 * MINUTE)).toBe(1); // a fresh window
    now = start + 19 * MINUTE;
    expect(await store.read('a')).toBe(1);
  });

  it('clear forgets the key', async () => {
    const store = new MemoryThrottleWindowStore({ now: clock });
    await store.increment('a', 10 * MINUTE);
    await store.increment('a', 10 * MINUTE);

    await store.clear('a');

    expect(await store.read('a')).toBe(0);
    expect(await store.increment('a', 10 * MINUTE)).toBe(1);
    await store.clear('never-seen'); // nothing to forget, nothing thrown
  });

  it('bounds the keys it holds: at the bound the oldest-touched key is forgotten first', async () => {
    const store = new MemoryThrottleWindowStore({ maxKeys: 2, now: clock });
    await store.increment('a', 10 * MINUTE);
    await store.increment('b', 10 * MINUTE);
    await store.increment('a', 10 * MINUTE); // 'a' is now the most recently touched

    await store.increment('c', 10 * MINUTE); // at the bound: 'b' goes

    expect(await store.read('a')).toBe(2);
    expect(await store.read('b')).toBe(0);
    expect(await store.read('c')).toBe(1);
  });
});
