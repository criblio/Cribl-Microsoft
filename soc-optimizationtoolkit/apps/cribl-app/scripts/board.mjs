// The board's data plane: validate docs/board.json, and RENDER docs/board.md
// from it so the two cannot disagree.
//
// WHY THIS EXISTS. board.md was prose. It read well and groomed badly: there was
// no reliable way to ask what is in progress, what is blocked on what, or which
// decision is holding up which story, without a person reading paragraphs. The
// structure check that already existed could only see shallow things - duplicate
// ids, an undeclared epic - because everything else was sentences.
//
// So the JSON is now the source and the markdown is a build artifact. Grooming
// is editing one file and reading the diff; the board people read is generated,
// which is what stops the two drifting the way board.md and backlog.md would
// have if the board had been allowed to accumulate detail.
//
// JSON RATHER THAN YAML, deliberately. YAML would be nicer to hand-edit, and
// every YAML parser is a dependency. @soc/core carries zero runtime deps and
// every PR is dependency-scanned; a docs tool is a poor reason to be the first
// to add one. Node parses JSON natively, so this costs nothing and the file is
// still editable by hand. The cost is real and lands on multi-line prose: detail
// is one string, and the renderer wraps it.
//
// The pure half takes data and returns findings or markdown; main() does the IO.

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const docsDir = join(__dirname, '..', '..', '..', 'docs');

/** Progress, which is what a Kanban column shows. */
export const STATUSES = ['backlog', 'in-progress', 'done'];
/** Sequencing WITHIN the backlog - orthogonal to progress, not a substitute. */
export const PRIORITIES = ['now', 'next', 'later'];
/**
 * Work-item types, aligned to SAFe (Essential level) since 2026-08-28.
 *
 *   story     changes what an operator sees or does
 *   enabler   infrastructure, architecture, tooling, docs, release mechanics -
 *             SAFe's Enabler, and what `chore` used to mean here
 *   spike     SAFe's EXPLORATION enabler: answered by investigation, never by
 *             preference. Timeboxed, and demonstrated like any story
 *   bug       a defect. SAFe has no distinct place for these in the hierarchy;
 *             teams carry them in the team backlog beside stories, as here
 *   decision  a LOCAL extension, not SAFe: a question that gates work and is
 *             answered by a person rather than by investigation. Attached to
 *             the feature it blocks
 */
const TYPES = ['story', 'enabler', 'spike', 'bug', 'decision'];

/** SAFe scores each WSJF input on a modified Fibonacci scale. */
const WSJF_SCALE = [1, 2, 3, 5, 8, 13, 20];

/** Business epics deliver value; enabler epics exist to unblock other epics. */
const EPIC_KINDS = ['business', 'enabler'];

/**
 * WSJF = (Business Value + Time Criticality + Risk Reduction / Opportunity
 * Enablement) / Job Size. Highest first. Returns null when unscored, so an
 * unscored feature sorts as unknown rather than as zero - a feature nobody has
 * sized must not silently rank last.
 *
 * @param {{bv:number,tc:number,rr:number,size:number}|null|undefined} wsjf
 * @returns {number|null}
 */
export function wsjfScore(wsjf) {
  if (wsjf === null || wsjf === undefined) return null;
  const { bv, tc, rr, size } = wsjf;
  if (![bv, tc, rr, size].every((n) => typeof n === 'number' && n > 0)) return null;
  return (bv + tc + rr) / size;
}
const SETTLED = ['settled', 'undecided', 'unconfirmed'];

/**
 * HOW a finished story was confirmed - the evidence axis, and the counterpart
 * to `settled`, which is about decision-confidence. The two are not
 * interchangeable: a story can be perfectly settled and never verified.
 *
 *   pins  automated tests, and only those
 *   live  driven against the real product or environment, and only that
 *   both  pins AND a live run
 *   none  neither - legitimate for docs and process work, and the value you
 *         are meant to notice on anything else
 *
 * WHAT THIS FIELD CAN AND CANNOT DO. Required on `done` so nobody can quietly
 * finish a story without saying how they know. Its truth is NOT checkable -
 * nothing stops someone typing `both` - so it is a claim, and this repo's own
 * history says hand-maintained claims rot. It is worth having anyway because
 * the failure it prevents is the one that keeps recurring: GEN-1 closed on a
 * live check and GEN-2 on pins plus a five-pack measurement, and the board
 * rendered them identically. The evidence itself still lives in `backlog.md`
 * and in the pins; this only forces the question to be answered.
 */
