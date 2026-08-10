/**
 * Workspace table listing: the tables an operator can point DCR gap analysis at.
 * Keeps the body of the GET that permission-preflight already issues as its
 * `table.read` probe and discards.
 */
export {
  listWorkspaceTables,
  parseWorkspaceTable,
  workspaceTablesPath,
} from "./workspace-tables";
export type {
  WorkspaceTable,
  WorkspaceTableKind,
  WorkspaceTablesTarget,
} from "./workspace-tables";
