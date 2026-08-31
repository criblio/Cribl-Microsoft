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
import { WAIVED_CLASSES, classNamesIn, definedClassesIn, evaluateClassNames } from './check-classnames.mjs';

const uiSrc = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'packages', 'ui', 'src');
const read = (...parts) => readFileSync(join(uiSrc, ...parts), 'utf8');

const facts = (overrides) => ({
  sources: [],
  stylesheets: [],
  allowlist: [],
  ...overrides,
});

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

  it('reports every rendered class that no stylesheet defines', () => {
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

    const named = result.errors.map((e) => /renders class "([^"]+)"/.exec(e)?.[1]).sort();
    expect(named).toEqual(['dcr-progress-line', 'identity-row-editable', 'pack-card', 'pack-card-head']);
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

  it('holds the three REAL files DBT-39 named to zero findings', () => {
    // The fixtures above prove the RULE; this proves the FIX. Without it,
    // putting `pack-card` back would fail nothing - the check that would catch
    // it is deliberately not wired into CI yet, so the pin has to read the
    // files itself.
    //
    // Scoped to these three on purpose. 36 findings of the same kind are open
    // in screens other people own, and swallowing them into this assertion
    // would either fail on somebody else's work or, once relaxed, stop
    // asserting anything.
    const result = evaluateClassNames({
      stylesheets: [{ path: 'styles.css', text: read('styles.css') }],
      sources: [
        ['screens', 'dcr-automation', 'dcr-inventory-panel.tsx'],
        ['screens', 'packs', 'pack-inventory-screen.tsx'],
        ['screens', 'mapping-review', 'identity-block.tsx'],
      ].map((parts) => ({ path: parts.join('/'), text: read(...parts) })),
      allowlist: [],
    });

    expect(result.errors).toEqual([]);
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

  it('reports an assembled name whose family is defined NOWHERE', () => {
    // The real finding of this shape: log-type-evidence-${entry.evidence}, with
    // no .log-type-evidence- rule anywhere. Every variant is missing, not one.
    const result = evaluateClassNames(
      facts({
        stylesheets: sheet('.log-type-recommendation-have { color: red; }\n'),
        sources: source('<li className={"log-type-recommendation-have" + ` log-type-evidence-${e.evidence}`} />'),
      }),
    );

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('log-type-evidence-*');
    expect(result.errors[0]).toContain('The whole family is missing');
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
    const result = evaluateClassNames(
      facts({
        stylesheets: sheet('.identity-block-missing { border: 0; }\n'),
        sources: source('<div className={`identity-block${missing ? " identity-block-missing" : ""}`} />'),
      }),
    );

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('onto the stem "identity-block"');
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
