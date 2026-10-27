// request-scan.ts - find the Cribl API call sites in the source, so a call that
// is not in API_CALLS (paths.ts) fails a test instead of reaching an admin as a
// 403 that only non-admins ever see.
//
// Pure: it takes {path, text} pairs and returns what it found. The test feeds it
// the real source tree.
//
// WHICH CALLS ARE CRIBL CALLS. The app has two request ports with the same shape
// - CriblClient and AzureManagement both take `{method, path, ...}` - and ARM
// request BUILDERS return `{ method: 'GET', path: '/subscriptions/...' }` objects
// all over core (eventhub-arm.ts, for one). A scan that took every `path:` literal
// would drown in ARM paths. So the rule is narrow on purpose:
//
//   1. Only CRIBL FILES are scanned: a file that imports the Cribl client
//      (`ports/cribl-client`, the `CriblClient` name from any module,
//      `kit/cribl-request`, `kit/config-writes/...`, or the UI's `ports-context`),
//      or that lives under `kit/config-writes/` or `kit/metrics/`.
//   2. Inside a Cribl file, two call shapes are extracted:
//      - `<receiver>.request({ ... path: <literal> ... })` where the receiver's
//        text matches /cribl/i (`cribl.request`, `ports.cribl.request`,
//        `this.cribl.request`). The object literal must be the argument itself;
//        a request built by a helper and passed in is NOT seen.
//      - the kit's transport style, `request('METHOD', <literal>)` and the
//        create-cribl-source wrapper `safeCall(request, 'METHOD', <literal>)`.
//        These paths are group-relative unless they start with /products/,
//        /master/ or /m/<g>/ (kit/cribl-request.ts routeCriblPath).
//   3. A Cribl file that ALSO imports the Azure port is MIXED and must be on the
//      reviewed MIXED_FILES list. Its Cribl calls are still extracted by rule 2,
//      which is what keeps its ARM calls out.
//   4. A template path that does not normalise to whole segments (e.g.
//      `/p/${pack}${path}`) cannot be checked and must be on the reviewed
//      DYNAMIC_PATHS list.
//
//   5. A Cribl call it finds but cannot read - `path: ROUTES_API_PATH`, the
//      shorthand `{ path }`, or a kit `request(method, path)` whose method is not
//      a literal - is reported as dynamic too, so it must be on DYNAMIC_PATHS.
//
// WHAT IT CANNOT SEE: a request object built by a helper and passed in
// (`cribl.request(buildEnsureSecretRequest(...))`), and raw fetch() calls.
// Those entries in API_CALLS are kept honest by review.

import type { Method } from './policyCoverage';

export interface SourceFile {
  /** Repo-relative, posix. */
  path: string;
  text: string;
}

/** One extracted Cribl call, in policy grammar. */
export interface ScannedCall {
  file: string;
  line: number;
  /** null when the method is not a literal at the call site. */
  method: Method | null;
  /** Policy grammar: `/m/:gid/...` for a group-context call, template holes as `:p`. */
  path: string;
  /** The path expression as written. */
  raw: string;
  shape: 'object' | 'kit';
}

/** A template path that does not normalise to whole segments. */
export interface DynamicCall {
  file: string;
  line: number;
  raw: string;
}

export interface ScanResult {
  calls: ScannedCall[];
  dynamic: DynamicCall[];
  /** Cribl files that also import the Azure port. */
  mixed: string[];
}

/**
 * Reviewed: Cribl files that also import the Azure port. Each was read and its
 * ARM calls confirmed to go through `azure.request(...)` / a builder, never a
 * receiver matching /cribl/i.
 */
