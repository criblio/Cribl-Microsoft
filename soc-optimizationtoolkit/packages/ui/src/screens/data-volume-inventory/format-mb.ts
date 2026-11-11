/**
 * Volume formatting shared by the inventory and its allowance cards. Its own
 * module so the two state modules can both use it without importing each other.
 */

/** Decimal units, matching Usage's MB (10^6 bytes) and the Azure portal. */
export function formatMB(mb: number): string {
  if (mb >= 1_000_000) return `${(mb / 1_000_000).toFixed(2)} TB`;
  if (mb >= 1_000) return `${(mb / 1_000).toFixed(2)} GB`;
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  if (mb > 0) return `${(mb * 1_000).toFixed(1)} KB`;
  return "0 MB";
}

/**
 * A window total, always in decimal GB so totals compare at a glance. A
 * figure too small for two decimals says so rather than rounding to 0.00 GB.
 */
export function formatGB(mb: number): string {
  if (mb === 0) return "0 GB";
  if (mb > 0 && mb < 5) return "less than 0.01 GB";
  return `${(mb / 1_000).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} GB`;
}
