// Pins for the kanban rendering.
//
// These guard the two things a second renderer can silently get wrong: showing
// a DIFFERENT set of work than board.md shows (both read board.json, so any
// disagreement is this file's fault), and rendering card text as markup.

import { describe, expect, it } from 'vitest';
import { columnsFrom, renderBoardHtml } from './board-html.mjs';
import { STATUSES } from './board.mjs';

const story = (over) => ({
  id: 'REL-1',
  epic: 'REL',
  title: 'Do the thing',
  type: 'enabler',
  feature: 'A-F1',
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

describe('columnsFrom', () => {
  it('DERIVES a column for every declared status', () => {
    // The audit finding of 2026-08-27: this file used to hardcode its own copy
    // of the three statuses while validateBoard accepted STATUSES. The two
    // agreed by luck, and a fourth status would have validated fine and then
    // rendered into no column at all.
    expect(columnsFrom(STATUSES).map((c) => c.status)).toEqual([...STATUSES]);
  });

  it('gives an UNKNOWN status a column keyed by its own name', () => {
    // The pin that actually fails if the list is hardcoded again: a status
    // nobody wrote a title for must still get somewhere to live, because a
    // missing column loses cards silently.
    const cols = columnsFrom(['backlog', 'archived']);

    expect(cols).toEqual([
      { status: 'backlog', title: 'Backlog' },
      { status: 'archived', title: 'archived' },
    ]);
  });
});

/**
 * DBT-59: the kanban is where the argument gets read, so it must show it.
 * Rendered plainly rather than behind a <details> toggle - a reason hidden
 * behind a click is as unread as one not rendered at all, and the field only
 * earns its keep if a groomer meets it without going looking.
 */
describe('renderBoardHtml - a deprioritised bug shows its argument', () => {
  const why = 'Cosmetic: the control works, it just does not match the app.';

  it('renders the reason on the card, not inside a details toggle', () => {
    const html = renderBoardHtml(
      board([story({ id: 'REL-1', type: 'bug', priority: 'next', priorityWhy: why })]),
      '2026-08-31',
    );

    expect(html).toContain('Not now because');
    expect(html).toContain('it just does not match the app');
    // Plain paragraph, not a collapsed section.
    expect(html).toMatch(/<p class="why">/);
  });

  it('shows nothing for a bug at now', () => {
    const html = renderBoardHtml(
      board([story({ id: 'REL-1', type: 'bug', priority: 'now' })]),
      '2026-08-31',
    );

    expect(html).not.toContain('Not now because');
  });
});

describe('renderBoardHtml', () => {
  it('renders one column per PROGRESS state, counted', () => {
    const html = renderBoardHtml(
      board([
        story({ id: 'REL-1', status: 'backlog' }),
        story({ id: 'REL-2', status: 'in-progress' }),
        story({ id: 'REL-3', status: 'done' }),
        story({ id: 'REL-4', status: 'done' }),
      ]),
      '2026-08-27',
    );

    expect(html).toContain('data-status="backlog"');
    expect(html).toContain('data-status="in-progress"');
    expect(html).toContain('data-status="done"');
    expect(html).toMatch(/Done <span class="count">2<\/span>/);
  });

  it('lanes the backlog by priority, and never loses an odd one', () => {
    // A story whose priority is missing still has to appear somewhere - the
    // failure this guards is a card that exists in board.json and is on no
    // column at all, which no count would reveal.
    const html = renderBoardHtml(
      board([
        story({ id: 'REL-1', priority: 'now' }),
        story({ id: 'REL-2', priority: 'later' }),
        story({ id: 'REL-3', priority: undefined }),
      ]),
      '2026-08-27',
    );

    expect(html).toContain('id="card-REL-1"');
    expect(html).toContain('id="card-REL-2"');
    expect(html).toContain('id="card-REL-3"');
    expect(html).toContain('unprioritised');
  });

  it('marks a blocked card and names what blocks it', () => {
    const html = renderBoardHtml(
      board([
        story({ id: 'REL-1', dependsOn: ['REL-2'] }),
        story({ id: 'REL-2', status: 'backlog' }),
      ]),
      '2026-08-27',
    );

    expect(html).toContain('blocked by REL-2');
    expect(html).toContain('data-blocked="yes"');
  });

  it('does NOT mark a card whose dependency is done', () => {
    const html = renderBoardHtml(
      board([
        story({ id: 'REL-1', dependsOn: ['REL-2'] }),
        story({ id: 'REL-2', status: 'done' }),
      ]),
      '2026-08-27',
    );

    expect(html).not.toContain('blocked by');
  });

  it('ESCAPES card text rather than letting it become markup', () => {
    // board.json is hand-edited prose. A title with an angle bracket must not
    // be able to close a tag - and `detail` gets a light rich-text pass, so it
    // is the one most likely to leak.
    const html = renderBoardHtml(
      board([
        story({
          title: '<script>alert(1)</script>',
          detail: 'plain <b>bold</b> & "quoted"',
        }),
      ]),
      '2026-08-27',
    );

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;b&gt;bold&lt;/b&gt;');
  });

  it('renders code spans and card links inside detail', () => {
    const html = renderBoardHtml(
      board([story({ detail: 'see `install-pack.ts` and [[REL-2]]' })]),
      '2026-08-27',
    );

    expect(html).toContain('<code>install-pack.ts</code>');
    expect(html).toContain('href="#card-REL-2"');
  });

  it('renders a decision as pickable options, wired to the story', () => {
    const html = renderBoardHtml(
      board([
        story({
          id: 'D-1',
          settled: 'undecided',
          decision: {
            question: 'Footer or connection bar?',
            options: [
              { key: 'footer', label: 'Frame footer' },
              { key: 'bar', label: 'Connection bar' },
            ],
            chosen: null,
          },
        }),
      ]),
      '2026-08-28',
    );

    expect(html).toContain('Footer or connection bar?');
    expect(html).toContain('name="dec-D-1"');
    expect(html).toContain('value="footer"');
    expect(html).toContain('value="bar"');
    expect(html).toContain('data-story="D-1"');
  });

  it('SAYS that a click records an answer rather than settling the card', () => {
    // Without this the green tick reads as "decided", which is exactly the
    // conflation the feature is built to avoid.
    const html = renderBoardHtml(
      board([
        story({
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
      ]),
      '2026-08-28',
    );

    expect(html).toContain('does not settle the card');
  });

  it('marks the chosen option and still says the card is undecided', () => {
    const html = renderBoardHtml(
      board([
        story({
          settled: 'undecided',
          decision: {
            question: 'A or B?',
            options: [
              { key: 'a', label: 'A' },
              { key: 'b', label: 'B' },
            ],
            chosen: 'b',
          },
        }),
      ]),
      '2026-08-28',
    );

    // Exactly one option is pre-selected, and it is b.
    expect(html.match(/ checked>/g)).toHaveLength(1);
    expect(html).toMatch(/value="b"[^>]* checked>/);
    expect(html).toContain('class="opt picked"');
    expect(html).toContain('Still <strong>undecided</strong>');
  });

  it('shows validation findings instead of hiding them', () => {
    // The server passes validateBoard's output straight in. A board that
    // breaks its own rules is exactly when someone is looking at this page.
    const html = renderBoardHtml(board([story({})]), '2026-08-27', [
      'REL-9 depends on NOPE-1, which is not a story on this board.',
    ]);

    expect(html).toContain('fails 1 of its own rules');
    expect(html).toContain('not a story on this board');
  });

  it('says nothing about rules when the board is sound', () => {
    expect(renderBoardHtml(board([story({})]), '2026-08-27', [])).not.toContain(
      'of its own rules',
    );
  });

  it('counts OPEN stories per epic, matching the markdown board', () => {
    const html = renderBoardHtml(
      board([story({ id: 'REL-1' }), story({ id: 'REL-2', status: 'done' })]),
      '2026-08-27',
    );

    expect(html).toMatch(/data-filter-epic="REL">REL <span class="count">1<\/span>/);
  });
});

describe('DBT-30 - a grouping at 100% collapses, and is never given a status', () => {
  const feats = [{ id: 'A-F1', epic: 'REL', menu: 'none', title: 'A feature' }];
  const done = (id) => story({ id, status: 'done', verified: 'pins', priority: undefined });

  it('collapses an epic and a feature whose every card is done', () => {
    const data = { ...board([done('REL-1'), done('REL-2')]), features: feats };
    const html = renderBoardHtml(data, '2026-08-30', []);

    // Both groupings - the epic card and the feature card.
    expect((html.match(/data-complete="yes"/g) ?? []).length).toBe(2);
    expect(html).toContain('100% &middot; 2/2 done');
  });

  it('UN-collapses the moment one open card is filed underneath', () => {
    // The whole reason this is derived rather than stored. Observed for real on
    // 2026-08-30: DBT-F5 was 11/11 and collapsed until this very card was filed
    // into it, at which point it re-expanded on its own. A declared `done`
    // would have kept claiming the feature was finished.
    const data = {
      ...board([done('REL-1'), story({ id: 'REL-2' })]),
      features: feats,
    };
    const html = renderBoardHtml(data, '2026-08-30', []);

    expect(html).not.toContain('data-complete="yes"');
  });

  it('does NOT treat an EMPTY grouping as complete', () => {
    // Zero of zero done is a grouping with nothing in it, which validateBoard
    // already reports as a finding. Dimming it would hide the thing that needs
    // attention behind a tick.
    const data = {
      ...board([done('REL-1')], [
        { key: 'REL', name: 'Ship it', why: '' },
        { key: 'EMPTY', name: 'Nothing here', why: '' },
      ]),
      features: feats,
    };
    const html = renderBoardHtml(data, '2026-08-30', []);

    expect(html).toContain('EMPTY');
    // REL's epic + A-F1's feature are complete; EMPTY is not.
    expect((html.match(/data-complete="yes"/g) ?? []).length).toBe(2);
  });

  it('keeps the collapsed card ON the board with its count', () => {
    // Collapsed, not retired. Hiding it would lose the fact that the grouping
    // exists and is finished, which is the useful half.
    const data = { ...board([done('REL-1')]), features: feats };
    const html = renderBoardHtml(data, '2026-08-30', []);

    expect(html).toContain('Ship it');
    expect(html).toContain('A feature');
    expect(html).toContain('100% &middot; 1/1 done');
  });

  it('gives epics and features NO status field to disagree with the stories', () => {
    // The decision this card records: completion stays derived. If a `status`
    // ever appears on an epic or feature, it is a second source of truth for a
    // fact the stories already answer, and this pin is the tripwire.
    const data = { ...board([done('REL-1')]), features: feats };

    expect(Object.keys(data.epics[0])).not.toContain('status');
    expect(Object.keys(data.features[0])).not.toContain('status');
  });
});
