import type { AzureManagement, AzureManagementRequest } from '../ports/azure-management';
import type { PortHttpResponse } from '../ports/http';

/**
 * In-memory {@link AzureManagement} for tests.
 *
 * Script responses with {@link respondWith}; they are consumed FIFO, one per
 * `request` call. Every call is recorded in {@link calls} for assertions.
 * A `request` with no scripted response left throws, so tests fail loudly on
 * unexpected extra calls.
 */
export class FakeAzureManagement implements AzureManagement {
  /** Every request received, in call order. */
  readonly calls: AzureManagementRequest[] = [];
  private readonly queue: PortHttpResponse[] = [];

  /** Queue one or more responses, consumed in the order given. */
  respondWith(...responses: PortHttpResponse[]): void {
    this.queue.push(...responses);
  }

  async request(opts: AzureManagementRequest): Promise<PortHttpResponse> {
    this.calls.push(opts);
    const response = this.queue.shift();
    if (response === undefined) {
      throw new Error(
        `FakeAzureManagement: no scripted response for ${opts.method} ${opts.path}`,
      );
    }
    return response;
  }
}
