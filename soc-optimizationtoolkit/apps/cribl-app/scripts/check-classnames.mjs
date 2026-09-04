// An ELEMENT that renders with no rule behind any of its class names.
//
// WHAT THIS EXISTS TO CATCH (DBT-39, 2026-08-31). A className that matches no
// rule fails SILENTLY: React writes the attribute, the browser finds nothing,
// and the element renders as a bare div. Nothing throws, no test fails, and the
// screen looks merely plain rather than broken - so it ships and stays shipped.
//
// styles.css records two hand sweeps that found exactly this, and the comments
// are still there:
//
//   .identity-mismatch-block       "found by the class sweep ... this block has
//                                  been rendering with no container and no row
//                                  layout"
//   .pipeline-preview-suggestions  "the block shipped in 1.11.5 naming these
//                                  three classes, none of which existed - it has
//                                  been rendering as bare divs since"
//
// Two sweeps, both by hand, both months after the fact. A defect that is only
// ever found by someone re-reading a 6,000-line stylesheet recurs on a schedule,
// so the fix that matters is not the four dead names DBT-39 lists - it is this
// diff, which costs nothing and cannot get bored.
//
// WHAT DBT-100 CORRECTED (2026-09-04), because the first version of this file
// asked a question one CLASS NAME at a time and the answer was mostly wrong.
// It reported 36 findings and asserted of each that "it renders as a bare
// element". Measured against the tree, that sentence was FALSE for 23 of the
// 36 (counted two independent ways on the tree at e147332, which reproduces the
// original 36 exactly: a re-implementation of the sibling test, and this
// script's own buckets - 23 unbacked, 13 errors, none unclassified. An earlier
// draft of this comment said 21, which was not measured): they name an element
// that another class on the SAME element already
// styles - `<div className="panel arch-screen">`, `<p className="match-warning
// match-warning-overflow-loss">` - so nothing rendered bare and there was
// nothing to fix. Worse, its advice ("Either DELETE it") would have broken the
// suite: six of the names are live test selectors, and
// numbered-section.dom.test.tsx asserts className === "numbered-section-body"
// by string equality.
//
// So the question is asked per ELEMENT now. A name with no rule is only a
// DEFECT when nothing else on that element carries one either; when a sibling
// does, it is counted as unbacked and never gated.
//
// THE CALIBRATION THAT EARNS THAT NARROWING is the tree at 864facb^, where the
// .identity-mismatch-block defect is live. Re-measured on 2026-09-04 with the
// code as it now stands, extracted by `git archive` into a scratch directory:
// 38 distinct names resolve to nothing anywhere in those 110 source files, and
// the element-level question reduces that to 17 error elements - which still
// name all three identity-mismatch classes. A narrowing that dropped the defect
// it was calibrated against would be a narrowing that had gone too far, so the
// three names are the assertion and the 17 is only the size of it.
//
// The earlier draft of this header put a second number in that sentence - "from
// 42 to 17". 17 reproduces exactly; 42 does not reproduce at all. Measured on
// the same tree the count is 38 distinct names, or 62 name-occurrences, and
// neither is 42. It was presumably counted by a draft of this script that no
// longer exists. Corrected to what was measured rather than deleted, because a
// number nobody can reproduce is the same failure as a comment nobody can check.
//
// WHAT IT CANNOT SEE, said out loud so nobody trusts it further than it goes:
//   - DESCENDANT AND ELEMENT SELECTORS ARE NOT MODELLED, and this is the big
//     one. `.match-field-table td` (styles.css:2840) styles every cell in that
//     table, so `<td className="mapping-catalog-doc">` is fully styled while
//     this check can see only that the name resolves to nothing. Matching a
//     descendant selector needs the render tree, not the source, so a finding
//     here means "no class on this element resolves", never "this is broken";
//   - a class name held in a variable (`className={className}`) contributes no
//     literal, so it is neither checked nor reported. IT ALSO DOES NOT COUNT AS
//     STYLING THE ELEMENT - see the next paragraph, which is where the first
//     wired version of this check went wrong;
//   - a rule that exists but is overridden, or empty, still counts as defined -
//     this checks EXISTENCE, not effect;
//   - a class defined but never rendered is not an error. Dead CSS is cheap;
//     dead markup is what breaks a screen.
//
// THREE STATES, NOT TWO, and this is the correction made when the gate was
// wired (2026-09-04). An element is BACKED when a rule these stylesheets define
// covers one of its names; it is UNKNOWN when the only thing that resolved was a
// token this script cannot read - a bare interpolation, or a waived name from
// somebody else's sheet - and it is BARE when nothing resolved at all. The first
// wired draft had two states and folded UNKNOWN into BACKED, which converted
// "we cannot check this" into "this element is fine": the element-level version
// of the `*` allowlist entry the opaque note below refuses in so many words.
// MEASURED, in memory, with .searchable-select deleted from a copy of styles.css: the two
// elements in searchable-select.tsx dropped from an error to zero errors and two
// ungated notes, even though all 16 shipped call sites pass no className, so
// that interpolation is the empty string in production and the static name was
// the only class those divs had. UNKNOWN is an ERROR now, worded as what it is.
//
// Which is why UNDECIDED_BARE below exists rather than a green tree: FOURTEEN
// elements survive the narrowing, recorded as THIRTEEN path-plus-name entries
// with a count each. None of them has been shown to be a defect, and they are
// recorded instead of being either fixed blind or failed on. NO CARD OWNS THAT
// DECISION YET - DBT-100's result asks for one; until it exists, this header and
// that list are the whole record, which is the point of writing them here rather
// than in a commit message.
//
// The INVERSE direction - a rule no element produces - is reported as a note
// (the "never rendered" count below) and never gated. DBT-97 tracks the one
// instance anybody has named, `.solution-browser-detail`, and files it under a
// sweep for all orphaned rules rather than a one-off.
//
// HOW IT RUNS, as of 2026-09-04. `npm run check-classnames` from
// soc-optimizationtoolkit, from apps/cribl-app, or with the workspace flag CI
// uses; the CI step is "Check class names" in
// .github/workflows/soc-toolkit-ci.yml. Between 2026-08-31 and that date it was
// invoked by NOTHING - no npm script in either manifest and no CI step - so it
// exited 1 for four days with nobody reading it, which is the whole of DBT-100.
// `soc-optimizationtoolkit/docs/backlog.md` section 8 carries the reasoning;
// this file carries the residue.
//
// The pure half takes facts and returns findings, the way check-docs-drift and
// check-release-drift do, so every rule can be pinned without a filesystem.

