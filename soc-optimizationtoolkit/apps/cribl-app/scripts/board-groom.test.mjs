// Pins for backlog grooming.
//
// Grooming is arithmetic over the dependency graph, and the arithmetic is where
// it can quietly lie: a chain computed in the wrong order reads as a plan, and
// an unblock count that misses transitive edges makes a bottleneck look
// harmless. These pin the numbers, not the prose.

import { describe, expect, it } from 'vitest';
import { PRIORITIES } from './board.mjs';
import {
  goalPlan,
  groomingFindings,
  isReady,
  prerequisiteChain,
  rankOf,
  renderGroom,
  unblockCount,
} from './board-groom.mjs';

const story = (over) => ({
  id: 'A-1',
  epic: 'A',
  title: 'A story',
  type: 'enabler',
  feature: 'A-F1',
  status: 'backlog',
  priority: 'now',
  settled: 'settled',
  dependsOn: [],
  detail: '',
  ...over,
});

const board = (stories, epics, features) => ({
  epics: epics ?? [{ key: 'A', name: 'Epic A', why: '' }],
  features: features ?? [{ id: 'A-F1', epic: 'A', title: 'A feature' }],
  stories,
});

const idx = (stories) => new Map(stories.map((s) => [s.id, s]));

describe('prerequisiteChain', () => {
  it('lists prerequisites DEEPEST FIRST so the list can be worked top to bottom', () => {
    // C depends on B depends on A. Working the list in order must be legal.
    const stories = [
      story({ id: 'A-1' }),
      story({ id: 'A-2', dependsOn: ['A-1'] }),
      story({ id: 'A-3', dependsOn: ['A-2'] }),
    ];

    expect(prerequisiteChain('A-3', idx(stories))).toEqual(['A-1', 'A-2']);
  });

  it('SKIPS prerequisites that are already done', () => {
    // A done blocker is not work; listing it would pad the plan with things
    // nobody has to do.
    const stories = [
      story({ id: 'A-1', status: 'done', verified: 'pins' }),
      story({ id: 'A-2', dependsOn: ['A-1'] }),
    ];

    expect(prerequisiteChain('A-2', idx(stories))).toEqual([]);
  });

  it('does not list the same prerequisite twice through two paths', () => {
    // Diamond: D needs B and C, both need A. A is one piece of work.
    const stories = [
      story({ id: 'A-1' }),
      story({ id: 'A-2', dependsOn: ['A-1'] }),
      story({ id: 'A-3', dependsOn: ['A-1'] }),
      story({ id: 'A-4', dependsOn: ['A-2', 'A-3'] }),
    ];
    const chain = prerequisiteChain('A-4', idx(stories));

    expect(chain.filter((c) => c === 'A-1')).toHaveLength(1);
    expect(chain.indexOf('A-1')).toBeLessThan(chain.indexOf('A-2'));
  });

  it('TERMINATES on a cycle instead of hanging', () => {
    // validateBoard rejects cycles - but a report that hangs is a poor way to
    // discover the board is broken, and grooming may well be what someone runs
    // to understand a mess.
    const stories = [
      story({ id: 'A-1', dependsOn: ['A-2'] }),
      story({ id: 'A-2', dependsOn: ['A-1'] }),
    ];

    expect(() => prerequisiteChain('A-1', idx(stories))).not.toThrow();
  });

  it('ignores a dependency on a story that does not exist', () => {
    const stories = [story({ id: 'A-1', dependsOn: ['GONE-9'] })];

    expect(prerequisiteChain('A-1', idx(stories))).toEqual([]);
  });
});

describe('unblockCount', () => {
  it('counts TRANSITIVE dependents, not just direct ones', () => {
    // The whole point of the leverage number: A-1 gates A-3 through A-2, and a
    // direct-only count would report 1 and hide the bottleneck.
    const stories = [
      story({ id: 'A-1' }),
      story({ id: 'A-2', dependsOn: ['A-1'] }),
      story({ id: 'A-3', dependsOn: ['A-2'] }),
    ];

    expect(unblockCount('A-1', idx(stories))).toBe(2);
  });

  it('does not count DONE dependents', () => {
    const stories = [
      story({ id: 'A-1' }),
      story({ id: 'A-2', status: 'done', verified: 'pins', dependsOn: ['A-1'] }),
    ];

    expect(unblockCount('A-1', idx(stories))).toBe(0);
  });
});