export const MIXED_FILES: readonly string[] = [
  // Both adapters in one module; ARM goes through fetchWithTimeout, Cribl through this.cribl.request.
  'apps/cribl-app/src/platform/adapters.ts',
  'packages/core/src/usecases/capability-audit/capability-audit.ts',
  'packages/core/src/usecases/create-cribl-source/plan-cribl-source.ts',
  'packages/core/src/usecases/onboard-table/onboard-table.ts',
  'packages/core/src/usecases/permission-preflight/permission-preflight.ts',
  // Port types and the context only; no request of its own.
  'packages/ui/src/ports-context.ts',
  // ARM only (readLoggingMap); it takes ports from ports-context and never calls Cribl.
  'packages/ui/src/screens/azure-logging-map/azure-logging-map-screen.tsx',
];

/** Reviewed: Cribl call paths the scan cannot normalise, with why each is registered. */
export const DYNAMIC_PATHS: readonly { file: string; raw: string; why: string }[] = [
  {
    file: 'packages/core/src/usecases/live-architecture/fetch-live-architecture.ts',
    raw: '`/p/${encodeURIComponent(packId)}${path}`',
    why: 'the four PACK_SECTION_PATHS under /m/:gid/p/:pack - each is in API_CALLS',
  },
  {
    file: 'packages/core/src/kit/config-writes/readModifyWrite.ts',
    raw: 'target.path',
    why: 'the kit reads whatever WriteTarget the caller passes; create-cribl-source passes /system/inputs/:id (API_CALLS)',
  },
  {
    file: 'packages/core/src/kit/config-writes/readModifyWrite.ts',
    raw: 'path',
    why: 'the kit verifyStored/read helpers read the caller path; create-cribl-source passes /system/inputs/:id (API_CALLS)',
  },
  {
    file: 'packages/core/src/kit/config-writes/readModifyWrite.ts',
    raw: 'target.method, target.path',
    why: 'the kit write itself (method and path from the WriteTarget); create-cribl-source imports only verifyStored from this file, never the write, so no shipped caller reaches it; a new caller must add its grant to API_CALLS and policies.yml',
  },
  {
    file: 'packages/core/src/kit/config-writes/commitDeploy.ts',
    raw: 'method, path',
    why: 'the kit safeCall wrapper; every method/path it forwards is a literal at its own call site, which the scan reads (version/status, version/commit, version, deploy)',
  },
  {
    file: 'packages/core/src/kit/metrics/metricsQuery.ts',
    raw: 'metricsQueryPath(groupId)',
    why: "'/m/<g>/system/metrics/query' - POST /m/:gid/system/metrics/query in API_CALLS (read-source-flow)",
  },
  {
    file: 'packages/core/src/usecases/live-architecture/fetch-live-architecture.ts',
    raw: 'path',
    why: 'shorthand `{ path }` over SECTION_PATHS: GET /m/:gid/{system/inputs,system/outputs,routes,pipelines,lib/breakers,packs,jobs} - each in API_CALLS',
  },
  {
    file: 'packages/core/src/usecases/read-source-flow/read-onboarding-cribl-side.ts',
    raw: 'path',
    why: 'shorthand `{ path }` over CRIBL_SIDE_PATHS: GET /m/:gid/system/inputs and GET /m/:gid/routes (AZR-30) - both in API_CALLS',
  },
  {
    file: 'packages/core/src/usecases/permission-preflight/permission-preflight.ts',
    raw: 'spec.path',
    why: 'CRIBL_CAPABILITY_PROBES: GET /m/:gid/{packs,system/outputs,system/inputs,routes} - each in API_CALLS',
  },
  {
    file: 'packages/core/src/usecases/capture-samples/capture-samples.ts',
    raw: 'SYSTEM_CAPTURE_PATH',
    why: "'/system/capture' - POST /m/:gid/system/capture in API_CALLS",
  },
  {
    file: 'packages/core/src/usecases/guided-deploy/wire-source.ts',
    raw: 'ROUTES_API_PATH',
    why: "'/routes' - GET and PUT /m/:gid/routes in API_CALLS",
  },
  {
    file: 'packages/core/src/usecases/guided-deploy/wire-source.ts',
    raw: 'LAKE_DATASETS_API_PATH',
    why: "'/system/lake/datasets' - POST /system/lake/datasets in API_CALLS",
  },
  {
    file: 'packages/core/src/usecases/guided-deploy/wire-source.ts',
    raw: 'COMMIT_API_PATH',
    why: "'/version/commit' - POST /m/:gid/version/commit in API_CALLS",
  },
  {
    file: 'packages/core/src/usecases/guided-deploy/wire-source.ts',
    raw: 'deployApiPath(g)',
    why: "'/master/groups/<g>/deploy' - PATCH /master/groups/:id/deploy in API_CALLS",
  },
  {
    file: 'packages/core/src/usecases/query-lake-samples/query-lake-samples.ts',
    raw: 'SEARCH_JOBS_PATH',
    why: "'/search/jobs' - POST /m/:gid/search/jobs in API_CALLS",
  },
  {
    file: 'packages/core/src/usecases/query-lake-samples/query-lake-samples.ts',
    raw: 'searchJobStatusPath(jobId)',
    why: "'/search/jobs/<id>/status' - GET /m/:gid/search/jobs/:id/status in API_CALLS",
  },
  {
    file: 'packages/core/src/usecases/query-lake-samples/query-lake-samples.ts',
    raw: 'searchJobResultsPath(jobId)',
    why: "'/search/jobs/<id>/results' - GET /m/:gid/search/jobs/:id/results in API_CALLS",
  },
];

