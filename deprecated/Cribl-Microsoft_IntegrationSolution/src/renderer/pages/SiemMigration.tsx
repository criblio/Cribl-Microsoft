// SIEM Migration - Parse Splunk/QRadar exports to identify data sources
// and map them to Sentinel solutions. Generates a migration report for planning.
// Actual pack building and deployment is done via the Sentinel Integration tab.

import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import InfoTip from '../components/InfoTip';

interface SentinelRuleMatch {
  name: string; severity: string; tactics: string[]; query: string;
}

interface DataSource {
  id: string; name: string; platform: string; platformIdentifiers: string[];
  ruleCount: number; rules: string[]; mitreTactics: string[]; mitreTechniques: string[];
  sentinelSolution: string; sentinelTable: string; confidence: string;
  sentinelAnalyticRules: SentinelRuleMatch[];
}

interface MigrationPlan {
  platform: string; fileName: string; totalRules: number; enabledRules: number;
  buildingBlocks: number;
  dataSources: DataSource[];
  unmappedRules: Array<{ name: string; dataSources: string[]; rawSearch: string }>;
  mitreCoverage: Array<{ tactic: string; techniqueCount: number; ruleCount: number }>;
  totalSentinelRules: number;
}

const s = {
  page: { maxWidth: '1100px', paddingBottom: '40px' } as React.CSSProperties,
  title: { fontSize: '22px', fontWeight: 700 } as React.CSSProperties,
  subtitle: { fontSize: '13px', color: 'var(--text-muted)', marginTop: '4px', marginBottom: '24px' } as React.CSSProperties,
  section: {
    background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
    borderRadius: 'var(--radius)', padding: '20px', marginBottom: '16px',
  } as React.CSSProperties,
  sectionTitle: {
    fontSize: '14px', fontWeight: 700, marginBottom: '4px',
    display: 'flex', alignItems: 'center', gap: '8px',
  } as React.CSSProperties,
  sectionDesc: { fontSize: '12px', color: 'var(--text-muted)', marginBottom: '16px' } as React.CSSProperties,
  sectionNum: {
    width: '24px', height: '24px', borderRadius: '50%', display: 'inline-flex',
    alignItems: 'center', justifyContent: 'center', fontSize: '12px', fontWeight: 700,
    background: 'var(--accent-blue)', color: '#fff', flexShrink: 0,
  } as React.CSSProperties,
  sectionNumDone: {
    width: '24px', height: '24px', borderRadius: '50%', display: 'inline-flex',
    alignItems: 'center', justifyContent: 'center', fontSize: '12px', fontWeight: 700,
    background: 'var(--accent-green)', color: '#fff', flexShrink: 0,
  } as React.CSSProperties,
};

const confidenceColor: Record<string, string> = {
  high: 'var(--accent-green)', medium: 'var(--accent-blue)',
  low: 'var(--accent-orange)', none: 'var(--text-muted)',
};

const severityColor = (sev: string) => ({
  background: sev === 'High' ? 'rgba(239, 83, 80, 0.15)' :
    sev === 'Medium' ? 'rgba(255, 167, 38, 0.15)' :
    sev === 'Low' ? 'rgba(79, 195, 247, 0.15)' : 'rgba(255,255,255,0.05)',
  color: sev === 'High' ? 'var(--accent-red)' :
    sev === 'Medium' ? 'var(--accent-orange)' :
    sev === 'Low' ? 'var(--accent-blue)' : 'var(--text-muted)',
});

