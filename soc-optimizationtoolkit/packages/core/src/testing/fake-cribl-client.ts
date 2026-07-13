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

  /**
   * The group's existing outputs, served to the destination collision-scan
   * GET (2026-07-12) WITHOUT consuming the scripted queue (same rationale as
   * FakeAzureManagement.dataCollectionRulesList). UNDEFINED (the default)
   * disables the special-casing - the call falls through to the queue.
   */
  outputsList: unknown[] | undefined = undefined;

  constructor(init?: { outputsList?: unknown[] }) {
    if (init?.outputsList !== undefined) {
      this.outputsList = init.outputsList;
    }
  }

  async request(opts: CriblRequest): Promise<PortHttpResponse> {
    this.calls.push(opts);
    if (
      this.outputsList !== undefined &&
      opts.method === "GET" &&
      opts.path === "/system/outputs"
    ) {
      return { status: 200, body: { items: this.outputsList } };
    }
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
