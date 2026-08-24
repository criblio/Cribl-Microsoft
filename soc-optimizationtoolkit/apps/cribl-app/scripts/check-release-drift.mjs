// Guards the claims a human otherwise has to keep true by hand.
//
// backlog.md item 8 records this decaying three times: the "IS CURRENT" version
// line sat at 1.5.4 while the app was at 1.11.11, was corrected to 1.11.11, was
// found stale again at three patch versions behind inside a single audit window,
// and was corrected a third time while shipping 1.12.0. That entry's own
// instruction is that a third manual correction is proof the check should exist
// instead - so this is it. A hand-maintained version claim decays exactly as
// fast as the automated one it warns about, and nothing tells anyone.
//
// FOUR ERRORS and ONE WARNING, and the split is deliberate. The errors are all
// facts that are free to keep true at packaging time and that read as confident
// answers when they are wrong - a doc naming the wrong version is worse than a
// doc naming none. The warning is the one thing that CANNOT be an error: the app
// releases in batches, so source landing ahead of the last package is the normal
// state of a feature branch, not a defect.
//
// The pure half takes facts and returns findings; main() gathers the facts. That
// split is what lets the rules be pinned without a repo, a git history or a tgz.

import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const appDir = join(__dirname, '..');
const toolkitDir = join(appDir, '..', '..');

const TGZ_VERSION = /^soc-optimizationtoolkit-(\d+\.\d+\.\d+)\.tgz$/;

// backlog.md item 8 states the current release as "**1.12.0 IS CURRENT (date).**".
// Prose rather than a machine field on purpose - it is read by people far more
// often than by this script - so the script reads the prose. Keep the shape if
// you reword around it.
const BACKLOG_CURRENT = /\*\*(\d+\.\d+\.\d+) IS CURRENT/;

// Source that changes what the packaged app DOES. Docs are excluded: a doc-only
// commit landing after a release is not a stale release, and warning about it
// would train people to ignore the warning.
const SOURCE_PATHS = [
  'soc-optimizationtoolkit/packages',
  'soc-optimizationtoolkit/apps/cribl-app/src',
  'soc-optimizationtoolkit/apps/cribl-app/default',
  'soc-optimizationtoolkit/apps/cribl-app/index.html',
  'soc-optimizationtoolkit/scripts',
];

/**
 * @param {{
 *   manifestVersion: string,
 *   releaseTarballs: string[],
 *   releaseNotes: string,
 *   backlog: string,
 *   sourceCommitsSinceRelease: number | null,
 * }} facts
 * @returns {{errors: string[], warnings: string[], packagedVersion: string | null}}
 */
export function evaluateReleaseDrift(facts) {
  const errors = [];
  const warnings = [];

  // The user directive from 2026-07-30 is that release/ holds EXACTLY the latest
  // tgz, and package.mjs prunes to enforce it. Two tarballs means the prune was
  // worked around - which happened three times before it was corrected - and
  // every check below would then have to pick one and could pick wrong.
  const versions = facts.releaseTarballs
    .map((name) => TGZ_VERSION.exec(name)?.[1])
    .filter((version) => version !== undefined);

  if (versions.length === 0) {
    errors.push(
      `release/ holds no soc-optimizationtoolkit-X.Y.Z.tgz (found: ${
        facts.releaseTarballs.join(', ') || 'nothing'
      }). Run scripts/package.mjs - it writes the tracked copy.`,
    );
    return { errors, warnings, packagedVersion: null };
  }

  if (versions.length > 1) {
    errors.push(
      `release/ holds ${versions.length} tarballs (${versions.join(', ')}). It holds exactly the latest by directive; package.mjs prunes the rest.`,
    );
  }

  const packagedVersion = versions.slice().sort().at(-1) ?? versions[0];

  // A manifest ahead of the tarball is the double-bump this repo has already hit:
  // editing package.json and THEN packaging bumps twice, and the tgz name is the
  // only place the doubled number shows. A manifest behind it should be
  // impossible, since package.mjs writes both.
  if (facts.manifestVersion !== packagedVersion) {
    errors.push(
      `package.json says ${facts.manifestVersion} but the packaged tarball is ${packagedVersion}. Do not hand-bump: scripts/package.mjs IS the bump.`,
    );
  }

  if (!hasReleaseNotesSection(facts.releaseNotes, packagedVersion)) {
    errors.push(
      `docs/release-notes.md has no "## ${packagedVersion}" section. The packaged version is the one people install; an unnoted release is one nobody can read.`,
    );
  }

  const claimed = BACKLOG_CURRENT.exec(facts.backlog)?.[1];
  if (claimed === undefined) {
    errors.push(
      'docs/backlog.md no longer states a current version ("**X.Y.Z IS CURRENT"). This check reads that line; restore it or update this script.',
    );
  } else if (claimed !== packagedVersion) {
    errors.push(
      `docs/backlog.md says ${claimed} IS CURRENT, but the packaged tarball is ${packagedVersion}.`,
    );
  }

  // The warning, and the only finding that is about work rather than about
  // bookkeeping. It cannot be an error: unreleased source is the normal state of
  // a feature branch.
  if (facts.sourceCommitsSinceRelease !== null && facts.sourceCommitsSinceRelease > 0) {
    warnings.push(
      `${facts.sourceCommitsSinceRelease} source commit(s) have landed since ${packagedVersion} was packaged. The tgz in release/ does not contain them, and neither does anything anyone installs from this repo.`,
    );
  }

  return { errors, warnings, packagedVersion };
}

