// Sentinel Repo Manager
// Maintains a local copy of selected files from Azure/Azure-Sentinel.
//
// Uses GitHub's Trees API + raw content URLs instead of git clone to avoid
// downloading content that triggers EDR security products (CrowdStrike Falcon,
// SentinelOne, Carbon Black etc.) on playbook Python/PowerShell scripts and
// Azure Function zip archives that git would otherwise write to disk.
//
// Only text content the app actually reads is fetched:
//   Solutions/*/Analytic Rules/*.yaml    (analytic rules -- KQL queries in YAML)
//   Solutions/*/Hunting Queries/*.yaml   (hunting queries)
//   Solutions/*/Parsers/*.yaml           (ASIM parsers)
//   Solutions/*/Data Connectors/*.json   (data connector metadata, top level only)
//   Solutions/*/Data/*.json              (solution metadata for deprecation check)
//   Solutions/*/Sample Data/*.*          (vendor sample logs, optional)
//   Sample Data/**/*.*                   (repo-root vendor sample logs for pipeline building)
//
// Skipped entirely (never written to disk):
//   - Playbooks (ARM templates + scripts)
//   - Workbooks (large JSON dashboards)
//   - Data Connector subdirectories (Azure Function source, zip archives)
//   - All .py, .ps1, .sh, .zip, .exe, .dll files
//   - Images and media
//
// This reduces the download from ~2GB to ~30-50MB and avoids EDR false positives.
// All other modules (github.ts, registry-sync.ts, change-detection.ts,
// vendor-research.ts) read from this local copy via the same API as before.

import { IpcMain, BrowserWindow } from 'electron';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { loadGitHubPat } from './auth';
import builtinBlocklistData from './edr-blocklist.json';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const REPO_BRANCH = 'master';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function getDataDir(): string {
  const appData = process.env.APPDATA || process.env.HOME || '';
  const dir = path.join(appData, '.cribl-microsoft', 'sentinel-repo');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getRepoDir(): string {
  return path.join(getDataDir(), 'Azure-Sentinel');
}

function getStatusPath(): string {
  return path.join(getDataDir(), 'status.json');
}

function getFetchingMarkerPath(): string {
  return path.join(getDataDir(), 'fetching.json');
}

function getLocalBlocklistPath(): string {
  const appData = process.env.APPDATA || process.env.HOME || '';
  const dir = path.join(appData, '.cribl-microsoft');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'edr-blocklist-local.json');
}

// ---------------------------------------------------------------------------
// EDR Blocklist -- Two-layer system
//   1. Built-in (ships with the app, committed to git)
//   2. Local (per-user, auto-populated on crash detection, user-editable)
// ---------------------------------------------------------------------------

export interface BlockedSolution {
  name: string;
  reason: string;
  source: 'built-in' | 'auto-detected' | 'user';
}

/** Load the built-in blocklist (imported at build time, bundled into main.js). */
function loadBuiltinBlocklist(): BlockedSolution[] {
  try {
    return (builtinBlocklistData.solutions || []).map((s: { name: string; reason: string }) => ({
      name: s.name,
      reason: s.reason,
      source: 'built-in' as const,
    }));
  } catch {
    return [];
  }
}

/** Load the local (per-user) blocklist. Auto-populated on crash detection. */
function loadLocalBlocklist(): BlockedSolution[] {
  try {
    const localPath = getLocalBlocklistPath();
    if (!fs.existsSync(localPath)) return [];
    const data = JSON.parse(fs.readFileSync(localPath, 'utf-8'));
    return (data.solutions || []).map((s: { name: string; reason: string; source?: string }) => ({
      name: s.name,
      reason: s.reason,
      source: (s.source as BlockedSolution['source']) || 'auto-detected',
    }));
  } catch {
    return [];
  }
}

/** Save the local blocklist. */
function saveLocalBlocklist(solutions: BlockedSolution[]): void {
  try {
    fs.writeFileSync(getLocalBlocklistPath(), JSON.stringify({
      description: 'Auto-populated EDR blocklist. Solutions added here were detected as causing process termination during fetch. You can manually add or remove entries.',
      solutions: solutions.map((s) => ({ name: s.name, reason: s.reason, source: s.source })),
    }, null, 2));
  } catch { /* non-fatal */ }
}

/** Add a solution to the local blocklist (deduplicates by name). */
function addToLocalBlocklist(name: string, reason: string, source: BlockedSolution['source'] = 'auto-detected'): void {
  const existing = loadLocalBlocklist();
  if (existing.some((s) => s.name === name)) return; // already listed
  existing.push({ name, reason, source });
  saveLocalBlocklist(existing);
}

/** Remove a solution from the local blocklist (for retry). */
function removeFromLocalBlocklist(name: string): void {
  const existing = loadLocalBlocklist();
  const filtered = existing.filter((s) => s.name !== name);
  if (filtered.length !== existing.length) saveLocalBlocklist(filtered);
}

/** Get the merged blocklist (built-in + local, deduplicated). */
function getMergedBlocklist(): BlockedSolution[] {
  const builtin = loadBuiltinBlocklist();
  const local = loadLocalBlocklist();
  const merged = [...builtin];
  const names = new Set(builtin.map((s) => s.name));
  for (const s of local) {
    if (!names.has(s.name)) {
      merged.push(s);
      names.add(s.name);
    }
  }
  return merged;
}

/** Get the set of blocked solution names for fast lookup during fetch. */
function getBlockedSolutionNames(): Set<string> {
  return new Set(getMergedBlocklist().map((s) => s.name));
}

