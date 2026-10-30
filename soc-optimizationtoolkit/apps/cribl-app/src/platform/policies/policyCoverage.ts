// policyCoverage.ts — compare the API calls an app makes with what config/policies.yml grants.
//
// Enforces standards/cribl-app-permissions.md → "Declare" and "Wildcards are undefined".
//
// policies.yml is a GRANT, not documentation (AGENTS.md: declared policies are granted to every
// user the app is shared with, for requests made through the app). It can be wrong two ways:
//   undeclared    — a call with no grant: a 403/401 that only non-admins ever see
//   over-declared — a grant with no call: an admin asked to trust more than the app uses
// plus three structural rules:
//   wildcard      — `*` in a path: whether it matches one segment or a whole subtree is Undefined,
//                   and an admin's own calls never exercise the matcher, so no test can settle it.
//                   Use literals and `:name` segments only.
//   wildcardAction — `actions: ['*']` grants every method; declare the ones you call.
//   appScoped     — `/kvstore` or `/proxy` paths are granted with the app; AGENTS.md says never
//                   to redeclare them.
//
// Matching is deliberately conservative: a `:name` segment (in either list) matches exactly one
// segment, literals match literally. What this cannot prove: that the platform's matcher agrees.

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface ApiCall {
  method: Method;
  /** Policy grammar: literals and `:name` segments, e.g. `/m/:gid/system/inputs/:id`. */
  path: string;
  /** Where in the app the call is made — so a reviewer can check the claim. */
  caller: string;
}

export interface PolicyEntry {
  object: string;
  actions: string[];
}

export interface CoverageReport {
  undeclared: ApiCall[];
  overDeclared: { object: string; action: string }[];
  wildcardPaths: string[];
  wildcardActions: string[];
  appScoped: string[];
}

const segments = (p: string) => p.split('/').filter(Boolean);
const isParam = (s: string) => s.startsWith(':');

/** Whether a declared object covers a called path, one segment for one segment. */
export function covers(object: string, path: string): boolean {
  const a = segments(object);
  const b = segments(path);
  if (a.length !== b.length) return false;
  return a.every((seg, i) => seg === b[i] || isParam(seg) || isParam(b[i]!));
}

const APP_SCOPED = /^\/(a\/[^/]+\/)?(kvstore|proxy)(\/|$)/;

export function checkCoverage(calls: readonly ApiCall[], policies: readonly PolicyEntry[]): CoverageReport {
  const report: CoverageReport = { undeclared: [], overDeclared: [], wildcardPaths: [], wildcardActions: [], appScoped: [] };

  for (const p of policies) {
    if (p.object.includes('*')) report.wildcardPaths.push(p.object);
    if (p.actions.includes('*')) report.wildcardActions.push(p.object);
    if (APP_SCOPED.test(p.object)) report.appScoped.push(p.object);
  }

  for (const call of calls) {
    const granted = policies.some(
      (p) => covers(p.object, call.path) && (p.actions.includes(call.method) || p.actions.includes('*')),
    );
    if (!granted) report.undeclared.push(call);
  }

  for (const p of policies) {
    for (const action of p.actions) {
      if (action === '*') continue;
      const used = calls.some((c) => c.method === action && covers(p.object, c.path));
      if (!used) report.overDeclared.push({ object: p.object, action });
    }
  }
  return report;
}

export const isClean = (r: CoverageReport) =>
  r.undeclared.length + r.overDeclared.length + r.wildcardPaths.length + r.wildcardActions.length + r.appScoped.length === 0;

/**
 * Parse the policies.yml subset Cribl apps use: a top-level `policies:` list of `- object: '…'`
 * entries with `actions: [...]` (inline) or a block list of actions. Comments ignored. Throws on
 * anything it does not understand rather than guessing — an unparsed grant is an unchecked grant.
 */
export function parsePoliciesYml(text: string): PolicyEntry[] {
  const out: PolicyEntry[] = [];
  let current: PolicyEntry | null = null;
  let inActionsBlock = false;
  const unquote = (s: string) => s.trim().replace(/^['"]|['"]$/g, '');

  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.replace(/\s+#.*$/, '').replace(/^\s*#.*$/, '');
    if (line.trim() === '' || /^policies:\s*$/.test(line.trim())) continue;
    const obj = line.match(/^\s*-\s*object:\s*(.+)$/);
    if (obj) {
      current = { object: unquote(obj[1]!), actions: [] };
      out.push(current);
      inActionsBlock = false;
      continue;
    }
    const inline = line.match(/^\s*actions:\s*\[(.*)\]\s*$/);
    if (inline && current) {
      current.actions = inline[1]!.split(',').map(unquote).filter(Boolean);
      inActionsBlock = false;
      continue;
    }
    if (/^\s*actions:\s*$/.test(line) && current) {
      inActionsBlock = true;
      continue;
    }
    const item = line.match(/^\s*-\s*(.+)$/);
    if (item && inActionsBlock && current) {
      current.actions.push(unquote(item[1]!));
      continue;
    }
    throw new Error(`policies.yml line ${i + 1}: cannot parse ${JSON.stringify(raw)}`);
  }
  return out;
}

/** One readable failure message per problem class, for test output. */
export function describeReport(r: CoverageReport): string {
  const lines: string[] = [];
  for (const c of r.undeclared) lines.push(`undeclared: ${c.method} ${c.path} (called from ${c.caller})`);
  for (const o of r.overDeclared) lines.push(`over-declared: ${o.action} ${o.object} (no call uses it)`);
  for (const w of r.wildcardPaths) lines.push(`wildcard path: ${w} (use literals and :name segments)`);
  for (const w of r.wildcardActions) lines.push(`wildcard action: ${w} (list the methods you call)`);
  for (const a of r.appScoped) lines.push(`app-scoped path declared: ${a} (granted with the app; remove it)`);
  return lines.join('\n');
}
