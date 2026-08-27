// Pins for the docs-drift rules. Same argument as the release-drift pins: the
// facts are stated directly, so a rule can be proven without a repo or a
// filesystem.
//
// The cases below are the audit of 2026-08-26 turned into tests. Each one is a
// document that actually existed in that state, so a regression here is not
// hypothetical - it is the repo going back to where it was.

import { describe, expect, it } from 'vitest';
import { PROPOSED_STALE_DAYS, boardFindings, evaluateDocsDrift } from './check-docs-drift.mjs';

const TODAY = '2026-08-26';

const EXISTS = new Set([
  'soc-optimizationtoolkit/packages/core/src/index.ts',
  'soc-optimizationtoolkit/apps/cribl-app/src/App.tsx',
  'soc-optimizationtoolkit/docs/backlog.md',
  // Present so the retired-token exemption below is tested in isolation: without
  // it the broken-path rule fires on the same line and the assertion passes for
  // a reason the test is not about.
  'deprecated/Cribl-Microsoft_IntegrationSolution',
]);

const doc = (path, text) => ({ path, text });

const facts = (overrides) => ({
  docs: [],
  adrs: [],
  existingPaths: EXISTS,
  today: TODAY,
  ...overrides,
});

describe('evaluateDocsDrift - the status vocabulary', () => {
  it('passes a Living document that names only paths which exist', () => {
    const result = evaluateDocsDrift(
      facts({
        docs: [
          doc(
            'docs/inventory-standard.md',
            '# Inventory standard\n\nStatus: Living\n\nSee `soc-optimizationtoolkit/packages/core/src/index.ts`.\n',
          ),
        ],
      }),
    );

    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.checked).toBe(1);
  });

  it('refuses a document that declares no status at all', () => {
    // The enabling rule. Every other rule is skipped for an undeclared doc, so
    // silence here would let a file opt out of the whole check by omission.
    const result = evaluateDocsDrift(
      facts({ docs: [doc('docs/whatever.md', '# Whatever\n\nSome prose.\n')] }),
    );

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('declares no "Status:"');
  });

  it('refuses a status word that is not in the vocabulary', () => {
    const result = evaluateDocsDrift(
      facts({ docs: [doc('docs/x.md', 'Status: Draft\n')] }),
    );

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('does not START with');
  });

  it('KEEPS the sentence the author wrote after the status word', () => {
    // These headers already said useful things. A check that demanded four bare
    // words would have deleted every one of them to satisfy a parser, which is a
    // check making the documentation worse.
    const result = evaluateDocsDrift(
      facts({
        docs: [
          doc('docs/inventory-standard.md', 'Status: Living - BINDING (user directive 2026-08-10)\n'),
          doc('docs/capability-model-plan.md', 'Status: Record. IMPLEMENTED, all five steps shipped 2026-08-06\n'),
          doc('docs/reroute.md', 'Status: Proposed (plan only, no code)\nLast-confirmed: 2026-08-26\n'),
        ],
      }),
    );

    expect(result.errors).toEqual([]);
    expect(result.checked).toBe(3);
  });

  it('truncates a long status line instead of reprinting the paragraph', () => {
    const rambling = `Status: Sideways ${'x'.repeat(200)}\n`;
    const result = evaluateDocsDrift(facts({ docs: [doc('docs/x.md', rambling)] }));

    expect(result.errors[0]).toContain('...');
    expect(result.errors[0].length).toBeLessThan(400);
  });

  it('reads the key through bold and blockquote decoration', () => {
    // These headers are written for people, so they get formatted like prose.
    // A parser that only accepts the bare form quietly stops checking the files
    // someone took care over.
    const result = evaluateDocsDrift(
      facts({ docs: [doc('docs/x.md', '> **Status:** Record\n')] }),
    );

    expect(result.errors).toEqual([]);
  });

  it('ignores a status word that appears below the header block', () => {
    const filler = '\n'.repeat(60);
    const result = evaluateDocsDrift(
      facts({ docs: [doc('docs/x.md', `# Title${filler}Status: Living\n`)] }),
    );

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('declares no "Status:"');
  });
});