describe('isReady', () => {
  it('is ready with no blockers, and not ready with an open one', () => {
    const stories = [story({ id: 'A-1' }), story({ id: 'A-2', dependsOn: ['A-1'] })];
    const m = idx(stories);

    expect(isReady(stories[0], m)).toBe(true);
    expect(isReady(stories[1], m)).toBe(false);
  });

  it('treats a dependency that is NOT ON THE BOARD as blocking', () => {
    // The eighth audit's finding: isReady used to ask whether the prerequisite
    // chain was empty, and the chain SKIPS unknown ids because it cannot order
    // what it cannot see. So the kanban said "blocked by GONE-9" while grooming
    // called the same card ready - visible on any board mid-edit, which is
    // exactly when the live server is running. One definition of blocked, and
    // it is the conservative one.
    const stories = [story({ id: 'A-1', dependsOn: ['GONE-9'] })];

    expect(isReady(stories[0], idx(stories))).toBe(false);
  });
});

describe('priority ranking', () => {
  it('ranks EVERY declared priority by its position, and unknowns last', () => {
    // A TRIPWIRE, and worth being honest about: with today's three priorities a
    // hardcoded {now:0,next:1,later:2} produces identical output, so this
    // cannot fail right now and a mutation test does not kill it. It arms the
    // moment PRIORITIES grows - which is exactly when a private copy would
    // rank the new value BELOW `later` and sort the most urgent work last.
    PRIORITIES.forEach((p, i) => {
      expect(rankOf({ priority: p })).toBe(i);
    });
    expect(rankOf({ priority: 'nonsense' })).toBe(PRIORITIES.length);
    expect(rankOf({})).toBe(PRIORITIES.length);
  });

  it('ranks by POSITION in the declared vocabulary, not a private copy', () => {
    // The seventh audit fixed exactly this between STATUSES and the kanban
    // columns; the eighth found a copy of {now,next,later} in the groom script.
    // A priority the vocabulary knows about must never sort below one it does
    // not - which is what a stale hardcoded map produces.
    const stories = [
      story({ id: 'A-1', priority: 'later' }),
      story({ id: 'A-2', priority: 'now' }),
      story({ id: 'A-3', priority: 'next' }),
      story({ id: 'A-4', priority: 'nonsense' }),
    ];
    const order = goalPlan(board(stories)).map((g) => g.id);

    expect(order).toEqual(['A-2', 'A-3', 'A-1', 'A-4']);
  });
});

describe('goalPlan', () => {
  it('orders by PRIORITY first, then by leverage', () => {
    const stories = [
      story({ id: 'A-1', priority: 'later' }),
      story({ id: 'A-2', priority: 'now' }),
      story({ id: 'A-3', priority: 'next' }),
    ];

    expect(goalPlan(board(stories)).map((g) => g.id)).toEqual(['A-2', 'A-3', 'A-1']);
  });

  it('breaks a priority tie by how much each unblocks', () => {
    const stories = [
      story({ id: 'A-1', priority: 'now' }),
      story({ id: 'A-2', priority: 'now' }),
      story({ id: 'A-3', priority: 'later', dependsOn: ['A-2'] }),
    ];
    const order = goalPlan(board(stories)).map((g) => g.id);

    expect(order.indexOf('A-2')).toBeLessThan(order.indexOf('A-1'));
  });

  it('leaves DONE stories out - a goal you already reached is not a goal', () => {
    const stories = [story({ id: 'A-1', status: 'done', verified: 'pins' }), story({ id: 'A-2' })];

    expect(goalPlan(board(stories)).map((g) => g.id)).toEqual(['A-2']);
  });

  it('nests each goal prerequisites in the order they must happen', () => {
    const stories = [
      story({ id: 'A-1' }),
      story({ id: 'A-2', dependsOn: ['A-1'] }),
      story({ id: 'A-3', priority: 'now', dependsOn: ['A-2'] }),
    ];
    const goal = goalPlan(board(stories)).find((g) => g.id === 'A-3');

    expect(goal.ready).toBe(false);
    expect(goal.prerequisites.map((p) => p.id)).toEqual(['A-1', 'A-2']);
  });
});

