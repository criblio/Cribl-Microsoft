// Pins for the board's data rules.
//
// These replace the three structural rules that used to live in
// check-docs-drift, which could only see what a regex could find in prose - and
// demonstrably not even that: two cards written `**AZR-S1 (spike)**` put the
// type inside the bold, so the id pattern never matched and BOTH spikes were
// invisible to every tool that read the board, including the duplicate-id check
// itself. Moving the board to data is what surfaced them.
//
// The ordering rules are the ones worth having. Prose could say "CAP blocks
// three epics" and nothing checked it; it stayed a sentence a reader had to
// notice.

import { describe, expect, it } from 'vitest';
import { blockers, renderBoard, validateBoard } from './board.mjs';

const story = (over) => ({
  id: 'REL-1',
  epic: 'REL',
  title: 'Do the thing',
  type: 'chore',
  status: 'backlog',
  priority: 'now',
  settled: 'settled',
  dependsOn: [],
  detail: '',
  ...over,
});

const board = (stories, epics) => ({
  epics: epics ?? [{ key: 'REL', name: 'Ship it', why: 'because' }],
  stories,
});

describe('validateBoard - the shape of a story', () => {
  it('accepts a sound board', () => {
    expect(validateBoard(board([story({})]))).toEqual([]);
  });

  it('catches a duplicated id', () => {
    const out = validateBoard(board([story({}), story({ title: 'Other' })]));

    expect(out).toHaveLength(1);
    expect(out[0]).toContain('appears twice');
  });

  it('catches a story whose epic is not declared', () => {
    const out = validateBoard(board([story({ id: 'ZZZ-1', epic: 'ZZZ' })]));

    // The epic it does declare is now empty, so two findings is correct.
    expect(out.some((f) => f.includes('epic "ZZZ", which is not declared'))).toBe(true);
  });

  it('catches an epic that carries no story', () => {
    const out = validateBoard(
      board([story({})], [
        { key: 'REL', name: 'Ship it', why: '' },
        { key: 'GONE', name: 'Empty', why: '' },
      ]),
    );

    expect(out).toHaveLength(1);
    expect(out[0]).toContain('Epic GONE is declared but carries no story');
  });

  it('insists a story is settled, undecided or unconfirmed', () => {
    // The most useful field on the board: settled means only work remains,
    // undecided means no amount of effort finishes it.
    const out = validateBoard(board([story({ settled: 'maybe' })]));

    expect(out).toHaveLength(1);
    expect(out[0]).toContain('neither settled nor undecided');
  });

  it('only requires a priority while the story is in the backlog', () => {
    expect(validateBoard(board([story({ status: 'done', priority: undefined })]))).toEqual([]);
    expect(
      validateBoard(board([story({ status: 'backlog', priority: undefined })])),
    ).toHaveLength(1);
  });
});

describe('validateBoard - dependencies', () => {
  const two = (a, b) => board([story({ id: 'REL-1', ...a }), story({ id: 'REL-2', ...b })]);

  it('catches a dependency on a story that does not exist', () => {
    const out = validateBoard(board([story({ dependsOn: ['NOPE-9'] })]));

    expect(out).toHaveLength(1);
    expect(out[0]).toContain('not a story on this board');
  });

  it('catches a story depending on itself', () => {
    const out = validateBoard(board([story({ dependsOn: ['REL-1'] })]));

    expect(out.some((f) => f.includes('depends on itself'))).toBe(true);
  });

  it('catches work started before its blocker', () => {
    // THE ORDERING RULE prose could not enforce.
    const out = validateBoard(
      two({ status: 'in-progress', dependsOn: ['REL-2'] }, { status: 'backlog' }),
    );

    expect(out).toHaveLength(1);
    expect(out[0]).toContain('in progress but REL-2 is still in the backlog');
  });

  it('catches a done story whose dependency is not done', () => {
    const out = validateBoard(
      two({ status: 'done', dependsOn: ['REL-2'] }, { status: 'backlog' }),
    );

    expect(out).toHaveLength(1);
    expect(out[0]).toContain('is done but REL-2');
  });

  it('accepts in-progress work whose blocker is already done', () => {
    expect(
      validateBoard(two({ status: 'in-progress', dependsOn: ['REL-2'] }, { status: 'done' })),
    ).toEqual([]);
  });

  it('catches a dependency cycle', () => {
    const out = validateBoard(
      two({ dependsOn: ['REL-2'] }, { dependsOn: ['REL-1'] }),
    );

    expect(out).toHaveLength(1);
    expect(out[0]).toContain('Dependency cycle');
    expect(out[0]).toContain('Nothing in it can ever start');
  });

  it('reports a cycle ONCE rather than once per member', () => {
    // Walking from every node finds the same loop repeatedly; a checker that
    // printed it three times would train people to skim the output.
    const out = validateBoard(
      board([
        story({ id: 'REL-1', dependsOn: ['REL-2'] }),
        story({ id: 'REL-2', dependsOn: ['REL-3'] }),
        story({ id: 'REL-3', dependsOn: ['REL-1'] }),
      ]),
    );

    expect(out.filter((f) => f.includes('Dependency cycle'))).toHaveLength(1);
  });
});

describe('blockers', () => {
  it('lists only the dependencies that are not done', () => {
    const stories = [
      story({ id: 'REL-1', dependsOn: ['REL-2', 'REL-3'] }),
      story({ id: 'REL-2', status: 'done' }),
      story({ id: 'REL-3', status: 'backlog' }),
    ];
    const byId = new Map(stories.map((s) => [s.id, s]));

    expect(blockers(stories[0], byId)).toEqual(['REL-3']);
  });
});

describe('renderBoard', () => {
  const data = board([
    story({ id: 'REL-1', status: 'in-progress', dependsOn: ['REL-2'] }),
    story({ id: 'REL-2', status: 'backlog', priority: 'now' }),
    story({ id: 'REL-3', status: 'done', title: 'Shipped it' }),
  ]);

  it('groups by PROGRESS, which is what a Kanban column shows', () => {
    const md = renderBoard(data, '2026-08-27');

    expect(md).toContain('## In progress (1)');
    expect(md).toContain('## Backlog - now (1)');
    expect(md).toContain('## Done (1)');
  });

  it('says on the card what is blocking it', () => {
    // The whole point of modelling dependencies: "blocked" is visible rather
    // than reconstructed by a reader following ids around.
    expect(renderBoard(data, '2026-08-27')).toContain('blocked by REL-2');
  });

  it('marks itself generated, so nobody edits the output', () => {
    const md = renderBoard(data, '2026-08-27');

    expect(md).toContain('GENERATED from board.json');
    expect(md).toContain('Do not edit this file by hand');
  });

  it('counts OPEN stories per epic, not all of them', () => {
    // A done story still belongs to its epic; counting it would make finished
    // work look like outstanding work.
    expect(renderBoard(data, '2026-08-27')).toMatch(/\|\s*`REL`\s*\|[^|]*\|\s*2\s*\|/);
  });

  it('carries a Status line, so the docs-drift check still governs it', () => {
    expect(renderBoard(data, '2026-08-27')).toMatch(/^Status: Living/m);
  });
});
