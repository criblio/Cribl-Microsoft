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
import { applyDecision, blockers, renderBoard, validateBoard } from './board.mjs';

/** A story carrying an open question with two spelled-out alternatives. */
const withDecision = (over = {}, decision = {}) =>
  story({
    settled: 'undecided',
    decision: {
      question: 'Footer or connection bar?',
      options: [
        { key: 'footer', label: 'Frame footer', detail: 'One surface, always visible.' },
        { key: 'bar', label: 'Connection bar', detail: 'Beside the existing chips.' },
      ],
      chosen: null,
      ...decision,
    },
    ...over,
  });

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

  it('REQUIRES a done story to say how it was verified', () => {
    // The point of the field: a story cannot reach done silently. GEN-1 closed
    // on a live check and GEN-2 on pins plus a live measurement, and before
    // this the board rendered the two identically.
    const out = validateBoard(board([story({ status: 'done', priority: undefined })]));

    expect(out).toHaveLength(1);
    expect(out[0]).toContain('does not say how it was verified');
  });

  it('accepts every verified value on a done story, including none', () => {
    // `none` is a legitimate answer for docs and process work. Forcing the
    // question is the goal; forcing a particular answer would just make people
    // type the prettiest one.
    for (const v of ['pins', 'live', 'both', 'none']) {
      expect(
        validateBoard(board([story({ status: 'done', priority: undefined, verified: v })])),
      ).toEqual([]);
    }
  });

  it('does NOT require verified before a story is done', () => {
    // A story picks up pins while it is in progress; demanding the field early
    // would only teach people to fill it in speculatively.
    expect(validateBoard(board([story({ status: 'backlog', priority: 'now' })]))).toEqual([]);
    expect(validateBoard(board([story({ status: 'in-progress', priority: undefined })]))).toEqual(
      [],
    );
  });

  it('still rejects a BOGUS verified value on a story that is not done', () => {
    // Optional does not mean unchecked - otherwise a typo sits there until the
    // story is finished and then suddenly fails.
    const out = validateBoard(
      board([story({ status: 'in-progress', priority: undefined, verified: 'probably' })]),
    );

    expect(out).toHaveLength(1);
    expect(out[0]).toContain('expected pins | live | both | none');
  });

  it('only requires a priority while the story is in the backlog', () => {
    expect(
      validateBoard(board([story({ status: 'done', priority: undefined, verified: 'pins' })])),
    ).toEqual([]);
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
      two({ status: 'done', verified: 'pins', dependsOn: ['REL-2'] }, { status: 'backlog' }),
    );

    expect(out).toHaveLength(1);
    expect(out[0]).toContain('is done but REL-2');
  });

  it('accepts in-progress work whose blocker is already done', () => {
    expect(
      validateBoard(
        two(
          { status: 'in-progress', dependsOn: ['REL-2'] },
          { status: 'done', verified: 'pins' },
        ),
      ),
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

describe('validateBoard - decisions', () => {
  it('accepts a well-formed unanswered decision', () => {
    expect(validateBoard(board([withDecision()]))).toEqual([]);
  });

  it('rejects a decision with fewer than two options', () => {
    // One option is not a decision, it is a plan.
    const out = validateBoard(
      board([withDecision({}, { options: [{ key: 'a', label: 'Only way' }] })]),
    );

    expect(out).toHaveLength(1);
    expect(out[0]).toContain('fewer than two options');
  });

  it('rejects an answer that is not one of the options', () => {
    const out = validateBoard(board([withDecision({}, { chosen: 'neither' })]));

    expect(out).toHaveLength(1);
    expect(out[0]).toContain('not one of its options');
  });

  it('rejects duplicate option keys', () => {
    const out = validateBoard(
      board([
        withDecision(
          {},
          { options: [{ key: 'a', label: 'One' }, { key: 'a', label: 'Two' }] },
        ),
      ]),
    );

    expect(out.some((f) => f.includes('appears twice'))).toBe(true);
  });

  it('catches a SETTLED story whose decision is still unanswered', () => {
    // The contradiction that matters: settled means nothing is outstanding,
    // and an unanswered question is something outstanding.
    const out = validateBoard(board([withDecision({ settled: 'settled' })]));

    expect(out).toHaveLength(1);
    expect(out[0]).toContain('settled but its decision is still unanswered');
  });

  it('is happy with a settled story whose decision was answered', () => {
    expect(
      validateBoard(board([withDecision({ settled: 'settled' }, { chosen: 'footer' })])),
    ).toEqual([]);
  });
});

describe('applyDecision', () => {
  const data = () => board([withDecision({ id: 'D-1' })]);

  it('records the answer', () => {
    const out = applyDecision(data(), 'D-1', 'bar');

    expect(out.ok).toBe(true);
    expect(out.data.stories[0].decision.chosen).toBe('bar');
  });

  it('does NOT settle the card - answering is not deciding', () => {
    // The whole contract of this feature. A click is a signal; the reasoning
    // still has to land in backlog.md before anything is settled.
    const out = applyDecision(data(), 'D-1', 'bar');

    expect(out.data.stories[0].settled).toBe('undecided');
  });

  it('does not mutate the board it was given', () => {
    // The server validates the RESULT before writing; that is only meaningful
    // if the input is still intact when validation fails.
    const before = data();
    applyDecision(before, 'D-1', 'bar');

    expect(before.stories[0].decision.chosen).toBeNull();
  });

  it('clears an answer when passed null', () => {
    const answered = applyDecision(data(), 'D-1', 'bar').data;

    expect(applyDecision(answered, 'D-1', null).data.stories[0].decision.chosen).toBeNull();
  });

  it('refuses an option the decision does not offer', () => {
    const out = applyDecision(data(), 'D-1', 'sidebar');

    expect(out.ok).toBe(false);
    expect(out.error).toContain('not one of');
  });

  it('refuses a story that does not exist, or has no decision', () => {
    expect(applyDecision(data(), 'NOPE-1', 'bar').ok).toBe(false);
    expect(applyDecision(board([story({ id: 'REL-9' })]), 'REL-9', 'bar').ok).toBe(false);
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
