// Azure resource-group helpers as pure functions (testable without rendering -- the renderer
// has no DOM test stack, so logic worth testing is extracted into pure modules).
//
// SentinelIntegration.tsx loaded Azure workspaces and resource groups in several effects,
// each duplicating the "derive resource groups from workspace metadata when the dedicated
// resource-group call fails" fallback. That derivation now lives here, once.

export interface AzureResourceGroup {
  name: string;
  location: string;
}

// Derive a unique resource-group list from workspace metadata: the first location seen for a
// given resource group wins. Used as a fallback when the dedicated resource-group call fails or
// returns nothing, so the UI can still populate the resource-group picker.
export function deriveResourceGroupsFromWorkspaces(
  workspaces: Array<{ resourceGroup: string; location: string }>,
): AzureResourceGroup[] {
  const byName = new Map<string, string>();
  for (const ws of workspaces) {
    if (ws.resourceGroup && !byName.has(ws.resourceGroup)) {
      byName.set(ws.resourceGroup, ws.location);
    }
  }
  return [...byName.entries()].map(([name, location]) => ({ name, location }));
}
