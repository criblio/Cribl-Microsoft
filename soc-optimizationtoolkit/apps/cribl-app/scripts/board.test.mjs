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
import {
  applyDecision,
  backlogSectionIds,
  blockers,
  renderBoard,
  validateBoard,
} from './board.mjs';

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
  type: 'enabler',
  feature: 'REL-F1',
  status: 'backlog',
  priority: 'now',
  settled: 'settled',
  dependsOn: [],
  detail: '',
  ...over,
});

const board = (stories, epics, features) => ({
  epics: epics ?? [{ key: 'REL', name: 'Ship it', why: 'because' }],
  features: features ?? [{ id: 'REL-F1', epic: 'REL', menu: 'none', title: 'A feature' }],
  stories,
});

/**
 * A bug is `now` unless the card says why not.
 *
 * The default flips because a defect is already costing someone something
 * while a feature is only not-yet-earning. "All bugs are now" was considered
 * and rejected - it flattens silent data loss and a list that swallows the
 * mouse wheel into one rank, and a NOW column holding everything ranks
 * nothing. So the exception survives, priced at an argument written down.
 */
/**
 * DBT-59: the reason has to be VISIBLE, not merely mandatory.
 *
 * check-board enforcing priorityWhy while nothing renders it buys the ritual
 * and none of the thinking - a justification nobody can read cannot be argued
 * with, only satisfied. These pin the three surfaces someone actually looks at.
 */
describe('renderBoard - a deprioritised bug shows its argument', () => {
  const heldBack = story({
    type: 'bug',
    priority: 'next',
    priorityWhy: 'Cosmetic: the control works, it just does not match the app around it.',
  });

  it('renders the reason, not just the priority', () => {
    // Collapsed because the renderer wraps at 76 columns, so the sentence is
    // split across lines in the file - asserting the raw string would pin the
    // wrap width rather than the behaviour.
    const md = renderBoard(board([heldBack])).replace(/\s+/g, ' ');

    expect(md).toContain('Not now because');
    expect(md).toContain('it just does not match the app around it');
  });

  it('says nothing for a bug at now - there is no exception to explain', () => {
    const md = renderBoard(board([story({ type: 'bug', priority: 'now' })]));

    expect(md).not.toContain('Not now because');
  });
});