const METHODS = new Set<string>(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

const CRIBL_IMPORT: readonly RegExp[] = [
  /from\s+['"][^'"]*ports\/cribl-client['"]/,
  /from\s+['"][^'"]*kit\/cribl-request['"]/,
  /from\s+['"][^'"]*kit\/config-writes\/[^'"]+['"]/,
  /from\s+['"][^'"]*ports-context['"]/,
  /import\s+(?:type\s+)?\{[^}]*\bCriblClient\b[^}]*\}\s*from/,
];
const AZURE_IMPORT: readonly RegExp[] = [
  /from\s+['"][^'"]*ports\/azure-management['"]/,
  /import\s+(?:type\s+)?\{[^}]*\bAzureManagement\b[^}]*\}\s*from/,
];
const KIT_DIRS = /(^|\/)kit\/(config-writes|metrics)\//;

export const isTestFile = (path: string): boolean =>
  /\.test\.[cm]?[jt]sx?$|\.test-util\.[jt]sx?$|(^|\/)testing\/|(^|\/)fake-[^/]*$/.test(path);

export function isCriblFile(f: SourceFile): boolean {
  return KIT_DIRS.test(f.path) || CRIBL_IMPORT.some((re) => re.test(f.text));
}

export function isMixedFile(f: SourceFile): boolean {
  return isCriblFile(f) && !KIT_DIRS.test(f.path) && AZURE_IMPORT.some((re) => re.test(f.text));
}

// ---------------------------------------------------------------------------
// A small reader: balanced braces/parens, strings, templates and comments.
// ---------------------------------------------------------------------------

/** Index just past the string/template/comment starting at i, or i when none starts there. */
function skipNonCode(s: string, i: number): number {
  const c = s[i];
  if (c === '/' && s[i + 1] === '/') {
    const nl = s.indexOf('\n', i);
    return nl < 0 ? s.length : nl;
  }
  if (c === '/' && s[i + 1] === '*') {
    const end = s.indexOf('*/', i + 2);
    return end < 0 ? s.length : end + 2;
  }
  if (c === "'" || c === '"') {
    let j = i + 1;
    while (j < s.length && s[j] !== c) j += s[j] === '\\' ? 2 : 1;
    return j + 1;
  }
  if (c === '`') {
    let j = i + 1;
    while (j < s.length && s[j] !== '`') {
      if (s[j] === '\\') j += 2;
      else if (s[j] === '$' && s[j + 1] === '{') j = matchClose(s, j + 1) + 1;
      else j += 1;
    }
    return j + 1;
  }
  return i;
}

