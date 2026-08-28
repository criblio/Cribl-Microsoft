// Pins for the board-freshness rule.
//
// This is the check that says the board still DESCRIBES the repo, as opposed
// to check-board, which only says board.md matches board.json. It is a warning
// by design - a change can legitimately touch source without moving a card -
// so what these guard is that it fires on the right shape of change and stays
// quiet on the rest. A warning that cries wolf is one people learn to skim,
// which is the failure the architecture-audit hook already had to be fixed for.

import { describe, expect, it } from 'vitest';
import { BOARD, freshness, report, WATCHED } from './board-freshness.mjs';

describe('freshness', () => {
  it('flags watched source changing while the board sits still', () => {
    const v = freshness(['soc-optimizationtoolkit/packages/core/src/domain/x.ts']);

    expect(v.stale).toBe(true);
    expect(v.watched).toHaveLength(1);
  });

  it('is quiet when the board moved with the work', () => {
    const v = freshness(['soc-optimizationtoolkit/packages/core/src/domain/x.ts', BOARD]);

    expect(v.stale).toBe(false);
    expect(v.board).toBe(true);
  });

  it('is quiet when nothing watched changed', () => {
    // A README tweak is not board-relevant, and saying so would be noise.
    const v = freshness(['README.md', '.gitignore']);

    expect(v.stale).toBe(false);
    expect(v.watched).toEqual([]);
  });

  it('does NOT count the generated board.md as updating the board', () => {
    // board.md can only change because board.json did - or because someone
    // hand-edited it, which check-board already fails on. Counting it would let
    // a stale board look fresh.
    const v = freshness([
      'soc-optimizationtoolkit/packages/core/src/domain/x.ts',
      'soc-optimizationtoolkit/docs/board.md',
    ]);

    expect(v.stale).toBe(true);
  });

  it('matches a watched DIRECTORY only at a path boundary', () => {
    // "packages-old/..." must not count as "packages/...".
    expect(freshness(['soc-optimizationtoolkit/packages-old/x.ts']).watched).toEqual([]);
    expect(freshness(['soc-optimizationtoolkit/packages/x.ts']).watched).toHaveLength(1);
  });

  it('matches a watched FILE exactly', () => {
    expect(freshness(['soc-optimizationtoolkit/docs/backlog.md']).watched).toHaveLength(1);
    expect(freshness(['soc-optimizationtoolkit/docs/backlog-old.md']).watched).toEqual([]);
  });

  it('ignores blank lines from git output', () => {
    expect(freshness(['', '   ', undefined]).watched).toEqual([]);
  });

  it('watches the paths the stop hook watched, so the rule did not change in the move', () => {
    // Moving a rule from a local hook into CI is only safe if it is the SAME
    // rule; a quietly different one would make the hook and CI disagree.
    expect(WATCHED).toContain('soc-optimizationtoolkit/packages');
    expect(WATCHED).toContain('soc-optimizationtoolkit/apps/cribl-app/src');
    expect(WATCHED).toContain('soc-optimizationtoolkit/apps/cribl-app/scripts');
    expect(WATCHED).toContain('soc-optimizationtoolkit/docs/backlog.md');
    expect(WATCHED).toContain('soc-optimizationtoolkit/docs/adr');
  });
});

describe('report', () => {
  it('names the files and says plainly that it is not a gate', () => {
    const text = report(
      freshness(['soc-optimizationtoolkit/packages/core/src/domain/x.ts']),
      'origin/main',
    );

    expect(text).toContain('did not');
    expect(text).toContain('packages/core/src/domain/x.ts');
    expect(text).toContain('not a gate');
  });

  it('truncates a long list rather than printing a hundred paths', () => {
    const many = Array.from(
      { length: 14 },
      (_, i) => `soc-optimizationtoolkit/packages/core/src/f${i}.ts`,
    );

    expect(report(freshness(many), 'origin/main')).toContain('and 4 more');
  });

  it('says so when the board moved with the work', () => {
    const text = report(
      freshness(['soc-optimizationtoolkit/packages/core/src/x.ts', BOARD]),
      'origin/main',
    );

    expect(text).toContain('moved with them');
  });
});