describe('validateBoard - a deprioritised bug owes a reason', () => {
  const bug = (over) => story({ type: 'bug', ...over });

  it('accepts a bug at now with no priorityWhy - that is the default', () => {
    expect(validateBoard(board([bug({ priority: 'now' })]))).toEqual([]);
  });

  it('REJECTS a bug pushed to next with no reason', () => {
    const out = validateBoard(board([bug({ priority: 'next' })]));

    expect(out).toHaveLength(1);
    expect(out[0]).toContain('with no priorityWhy');
  });

  it('rejects later just the same - the rule is not about one rank', () => {
    const out = validateBoard(board([bug({ priority: 'later' })]));

    expect(out.some((f) => f.includes('with no priorityWhy'))).toBe(true);
  });

  it('REJECTS a placeholder - the field is the argument, not a checkbox', () => {
    // The failure this guards: satisfying the rule with "cosmetic" and moving
    // on, which buys the ritual and none of the thinking.
    const out = validateBoard(board([bug({ priority: 'next', priorityWhy: 'cosmetic' })]));

    expect(out).toHaveLength(1);
    expect(out[0]).toContain('Name the reason it can wait');
  });

  it('accepts a real reason', () => {
    const why =
      'Cosmetic: the control works, it just does not match the app around it.';

    expect(validateBoard(board([bug({ priority: 'next', priorityWhy: why })]))).toEqual([]);
  });

  it('leaves a DONE bug alone - priority is a backlog question', () => {
    expect(
      validateBoard(board([bug({ priority: 'later', status: 'done', verified: 'pins' })])),
    ).toEqual([]);
  });

  it('rejects the field on a non-bug, where it answers nothing', () => {
    const out = validateBoard(
      board([story({ type: 'story', priority: 'next', priorityWhy: 'a perfectly good sentence' })]),
    );

    expect(out).toHaveLength(1);
    expect(out[0]).toContain('not a deprioritised bug');
  });

  it('rejects the field on a bug that is already now', () => {
    const out = validateBoard(
      board([bug({ priority: 'now', priorityWhy: 'a perfectly good sentence' })]),
    );

    expect(out[0]).toContain('not a deprioritised bug');
  });
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

  it('catches an epic that carries no FEATURE', () => {
    // Re-pointed when the hierarchy landed 2026-08-28: an epic now holds
    // features, and features hold stories, so "empty" is one level up.
    const out = validateBoard(
      board([story({})], [
        { key: 'REL', name: 'Ship it', why: '' },
        { key: 'GONE', name: 'Empty', why: '' },
      ]),
    );

    expect(out).toHaveLength(1);
    expect(out[0]).toContain('Epic GONE is declared but carries no feature');
  });

  it('catches a feature that carries no story', () => {
    const out = validateBoard(
      board([story({})], undefined, [
        { id: 'REL-F1', epic: 'REL', menu: 'none', title: 'A feature' },
        { id: 'REL-F9', epic: 'REL', menu: 'none', title: 'Abandoned' },
      ]),
    );

    expect(out).toHaveLength(1);
    expect(out[0]).toContain('Feature REL-F9 is declared but carries no story');
  });

  it('catches a story whose feature lives in a DIFFERENT epic', () => {
    // The rule that actually bites: every rollup - percent complete, the epic
    // column, the counts - would disagree with itself depending on which side
    // it counted from.
    const out = validateBoard(
      board([story({ epic: 'REL', feature: 'OTH-F1' })], [
        { key: 'REL', name: 'Ship it', why: '' },
        { key: 'OTH', name: 'Other', why: '' },
      ], [
        { id: 'REL-F1', epic: 'REL', menu: 'none', title: 'A feature' },
        { id: 'OTH-F1', epic: 'OTH', menu: 'none', title: 'Elsewhere' },
      ]),
    );

    expect(out.some((f) => f.includes('but its feature OTH-F1 is in epic OTH'))).toBe(true);
  });

  it('REQUIRES every feature to name a menu item', () => {
    // Added 2026-08-28. The tag's whole value is being able to ask "what is
    // left before Sentinel Integration works end to end" and trust the answer.
    // One untagged feature makes that answer quietly short.
    const out = validateBoard(
      board([story({})], undefined, [{ id: 'REL-F1', epic: 'REL', title: 'A feature' }]),
    );

    expect(out).toHaveLength(1);
    expect(out[0]).toContain('has no menu');
  });

  it('rejects a menu that is not one of the app\'s routes', () => {
    // The vocabulary is copied from the nav registration, so an invented menu
    // is a card claiming to be about a screen that does not exist.
    const out = validateBoard(
      board([story({})], undefined, [
        { id: 'REL-F1', epic: 'REL', menu: 'dashboard', title: 'A feature' },
      ]),
    );

    expect(out).toHaveLength(1);
    expect(out[0]).toContain('not a menu item');
  });

  it('lets a STORY override its feature\'s menu', () => {
    // A few genuinely differ - a fallback offer that lands on the Integrate
    // deploy while its feature is about the capability audit.
    expect(
      validateBoard(board([story({ menu: 'integrate' })], undefined, [
        { id: 'REL-F1', epic: 'REL', menu: 'none', title: 'A feature' },
      ])),
    ).toEqual([]);
  });

  it('rejects an override that just RESTATES the feature\'s menu', () => {
    // A second copy of the same fact is a second thing to keep in step, and
    // this one goes stale silently the moment the feature is re-tagged.
    const out = validateBoard(
      board([story({ menu: 'none' })], undefined, [
        { id: 'REL-F1', epic: 'REL', menu: 'none', title: 'A feature' },
      ]),
    );

    expect(out).toHaveLength(1);
    expect(out[0]).toContain('repeats its feature');
  });

  it('rejects a story override naming a menu that does not exist', () => {
    const out = validateBoard(board([story({ menu: 'nowhere' })]));

    expect(out).toHaveLength(1);
    expect(out[0]).toContain('not a menu item');
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
    // The fixture gained a backlog.md citation when the citation rule landed
    // (see "an answered decision owes a citation" below). The pin still tests
    // what it always tested - that ANSWERING resolves the settled/unanswered
    // contradiction above - it just now has to satisfy both requirements of a
    // settled decision rather than one. Kept rather than relaxed: dropping it
    // would leave the contradiction check with no positive case.
    expect(
      validateBoard(
        board([
          withDecision(
            { settled: 'settled', detail: 'Reasoning in backlog.md section 18a.' },
            { chosen: 'footer' },
          ),
        ]),
      ),
    ).toEqual([]);
  });
});

describe('backlogSectionIds', () => {
  it('reads ## and ### numbered section ids, including letter suffixes', () => {
    const ids = backlogSectionIds(
      ['# Backlog', '## 5. Windows Event analysis screen', '### 6g. Dataflow diagrams', 'prose'].join(
        '\n',
      ),
    );

    expect([...ids].sort()).toEqual(['5', '6g']);
  });

  it('ignores headings that are not numbered sections', () => {
    expect([...backlogSectionIds('## Overview\n### Notes\n#### 9. Too deep')]).toEqual([]);
  });
});