// ---------------------------------------------------------------------------
// Fetching marker -- crash detection
// When the app starts and finds this file, the previous fetch was killed
// mid-stream (likely by EDR). The solution named in the marker is auto-added
// to the local blocklist.
// ---------------------------------------------------------------------------

interface FetchingMarker {
  solution: string;
  startedAt: number;
}

function writeFetchingMarker(solutionName: string): void {
  try {
    const marker: FetchingMarker = { solution: solutionName, startedAt: Date.now() };
    fs.writeFileSync(getFetchingMarkerPath(), JSON.stringify(marker));
  } catch { /* non-fatal */ }
}

function clearFetchingMarker(): void {
  try {
    const p = getFetchingMarkerPath();
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch { /* non-fatal */ }
}

/** Check for a stale fetching marker on startup. Returns the solution name if found. */
function checkAndRecoverFetchingMarker(): string | null {
  try {
    const p = getFetchingMarkerPath();
    if (!fs.existsSync(p)) return null;
    const marker: FetchingMarker = JSON.parse(fs.readFileSync(p, 'utf-8'));
    // Clean up marker regardless
    fs.unlinkSync(p);

    // Only auto-blocklist if the fetch was very recent (within 60 seconds).
    // EDR kills happen almost immediately when the problematic content is written to disk.
    // If the marker is older, the app was likely closed normally by the user during a fetch,
    // not killed by EDR -- don't penalize the solution.
    const ageMs = Date.now() - marker.startedAt;
    if (ageMs < 60000) {
      addToLocalBlocklist(
        marker.solution,
        `Process terminated during fetch (detected at startup). Original fetch started at ${new Date(marker.startedAt).toISOString()}.`,
      );
      console.warn(`[sentinel-repo] Crash recovery: "${marker.solution}" was being fetched when the process was killed (${Math.round(ageMs / 1000)}s ago). Added to local EDR blocklist.`);
      return marker.solution;
    } else {
      console.log(`[sentinel-repo] Stale fetch marker found for "${marker.solution}" (${Math.round(ageMs / 1000)}s old) -- likely user restart, not EDR kill. Ignoring.`);
      return null;
    }
  } catch {
    try { fs.unlinkSync(getFetchingMarkerPath()); } catch { /* ignore */ }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RepoStatus {
  state: 'not_cloned' | 'cloning' | 'ready' | 'updating' | 'error';
  localPath: string;
  lastUpdated: number;
  lastCommit: string;
  solutionCount: number;
  sizeOnDisk: string;
  error: string;
  blockedCount: number;
  fetchedCount: number;
}

interface StatusFile {
  lastUpdated: number;
  lastCommit: string;
  solutionCount: number;
}

let currentStatus: RepoStatus = {
  state: 'not_cloned', localPath: '', lastUpdated: 0,
  lastCommit: '', solutionCount: 0, sizeOnDisk: '', error: '',
  blockedCount: 0, fetchedCount: 0,
};

// ---------------------------------------------------------------------------
// Status Management
// ---------------------------------------------------------------------------

function loadStatus(): void {
  const repoDir = getRepoDir();
  const statusPath = getStatusPath();
  const solDir = path.join(repoDir, 'Solutions');

  // Repo is considered "cloned" when Solutions/ exists with at least one subdirectory.
  // Uses the fetched file layout rather than any git marker.
  let hasFetchedContent = false;
  if (fs.existsSync(solDir)) {
    try {
      const entries = fs.readdirSync(solDir, { withFileTypes: true }).filter((e) => e.isDirectory());
      hasFetchedContent = entries.length > 0;
    } catch { /* ignore */ }
  }

  const blockedCount = getBlockedSolutionNames().size;

  if (!hasFetchedContent) {
    currentStatus = {
      state: 'not_cloned', localPath: repoDir, lastUpdated: 0,
      lastCommit: '', solutionCount: 0, sizeOnDisk: '', error: '',
      blockedCount, fetchedCount: 0,
    };
    return;
  }

  let saved: StatusFile = { lastUpdated: 0, lastCommit: '', solutionCount: 0 };
  if (fs.existsSync(statusPath)) {
    try { saved = JSON.parse(fs.readFileSync(statusPath, 'utf-8')); } catch { /* use defaults */ }
  }

  currentStatus = {
    state: 'ready',
    localPath: repoDir,
    lastUpdated: saved.lastUpdated,
    lastCommit: saved.lastCommit,
    solutionCount: saved.solutionCount,
    sizeOnDisk: '',
    error: '',
    blockedCount,
    fetchedCount: saved.solutionCount,
  };
}

function saveStatus(): void {
  try {
    fs.writeFileSync(getStatusPath(), JSON.stringify({
      lastUpdated: currentStatus.lastUpdated,
      lastCommit: currentStatus.lastCommit,
      solutionCount: currentStatus.solutionCount,
    }, null, 2));
  } catch { /* non-fatal */ }
}

function broadcast(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('sentinel-repo:status', currentStatus);
    }
  }
}

// ---------------------------------------------------------------------------
// GitHub API-based fetcher (replaces git clone to avoid EDR false positives)
// ---------------------------------------------------------------------------

const GITHUB_API_BASE = 'https://api.github.com/repos/Azure/Azure-Sentinel';
const GITHUB_RAW_BASE = 'https://raw.githubusercontent.com/Azure/Azure-Sentinel';

// EDR-blocked solutions are now loaded dynamically from two-layer blocklist
// (built-in edr-blocklist.json + local auto-detected). See getBlockedSolutionNames().

// File extensions that are executable/archive content -- NEVER fetched.
// These are what EDR products (CrowdStrike, SentinelOne etc.) hash and block
// when written to disk during a git clone. We skip them entirely.
const BLOCKED_EXTENSIONS = new Set([
  '.py', '.ps1', '.psm1', '.psd1',   // scripts
  '.sh', '.bat', '.cmd',              // shell
  '.exe', '.dll', '.msi', '.scr',     // binaries
  '.zip', '.tar', '.gz', '.7z', '.rar', // archives
  '.jar', '.war',                     // Java archives
]);

// Media/binary extensions -- safe but useless for the app. Skipped to save bandwidth.
const SKIP_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp', '.bmp',
  '.mp4', '.mp3', '.mov', '.avi',
  '.pdf',
  '.bacpac', '.bin',
]);

