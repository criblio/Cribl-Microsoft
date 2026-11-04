/**
 * RequestPacer port - spend one request of a rolling-minute budget before a
 * proxied request goes out.
 *
 * The Cribl app proxy allows about 100 requests a minute for the whole app, so
 * every request a flow sends - not only the ones its Azure port carries, but a
 * tenant session's proof reads and token mints too - must spend the same
 * budget. usecases/onboard-batch `createRequestPacer` builds one over the
 * shell's clock and sleep; tests pass a counting fake.
 */

/** Anything with an `aborted` flag; an AbortSignal satisfies it. */
export interface PacingSignal {
  readonly aborted: boolean;
}

export interface RequestPacer {
  /**
   * Wait until every budget has room, then spend one request. With a signal,
   * rejects once it has aborted - before waiting or after it - and spends
   * nothing, so a cancelled flow sends no further request. Without one it
   * never rejects (a restore that must go out whatever happened).
   */
  acquire(signal?: PacingSignal): Promise<void>;
}
