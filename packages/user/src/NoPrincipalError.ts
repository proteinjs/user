/**
 * A grant-scoped operation on a shared table ran with NO principal: access grants are enforced and the
 * current async context carries no session user — a background executor, a boot-time or deploy-time
 * migration, a socket event callback, a startup task's timer, any caller-scoped read reached from a
 * lineage no request seeded. Before this error the read fell through to the query builder's
 * `Must not pass in undefined for value in condition … {"field":"principal","operator":"="}` — a message
 * naming neither the table nor the caller, which cost a stack-walk per occurrence. This one is one line:
 * the table, the operation, and the first stack frame outside the libraries (this package's own files and
 * anything under node_modules), so the log line names the seat that read without a principal.
 */
export class NoPrincipalError extends Error {
  readonly table: string;
  readonly operation: string;
  /** The first stack frame outside this package and node_modules — the seat that ran with no principal. */
  readonly frame: string;

  constructor(args: { table: string; operation: string }) {
    super('');
    // An ES5 target: the Error the super call hands back needs this class's prototype put back.
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'NoPrincipalError';
    this.table = args.table;
    this.operation = args.operation;
    this.frame = NoPrincipalError.firstNonLibraryFrame(this.stack);
    this.message =
      `${args.table}: a ${args.operation} that needs a principal ran with none ` +
      `(no session user in this async context, access grants enforced) — at ${this.frame}`;
  }

  /**
   * The first `at …` frame that is neither under node_modules nor inside this package's own source
   * directory (`__dirname` — `src` or `dist/src`, wherever the package runs from), without the `at `.
   */
  static firstNonLibraryFrame(stack: string | undefined): string {
    const frames = (stack ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('at '));
    const frame = frames.find((line) => !NoPrincipalError.isLibraryFrame(line));
    return frame ? frame.slice('at '.length) : '(no frame outside the libraries)';
  }

  private static isLibraryFrame(frame: string): boolean {
    return (
      frame.includes('/node_modules/') ||
      frame.includes('\\node_modules\\') ||
      frame.includes(__dirname) ||
      frame.includes('node:internal') ||
      !/[/\\]/.test(frame)
    );
  }
}
