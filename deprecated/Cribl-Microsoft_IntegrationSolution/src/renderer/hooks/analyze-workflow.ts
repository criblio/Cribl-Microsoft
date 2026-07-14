// Pure logic for the Sentinel analysis workflow, extracted from SentinelIntegration.tsx so it
// can be unit-tested without rendering. These two helpers (destination-table resolution and
// per-sample table matching) were duplicated across the analyze, resource-preview, and deploy
// flows; centralizing them removes that drift and makes the rules testable.

export interface DestinationTableResolution {
  tables: string[];
  source: string;
}

export interface VendorLogTypeHint {
  id?: string;
  name?: string;
  destTable?: string;
}

export interface SolutionConnector {
  name: string;
  path: string;
}

// Resolve the destination Sentinel tables for a solution, in precedence order:
//   1. Vendor research log types (strip the Microsoft- content-hub prefix)
//   2. Custom-table connectors from the Sentinel repo (_CL tables) -- fetched lazily via
//      loadConnectors, which is only called when vendor research yields nothing
//   3. Default to CommonSecurityLog
// loadConnectors is injected so it can handle its own errors/logging and so tests need no IO.
export async function resolveDestinationTables(
  researchLogTypes: VendorLogTypeHint[],
  loadConnectors: () => Promise<SolutionConnector[]>,
): Promise<DestinationTableResolution> {
  const destTables = new Set<string>();
  let source = '';

  for (const lt of researchLogTypes) {
    if (lt.destTable) destTables.add(lt.destTable.replace(/^Microsoft-/, ''));
  }
  if (destTables.size > 0) source = 'Vendor research (Sentinel Content Hub)';

  if (destTables.size === 0) {
    const connectors = await loadConnectors();
    for (const c of connectors) {
      if (c.name.toLowerCase().includes('customtable') || c.path.includes('CustomTables')) {
        const tableName = c.name.replace('.json', '');
        if (tableName.endsWith('_CL')) destTables.add(tableName);
      }
    }
    if (destTables.size > 0) source = 'Sentinel repo (CustomTables definition)';
  }

  if (destTables.size === 0) {
    destTables.add('CommonSecurityLog');
    source = 'Default (no DCR definition found in Sentinel solution)';
  }

  return { tables: [...destTables], source };
}

// Match a sample's log type to one of the resolved destination tables using the vendor log
// types (exact normalized match, or substring either direction for names/ids longer than 3
// chars). With one or zero destination tables there is nothing to disambiguate -> default.
export function matchSampleToTable(
  sampleLogType: string,
  researchLogTypes: VendorLogTypeHint[],
  destinationTableCount: number,
  defaultTable: string,
): string {
  if (destinationTableCount <= 1) return defaultTable;

  const sNorm = sampleLogType.toLowerCase().replace(/[_ \-]/g, '');
  for (const lt of researchLogTypes) {
    if (!lt.destTable) continue;
    const idNorm = (lt.id || '').toLowerCase().replace(/[_ \-]/g, '');
    const nameNorm = (lt.name || '').toLowerCase().replace(/[_ \-]/g, '');
    if (
      idNorm === sNorm || nameNorm === sNorm ||
      (idNorm.length > 3 && sNorm.includes(idNorm)) ||
      (sNorm.length > 3 && idNorm.includes(sNorm)) ||
      (nameNorm.length > 3 && sNorm.includes(nameNorm)) ||
      (sNorm.length > 3 && nameNorm.includes(sNorm))
    ) {
      return lt.destTable;
    }
  }
  return defaultTable;
}