// Directory segments that contain nothing the app needs AND may have risky content.
// Matched case-insensitively against any path segment.
const SKIP_DIRS = new Set([
  'images', 'media', 'screenshots',   // image directories
  'node_modules', '.vscode', '.github', // build artifacts
]);

// File extensions we actively want (text content the app reads or may read).
const INCLUDED_EXTENSIONS = new Set([
  '.yaml', '.yml',  // analytic rules, hunting queries, parsers, ASIM schemas
  '.json',           // data connectors, workbooks, playbook ARM templates, solution metadata
  '.csv',            // sample data, schema files
  '.txt', '.log',    // sample data, raw log files
  '.md',             // readme files (small, useful for context)
  '.kql',            // standalone KQL files if present
]);

function isIncluded(filePath: string, blockedSolutions?: Set<string>): boolean {
  // Solutions/ content and repo-root Sample Data/ (vendor log samples for pipeline building)
  if (!filePath.startsWith('Solutions/') && !filePath.startsWith('Sample Data/')) return false;

  // Skip Solutions in the merged EDR blocklist
  const solName = filePath.split('/')[1]; // "Solutions/<name>/..."
  if (solName && blockedSolutions && blockedSolutions.has(solName)) return false;

  const ext = path.extname(filePath).toLowerCase();

  // Hard-block executable/archive content (EDR triggers)
  if (BLOCKED_EXTENSIONS.has(ext)) return false;

  // Skip media/binary content (safe but not useful)
  if (SKIP_EXTENSIONS.has(ext)) return false;

  // Skip entire directories that are either useless (images, node_modules) or risky
  // (.github has workflow YAMLs that aren't solution content)
  const segments = filePath.split('/').map((s) => s.toLowerCase());
  for (const segment of segments) {
    if (SKIP_DIRS.has(segment)) return false;
  }

  // Only fetch known text content types
  return INCLUDED_EXTENSIONS.has(ext);
}

function getAuthHeader(): Record<string, string> {
  const pat = loadGitHubPat();
  if (pat) return { 'Authorization': `Bearer ${pat}` };
  return {};
}

// Fetch JSON via GitHub API (with PAT if available)
async function githubJson<T = unknown>(url: string): Promise<T | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { net } = require('electron');
    const resp = await net.fetch(url, {
      headers: {
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'Cribl-Microsoft-Integration',
        ...getAuthHeader(),
      },
    });
    if (!resp.ok) return null;
    return await resp.json() as T;
  } catch {
    return null;
  }
}

// Fetch raw file content as text
async function githubRaw(relativePath: string, commitSha: string): Promise<string | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { net } = require('electron');
    const url = `${GITHUB_RAW_BASE}/${commitSha}/${encodeURI(relativePath)}`;
    const resp = await net.fetch(url, {
      headers: {
        'User-Agent': 'Cribl-Microsoft-Integration',
        ...getAuthHeader(),
      },
    });
    if (!resp.ok) return null;
    return await resp.text();
  } catch {
    return null;
  }
}

// Get the current HEAD commit SHA of the master branch
async function getCurrentCommitSha(): Promise<string | null> {
  const data = await githubJson<{ object?: { sha?: string } }>(
    `${GITHUB_API_BASE}/git/ref/heads/${REPO_BRANCH}`,
  );
  return data?.object?.sha || null;
}

// Walk the full repo tree at a given commit. Returns every file path + blob SHA.
// Checks for truncation -- if the tree is too large for a single API response,
// we fall back to walking only the Solutions/ subtree (which is much smaller).
async function getRepoTree(commitSha: string): Promise<Array<{ path: string; sha: string; size: number }>> {
  const commit = await githubJson<{ tree?: { sha?: string } }>(`${GITHUB_API_BASE}/git/commits/${commitSha}`);
  const treeSha = commit?.tree?.sha;
  if (!treeSha) return [];

  const tree = await githubJson<{ tree?: Array<{ path: string; type: string; sha: string; size?: number }>; truncated?: boolean }>(
    `${GITHUB_API_BASE}/git/trees/${treeSha}?recursive=1`,
  );
  if (!tree?.tree) return [];

  // If the recursive tree was truncated (GitHub caps at ~100K entries or 7MB response),
  // we'd miss files. In practice Azure-Sentinel returns ~31K entries which fits. Log a warning.
  if (tree.truncated) {
    console.warn('[sentinel-repo] GitHub returned a truncated tree -- some files may be missing');
  }

  return tree.tree
    .filter((e) => e.type === 'blob')
    .map((e) => ({ path: e.path, sha: e.sha, size: e.size || 0 }));
}

