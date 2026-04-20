import { useState, useEffect } from 'react';
import { FieldMapping, DataConnectorSchema, SchemaColumn, VendorSample } from '../../types';

interface PackScaffoldProps {
  solution: { name: string; path: string };
  onCreated: () => void;
  onCancel: () => void;
}

interface TableConfig {
  sentinelTable: string;
  criblStream: string;
  sourceSchema: SchemaColumn[];
  dcrSchema: SchemaColumn[];
  fields: FieldMapping[];
  loadingDcr: boolean;
}

const styles = {
  container: {} as React.CSSProperties,
  form: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '16px',
  } as React.CSSProperties,
  row: {
    display: 'flex',
    gap: '12px',
    alignItems: 'flex-end',
  } as React.CSSProperties,
  field: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '4px',
    flex: 1,
  } as React.CSSProperties,
  label: {
    fontSize: '11px',
    color: 'var(--text-muted)',
    fontWeight: 600,
    textTransform: 'uppercase' as const,
  } as React.CSSProperties,
  sectionTitle: {
    fontSize: '13px',
    fontWeight: 600,
    color: 'var(--text-secondary)',
    marginBottom: '8px',
    marginTop: '8px',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.5px',
  } as React.CSSProperties,
  tableCard: {
    background: 'var(--bg-secondary)',
    border: '1px solid var(--border-color)',
    borderRadius: 'var(--radius)',
    padding: '14px',
    marginBottom: '10px',
  } as React.CSSProperties,
  tableHeader: {
    display: 'flex',
    gap: '8px',
    alignItems: 'center',
    marginBottom: '10px',
  } as React.CSSProperties,
  schemaSection: {
    marginTop: '10px',
    borderTop: '1px solid var(--border-color)',
    paddingTop: '10px',
  } as React.CSSProperties,
  fieldRow: {
    display: 'grid',
    gridTemplateColumns: '1fr 20px 1fr 80px 80px',
    gap: '6px',
    alignItems: 'center',
    padding: '4px 0',
    fontSize: '12px',
    fontFamily: 'var(--font-mono)',
  } as React.CSSProperties,
  fieldHeader: {
    display: 'grid',
    gridTemplateColumns: '1fr 20px 1fr 80px 80px',
    gap: '6px',
    padding: '4px 0',
    fontSize: '10px',
    fontWeight: 600,
    color: 'var(--text-muted)',
    textTransform: 'uppercase' as const,
    borderBottom: '1px solid var(--border-color)',
    marginBottom: '4px',
  } as React.CSSProperties,
  arrow: {
    textAlign: 'center' as const,
    color: 'var(--text-muted)',
  } as React.CSSProperties,
  typeTag: (type: string) => {
    const colors: Record<string, string> = {
      string: 'var(--accent-green)',
      int: 'var(--accent-blue)',
      long: 'var(--accent-blue)',
      real: 'var(--accent-orange)',
      boolean: 'var(--accent-purple)',
      datetime: 'var(--accent-blue)',
      dynamic: 'var(--accent-orange)',
    };
    return {
      fontSize: '10px',
      padding: '1px 6px',
      borderRadius: '8px',
      background: `${colors[type] || 'var(--text-muted)'}22`,
      color: colors[type] || 'var(--text-muted)',
      textAlign: 'center' as const,
    } as React.CSSProperties;
  },
  actionSelect: {
    fontSize: '11px',
    padding: '2px 4px',
    background: 'var(--bg-input)',
    border: '1px solid var(--border-color)',
    color: 'var(--text-primary)',
    borderRadius: '4px',
  } as React.CSSProperties,
  smallInput: {
    flex: 1,
    padding: '6px 10px',
    fontSize: '12px',
  } as React.CSSProperties,
  actions: {
    display: 'flex',
    gap: '12px',
    marginTop: '12px',
  } as React.CSSProperties,
  details: {
    background: 'var(--bg-secondary)',
    border: '1px solid var(--border-color)',
    borderRadius: 'var(--radius)',
    padding: '14px',
    marginBottom: '16px',
  } as React.CSSProperties,
  dirList: {
    display: 'flex',
    gap: '8px',
    flexWrap: 'wrap' as const,
    marginTop: '8px',
  } as React.CSSProperties,
  dirTag: {
    background: 'var(--bg-surface)',
    padding: '4px 10px',
    borderRadius: '12px',
    fontSize: '11px',
    color: 'var(--text-secondary)',
  } as React.CSSProperties,
  error: {
    color: 'var(--accent-red)',
    fontSize: '12px',
    marginTop: '8px',
  } as React.CSSProperties,
  success: {
    color: 'var(--accent-green)',
    fontSize: '13px',
    marginTop: '12px',
  } as React.CSSProperties,
  schemaCount: {
    fontSize: '11px',
    color: 'var(--text-muted)',
    fontStyle: 'italic' as const,
  } as React.CSSProperties,
  checkbox: {
    marginRight: '8px',
  } as React.CSSProperties,
};

