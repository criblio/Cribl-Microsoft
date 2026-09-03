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
// FIVE ERRORS and ONE WARNING, and the split is deliberate. The errors are all
// facts that are free to keep true at packaging time and that read as confident
// answers when they are wrong - a doc naming the wrong version is worse than a
// doc naming none. The warning is the one thing that CANNOT be an error: the app
// releases in batches, so source landing ahead of the last package is the normal
// state of a feature branch, not a defect.
//
// The fifth error - package-lock.json - was added after the lock was found
// recording 1.11.5 while package.json said 1.12.3, and the argument against it
// was taken seriously first. The lock is GENERATED, so a claim on it risks
// failing whenever someone forgets npm install, which is how a check gets
// bypassed rather than obeyed. Three measurements settled it the other way.
// (1) That field mirrors package.json's version and NOTHING else, and
// package.json's version is written in exactly one place - package.mjs, which
// bumps it and never runs npm. So the lock can only drift at the release commit;
// ordinary dependency work already forces an npm install. The false-positive
// surface is one moment, not every day. (2) It does not self-correct: the lock
// sat at 1.11.5 across FOURTEEN subsequent releases (1.11.6 through 1.12.3)
// before an agent noticed it by accident. (3) The damage is exactly the damage
// this check exists for and no more - npm ci accepts the mismatch (measured on
// npm 11.4.2: exit 0, lock untouched) and the lock never ships inside the tgz,
// so nothing breaks. What is wrong is a tracked file stating a version that is
// not the version, which is the definition of the thing above.
//
// The honest cost, stated rather than buried: this makes THREE of the five
// claims manual, where two were before. The difference is that the other two
// manual ones need prose written and this one needs one deterministic command,
// and the right end state is package.mjs regenerating the lock as it already
// writes package.json and release/ - at which point this claim guards an
// automated fact instead of a chore.
//
// The pure half takes facts and returns findings; main() gathers the facts. That
// split is what lets the rules be pinned without a repo, a git history or a tgz.

import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const appDir = join(__dirname, '..');
const toolkitDir = join(appDir, '..', '..');

const TGZ_VERSION = /^soc-optimizationtoolkit-(\d+\.\d+\.\d+)\.tgz$/;

// backlog.md item 8 states the current release as "**X.Y.Z IS CURRENT (date).**".
// Placeholders, not the version of the day: this comment named 1.12.0 while the
// backlog said 1.12.3, so the file that exists BECAUSE version literals in prose
// decay was carrying one of its own. No code reads this comment, so nothing was
// ever going to catch it; a shape has nothing to go stale.
//
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
 *   lockVersion: string | null,
 *   releaseTarballs: string[],
 *   releaseNotes: string,
 *   backlog: string,
 *   sourceCommitsSinceRelease: number | null,
 * }} facts
 * @returns {{errors: string[], warnings: string[], notes: string[], packagedVersion: string | null}}
 */
