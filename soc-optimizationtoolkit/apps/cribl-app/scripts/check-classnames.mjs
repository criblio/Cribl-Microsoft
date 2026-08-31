// Every class name the app RENDERS must be a class a stylesheet DEFINES.
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
// WHAT IT CANNOT SEE, said out loud so nobody trusts it further than it goes:
//   - a class name held in a variable (`className={className}`) contributes no
//     literal, so it is neither checked nor reported;
//   - a rule that exists but is overridden, or empty, still counts as defined -
//     this checks EXISTENCE, not effect;
//   - a class defined but never rendered is not an error. Dead CSS is cheap;
//     dead markup is what breaks a screen.
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
 * The class names one source file renders, in three buckets:
 *
 *   statics   written out in full, so they can be checked exactly;
 *   dynamics  a stem plus an interpolation ("dcr-col-*"), checkable as a family;
 *   opaque    the whole value is an interpolation, so there is nothing to check.
 *
 * Each map is name -> the first line that renders it, so a finding points at
 * somewhere to stand rather than at a file.
 *
 * @param {string} text
 * @returns {{statics: Map<string, number>, dynamics: Map<string, number>, opaque: Map<string, number>}}
 */
export function classNamesIn(text) {
  const statics = new Map();
  const dynamics = new Map();
  const opaque = new Map();
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
    const line = lineOf(lines, start);
    for (const token of tokensIn(text.slice(start, end))) {
      const map = token.kind === 'static' ? statics : token.kind === 'dynamic' ? dynamics : opaque;
      if (!map.has(token.name)) map.set(token.name, line);
    }
    attribute.lastIndex = end;
  }
  return { statics, dynamics, opaque };
}

/**
 * @param {{
 *   sources: {path: string, text: string}[],
 *   stylesheets: {path: string, text: string}[],
 *   allowlist?: {pattern: string, why: string}[],
 * }} facts
 * @returns {{errors: string[], notes: string[], rendered: number, defined: number}}
 */
export function evaluateClassNames(facts) {
  const allowlist = facts.allowlist ?? WAIVED_CLASSES;
  const errors = [];
  const notes = [];
  const defined = new Set();
  for (const sheet of facts.stylesheets) {
    for (const name of definedClassesIn(sheet.text)) defined.add(name);
  }

  const used = new Set();
  const rendered = new Set();
  let opaqueCount = 0;

  for (const source of facts.sources) {
    const { statics, dynamics, opaque } = classNamesIn(source.text);
    opaqueCount += opaque.size;

    for (const [name, line] of statics) {
      rendered.add(name);
      if (defined.has(name)) continue;
      const waived = allowlist.find((e) => globMatches(e.pattern, name));
      if (waived !== undefined) {
        used.add(waived.pattern);
        continue;
      }
      errors.push(
        `${source.path}:${line} renders class "${name}", which no stylesheet defines. It renders as a bare element - nothing throws and no test fails, which is why this has to be a check. Either DELETE it (right whenever a sibling class on the same element already does the layout) or DEFINE it.`,
      );
    }

    for (const [pattern, line] of dynamics) {
      rendered.add(pattern);
      const entry = allowlist.find((e) => globMatches(e.pattern, pattern));
      if (entry !== undefined) {
        used.add(entry.pattern);
        continue;
      }
      const stem = pattern.slice(0, pattern.indexOf('*'));

      // THE TRAILING HYPHEN DECIDES WHAT THE STEM IS, and it is the author's
      // own signal, not this script's guess.
      //
      // `dcr-col-${status}` has a stem that is a PREFIX - nobody ever wrote
      // .dcr-col- - so the most that can be asked is that the family exists,
      // and .dcr-col-added answers it.
      //
      // `identity-block${cond ? " ..." : ""}` has a stem that is a WHOLE class,
      // and it must be defined as one. Accepting a prefix match here would let
      // .identity-block be deleted while .identity-block-missing kept the check
      // green - the same silent hole, one level up.
      if (stem.endsWith('-') || stem === '') {
        if (stem !== '' && [...defined].some((name) => name.startsWith(stem))) continue;
        errors.push(
          `${source.path}:${line} assembles class "${pattern}", and no stylesheet defines anything beginning "${stem}". The whole family is missing, not one variant of it. Define the variants, or declare the pattern in WAIVED_CLASSES with the reason it cannot be checked.`,
        );
        continue;
      }

      if (defined.has(stem)) continue;
      errors.push(
        `${source.path}:${line} assembles class "${pattern}" onto the stem "${stem}", which no stylesheet defines. The modifier may well exist; the name it modifies does not, so the element renders with only whatever the modifier carries.`,
      );
    }
  }

  for (const entry of allowlist) {
    if (used.has(entry.pattern)) continue;
    errors.push(
      `WAIVED_CLASSES entry "${entry.pattern}" matches nothing that is rendered any more. Delete it - an allowlist nobody prunes is how this check stops covering what it was added for.`,
    );
  }

  if (opaqueCount > 0) {
    notes.push(
      `${opaqueCount} className(s) are a bare interpolation with no literal text - a prop passed straight through, most often. Nothing here can check those, and saying so is better than an allowlist entry of "*" that would swallow every real finding.`,
    );
  }

  const unrendered = [...defined].filter((n) => !rendered.has(n)).length;
  if (unrendered > 0) {
    notes.push(
      `${unrendered} defined class(es) are never rendered from a whole string literal. NOT an error - many are the variants behind an interpolation, and the rest are dead CSS, which costs a few bytes rather than a broken screen.`,
    );
  }

  return { errors, notes, rendered: rendered.size, defined: defined.size };
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
  const { errors, notes, rendered, defined } = evaluateClassNames(facts);

  for (const note of notes) annotate('notice', note);
  for (const error of errors) annotate('error', error);

  if (errors.length > 0) {
    console.log(
      `\nClass names: ${errors.length} undefined or undeclared across ${facts.sources.length} source file(s).`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `${rendered} rendered class name(s) across ${facts.sources.length} source file(s) all resolve to one of the ${defined} classes the stylesheets define.`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