// Auto-generate field mappings by comparing source schema (from Sentinel) to DCR schema
function generateFieldMappings(
  sourceColumns: SchemaColumn[],
  dcrColumns: SchemaColumn[],
): FieldMapping[] {
  const mappings: FieldMapping[] = [];
  const dcrMap = new Map(dcrColumns.map((c) => [c.name.toLowerCase(), c]));

  for (const src of sourceColumns) {
    const dcrMatch = dcrMap.get(src.name.toLowerCase());
    if (dcrMatch) {
      // Exact name match - check if type needs coercion
      const needsCoerce = src.type !== dcrMatch.type;
      mappings.push({
        source: src.name,
        target: dcrMatch.name,
        type: dcrMatch.type,
        action: src.name !== dcrMatch.name ? 'rename' : (needsCoerce ? 'coerce' : 'keep'),
      });
      dcrMap.delete(src.name.toLowerCase());
    }
  }

  // Source fields not in DCR schema - mark as drop candidates
  const mappedSources = new Set(mappings.map((m) => m.source.toLowerCase()));
  for (const src of sourceColumns) {
    if (!mappedSources.has(src.name.toLowerCase())) {
      mappings.push({
        source: src.name,
        target: src.name,
        type: src.type,
        action: 'drop',
      });
    }
  }

  // DCR fields not matched from source - these need to be populated
  for (const [, dcrCol] of dcrMap) {
    mappings.push({
      source: '',
      target: dcrCol.name,
      type: dcrCol.type,
      action: 'keep',
    });
  }

  return mappings;
}