export const VERIFIED = ['pins', 'live', 'both', 'none'];

/**
 * An open question the board can ASK, with the alternatives spelled out, so it
 * can be answered on the card instead of in a message that then has to be
 * transcribed back here.
 *
 *   { question, options: [{ key, label, detail }], chosen: null | key }
 *
 * ANSWERING IS NOT DECIDING. Picking an option records `chosen` and nothing
 * else: `settled` stays where it was. The reasoning still has to land in
 * `backlog.md` before a card is settled, because a decision without its
 * rejected alternatives is the thing this repo keeps having to reconstruct.
 * The click is a signal, not a verdict - which is also why a settled story
 * carrying an unanswered decision is a contradiction the validator reports.
 */
function decisionFindings(story) {
  const d = story.decision;
  if (d === undefined) return [];
  const out = [];
  const id = story.id;
  if (typeof d !== 'object' || d === null || Array.isArray(d)) {
    return [`${id} has a decision that is not an object.`];
  }
  if (typeof d.question !== 'string' || d.question.trim() === '') {
    out.push(`${id} has a decision with no question.`);
  }
  const options = Array.isArray(d.options) ? d.options : [];
  if (options.length < 2) {
    // One option is not a decision, it is a plan.
    out.push(`${id} has a decision with fewer than two options.`);
  }
  const keys = new Set();
  for (const o of options) {
    if (typeof o?.key !== 'string' || o.key.trim() === '') {
      out.push(`${id} has a decision option with no key.`);
      continue;
    }
    if (typeof o?.label !== 'string' || o.label.trim() === '') {
      out.push(`${id} decision option "${o.key}" has no label.`);
    }
    if (keys.has(o.key)) {
      out.push(`${id} decision option key "${o.key}" appears twice.`);
    }
    keys.add(o.key);
  }
  if (d.chosen !== null && d.chosen !== undefined && !keys.has(d.chosen)) {
    out.push(`${id} decision chose "${d.chosen}", which is not one of its options.`);
  }
  if (story.settled === 'settled' && (d.chosen === null || d.chosen === undefined)) {
    out.push(
      `${id} is settled but its decision is still unanswered. One of the two is wrong.`,
    );
  }
  return out;
}

/**
 * Record an answer against a story's decision. PURE: returns new data, never
 * touches the argument, so the caller can validate the result before writing
 * it anywhere.
 *
 * `settled` is deliberately untouched - see the note above.
 *
 * @param {{epics: any[], stories: any[]}} data
 * @param {string} storyId
 * @param {string | null} optionKey null clears the answer
 * @returns {{ok: true, data: any} | {ok: false, error: string}}
 */
export function applyDecision(data, storyId, optionKey) {
  const story = (data.stories ?? []).find((s) => s.id === storyId);
  if (story === undefined) {
    return { ok: false, error: `No story "${storyId}" on this board.` };
  }
  if (story.decision === undefined) {
    return { ok: false, error: `${storyId} has no decision to answer.` };
  }
  const keys = (story.decision.options ?? []).map((o) => o?.key);
  if (optionKey !== null && !keys.includes(optionKey)) {
    return {
      ok: false,
      error: `"${optionKey}" is not one of ${storyId}'s options (${keys.join(', ')}).`,
    };
  }
  return {
    ok: true,
    data: {
      ...data,
      stories: data.stories.map((s) =>
        s.id === storyId ? { ...s, decision: { ...s.decision, chosen: optionKey } } : s,
      ),
    },
  };
}

/**
 * Every rule the board must satisfy. Ordering rules are the point: prose could
 * say "CAP blocks three epics" and nothing checked it, so it stayed a sentence a
 * reader had to notice.
 *
 * @param {{epics: any[], stories: any[]}} data
 * @returns {string[]} findings, empty when the board is sound
 */
/**
 * Every `## 5.` / `### 6g.` section id in a backlog.md's text.
 *
 * @param {string} text
 * @returns {Set<string>}
 */