describe('evaluateDocsDrift - retired paths in live documents', () => {
  const REROUTE_PLAN =
    '# Content-preserving native reroute\n\nStatus: Proposed\nLast-confirmed: 2026-08-26\n\n' +
    'Every screen ships in `apps/local-app` as well.\n';

  it('catches the unbuilt plan that still instructs a build for the dropped shell', () => {
    // The exact document, in the exact state, that this check was written for.
    const result = evaluateDocsDrift(
      facts({ docs: [doc('docs/features/content-preserving-native-reroute.md', REROUTE_PLAN)] }),
    );

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('apps/local-app');
    expect(result.errors[0]).toContain('ADR 0002');
    // The line number is load-bearing: the fix is a one-line edit in a long file.
    expect(result.errors[0]).toContain(':6');
  });

  it('exempts the same sentence once the document is labelled Record', () => {
    // The affordability argument for the whole design: a repo full of history
    // does not have to be rewritten, only labelled.
    const asRecord = REROUTE_PLAN.replace('Status: Proposed', 'Status: Record');
    const result = evaluateDocsDrift(facts({ docs: [doc('docs/f.md', asRecord)] }));

    expect(result.errors).toEqual([]);
  });

  it('catches the dual-shell build instruction by phrase, not only by path', () => {
    const result = evaluateDocsDrift(
      facts({
        docs: [doc('docs/porting-plan.md', 'Status: Living\n\nIt ships in both shells or it does not ship.\n')],
      }),
    );

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('both shells');
  });

  it('allows the deprecated tree when it is named with its full path', () => {
    // The tree still exists one directory down. Flagging the correct reference
    // would push people toward writing the incorrect one.
    const result = evaluateDocsDrift(
      facts({
        docs: [
          doc('docs/x.md', 'Status: Living\n\nSee `deprecated/Cribl-Microsoft_IntegrationSolution/` for the old GUI.\n'),
        ],
      }),
    );

    expect(result.errors).toEqual([]);
  });

  it('still catches the same tree named without its prefix', () => {
    const result = evaluateDocsDrift(
      facts({ docs: [doc('docs/x.md', 'Status: Living\n\nRun the Cribl-Microsoft_IntegrationSolution app.\n')] }),
    );

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('deprecated/');
  });

  it('reports every offending line rather than only the first', () => {
    // A check that stops at the first hit turns one fix into as many rounds as
    // there are mentions, which is how people learn to stop running it.
    const result = evaluateDocsDrift(
      facts({
        docs: [doc('docs/x.md', 'Status: Living\n\nboth shells\n\nmore\n\nboth shells\n')],
      }),
    );

    expect(result.errors).toHaveLength(2);
  });
});

describe('evaluateDocsDrift - the suppression marker', () => {
  it('lets a Living document quote history on the marked line', () => {
    // backlog.md is the real case: it states what is open NOW, so it is Living,
    // and its resolved sections still have to say what they resolved.
    const result = evaluateDocsDrift(
      facts({
        docs: [doc('docs/backlog.md', 'Status: Living\n\nThe Browse Samples modal was removed. <!--drift-ok-->\n')],
      }),
    );

    expect(result.errors).toEqual([]);
  });

  it('COUNTS every suppression and says so', () => {
    // A suppression nobody can see is how this check would quietly stop meaning
    // anything, so the number is reported even when nothing failed.
    const result = evaluateDocsDrift(
      facts({
        docs: [
          doc('docs/a.md', 'Status: Living\n\nboth shells <!--drift-ok-->\nboth shells <!--drift-ok-->\n'),
          doc('docs/b.md', 'Status: Living\n\nBrowse Samples <!--drift-ok-->\n'),
        ],
      }),
    );

    expect(result.errors).toEqual([]);
    expect(result.suppressed).toBe(3);
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]).toContain('3 line(s)');
  });

  it('suppresses only the line it is on', () => {
    const result = evaluateDocsDrift(
      facts({
        docs: [doc('docs/a.md', 'Status: Living\n\nboth shells <!--drift-ok-->\nboth shells\n')],
      }),
    );

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain(':4');
    expect(result.suppressed).toBe(1);
  });

  it('stays silent about suppressions when there are none', () => {
    const result = evaluateDocsDrift(facts({ docs: [doc('docs/a.md', 'Status: Living\n')] }));

    expect(result.notes).toEqual([]);
    expect(result.suppressed).toBe(0);
  });
});