// Fetch selected files in parallel with a concurrency limit.
// Emits percentage-based progress events (throttled) for UI rendering.
async function fetchFilesInParallel(
  files: Array<{ path: string; sha: string }>,
  commitSha: string,
  concurrency: number,
  onProgress: (done: number, total: number) => void,
): Promise<number> {
  const repoDir = getRepoDir();
  let completed = 0;
  let written = 0;
  let lastEmittedPct = -1;

  // Simple concurrency pool.
  // Each file download is wrapped in try/catch so that EDR-triggered process
  // interruptions on individual files don't kill the entire fetch operation.
  const queue = [...files];
  async function worker() {
    while (queue.length > 0) {
      const file = queue.shift();
      if (!file) break;
      try {
        const content = await githubRaw(file.path, commitSha);
        if (content !== null) {
          const fullPath = path.join(repoDir, file.path);
          try {
            fs.mkdirSync(path.dirname(fullPath), { recursive: true });
            fs.writeFileSync(fullPath, content, 'utf-8');
            written++;
          } catch { /* skip write errors (EDR may block specific files) */ }
        }
      } catch { /* skip individual fetch errors */ }
      completed++;
      // Throttle progress emission to integer percentage changes (100 events max total)
      const pct = Math.floor((completed / files.length) * 100);
      if (pct !== lastEmittedPct || completed === files.length) {
        lastEmittedPct = pct;
        onProgress(completed, files.length);
      }
    }
  }

  const workers = Array.from({ length: Math.max(1, concurrency) }, () => worker());
  await Promise.all(workers);
  return written;
}

// Fetch repo content via GitHub API -- this is the new "clone" operation.
// Fetches per-solution with a marker file so that if EDR kills the process
// mid-fetch, the offending solution is auto-added to the local blocklist
// on next startup.
async function cloneRepo(): Promise<boolean> {
  // PAT is required: fetching ~600-2500 files would blow through the 60/hr
  // unauthenticated rate limit immediately.
  const pat = loadGitHubPat();
  if (!pat) {
    currentStatus.state = 'error';
    currentStatus.error = 'GitHub Personal Access Token required. Add one on the Repositories page before fetching.';
    broadcast();
    return false;
  }

  try {
  const repoDir = getRepoDir();

  // Clean up any partial previous state
  if (fs.existsSync(repoDir)) {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
  fs.mkdirSync(repoDir, { recursive: true });

  currentStatus.state = 'cloning';
  currentStatus.error = '';
  broadcast();

  // Progress emission: two channels
  //   'sentinel-repo:progress' -- short text log (current phase)
  //   'sentinel-repo:fetch-progress' -- structured { done, total, pct } for progress bar
  // All sends wrapped in try/catch to prevent crashes if the window closes mid-fetch.
  const safeSend = (channel: string, data: unknown) => {
    try {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          try { win.webContents.send(channel, data); } catch { /* window closed mid-send */ }
        }
      }
    } catch { /* no windows */ }
  };
  const sendPhase = (phase: string) => safeSend('sentinel-repo:progress', phase);
  const sendFetchProgress = (done: number, total: number) => safeSend('sentinel-repo:fetch-progress', {
    done, total, pct: total > 0 ? Math.round((done / total) * 100) : 0,
  });

  sendPhase('Resolving master branch commit...');
  const commitSha = await getCurrentCommitSha();
  if (!commitSha) {
    currentStatus.state = 'error';
    currentStatus.error = 'Failed to resolve master branch commit (check network / PAT).';
    broadcast();
    return false;
  }

  sendPhase('Fetching repository tree...');
  const allFiles = await getRepoTree(commitSha);
  if (allFiles.length === 0) {
    currentStatus.state = 'error';
    currentStatus.error = 'Failed to fetch repo tree (possible rate limit -- check PAT).';
    broadcast();
    return false;
  }

  // Load current blocklist (built-in + local) for this fetch run
  const blockedNames = getBlockedSolutionNames();
  const blockedCount = blockedNames.size;

  // Filter to safe files only (excluding blocked solutions)
  const safeFiles = allFiles.filter((f) => isIncluded(f.path, blockedNames));

  // Group files by solution name for per-solution fetching with marker
  const solutionFiles = new Map<string, Array<{ path: string; sha: string }>>();
  for (const f of safeFiles) {
    const parts = f.path.split('/');
    const solName = parts[1] || '__root__';
    if (!solutionFiles.has(solName)) solutionFiles.set(solName, []);
    solutionFiles.get(solName)!.push(f);
  }

  // Create directories for ALL solutions in the tree, even those with no matching files.
  // This ensures listSolutions() returns the complete list for the dropdown.
  const allSolutionNames = new Set<string>();
  for (const f of allFiles) {
    if (f.path.startsWith('Solutions/')) {
      const solName = f.path.split('/')[1];
      if (solName && !blockedNames.has(solName)) allSolutionNames.add(solName);
    }
  }
  const solutionsBase = path.join(repoDir, 'Solutions');
  for (const name of allSolutionNames) {
    const dir = path.join(solutionsBase, name);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  const totalFiles = safeFiles.length;
  const totalSolutions = solutionFiles.size;
  const totalSolutionDirs = allSolutionNames.size;
  sendPhase(`Downloading ${totalFiles} files across ${totalSolutions} solutions (${totalSolutionDirs} total, ${blockedCount} blocked)...`);
  sendFetchProgress(0, totalFiles);

  // Fetch each solution sequentially with a marker file.
  // Within each solution, files are fetched in parallel (concurrency 20).
  // If EDR kills the process during a solution fetch, the marker file
  // persists and is detected on next startup.
  let completedFiles = 0;
  let totalWritten = 0;
  let solutionsDone = 0;
  const concurrency = 20;

  for (const [solName, files] of solutionFiles) {
    // Write marker before fetching this solution
    writeFetchingMarker(solName);

    solutionsDone++;
    sendPhase(`[${solutionsDone}/${totalSolutions}] Fetching ${solName} (${files.length} files)...`);

    const written = await fetchFilesInParallel(
      files,
      commitSha,
      concurrency,
      (done, _total) => {
        sendFetchProgress(completedFiles + done, totalFiles);
      },
    );
    totalWritten += written;
    completedFiles += files.length;

    // Clear marker -- this solution fetched successfully
    clearFetchingMarker();
  }

  // Count solutions (directories under Solutions/)
  const solDir = path.join(repoDir, 'Solutions');
  let solutionCount = 0;
  if (fs.existsSync(solDir)) {
    solutionCount = fs.readdirSync(solDir, { withFileTypes: true }).filter((e) => e.isDirectory()).length;
  }

  currentStatus.state = 'ready';
  currentStatus.localPath = repoDir;
  currentStatus.lastUpdated = Date.now();
  currentStatus.lastCommit = commitSha.slice(0, 12);
  currentStatus.solutionCount = solutionCount;
  currentStatus.blockedCount = blockedCount;
  currentStatus.fetchedCount = solutionCount;
  currentStatus.error = '';
  saveStatus();
  broadcast();

  sendPhase(`Complete. ${solutionCount} solutions fetched, ${blockedCount} blocked (EDR), ${totalWritten} files written.`);
  return true;
  } catch (err) {
    // Catch-all: prevent any unexpected error from crashing the Electron main process.
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[sentinel-repo] Clone failed:', msg);
    clearFetchingMarker(); // Clean up marker on non-EDR errors
    currentStatus.state = 'error';
    currentStatus.error = `Fetch failed: ${msg.slice(0, 200)}`;
    broadcast();
    return false;
  }
}