import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const appDir = join(__dirname, '..');
const toolkitDir = join(appDir, '..', '..');

/** Stands in for one `${...}` while a template literal is flattened. */
const SENTINEL = '\u0001';

/**
 * The names this check cannot answer for, each with the reason attached to it
 * rather than living in somebody's memory. `*` matches any run of characters.
 *
 * It is deliberately SHORT, and the rules below are the reason: a name whose
 * variants exist (`dcr-col-${status}`, answered by .dcr-col-added) and a name
 * whose stem is itself a class (`identity-block${...}`) need no entry, so this
 * list holds only what is genuinely outside the stylesheets.
 *
 * An entry that matches nothing is an ERROR, not a shrug: an allowlist nobody
 * prunes is how this check would quietly stop covering what it was added for.
 */
export const WAIVED_CLASSES = [
  {
    pattern: 'nodrag',
    why: "React Flow's own behavioural class, defined in @xyflow/react's stylesheet.",
  },
  {
    pattern: 'nopan',
    why: "React Flow's own behavioural class, defined in @xyflow/react's stylesheet.",
  },
];

/**
 * THE ELEMENTS THAT ALREADY RENDER THIS WAY, recorded rather than fixed.
 *
 * Wiring a gate that fails on findings older than itself is how a gate gets
 * bypassed, which is the failure DBT-88 is about - so enabling this blind would
 * have manufactured the problem it exists to catch. FOURTEEN ELEMENTS survive
 * the element-level narrowing above, held as the THIRTEEN path-plus-name
 * entries below, because `gap-overflow-triage` is bare at two separate lines of
 * one file. Both numbers are measured with `baseline: []` against the tree of
 * 2026-09-04, and both are stated because they are not the same number and a
 * reader who has only one of them will draw the wrong conclusion from it.
 * NONE OF THE FOURTEEN HAS BEEN SHOWN TO BE A DEFECT, and none has been shown
 * to be harmless either; deciding them needs the design intent of the screen's
 * owner, which is not a thing this script or DBT-100 can supply, and no card
 * owns it yet.
 *
 * The `tag` on each entry is a MEASURED fact and it is what makes most of these
 * doubtful. An `a`, a `tr`, a `td` and a `details` all carry user-agent styling
 * or an ancestor rule that this check cannot see - `.match-field-table td` at
 * styles.css:2840 styles the `td` below outright - so for those the finding is
 * near-certainly nothing. The `div`s are the ones worth a look, because a div
 * with no rule really does render as nothing, which is what
 * .identity-mismatch-block did for two months.
 *
 * The `count` is what makes an entry a RECORD rather than a licence. Entries
 * carry no line number - a line moves whenever anything above it is edited, and
 * a baseline that churns on unrelated edits is one people delete - so the key is
 * path plus name, and without a count that key would suppress an unbounded
 * number of elements sharing that name in that file. It is held EXACTLY: too
 * high and it is a slot waiting for the next new one, too low and the gate has
 * already fired.
 *
 * An entry that stops matching is an ERROR, exactly as in WAIVED_CLASSES: the
 * whole point of a baseline is that it shrinks, and one nobody prunes is a
 * second silent hole rather than a record.
 */
