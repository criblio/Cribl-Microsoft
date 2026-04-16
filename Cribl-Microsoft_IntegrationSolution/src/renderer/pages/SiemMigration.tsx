// SIEM Migration - Parse Splunk/QRadar exports to identify data sources
// and auto-configure Cribl packs for Sentinel integration.

import { useState, useEffect } from 'react';
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
  header: { marginBottom: '24px' } as React.CSSProperties,
  title: { fontSize: '22px', fontWeight: 700 } as React.CSSProperties,
  subtitle: { fontSize: '13px', color: 'var(--text-muted)', marginTop: '4px' } as React.CSSProperties,
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
  row: { display: 'flex', gap: '12px', alignItems: 'flex-start', marginBottom: '12px' } as React.CSSProperties,
  label: { fontSize: '11px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '4px' } as React.CSSProperties,
};

const confidenceColor: Record<string, string> = {
  high: 'var(--accent-green)', medium: 'var(--accent-blue)',
  low: 'var(--accent-orange)', none: 'var(--text-muted)',
};

function SiemMigration() {
  const [platform, setPlatform] = useState<'splunk' | 'qradar'>('splunk');
  const [parsing, setParsing] = useState(false);
  const [plan, setPlan] = useState<MigrationPlan | null>(null);
  const [parseError, setParseError] = useState('');
  const [fileName, setFileName] = useState('');
  const [selectedSources, setSelectedSources] = useState<Set<string>>(new Set());
  const [buildStatus, setBuildStatus] = useState<Record<string, string>>({});
  const [buildLog, setBuildLog] = useState<string[]>([]);
  const [exporting, setExporting] = useState(false);
  const [exportPath, setExportPath] = useState('');
  // Per-solution user-uploaded sample files: solutionName -> [{logType, content, fileName}]
  const [userSamples, setUserSamples] = useState<Record<string, Array<{ logType: string; content: string; fileName: string }>>>({});
  // Available samples per solution (listed from repos, user selects which to use)
  interface AvailableSampleInfo { id: string; tier: string; source: string; logType: string; format: string; eventCount: number; fileName: string; }
  const [availableSamples, setAvailableSamples] = useState<Record<string, AvailableSampleInfo[]>>({});
  const [selectedSampleIds, setSelectedSampleIds] = useState<Record<string, Set<string>>>({});
  const [loadingSamples, setLoadingSamples] = useState<Record<string, boolean>>({});
  // Repo status
  const [sentinelRepoState, setSentinelRepoState] = useState<{ state: string; solutionCount: number }>({ state: 'unknown', solutionCount: 0 });
  const [elasticRepoState, setElasticRepoState] = useState<{ state: string; packageCount: number }>({ state: 'unknown', packageCount: 0 });

  useEffect(() => {
    if (!window.api) return;
    // Fetch initial status
    window.api.sentinelRepo.status().then((s: any) => setSentinelRepoState(s)).catch(() => {});
    (window.api as any).elasticRepo?.status().then((s: any) => setElasticRepoState(s)).catch(() => {});
    // Subscribe to live updates
    const removeSentinel = window.api.sentinelRepo.onStatus((s: any) => setSentinelRepoState(s));
    const removeElastic = (window.api as any).elasticRepo?.onStatus?.((s: any) => setElasticRepoState(s));
    return () => { removeSentinel(); removeElastic?.(); };
  }, []);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !window.api) return;
    setFileName(file.name);
    setParsing(true);
    setParseError('');
    setPlan(null);
    setSelectedSources(new Set());

    try {
      const content = await file.text();
      const detectedPlatform = file.name.endsWith('.csv') ? 'qradar' : 'splunk';
      setPlatform(detectedPlatform);
      const result = await window.api.siemMigration.parse(content, detectedPlatform, file.name);
      if (result.success && result.plan) {
        setPlan(result.plan as MigrationPlan);
        // Auto-select data sources with high/medium confidence
        const autoSelect = new Set<string>();
        for (const ds of (result.plan as MigrationPlan).dataSources) {
          if (ds.sentinelSolution && ds.confidence !== 'none') autoSelect.add(ds.id);
        }
        setSelectedSources(autoSelect);
      } else {
        setParseError(result.error || 'Failed to parse export file');
      }
    } catch (err) {
      setParseError(err instanceof Error ? err.message : 'Parse failed');
    }
    setParsing(false);
    e.target.value = '';
  };

  const handleSampleUpload = async (solutionName: string, e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const newSamples: Array<{ logType: string; content: string; fileName: string }> = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const content = await file.text();
      const logType = file.name.replace(/\.[^.]+$/, ''); // strip extension as log type
      newSamples.push({ logType, content, fileName: file.name });
    }
    setUserSamples((prev) => ({
      ...prev,
      [solutionName]: [...(prev[solutionName] || []), ...newSamples],
    }));
    e.target.value = '';
  };

  // Browse available samples from Elastic/Cribl/synthesis for a solution
  const handleBrowseSamples = async (solutionName: string) => {
    if (!window.api) return;
    setLoadingSamples((prev) => ({ ...prev, [solutionName]: true }));
    try {
      const samples = await (window.api as any).sampleResolver.listAvailable(solutionName);
      setAvailableSamples((prev) => ({ ...prev, [solutionName]: samples }));
      // Auto-select all by default
      setSelectedSampleIds((prev) => ({
        ...prev,
        [solutionName]: new Set(samples.map((s: AvailableSampleInfo) => s.id)),
      }));
    } catch { /* skip */ }
    setLoadingSamples((prev) => ({ ...prev, [solutionName]: false }));
  };

  const toggleSampleSelection = (solutionName: string, sampleId: string) => {
    setSelectedSampleIds((prev) => {
      const current = new Set(prev[solutionName] || []);
      if (current.has(sampleId)) current.delete(sampleId);
      else current.add(sampleId);
      return { ...prev, [solutionName]: current };
    });
  };

  const handleBuildPack = async (ds: DataSource) => {
    if (!window.api || !ds.sentinelSolution) return;
    const key = ds.sentinelSolution;
    setBuildStatus((prev) => ({ ...prev, [key]: 'building' }));

    // Determine sample source: user uploads take priority, then selected repo samples
    const uploads = userSamples[key];
    const selected = selectedSampleIds[key];
    const hasRepoSelection = selected && selected.size > 0 && !uploads?.length;

    if (uploads?.length) {
      setBuildLog((prev) => [...prev, `Building pack for ${key}... (${uploads.length} user sample${uploads.length > 1 ? 's' : ''})`]);
    } else if (hasRepoSelection) {
      setBuildLog((prev) => [...prev, `Building pack for ${key}... (loading ${selected.size} selected sample${selected.size > 1 ? 's' : ''})`]);
    } else {
      setBuildLog((prev) => [...prev, `Building pack for ${key}... (no samples selected)`]);
    }

    try {
      // If user selected repo samples, load their content first
      let samplesToPass = uploads;
      if (hasRepoSelection) {
        try {
          const loaded = await (window.api as any).sampleResolver.loadSelected(key, [...selected]);
          // Convert ResolvedSample[] to the format siem:build-pack expects
          samplesToPass = loaded.map((s: any) => ({
            logType: s.logType || s.tableName,
            content: s.rawEvents.join('\n'),
            fileName: `${s.source}.log`,
          }));
        } catch (err) {
          setBuildLog((prev) => [...prev, `  Warning: Failed to load repo samples, building without`]);
        }
      }

      const result = await window.api.siemMigration.buildPack(ds.sentinelSolution, undefined, samplesToPass);
      if (result.success) {
        setBuildStatus((prev) => ({ ...prev, [key]: 'done' }));
        const sampleInfo = (result as any).sampleInfo;
        const tierLabel = sampleInfo?.tier ? ` [samples: ${sampleInfo.tier}, ${sampleInfo.eventCount} events]` : '';
        setBuildLog((prev) => [...prev, `  Pack ready: ${result.packName} (${result.tables?.join(', ')})${tierLabel}`]);
      } else {
        setBuildStatus((prev) => ({ ...prev, [key]: 'error' }));
        setBuildLog((prev) => [...prev, `  Error: ${result.error}`]);
      }
    } catch (err) {
      setBuildStatus((prev) => ({ ...prev, [key]: 'error' }));
      setBuildLog((prev) => [...prev, `  Error: ${err instanceof Error ? err.message : String(err)}`]);
    }
  };

  const handleBuildAll = async () => {
    if (!plan) return;
    for (const ds of plan.dataSources) {
      if (selectedSources.has(ds.id) && ds.sentinelSolution && buildStatus[ds.id] !== 'done') {
        await handleBuildPack(ds);
      }
    }
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

  const mapped = plan?.dataSources.filter((ds) => ds.sentinelSolution) || [];
  const unmapped = plan?.dataSources.filter((ds) => !ds.sentinelSolution) || [];

  return (
    <div style={s.page}>
      <div style={s.header}>
        <h1 style={s.title}>SIEM Migration</h1>
        <p style={s.subtitle}>Parse Splunk or QRadar detection rule exports to identify required data sources and build Cribl packs</p>
      </div>

      {/* Repo status bar */}
      <div style={{
        display: 'flex', gap: '16px', marginBottom: '12px', padding: '8px 14px',
        background: 'var(--bg-secondary)', borderRadius: 'var(--radius)',
        border: '1px solid var(--border-color)', fontSize: '11px', fontFamily: 'var(--font-mono)',
        alignItems: 'center',
      }}>
        <span style={{ color: 'var(--text-muted)', fontWeight: 600, fontSize: '10px' }}>REPOS</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
          <span style={{
            width: '7px', height: '7px', borderRadius: '50%', display: 'inline-block',
            background: sentinelRepoState.state === 'ready' ? 'var(--accent-green)'
              : sentinelRepoState.state === 'cloning' ? 'var(--accent-blue)'
              : sentinelRepoState.state === 'error' ? 'var(--accent-red)' : 'var(--text-muted)',
          }} />
          <span style={{ color: sentinelRepoState.state === 'ready' ? 'var(--accent-green)' : 'var(--text-muted)' }}>
            Sentinel {sentinelRepoState.state === 'ready' ? `(${sentinelRepoState.solutionCount} solutions)` : sentinelRepoState.state}
          </span>
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
          <span style={{
            width: '7px', height: '7px', borderRadius: '50%', display: 'inline-block',
            background: elasticRepoState.state === 'ready' ? 'var(--accent-green)'
              : elasticRepoState.state === 'cloning' ? 'var(--accent-blue)'
              : elasticRepoState.state === 'error' ? 'var(--accent-red)' : 'var(--text-muted)',
          }} />
          <span style={{ color: elasticRepoState.state === 'ready' ? 'var(--accent-green)' : 'var(--text-muted)' }}>
            Elastic {elasticRepoState.state === 'ready' ? `(${elasticRepoState.packageCount} packages)` : elasticRepoState.state}
          </span>
        </span>
      </div>

      {/* Section 1: Upload */}
      <div style={s.section}>
        <div style={s.sectionTitle}>
          <span style={plan ? s.sectionNumDone : s.sectionNum}>1</span>
          Upload Detection Rules
          <InfoTip text="Upload the detection rule export from your current SIEM. For Splunk, use the JSON export from the SPL query in the Microsoft SIEM migration docs. For QRadar, export rules as CSV including Building Blocks." />
        </div>
        <div style={s.sectionDesc}>
          Upload your exported detection rules to identify data sources and map them to Sentinel solutions.
        </div>

        <div style={s.row}>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              className={platform === 'splunk' ? 'btn-primary' : 'btn-secondary'}
              style={{ fontSize: '12px', padding: '6px 16px' }}
              onClick={() => setPlatform('splunk')}
            >Splunk (JSON)</button>
            <button
              className={platform === 'qradar' ? 'btn-primary' : 'btn-secondary'}
              style={{ fontSize: '12px', padding: '6px 16px' }}
              onClick={() => setPlatform('qradar')}
            >QRadar (CSV)</button>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <label style={{
            padding: '10px 24px', borderRadius: 'var(--radius)',
            border: '2px dashed var(--border-color)', background: 'var(--bg-input)',
            cursor: 'pointer', fontSize: '13px', color: 'var(--accent-blue)',
            textAlign: 'center', flex: 1,
          }}>
            {parsing ? 'Parsing...' : fileName ? `Loaded: ${fileName}` : `Click to upload ${platform === 'splunk' ? 'Splunk JSON' : 'QRadar CSV'} export`}
            <input
              type="file"
              accept={platform === 'splunk' ? '.json' : '.csv'}
              style={{ display: 'none' }}
              onChange={handleFileUpload}
              disabled={parsing}
            />
          </label>
        </div>

        {parseError && (
          <div style={{ marginTop: '8px', fontSize: '12px', color: 'var(--accent-red)', padding: '8px 12px', background: 'rgba(239, 83, 80, 0.08)', borderRadius: '4px' }}>
            {parseError}
          </div>
        )}
      </div>

      {/* Section 2: Rules Summary */}
      {plan && (
        <div style={s.section}>
          <div style={s.sectionTitle}>
            <span style={s.sectionNumDone}>2</span>
            Rules Summary
            <InfoTip text="Identified data sources from your detection rules. Each data source is mapped to a Sentinel solution based on the rule's macros (Splunk) or content extensions (QRadar). High confidence means an exact match; low means fuzzy matching was used." />
          </div>
          <div style={s.sectionDesc}>
            {plan.totalRules} detection rule{plan.totalRules !== 1 ? 's' : ''} parsed from {plan.platform === 'splunk' ? 'Splunk' : 'QRadar'} export.
            {plan.buildingBlocks > 0 ? ` ${plan.buildingBlocks} building block(s) also found.` : ''}
          </div>

          {/* Summary stats */}
          <div style={{
            display: 'flex', gap: '24px', marginBottom: '16px', padding: '10px 14px',
            background: 'var(--bg-primary)', borderRadius: '4px', fontFamily: 'var(--font-mono)', fontSize: '11px',
          }}>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '20px', fontWeight: 700, color: 'var(--text-primary)' }}>{plan.totalRules}</div>
              <div style={{ color: 'var(--text-muted)' }}>Rules</div>
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '20px', fontWeight: 700, color: 'var(--text-primary)' }}>{plan.dataSources.length}</div>
              <div style={{ color: 'var(--text-muted)' }}>Data Sources</div>
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '20px', fontWeight: 700, color: 'var(--accent-green)' }}>{mapped.length}</div>
              <div style={{ color: 'var(--text-muted)' }}>Mapped</div>
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '20px', fontWeight: 700, color: unmapped.length > 0 ? 'var(--accent-orange)' : 'var(--text-muted)' }}>{unmapped.length}</div>
              <div style={{ color: 'var(--text-muted)' }}>Unmapped</div>
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '20px', fontWeight: 700, color: 'var(--accent-blue)' }}>{plan.totalSentinelRules}</div>
              <div style={{ color: 'var(--text-muted)' }}>Sentinel Rules</div>
            </div>
          </div>

          {/* Data sources table */}
          <div style={{ border: '1px solid var(--border-color)', borderRadius: '4px', overflow: 'auto', maxHeight: '400px' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px', fontFamily: 'var(--font-mono)' }}>
              <thead>
                <tr style={{ background: 'var(--bg-secondary)', position: 'sticky', top: 0, zIndex: 1 }}>
                  <th style={{ padding: '6px 8px', textAlign: 'left', borderBottom: '1px solid var(--border-color)', fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)', width: '30px' }}>
                    <input type="checkbox"
                      checked={selectedSources.size === mapped.length && mapped.length > 0}
                      onChange={(e) => {
                        if (e.target.checked) setSelectedSources(new Set(mapped.map((ds) => ds.id)));
                        else setSelectedSources(new Set());
                      }}
                    />
                  </th>
                  {['Data Source', 'Rules', 'Sentinel Solution', 'Sentinel Rules', 'Table', 'Confidence'].map((h) => (
                    <th key={h} style={{ padding: '6px 8px', textAlign: 'left', borderBottom: '1px solid var(--border-color)', fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {plan.dataSources.map((ds) => (
                  <tr key={ds.id} style={{
                    borderBottom: '1px solid var(--border-color)',
                    background: !ds.sentinelSolution ? 'rgba(255, 255, 255, 0.02)' : 'transparent',
                    opacity: ds.sentinelSolution ? 1 : 0.6,
                  }}>
                    <td style={{ padding: '4px 8px' }}>
                      <input type="checkbox"
                        checked={selectedSources.has(ds.id)}
                        disabled={!ds.sentinelSolution}
                        onChange={(e) => {
                          const next = new Set(selectedSources);
                          e.target.checked ? next.add(ds.id) : next.delete(ds.id);
                          setSelectedSources(next);
                        }}
                      />
                    </td>
                    <td style={{ padding: '4px 8px', color: 'var(--text-primary)', fontWeight: 600 }}>
                      {ds.name}
                      <div style={{ fontSize: '9px', color: 'var(--text-muted)', fontWeight: 400 }}>
                        {ds.platformIdentifiers.slice(0, 2).join(', ')}
                        {ds.platformIdentifiers.length > 2 ? ` +${ds.platformIdentifiers.length - 2}` : ''}
                      </div>
                    </td>
                    <td style={{ padding: '4px 8px', fontFamily: 'var(--font-mono)' }}>{ds.ruleCount}</td>
                    <td style={{ padding: '4px 8px', color: ds.sentinelSolution ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                      {ds.sentinelSolution || '--'}
                    </td>
                    <td style={{ padding: '4px 8px' }}>
                      {ds.sentinelAnalyticRules.length > 0 ? (
                        <span style={{ color: 'var(--accent-green)', fontFamily: 'var(--font-mono)' }}>
                          {ds.sentinelAnalyticRules.length}
                        </span>
                      ) : (
                        <span style={{ color: 'var(--text-muted)' }}>--</span>
                      )}
                    </td>
                    <td style={{ padding: '4px 8px', color: 'var(--text-muted)' }}>{ds.sentinelTable || '--'}</td>
                    <td style={{ padding: '4px 8px' }}>
                      <span style={{
                        fontSize: '9px', padding: '1px 6px', borderRadius: '3px',
                        color: confidenceColor[ds.confidence] || 'var(--text-muted)',
                        background: `color-mix(in srgb, ${confidenceColor[ds.confidence] || 'var(--text-muted)'} 15%, transparent)`,
                      }}>{ds.confidence}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Section 3: Matched Sentinel Analytics Rules */}
      {plan && plan.totalSentinelRules > 0 && (
        <div style={s.section}>
          <div style={s.sectionTitle}>
            <span style={s.sectionNumDone}>3</span>
            Matched Sentinel Analytics Rules
            <InfoTip text="Sentinel analytics rules from the matched solutions in the local Sentinel repository clone. These are the detection rules that will be available in Sentinel once the corresponding data sources are configured via Cribl packs." />
          </div>
          {(() => {
            // Group by unique Sentinel solution to avoid duplicate rows
            const solMap = new Map<string, SentinelRuleMatch[]>();
            for (const ds of plan.dataSources) {
              if (!ds.sentinelSolution || ds.sentinelAnalyticRules.length === 0) continue;
              if (!solMap.has(ds.sentinelSolution)) {
                solMap.set(ds.sentinelSolution, ds.sentinelAnalyticRules);
              }
            }
            const uniqueSolutions = [...solMap.entries()];
            const uniqueRuleCount = uniqueSolutions.reduce((sum, [, rules]) => sum + rules.length, 0);

            return (<>
          <div style={s.sectionDesc}>
            {uniqueRuleCount} Sentinel analytics rule{uniqueRuleCount !== 1 ? 's' : ''} matched across {uniqueSolutions.length} solution{uniqueSolutions.length !== 1 ? 's' : ''}.
          </div>

          {uniqueSolutions.map(([solName, rules]) => (
            <details key={solName} style={{ marginBottom: '6px' }}>
              <summary style={{
                cursor: 'pointer', fontSize: '12px', fontWeight: 600,
                color: 'var(--accent-blue)', display: 'flex', alignItems: 'center', gap: '8px',
                padding: '6px 0',
              }}>
                <span>{solName}</span>
                <span style={{
                  fontSize: '10px', padding: '1px 8px', borderRadius: '10px',
                  background: 'rgba(102, 187, 106, 0.15)', color: 'var(--accent-green)',
                }}>{rules.length} rule{rules.length !== 1 ? 's' : ''}</span>
              </summary>
              <div style={{
                border: '1px solid var(--border-color)', borderRadius: '4px',
                overflow: 'auto', maxHeight: '300px', marginBottom: '4px',
              }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px', fontFamily: 'var(--font-mono)' }}>
                  <thead>
                    <tr style={{ background: 'var(--bg-secondary)', position: 'sticky', top: 0 }}>
                      {['Rule Name', 'Severity', 'Tactics'].map((h) => (
                        <th key={h} style={{ padding: '5px 8px', textAlign: 'left', borderBottom: '1px solid var(--border-color)', fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rules.map((rule, ri) => (
                      <tr key={ri} style={{ borderBottom: '1px solid var(--border-color)' }}>
                        <td style={{ padding: '4px 8px', color: 'var(--text-primary)' }}>
                          <details style={{ cursor: 'pointer' }}>
                            <summary>{rule.name}</summary>
                            {rule.query && (
                              <pre style={{
                                marginTop: '4px', padding: '6px', background: 'var(--bg-input)',
                                borderRadius: '4px', fontSize: '10px', color: 'var(--text-secondary)',
                                whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: '150px', overflow: 'auto',
                              }}>{rule.query}</pre>
                            )}
                          </details>
                        </td>
                        <td style={{ padding: '4px 8px' }}>
                          <span style={{
                            fontSize: '9px', padding: '1px 6px', borderRadius: '3px', fontWeight: 700,
                            background: rule.severity === 'High' ? 'rgba(239, 83, 80, 0.15)' :
                              rule.severity === 'Medium' ? 'rgba(255, 167, 38, 0.15)' :
                              rule.severity === 'Low' ? 'rgba(79, 195, 247, 0.15)' : 'rgba(255,255,255,0.05)',
                            color: rule.severity === 'High' ? 'var(--accent-red)' :
                              rule.severity === 'Medium' ? 'var(--accent-orange)' :
                              rule.severity === 'Low' ? 'var(--accent-blue)' : 'var(--text-muted)',
                          }}>{rule.severity}</span>
                        </td>
                        <td style={{ padding: '4px 8px', fontSize: '10px', color: 'var(--text-muted)' }}>
                          {rule.tactics.join(', ') || '--'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          ))}
            </>);
          })()}
        </div>
      )}

      {/* Section 4: Build Packs (grouped by Sentinel Solution) */}
      {plan && selectedSources.size > 0 && (() => {
        // Group selected data sources by Sentinel solution -> one pack per solution
        // Normalize key to avoid case/whitespace duplicates
        const solGroups = new Map<string, { solution: string; table: string; dataSources: DataSource[]; totalRules: number }>();
        for (const ds of plan.dataSources) {
          if (!selectedSources.has(ds.id) || !ds.sentinelSolution) continue;
          const key = ds.sentinelSolution.toLowerCase().trim();
          const existing = solGroups.get(key) || { solution: ds.sentinelSolution, table: ds.sentinelTable, dataSources: [], totalRules: 0 };
          existing.dataSources.push(ds);
          existing.totalRules += ds.ruleCount;
          if (!existing.table && ds.sentinelTable) existing.table = ds.sentinelTable;
          solGroups.set(key, existing);
        }
        const packList = [...solGroups.values()].sort((a, b) => b.totalRules - a.totalRules);

        return (
        <div style={{ ...s.section, borderTop: '3px solid var(--accent-green)' }}>
          <div style={s.sectionTitle}>
            <span style={s.sectionNum}>4</span>
            Configure Packs
            <InfoTip text="One Cribl pack per Sentinel solution. Each pack handles all the data sources that map to that solution. After building, use 'Continue in Sentinel Integration' to configure samples, field mappings, and deployment." />
          </div>
          <div style={s.sectionDesc}>
            {packList.length} pack{packList.length !== 1 ? 's' : ''} to build from {selectedSources.size} selected data source{selectedSources.size !== 1 ? 's' : ''}.
          </div>

          <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
            <button className="btn-success" style={{ fontSize: '12px', padding: '8px 20px', fontWeight: 700 }}
              onClick={async () => {
                for (const grp of packList) {
                  if (buildStatus[grp.solution] !== 'done') {
                    await handleBuildPack(grp.dataSources[0]);
                  }
                }
              }}>
              Build All ({packList.length} packs)
            </button>
          </div>

          {packList.map((grp) => (
            <div key={grp.solution} style={{
              padding: '12px 14px', marginBottom: '8px', borderRadius: '4px',
              background: 'var(--bg-primary)', border: '1px solid var(--border-color)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: '13px' }}>{grp.solution}</div>
                  <div style={{ fontSize: '10px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', marginTop: '2px' }}>
                    {grp.table} | {grp.dataSources.length} data source{grp.dataSources.length !== 1 ? 's' : ''} | {grp.totalRules} rules
                  </div>
                </div>
                <span style={{
                  fontSize: '10px', padding: '2px 8px', borderRadius: '10px',
                  background: buildStatus[grp.solution] === 'done' ? 'rgba(102, 187, 106, 0.15)' :
                    buildStatus[grp.solution] === 'error' ? 'rgba(239, 83, 80, 0.15)' :
                    buildStatus[grp.solution] === 'building' ? 'rgba(79, 195, 247, 0.15)' : 'rgba(255, 255, 255, 0.05)',
                  color: buildStatus[grp.solution] === 'done' ? 'var(--accent-green)' :
                    buildStatus[grp.solution] === 'error' ? 'var(--accent-red)' :
                    buildStatus[grp.solution] === 'building' ? 'var(--accent-blue)' : 'var(--text-muted)',
                }}>
                  {buildStatus[grp.solution] === 'done' ? 'Built' :
                   buildStatus[grp.solution] === 'error' ? 'Error' :
                   buildStatus[grp.solution] === 'building' ? 'Building...' : 'Pending'}
                </span>
                {buildStatus[grp.solution] === 'done' && (
                  <button className="btn-primary" style={{ fontSize: '10px', padding: '4px 12px' }}
                    onClick={() => {
                      window.location.hash = `#/?solution=${encodeURIComponent(grp.solution)}`;
                    }}>
                    Open in Integration
                  </button>
                )}
                {buildStatus[grp.solution] !== 'done' && buildStatus[grp.solution] !== 'building' && (
                  <button className="btn-secondary" style={{ fontSize: '10px', padding: '4px 12px' }}
                    onClick={() => handleBuildPack(grp.dataSources[0])}>
                    Build
                  </button>
                )}
              </div>
              {/* Sample upload area */}
              {/* Sample selection area */}
              <div style={{ marginTop: '8px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                  <button className="btn-secondary" style={{ fontSize: '10px', padding: '3px 10px' }}
                    onClick={() => handleBrowseSamples(grp.solution)}
                    disabled={!!loadingSamples[grp.solution]}>
                    {loadingSamples[grp.solution] ? 'Loading...' : availableSamples[grp.solution] ? 'Refresh Samples' : 'Browse Samples'}
                  </button>
                  <label style={{
                    fontSize: '10px', padding: '3px 10px', borderRadius: '3px',
                    border: '1px dashed var(--border-color)', cursor: 'pointer',
                    color: 'var(--accent-blue)', background: 'var(--bg-input)',
                  }}>
                    Upload Own
                    <input type="file" multiple accept=".json,.log,.txt,.csv,.cef"
                      style={{ display: 'none' }}
                      onChange={(e) => handleSampleUpload(grp.solution, e)}
                    />
                  </label>
                  {userSamples[grp.solution]?.length > 0 && (
                    <span style={{ fontSize: '10px', color: 'var(--accent-green)', fontFamily: 'var(--font-mono)' }}>
                      {userSamples[grp.solution].length} uploaded: {userSamples[grp.solution].map((s) => s.fileName).join(', ')}
                    </span>
                  )}
                </div>

                {/* Available samples list with checkboxes */}
                {availableSamples[grp.solution]?.length > 0 && !userSamples[grp.solution]?.length && (
                  <div style={{
                    marginTop: '6px', border: '1px solid var(--border-color)', borderRadius: '4px',
                    overflow: 'auto', maxHeight: '180px',
                  }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '10px', fontFamily: 'var(--font-mono)' }}>
                      <thead>
                        <tr style={{ background: 'var(--bg-secondary)', position: 'sticky', top: 0 }}>
                          <th style={{ padding: '4px 6px', textAlign: 'left', borderBottom: '1px solid var(--border-color)', width: '24px' }}>
                            <input type="checkbox"
                              checked={selectedSampleIds[grp.solution]?.size === availableSamples[grp.solution].length}
                              onChange={(e) => {
                                setSelectedSampleIds((prev) => ({
                                  ...prev,
                                  [grp.solution]: e.target.checked
                                    ? new Set(availableSamples[grp.solution].map((s) => s.id))
                                    : new Set(),
                                }));
                              }}
                            />
                          </th>
                          {['Source', 'Log Type', 'Format', 'Events', 'File'].map((h) => (
                            <th key={h} style={{ padding: '4px 6px', textAlign: 'left', borderBottom: '1px solid var(--border-color)', fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)' }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {availableSamples[grp.solution].map((sample) => (
                          <tr key={sample.id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                            <td style={{ padding: '3px 6px' }}>
                              <input type="checkbox"
                                checked={selectedSampleIds[grp.solution]?.has(sample.id) || false}
                                onChange={() => toggleSampleSelection(grp.solution, sample.id)}
                              />
                            </td>
                            <td style={{ padding: '3px 6px' }}>
                              <span style={{
                                fontSize: '9px', padding: '1px 5px', borderRadius: '3px',
                                background: sample.tier === 'elastic' ? 'rgba(79, 195, 247, 0.12)' :
                                  sample.tier === 'cribl' ? 'rgba(102, 187, 106, 0.12)' : 'rgba(255, 167, 38, 0.12)',
                                color: sample.tier === 'elastic' ? 'var(--accent-blue)' :
                                  sample.tier === 'cribl' ? 'var(--accent-green)' : 'var(--accent-orange)',
                              }}>{sample.tier}</span>
                              <span style={{ marginLeft: '4px', color: 'var(--text-muted)' }}>{sample.source}</span>
                            </td>
                            <td style={{ padding: '3px 6px', color: 'var(--text-primary)' }}>{sample.logType}</td>
                            <td style={{ padding: '3px 6px', color: 'var(--text-muted)' }}>{sample.format}</td>
                            <td style={{ padding: '3px 6px', color: 'var(--text-muted)' }}>{sample.eventCount}</td>
                            <td style={{ padding: '3px 6px', color: 'var(--text-muted)', fontSize: '9px' }}>{sample.fileName}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <div style={{
                      padding: '4px 8px', fontSize: '9px', color: 'var(--text-muted)',
                      background: 'var(--bg-secondary)', borderTop: '1px solid var(--border-color)',
                    }}>
                      {selectedSampleIds[grp.solution]?.size || 0} of {availableSamples[grp.solution].length} selected
                    </div>
                  </div>
                )}
              </div>
              <details style={{ marginTop: '6px', fontSize: '10px' }}>
                <summary style={{ cursor: 'pointer', color: 'var(--text-muted)' }}>
                  Data sources: {grp.dataSources.map((ds) => ds.name).slice(0, 5).join(', ')}
                  {grp.dataSources.length > 5 ? ` +${grp.dataSources.length - 5} more` : ''}
                </summary>
                <div style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)', padding: '4px 0' }}>
                  {grp.dataSources.map((ds) => ds.name).join(', ')}
                </div>
              </details>
            </div>
          ))}

          {buildLog.length > 0 && (
            <div style={{
              marginTop: '12px', background: 'var(--bg-input)', borderRadius: '4px',
              padding: '12px', fontFamily: 'var(--font-mono)', fontSize: '11px',
              color: 'var(--text-secondary)', maxHeight: '200px', overflow: 'auto',
              whiteSpace: 'pre-wrap',
            }}>
              {buildLog.map((line, i) => <div key={i}>{line}</div>)}
            </div>
          )}
        </div>
        );
      })()}

      {/* Section 5: Export Report */}
      {plan && (
        <div style={s.section}>
          <div style={s.sectionTitle}>
            <span style={s.sectionNum}>{selectedSources.size > 0 ? '5' : '3'}</span>
            Export Migration Report
            <InfoTip text="Download a Markdown report summarizing all identified data sources, Sentinel solution mappings, MITRE coverage, and unmapped rules for manual review." />
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