// Update = same as clone, but checks if the commit changed first.
async function updateRepo(): Promise<boolean> {
  const repoDir = getRepoDir();
  if (!fs.existsSync(repoDir) || !fs.existsSync(path.join(repoDir, 'Solutions'))) {
    return cloneRepo();
  }

  currentStatus.state = 'updating';
  currentStatus.error = '';
  broadcast();

  const sendProgress = (data: string) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('sentinel-repo:progress', data);
      }
    }
  };

  // Check if there's a new commit
  const latestSha = await getCurrentCommitSha();
  if (!latestSha) {
    // Can't check -- mark ready so app remains usable with current files
    currentStatus.state = 'ready';
    broadcast();
    return false;
  }

  if (latestSha.slice(0, 12) === currentStatus.lastCommit) {
    // Nothing changed
    sendProgress(`Already up to date (${currentStatus.lastCommit}).\n`);
    currentStatus.state = 'ready';
    currentStatus.lastUpdated = Date.now();
    saveStatus();
    broadcast();
    return true;
  }

  // Commit changed -- re-fetch everything. Simpler than a diff-based approach
  // and still avoids EDR content since we only pull safe files.
  sendProgress(`New commit: ${latestSha.slice(0, 12)} (was ${currentStatus.lastCommit}). Re-fetching...\n`);
  return cloneRepo();
}

// ---------------------------------------------------------------------------
// Local File Access (replaces GitHub API calls)
// ---------------------------------------------------------------------------

// Check if local repo is available (at least one solution was fetched)
export function isRepoReady(): boolean {
  const solDir = path.join(getRepoDir(), 'Solutions');
  if (!fs.existsSync(solDir)) return false;
  try {
    const entries = fs.readdirSync(solDir, { withFileTypes: true }).filter((e) => e.isDirectory());
    return entries.length > 0;
  } catch { return false; }
}

// Get the local path to the Solutions directory
export function getSolutionsDir(): string {
  return path.join(getRepoDir(), 'Solutions');
}

