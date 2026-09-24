import { SourceRepository } from '@proteinjs/reflection';
import { Logger } from '@proteinjs/logger';
import { DefaultThrottleWindowStoreFactory, ThrottleWindowStore } from './ThrottleWindowStore';
import { MemoryThrottleWindowStore } from './MemoryThrottleWindowStore';

/**
 * A throttle window counted in a `ThrottleWindowStore` — the windows that must hold across server
 * processes (the sign-in door's per-account window, the reset door's per-address window). The
 * store is the one a consuming application registers through `DefaultThrottleWindowStoreFactory`
 * (read on every call, so a registration made after start-up is honoured), else the library's own
 * per-process `MemoryThrottleWindowStore`. The window's name prefixes every key, so windows sharing
 * one store never meet.
 *
 * THE NAMED FALLBACK when the store fails — an error, or no answer within `STORE_DEADLINE_MS` (a
 * client queueing commands while it reconnects never answers at all): the window COUNTS IN THIS
 * PROCESS'S MEMORY (the `MemoryThrottleWindowStore` it already holds) until the store answers
 * again — `hit` counts and judges there, `clear` clears there. A door that cannot reach the shared
 * count still counts the way a single process does: each process holds its own count for the
 * outage (at most the limit per process), behind the per-client window and any per-address limit
 * in front of the servers — where refusing every try would lock out every person for a blip with
 * a sentence that is untrue for them. The outage is one WARN line per window saying so, however
 * many tries meet it, and one INFO line when the store answers again; the store then counts again
 * from what it holds (the outage's tries were this process's own). A success clears the memory
 * window as well as the store's, so an account that proved itself starts clean in both.
 */
export class StoredWindow {
  /** How long a door waits on the store before counting in memory: well above a healthy store's milliseconds. */
  private static readonly STORE_DEADLINE_MS = 2000;
  private static readonly FACTORY = '@proteinjs/user-server/DefaultThrottleWindowStoreFactory';

  private readonly name: string;
  private readonly windowMs: number;
  private readonly limit: number;
  private readonly memory: ThrottleWindowStore;
  private readonly logger = new Logger({ name: 'StoredWindow' });
  /** Whether the last call met a failed store — the outage is logged once, on the way in. */
  private storeUnavailable = false;

  constructor(options: { name: string; windowMs: number; limit: number; now?: () => number }) {
    this.name = options.name;
    this.windowMs = options.windowMs;
    this.limit = options.limit;
    this.memory = new MemoryThrottleWindowStore({ now: options.now });
  }

  /**
   * Count an attempt for `key` and answer whether it is over the window — `true` means refuse.
   * Every attempt is counted (the window's end is fixed at its first count, so counting a refused
   * attempt never extends it). A failed store counts it in this process's memory (see the class comment).
   */
  async hit(key: string): Promise<boolean> {
    try {
      const count = await this.withDeadline((store) => store.increment(this.key(key), this.windowMs));
      this.answered();
      return count > this.limit;
    } catch (error) {
      this.failed(error);
      return (await this.memory.increment(this.key(key), this.windowMs)) > this.limit;
    }
  }

  /** Forget `key`'s window — in this process's memory, and in the store when it answers. */
  async clear(key: string): Promise<void> {
    await this.memory.clear(this.key(key));
    try {
      await this.withDeadline((store) => store.clear(this.key(key)));
      this.answered();
    } catch (error) {
      this.failed(error);
    }
  }

  /** The registered shared store, else the library's own. */
  private store(): ThrottleWindowStore {
    const factory = SourceRepository.get().object<DefaultThrottleWindowStoreFactory>(StoredWindow.FACTORY);
    return factory ? factory.getStore() : this.memory;
  }

  private key(key: string): string {
    return `${this.name}:${key}`;
  }

  private async withDeadline<T>(call: (store: ThrottleWindowStore) => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`no answer within ${StoredWindow.STORE_DEADLINE_MS} ms`)),
        StoredWindow.STORE_DEADLINE_MS
      );
    });
    try {
      return await Promise.race([call(this.store()), deadline]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  private failed(error: unknown): void {
    if (this.storeUnavailable) {
      return;
    }
    this.storeUnavailable = true;
    this.logger.warn({
      message: "Throttle window store unavailable; counting in this process's memory until it answers",
      obj: { window: this.name, errorMessage: error instanceof Error ? error.message : String(error) },
    });
  }

  private answered(): void {
    if (!this.storeUnavailable) {
      return;
    }
    this.storeUnavailable = false;
    this.logger.info({ message: 'Throttle window store answering again', obj: { window: this.name } });
  }
}
