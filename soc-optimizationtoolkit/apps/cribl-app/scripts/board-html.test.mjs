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
