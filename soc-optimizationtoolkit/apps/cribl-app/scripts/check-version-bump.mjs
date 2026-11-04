// The version-bump gate (DBT-250): a PR to main that changes what the app ships,
// or what Live Preview shows, must raise the app version above main's.
//
// Why it exists: the operator's rule (2026-11-04) is that the 1.13.x patch
// number changes every time something reaches main. Six PRs (#188, #192, #193,
// #198, #201, #202) merged with main left at 1.13.0, because the rule lived only
// in conversation and nothing asked for it. A rule this repo only writes down
// gets broken (CLAUDE.md board rule 4), so it is a check.
//
// VERSION ONLY, by the operator's choice: a PR runs `npm run bump`, which moves
// package.json and the lock. Packaging the .tgz, the release-notes section and
// the backlog "IS CURRENT" line stay batched; check-release-drift warns while
// the manifest is ahead of the last package and names the release command.
//
// SCOPE: what ships, plus what Live Preview shows (the footer reads
// package.json's version at runtime). Docs, the board, release tooling and test
// files change neither, so a PR touching only those needs no bump - and the
// gate says so rather than passing silently.
//
// The pure half takes facts and returns findings; main() gathers them from git.

import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHIPPED_PATH_PREFIXES, XYZ, compareVersions, isShippedPath } from './shipped-paths.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const appDir = join(__dirname, '..');
const APP_MANIFEST = 'soc-optimizationtoolkit/apps/cribl-app/package.json';

export { SHIPPED_PATH_PREFIXES, isShippedPath };

const MAX_LISTED = 10;

/**
 * @param {{ baseVersion: string, headVersion: string, changedPaths: string[] }} facts
 * @returns {{ errors: string[], notes: string[], required: boolean, shipped: string[] }}
 */
export function evaluateVersionBump(facts) {
  const errors = [];
  const notes = [];
  const shipped = facts.changedPaths.filter(isShippedPath);
  const required = shipped.length > 0;

  for (const [label, version] of [['main', facts.baseVersion], ['this branch', facts.headVersion]]) {
    if (!XYZ.test(version ?? '')) {
      errors.push(`The app version on ${label} is "${version}", which is not X.Y.Z, so the bump cannot be judged.`);
    }
  }
  if (errors.length > 0) return { errors, notes, required, shipped };

  if (!required) {
    notes.push(
      `This PR changes nothing that ships or that Live Preview shows (${facts.changedPaths.length} file(s) changed), so no bump required.`,
    );
    return { errors, notes, required, shipped };
  }

  if (compareVersions(facts.headVersion, facts.baseVersion) <= 0) {
    const listed = shipped.slice(0, MAX_LISTED).join(', ');
    const more = shipped.length > MAX_LISTED ? ` and ${shipped.length - MAX_LISTED} more` : '';
    errors.push(
      `This PR changes what the app ships or Live Preview shows (${listed}${more}) but leaves the version at ${facts.headVersion}, ` +
        `not above main's ${facts.baseVersion}. Run "npm run bump" from soc-optimizationtoolkit and commit package.json and package-lock.json.`,
    );
  } else {
    notes.push(`Version ${facts.headVersion} is above main's ${facts.baseVersion}.`);
  }
  return { errors, notes, required, shipped };
}

/**
 * The base to compare against. In CI the PR's own base (GITHUB_BASE_REF); the
 * rule is about main, so a PR into another branch is reported, not enforced.
 */
export function parseArgs(args, env) {
  const i = args.indexOf('--base');
  if (i >= 0 && args[i + 1]) {
    const base = args[i + 1];
    return { base, enforce: base === 'origin/main' };
  }
  const ref = env.GITHUB_BASE_REF;
  if (ref) return { base: `origin/${ref}`, enforce: ref === 'main' };
  return { base: 'origin/main', enforce: true };
}

function git(args) {
  return execFileSync('git', args, { cwd: appDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

async function main() {
  const { base, enforce } = parseArgs(process.argv.slice(2), process.env);
  let facts;
  try {
    const repoRoot = git(['rev-parse', '--show-toplevel']).trim();
    facts = {
      baseVersion: JSON.parse(git(['show', `${base}:${APP_MANIFEST}`])).version,
      headVersion: JSON.parse(await readFile(join(repoRoot, APP_MANIFEST), 'utf8')).version,
      changedPaths: git(['diff', '--name-only', `${base}...HEAD`]).split('\n').filter(Boolean),
    };
  } catch (err) {
    // Unmeasured is not a pass: say so, and fail, since the gate exists for CI.
    console.error(`Version bump NOT checked: could not read ${base} from git (${err.message.split('\n')[0]}). Fetch it (git fetch origin) and re-run.`);
    process.exit(1);
  }

  const result = evaluateVersionBump(facts);
  for (const note of result.notes) console.log(note);
  if (result.errors.length === 0) return;
  if (!enforce) {
    for (const e of result.errors) console.log(`Not enforced (base is ${base}, not origin/main): ${e}`);
    return;
  }
  for (const e of result.errors) console.error(`error: ${e}`);
  process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