/**
 * Matches the heading for one version and not the versions it prefixes: "## 1.1.2"
 * must not satisfy a check for "## 1.1.2" inside "## 1.1.20".
 */
function hasReleaseNotesSection(notes, version) {
  return notes
    .split('\n')
    .some((line) => line.trim() === `## ${version}`);
}

async function gatherFacts() {
  const [manifest, releaseEntries, releaseNotes, backlog] = await Promise.all([
    readFile(join(appDir, 'package.json'), 'utf8'),
    readdir(join(appDir, 'release')).catch(() => []),
    readFile(join(toolkitDir, 'docs', 'release-notes.md'), 'utf8'),
    readFile(join(toolkitDir, 'docs', 'backlog.md'), 'utf8'),
  ]);

  return {
    manifestVersion: JSON.parse(manifest).version,
    releaseTarballs: releaseEntries.filter((name) => name.endsWith('.tgz')),
    releaseNotes,
    backlog,
    sourceCommitsSinceRelease: countSourceCommitsSinceRelease(),
  };
}

/**
 * null rather than 0 when git cannot answer - a shallow clone has no history to
 * count, and reporting "0 commits since the release" there would be a measured
 * zero invented from an unmeasured absence.
 */
function countSourceCommitsSinceRelease() {
  try {
    // Pathspecs resolve against the CWD, and SOURCE_PATHS are written from the
    // REPO root - the toolkit is one directory down. Running git here rather
    // than in the toolkit is what makes them match anything at all: with the
    // wrong cwd every path matches nothing, the count is zero, and the check
    // passes silently having measured nothing.
    const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: toolkitDir,
      encoding: 'utf8',
    }).trim();

    const releaseCommit = git(repoRoot, [
      'log', '-1', '--format=%H', '--',
      'soc-optimizationtoolkit/apps/cribl-app/release',
    ]);
    if (!releaseCommit) return null;

    const count = git(repoRoot, [
      'rev-list', '--count', `${releaseCommit}..HEAD`, '--', ...SOURCE_PATHS,
    ]);
    return count === '' ? null : Number(count);
  } catch {
    return null;
  }
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

// Annotations rather than bare lines: on GitHub these attach to the run, and
// locally they are still readable text.
function annotate(level, message) {
  const prefix = process.env.GITHUB_ACTIONS === 'true' ? `::${level}::` : `${level}: `;
  console.log(`${prefix}${message}`);
}

async function main() {
  const facts = await gatherFacts();
  const { errors, warnings, packagedVersion } = evaluateReleaseDrift(facts);

  for (const warning of warnings) annotate('warning', warning);
  for (const error of errors) annotate('error', error);

  if (errors.length > 0) {
    console.log(`\nRelease drift: ${errors.length} error(s), ${warnings.length} warning(s).`);
    process.exitCode = 1;
    return;
  }

  console.log(
    `Release ${packagedVersion} is consistent across package.json, release/, release-notes.md and backlog.md` +
      `${warnings.length > 0 ? ` (${warnings.length} warning(s) above)` : ''}.`,
  );
}

// Only when run directly, so the pure half can be imported by its pins.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
