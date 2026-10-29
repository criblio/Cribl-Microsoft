/**
 * Workspace inventory (MIG-2): discover workspaces across the tenant and
 * inventory one - tables, sources and 30-day daily average volume.
 */
export {
  discoverWorkspaces,
  inventoryWorkspace,
  runWorkspaceQuery,
  SOURCE_BATCH_SIZE,
  WORKSPACE_QUERY_API_VERSION,
  workspaceArmId,
} from "./workspace-inventory";
export type {
  DiscoveredWorkspace,
  DiscoveryFailure,
  SentinelState,
  WorkspaceDiscovery,
  WorkspaceInventory,
} from "./workspace-inventory";
