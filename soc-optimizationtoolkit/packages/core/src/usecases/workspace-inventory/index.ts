/**
 * Workspace inventory (MIG-2): discover workspaces across the tenant and
 * inventory one - tables, sources and 30-day daily average volume.
 *
 * The public surface is the two usecases and the types their results carry.
 * The KQL, parser and fold in domain/workspace-inventory stay off the
 * @soc/core barrel: nothing outside this feature imports them (the AZR-53
 * rule), and the tests import the modules directly.
 */
export { discoverWorkspaces, inventoryWorkspace } from "./workspace-inventory";
export type {
  DiscoveredWorkspace,
  DiscoveryFailure,
  SentinelState,
  WorkspaceDiscovery,
  WorkspaceInventory,
} from "./workspace-inventory";
export type {
  InventorySource,
  InventoryTable,
  TableSources,
} from "../../domain/workspace-inventory";
