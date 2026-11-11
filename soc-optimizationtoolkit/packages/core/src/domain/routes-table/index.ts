/**
 * routes-table domain barrel (DBT-301): a worker group's routing table read
 * without ever mistaking an unknown shape for an empty table, and the pure
 * route insert (position, conflicts, fresh re-check) the route-insert usecase
 * writes with.
 */

export type {
  NewRoute,
  RouteConflict,
  RouteInsertRefusal,
  RouteInsertRequest,
  RouteInsertResult,
  RoutePosition,
  RouteRowSnapshot,
  RoutesTableParse,
  RoutesTableRead,
} from "./routes-table";
export {
  describeConflict,
  describeRoute,
  insertRoutes,
  parseRoutesListing,
  parseRoutesTable,
  routeConflicts,
  routeInsertFreshCheck,
  routeRow,
} from "./routes-table";
