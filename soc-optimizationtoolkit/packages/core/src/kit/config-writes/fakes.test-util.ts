// Test doubles for the injected transport and clock. Not shipped into an app.

import type { ApiResponse, Clock, Request, RequestOptions } from './transport';

export interface Call {
  method: string;
  path: string;
  options?: RequestOptions;
}

/** A transport scripted by a handler, recording every call. */
export function fakeRequest(handler: (call: Call) => ApiResponse | Promise<ApiResponse>): { request: Request; calls: Call[] } {
  const calls: Call[] = [];
  const request: Request = async (method, path, options) => {
    const call = { method, path, options };
    calls.push(call);
    return handler(call);
  };
  return { request, calls };
}

/** A clock whose sleeps advance time instantly and are recorded. */
export function fakeClock(start = 1_700_000_000_000): Clock & { sleeps: number[]; advance(ms: number): void } {
  let t = start;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => t,
    advance(ms) {
      t += ms;
    },
    async sleep(ms, signal) {
      if (signal?.aborted) {
        const e = new Error('Aborted');
        e.name = 'AbortError';
        throw e;
      }
      sleeps.push(ms);
      t += ms;
    },
  };
}
