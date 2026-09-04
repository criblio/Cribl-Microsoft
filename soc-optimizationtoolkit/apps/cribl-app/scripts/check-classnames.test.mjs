// Pins for the class-name check, and for the two defects that produced it.
//
// The DBT-39 cases below are not hypothetical: each is a className this repo was
// actually rendering against no rule at all, so a regression here is the repo
// going back to where it was on 2026-08-31.
//
// Most of these tests state their facts directly, the way the docs-drift and
// release-drift pins do. The last block cannot: DBT-38 is a defect in the real
// stylesheet, and a fixture cannot hold a stylesheet to its own tokens.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  UNDECIDED_BARE,
  WAIVED_CLASSES,
  classNamesIn,
  definedClassesIn,
  elementsIn,
  evaluateClassNames,
} from './check-classnames.mjs';

const uiSrc = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'packages', 'ui', 'src');
const read = (...parts) => readFileSync(join(uiSrc, ...parts), 'utf8');

const facts = (overrides) => ({
  sources: [],
  stylesheets: [],
  allowlist: [],
  baseline: [],
  ...overrides,
});

/** The class names a result reports as errors, whatever wording carries them. */
const errorNames = (result) =>
  result.errors.flatMap((e) => [...e.matchAll(/"([^"]+)"/g)].map((m) => m[1])).sort();

/** The `path:line "name"` entries the result counted as unbacked, names only. */
const unbackedNames = (result) => result.unbacked.map((u) => /"([^"]+)"/.exec(u)[1]).sort();

const source = (text) => [{ path: 'screen.tsx', text }];
const sheet = (text) => [{ path: 'styles.css', text }];

