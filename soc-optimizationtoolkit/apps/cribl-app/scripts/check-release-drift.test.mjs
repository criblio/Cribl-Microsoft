// Pins for the release-drift rules. The point of pinning the PURE half is that
// these cases can be stated without a repo, a git history or a tarball - the
// facts are the argument.

import { describe, expect, it } from 'vitest';
import { evaluateReleaseDrift } from './check-release-drift.mjs';

const CONSISTENT = {
  manifestVersion: '1.12.0',
  lockVersion: '1.12.0',
  releaseTarballs: ['soc-optimizationtoolkit-1.12.0.tgz'],
  releaseNotes: '# Release notes\n\n## 1.12.0\n\nSomething shipped.\n\n## 1.11.15\n',
  backlog: 'Some prose.\n\n**1.12.0 IS CURRENT (2026-08-24).**\n\nMore prose.\n',
  sourceCommitsSinceRelease: 0,
};

const facts = (overrides) => ({ ...CONSISTENT, ...overrides });

describe('evaluateReleaseDrift', () => {
  it('reports nothing when every claim names the packaged version', () => {
    const result = evaluateReleaseDrift(CONSISTENT);

    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.notes).toEqual([]);
    expect(result.packagedVersion).toBe('1.12.0');
  });

  it('catches a hand-bumped manifest running ahead of the tarball', () => {
    // The lock moves WITH the manifest here: npm copies that field, so a
    // hand-bump plus an npm install leaves them agreeing with each other and
    // disagreeing with the tarball.
    const result = evaluateReleaseDrift(
      facts({ manifestVersion: '1.12.1', lockVersion: '1.12.1' }),
    );

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('1.12.1');
    expect(result.errors[0]).toContain('1.12.0');
    expect(result.errors[0]).toContain('package.json');
    // The packaged tarball stays the authority - it is what people install.
    expect(result.packagedVersion).toBe('1.12.0');
  });

  it('catches the lock recording a version its package.json has moved past', () => {
    // The defect as found: package-lock.json said 1.11.5 while package.json
    // said 1.12.3. package.mjs bumps package.json and never runs npm, so the
    // lock goes stale at the release commit and stays there - this one sat
    // fourteen releases behind before anyone looked.
    const result = evaluateReleaseDrift(facts({ lockVersion: '1.11.5' }));

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('package-lock.json');
    expect(result.errors[0]).toContain('1.11.5');
    expect(result.errors[0]).toContain('1.12.0');
  });

  it('sends the reader to npm rather than to the lock file', () => {
    // A generated file must never be hand-edited to satisfy a check. The
    // message names the minimal regenerating command, and this pin fails if
    // someone rewords it into advice to fix the number in place.
    const result = evaluateReleaseDrift(facts({ lockVersion: '1.11.5' }));

    expect(result.errors[0]).toContain('npm install --package-lock-only');
    expect(result.errors[0]).toContain('GENERATED');
  });

  it('holds the lock to package.json, so a hand-bump reports once not twice', () => {
    // The lock is a claim ABOUT package.json, and package.json is already held
    // to the tarball. Resolving the lock against the TARBALL instead would make
    // every hand-bump produce two errors for one mistake - and would blame the
    // lock, which is the one file that recorded the truth it was given.
    const cascade = evaluateReleaseDrift(
      facts({ manifestVersion: '1.12.1', lockVersion: '1.12.1' }),
    );
    expect(cascade.errors).toHaveLength(1);
    expect(cascade.errors[0]).not.toContain('package-lock.json');

    // ...and a lock that agrees with the TARBALL while its manifest has moved
    // on is still a finding, which the tarball-based comparison would miss.
    const stale = evaluateReleaseDrift(
      facts({ manifestVersion: '1.12.1', lockVersion: '1.12.0' }),
    );
    expect(stale.errors).toHaveLength(2);
    expect(stale.errors.filter((e) => e.includes('package-lock.json'))).toHaveLength(1);
  });

  it('says so when the lock states no version for the app at all', () => {
    // A workspace rename moves the key, and a conflict-marked lock will not
    // parse - both arrive here as null. Silence would read as agreement.
    const result = evaluateReleaseDrift(facts({ lockVersion: null }));

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('package-lock.json');
    expect(result.errors[0]).toContain('no version');
  });

  it('catches release notes that stop short of the packaged version', () => {
    const result = evaluateReleaseDrift(
      facts({ releaseNotes: '# Release notes\n\n## 1.11.15\n' }),
    );

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('release-notes.md');
  });

  it('does not accept a longer version as the section it prefixes', () => {
    // "## 1.1.20" must not satisfy a check for 1.1.2, which a substring test
    // would - and the versions here run past .9 regularly.
    const result = evaluateReleaseDrift(
      facts({
        manifestVersion: '1.1.2',
        lockVersion: '1.1.2',
        releaseTarballs: ['soc-optimizationtoolkit-1.1.2.tgz'],
        releaseNotes: '# Release notes\n\n## 1.1.20\n',
        backlog: '**1.1.2 IS CURRENT (2026-08-24).**\n',
      }),
    );

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('release-notes.md');
  });

  it('catches the backlog claim this check exists because of', () => {
    const result = evaluateReleaseDrift(
      facts({ backlog: '**1.5.4 IS CURRENT (2026-08-06).**\n' }),
    );

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('1.5.4');
    expect(result.errors[0]).toContain('1.12.0');
  });

  it('says so when the backlog stops stating a version at all', () => {
    const result = evaluateReleaseDrift(facts({ backlog: 'No version claim here.\n' }));

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('backlog.md');
  });

  it('refuses a release directory holding more than the latest tarball', () => {
    const result = evaluateReleaseDrift(
      facts({
        // 1.9.0 rather than 1.11.15 on purpose: it is GREATER as a string and
        // LESSER as a version, so a default sort picks it and this pin fails.
        // The pair that agrees under both orderings cannot tell the two apart.
        releaseTarballs: [
          'soc-optimizationtoolkit-1.9.0.tgz',
          'soc-optimizationtoolkit-1.12.0.tgz',
        ],
      }),
    );

    // The extra tarball is the finding; the version claims still resolve against
    // the newest, so this is exactly one error rather than a cascade of four.
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('2 tarballs');
    expect(result.packagedVersion).toBe('1.12.0');
  });

  it('stops at the first question when there is no tarball to compare against', () => {
    const result = evaluateReleaseDrift(facts({ releaseTarballs: [] }));

    expect(result.errors).toHaveLength(1);
    expect(result.packagedVersion).toBeNull();
  });

  it('WARNS about unreleased source and never errors on it', () => {
    const result = evaluateReleaseDrift(facts({ sourceCommitsSinceRelease: 55 }));

    // Unreleased source is the normal state of a feature branch. Failing here
    // would mean every branch had to package to stay green, which is how a
    // check gets disabled instead of obeyed.
    expect(result.errors).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('55 source commit(s)');
  });

  it('does not warn when git could not count, and does not stay silent either', () => {
    // A shallow clone has no history. "0 commits since the release" there would
    // be a measured zero invented from an unmeasured absence - but so would a
    // clean run indistinguishable from one that actually counted zero, which is
    // why the unmeasured case is a NOTE rather than nothing.
    const result = evaluateReleaseDrift(facts({ sourceCommitsSinceRelease: null }));

    expect(result.warnings).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]).toContain('NOT measured');
  });

  it('does not confuse a measured zero with an unmeasured one', () => {
    const measured = evaluateReleaseDrift(facts({ sourceCommitsSinceRelease: 0 }));
    const unmeasured = evaluateReleaseDrift(facts({ sourceCommitsSinceRelease: null }));

    // Both are clean runs; only one of them checked.
    expect(measured.notes).toEqual([]);
    expect(unmeasured.notes).toHaveLength(1);
  });

  it('reports every drifted claim at once rather than the first', () => {
    const result = evaluateReleaseDrift(
      facts({
        manifestVersion: '1.13.0',
        lockVersion: '1.11.5',
        releaseNotes: '# Release notes\n\n## 1.11.15\n',
        backlog: '**1.5.4 IS CURRENT (2026-08-06).**\n',
        sourceCommitsSinceRelease: 3,
      }),
    );

    // All four claims, one line each - naming only the first would send someone
    // round the loop four times.
    // startsWith, not includes: the lock error QUOTES package.json in its own
    // text, so an includes() filter for the manifest claim matches both and the
    // count assertion stops meaning anything.
    expect(result.errors).toHaveLength(4);
    expect(result.errors.filter((e) => e.startsWith('package.json says'))).toHaveLength(1);
    expect(result.errors.filter((e) => e.startsWith('package-lock.json'))).toHaveLength(1);
    expect(result.errors.filter((e) => e.includes('release-notes.md'))).toHaveLength(1);
    expect(result.errors.filter((e) => e.includes('backlog.md'))).toHaveLength(1);
    expect(result.warnings).toHaveLength(1);
  });
});
