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
 * FAILS CLOSED, deliberately: when the store fails — an error, or no answer within
 * `STORE_DEADLINE_MS` (a client queueing commands while it reconnects never answers at all) —
 * `hit` answers "refuse". A door that cannot count cannot tell guessing from a person, and the
 * windows exist to stop guessing; the person is told to try again in a few minutes, which is true
 * the moment the store answers. The outage is one WARN line per window, however many tries meet
 * it, and one INFO line when the store answers again. `clear` meeting a failed store leaves the
 * window to end on its own (its TTL) rather than failing the door that proved the account.
 */
export class StoredWindow {
  /** How long a door waits on the store before refusing: well above a healthy store's milliseconds. */
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
   * attempt never extends it). A failed store answers `true` (see the class comment).
   */
  async hit(key: string): Promise<boolean> {
    try {
      const count = await this.withDeadline((store) => store.increment(this.key(key), this.windowMs));
      this.answered();
      return count > this.limit;
    } catch (error) {
      this.failed(error);
      return true;
    }
  }

  /** Forget `key`'s window. A failed store leaves it to end on its own. */
  async clear(key: string): Promise<void> {
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
      message: 'Throttle window store unavailable; refusing the counted tries until it answers',
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
