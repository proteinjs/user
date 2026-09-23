import { SlidingWindow } from '../src/throttle/SlidingWindow';

/**
 * The per-key sliding window every throttled door shares (the sign-in and reset doors here, the
 * invite-request door in the consuming app): `hit` records and answers whether the key is over,
 * `isOver` only reads, `record` only counts, `clear` forgets. Attempts refused as over the window
 * are not counted, so a key drains exactly one window after its last counted attempt.
 */
describe('SlidingWindow', () => {
  const MINUTE = 60 * 1000;
  let now = 1_700_000_000_000;
  const clock = () => now;

  it('admits up to the limit inside the window and refuses the next', () => {
    const window = new SlidingWindow({ windowMs: 10 * MINUTE, limit: 3, now: clock });

    expect([window.hit('a'), window.hit('a'), window.hit('a')]).toEqual([false, false, false]);
    expect(window.hit('a')).toBe(true);
    expect(window.isOver('a')).toBe(true);
  });

  it('keeps each key in its own window', () => {
    const window = new SlidingWindow({ windowMs: 10 * MINUTE, limit: 2, now: clock });
    window.hit('a');
    window.hit('a');

    expect(window.hit('a')).toBe(true);
    expect(window.hit('b')).toBe(false);
  });

  it('drains: an attempt older than the window no longer counts, and refused attempts never counted', () => {
    const window = new SlidingWindow({ windowMs: 10 * MINUTE, limit: 2, now: clock });
    window.hit('a');
    now += 4 * MINUTE;
    window.hit('a');
    now += 5 * MINUTE;
    expect(window.hit('a')).toBe(true); // both counted attempts are still inside the window

    now += 1 * MINUTE + 1; // the first counted attempt left the window; the refused one never counted
    expect(window.hit('a')).toBe(false);
    expect(window.hit('a')).toBe(true);
  });

  it('isOver reads without counting; record counts without answering; clear forgets the key', () => {
    const window = new SlidingWindow({ windowMs: 10 * MINUTE, limit: 2, now: clock });

    expect(window.isOver('a')).toBe(false);
    expect(window.isOver('a')).toBe(false);
    window.record('a');
    expect(window.isOver('a')).toBe(false);
    window.record('a');
    expect(window.isOver('a')).toBe(true);

    window.clear('a');
    expect(window.isOver('a')).toBe(false);
  });

  it('forgive uncounts the latest attempt only', () => {
    const window = new SlidingWindow({ windowMs: 10 * MINUTE, limit: 2, now: clock });
    window.hit('a');
    window.hit('a');
    expect(window.isOver('a')).toBe(true);

    window.forgive('a');

    expect(window.isOver('a')).toBe(false);
    expect(window.hit('a')).toBe(false);
    expect(window.hit('a')).toBe(true);
    window.forgive('b'); // a key never seen: nothing to uncount, nothing thrown
    expect(window.isOver('b')).toBe(false);
  });

  it('bounds the keys it tracks: at the bound the oldest-touched key is forgotten first', () => {
    const window = new SlidingWindow({ windowMs: 10 * MINUTE, limit: 1, maxKeys: 2, now: clock });
    window.hit('a');
    window.hit('b');
    window.hit('a'); // refused, but 'a' is now the most recently touched

    window.hit('c'); // at the bound: 'b' (oldest-touched) is forgotten

    expect(window.isOver('a')).toBe(true);
    expect(window.isOver('b')).toBe(false);
    expect(window.isOver('c')).toBe(true);
  });
});