export function backlogSectionIds(text) {
  const ids = new Set();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = /^#{2,3}\s+(\d+[a-z]?)\.\s+\S/.exec(line);
    if (m) ids.add(m[1]);
  }
  return ids;
}

/**
 * Citations from a card into backlog.md.
 *
 * WHY ANCHORS AND NOT LINE NUMBERS. Cards used to cite `backlog.md:113-116`.
 * Nothing checked them, and on 2026-08-28 a count found 7 of 39 landing on
 * blank lines and several pointing at the wrong topic entirely - AZR-10
 * ("Dataflow diagrams") had drifted into "Agent-based - AMA plus DCR" - because
 * backlog.md grows by insertion and every number below the insertion moves.
 * A pointer that is silently wrong is worse than no pointer: it sends a reader
 * to confidently read the wrong section.
 *
 * Section ids do not move when text is inserted above them, and their existence
 * IS checkable, which is the whole difference.
 *
 * The section list is injected rather than read here so this stays pure; main()
 * supplies it. Without it the anchors are not resolved - the format rule below
 * still applies.
 */
function citationFindings(story, sections) {
  const out = [];
  const detail = story.detail ?? '';
  for (const m of detail.matchAll(/backlog\.md:(\d+)(?:-\d+)?/g)) {
    out.push(
      `${story.id} cites backlog.md:${m[1]} by LINE NUMBER. Line numbers move whenever text is inserted above them; cite a section instead, e.g. backlog.md#6g.`,
    );
  }
  if (sections === undefined) return out;
  for (const m of detail.matchAll(/backlog\.md#(\d+[a-z]?)\b/g)) {
    if (!sections.has(m[1])) {
      out.push(`${story.id} cites backlog.md#${m[1]}, which is not a section in backlog.md.`);
    }
  }
  return out;
}

/**
 * @param {{epics: any[], stories: any[]}} data
 * @param {{backlogSections?: Set<string>}} [options]
 */
/**
 * The hierarchy rules. Epic contains Feature contains Story - and the one that
 * actually bites is that a story's feature must live in the story's OWN epic.
 * Without it a card can be filed under one epic while its feature sits in
 * another, and every rollup - percent complete, counts, the epic column -
 * quietly disagrees with itself depending on which side it counts from.
 */
function hierarchyFindings(data, sections) {
  const out = [];
  const epicKeys = new Set((data.epics ?? []).map((e) => e.key));
  const featureIds = new Set();

  for (const e of data.epics ?? []) {
    if (e.kind !== undefined && !EPIC_KINDS.includes(e.kind)) {
      out.push(`Epic ${e.key} has kind "${e.kind}"; expected ${EPIC_KINDS.join(' | ')}.`);
    }
  }

  for (const f of data.features ?? []) {
    if (featureIds.has(f.id)) {
      out.push(`Feature ${f.id} appears twice.`);
      continue;
    }
    featureIds.add(f.id);
    if (!epicKeys.has(f.epic)) {
      out.push(`Feature ${f.id} belongs to epic "${f.epic}", which is not declared.`);
    }
    if ((f.title ?? '').trim() === '') out.push(`Feature ${f.id} has no title.`);
    if (f.anchor !== undefined && sections !== undefined && !sections.has(f.anchor)) {
      out.push(`Feature ${f.id} cites backlog.md#${f.anchor}, which is not a section.`);
    }
    if (f.wsjf !== null && f.wsjf !== undefined) {
      for (const k of ['bv', 'tc', 'rr', 'size']) {
        if (!WSJF_SCALE.includes(f.wsjf[k])) {
          out.push(
            `Feature ${f.id} WSJF ${k} is "${f.wsjf[k]}"; SAFe scores each input on ${WSJF_SCALE.join(', ')}.`,
          );
        }
      }
    }
  }

  const featureById = new Map((data.features ?? []).map((f) => [f.id, f]));
  for (const s of data.stories ?? []) {
    if (s.feature === undefined) {
      out.push(`${s.id} belongs to no feature. Every story sits under one.`);
      continue;
    }
    const f = featureById.get(s.feature);
    if (f === undefined) {
      out.push(`${s.id} belongs to feature "${s.feature}", which is not declared.`);
    } else if (f.epic !== s.epic) {
      out.push(
        `${s.id} is in epic ${s.epic} but its feature ${f.id} is in epic ${f.epic}. Every rollup would count it twice, differently.`,
      );
    }
  }

  // An epic with no feature has either shipped or lost its work.
  for (const e of data.epics ?? []) {
    if (!(data.features ?? []).some((f) => f.epic === e.key)) {
      out.push(`Epic ${e.key} is declared but carries no feature.`);
    }
  }
  return out;
}

export function validateBoard(data, options = {}) {
  const out = [];
  const epicKeys = new Set((data.epics ?? []).map((e) => e.key));
  const byId = new Map();

  for (const s of data.stories ?? []) {
    if (byId.has(s.id)) {
      out.push(
        `${s.id} appears twice. A duplicated id looks tracked, gets named in a commit message, and points at whichever card the reader found first.`,
      );
      continue;
    }
    byId.set(s.id, s);
  }

  for (const s of byId.values()) {
    if (!epicKeys.has(s.epic)) {
      out.push(`${s.id} belongs to epic "${s.epic}", which is not declared.`);
    }
    if (!STATUSES.includes(s.status)) {
      out.push(`${s.id} has status "${s.status}"; expected ${STATUSES.join(' | ')}.`);
    }
    if (s.status === 'backlog' && !PRIORITIES.includes(s.priority)) {
      out.push(`${s.id} is in the backlog with priority "${s.priority}"; expected ${PRIORITIES.join(' | ')}.`);
    }
    if (!TYPES.includes(s.type)) {
      out.push(`${s.id} has type "${s.type}"; expected ${TYPES.join(' | ')}.`);
    }
    if (!SETTLED.includes(s.settled)) {
      out.push(
        `${s.id} is neither ${SETTLED.join(' nor ')}. That distinction is the most useful field on the board - settled means only work remains, undecided means no amount of effort finishes it.`,
      );
    }
    if ((s.title ?? '').trim() === '') {
      out.push(`${s.id} has no title.`);
    }
    // Required on done, optional before it: a story can pick up pins while it
    // is still in progress, but it cannot FINISH without saying how it was
    // confirmed. Checking presence is all a validator can do - the value's
    // truth is a claim - and presence is what stops "done" being silent.
    if (s.status === 'done' && !VERIFIED.includes(s.verified)) {
      out.push(
        `${s.id} is done but does not say how it was verified; expected ${VERIFIED.join(' | ')}. A finished story that cannot answer this is one nobody can re-check.`,
      );
    }
    if (s.status !== 'done' && s.verified !== undefined && !VERIFIED.includes(s.verified)) {
      out.push(`${s.id} has verified "${s.verified}"; expected ${VERIFIED.join(' | ')}.`);
    }
    out.push(...decisionFindings(s));
    out.push(...citationFindings(s, options.backlogSections));
  }

  // Epics that emptied out. An epic with no stories has either shipped, in which
  // case say so, or lost its work.
  // Epics are now checked for FEATURES in hierarchyFindings - an epic whose
  // features are all empty is caught here instead.
  for (const f of data.features ?? []) {
    if (![...byId.values()].some((s) => s.feature === f.id)) {
      out.push(`Feature ${f.id} is declared but carries no story.`);
    }
  }
  out.push(...hierarchyFindings(data, options.backlogSections));

  for (const s of byId.values()) {
    for (const dep of s.dependsOn ?? []) {
      const target = byId.get(dep);
      if (target === undefined) {
        out.push(`${s.id} depends on ${dep}, which is not a story on this board.`);
        continue;
      }
      if (dep === s.id) {
        out.push(`${s.id} depends on itself.`);
        continue;
      }
      // The two orderings that are actually wrong, rather than merely untidy.
      if (s.status === 'in-progress' && target.status === 'backlog') {
        out.push(
          `${s.id} is in progress but ${dep} is still in the backlog. Either ${dep} is further along than the board says, or ${s.id} started too early.`,
        );
      }
      if (s.status === 'done' && target.status !== 'done') {
        out.push(
          `${s.id} is done but ${dep}, which it depends on, is ${target.status}. One of the two is wrong.`,
        );
      }
    }
  }

  for (const cycle of findCycles(byId)) {
    out.push(`Dependency cycle: ${cycle.join(' -> ')}. Nothing in it can ever start.`);
  }

  return out;
}

/** Every dependency cycle, each reported once from its lowest-sorting member. */
function findCycles(byId) {
  const cycles = [];
  const seen = new Set();
  const stack = [];
  const onStack = new Set();

  const walk = (id) => {
    if (onStack.has(id)) {
      const at = stack.indexOf(id);
      const cycle = [...stack.slice(at), id];
      // Report each cycle once, keyed on its sorted membership.
      const key = [...new Set(cycle)].sort().join(',');
      if (!seen.has(key)) {
        seen.add(key);
        cycles.push(cycle);
      }
      return;
    }
    if (stack.includes(id)) return;
    const story = byId.get(id);
    if (story === undefined) return;
    stack.push(id);
    onStack.add(id);
    for (const dep of story.dependsOn ?? []) walk(dep);
    onStack.delete(id);
    stack.pop();
  };

  for (const id of byId.keys()) walk(id);
  return cycles;
}

/**
 * What is stopping a story right now: its dependencies that are not done.
 * Rendered on the card so "blocked" is visible rather than reconstructed.
 */
export function blockers(story, byId) {
  return (story.dependsOn ?? []).filter((d) => byId.get(d)?.status !== 'done');
}

/** Wrap prose to a readable width without breaking inline code spans. */
function wrap(text, width = 76, indent = '  ') {
  const words = String(text ?? '').split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    if (line === '') line = w;
    else if ((line + ' ' + w).length <= width) line += ' ' + w;
    else {
      lines.push(line);
      line = w;
    }
  }
  if (line !== '') lines.push(line);
  return lines.map((l) => indent + l).join('\n');
}

