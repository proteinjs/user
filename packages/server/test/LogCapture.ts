import { createHash } from 'crypto';

/**
 * Everything the process wrote while a run executed, as a log reader would see it: every
 * `console` call at every level (where the default log writer sends each entry, whichever logger
 * produced it) and every direct stdout/stderr write, one string per write. Nothing is filtered by
 * logger name or level, so the capture holds exactly what the default configuration emits.
 */
export class LogCapture {
  /** How many leading characters of a token count as the token showing up in a log. */
  private static readonly TOKEN_PREFIX_LENGTH = 12;
  /**
   * An e-mail address, as the house's log check reads one: bare, or URL-encoded (`%40` for the `@`)
   * as a logged request path carries it — a check that read only the bare spelling missed the one
   * place an address is known to reach a log, the request log's URL.
   */
  private static readonly ADDRESS_SHAPE = /[A-Za-z0-9._%+-]+(?:@|%40)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

  private constructor(readonly lines: string[]) {}

  static async during(run: () => Promise<void>): Promise<LogCapture> {
    const lines: string[] = [];
    const consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      jest.spyOn(console, level).mockImplementation((...parts: unknown[]) => {
        lines.push(parts.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' '));
      })
    );
    const streamSpies = [process.stdout, process.stderr].map((stream) => {
      const write = stream.write.bind(stream) as (...args: unknown[]) => boolean;
      return jest.spyOn(stream, 'write').mockImplementation(((...args: unknown[]) => {
        lines.push(String(args[0]));
        return write(...args);
      }) as never);
    });
    try {
      await run();
    } finally {
      [...consoleSpies, ...streamSpies].forEach((spy) => spy.mockRestore());
    }
    return new LogCapture(lines);
  }

  get text(): string {
    return this.lines.join('\n');
  }

  /** Every e-mail address the log holds, in order of appearance — a log names people by their digests, never by address. */
  get addresses(): string[] {
    return this.text.match(LogCapture.ADDRESS_SHAPE) ?? [];
  }

  /** The capture narrowed to the writes that contain `text` — one door's lines, read with the same readers. */
  linesContaining(text: string): LogCapture {
    return new LogCapture(this.lines.filter((line) => line.includes(text)));
  }

  /**
   * Fails unless the log is free of `token` in every form that would let a log reader act on it
   * or tie a line to a row: the token, the SHA-256 digest a row stores for it, and the token's
   * own leading characters — a log reference to a token is cut from its digest, never from the
   * token. Letter case is ignored.
   */
  expectFreeOf(token: string): void {
    const text = this.text.toLowerCase();
    const digest = createHash('sha256').update(token).digest('hex');
    expect(text).not.toContain(token.toLowerCase());
    expect(text).not.toContain(digest);
    expect(text).not.toContain(token.slice(0, LogCapture.TOKEN_PREFIX_LENGTH).toLowerCase());
  }
}