export const UNDECIDED_BARE = [
  { path: 'packages/ui/src/components/numbered-section.tsx', name: 'numbered-section-body', tag: 'div', count: 1 },
  { path: 'packages/ui/src/frame/app-frame.tsx', name: 'app-frame-route', tag: 'div', count: 1 },
  { path: 'packages/ui/src/onboarding/manual-schema-editor.tsx', name: 'manual-schema-editor', tag: 'div', count: 1 },
  { path: 'packages/ui/src/screens/architecture/architecture-screen.tsx', name: 'arch-card-head', tag: 'div', count: 1 },
  { path: 'packages/ui/src/screens/content-install/content-install-section.tsx', name: 'content-install', tag: 'div', count: 1 },
  { path: 'packages/ui/src/screens/mapping-catalog/mapping-catalog-screen.tsx', name: 'mapping-catalog-doclink', tag: 'a', count: 1 },
  { path: 'packages/ui/src/screens/mapping-catalog/mapping-catalog-screen.tsx', name: 'mapping-row', tag: 'tr', count: 1 },
  { path: 'packages/ui/src/screens/mapping-catalog/mapping-catalog-screen.tsx', name: 'mapping-catalog-doc', tag: 'td', count: 1 },
  // TWO elements, at overflow-triage-block.tsx:61 and :76 - the one entry in
  // this list that holds more than one, and the reason `count` exists at all.
  { path: 'packages/ui/src/screens/mapping-review/overflow-triage-block.tsx', name: 'gap-overflow-triage', tag: 'details', count: 2 },
  { path: 'packages/ui/src/screens/pipeline-preview/pipeline-preview-section.tsx', name: 'pipeline-preview-funcs', tag: 'div', count: 1 },
  { path: 'packages/ui/src/screens/pipeline-preview/pipeline-preview-section.tsx', name: 'pipeline-preview-rules', tag: 'div', count: 1 },
  { path: 'packages/ui/src/screens/samples/capture-panel.tsx', name: 'capture-outcome', tag: 'div', count: 1 },
  { path: 'packages/ui/src/screens/samples/sample-intake-section.tsx', name: 'vendor-name-seam', tag: 'div', count: 1 },
];

/**
 * The classes a stylesheet defines.
 *
 * Only SELECTORS are read - comments are stripped first and declaration bodies
 * are skipped - because these sheets discuss their own class names in prose
 * ("`.identity-block` and `.identity-row` above are styled"), and a checker that
 * counted a comment as a definition would pass the exact defect it exists for.
 *
 * @param {string} css
 * @returns {Set<string>}
 */
export function definedClassesIn(css) {
  const names = new Set();
  const text = css.replace(/\/\*[\s\S]*?\*\//g, ' ');
  const stack = [];
  let prelude = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '{') {
      // An at-rule prelude (@media, @supports) names no classes but does open a
      // block, so it is pushed to keep the nesting honest. Anything opened
      // inside a plain rule is a declaration body, not a selector.
      const insideRule = stack[stack.length - 1] === 'rule';
      const kind = prelude.trim().startsWith('@') ? 'at' : 'rule';
      if (!insideRule && kind === 'rule') {
        for (const hit of prelude.matchAll(/\.(-?[A-Za-z_][A-Za-z0-9_-]*)/g)) names.add(hit[1]);
      }
      stack.push(kind);
      prelude = '';
    } else if (ch === '}') {
      stack.pop();
      prelude = '';
    } else {
      prelude += ch;
    }
  }
  return names;
}