/** The human-readable board, generated. Never edit board.md by hand. */
export function renderBoard(data, today) {
  const byId = new Map(data.stories.map((s) => [s.id, s]));
  const L = [];
  const count = (f) => data.stories.filter(f).length;

  L.push('# Board');
  L.push('');
  L.push('Status: Living - GENERATED from board.json. Do not edit this file by hand; edit the data and re-render.');
  L.push('');
  L.push(`Rendered ${today} from \`docs/board.json\`, which is the source of truth for`);
  L.push('what is in the backlog, what is in progress, and what is done. Run');
  L.push('`npm run board` to regenerate; CI fails if this file is out of date, so the');
  L.push('two cannot disagree.');
  L.push('');
  L.push('`backlog.md` still holds the reasoning, the measurements and the rejected');
  L.push('alternatives. This board holds only what is a unit of work, what state it is');
  L.push('in, and what it waits on.');
  L.push('');
  L.push(`**${count((s) => s.status === 'backlog')} in the backlog, ${count((s) => s.status === 'in-progress')} in progress, ${count((s) => s.status === 'done')} done.**`);
  L.push('');

  // SAFe hierarchy: Epic > Feature > Story. Rendered as a rollup so the shape
  // is readable without opening the data.
  L.push('## Epics and features');
  L.push('');
  L.push('Epic > Feature > Story, per SAFe (Essential). An `enabler` epic exists to');
  L.push('unblock other epics rather than to deliver on its own. WSJF sequences');
  L.push('features: (business value + time criticality + risk reduction) / job size,');
  L.push('highest first - an unscored feature cannot be sequenced.');
  L.push('');
  for (const e of data.epics) {
    const feats = (data.features ?? []).filter((f) => f.epic === e.key);
    const inEpic = data.stories.filter((s) => s.epic === e.key);
    const doneN = inEpic.filter((s) => s.status === 'done').length;
    const pct = inEpic.length === 0 ? 0 : Math.round((100 * doneN) / inEpic.length);
    const kind = e.kind === 'enabler' ? ' _(enabler)_' : '';
    L.push(`### \`${e.key}\` ${e.name}${kind} - ${pct}% (${doneN}/${inEpic.length})`);
    L.push('');
    L.push(e.why);
    L.push('');
    L.push('| Feature | WSJF | Done | Stories |');
    L.push('|---|---|---|---|');
    for (const f of feats) {
      const kids = data.stories.filter((s) => s.feature === f.id);
      const kd = kids.filter((s) => s.status === 'done').length;
      const score = wsjfScore(f.wsjf);
      const ids = kids.map((s) => s.id).join(', ');
      L.push(
        `| \`${f.id}\` ${f.title} | ${score === null ? 'unscored' : score.toFixed(2)} | ${kd}/${kids.length} | ${ids} |`,
      );
    }
    L.push('');
  }

  const sections = [
    ['In progress', (s) => s.status === 'in-progress', 'Started. Anything here with an unfinished dependency is called out on its card.'],
    ['Backlog - now', (s) => s.status === 'backlog' && s.priority === 'now', 'Next to pick up. Nothing blocks these.'],
    ['Backlog - next', (s) => s.status === 'backlog' && s.priority === 'next', 'Settled and unblocked, sequenced behind now.'],
    ['Backlog - later', (s) => s.status === 'backlog' && s.priority === 'later', 'Settled, gated on something above.'],
    ['Done', (s) => s.status === 'done', 'Kept briefly so a reader can see what just landed; prune when the list grows.'],
  ];

  for (const [heading, pred, note] of sections) {
    const items = data.stories.filter(pred);
    L.push('---');
    L.push('');
    L.push(`## ${heading} (${items.length})`);
    L.push('');
    L.push(note);
    L.push('');
    if (items.length === 0) {
      L.push('_Nothing here._');
      L.push('');
      continue;
    }
    for (const s of items) {
      const blocked = blockers(s, byId);
      const tags = [
        s.feature ?? 'no feature',
        s.type,
        s.settled,
        ...(s.verified === undefined ? [] : [`verified: ${s.verified}`]),
        ...(blocked.length ? [`blocked by ${blocked.join(', ')}`] : []),
      ];
      L.push(`- **${s.id}** ${s.title}`);
      L.push(`  \`${tags.join('\` \`')}\``);
      if ((s.detail ?? '').trim() !== '') L.push(wrap(s.detail));
      if (s.decision !== undefined) {
        // Rendered so the markdown board shows the answer too - the kanban is
        // where it gets clicked, but this file is what lands in a diff.
        const chosen = s.decision.chosen ?? null;
        L.push(
          wrap(
            `DECISION${chosen === null ? ' (unanswered)' : ''}: ${s.decision.question}`,
          ),
        );
        for (const o of s.decision.options ?? []) {
          const mark = o.key === chosen ? '[x]' : '[ ]';
          const detail = (o.detail ?? '').trim();
          L.push(`    ${mark} \`${o.key}\` ${o.label}${detail === '' ? '' : ` - ${detail}`}`);
        }
      }
      L.push('');
    }
  }

  return L.join('\n');
}