function PackScaffold({ solution, onCreated, onCancel }: PackScaffoldProps) {
  const [packName, setPackName] = useState(
    solution.name.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_-]/g, '')
  );
  const [version, setVersion] = useState('1.0.0');
  const [autoPackage, setAutoPackage] = useState(true);
  const [tables, setTables] = useState<TableConfig[]>([]);
  const [solutionDirs, setSolutionDirs] = useState<string[]>([]);
  const [loadingDetails, setLoadingDetails] = useState(true);
  const [loadingSchemas, setLoadingSchemas] = useState(false);
  const [vendorSamples, setVendorSamples] = useState<VendorSample[]>([]);
  const [loadingSamples, setLoadingSamples] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [createdPath, setCreatedPath] = useState('');
  const [availableTables, setAvailableTables] = useState<string[]>([]);

  useEffect(() => {
    loadSolutionDetails();
    loadAvailableTables();
    loadVendorSamples();
  }, [solution.path]);

  async function loadAvailableTables() {
    if (!window.api) return;
    try {
      const tables = await window.api.packBuilder.getAvailableTables();
      setAvailableTables(tables);
    } catch {
      // Non-critical
    }
  }

  async function loadVendorSamples() {
    if (!window.api) return;
    setLoadingSamples(true);
    try {
      const samples = await window.api.github.fetchVendorSamples(solution.path);
      setVendorSamples(samples);
    } catch {
      // Non-critical - will fall back to generated samples
    } finally {
      setLoadingSamples(false);
    }
  }

  async function loadSolutionDetails() {
    if (!window.api) return;
    setLoadingDetails(true);
    setLoadingSchemas(true);
    try {
      // Fetch solution directory structure
      const details = await window.api.github.fetchSolutionDetails(solution.path) as {
        directories?: string[];
        files?: string[];
      };
      setSolutionDirs(details.directories || []);

      // Fetch data connector schemas from the solution
      const schemas: DataConnectorSchema[] = await window.api.github.fetchSolutionSchemas(solution.path);

      if (schemas.length > 0) {
        // Create table configs from discovered schemas
        const tableConfigs: TableConfig[] = [];
        for (const schema of schemas) {
          const config: TableConfig = {
            sentinelTable: schema.tableName,
            criblStream: 'default',
            sourceSchema: schema.columns,
            dcrSchema: [],
            fields: [],
            loadingDcr: true,
          };
          tableConfigs.push(config);
        }
        setTables(tableConfigs);

        // Load DCR schemas for each table to build field mappings
        for (let i = 0; i < tableConfigs.length; i++) {
          try {
            const dcrColumns = await window.api.packBuilder.getDcrSchema(tableConfigs[i].sentinelTable);
            const updated = [...tableConfigs];
            updated[i] = {
              ...updated[i],
              dcrSchema: dcrColumns,
              fields: generateFieldMappings(updated[i].sourceSchema, dcrColumns),
              loadingDcr: false,
            };
            tableConfigs[i] = updated[i];
            setTables([...tableConfigs]);
          } catch {
            const updated = [...tableConfigs];
            updated[i] = { ...updated[i], loadingDcr: false };
            tableConfigs[i] = updated[i];
            setTables([...tableConfigs]);
          }
        }
      } else {
        // Fallback: create a single empty table entry
        setTables([{
          sentinelTable: solution.name.replace(/\s+/g, ''),
          criblStream: 'default',
          sourceSchema: [],
          dcrSchema: [],
          fields: [],
          loadingDcr: false,
        }]);
      }
    } catch {
      setTables([{
        sentinelTable: solution.name.replace(/\s+/g, ''),
        criblStream: 'default',
        sourceSchema: [],
        dcrSchema: [],
        fields: [],
        loadingDcr: false,
      }]);
    } finally {
      setLoadingDetails(false);
      setLoadingSchemas(false);
    }
  }

  async function loadDcrSchemaForTable(index: number) {
    if (!window.api) return;
    const updated = [...tables];
    updated[index] = { ...updated[index], loadingDcr: true };
    setTables(updated);

    try {
      const dcrColumns = await window.api.packBuilder.getDcrSchema(updated[index].sentinelTable);
      updated[index] = {
        ...updated[index],
        dcrSchema: dcrColumns,
        fields: generateFieldMappings(updated[index].sourceSchema, dcrColumns),
        loadingDcr: false,
      };
    } catch {
      updated[index] = { ...updated[index], loadingDcr: false };
    }
    setTables([...updated]);
  }

  function updateFieldAction(tableIdx: number, fieldIdx: number, action: FieldMapping['action']) {
    const updated = [...tables];
    const fields = [...updated[tableIdx].fields];
    fields[fieldIdx] = { ...fields[fieldIdx], action };
    updated[tableIdx] = { ...updated[tableIdx], fields };
    setTables(updated);
  }

  function removeTable(index: number) {
    setTables(tables.filter((_, i) => i !== index));
  }

  function addTable() {
    setTables([...tables, {
      sentinelTable: '',
      criblStream: 'default',
      sourceSchema: [],
      dcrSchema: [],
      fields: [],
      loadingDcr: false,
    }]);
  }

  function updateTableName(index: number, name: string) {
    const updated = [...tables];
    updated[index] = { ...updated[index], sentinelTable: name };
    setTables(updated);
  }

  async function handleCreate() {
    if (!window.api) return;
    if (!packName.trim()) {
      setError('Pack name is required');
      return;
    }
    const validTables = tables.filter((t) => t.sentinelTable.trim());
    if (validTables.length === 0) {
      setError('At least one table is required');
      return;
    }

    setCreating(true);
    setError('');
    try {
      const resultPath = await window.api.packBuilder.scaffold({
        solutionName: solution.name,
        packName: packName.trim(),
        version,
        autoPackage,
        vendorSamples,
        tables: validTables.map((t) => ({
          sentinelTable: t.sentinelTable,
          criblStream: t.criblStream,
          fields: t.fields,
        })),
      });
      setCreatedPath(typeof resultPath === 'string' ? resultPath : resultPath.packDir);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
    } finally {
      setCreating(false);
    }
  }

  if (createdPath) {
    return (
      <div>
        <div style={styles.success}>
          Pack "{packName}" created{autoPackage ? ' and packaged' : ''} successfully.
        </div>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '8px', fontFamily: 'var(--font-mono)' }}>
          {createdPath}
        </div>
        {autoPackage && (
          <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '4px' }}>
            Check the terminal panel for .crbl packaging output.
          </div>
        )}
        <div style={styles.actions}>
          <button className="btn-primary" onClick={onCreated}>Go to My Packs</button>
          <button className="btn-secondary" onClick={onCancel}>Create Another</button>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      {/* Solution Details */}
      <div style={styles.details}>
        <div style={{ fontSize: '14px', fontWeight: 600, marginBottom: '6px' }}>
          {solution.name}
        </div>
        {loadingDetails ? (
          <div style={{ color: 'var(--text-muted)', fontSize: '12px' }}>Loading solution details...</div>
        ) : (
          <>
            <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Solution directories:</div>
            <div style={styles.dirList}>
              {solutionDirs.map((dir) => (
                <span key={dir} style={styles.dirTag}>{dir}</span>
              ))}
            </div>
          </>
        )}
        {loadingSchemas && (
          <div style={{ fontSize: '12px', color: 'var(--accent-blue)', marginTop: '8px' }}>
            Fetching Data Connector schemas and matching against DCR templates...
          </div>
        )}
        {loadingSamples && (
          <div style={{ fontSize: '12px', color: 'var(--accent-blue)', marginTop: '4px' }}>
            Checking vendor documentation and sample data...
          </div>
        )}
        {!loadingSamples && vendorSamples.length > 0 && (
          <div style={{ fontSize: '12px', color: 'var(--accent-green)', marginTop: '8px' }}>
            Found {vendorSamples.length} vendor sample source{vendorSamples.length !== 1 ? 's' : ''}: {vendorSamples.map((s) => s.source).join(', ')}
          </div>
        )}
        {!loadingSamples && vendorSamples.length === 0 && !loadingSchemas && (
          <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '8px' }}>
            No vendor sample data found in solution. Sample events will be generated from schema field heuristics.
          </div>
        )}
      </div>

      <div style={styles.form}>
        {/* Pack Config */}
        <div style={styles.sectionTitle}>Pack Configuration</div>
        <div style={styles.row}>
          <div style={styles.field}>
            <span style={styles.label}>Pack Name</span>
            <input value={packName} onChange={(e) => setPackName(e.target.value)} placeholder="my-pack-name" />
          </div>
          <div style={styles.field}>
            <span style={styles.label}>Version</span>
            <input value={version} onChange={(e) => setVersion(e.target.value)} placeholder="1.0.0" style={{ maxWidth: '120px' }} />
          </div>
        </div>
        <label style={{ fontSize: '12px', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center' }}>
          <input
            type="checkbox"
            checked={autoPackage}
            onChange={(e) => setAutoPackage(e.target.checked)}
            style={styles.checkbox}
          />
          Auto-package .crbl file after creation
        </label>

        {/* Table Mappings with Schema */}
        <div style={styles.sectionTitle}>
          Table Mappings
          <span style={{ ...styles.schemaCount, marginLeft: '8px' }}>
            {tables.length} table{tables.length !== 1 ? 's' : ''} discovered
          </span>
        </div>

        {tables.map((table, tableIdx) => (
          <div key={tableIdx} style={styles.tableCard}>
            <div style={styles.tableHeader}>
              <div style={{ ...styles.field, flex: 2 }}>
                <span style={styles.label}>Destination Sentinel Table</span>
                <div style={{ display: 'flex', gap: '6px' }}>
                  <input
                    style={styles.smallInput}
                    value={table.sentinelTable}
                    onChange={(e) => updateTableName(tableIdx, e.target.value)}
                    placeholder="TableName"
                    list={`tables-${tableIdx}`}
                  />
                  <datalist id={`tables-${tableIdx}`}>
                    {availableTables.map((t) => <option key={t} value={t} />)}
                  </datalist>
                  <button
                    className="btn-secondary"
                    style={{ fontSize: '10px', padding: '4px 8px', whiteSpace: 'nowrap' }}
                    onClick={() => loadDcrSchemaForTable(tableIdx)}
                    disabled={table.loadingDcr || !table.sentinelTable.trim()}
                  >
                    {table.loadingDcr ? 'Loading...' : 'Load DCR Schema'}
                  </button>
                </div>
              </div>
              {tables.length > 1 && (
                <button
                  className="btn-danger"
                  style={{ padding: '4px 8px', fontSize: '11px', alignSelf: 'flex-end' }}
                  onClick={() => removeTable(tableIdx)}
                >
                  Remove
                </button>
              )}
            </div>

            {/* Schema Mapping */}
            {table.fields.length > 0 && (
              <div style={styles.schemaSection}>
                <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '6px' }}>
                  FIELD MAPPING
                  <span style={{ fontWeight: 400, marginLeft: '8px' }}>
                    ({table.sourceSchema.length} source, {table.dcrSchema.length} DCR, {table.fields.length} mapped)
                  </span>
                </div>

                <div style={styles.fieldHeader}>
                  <span>Source Field</span>
                  <span></span>
                  <span>DCR Target</span>
                  <span>Type</span>
                  <span>Action</span>
                </div>

                <div style={{ maxHeight: '300px', overflow: 'auto' }}>
                  {table.fields.map((field, fieldIdx) => (
                    <div key={fieldIdx} style={{
                      ...styles.fieldRow,
                      opacity: field.action === 'drop' ? 0.4 : 1,
                    }}>
                      <span style={{ color: field.source ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                        {field.source || '(unmapped)'}
                      </span>
                      <span style={styles.arrow}>-&gt;</span>
                      <span>{field.target}</span>
                      <span style={styles.typeTag(field.type)}>{field.type}</span>
                      <select
                        style={styles.actionSelect}
                        value={field.action}
                        onChange={(e) => updateFieldAction(tableIdx, fieldIdx, e.target.value as FieldMapping['action'])}
                      >
                        <option value="keep">Keep</option>
                        <option value="rename">Rename</option>
                        <option value="coerce">Coerce</option>
                        <option value="drop">Drop</option>
                      </select>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {table.fields.length === 0 && !table.loadingDcr && table.dcrSchema.length === 0 && table.sourceSchema.length === 0 && (
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontStyle: 'italic' }}>
                No schema detected. Click "Load DCR Schema" to load the destination table schema,
                or the pack will be created with a basic passthrough pipeline.
              </div>
            )}

            {table.loadingDcr && (
              <div style={{ fontSize: '11px', color: 'var(--accent-blue)' }}>
                Loading DCR schema for {table.sentinelTable}...
              </div>
            )}
          </div>
        ))}

        <button className="btn-secondary" onClick={addTable} style={{ alignSelf: 'flex-start' }}>
          + Add Table
        </button>

        {error && <div style={styles.error}>{error}</div>}

        <div style={styles.actions}>
          <button className="btn-success" onClick={handleCreate} disabled={creating || loadingSchemas}>
            {creating ? 'Creating...' : (autoPackage ? 'Generate Pack + .crbl' : 'Generate Pack')}
          </button>
          <button className="btn-secondary" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

export default PackScaffold;