// List all solution directories with deprecation status
export function listSolutions(): Array<{ name: string; path: string; deprecated?: boolean; deprecationReason?: string }> {
  const solDir = getSolutionsDir();
  if (!fs.existsSync(solDir)) return [];

  return fs.readdirSync(solDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const result: { name: string; path: string; deprecated?: boolean; deprecationReason?: string } = {
        name: e.name,
        path: `Solutions/${e.name}`,
      };

      // Check deprecation: directory name
      const nameLower = e.name.toLowerCase();
      if (nameLower.includes('legacy') || nameLower.includes('deprecated')) {
        result.deprecated = true;
        result.deprecationReason = 'Solution marked as legacy';
        return result;
      }

      // Check deprecation: Data/Solution_*.json content
      const dataDir = path.join(solDir, e.name, 'Data');
      if (fs.existsSync(dataDir)) {
        try {
          const dataFiles = fs.readdirSync(dataDir).filter((f) => f.startsWith('Solution_') && f.endsWith('.json'));
          for (const df of dataFiles) {
            const content = fs.readFileSync(path.join(dataDir, df), 'utf8').toLowerCase();
            if (content.includes('[deprecated]') || content.includes('about to be deprecated') ||
                content.includes('no longer recommended') || content.includes('this is a legacy')) {
              result.deprecated = true;
              result.deprecationReason = 'Connector deprecated by Microsoft';
              return result;
            }
          }
        } catch { /* skip unreadable */ }
      }

      // Check deprecation: Data Connectors with [Deprecated] tag
      for (const connDirName of ['Data Connectors', 'DataConnectors']) {
        const connDir = path.join(solDir, e.name, connDirName);
        if (!fs.existsSync(connDir)) continue;
        try {
          const files = fs.readdirSync(connDir).filter((f) => f.endsWith('.json'));
          let totalConnectors = 0;
          let deprecatedConnectors = 0;
          for (const f of files) {
            try {
              const content = fs.readFileSync(path.join(connDir, f), 'utf8');
              if (content.includes('"title"')) totalConnectors++;
              if (content.includes('[Deprecated]')) deprecatedConnectors++;
            } catch { /* skip */ }
          }
          // Only flag if ALL connectors are deprecated (some solutions have both old and new)
          if (totalConnectors > 0 && deprecatedConnectors === totalConnectors) {
            result.deprecated = true;
            result.deprecationReason = 'All connectors deprecated';
            return result;
          }
        } catch { /* skip */ }
      }

      return result;
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

// List files in a solution subdirectory
export function listSolutionFiles(
  solutionName: string,
  subDir: string,
): Array<{ name: string; path: string; size: number }> {
  const dirPath = path.join(getSolutionsDir(), solutionName, subDir);
  if (!fs.existsSync(dirPath)) return [];

  return fs.readdirSync(dirPath, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => {
      const fullPath = path.join(dirPath, e.name);
      const stat = fs.statSync(fullPath);
      return { name: e.name, path: `Solutions/${solutionName}/${subDir}/${e.name}`, size: stat.size };
    });
}

// Read a file from the local repo
export function readRepoFile(relativePath: string): string | null {
  const fullPath = path.join(getRepoDir(), relativePath);
  if (!fs.existsSync(fullPath)) return null;
  try { return fs.readFileSync(fullPath, 'utf-8'); } catch { return null; }
}

// Get SHA hash of a file (for change detection)
export function getFileHash(relativePath: string): string {
  const fullPath = path.join(getRepoDir(), relativePath);
  if (!fs.existsSync(fullPath)) return '';
  try {
    const content = fs.readFileSync(fullPath);
    return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
  } catch { return ''; }
}

// Find Data Connectors directory for a solution (handles both naming conventions)
export function findDataConnectorsDir(solutionName: string): string | null {
  const solDir = path.join(getSolutionsDir(), solutionName);
  const candidates = ['Data Connectors', 'DataConnectors', 'data_connectors'];
  for (const name of candidates) {
    const dirPath = path.join(solDir, name);
    if (fs.existsSync(dirPath)) return name;
  }
  return null;
}

// List JSON connector files for a solution (recursively searches all subdirectories)
export function listConnectorFiles(solutionName: string): Array<{ name: string; path: string; size: number }> {
  const connDir = findDataConnectorsDir(solutionName);
  if (!connDir) return [];

  const files = listSolutionFiles(solutionName, connDir)
    .filter((f) => f.name.toLowerCase().endsWith('.json'));

  // Recursively scan all subdirectories (DCR files can be nested 2+ levels deep,
  // e.g. CrowdstrikeReplicatorCLv2/Data Collection Rules/CrowdStrikeCustomDCR.json)
  const fullDir = path.join(getSolutionsDir(), solutionName, connDir);
  const scanDir = (dir: string, relPrefix: string) => {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          scanDir(path.join(dir, entry.name), `${relPrefix}/${entry.name}`);
        }
      }
      const subFiles = listSolutionFiles(solutionName, relPrefix)
        .filter((f) => f.name.toLowerCase().endsWith('.json'));
      files.push(...subFiles);
    } catch { /* skip inaccessible dirs */ }
  };

  try {
    const subDirs = fs.readdirSync(fullDir, { withFileTypes: true })
      .filter((e) => e.isDirectory());
    for (const sub of subDirs) {
      scanDir(path.join(fullDir, sub.name), `${connDir}/${sub.name}`);
    }
  } catch { /* skip */ }

  return files;
}

// Read and parse a connector JSON file
export function readConnectorJson(relativePath: string): Record<string, unknown> | null {
  const content = readRepoFile(relativePath);
  if (!content) return null;
  try { return JSON.parse(content); } catch { return null; }
}

// ---------------------------------------------------------------------------
// Analytics Rule Parser
// ---------------------------------------------------------------------------

// KQL built-in functions, operators, keywords, and Azure system-populated fields to exclude
const KQL_BUILTINS = new Set([
  // Azure auto-populated fields (never in raw vendor data, populated at ingestion time)
  // Lowercase because extractKqlFields checks with .toLowerCase()
  'timegenerated', 'tenantid', 'sourcesystem', 'mg', 'managementgroupname',
  '_resourceid', '_subscriptionid', '_itemid', '_isbillable', '_billedsize',
  'type', 'computer', 'collectorhostname', 'timecollected',
  // Functions
  'count', 'count_', 'sum', 'sum_', 'avg', 'min', 'max', 'dcount', 'arg_max', 'arg_min',
  'make_set', 'make_list', 'make_bag', 'percentile', 'stdev', 'variance',
  'tostring', 'toint', 'tolong', 'todouble', 'toreal', 'tobool', 'todatetime', 'totimespan', 'todynamic',
  'strlen', 'tolower', 'toupper', 'trim', 'substring', 'replace', 'split', 'strcat', 'strcat_delim',
  'parse_json', 'parse_url', 'parse_path', 'parse_csv', 'extract', 'extract_all',
  'startofday', 'startofweek', 'startofmonth', 'startofyear', 'endofday', 'endofweek',
  'ago', 'now', 'datetime', 'datetime_diff', 'format_datetime', 'bin', 'floor', 'ceiling',
  'ipv4_is_private', 'ipv4_is_match', 'ipv4_compare', 'isnotempty', 'isempty', 'isnull', 'isnotnull',
  'iff', 'iif', 'case', 'coalesce', 'pack', 'pack_all', 'bag_keys',
  'next', 'prev', 'row_number', 'serialize',
  // Operators and keywords
  'let', 'where', 'project', 'extend', 'summarize', 'by', 'on', 'join', 'union', 'sort', 'order',
  'asc', 'desc', 'top', 'take', 'limit', 'distinct', 'render', 'lookup', 'mv_expand', 'mv-expand',
  'evaluate', 'search', 'find', 'datatable', 'print', 'range', 'invoke', 'externaldata',
  'kind', 'inner', 'outer', 'leftouter', 'rightouter', 'fullouter', 'leftanti', 'rightanti', 'leftsemi', 'rightsemi',
  'and', 'or', 'not', 'in', 'has', 'contains', 'startswith', 'endswith', 'matches', 'between',
  'true', 'false', 'null', 'dynamic',
  // Time literals
  '1h', '1d', '2d', '7d', '14d', '30d', '1m', '5m', '10m', '15m', '30m',
  // Common computed column suffixes
  'count_', 'sum_', 'avg_', 'min_', 'max_', 'dcount_',
]);