describe('definedClassesIn', () => {
  it('reads grouped and descendant selectors, and the classes inside them', () => {
    const names = definedClassesIn('.a,\n.b input { color: red; }\n.c .d { color: red; }');

    expect([...names].sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('does NOT count a class named in a COMMENT', () => {
    // The trap this sheet sets for itself: styles.css discusses its own class
    // names in prose ("`.identity-block` and `.identity-row` above are styled"),
    // and a checker that read a comment as a definition would pass the exact
    // defect it exists to catch - a name that is only ever talked about.
    const names = definedClassesIn('/* .talked-about is styled below. */\n.real { color: red; }');

    expect(names.has('talked-about')).toBe(false);
    expect(names.has('real')).toBe(true);
  });

  it('does NOT count a dot inside a declaration body', () => {
    const names = definedClassesIn('.real { content: ".fake"; background: url(x.png); }');

    expect(names.has('fake')).toBe(false);
    expect(names.has('png')).toBe(false);
    expect([...names]).toEqual(['real']);
  });

  it('reads selectors nested inside an at-rule', () => {
    const names = definedClassesIn('@media (min-width: 40em) {\n  .wide { color: red; }\n}');

    expect([...names]).toEqual(['wide']);
  });
});

describe('classNamesIn', () => {
  it('splits a plain string attribute into every class it renders', () => {
    const { statics } = classNamesIn('<p className="panel-desc dcr-progress-line">x</p>');

    expect([...statics.keys()].sort()).toEqual(['dcr-progress-line', 'panel-desc']);
  });

  it('collects BOTH branches of a ternary, because either one can ship', () => {
    const { statics } = classNamesIn(
      '<div className={missing ? "identity-required" : "identity-row-editable"} />',
    );

    expect([...statics.keys()].sort()).toEqual(['identity-required', 'identity-row-editable']);
  });

  it('does NOT treat a comparison operand as a class name', () => {
    // The first run of this check reported 27 findings of exactly this shape -
    // every tab, every status pill - because "patterns" sits in the same
    // expression as the classes. A check whose findings are mostly noise is one
    // people learn to scroll past, which is worse than not having it.
    //
    // Written as a bare ternary, which is the shape architecture-screen.tsx
    // actually uses, and deliberately NOT inside an interpolation: the glue
    // rule below would drop "patterns" for its own unrelated reason, and this
    // assertion would then pass with the comparison rule deleted.
    const { statics } = classNamesIn(
      '<button className={viewMode === "patterns" ? "arch-view-tab arch-view-tab-active" : "arch-view-tab"} />',
    );

    expect(statics.has('patterns')).toBe(false);
    expect([...statics.keys()].sort()).toEqual(['arch-view-tab', 'arch-view-tab-active']);
  });

  it('does NOT treat a comparison operand as a class name inside a template either', () => {
    const { statics, dynamics } = classNamesIn(
      '<button className={`dcr-mode-tab${active === "single" ? " dcr-mode-tab-active" : ""}`} />',
    );

    expect(statics.has('single')).toBe(false);
    expect([...statics.keys()]).toEqual(['dcr-mode-tab-active']);
    expect([...dynamics.keys()]).toEqual(['dcr-mode-tab*']);
  });

  it('reads a suffix spliced into the middle of a name as a FAMILY, not as classes', () => {
    const { statics, dynamics } = classNamesIn(
      '<span className={`status status-${busy ? "running" : "idle"}`} />',
    );

    // "running" and "idle" are the tail of status-running and status-idle. They
    // are not classes, and reporting them as undefined ones was the second
    // largest source of noise in the first run.
    expect(statics.has('running')).toBe(false);
    expect(statics.has('idle')).toBe(false);
    expect([...dynamics.keys()]).toEqual(['status-*']);
    expect([...statics.keys()]).toEqual(['status']);
  });

  it('still reads a SEPARATED modifier inside that same interpolation', () => {
    // The separating space is the author's own signal that this is another
    // class rather than a suffix, and it is where most of this codebase's
    // modifier classes live. Waiving interpolations wholesale would waive them.
    const { statics, dynamics } = classNamesIn(
      '<div className={`identity-block${missing ? " identity-block-missing" : ""}`} />',
    );

    expect([...statics.keys()]).toEqual(['identity-block-missing']);
    // The stem is not a static name: an interpolation is glued to it, so what
    // ships is identity-block plus whatever the branch adds. It is checked as a
    // stem instead, which is a stricter test, not a looser one.
    expect([...dynamics.keys()]).toEqual(['identity-block*']);
  });

  it('files a className that is nothing but an interpolation as opaque, never as a name', () => {
    const { statics, dynamics, opaque } = classNamesIn(
      '<div className={`searchable-select${extra !== undefined ? ` ${extra}` : ""}`} />',
    );

    expect([...opaque.keys()]).toEqual(['*']);
    expect([...dynamics.keys()]).toEqual(['searchable-select*']);
    expect([...statics.keys()]).toEqual([]);
  });

  it('names the line each class is rendered on', () => {
    const { statics } = classNamesIn('one\ntwo\n<p className="pack-card" />\n');

    expect(statics.get('pack-card')).toBe(3);
  });
});

describe('evaluateClassNames - the DBT-39 names, as they actually were', () => {
  const STYLES = sheet('.mapping-review-card { padding: 12px; }\n.mapping-review-card-head { display: flex; }\n.panel-desc { color: grey; }\n.identity-required { display: flex; }\n');

  it('counts every rendered class that no stylesheet defines, WITHOUT calling it a defect', () => {
    // DBT-100 measured what DBT-39 actually was, and it was not what the first
    // version of this check claimed. Every one of these four names sits beside a
    // sibling that IS defined, and e147332 fixed all four by DELETING the dead
    // name - `pack-card mapping-review-card` became `mapping-review-card`,
    // `panel-desc dcr-progress-line` became `panel-desc`. Nothing rendered
    // differently before or after. They were dead attributes, not broken
    // screens, so they are counted here and never gated.
    const result = evaluateClassNames(
      facts({
        stylesheets: STYLES,
        sources: source(
          '<div className="pack-card mapping-review-card">\n' +
            '<div className="pack-card-head mapping-review-card-head" />\n' +
            '<p className="panel-desc dcr-progress-line" />\n' +
            '<div className={missing ? "identity-required" : "identity-row-editable"} />\n' +
            '</div>',
        ),
      }),
    );

    expect(unbackedNames(result)).toEqual([
      'dcr-progress-line',
      'identity-row-editable',
      'pack-card',
      'pack-card-head',
    ]);
    expect(result.errors).toEqual([]);
  });

  it('DOES call it a defect when the element has nothing else on it', () => {
    // The other half of the same fixture, and the distinction the whole of
    // DBT-100 turns on. Drop the defined sibling and the identical name becomes
    // an error, because now nothing on the element carries a rule - which is
    // what .identity-mismatch-block did for two months.
    const result = evaluateClassNames(
      facts({
        stylesheets: STYLES,
        sources: source('<div className="pack-card">\n<p className="dcr-progress-line" />\n</div>'),
      }),
    );

    expect(errorNames(result)).toEqual(['dcr-progress-line', 'pack-card']);
    expect(result.unbacked).toEqual([]);
  });

  it('reads the sibling per ELEMENT, not per file', () => {
    // The hole a file-level answer would leave: `mapping-review-card` is
    // defined and rendered in this file, so a check that pooled the file's
    // names would find a defined class "nearby" and clear the second div. The
    // second div is a different element and has nothing.
    const result = evaluateClassNames(
      facts({
        stylesheets: STYLES,
        sources: source('<div className="pack-card mapping-review-card" />\n<div className="pack-card" />'),
      }),
    );

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('screen.tsx:2');
    expect(unbackedNames(result)).toEqual(['pack-card']);
  });

  it('passes once each name is either deleted or defined', () => {
    const result = evaluateClassNames(
      facts({
        stylesheets: sheet(`${STYLES[0].text}.identity-row-editable { display: flex; }\n`),
        sources: source(
          '<div className="mapping-review-card">\n' +
            '<div className="mapping-review-card-head" />\n' +
            '<p className="panel-desc" />\n' +
            '<div className={missing ? "identity-required" : "identity-row-editable"} />\n' +
            '</div>',
        ),
      }),
    );

    expect(result.errors).toEqual([]);
  });

  it('holds the three REAL files DBT-39 named to zero findings of EITHER severity', () => {
    // The fixtures above prove the RULE; this proves the FIX.
    //
    // Asserting `unbacked` and not just `errors` is the point, and DBT-100 is
    // why: all four DBT-39 names sat beside a defined sibling, so re-adding
    // `pack-card` produces an unbacked count and no error. Pinned on errors
    // alone this would have gone quietly back to where it was on 2026-08-31.
    //
    // Scoped to these three on purpose. Findings of the same kind are open in
    // screens other people own - counted by the run, listed in UNDECIDED_BARE -
    // and swallowing them here would either fail on somebody else's work or,
    // once relaxed, stop asserting anything.
    const result = evaluateClassNames({
      stylesheets: [{ path: 'styles.css', text: read('styles.css') }],
      sources: [
        ['screens', 'dcr-automation', 'dcr-inventory-panel.tsx'],
        ['screens', 'packs', 'pack-inventory-screen.tsx'],
        ['screens', 'mapping-review', 'identity-block.tsx'],
      ].map((parts) => ({ path: parts.join('/'), text: read(...parts) })),
      allowlist: [],
      baseline: [],
    });

    expect(result.errors).toEqual([]);
    expect(result.unbacked).toEqual([]);
  });

  it('says WHERE, so a finding points at somewhere to stand', () => {
    const result = evaluateClassNames(
      facts({
        stylesheets: STYLES,
        sources: [{ path: 'packs/pack-inventory-screen.tsx', text: '\n\n<div className="pack-card" />' }],
      }),
    );

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('packs/pack-inventory-screen.tsx:3');
  });
});

describe('evaluateClassNames - assembled names', () => {
  it('accepts an assembled name whose FAMILY exists in the stylesheet', () => {
    const result = evaluateClassNames(
      facts({
        stylesheets: sheet('.dcr-col-chip { border: 0; }\n.dcr-col-added { border: 0; }\n'),
        sources: source('<span className={`dcr-col-chip dcr-col-${c.status}`} />'),
      }),
    );

    expect(result.errors).toEqual([]);
  });

  it('counts an assembled name whose family is defined NOWHERE', () => {
    // The real finding of this shape: log-type-evidence-${entry.evidence}, with
    // no .log-type-evidence- rule anywhere. Every variant is missing, not one -
    // but the <li> also carries .log-type-recommendation-have, which is defined,
    // so the chip is styled and only its evidence modifier is dead.
    const result = evaluateClassNames(
      facts({
        stylesheets: sheet('.log-type-recommendation-have { color: red; }\n'),
        sources: source('<li className={"log-type-recommendation-have" + ` log-type-evidence-${e.evidence}`} />'),
      }),
    );

    expect(unbackedNames(result)).toEqual(['log-type-evidence-*']);
    expect(result.errors).toEqual([]);
  });

  it('errors on that same missing family when it is ALL the element has', () => {
    const result = evaluateClassNames(
      facts({
        stylesheets: sheet('.log-type-recommendation-have { color: red; }\n'),
        sources: source('<li className={`log-type-evidence-${e.evidence}`} />'),
      }),
    );

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('log-type-evidence-*');
  });

  it('accepts an assembled name whose STEM is itself a class', () => {
    const result = evaluateClassNames(
      facts({
        stylesheets: sheet('.identity-block { display: flex; }\n.identity-block-missing { border: 0; }\n'),
        sources: source('<div className={`identity-block${missing ? " identity-block-missing" : ""}`} />'),
      }),
    );

    expect(result.errors).toEqual([]);
  });

  it('does NOT let a longer name cover for a stem that is missing', () => {
    // The hole this closes was found by writing the test above: if a prefix
    // match satisfied every stem, .identity-block could be deleted and
    // .identity-block-missing would keep the check green - the same silent
    // failure one level up, and the harder one to spot, because the element
    // does still pick up a rule. The trailing hyphen is what separates a stem
    // that is a whole name from one that is only a prefix.
    //
    // Counted rather than errored, and for the reason the element itself gives:
    // .identity-block-missing IS defined, so on the branch where it is applied
    // the div is styled. The stem going missing is still worth saying, which is
    // what the unbacked count is for.
    const result = evaluateClassNames(
      facts({
        stylesheets: sheet('.identity-block-missing { border: 0; }\n'),
        sources: source('<div className={`identity-block${missing ? " identity-block-missing" : ""}`} />'),
      }),
    );

    expect(unbackedNames(result)).toEqual(['identity-block*']);
    expect(result.errors).toEqual([]);
  });
});

describe('evaluateClassNames - an unreadable token is not proof the element is styled', () => {
  // THE HOLE THAT REOPENED THE DEFECT CLASS. A bare interpolation is a name this
  // check never sees, so treating it as backing converts "we cannot check this
  // element" into "this element is fine" - an allowlist entry of `*`, applied at
  // element level, which the header of the script rejects in prose. Every other
  // dead name on the element was demoted with it, from an error to an ungated
  // note.
  //
  // Both directions are pinned, because either one alone is satisfiable by a
  // wrong rule: erroring on everything opaque passes the first and fails the
  // second, and the shipped behaviour passed the second and failed the first.

  it('STILL reports a missing static when the only other token is a pass-through', () => {
    // The shape measured in searchable-select.tsx: `${...}` is the whole of the
    // second token, and all 16 call sites pass nothing, so at runtime the
    // element carries one class and that class is dead.
    const result = evaluateClassNames(
      facts({
        stylesheets: sheet('.real { color: red; }\n'),
        sources: source('<div className={`searchable-select${extra !== undefined ? ` ${extra}` : ""}`} />'),
      }),
    );

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('searchable-select*');
    expect(result.errors[0]).toContain('cannot read');
    expect(result.unknown).toHaveLength(1);
    // NOT demoted to the ungated half. That demotion is the defect.
    expect(result.unbacked).toEqual([]);
  });

  it('does NOT error on an element whose className is ONLY an interpolation', () => {
    // The other direction, and the reason the fix is a third state rather than
    // "opaque never counts". Nothing here is missing - there is no literal name
    // to be dead - so there is nothing to report, and erroring would fail on
    // every pass-through prop in the tree.
    //
    // THE MUTATION THIS PIN ANSWERS TO is `resolve` returning null for an opaque
    // token, which is the obvious over-correction and makes this fail. It does
    // NOT answer to widening the `missing.length === 0` guard: the error text is
    // built from the missing names, so an element with none cannot produce one
    // whatever that guard says. Recorded because a pin whose strength is
    // unstated gets trusted for the wrong reasons - measured 2026-09-04, both
    // mutations run.
    const result = evaluateClassNames(
      facts({
        stylesheets: sheet('.real { color: red; }\n'),
        sources: source('<div className={className} />\n<span className={`${tone}`} />'),
      }),
    );

    expect(result.errors).toEqual([]);
    expect(result.unknown).toEqual([]);
  });

  it('counts element findings apart from the bookkeeping ones', () => {
    // The run summary says "N element(s) render with no rule behind any class",
    // and it used to say that about `errors.length` - which also carries the
    // WAIVED_CLASSES and UNDECIDED_BARE reconciliation failures. A stale baseline
    // entry then sent a reader hunting through the UI for a defect that was in
    // this script's own list. Two errors here, exactly one of them an element.
    const result = evaluateClassNames(
      facts({
        stylesheets: sheet('.real { color: red; }\n'),
        sources: source('<div className="dead-name" />'),
        baseline: [{ path: 'elsewhere.tsx', name: 'gone', tag: 'div', count: 1 }],
      }),
    );

    expect(result.errors).toHaveLength(2);
    expect(result.bareElements).toBe(1);
  });

  it('treats a WAIVED name the same way, because a waiver is also a rule it cannot read', () => {
    // `nodrag` and `nopan` are React Flow BEHAVIOURAL classes that paint
    // nothing, so an element left with one of those and a dead name still
    // renders bare. A waiver says "defined in a stylesheet this check does not
    // load", which is not the same claim as "this element is styled".
    const result = evaluateClassNames(
      facts({
        stylesheets: sheet('.real { color: red; }\n'),
        sources: source('<div className="nodrag arch-flow-ghost" />'),
        allowlist: WAIVED_CLASSES,
      }),
    );

    expect(errorNames(result)).toContain('arch-flow-ghost');
    expect(result.unbacked).toEqual([]);
  });

  it('a REAL sibling still clears the element, so the third state has not swallowed the second', () => {
    // The control. If `backed` had been narrowed to nothing, every element in
    // the tree would error and the three tests above would pass for the wrong
    // reason.
    const result = evaluateClassNames(
      facts({
        stylesheets: sheet('.real { color: red; }\n'),
        sources: source('<div className={`real${extra !== undefined ? ` ${extra}` : ""} dead-name`} />'),
      }),
    );

    expect(result.errors).toEqual([]);
    expect(unbackedNames(result)).toEqual(['dead-name']);
  });
});

describe('elementsIn - the grouping DBT-100 turns on', () => {
  it('keeps each className attribute separate, with its own line', () => {
    const elements = elementsIn('<div className="a b" />\n<div className="c" />');

    expect(elements).toEqual([
      { line: 1, statics: ['a', 'b'], dynamics: [], opaque: [] },
      { line: 2, statics: ['c'], dynamics: [], opaque: [] },
    ]);
  });
});

describe('evaluateClassNames - UNDECIDED_BARE', () => {
  const STYLES = sheet('.real { color: red; }\n');
  const bare = [{ path: 'screen.tsx', text: '<div className="undecided" />' }];

  it('suppresses a recorded element instead of failing on it', () => {
    const result = evaluateClassNames(
      facts({
        stylesheets: STYLES,
        sources: bare,
        baseline: [{ path: 'screen.tsx', name: 'undecided', tag: 'div', count: 1 }],
      }),
    );

    expect(result.errors).toEqual([]);
    expect(result.baselined).toBe(1);
  });

  it('still fails on the SAME name in a file the baseline does not name', () => {
    // A baseline keyed on the name alone would let a fresh copy of the defect
    // ride in on an entry filed for somewhere else.
    const result = evaluateClassNames(
      facts({
        stylesheets: STYLES,
        sources: [{ path: 'other.tsx', text: '<div className="undecided" />' }],
        baseline: [{ path: 'screen.tsx', name: 'undecided', tag: 'div', count: 1 }],
      }),
    );

    expect(result.errors).toHaveLength(2);
    expect(result.errors[0]).toContain('other.tsx:1');
  });

  it('fails on a SECOND bare element of a recorded name in the recorded file', () => {
    // THE HOLE THE COUNT CLOSES, and the one the CI comment claimed was already
    // shut. The entry is keyed on path and name with no line, so without a count
    // it suppressed every element in that file rendering that name - one entry
    // absorbing an unbounded number of findings. Measured on the real tree
    // before the count existed: 14 bare elements passed under 13 entries, so the
    // "fails on the fourteenth" the workflow promised had already happened.
    const result = evaluateClassNames(
      facts({
        stylesheets: STYLES,
        sources: [
          {
            path: 'screen.tsx',
            text: '<div className="undecided" />\n<div className="undecided" />\n<div className="undecided" />',
          },
        ],
        baseline: [{ path: 'screen.tsx', name: 'undecided', tag: 'div', count: 1 }],
      }),
    );

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('records 1 bare element(s) but 3 now render');
    expect(result.errors[0]).toContain('2 of them is NEW');
  });

  it('fails when a recorded count is HIGHER than what is left', () => {
    // The other direction, and not symmetry for its own sake: an entry left
    // larger than the truth is a slot sitting open for the next new element,
    // which is the same absorption one release later.
    const result = evaluateClassNames(
      facts({
        stylesheets: STYLES,
        sources: bare,
        baseline: [{ path: 'screen.tsx', name: 'undecided', tag: 'div', count: 2 }],
      }),
    );

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('records 2 bare element(s) and only 1 remain');
    expect(result.errors[0]).toContain('Lower the count');
  });

  it('fails when a recorded element is FIXED and the entry is left behind', () => {
    // Checked before the suppression case can hide it: a baseline only earns
    // its place by shrinking, and this is the rule that makes it shrink.
    const result = evaluateClassNames(
      facts({
        stylesheets: sheet('.real { color: red; }\n.undecided { display: flex; }\n'),
        sources: bare,
        baseline: [{ path: 'screen.tsx', name: 'undecided', tag: 'div', count: 1 }],
      }),
    );

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('UNDECIDED_BARE entry "undecided"');
    expect(result.errors[0]).toContain('Delete the entry');
  });

  it('records a tag for every entry, because the tag is what makes most doubtful', () => {
    // Four of the thirteen sit on an `a`, a `tr`, a `td` and a `details`, all of
    // which carry user-agent styling or an ancestor rule this check cannot see.
    // An entry with no tag would be a finding nobody can weigh.
    for (const entry of UNDECIDED_BARE) {
      expect(entry.tag, `${entry.name} has no tag`).toMatch(/^[a-z]+$/);
      expect(entry.path).toMatch(/^packages\/ui\/src\/.+\.tsx$/);
    }
  });

  it('records a count on every entry, and the list holds 14 elements in 13 entries', () => {
    // BOTH NUMBERS, because they are not the same number and the CI comment and
    // the file header both said only the smaller one. Thirteen entries, fourteen
    // elements - `gap-overflow-triage` is bare at two lines of one file. An entry
    // with no count would default to nothing and suppress silently, which is the
    // hole this whole field exists to close.
    for (const entry of UNDECIDED_BARE) {
      expect(entry.count, `${entry.name} has no count`).toBeTypeOf('number');
      expect(entry.count, `${entry.name} has a count below 1`).toBeGreaterThanOrEqual(1);
    }

    expect(UNDECIDED_BARE).toHaveLength(13);
    expect(UNDECIDED_BARE.reduce((n, e) => n + e.count, 0)).toBe(14);
    expect(UNDECIDED_BARE.filter((e) => e.count > 1)).toEqual([
      {
        path: 'packages/ui/src/screens/mapping-review/overflow-triage-block.tsx',
        name: 'gap-overflow-triage',
        tag: 'details',
        count: 2,
      },
    ]);
  });
});

describe('evaluateClassNames - the waiver list', () => {
  it("waives a class that belongs to somebody else's stylesheet", () => {
    const result = evaluateClassNames(
      facts({
        stylesheets: sheet('.arch-flow-remove-btn { border: 0; }\n'),
        sources: source('<button className="arch-flow-remove-btn nodrag nopan" />'),
        allowlist: WAIVED_CLASSES,
      }),
    );

    expect(result.errors).toEqual([]);
  });

  it('reports a waiver that no longer matches anything', () => {
    // Checked BEFORE the passing case above would let it hide: a waiver nobody
    // prunes is how this check stops covering what it was added for, and it
    // fails silently in exactly the way the classes themselves do.
    const result = evaluateClassNames(
      facts({
        stylesheets: sheet('.real { color: red; }\n'),
        sources: source('<div className="real" />'),
        allowlist: [{ pattern: 'gone-*', why: 'removed two releases ago.' }],
      }),
    );

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('WAIVED_CLASSES entry "gone-*" matches nothing');
  });

  it('never lets a waiver be written broadly enough to swallow real findings', () => {
    // A bare interpolation is a NOTE, not something an entry of "*" is invited
    // to cover - such an entry would match every finding this check can make.
    const result = evaluateClassNames(
      facts({
        stylesheets: sheet('.searchable-select { display: flex; }\n'),
        sources: source('<div className={`searchable-select${extra ? ` ${extra}` : ""}`} />'),
      }),
    );

    expect(result.errors).toEqual([]);
    expect(result.notes.join(' ')).toContain('bare interpolation');
  });
});

describe('DBT-38 - the add-column control renders with the app tokens', () => {
  // This one reads the REAL files. The defect is that `.field input` and
  // `.field select` are DESCENDANT selectors with no bare input/select base
  // rule, so a control outside a <label className="field"> falls through to raw
  // USER AGENT chrome - the browser's own border, corner radius, form font and
  // focus ring instead of the app's. NOT "a white box": styles.css:129 sets
  // color-scheme: dark, which inherits to native controls, so it renders dark
  // and merely looks subtly wrong (review, 2026-08-31). A fixture cannot pin
  // that: the thing being asserted is that this stylesheet covers this control.
  const styles = read('styles.css');
  const panel = read('screens', 'dcr-automation', 'dcr-inventory-panel.tsx');

  const addColumnRule = /\.dcr-add-column input,\s*\.dcr-add-column select\s*\{([^}]*)\}/.exec(styles);

  it('gives the input AND the select a border, a surface and a text color', () => {
    expect(addColumnRule).not.toBeNull();
    const body = addColumnRule[1];
    expect(body).toMatch(/border:\s*1px solid var\(--border\)/);
    expect(body).toMatch(/background:\s*var\(--surface-raised\)/);
    expect(body).toMatch(/color:\s*var\(--text\)/);
  });

  it('gives them a focus border, which raw browser chrome does not', () => {
    expect(styles).toMatch(
      /\.dcr-add-column input:focus,\s*\.dcr-add-column select:focus\s*\{[^}]*border-color:\s*var\(--border-focus\)/,
    );
  });

  it('applies that container to the row holding the bare input and select', () => {
    // The rule and the markup are two halves of one fix; either alone is the
    // defect. The input is asserted to be BARE on purpose - if it is ever
    // wrapped in a .field label instead, this whole rule should go, not be
    // quietly kept passing by a wrapper it no longer needs.
    const row = /className="panel-controls dcr-add-column">([\s\S]{0,400})/.exec(panel);
    expect(row).not.toBeNull();
    expect(row[1]).toMatch(/<input\b/);
    expect(row[1]).toMatch(/<select\b/);
    expect(row[1]).not.toMatch(/<label[^>]*className="field["\s]/);
  });
});
