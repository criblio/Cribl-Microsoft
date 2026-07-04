import { describe, expect, it } from 'vitest';
import { FakeAzureManagement } from './fake-azure-management';

describe('FakeAzureManagement', () => {
  it('serves scripted responses FIFO and records every call', async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith({ status: 200, body: { value: [] } }, { status: 201, body: { id: 'dcr-1' } });

    const first = await azure.request({
      method: 'GET',
      path: '/subscriptions/sub-1/resourceGroups',
      apiVersion: '2021-04-01',
    });
    const second = await azure.request({
      method: 'PUT',
      path: '/subscriptions/sub-1/resourceGroups/rg/providers/Microsoft.Insights/dataCollectionRules/dcr-1',
      apiVersion: '2023-03-11',
      body: { location: 'eastus' },
      query: { createMode: 'default' },
    });

    expect(first).toEqual({ status: 200, body: { value: [] } });
    expect(second.status).toBe(201);
    expect(azure.calls).toHaveLength(2);
    expect(azure.calls[0]!.method).toBe('GET');
    expect(azure.calls[1]!.body).toEqual({ location: 'eastus' });
    expect(azure.calls[1]!.query).toEqual({ createMode: 'default' });
  });

  it('throws (and still records the call) when the response queue is exhausted', async () => {
    const azure = new FakeAzureManagement();
    await expect(
      azure.request({ method: 'DELETE', path: '/subscriptions/sub-1', apiVersion: '2021-04-01' }),
    ).rejects.toThrow('no scripted response for DELETE /subscriptions/sub-1');
    expect(azure.calls).toHaveLength(1);
  });

  it('serves requestUrl (nextLink pages) from the same FIFO queue and records urlCalls', async () => {
    const azure = new FakeAzureManagement();
    const nextLink = 'https://management.azure.com/subscriptions/sub-1/resourcegroups?api-version=2021-04-01&%24skiptoken=abc';
    azure.respondWith(
      { status: 200, body: { value: [{ name: 'rg-1' }], nextLink } },
      { status: 200, body: { value: [{ name: 'rg-2' }] } },
    );

    const page1 = await azure.request({
      method: 'GET',
      path: '/subscriptions/sub-1/resourcegroups',
      apiVersion: '2021-04-01',
    });
    const page2 = await azure.requestUrl({ method: 'GET', url: nextLink });

    expect(page1.status).toBe(200);
    expect(page2).toEqual({ status: 200, body: { value: [{ name: 'rg-2' }] } });
    expect(azure.calls).toHaveLength(1);
    expect(azure.urlCalls).toEqual([{ method: 'GET', url: nextLink }]);
  });

  it('throws on requestUrl when the response queue is exhausted', async () => {
    const azure = new FakeAzureManagement();
    await expect(
      azure.requestUrl({ method: 'GET', url: 'https://management.azure.com/subscriptions?x=1' }),
    ).rejects.toThrow('no scripted response for GET https://management.azure.com/subscriptions?x=1');
    expect(azure.urlCalls).toHaveLength(1);
  });

  it('passes non-2xx scripted responses through as resolutions, not rejections', async () => {
    const azure = new FakeAzureManagement();
    azure.respondWith({ status: 409, body: { error: { code: 'Conflict' } } });
    const response = await azure.request({
      method: 'PUT',
      path: '/subscriptions/sub-1/whatever',
      apiVersion: '2021-04-01',
    });
    expect(response.status).toBe(409);
  });
});