describe('validateBoard - citations into backlog.md', () => {
  const cite = (detail) => board([story({ detail })]);

  it('REJECTS a line-number citation', () => {
    // The 2026-08-28 count: 7 of 39 line citations had drifted onto blank
    // lines and several pointed at the wrong section entirely, because
    // backlog.md grows by insertion. A silently wrong pointer sends a reader
    // to confidently read the wrong thing.
    const out = validateBoard(cite('see backlog.md:113-116'));

    expect(out).toHaveLength(1);
    expect(out[0]).toContain('by LINE NUMBER');
  });

  it('accepts an anchor that resolves to a real section', () => {
    expect(
      validateBoard(cite('see backlog.md#6g'), { backlogSections: new Set(['6g']) }),
    ).toEqual([]);
  });

  it('REJECTS an anchor with no such section', () => {
    const out = validateBoard(cite('see backlog.md#99z'), {
      backlogSections: new Set(['6g']),
    });

    expect(out).toHaveLength(1);
    expect(out[0]).toContain('not a section in backlog.md');
  });

  it('still rejects the line format when no section list is supplied', () => {
    // The format rule does not need the backlog to be readable; only anchor
    // RESOLUTION does. A missing backlog must not silently disable the check.
    expect(validateBoard(cite('see backlog.md:900'))).toHaveLength(1);
  });

  it('leaves anchors unresolved, not rejected, without a section list', () => {
    expect(validateBoard(cite('see backlog.md#6g'))).toEqual([]);
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

  it('rolls each epic up as PERCENT COMPLETE over its stories', () => {
    // Re-pointed 2026-08-28: the epics table became an Epic > Feature rollup.
    // The fixture is 3 stories, 1 done.
    expect(renderBoard(data, '2026-08-27')).toContain('33% (1/3)');
  });

  it('carries a Status line, so the docs-drift check still governs it', () => {
    expect(renderBoard(data, '2026-08-27')).toMatch(/^Status: Living/m);
  });

  it('gives the feature table exactly its four columns, with no score among them', () => {
    // WSJF was built and removed on 2026-08-28 (see the note in board.mjs):
    // scoring answers contention between features for one team's finite
    // capacity, and there is one author here. This pin is what makes a re-add
    // show up as a failing test in review rather than as a silent extra column.
    //
    // It reads the table STRUCTURE rather than searching the page for "WSJF" or
    // "score". The first version did search the prose, and it failed on the
    // preamble sentence that explains features carry no score - a word-search
    // cannot tell a column from a paragraph about columns, and would have been
    // routed around the moment it cried wolf.
    //
    // RE-POINTED 2026-08-28 from three columns to four: `Menu` was added
    // deliberately, and exact-header matching means such a change has to be
    // made here on purpose. That is the pin working, not the pin being in the
    // way - the same reason it would catch a `Score` column.
    const md = renderBoard(data, '2026-08-27');
    const headers = md.split('\n').filter((l) => l.startsWith('| Feature |'));

    expect(headers.length).toBeGreaterThan(0);
    for (const h of headers) expect(h).toBe('| Feature | Menu | Done | Stories |');

    const rows = md.split('\n').filter((l) => /^\| `[A-Z]+-F\d/.test(l));
    expect(rows).toHaveLength(1);
    for (const r of rows) expect(r.split('|').length - 2).toBe(4);
  });
});

/**
 * An answer is not a decision.
 *
 * Picking an option records `chosen` and touches nothing else, deliberately -
 * the reasoning still has to reach backlog.md. That contract had no
 * enforcement and NINE cards accumulated a ticked box with no argument behind
 * it, three of them still reading as questions blocking answered work.
 */
describe('validateBoard - an answered decision owes a citation', () => {
  const decided = (over) =>
    story({
      decision: {
        question: 'Which way?',
        options: [
          { key: 'a', label: 'A', detail: 'one way' },
          { key: 'b', label: 'B', detail: 'the other' },
        ],
        chosen: 'a',
      },
      ...over,
    });

  it('accepts a settled decision citing a SECTION', () => {
    const out = validateBoard(
      board([decided({ detail: 'Reasoning in backlog.md section 18a.' })]),
    );
    expect(out).toEqual([]);
  });

  it('accepts the older ANCHOR spelling too - one fact, not two conventions', () => {
    // Load-bearing. The first draft of this rule accepted only "section" and
    // flagged AZR-S2, VND-3 and D-7, all of which were correctly cited as
    // `backlog.md#6h` style. A checker that invents a second convention for a
    // fact the repo already records is worse than no checker.
    expect(validateBoard(board([decided({ detail: 'See backlog.md#6h.' })]))).toEqual([]);
  });

  it('REJECTS a settled decision that cites nothing', () => {
    const out = validateBoard(board([decided({ detail: 'DECIDED: option A.' })]));

    expect(out).toHaveLength(1);
    expect(out[0]).toContain('cites no reasoning');
  });

  it('REJECTS a card whose write-up exists but never settled - the nine', () => {
    // The exact shape that accumulated: reasoning written, `settled` left
    // behind. Without this half the rule only catches one direction.
    const out = validateBoard(
      board([decided({ settled: 'undecided', detail: 'Reasoning in backlog.md section 18a.' })]),
    );

    expect(out).toHaveLength(1);
    expect(out[0]).toContain('settle the card');
  });

  it('leaves an UNANSWERED decision alone - it owes nothing yet', () => {
    // The open question is the one state that is legitimately incomplete.
    const d = decided({ settled: 'undecided', detail: 'no citation here' });
    d.decision.chosen = null;
    expect(validateBoard(board([d]))).toEqual([]);
  });

  it('ignores stories with no decision block at all', () => {
    expect(validateBoard(board([story({ detail: 'no decision, no citation' })]))).toEqual([]);
  });
});