/**
 * Extract field/column names referenced in a KQL query.
 * Identifies computed variables (let, extend) and excludes them so only
 * actual table columns are returned.
 */
export function extractKqlFields(kql: string): string[] {
  const fields = new Set<string>();
  const computed = new Set<string>(); // fields created by let/extend (not table columns)

  // Remove comments and string literals to avoid false matches
  const cleaned = kql
    .replace(/\/\/.*$/gm, '')                    // line comments
    .replace(/"[^"]*"/g, '""')                   // double-quoted strings
    .replace(/'[^']*'/g, "''")                   // single-quoted strings
    .replace(/\b\d+(\.\d+)?\b/g, '0');           // numbers

  // Step 1: Identify computed variables (not real table columns)
  // let varName = ...
  const letMatches = cleaned.matchAll(/\blet\s+(\w+)\s*=/gi);
  for (const m of letMatches) { if (m[1]) computed.add(m[1]); }
  // extend NewField = ...
  const extMatches = cleaned.matchAll(/\bextend\s+(\w+)\s*=/gi);
  for (const m of extMatches) { if (m[1]) computed.add(m[1]); }
  // summarize NewCol = func(...) -- left side of assignment in summarize
  const sumAssignMatches = cleaned.matchAll(/\bsummarize\b[^|]*?(\w+)\s*=\s*(?:count|sum|avg|min|max|dcount|arg_max|arg_min|make_set|make_list)/gi);
  for (const m of sumAssignMatches) { if (m[1]) computed.add(m[1]); }

  // Step 2: Extract field references
  const patterns = [
    /\bwhere\s+(\w+)\b/gi,
    /\bproject(?:-rename|-away)?\s+([\w,\s]+?)(?:\||$)/gim,
    /\bby\s+([\w,\s]+?)(?:\||$)/gim,
    /\bon\s+(\w+)/gi,
    /\b(\w+)\s*[!=]=~/g,
    /\bisnotempty\s*\(\s*(\w+)\s*\)/gi,
    /\bisempty\s*\(\s*(\w+)\s*\)/gi,
    /\bmake_(?:set|list)\s*\(\s*(\w+)\s*\)/gi,
    /\b(?:min|max|sum|avg|dcount)\s*\(\s*(\w+)\s*\)/gi,
    /\barg_(?:max|min)\s*\([^,]+,\s*(\w+)\s*\)/gi,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(cleaned)) !== null) {
      const captured = match[1];
      const parts = captured.split(/\s*,\s*/);
      for (const part of parts) {
        const fieldName = part.trim().split(/\s+/)[0];
        if (fieldName && fieldName.length > 1 && /^[A-Za-z_]/.test(fieldName)
            && !KQL_BUILTINS.has(fieldName.toLowerCase())
            && !computed.has(fieldName)) {
          fields.add(fieldName);
        }
      }
    }
  }

  return [...fields].sort();
}

export interface AnalyticRule {
  id: string;
  name: string;
  severity: string;
  tactics: string[];
  requiredFields: string[];  // Only fields that exist in the destination table schema
  allExtractedFields: string[]; // All fields from KQL (before schema filtering, for debugging)
  dataTypes: string[];
  query: string;
  fileName: string;
}

/**
 * List and parse analytics rules for a solution.
 * Reads YAML files from the Analytic Rules directory, extracts KQL field references,
 * and filters them against the actual destination table schema so only real table
 * columns are reported as required.
 *
 * @param tableSchemaColumns Optional set of column names from the destination table.
 *   When provided, requiredFields is intersected with this set so computed/intermediate
 *   KQL variables are excluded. Pass the result of loadDcrTemplateSchemaPublic().
 */