function SiemMigration() {
  const navigate = useNavigate();
  const [platform, setPlatform] = useState<'splunk' | 'qradar'>('splunk');
  const [parsing, setParsing] = useState(false);
  const [plan, setPlan] = useState<MigrationPlan | null>(null);
  const [parseError, setParseError] = useState('');
  const [fileName, setFileName] = useState('');
  const [exporting, setExporting] = useState(false);
  const [exportPath, setExportPath] = useState('');

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !window.api) return;
    setFileName(file.name);
    setParsing(true);
    setParseError('');
    setPlan(null);
    try {
      const content = await file.text();
      const detectedPlatform = file.name.endsWith('.csv') ? 'qradar' : 'splunk';
      setPlatform(detectedPlatform);
      const result = await window.api.siemMigration.parse(content, detectedPlatform, file.name);
      if (result.success && result.plan) {
        setPlan(result.plan as MigrationPlan);
      } else {
        setParseError(result.error || 'Failed to parse export file');
      }
    } catch (err) {
      setParseError(err instanceof Error ? err.message : 'Parse failed');
    }
    setParsing(false);
    e.target.value = '';
  };

  const handleExportReport = async () => {
    if (!plan || !window.api) return;
    setExporting(true);
    try {
      const result = await window.api.siemMigration.exportReport(plan);
      if (result.success) setExportPath(result.filePath);
    } catch { /* skip */ }
    setExporting(false);
  };

  const openInIntegration = (solutionName: string) => {
    // Navigate to Sentinel Integration with the solution pre-selected
    navigate(`/?solution=${encodeURIComponent(solutionName)}`);
  };

  const mapped = plan?.dataSources.filter((ds) => ds.sentinelSolution) || [];
  const unmapped = plan?.dataSources.filter((ds) => !ds.sentinelSolution) || [];

  // Group mapped sources by Sentinel solution for the action table
  const solutionGroups = new Map<string, { solution: string; table: string; dataSources: DataSource[]; totalRules: number; sentinelRules: number }>();
  for (const ds of mapped) {
    const key = ds.sentinelSolution.toLowerCase().trim();
    const existing = solutionGroups.get(key) || { solution: ds.sentinelSolution, table: ds.sentinelTable, dataSources: [], totalRules: 0, sentinelRules: 0 };
    existing.dataSources.push(ds);
    existing.totalRules += ds.ruleCount;
    existing.sentinelRules = Math.max(existing.sentinelRules, ds.sentinelAnalyticRules.length);
    if (!existing.table && ds.sentinelTable) existing.table = ds.sentinelTable;
    solutionGroups.set(key, existing);
  }
  const solutionList = [...solutionGroups.values()].sort((a, b) => b.totalRules - a.totalRules);

  return (
    <div style={s.page}>
      <h1 style={s.title}>SIEM Migration Analysis</h1>
      <p style={s.subtitle}>
        Upload Splunk or QRadar detection rule exports to identify data sources, map them to Sentinel solutions,
        and generate a migration plan. Use the Sentinel Integration page to configure each data source.
      </p>

      {/* Section 1: Upload */}
      <div style={s.section}>
        <div style={s.sectionTitle}>
          <span style={plan ? s.sectionNumDone : s.sectionNum}>1</span>
          Upload Detection Rules
          <InfoTip text="For Splunk, export detection rules as JSON. For QRadar, export as CSV including Building Blocks." />
        </div>
        <div style={s.sectionDesc}>
          Upload your exported detection rules to identify data sources and map them to Sentinel solutions.
        </div>

        <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
          <button className={platform === 'splunk' ? 'btn-primary' : 'btn-secondary'}
            style={{ fontSize: '12px', padding: '6px 16px' }}
            onClick={() => setPlatform('splunk')}>Splunk (JSON)</button>
          <button className={platform === 'qradar' ? 'btn-primary' : 'btn-secondary'}
            style={{ fontSize: '12px', padding: '6px 16px' }}
            onClick={() => setPlatform('qradar')}>QRadar (CSV)</button>
        </div>

        <label style={{
          display: 'block', padding: '16px 24px', borderRadius: 'var(--radius)',
          border: '2px dashed var(--border-color)', background: 'var(--bg-input)',
          cursor: 'pointer', fontSize: '13px', color: 'var(--accent-blue)', textAlign: 'center',
        }}>
          {parsing ? 'Parsing...' : fileName ? `Loaded: ${fileName}` : `Click to upload ${platform === 'splunk' ? 'Splunk JSON' : 'QRadar CSV'} export`}
          <input type="file" accept={platform === 'splunk' ? '.json' : '.csv'}
            style={{ display: 'none' }} onChange={handleFileUpload} disabled={parsing} />
        </label>

        {parseError && (
          <div style={{ marginTop: '8px', fontSize: '12px', color: 'var(--accent-red)', padding: '8px 12px', background: 'rgba(239, 83, 80, 0.08)', borderRadius: '4px' }}>
            {parseError}
          </div>
        )}
      </div>

      {/* Section 2: Migration Mapping */}
      {plan && (
        <div style={s.section}>
          <div style={s.sectionTitle}>
            <span style={s.sectionNumDone}>2</span>
            Data Source Mapping
            <InfoTip text="Each data source is mapped to a Sentinel solution based on the detection rule's macros and data model references. Click 'Configure' to set up the data source in the Sentinel Integration page." />
          </div>

          {/* Summary stats */}
          <div style={{
            display: 'flex', gap: '24px', marginBottom: '16px', padding: '12px 16px',
            background: 'var(--bg-primary)', borderRadius: '4px', fontFamily: 'var(--font-mono)', fontSize: '11px',
          }}>
            {[
              { label: 'Rules', value: plan.totalRules, color: 'var(--text-primary)' },
              { label: 'Data Sources', value: plan.dataSources.length, color: 'var(--text-primary)' },
              { label: 'Mapped', value: mapped.length, color: 'var(--accent-green)' },
              { label: 'Unmapped', value: unmapped.length, color: unmapped.length > 0 ? 'var(--accent-orange)' : 'var(--text-muted)' },
              { label: 'Sentinel Rules', value: plan.totalSentinelRules, color: 'var(--accent-blue)' },
            ].map((stat) => (
              <div key={stat.label} style={{ textAlign: 'center' }}>
                <div style={{ fontSize: '20px', fontWeight: 700, color: stat.color }}>{stat.value}</div>
                <div style={{ color: 'var(--text-muted)' }}>{stat.label}</div>
              </div>
            ))}
          </div>

          {/* Solution action cards */}
          <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '8px' }}>
            Sentinel Solutions ({solutionList.length})
          </div>
          {solutionList.map((grp) => {
            const bestConfidence = grp.dataSources.reduce((best, ds) =>
              ds.confidence === 'high' ? 'high' : ds.confidence === 'medium' && best !== 'high' ? 'medium' : best, 'low');
            return (
              <div key={grp.solution} style={{
                display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 14px',
                marginBottom: '6px', borderRadius: '4px', background: 'var(--bg-primary)',
                border: '1px solid var(--border-color)',
              }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: '13px', marginBottom: '2px' }}>{grp.solution}</div>
                  <div style={{ fontSize: '10px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                    {grp.table} | {grp.dataSources.length} source{grp.dataSources.length !== 1 ? 's' : ''} | {grp.totalRules} rules
                    {grp.sentinelRules > 0 && ` | ${grp.sentinelRules} Sentinel rules`}
                  </div>
                  <div style={{ fontSize: '9px', color: 'var(--text-muted)', marginTop: '2px' }}>
                    {grp.dataSources.map((ds) => ds.name).join(', ')}
                  </div>
                </div>
                <span style={{
                  fontSize: '9px', padding: '2px 6px', borderRadius: '3px',
                  color: confidenceColor[bestConfidence],
                  background: `color-mix(in srgb, ${confidenceColor[bestConfidence]} 15%, transparent)`,
                }}>{bestConfidence}</span>
                <button className="btn-primary" style={{ fontSize: '11px', padding: '5px 14px', flexShrink: 0 }}
                  onClick={() => openInIntegration(grp.solution)}>
                  Configure
                </button>
              </div>
            );
          })}

          {/* Unmapped sources */}
          {unmapped.length > 0 && (
            <div style={{ marginTop: '12px' }}>
              <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--accent-orange)', marginBottom: '6px' }}>
                Unmapped Data Sources ({unmapped.length})
              </div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '8px' }}>
                These data sources could not be automatically mapped to a Sentinel solution. Review manually.
              </div>
              {unmapped.map((ds) => (
                <div key={ds.id} style={{
                  padding: '6px 14px', marginBottom: '4px', borderRadius: '4px',
                  background: 'rgba(255, 167, 38, 0.04)', border: '1px solid rgba(255, 167, 38, 0.1)',
                  fontSize: '11px', display: 'flex', gap: '12px', alignItems: 'center',
                }}>
                  <span style={{ fontWeight: 600, color: 'var(--text-primary)', flex: 1 }}>{ds.name}</span>
                  <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: '10px' }}>
                    {ds.ruleCount} rules | {ds.platformIdentifiers.slice(0, 3).join(', ')}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* MITRE Coverage */}
          {plan.mitreCoverage.length > 0 && (
            <details style={{ marginTop: '12px' }}>
              <summary style={{ cursor: 'pointer', fontSize: '12px', fontWeight: 600, color: 'var(--accent-blue)', padding: '4px 0' }}>
                MITRE ATT&CK Coverage ({plan.mitreCoverage.length} tactics)
              </summary>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '8px' }}>
                {plan.mitreCoverage.sort((a, b) => b.ruleCount - a.ruleCount).map((m) => (
                  <div key={m.tactic} style={{
                    padding: '6px 10px', borderRadius: '4px', background: 'var(--bg-primary)',
                    border: '1px solid var(--border-color)', fontSize: '10px', textAlign: 'center',
                  }}>
                    <div style={{ fontWeight: 600, color: 'var(--text-primary)', marginBottom: '2px' }}>{m.tactic}</div>
                    <div style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                      {m.ruleCount} rules, {m.techniqueCount} techniques
                    </div>
                  </div>
                ))}
              </div>
            </details>
          )}

          {/* Sentinel Analytics Rules */}
          {plan.totalSentinelRules > 0 && (() => {
            const solMap = new Map<string, SentinelRuleMatch[]>();
            for (const ds of plan.dataSources) {
              if (!ds.sentinelSolution || ds.sentinelAnalyticRules.length === 0) continue;
              if (!solMap.has(ds.sentinelSolution)) solMap.set(ds.sentinelSolution, ds.sentinelAnalyticRules);
            }
            const uniqueSolutions = [...solMap.entries()];
            const uniqueRuleCount = uniqueSolutions.reduce((sum, [, rules]) => sum + rules.length, 0);
            return (
              <details style={{ marginTop: '12px' }}>
                <summary style={{ cursor: 'pointer', fontSize: '12px', fontWeight: 600, color: 'var(--accent-blue)', padding: '4px 0' }}>
                  Sentinel Analytics Rules ({uniqueRuleCount} rules across {uniqueSolutions.length} solutions)
                </summary>
                {uniqueSolutions.map(([solName, rules]) => (
                  <details key={solName} style={{ marginTop: '6px', marginLeft: '12px' }}>
                    <summary style={{ cursor: 'pointer', fontSize: '11px', fontWeight: 600, color: 'var(--text-primary)' }}>
                      {solName} ({rules.length} rules)
                    </summary>
                    <div style={{ marginTop: '4px', maxHeight: '200px', overflow: 'auto' }}>
                      {rules.map((rule, i) => (
                        <div key={i} style={{ display: 'flex', gap: '8px', alignItems: 'center', padding: '3px 8px', fontSize: '10px', borderBottom: '1px solid var(--border-color)' }}>
                          <span style={{ flex: 1, color: 'var(--text-primary)' }}>{rule.name}</span>
                          <span style={{ ...severityColor(rule.severity), fontSize: '9px', padding: '1px 6px', borderRadius: '3px', fontWeight: 700 }}>{rule.severity}</span>
                          <span style={{ color: 'var(--text-muted)', fontSize: '9px', maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {rule.tactics.join(', ') || '--'}
                          </span>
                        </div>
                      ))}
                    </div>
                  </details>
                ))}
              </details>
            );
          })()}
        </div>
      )}

      {/* Section 3: Export Report */}
      {plan && (
        <div style={s.section}>
          <div style={s.sectionTitle}>
            <span style={s.sectionNum}>3</span>
            Export Migration Report
            <InfoTip text="Download a Markdown report summarizing all data sources, Sentinel mappings, MITRE coverage, and unmapped rules." />
          </div>
          <div style={s.sectionDesc}>
            Generate a migration plan document for stakeholder review and planning.
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <button className="btn-primary" style={{ fontSize: '12px', padding: '8px 20px' }}
              onClick={handleExportReport} disabled={exporting}>
              {exporting ? 'Exporting...' : 'Download Migration Report'}
            </button>
            {exportPath ? (
              <span style={{ fontSize: '11px', color: 'var(--accent-green)', fontFamily: 'var(--font-mono)' }}>
                Saved to: {exportPath.replace(/\\/g, '/')}
              </span>
            ) : (
              <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                Report will be saved to your Downloads folder
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default SiemMigration;