describe('evaluateDocsDrift - broken path references', () => {
  it('catches a Living document pointing at a path that does not exist', () => {
    const result = evaluateDocsDrift(
      facts({
        docs: [doc('docs/ui-refinement-reference.md', 'Status: Living\n\nLaunch `apps/gone/main.ts`.\n')],
      }),
    );

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('apps/gone/main.ts');
  });

  it('accepts a path written from inside the toolkit', () => {
    // Both spellings are normal in these docs. Rejecting one would be a rule
    // about house style wearing a correctness rule's clothes.
    const result = evaluateDocsDrift(
      facts({ docs: [doc('docs/x.md', 'Status: Living\n\nSee `packages/core/src/index.ts`.\n')] }),
    );

    expect(result.errors).toEqual([]);
  });

  it('does NOT hold a Proposed plan to paths it has not built yet', () => {
    // A plan legitimately names the files it intends to create. This is the one
    // place the Proposed and Living rules deliberately differ.
    const result = evaluateDocsDrift(
      facts({
        docs: [
          doc(
            'docs/plan.md',
            'Status: Proposed\nLast-confirmed: 2026-08-20\n\nAdd `packages/core/src/domain/not-yet/index.ts`.\n',
          ),
        ],
      }),
    );

    expect(result.errors).toEqual([]);
  });

  it('leaves inline prose in backticks alone', () => {
    const result = evaluateDocsDrift(
      facts({ docs: [doc('docs/x.md', 'Status: Living\n\nThe `_raw` field and `Status:` key.\n')] }),
    );

    expect(result.errors).toEqual([]);
  });
});

describe('evaluateDocsDrift - proposed plans expire', () => {
  const proposed = (confirmed) =>
    facts({ docs: [doc('docs/plan.md', `Status: Proposed\nLast-confirmed: ${confirmed}\n`)] });

  it('requires a confirmation date', () => {
    const result = evaluateDocsDrift(facts({ docs: [doc('docs/plan.md', 'Status: Proposed\n')] }));

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('Last-confirmed');
  });

  it('accepts a plan confirmed today', () => {
    expect(evaluateDocsDrift(proposed(TODAY)).errors).toEqual([]);
  });

  it('fails a plan past the limit and says how to clear it', () => {
    const result = evaluateDocsDrift(proposed('2026-05-01'));

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('117 days ago');
    expect(result.errors[0]).toContain('Status to Record');
  });

  it('warns before it fails, so the deadline is never a surprise', () => {
    // 55 days: inside the limit, inside the two-week notice.
    const result = evaluateDocsDrift(proposed('2026-07-02'));

    expect(result.errors).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('re-confirmation');
  });

  it('rejects a confirmation date that is not a date', () => {
    const result = evaluateDocsDrift(proposed('last Tuesday'));

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('not a YYYY-MM-DD');
  });

  it('holds the limit where the pins assume it is', () => {
    expect(PROPOSED_STALE_DAYS).toBe(60);
  });
});

describe('evaluateDocsDrift - superseded documents name a successor', () => {
  it('refuses a Superseded document with nowhere to send the reader', () => {
    const result = evaluateDocsDrift(facts({ docs: [doc('docs/old.md', 'Status: Superseded\n')] }));

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('names no successor');
  });

  it('accepts one that does', () => {
    const result = evaluateDocsDrift(
      facts({ docs: [doc('docs/old.md', 'Status: Superseded\nSuperseded by: docs/board.md\n')] }),
    );

    expect(result.errors).toEqual([]);
  });

  it('accepts the successor named inline, which is how ADRs already write it', () => {
    const result = evaluateDocsDrift(
      facts({ docs: [doc('docs/old.md', 'Status: Superseded in part by ADR 0002\n')] }),
    );

    expect(result.errors).toEqual([]);
  });
});

