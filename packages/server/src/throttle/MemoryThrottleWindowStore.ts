import { ThrottleWindowStore } from './ThrottleWindowStore';

/**
 * The library's own `ThrottleWindowStore`: windows held in this process's memory. It is the
 * default when no shared store is registered — right for tests and single-process servers; in a
 * deployment of several processes each keeps its own counts (register a shared store there).
 *
 * BOUNDED like `SlidingWindow`: at most `maxKeys` keys are held; at the bound the oldest-touched
 * key is forgotten first, so a flood of fresh keys degrades the friction before it grows memory.
 */
export class MemoryThrottleWindowStore implements ThrottleWindowStore {
  private static readonly DEFAULT_MAX_KEYS = 10_000;

  private readonly maxKeys: number;
  private readonly now: () => number;
  /** key → its count and when its window ends, in touch order. */
  private readonly windows = new Map<string, { count: number; expiresAt: number }>();

  constructor(options?: { maxKeys?: number; now?: () => number }) {
    this.maxKeys = options?.maxKeys ?? MemoryThrottleWindowStore.DEFAULT_MAX_KEYS;
    this.now = options?.now ?? Date.now;
  }

  async increment(key: string, windowMs: number): Promise<number> {
    const window = this.live(key) ?? { count: 0, expiresAt: this.now() + windowMs };
    window.count++;
    this.touch(key, window);
    return window.count;
  }

  async read(key: string): Promise<number> {
    return this.live(key)?.count ?? 0;
  }

  async clear(key: string): Promise<void> {
    this.windows.delete(key);
  }

  /** `key`'s window while it lasts; an ended one is dropped. */
  private live(key: string): { count: number; expiresAt: number } | undefined {
    const window = this.windows.get(key);
    if (window && window.expiresAt <= this.now()) {
      this.windows.delete(key);
      return undefined;
    }
    return window;
  }

  /** Store `key`'s window as the most recently touched, evicting the oldest-touched key at the bound. */
  private touch(key: string, window: { count: number; expiresAt: number }): void {
    if (!this.windows.has(key) && this.windows.size >= this.maxKeys) {
      const oldest = this.windows.keys().next().value;
      if (oldest !== undefined) {
        this.windows.delete(oldest);
      }
    }
    this.windows.delete(key);
    this.windows.set(key, window);
  }
}
