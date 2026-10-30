// CORE-LOCAL STAND-IN for claude-kit skills/cribl-config-writes/reference/transport.ts.
//
// NOT A COPY, and not tracked by kitDrift (.claude-kit.json lists the kit file under
// `skipped` with the reason). The kit's transport also defines `systemClock`, whose
// `now` reads Date.now and whose `sleep` arms setTimeout. packages/core is pure - no
// clock, no timers (repo CLAUDE.md, packages/core/CONTEXT.md) - so this module keeps
// ONLY the types and the two pure helpers. The adopted kit files import './transport'
// and resolve here unedited. Any real clock belongs to the shell (BATCH_PACING) or
// the UI; kit-purity.test.ts fails if `systemClock` or a timer appears in this folder.
//
// The declarations below are the kit's, word for word, so an adopted file type-checks
// exactly as it does in the kit.

/** What a call carries. `contentType` defaults to JSON when `body` is set. */
export interface RequestOptions {
  body?: unknown;
  contentType?: string;
  signal?: AbortSignal;
}

/**
 * One response. `body` is the parsed JSON when the response is JSON, otherwise the raw text —
 * Search's `/results` endpoint answers NDJSON, which only parses line by line.
 * A transport resolves on ANY HTTP status and rejects only on transport failure, so a 403 and a
 * 500 reach the caller as data and can be told apart.
 */
export interface ApiResponse {
  status: number;
  body: unknown;
}

/** `path` is relative to the API base (`/api/v1`), e.g. `/m/default_search/search/jobs`. */
export type Request = (method: string, path: string, options?: RequestOptions) => Promise<ApiResponse>;

/** Time, injected. `sleep` must reject with an AbortError-like error when `signal` aborts. */
export interface Clock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export function abortError(): Error {
  const err = new Error('Aborted');
  err.name = 'AbortError';
  return err;
}

export const isOk = (status: number) => status >= 200 && status < 300;
