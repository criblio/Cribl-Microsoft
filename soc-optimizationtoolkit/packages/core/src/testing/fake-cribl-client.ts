import type { CriblClient, CriblGroupSummary, CriblRequest } from '../ports/cribl-client';
import type { PortHttpResponse } from '../ports/http';

/**
 * In-memory {@link CriblClient} for tests.
 *
 * Script `request` responses with {@link respondWith}; they are consumed
 * FIFO, one per call, and every call is recorded in {@link calls}. A call
 * with no scripted response left throws, so tests fail loudly on unexpected
 * extra calls. `listGroups` returns the mutable {@link groups} array and
 * counts its invocations in {@link listGroupsCalls}.
 */
export class FakeCriblClient implements CriblClient {
  /** Every request received, in call order. */
  readonly calls: CriblRequest[] = [];
  /** Groups returned by listGroups; set directly in test arrange steps. */
  groups: CriblGroupSummary[] = [];
  /** Number of times listGroups has been called. */
  listGroupsCalls = 0;
  private readonly queue: PortHttpResponse[] = [];

  /** Queue one or more responses for `request`, consumed in the order given. */
  respondWith(...responses: PortHttpResponse[]): void {
    this.queue.push(...responses);
  }

  async request(opts: CriblRequest): Promise<PortHttpResponse> {
    this.calls.push(opts);
    const response = this.queue.shift();
    if (response === undefined) {
      throw new Error(`FakeCriblClient: no scripted response for ${opts.method} ${opts.path}`);
    }
    return response;
  }

  async listGroups(): Promise<CriblGroupSummary[]> {
    this.listGroupsCalls++;
    return this.groups.map((group) => ({ ...group }));
  }
}
