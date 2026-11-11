/**
 * Data allowances (MIG-14): run the licence, benefit, machine and plan reads
 * behind the Data Volume Inventory's allowance cards and assemble one result.
 *
 * The public surface is the two usecases, the result types the UI renders and
 * the catalog lookups a screen needs. The KQL, parsers and arithmetic in
 * domain/data-allowances stay off the @soc/core barrel (the AZR-53 rule): the
 * tests import those modules directly.
 */
export { compareTenant, readDataAllowances } from "./data-allowances";
export type {
  DataAllowances,
  DataAllowancesOptions,
  GrantView,
  LicenceRead,
} from "./data-allowances";
export {
  ALLOWANCE_CATALOG_AS_OF,
  ALLOWANCE_SOURCES,
  allowanceFor,
  E5_MB_PER_SEAT_PER_DAY,
  SERVERS_MB_PER_MACHINE_PER_DAY,
} from "../../domain/data-allowances/allowance-catalog";
export type { AllowanceTag, GrantId } from "../../domain/data-allowances/allowance-catalog";
export type { GrantUsage } from "../../domain/data-allowances/benefit-usage";
export { serversGranted } from "../../domain/data-allowances/granted";
export type {
  AllowanceUnknown,
  CompleteDays,
  GrantWindowTotals,
  LicenceCount,
  WindowNet,
  WindowTotals,
} from "../../domain/data-allowances/window-totals";
export type {
  CrossCheck,
  LicenceRow,
  ServersSubscriptionRow,
} from "../../domain/data-allowances/granted";