describe('evaluateDocsDrift - an ADR must carry its own consequences', () => {
  const accepted = (extra) => doc('docs/adr/0002-drop-local-target.md', `Status: Accepted\n${extra}`);

  it('refuses an accepted ADR that does not say what it invalidates', () => {
    const result = evaluateDocsDrift(facts({ adrs: [accepted('')] }));

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('Invalidates:');
  });

  it('accepts "none" for a decision that broke nothing', () => {
    const result = evaluateDocsDrift(facts({ adrs: [accepted('Invalidates: none\n')] }));

    expect(result.errors).toEqual([]);
  });

  it('catches a named document that never acknowledges the decision', () => {
    // THE GAP THIS FIELD EXISTS TO CLOSE. ADR 0002 was written correctly and
    // still left six documents asserting the world it had just ended, because
    // nothing carried the decision out of the decision log.
    const result = evaluateDocsDrift(
      facts({
        adrs: [accepted('Invalidates: porting-plan.md\n')],
        docs: [doc('docs/porting-plan.md', 'Status: Record\n\nThe plan.\n')],
      }),
    );

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('never mentions ADR 0002');
  });

  it('passes once that document points back at the ADR', () => {
    const result = evaluateDocsDrift(
      facts({
        adrs: [accepted('Invalidates: porting-plan.md\n')],
        docs: [doc('docs/porting-plan.md', 'Status: Record\n\nSuperseded in part by ADR 0002.\n')],
      }),
    );

    expect(result.errors).toEqual([]);
  });

  it('catches an ADR invalidating something that is not there', () => {
    const result = evaluateDocsDrift(facts({ adrs: [accepted('Invalidates: ghost.md\n')] }));

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('not a document this check can find');
  });

  it('leaves a superseded ADR alone', () => {
    // Only Accepted decisions are binding, so only they owe a consequence list.
    const result = evaluateDocsDrift(
      facts({ adrs: [doc('docs/adr/0001-dual-target.md', 'Status: Superseded by ADR 0002\n')] }),
    );

    expect(result.errors).toEqual([]);
  });
});

/**
 * Pins for the board's structural rules.
 *
 * Deliberately few. The board is a working surface, and a checker that argued
 * with its prose would get the prose removed instead of the rule obeyed. These
 * three catch the ways it rots without anyone noticing.
 */
describe('boardFindings', () => {
  const board = (body) => ({ path: 'docs/board.md', text: body });

  const EPICS =
    '| Key | Epic | Why |\n|---|---|---|\n' +
    '| `REL` | Ship what is built | ... |\n' +
    '| `FX` | Effect-identity defects | ... |\n';

  it('passes a board whose stories all belong to a declared epic', () => {
    const result = boardFindings(
      board(`${EPICS}\n- **REL-1** Open the PR.\n- **FX-1** Guard the latch.\n`),
    );

    expect(result).toEqual([]);
  });

  it('catches a duplicated story id', () => {
    // The one that actually bites: the second card looks tracked, gets named in
    // a commit message, and points at whichever one the reader found first.
    // FX-1 is present so the empty-epic rule stays quiet and this asserts on
    // the duplicate alone.
    const result = boardFindings(
      board(`${EPICS}\n- **REL-1** Open the PR.\n- **REL-1** Something else.\n- **FX-1** Guard it.\n`),
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toContain('REL-1 2 times');
  });

  it('catches a story whose epic was never declared', () => {
    const result = boardFindings(
      board(`${EPICS}\n- **REL-1** Open the PR.\n- **FX-1** Guard it.\n- **ZZZ-1** From nowhere.\n`),
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toContain('ZZZ-* stories but no `ZZZ` row');
  });

  it('catches an epic that quietly emptied out', () => {
    // It either shipped, in which case say so, or it lost its work. Both are
    // worth knowing and neither announces itself.
    const result = boardFindings(board(`${EPICS}\n- **REL-1** Open the PR.\n`));

    expect(result).toHaveLength(1);
    expect(result[0]).toContain('declares epic `FX` but no story carries it');
  });

  it('reads a spike id with a letter in it', () => {
    // AZR-S1 and AZR-S2 are spikes. A stricter id pattern would file them under
    // an epic called AZR-S and report two problems that are not there.
    const result = boardFindings(
      board(
        '| Key | Epic | Why |\n|---|---|---|\n| `AZR` | Azure onboarding | ... |\n\n' +
          '- **AZR-S1** Verify the API grain.\n- **AZR-0** Port the model.\n',
      ),
    );

    expect(result).toEqual([]);
  });

  it('ignores bold text that is not a story id', () => {
    const result = boardFindings(
      board(`${EPICS}\n- **REL-1** Open the PR.\n- **FX-1** Guard it.\n\n- **Note** prose.\n`),
    );

    expect(result).toEqual([]);
  });
});