export function listAnalyticRules(
  solutionName: string,
  tableSchemaColumns?: Set<string>,
): AnalyticRule[] {
  if (!isRepoReady()) return [];
  const solutionsDir = getSolutionsDir();

  const dirNames = ['Analytic Rules', 'Analytics Rules', 'AnalyticRules'];
  let rulesDir = '';
  for (const d of dirNames) {
    const candidate = path.join(solutionsDir, solutionName, d);
    if (fs.existsSync(candidate)) { rulesDir = candidate; break; }
  }
  if (!rulesDir) return [];

  // Build case-insensitive schema lookup if provided
  const schemaLower = tableSchemaColumns
    ? new Set([...tableSchemaColumns].map((c) => c.toLowerCase()))
    : null;

  const rules: AnalyticRule[] = [];
  const files = fs.readdirSync(rulesDir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));

  for (const fileName of files) {
    try {
      const content = fs.readFileSync(path.join(rulesDir, fileName), 'utf-8');

      const id = content.match(/^id:\s*(.+)/m)?.[1]?.trim() || '';
      const name = content.match(/^name:\s*(.+)/m)?.[1]?.trim().replace(/^['"]|['"]$/g, '') || fileName;
      const severity = content.match(/^severity:\s*(.+)/m)?.[1]?.trim() || 'Unknown';

      const tactics: string[] = [];
      const tacticsMatch = content.match(/^tactics:\s*\n((?:\s+-\s+.+\n)*)/m);
      if (tacticsMatch) {
        for (const line of tacticsMatch[1].split('\n')) {
          const t = line.match(/^\s+-\s+(.+)/)?.[1]?.trim();
          if (t) tactics.push(t);
        }
      }

      const dataTypes: string[] = [];
      const dtMatches = content.matchAll(/dataTypes:\s*\n((?:\s+-\s+.+\n)*)/g);
      for (const dtm of dtMatches) {
        for (const line of dtm[1].split('\n')) {
          const dt = line.match(/^\s+-\s+(.+)/)?.[1]?.trim();
          if (dt) dataTypes.push(dt);
        }
      }

      const queryMatch = content.match(/^query:\s*\|?\s*\n([\s\S]*?)(?=^[a-zA-Z]|\Z)/m);
      const query = queryMatch?.[1]?.trim() || '';

      // Entity mapping column names -- but only include if they exist in the schema
      // (entity mappings often reference computed extend fields like AccountName, HostName)
      const entityFields: string[] = [];
      const colMatches = content.matchAll(/columnName:\s*(\w+)/g);
      for (const cm of colMatches) {
        if (cm[1] && !KQL_BUILTINS.has(cm[1].toLowerCase())) entityFields.push(cm[1]);
      }

      const kqlFields = extractKqlFields(query);
      const allExtracted = [...new Set([...kqlFields, ...entityFields])].sort();

      // Filter against table schema: only keep fields that are actual table columns
      const requiredFields = schemaLower
        ? allExtracted.filter((f) => schemaLower.has(f.toLowerCase()))
        : allExtracted;

      if (requiredFields.length > 0) {
        rules.push({ id, name, severity, tactics, requiredFields, allExtractedFields: allExtracted, dataTypes, query, fileName });
      }
    } catch { /* skip unparseable files */ }
  }

  return rules;
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

// Initialize on module load
// Check for crash recovery first (stale fetching marker = EDR killed the process)
checkAndRecoverFetchingMarker();
loadStatus();

// Auto-update if repo exists and last update > 12 hours ago
export async function autoUpdate(): Promise<void> {
  if (currentStatus.state === 'not_cloned') {
    // Don't auto-clone -- let the user trigger it
    return;
  }
  const twelveHours = 12 * 60 * 60 * 1000;
  if (currentStatus.state === 'ready' && (Date.now() - currentStatus.lastUpdated) > twelveHours) {
    await updateRepo();
  }
}

// ---------------------------------------------------------------------------
// IPC Handlers
// ---------------------------------------------------------------------------

export function registerSentinelRepoHandlers(ipcMain: IpcMain) {
  ipcMain.handle('sentinel-repo:status', async () => {
    loadStatus();
    return currentStatus;
  });

  // Clear a transient error state. Called after the user adds a GitHub PAT so that
  // prior "PAT required" errors don't linger in the UI.
  ipcMain.handle('sentinel-repo:reset-error', async () => {
    if (currentStatus.state === 'error') {
      loadStatus(); // recompute state based on filesystem
    }
    currentStatus.error = '';
    broadcast();
    return currentStatus;
  });

  // Clone or update the repo
  ipcMain.handle('sentinel-repo:sync', async () => {
    if (currentStatus.state === 'cloning' || currentStatus.state === 'updating') {
      return { started: false, reason: 'Operation already in progress' };
    }

    if (currentStatus.state === 'not_cloned' || currentStatus.state === 'error') {
      cloneRepo().catch(() => {
        currentStatus.state = 'error';
        currentStatus.error = 'Clone failed';
        broadcast();
      });
    } else {
      updateRepo().catch(() => {
        currentStatus.state = 'error';
        currentStatus.error = 'Update failed';
        broadcast();
      });
    }

    return { started: true };
  });

  // Force re-clone (delete and start fresh)
  ipcMain.handle('sentinel-repo:reclone', async () => {
    const repoDir = getRepoDir();
    if (fs.existsSync(repoDir)) {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
    loadStatus();
    cloneRepo().catch(() => {
      currentStatus.state = 'error';
      broadcast();
    });
    return { started: true };
  });

  // List all solutions from local repo
  ipcMain.handle('sentinel-repo:solutions', async () => {
    return listSolutions();
  });

  // Read connector files for a solution
  ipcMain.handle('sentinel-repo:connectors', async (_event, { solutionName }: { solutionName: string }) => {
    return listConnectorFiles(solutionName);
  });

  // Read a file from the local repo
  ipcMain.handle('sentinel-repo:read-file', async (_event, { relativePath }: { relativePath: string }) => {
    return readRepoFile(relativePath);
  });

  // ---------------------------------------------------------------------------
  // EDR Blocklist IPC handlers
  // ---------------------------------------------------------------------------

  // Get the full merged blocklist for UI display
  ipcMain.handle('sentinel-repo:blocklist', async () => {
    return getMergedBlocklist();
  });

  // Retry a blocked solution: removes it from the local blocklist.
  // The next fetch will attempt it again. If EDR kills the process,
  // crash detection re-adds it automatically.
  ipcMain.handle('sentinel-repo:blocklist-retry', async (_event, { solutionName }: { solutionName: string }) => {
    removeFromLocalBlocklist(solutionName);
    // Refresh status so blocked count updates in the UI
    loadStatus();
    broadcast();
    return { removed: true, blocklist: getMergedBlocklist() };
  });

  // Manually add a solution to the local blocklist
  ipcMain.handle('sentinel-repo:blocklist-add', async (_event, { solutionName, reason }: { solutionName: string; reason: string }) => {
    addToLocalBlocklist(solutionName, reason || 'Manually blocked by user', 'user');
    loadStatus();
    broadcast();
    return { added: true, blocklist: getMergedBlocklist() };
  });
}