async function main() {
  const dataPath = join(docsDir, 'board.json');
  const mdPath = join(docsDir, 'board.md');
  const data = JSON.parse(await readFile(dataPath, 'utf8'));

  // Resolve card citations against the real backlog. A missing backlog is not
  // fatal - the format rule still applies - but a present one is checked.
  const backlogText = await readFile(join(docsDir, 'backlog.md'), 'utf8').catch(() => '');
  const backlogSections = backlogText === '' ? undefined : backlogSectionIds(backlogText);

  const findings = validateBoard(data, { backlogSections });
  const prefix = process.env.GITHUB_ACTIONS === 'true' ? '::error::' : 'error: ';
  for (const f of findings) console.log(`${prefix}${f}`);
  if (findings.length > 0) {
    console.log(`\nBoard: ${findings.length} problem(s) in docs/board.json.`);
    process.exitCode = 1;
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const rendered = renderBoard(data, today);
  const check = process.argv.includes('--check');
  const current = await readFile(mdPath, 'utf8').catch(() => '');

  // Compare ignoring the rendered date, so a board that changed only by being
  // re-rendered on a later day does not fail CI.
  const strip = (t) => t.replace(/^Rendered \d{4}-\d{2}-\d{2} from/m, 'Rendered <date> from');
  if (check) {
    if (strip(current.replace(/\r\n/g, '\n')) !== strip(rendered)) {
      console.log(`${prefix}docs/board.md is out of date. Run "npm run board" and commit the result.`);
      process.exitCode = 1;
      return;
    }
    console.log(`board.md matches board.json (${data.stories.length} stories, ${data.epics.length} epics).`);
    return;
  }

  await writeFile(mdPath, rendered, 'utf8');
  console.log(`Rendered docs/board.md from board.json (${data.stories.length} stories, ${data.epics.length} epics).`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