describe('groomingFindings', () => {
  it('catches a NOW card that is actually blocked', () => {
    const stories = [
      story({ id: 'A-1', priority: 'later' }),
      story({ id: 'A-2', priority: 'now', dependsOn: ['A-1'] }),
    ];
    const f = groomingFindings(board(stories)).filter((x) => x.kind === 'contradiction');

    expect(f.some((x) => x.id === 'A-2' && x.message.includes('priority NOW but waits'))).toBe(true);
  });

  it('catches a LATER card that is ready and gating others', () => {
    const stories = [
      story({ id: 'A-1', priority: 'later' }),
      story({ id: 'A-2', dependsOn: ['A-1'] }),
      story({ id: 'A-3', dependsOn: ['A-1'] }),
    ];
    const f = groomingFindings(board(stories)).filter((x) => x.kind === 'contradiction');

    expect(f.some((x) => x.id === 'A-1' && x.message.includes('LATER but is ready'))).toBe(true);
  });

  it('surfaces an unanswered decision that gates work', () => {
    const stories = [
      story({
        id: 'A-1',
        type: 'decision',
        settled: 'undecided',
        decision: {
          question: 'A or B?',
          options: [
            { key: 'a', label: 'A' },
            { key: 'b', label: 'B' },
          ],
          chosen: null,
        },
      }),
      story({ id: 'A-2', dependsOn: ['A-1'] }),
    ];
    const f = groomingFindings(board(stories)).filter((x) => x.kind === 'decision');

    expect(f).toHaveLength(1);
    expect(f[0].message).toContain('gating 1');
  });

  it('does NOT surface a decision that was already answered', () => {
    const stories = [
      story({
        id: 'A-1',
        settled: 'undecided',
        decision: {
          question: 'A or B?',
          options: [
            { key: 'a', label: 'A' },
            { key: 'b', label: 'B' },
          ],
          chosen: 'a',
        },
      }),
      story({ id: 'A-2', dependsOn: ['A-1'] }),
    ];

    expect(groomingFindings(board(stories)).filter((x) => x.kind === 'decision')).toEqual([]);
  });

  it('flags a STALLED epic, not merely one outside the current focus', () => {
    // The first run flagged eight epics for having no `now` card, which is what
    // deliberate focus looks like. A report that fires on normal states is one
    // people learn to skim.
    const stories = [
      story({ id: 'A-1', epic: 'A', priority: 'now' }),
      story({ id: 'B-1', epic: 'B', priority: 'next', dependsOn: ['A-1'] }),
    ];
    const epics = [
      { key: 'A', name: 'A', why: '' },
      { key: 'B', name: 'B', why: '' },
    ];
    const f = groomingFindings(board(stories, epics)).filter((x) => x.kind === 'hygiene');

    expect(f.some((x) => x.id === 'B' && x.message.includes('NOT ONE is ready'))).toBe(true);
    expect(f.some((x) => x.id === 'A')).toBe(false);
  });
});

describe('renderGroom', () => {
  it('puts decisions above the work they gate', () => {
    // Ordering of the report is itself a claim: answering a decision is minutes
    // and unblocks a chain, so it belongs before the queue, not after it.
    const stories = [
      story({
        id: 'A-1',
        settled: 'undecided',
        decision: {
          question: 'A or B?',
          options: [
            { key: 'a', label: 'A' },
            { key: 'b', label: 'B' },
          ],
          chosen: null,
        },
      }),
      story({ id: 'A-2', dependsOn: ['A-1'] }),
    ];
    const text = renderGroom(board(stories), '2026-08-28');

    expect(text.indexOf('DECISIONS IN THE WAY')).toBeLessThan(text.indexOf('NOW ('));
  });

  it('shows a blocked goal with its do-first list', () => {
    const stories = [
      story({ id: 'A-1', priority: 'later' }),
      story({ id: 'A-2', priority: 'now', dependsOn: ['A-1'] }),
    ];
    const text = renderGroom(board(stories), '2026-08-28');

    expect(text).toContain('do first: A-1');
  });
});