/**
 * One entry per `className` attribute - per ELEMENT - holding every class name
 * that element renders, in three buckets:
 *
 *   statics   written out in full, so they can be checked exactly;
 *   dynamics  a stem plus an interpolation ("dcr-col-*"), checkable as a family;
 *   opaque    the whole value is an interpolation, so there is nothing to check.
 *
 * THE GROUPING IS THE POINT, and it is what the first version of this check got
 * wrong. "Does this NAME resolve?" and "is this ELEMENT styled?" are different
 * questions, and only the second one is a defect. A name has to be read next to
 * whatever else sits on the same element before it can be called anything.
 *
 * @param {string} text
 * @returns {{line: number, statics: string[], dynamics: string[], opaque: string[]}[]}
 */
export function elementsIn(text) {
  const elements = [];
  const lines = lineIndex(text);
  const attribute = /className\s*=\s*/g;
  let hit;
  while ((hit = attribute.exec(text)) !== null) {
    const start = hit.index + hit[0].length;
    const ch = text[start];
    let end;
    if (ch === '"' || ch === "'") end = readString(text, start);
    else if (ch === '{') end = readBraced(text, start);
    else continue;
    const element = { line: lineOf(lines, start), statics: [], dynamics: [], opaque: [] };
    for (const token of tokensIn(text.slice(start, end))) {
      const bucket =
        token.kind === 'static'
          ? element.statics
          : token.kind === 'dynamic'
            ? element.dynamics
            : element.opaque;
      if (!bucket.includes(token.name)) bucket.push(token.name);
    }
    elements.push(element);
    attribute.lastIndex = end;
  }
  return elements;
}

/**
 * The class names one source file renders, flattened across every element to
 * name -> the first line that renders it.
 *
 * @param {string} text
 * @returns {{statics: Map<string, number>, dynamics: Map<string, number>, opaque: Map<string, number>}}
 */
export function classNamesIn(text) {
  const statics = new Map();
  const dynamics = new Map();
  const opaque = new Map();
  for (const element of elementsIn(text)) {
    for (const [bucket, map] of [
      [element.statics, statics],
      [element.dynamics, dynamics],
      [element.opaque, opaque],
    ]) {
      for (const name of bucket) if (!map.has(name)) map.set(name, element.line);
    }
  }
  return { statics, dynamics, opaque };
}

/**
 * The `how` values that mean "THIS CHECK COULD NOT LOOK" rather than "a rule
 * exists". The distinction is the whole of the UNKNOWN branch below, and
 * collapsing it is how the first wiring of this gate went silent: an opaque
 * token is a name this script never saw, so counting it as backing turns "we
 * cannot check this element" into "this element is fine" - an allowlist entry
 * of `*` at element level, which the header of this file rejects in prose.
 *
 * `waived` sits here for the same reason and not as a hedge: a waiver says a
 * rule lives in a stylesheet this check does not read, and `nodrag`/`nopan` are
 * React Flow BEHAVIOURAL classes that paint nothing at all. An element whose
 * only surviving class is one of those still renders bare.
 */
const CANNOT_CHECK = new Set(['opaque', 'waived']);

/**
 * Whether one rendered name is backed by a rule, and if not, why the answer is
 * worth saying out loud. `null` means "carries no rule".
 *
 * @returns {{how: string} | null}
 */
function resolve(name, kind, defined, allowlist, used) {
  const entry = allowlist.find((e) => globMatches(e.pattern, name));
  if (entry !== undefined) {
    used.add(entry.pattern);
    return { how: 'waived' };
  }
  if (kind === 'opaque') return { how: 'opaque' };
  if (kind === 'static') return defined.has(name) ? { how: 'defined' } : null;

  const stem = name.slice(0, name.indexOf('*'));

  // THE TRAILING HYPHEN DECIDES WHAT THE STEM IS, and it is the author's own
  // signal, not this script's guess.
  //
  // `dcr-col-${status}` has a stem that is a PREFIX - nobody ever wrote
  // .dcr-col- - so the most that can be asked is that the family exists, and
  // .dcr-col-added answers it.
  //
  // `identity-block${cond ? " ..." : ""}` has a stem that is a WHOLE class, and
  // it must be defined as one. Accepting a prefix match here would let
  // .identity-block be deleted while .identity-block-missing kept the check
  // green - the same silent hole, one level up.
  if (stem === '') return { how: 'opaque' };
  if (stem.endsWith('-')) {
    return [...defined].some((n) => n.startsWith(stem)) ? { how: 'family' } : null;
  }
  return defined.has(stem) ? { how: 'defined' } : null;
}