export function evaluateReleaseDrift(facts) {
  const errors = [];
  const warnings = [];
  const notes = [];

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
    return { errors, warnings, notes, packagedVersion: null };
  }

  if (versions.length > 1) {
    errors.push(
      `release/ holds ${versions.length} tarballs (${versions.join(', ')}). It holds exactly the latest by directive; package.mjs prunes the rest.`,
    );
  }

  // Ordered NUMERICALLY, not lexicographically. A default sort compares strings,
  // where "1.9.0" beats "1.12.0" - so the one state this branch exists to handle
  // would resolve every claim below against the older tarball and report the
  // correct files as the drifted ones. package.mjs parses versions numerically
  // for the same reason; it cannot be imported here because it packages on load.
  const packagedVersion = versions.slice().sort(compareVersions).at(-1) ?? versions[0];

  // A manifest ahead of the tarball is the double-bump this repo has already hit:
  // editing package.json and THEN packaging bumps twice, and the tgz name is the
  // only place the doubled number shows. A manifest behind it should be
  // impossible, since package.mjs writes both.
  if (facts.manifestVersion !== packagedVersion) {
    errors.push(
      `package.json says ${facts.manifestVersion} but the packaged tarball is ${packagedVersion}. Do not hand-bump: scripts/package.mjs IS the bump.`,
    );
  }

  // Held to the MANIFEST, not to the tarball, unlike every other claim here.
  // The lock is a claim ABOUT package.json - npm copies that version field into
  // it verbatim - and package.json is already held to the tarball one rule up,
  // so this completes a chain rather than opening a second front. Comparing the
  // lock to the tarball instead would report a hand-bump TWICE, once as the
  // bump and once as a lock that faithfully recorded it; the extra-tarball rule
  // above avoids the same cascade for the same reason.
  //
  // "npm install --package-lock-only" rather than "npm install" because it is
  // the minimal command that fixes this and only this: it resolves the lock
  // from the manifests without touching node_modules, and on the run that fixed
  // the 1.11.5 drift it changed one line. The bare command is not WRONG, just
  // wider - measured 2026-09-03 on npm 11.4.2 / node 24.4.1, seeding a sandbox
  // with the real manifests and lock at manifest 1.12.4 / lock 1.12.3: both
  // commands wrote a BYTE-IDENTICAL lock, same sha256, the same ONE changed
  // line - this workspace's version field, one deletion and one insertion. The
  // difference is node_modules, which the bare form resolves and installs and
  // this form never creates.
  if (facts.lockVersion === null) {
    errors.push(
      'package-lock.json states no version for the app workspace. Run "npm install --package-lock-only" to regenerate it; if the workspace moved, update this script.',
    );
  } else if (facts.lockVersion !== facts.manifestVersion) {
    errors.push(
      `package-lock.json records the app at ${facts.lockVersion} but package.json says ${facts.manifestVersion}. The lock is GENERATED - run "npm install --package-lock-only" rather than editing the version by hand.`,
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
  //
  // The null case gets a NOTE rather than silence. A check that prints the same
  // clean line whether it counted zero commits or could not count at all reports
  // an unmeasured absence as a measured zero - which is the inventory-standard
  // rule this repo applies to Azure listings, and it applies to its own tooling.
  if (facts.sourceCommitsSinceRelease === null) {
    notes.push(
      'Unreleased source was NOT measured - git could not answer (a shallow clone has no history to count). This run says nothing about whether release/ is behind.',
    );
  } else if (facts.sourceCommitsSinceRelease > 0) {
    warnings.push(
      `${facts.sourceCommitsSinceRelease} source commit(s) have landed since ${packagedVersion} was packaged. The tgz in release/ does not contain them, and neither does anything anyone installs from this repo.`,
    );
  }

  return { errors, warnings, notes, packagedVersion };
}

/** Compares X.Y.Z by component, so 1.12.0 sorts above 1.9.0. */
function compareVersions(a, b) {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
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
  const [manifest, lock, releaseEntries, releaseNotes, backlog] = await Promise.all([
    readFile(join(appDir, 'package.json'), 'utf8'),
    readFile(join(toolkitDir, 'package-lock.json'), 'utf8').catch(() => ''),
    readdir(join(appDir, 'release')).catch(() => []),
    readFile(join(toolkitDir, 'docs', 'release-notes.md'), 'utf8'),
    readFile(join(toolkitDir, 'docs', 'backlog.md'), 'utf8'),
  ]);

  return {
    manifestVersion: JSON.parse(manifest).version,
    lockVersion: readLockVersion(lock),
    releaseTarballs: releaseEntries.filter((name) => name.endsWith('.tgz')),
    releaseNotes,
    backlog,
    sourceCommitsSinceRelease: countSourceCommitsSinceRelease(),
  };
}

/**
 * The lock keys its workspace entries by PATH relative to the lock, in posix
 * form, so the key is derived from appDir rather than written out - a workspace
 * move then keeps working instead of reporting the lock as versionless. The
 * separator swap is not cosmetic: node's relative() yields "apps\\cribl-app" on
 * Windows, which matches no key in any lock file, and the check would fail on
 * every Windows run with a message pointing at npm.
 *
 * A parse failure returns null rather than throwing. This lock lives in a repo
 * where several agents share one tree, so a half-written or conflict-marked
 * lock is a state that happens; "the lock states no version, regenerate it" is
 * a better report of that than a stack trace out of the version checker.
 */
function readLockVersion(lockJson) {
  const workspaceKey = relative(toolkitDir, appDir).split(sep).join('/');
  try {
    return JSON.parse(lockJson).packages?.[workspaceKey]?.version ?? null;
  } catch {
    return null;
  }
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
  const { errors, warnings, notes, packagedVersion } = evaluateReleaseDrift(facts);

  for (const note of notes) annotate('notice', note);
  for (const warning of warnings) annotate('warning', warning);
  for (const error of errors) annotate('error', error);

  if (errors.length > 0) {
    console.log(`\nRelease drift: ${errors.length} error(s), ${warnings.length} warning(s).`);
    process.exitCode = 1;
    return;
  }

  // Name what was checked AND what was counted, so a run that measured nothing
  // cannot be read as a run that found nothing.
  const unreleased =
    facts.sourceCommitsSinceRelease === null
      ? 'unreleased source not measured'
      : `${facts.sourceCommitsSinceRelease} source commit(s) since it was packaged`;

  console.log(
    `Release ${packagedVersion} is consistent across package.json, package-lock.json, release/, release-notes.md and backlog.md (${unreleased}).`,
  );
}

// Only when run directly, so the pure half can be imported by its pins.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
