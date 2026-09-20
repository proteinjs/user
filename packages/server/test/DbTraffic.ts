import { Db, DbDriver } from '@proteinjs/db';

/**
 * What reached the database while a run executed — the outcome a "refused before any lookup"
 * claim rests on. A response code cannot prove it: a value that is wrongly let through still
 * matches no row and still answers 400, so the proof is that nothing was built and nothing ran.
 * - `lookups`: the filter of every read built through the package's `Db` — every `query`, which
 *   is also what a `get` is (the first row of one);
 * - `writes`: how many writes were built through it (`insert`, `update`, `delete`);
 * - `statements`: how many statements the driver ran, whoever built them.
 */
export class DbTraffic {
  private constructor(
    readonly lookups: unknown[],
    readonly writes: number,
    readonly statements: number
  ) {}

  /** The traffic of a run that never touched the database: `expect(traffic).toEqual(DbTraffic.NONE)`. */
  static readonly NONE = { lookups: [], writes: 0, statements: 0 };

  /** Runs `run` and answers what it resolved to beside the database traffic it caused. */
  static async during<T>(driver: DbDriver, run: () => Promise<T>): Promise<{ result: T; traffic: DbTraffic }> {
    const reads = jest.spyOn(Db.prototype, 'query');
    const writes = [
      jest.spyOn(Db.prototype, 'insert'),
      jest.spyOn(Db.prototype, 'update'),
      jest.spyOn(Db.prototype, 'delete'),
    ];
    const statements = [jest.spyOn(driver, 'runQuery'), jest.spyOn(driver, 'runDml')];
    try {
      const result = await run();
      const lookups = reads.mock.calls.map(([_table, filter]) => filter);
      return { result, traffic: new DbTraffic(lookups, DbTraffic.callCount(writes), DbTraffic.callCount(statements)) };
    } finally {
      [reads, ...writes, ...statements].forEach((spy) => spy.mockRestore());
    }
  }

  private static callCount(spies: { mock: { calls: unknown[] } }[]): number {
    return spies.reduce((count, spy) => count + spy.mock.calls.length, 0);
  }
}