/**
 * @param {{
 *   sources: {path: string, text: string}[],
 *   stylesheets: {path: string, text: string}[],
 *   allowlist?: {pattern: string, why: string}[],
 *   baseline?: {path: string, name: string, tag: string, count: number}[],
 * }} facts
 * @returns {{errors: string[], notes: string[], unbacked: string[], unknown: string[], baselined: number, rendered: number, defined: number}}
 */
export function evaluateClassNames(facts) {
  const allowlist = facts.allowlist ?? WAIVED_CLASSES;
  const baseline = facts.baseline ?? UNDECIDED_BARE;
  // path|name -> how many bare ELEMENTS in that file rendered that name. A count
  // and not a flag: the entry is keyed on path and name, so one entry would
  // otherwise absorb an unbounded number of elements sharing that name in that
  // file - see the reconciliation below.
  const seen = new Map();
  const errors = [];
  const notes = [];
  const unbacked = [];
  const unknown = [];
  const defined = new Set();
  for (const sheet of facts.stylesheets) {
    for (const name of definedClassesIn(sheet.text)) defined.add(name);
  }

  const used = new Set();
  const rendered = new Set();
  let opaqueCount = 0;
  // Counted apart from `errors.length`, because the two are not the same number
  // and the run summary used to say they were: `errors` also carries the
  // WAIVED_CLASSES and UNDECIDED_BARE reconciliation failures, which are
  // bookkeeping about this file rather than elements in the tree. Reporting
  // "1 element(s) render with no rule" for a stale baseline entry sends a reader
  // hunting through the UI for a defect that is in this script's own list.
  let bareElements = 0;

  for (const source of facts.sources) {
    for (const element of elementsIn(source.text)) {
      opaqueCount += element.opaque.length;
      const where = `${source.path}:${element.line}`;
      const missing = [];
      // THREE STATES, NOT TWO. `backed` is a rule this check actually read;
      // `uncheckable` is a token it could not read at all. Only the first is
      // evidence the element is styled.
      let backed = false;
      let uncheckable = false;

      for (const [bucket, kind] of [
        [element.statics, 'static'],
        [element.dynamics, 'dynamic'],
        [element.opaque, 'opaque'],
      ]) {
        for (const name of bucket) {
          if (kind !== 'opaque') rendered.add(name);
          const outcome = resolve(name, kind, defined, allowlist, used);
          if (outcome === null) missing.push(name);
          else if (CANNOT_CHECK.has(outcome.how)) uncheckable = true;
          else backed = true;
        }
      }

      // Nothing missing, so there is nothing to report - INCLUDING the element
      // whose className is only ever an interpolation. That one is unknowable
      // rather than wrong, and turning it into an error would fail on every
      // pass-through prop in the tree.
      if (missing.length === 0) continue;

      // NO RULE THIS CHECK CAN READ COVERS THIS ELEMENT - the BARE and UNKNOWN
      // states, which differ only in whether an unreadable token is also
      // present. BARE is the shape both hand sweeps found - styles.css records
      // them: .identity-mismatch-block "has been rendering with no container and
      // no row layout", .pipeline-preview-suggestions "as bare divs since".
      //
      // Stated as "no class resolves" and never as "this is broken", because an
      // ancestor selector this check cannot see may be styling it anyway - see
      // the header on `.match-field-table td`.
      if (!backed) {
        const fresh = missing.filter((name) => {
          const entry = baseline.find((b) => b.path === source.path && b.name === name);
          if (entry === undefined) return true;
          const key = `${entry.path}|${entry.name}`;
          seen.set(key, (seen.get(key) ?? 0) + 1);
          return false;
        });
        if (fresh.length === 0) continue;
        const names = fresh.map((n) => `"${n}"`).join(' and ');
        // The UNKNOWN half, reported as its own thing rather than folded into
        // either neighbour. Something on this element resolved, but only to a
        // token this check cannot read - a bare interpolation, or a waived name
        // from a stylesheet it does not load. So the static names beside it are
        // dead and NOTHING KNOWN IS STYLING THIS ELEMENT; whether the
        // interpolation supplies a real class at runtime is a question about
        // every call site, which is a thing to go and look at rather than a
        // thing to assume. Gated, because assuming it is fine is exactly the
        // silence this file exists to break.
        errors.push(
          uncheckable
            ? `${where} renders ${names}, which no stylesheet defines, and the ONLY other thing on the element is a class name this check cannot read - a bare interpolation, or a waived name from a stylesheet it does not load. So nothing KNOWN styles this element. Whether it renders bare depends on what every call site passes in, which is a thing to go and check. Define the missing name, delete it, or record the element in UNDECIDED_BARE with what you found.`
            : `${where} renders ${names} and NOTHING ELSE, and no stylesheet defines any of it. No class on this element resolves to a rule, so unless an ancestor selector covers it, it renders unstyled - nothing throws and no test fails, which is why this has to be a check. Define it, or delete the attribute if the element genuinely needs no styling.`,
        );
        bareElements += 1;
        if (uncheckable) unknown.push(`${where} ${names}`);
        continue;
      }

      // The element IS styled by something else on it, so nothing is visibly
      // broken and this is NOT an error. Reported, never gated: see the header.
      for (const name of missing) unbacked.push(`${where} "${name}"`);
    }
  }

  for (const entry of allowlist) {
    if (used.has(entry.pattern)) continue;
    errors.push(
      `WAIVED_CLASSES entry "${entry.pattern}" matches nothing that is rendered any more. Delete it - an allowlist nobody prunes is how this check stops covering what it was added for.`,
    );
  }

  // THE COUNT IS THE GATE, and without it this loop was a hole rather than a
  // record: keyed on path and name with no line and no count, ONE entry absorbed
  // any number of elements rendering that name in that file. `gap-overflow-triage`
  // is bare at two lines of overflow-triage-block.tsx and the first version of
  // this baseline held it as a single entry, so a third and a fourth copy would
  // have passed in silence - the fourteenth finding sliding in under the
  // thirteenth's entry, which is precisely the accumulation this gate is for.
  for (const entry of baseline) {
    const found = seen.get(`${entry.path}|${entry.name}`) ?? 0;
    if (found === entry.count) continue;
    if (found === 0) {
      errors.push(
        `UNDECIDED_BARE entry "${entry.name}" in ${entry.path} no longer names an element with nothing on it - it was defined, deleted, or given a styled sibling. Delete the entry. A baseline only earns its place by shrinking, and one nobody prunes is a second silent hole rather than a record.`,
      );
    } else if (found < entry.count) {
      errors.push(
        `UNDECIDED_BARE entry "${entry.name}" in ${entry.path} records ${entry.count} bare element(s) and only ${found} remain. Lower the count. An entry that stays larger than the truth is an entry that will absorb the next new one.`,
      );
    } else {
      errors.push(
        `UNDECIDED_BARE entry "${entry.name}" in ${entry.path} records ${entry.count} bare element(s) but ${found} now render that name with nothing else on them. ${found - entry.count} of them is NEW and is the thing this check exists to catch. Fix it, or raise the count and say on the card why another one was accepted.`,
      );
    }
  }

  if (opaqueCount > 0) {
    notes.push(
      `${opaqueCount} className(s) are a bare interpolation with no literal text - a prop passed straight through, most often. Nothing here can check those, and saying so is better than an allowlist entry of "*" that would swallow every real finding. One on an element does NOT make that element count as styled: an element left with nothing but an interpolation and a dead name is an error above, not a shrug.`,
    );
  }

  if (unbacked.length > 0) {
    notes.push(
      `${unbacked.length} class name(s) resolve to no rule but sit on an element another class DEFINED IN THESE STYLESHEETS already styles, so nothing renders bare. NOT gated - see DBT-100 in the header for why this half is counted rather than failed on.`,
    );
  }

  const unrendered = [...defined].filter((n) => !rendered.has(n)).length;
  if (unrendered > 0) {
    notes.push(
      `${unrendered} defined class(es) are never rendered from a whole string literal. NOT an error - many are the variants behind an interpolation, and the rest are dead CSS, which costs a few bytes rather than a broken screen.`,
    );
  }

  // `baselined` counts ELEMENTS, not entries. The two differ - 14 elements are
  // held by 13 entries - and reporting entries would restate the length of a
  // list rather than the size of the residue.
  let baselined = 0;
  for (const count of seen.values()) baselined += count;

  return {
    errors,
    notes,
    unbacked,
    unknown,
    bareElements,
    baselined,
    rendered: rendered.size,
    defined: defined.size,
  };
}

