// The ONE definition of "this change reaches the app" and of version order
// (architecture audit 2026-11-04). Before it, check-version-bump (DBT-253) and
// check-release-drift each kept their own path list, and they disagreed: the
// release check named a directory that no longer exists (apps/cribl-app/default)
// and missed config/, public/, the Vite config and package.json. Two checks
// could then answer "did this commit change the app" differently. The version
// comparison was likewise written three times.

/** Repo-root paths whose change reaches the shipped app or Live Preview. */
export const SHIPPED_PATH_PREFIXES = Object.freeze([
  'soc-optimizationtoolkit/packages/',
  'soc-optimizationtoolkit/apps/cribl-app/src/',
  'soc-optimizationtoolkit/apps/cribl-app/config/',
  'soc-optimizationtoolkit/apps/cribl-app/public/',
  'soc-optimizationtoolkit/apps/cribl-app/index.html',
  'soc-optimizationtoolkit/apps/cribl-app/vite.config.ts',
  'soc-optimizationtoolkit/apps/cribl-app/package.json',
  'soc-optimizationtoolkit/package.json',
  'soc-optimizationtoolkit/package-lock.json',
]);

/** A test file changes neither the bundle nor what Live Preview renders. */
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;
/** Workspace docs (CONTEXT.md, README.md) inside packages/ do not ship. */
const MARKDOWN = /\.md$/;

export function isShippedPath(path) {
  if (TEST_FILE.test(path) || MARKDOWN.test(path)) return false;
  return SHIPPED_PATH_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix));
}

/**
 * The same definition as git pathspecs, from the REPO root, for git log /
 * rev-list. The exclusions are the TEST_FILE and MARKDOWN rules above.
 */
export function shippedPathspecs() {
  return [
    ...SHIPPED_PATH_PREFIXES.map((p) => p.replace(/\/$/, '')),
    ':(glob,exclude)**/*.test.*',
    ':(glob,exclude)**/*.md',
  ];
}

export const XYZ = /^(\d+)\.(\d+)\.(\d+)$/;

/** Orders X.Y.Z by component, so 1.12.0 sorts above 1.9.0. Callers validate first. */
export function compareVersions(a, b) {
  const [, a1, a2, a3] = XYZ.exec(a).map(Number);
  const [, b1, b2, b3] = XYZ.exec(b).map(Number);
  return a1 - b1 || a2 - b2 || a3 - b3;
}