/** Index of the bracket closing the one at `open`. */
function matchClose(s: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < s.length) {
    const skipped = skipNonCode(s, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    const c = s[i];
    if (c === '{' || c === '(' || c === '[') depth += 1;
    else if (c === '}' || c === ')' || c === ']') {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return s.length;
}

/** Split `s` on commas at depth 0. */
function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < s.length) {
    const skipped = skipNonCode(s, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    const c = s[i];
    if (c === '{' || c === '(' || c === '[') depth += 1;
    else if (c === '}' || c === ')' || c === ']') depth -= 1;
    else if (c === ',' && depth === 0) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
    i += 1;
  }
  parts.push(s.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p !== '');
}

/** Text of the next call argument starting at i (up to a depth-0 comma or the closing paren). */
function nextArgument(s: string, i: number): string {
  let depth = 0;
  let j = i;
  while (j < s.length) {
    const skipped = skipNonCode(s, j);
    if (skipped !== j) {
      j = skipped;
      continue;
    }
    const c = s[j];
    if (c === '{' || c === '(' || c === '[') depth += 1;
    else if (c === '}' || c === ')' || c === ']') {
      if (depth === 0) break;
      depth -= 1;
    } else if (c === ',' && depth === 0) break;
    j += 1;
  }
  return s.slice(i, j).trim();
}

const lineOf = (s: string, index: number): number => s.slice(0, index).split('\n').length;

// ---------------------------------------------------------------------------
// Path normalisation
// ---------------------------------------------------------------------------

type PathRead = { kind: 'path'; path: string } | { kind: 'dynamic' } | { kind: 'indirect' };

const HOLE = '\u0000';

/** Read a path expression: a literal, a template, or something the scan cannot see. */
export function readPathExpression(expr: string): PathRead {
  const quoted = /^(['"])([^'"\\]*)\1$/.exec(expr);
  let text: string | null = quoted ? quoted[2]! : null;
  if (text === null && expr.startsWith('`') && expr.endsWith('`') && expr.length >= 2) {
    // Replace each ${...} with one HOLE.
    const body = expr.slice(1, -1);
    let out = '';
    let i = 0;
    while (i < body.length) {
      if (body[i] === '$' && body[i + 1] === '{') {
        i = matchClose(body, i + 1) + 1;
        out += HOLE;
      } else {
        out += body[i];
        i += 1;
      }
    }
    text = out;
  }
  if (text === null) return { kind: 'indirect' };
  const pathname = text.split('?')[0]!;
  if (!pathname.startsWith('/')) return { kind: 'dynamic' };
  const segs = pathname.split('/').slice(1);
  const norm: string[] = [];
  for (const seg of segs) {
    if (!seg.includes(HOLE)) norm.push(seg);
    else if (seg === HOLE) norm.push(':p');
    else return { kind: 'dynamic' };
  }
  return { kind: 'path', path: `/${norm.join('/')}` };
}

const LEADER = /^\/(products|master)\//;

/** Kit transport paths: group-relative unless leader-level or explicit /m/<g>/ (routeCriblPath). */
function kitPolicyPath(path: string): string {
  if (LEADER.test(path)) return path;
  const m = /^\/m\/[^/]+(\/.*)?$/.exec(path);
  if (m) return `/m/:gid${m[1] ?? ''}`;
  return `/m/:gid${path}`;
}

// ---------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------

const OBJECT_CALL = /([A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*)\??\.request\(\s*\{/g;
/** `request(` not preceded by `.` or an identifier character: the kit transport call. */
const KIT_INDIRECT_CALL = /(?<![.\w$])request\(\s*/g;
const KIT_CALL = /\b(?:safeCall\(\s*request\s*,|request\()\s*(['"])(GET|POST|PUT|PATCH|DELETE)\1\s*,\s*/g;

function propValue(props: string[], key: string): string | null | undefined {
  for (const p of props) {
    if (p === key) return null; // shorthand: present, value is an identifier
    const m = new RegExp(`^${key}\\s*:\\s*([\\s\\S]*)$`).exec(p);
    if (m) return m[1]!.trim();
  }
  return undefined;
}

export function scanFile(f: SourceFile): ScanResult {
  const result: ScanResult = { calls: [], dynamic: [], mixed: isMixedFile(f) ? [f.path] : [] };
  if (!isCriblFile(f)) return result;
  const s = f.text;

  for (const m of s.matchAll(OBJECT_CALL)) {
    const receiver = m[1]!;
    if (!/cribl/i.test(receiver)) continue;
    const open = m.index! + m[0].length - 1;
    const close = matchClose(s, open);
    const props = splitTopLevel(s.slice(open + 1, close));
    const pathProp = propValue(props, 'path');
    if (pathProp === undefined) continue;
    const line = lineOf(s, m.index!);
    // Shorthand `{ path }` reads the identifier `path`; report it like any other
    // path the scan cannot see, so the reviewed DYNAMIC_PATHS list must name it.
    const pathExpr = pathProp === null ? 'path' : pathProp;
    const read = readPathExpression(pathExpr);
    if (read.kind === 'dynamic' || read.kind === 'indirect') {
      result.dynamic.push({ file: f.path, line, raw: pathExpr });
      continue;
    }
    const methodExpr = propValue(props, 'method');
    const lit = methodExpr ? /^['"]([A-Z]+)['"]$/.exec(methodExpr) : null;
    const method = lit && METHODS.has(lit[1]!) ? (lit[1] as Method) : null;
    const groupExpr = propValue(props, 'groupId');
    const grouped = groupExpr !== undefined && groupExpr !== 'undefined';
    result.calls.push({
      file: f.path,
      line,
      method,
      path: grouped ? `/m/:gid${read.path}` : read.path,
      raw: pathExpr,
      shape: 'object',
    });
  }

  for (const m of s.matchAll(KIT_CALL)) {
    const start = m.index! + m[0].length;
    const expr = nextArgument(s, start);
    const line = lineOf(s, m.index!);
    const read = readPathExpression(expr);
    if (read.kind === 'dynamic' || read.kind === 'indirect') {
      result.dynamic.push({ file: f.path, line, raw: expr });
      continue;
    }
    result.calls.push({
      file: f.path,
      line,
      method: m[2] as Method,
      path: kitPolicyPath(read.path),
      raw: expr,
      shape: 'kit',
    });
  }

  // Kit-style calls whose METHOD is not a literal (`request(target.method,
  // target.path, ...)`) cannot be matched to a grant at all. Only kit files use
  // this transport shape, so only they are checked; the raw text carries both
  // arguments so a write site stays distinct from a GET of the same path.
  if (KIT_DIRS.test(f.path)) {
    for (const m of s.matchAll(KIT_INDIRECT_CALL)) {
      const start = m.index! + m[0].length;
      const methodExpr = nextArgument(s, start);
      if (/^['"]/.test(methodExpr) || methodExpr === '') continue;
      let after = start + s.slice(start).indexOf(methodExpr) + methodExpr.length;
      while (after < s.length && /\s/.test(s[after]!)) after += 1;
      const pathExpr = s[after] === ',' ? nextArgument(s, after + 1) : '';
      result.dynamic.push({ file: f.path, line: lineOf(s, m.index!), raw: `${methodExpr}, ${pathExpr}` });
    }
  }
  return result;
}

export function scanSources(files: readonly SourceFile[]): ScanResult {
  const out: ScanResult = { calls: [], dynamic: [], mixed: [] };
  for (const f of files) {
    if (isTestFile(f.path)) continue;
    const r = scanFile(f);
    out.calls.push(...r.calls);
    out.dynamic.push(...r.dynamic);
    out.mixed.push(...r.mixed);
  }
  return out;
}
