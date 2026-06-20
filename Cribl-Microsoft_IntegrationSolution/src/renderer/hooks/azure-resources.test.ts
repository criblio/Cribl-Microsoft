import { describe, it, expect } from 'vitest';
import { deriveResourceGroupsFromWorkspaces } from './azure-resources';

describe('deriveResourceGroupsFromWorkspaces', () => {
  it('returns unique resource groups, keeping the first location seen per group', () => {
    const rgs = deriveResourceGroupsFromWorkspaces([
      { resourceGroup: 'rg-a', location: 'eastus' },
      { resourceGroup: 'rg-b', location: 'westus' },
      { resourceGroup: 'rg-a', location: 'centralus' }, // duplicate group: first location wins
    ]);
    expect(rgs).toEqual([
      { name: 'rg-a', location: 'eastus' },
      { name: 'rg-b', location: 'westus' },
    ]);
  });

  it('skips workspaces with no resource group', () => {
    const rgs = deriveResourceGroupsFromWorkspaces([
      { resourceGroup: '', location: 'eastus' },
      { resourceGroup: 'rg-x', location: 'westus' },
    ]);
    expect(rgs).toEqual([{ name: 'rg-x', location: 'westus' }]);
  });

  it('returns an empty list when there are no workspaces', () => {
    expect(deriveResourceGroupsFromWorkspaces([])).toEqual([]);
  });
});
