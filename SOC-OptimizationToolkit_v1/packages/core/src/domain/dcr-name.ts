// Direct DCR naming — a pure seed of the abbreviation logic ported (verbatim, with
// characterization tests) from Azure/.../Create-TableDCRs.ps1 (line ~2599) in Phase 1.
// Pure: same input -> same output, no IO.

/** Azure Direct DCR names are capped at 30 characters. */
export const DIRECT_DCR_MAX = 30;

/** Known table abbreviations (seed; the full map is ported in Phase 1). */
const ABBREVIATIONS: Readonly<Record<string, string>> = {
  CommonSecurityLog: 'CSL',
  SecurityEvent: 'SecEvt',
  WindowsEvent: 'WinEvt',
  DeviceEvents: 'DevEvt',
};

/** Abbreviate a Sentinel table name, or pass it through unchanged when unknown. */
export function abbreviateTableName(table: string): string {
  return ABBREVIATIONS[table] ?? table;
}

/** Build a Direct DCR name within the 30-char limit, trimming any trailing hyphen. */
export function toDirectDcrName(table: string, prefix = 'dcr', location = ''): string {
  const name = [prefix, abbreviateTableName(table), location].filter(Boolean).join('-');
  return name.length > DIRECT_DCR_MAX ? name.slice(0, DIRECT_DCR_MAX).replace(/-+$/, '') : name;
}