/** Only `*` is special, and it stands for any run of characters. */
function globMatches(pattern, name) {
  const literals = pattern.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${literals.join('.*')}$`).test(name);
}

/**
 * A string literal that is being COMPARED rather than rendered.
 *
 * `className={active === "single" ? "tab tab-active" : "tab"}` contains three
 * literals and only two of them are classes. Without this rule the first run of
 * this check reported 27 findings of that shape - every tab, every status pill -
 * and a check whose findings are mostly noise is one people learn to scroll
 * past, which is worse than not having it.
 */
const COMPARED_BEFORE = /(?:[=!<>]=|[<>]|\b(?:includes|startsWith|endsWith|indexOf|localeCompare|case)\s*\(?)\s*$/;
const COMPARED_AFTER = /^\s*(?:[=!]==?|[<>]=?)/;

/**
 * Every class-name token in one className expression, quotes included.
 *
 * `glue` says whether this expression was spliced into the MIDDLE of a token
 * ("status-${...}") rather than standing in a slot of its own. It changes what
 * a literal means: inside a glued interpolation, "running" is the tail of
 * status-running, not a class - but " identity-block-missing", written with the
 * separating space the author had to type, is one.
 */
function* tokensIn(expr, glue = { left: false, right: false }) {
  for (let i = 0; i < expr.length; i += 1) {
    const ch = expr[i];
    if (ch === '"' || ch === "'") {
      const end = readString(expr, i);
      if (!COMPARED_BEFORE.test(expr.slice(0, i)) && !COMPARED_AFTER.test(expr.slice(end))) {
        for (const token of standaloneTokens(expr.slice(i + 1, end - 1), glue)) {
          yield { name: token, kind: 'static' };
        }
      }
      i = end - 1;
    } else if (ch === '`') {
      const { end, flat, inners } = scanTemplate(expr, i);
      for (const token of flat.split(/\s+/)) {
        if (token === '') continue;
        if (!token.includes(SENTINEL)) {
          yield { name: token, kind: 'static' };
        } else if (token.split(SENTINEL).join('') === '') {
          // Nothing but interpolation: a value passed straight through, with no
          // stem to check and no family to look for.
          yield { name: token.split(SENTINEL).join('*'), kind: 'opaque' };
        } else {
          yield { name: token.split(SENTINEL).join('*'), kind: 'dynamic' };
        }
      }
      // The branches inside an interpolation are ordinary literals and are
      // checked like any other - `${cond ? " x-active" : ""}` is where most of
      // this codebase's modifier classes live. Waiving them would waive them.
      for (const inner of inners) yield* tokensIn(inner.expr, inner.glue);
      i = end - 1;
    } else if (ch === '/' && (expr[i + 1] === '/' || expr[i + 1] === '*')) {
      i = skipComment(expr, i) - 1;
    }
  }
}

