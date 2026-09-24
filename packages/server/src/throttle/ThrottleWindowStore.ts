import { Loadable } from '@proteinjs/reflection';

/**
 * Where a throttle counts the windows that must hold across server processes — the windows keyed
 * on something other than the device (the sign-in door's per-account window, the reset door's
 * per-address window; see `StoredWindow`). A window here is a TTL: it opens at a key's first count
 * and lasts the `windowMs` that count was given; counts inside it add up; at its end the key is
 * gone and the next count opens a fresh window.
 *
 * The library's own store is `MemoryThrottleWindowStore` — per process, which is right for tests
 * and single-process servers. A deployment of several processes registers a SHARED store (one
 * every process reads and writes) through `DefaultThrottleWindowStoreFactory`, so a window is one
 * count across replicas and survives a restart or a deploy.
 *
 * Keys are digests (see `RequestDigests`) prefixed with the window's name — never an address — so
 * nothing identifying reaches the store.
 */
export interface ThrottleWindowStore {
  /**
   * Count one attempt for `key` and answer how many the key holds inside its window, this one
   * included. The first count opens the window with `windowMs` as its TTL; later counts never
   * extend it. Atomic across every caller of the store: attempts in flight at once each get their
   * own count.
   */
  increment(key: string, windowMs: number): Promise<number>;

  /** How many attempts `key` holds inside its window (0 when it holds none). */
  read(key: string): Promise<number>;

  /** Forget `key`'s window. */
  clear(key: string): Promise<void>;
}

/**
 * The seam a consuming application registers its shared store through (discovered like every
 * other `Default…Factory`). Without a registration the counted windows use the library's own
 * per-process store.
 */
export interface DefaultThrottleWindowStoreFactory extends Loadable {
  getStore(): ThrottleWindowStore;
}
