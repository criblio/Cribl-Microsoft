import type {
  AzureManagement,
  AzureManagementRequest,
  AzureManagementUrlRequest,
} from '../ports/azure-management';
import type { PortHttpResponse } from '../ports/http';

/**
 * In-memory {@link AzureManagement} for tests.
 *
 * Script responses with {@link respondWith}; they are consumed FIFO, one per
 * `request` OR `requestUrl` call (a single queue, so scripted pages of a
 * paginated list interleave naturally with other calls in call order). Every
 * path-based call is recorded in {@link calls} and every full-URL call in
 * {@link urlCalls} for assertions. A call with no scripted response left
 * throws, so tests fail loudly on unexpected extra calls.
 *
 * The fake implements the OPTIONAL `requestUrl` port method (nextLink
 * pagination). To exercise a caller's single-page fallback against an adapter
 * WITHOUT `requestUrl`, wrap the fake:
 * `const azure: AzureManagement = { request: (o) => fake.request(o) };`
 */
export class FakeAzureManagement implements AzureManagement {
  /** Every path-based request received, in call order. */
  readonly calls: AzureManagementRequest[] = [];
  /** Every full-URL request received, in call order. */
  readonly urlCalls: AzureManagementUrlRequest[] = [];
  private readonly queue: PortHttpResponse[] = [];

  /** Queue one or more responses, consumed in the order given. */
  respondWith(...responses: PortHttpResponse[]): void {
    this.queue.push(...responses);
  }

  async request(opts: AzureManagementRequest): Promise<PortHttpResponse> {
    this.calls.push(opts);
    return this.nextResponse(`${opts.method} ${opts.path}`);
  }

  async requestUrl(opts: AzureManagementUrlRequest): Promise<PortHttpResponse> {
    this.urlCalls.push(opts);
    return this.nextResponse(`${opts.method} ${opts.url}`);
  }

  private nextResponse(context: string): PortHttpResponse {
    const response = this.queue.shift();
    if (response === undefined) {
      throw new Error(`FakeAzureManagement: no scripted response for ${context}`);
    }
    return response;
  }
}