/**
 * The whitespace-separated tokens of one literal that are class names in their
 * own right. A token touching a glued edge is a fragment of the surrounding
 * name, not a name.
 */
function standaloneTokens(literal, glue) {
  const tokens = literal.split(/\s+/);
  if (glue.left && !/^\s/.test(literal)) tokens.shift();
  if (glue.right && !/\s$/.test(literal)) tokens.pop();
  return tokens.filter((t) => t !== '');
}

/** Index just past the string literal starting at `i` (text[i] is the quote). */
function readString(text, i) {
  const quote = text[i];
  for (let j = i + 1; j < text.length; j += 1) {
    if (text[j] === '\\') {
      j += 1;
      continue;
    }
    if (text[j] === quote) return j + 1;
  }
  return text.length;
}

/**
 * Index just past the `{...}` starting at `i`. Strings, templates and comments
 * are skipped whole, so a brace inside one of them cannot unbalance the count.
 */
function readBraced(text, i) {
  let depth = 0;
  for (let j = i; j < text.length; j += 1) {
    const ch = text[j];
    if (ch === '"' || ch === "'") j = readString(text, j) - 1;
    else if (ch === '`') j = scanTemplate(text, j).end - 1;
    else if (ch === '/' && (text[j + 1] === '/' || text[j + 1] === '*')) j = skipComment(text, j) - 1;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return j + 1;
    }
  }
  return text.length;
}

/**
 * A template literal flattened to its literal text, with each `${...}` replaced
 * by a sentinel and its expression handed back for its own scan - each one
 * carrying whether it was spliced into the middle of a token or stands alone.
 */
function scanTemplate(text, i) {
  let flat = '';
  const inners = [];
  const at = [];
  let end = text.length;
  for (let j = i + 1; j < text.length; j += 1) {
    const ch = text[j];
    if (ch === '\\') {
      flat += text[j + 1] ?? '';
      j += 1;
    } else if (ch === '`') {
      end = j + 1;
      break;
    } else if (ch === '$' && text[j + 1] === '{') {
      const close = readBraced(text, j + 1);
      inners.push({ expr: text.slice(j + 2, close - 1), glue: { left: false, right: false } });
      at.push(flat.length);
      flat += SENTINEL;
      j = close - 1;
    } else {
      flat += ch;
    }
  }
  // Resolved only once the whole template is known: what FOLLOWS an
  // interpolation cannot be read until it has been read.
  for (let k = 0; k < at.length; k += 1) {
    const p = at[k];
    inners[k].glue = {
      left: p > 0 && !/\s/.test(flat[p - 1]),
      right: p + 1 < flat.length && !/\s/.test(flat[p + 1]),
    };
  }
  return { end, flat, inners };
}

/** Index just past the comment starting at `i`. */
function skipComment(text, i) {
  if (text[i + 1] === '/') {
    const nl = text.indexOf('\n', i);
    return nl === -1 ? text.length : nl;
  }
  const close = text.indexOf('*/', i + 2);
  return close === -1 ? text.length : close + 2;
}

/** Offsets of every line start, so a finding can name a line without rescanning. */
function lineIndex(text) {
  const offsets = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') offsets.push(i + 1);
  }
  return offsets;
}

function lineOf(offsets, index) {
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (offsets[mid] <= index) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

/**
 * Shipped markup only. Test files render invented class names on purpose - a
 * fixture asserting on `.whatever` is not a defect - and counting them would
 * force every test to style its scaffolding.
 */
function isSource(name) {
  return (name.endsWith('.tsx') || name.endsWith('.ts')) && !name.includes('.test.');
}

async function listFiles(dir, keep, acc = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await listFiles(full, keep, acc);
    else if (keep(entry.name)) acc.push(full);
  }
  return acc;
}

async function gatherFacts() {
  const read = async (path) => ({
    path: relative(toolkitDir, path).split(sep).join(posix.sep),
    text: await readFile(path, 'utf8'),
  });

  // Both sheets are loaded globally by apps/cribl-app/src/main.tsx, so a class
  // defined in either is defined for every screen.
  const stylesheets = await Promise.all(
    [
      join(toolkitDir, 'packages', 'ui', 'src', 'styles.css'),
      join(appDir, 'src', 'App.css'),
    ].map(read),
  );

  const files = [
    ...(await listFiles(join(toolkitDir, 'packages', 'ui', 'src'), isSource)),
    ...(await listFiles(join(appDir, 'src'), isSource)),
  ];

  return { sources: await Promise.all(files.map(read)), stylesheets };
}

function annotate(level, message) {
  const prefix = process.env.GITHUB_ACTIONS === 'true' ? `::${level}::` : `${level}: `;
  console.log(`${prefix}${message}`);
}

async function main() {
  const facts = await gatherFacts();
  const { errors, notes, unbacked, bareElements, baselined, rendered, defined } = evaluateClassNames(facts);
  const entries = UNDECIDED_BARE.length;

  for (const note of notes) annotate('notice', note);
  for (const error of errors) annotate('error', error);

  if (errors.length > 0) {
    const bookkeeping = errors.length - bareElements;
    const parts = [];
    if (bareElements > 0) {
      parts.push(
        `${bareElements} element(s) render with no rule behind any class, across ${facts.sources.length} source file(s)`,
      );
    }
    if (bookkeeping > 0) {
      parts.push(
        `${bookkeeping} WAIVED_CLASSES/UNDECIDED_BARE entry(ies) no longer describe the tree - that is a list in this script to correct, not a screen`,
      );
    }
    console.log(`\nClass names: ${parts.join('; ')}.`);
    process.exitCode = 1;
    return;
  }

  // PASSING IS NOT THE SAME AS CLEAN, and this line says so every run. The
  // counts are the whole state of DBT-100: what is recorded and undecided, and
  // what is known-unbacked but provably not rendering bare. Elements AND entries
  // are both named because they are different numbers - one entry can hold
  // several elements - and a line quoting only one of them would let a reader
  // believe the residue is smaller than it is.
  console.log(
    `${rendered} rendered class name(s) across ${facts.sources.length} source file(s) checked against the ${defined} classes the stylesheets define.\n` +
      `No element renders with nothing on it, EXCEPT the ${baselined} recorded in UNDECIDED_BARE's ${entries} entries - undecided, NOT cleared. Each entry holds an exact count, so a further one under a recorded name fails this check rather than joining the record.\n` +
      `${unbacked.length} further name(s) resolve to no rule but sit beside a class that does, so nothing renders bare; these are counted, never gated.`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
