// Backlog grooming: what to work on, in what order, and what is really in the
// way.
//
// The board already answers "what state is this card in". It does not answer
// "what should I do next", because that question is a function of THREE things
// the board stores separately: priority, the dependency graph, and whether an
// open decision is sitting in front of the work. A `now` card that is blocked
// is not next; a `later` card that gates five others probably is.
//
// GOAL-LED, by choice. Each non-done story is a goal, and its prerequisites are
// nested underneath in the order they have to happen. A flat queue would say
// what to pick up but not what it is FOR, and the thing being groomed is the
// sequence toward a goal rather than the next ticket.
//
// Everything here is pure - it takes board data and returns a report. The skill
// wrapped around it supplies the judgement, because the arithmetic can say a
// card gates five others and still cannot say whether that matters this week.

/** Ranked, lowest first. Absent priority sorts last. */
const PRIORITY_RANK = { now: 0, next: 1, later: 2 };

function rankOf(story) {
  return PRIORITY_RANK[story.priority] ?? 3;
}

/**
 * Prerequisites that are not done yet, deepest first, so the list can be worked
 * top to bottom. Cycle-safe: validateBoard rejects cycles, but a report that
 * hangs on bad data is a poor way to find that out.
 *
 * @param {string} id
 * @param {Map<string, any>} byId
 * @returns {string[]}
 */
export function prerequisiteChain(id, byId) {
  const out = [];
  const seen = new Set();
  const walk = (current, stack) => {
    if (stack.has(current)) return; // cycle - stop, do not recurse
    const story = byId.get(current);
    if (story === undefined) return;
    stack.add(current);
    for (const dep of story.dependsOn ?? []) {
      const target = byId.get(dep);
      if (target === undefined || target.status === 'done') continue;
      walk(dep, stack);
      if (!seen.has(dep)) {
        seen.add(dep);
        out.push(dep);
      }
    }
    stack.delete(current);
  };
  walk(id, new Set());
  return out;
}

/**
 * How many not-done stories are waiting on this one, transitively. The leverage
 * number: a card that gates five others is worth more than its own priority
 * suggests, which is exactly the thing a priority column cannot express.
 */
export function unblockCount(id, byId) {
  let n = 0;
  for (const other of byId.values()) {
    if (other.id === id || other.status === 'done') continue;
    if (prerequisiteChain(other.id, byId).includes(id)) n += 1;
  }
  return n;
}

/** A story with nothing unfinished in front of it. */
export function isReady(story, byId) {
  return prerequisiteChain(story.id, byId).length === 0;
}

/**
 * Goals in the order they should be considered: priority first, then leverage,
 * then id so the report is stable between runs.
 */
export function goalPlan(data) {
  const byId = new Map((data.stories ?? []).map((s) => [s.id, s]));
  const goals = (data.stories ?? [])
    .filter((s) => s.status !== 'done')
    .map((s) => {
      const chain = prerequisiteChain(s.id, byId);
      return {
        id: s.id,
        title: s.title,
        epic: s.epic,
        priority: s.priority,
        status: s.status,
        ready: chain.length === 0,
        prerequisites: chain.map((d) => ({
          id: d,
          title: byId.get(d)?.title ?? '',
          status: byId.get(d)?.status,
          settled: byId.get(d)?.settled,
          decision: byId.get(d)?.decision !== undefined,
        })),
        unblocks: unblockCount(s.id, byId),
      };
    });
  goals.sort(
    (a, b) =>
      rankOf({ priority: a.priority }) - rankOf({ priority: b.priority }) ||
      b.unblocks - a.unblocks ||
      a.id.localeCompare(b.id),
  );
  return goals;
}

/**
 * What grooming should ARGUE with, as opposed to merely list. Each finding is a
 * claim about the board disagreeing with itself or with reality.
 */
export function groomingFindings(data) {
  const stories = data.stories ?? [];
  const byId = new Map(stories.map((s) => [s.id, s]));
  const open = stories.filter((s) => s.status !== 'done');
  const out = [];

  // 1. Priority no longer matches readiness.
  for (const s of open) {
    const chain = prerequisiteChain(s.id, byId);
    if (s.priority === 'now' && chain.length > 0) {
      out.push({
        kind: 'contradiction',
        id: s.id,
        message: `${s.id} is priority NOW but waits on ${chain.length} unfinished card(s): ${chain.join(', ')}. Either it is not now, or those are.`,
      });
    }
    if (s.priority === 'later' && chain.length === 0 && unblockCount(s.id, byId) >= 2) {
      out.push({
        kind: 'contradiction',
        id: s.id,
        message: `${s.id} is priority LATER but is ready and gates ${unblockCount(s.id, byId)} card(s). Leaving it late holds them all.`,
      });
    }
  }

  // 2. Decisions in front of work - usually the highest-leverage move, because
  //    answering one is minutes and unblocks a chain.
  const gating = open
    .filter((s) => s.decision !== undefined && (s.decision.chosen ?? null) === null)
    .map((s) => ({ id: s.id, n: unblockCount(s.id, byId), title: s.title }))
    .filter((g) => g.n > 0)
    .sort((a, b) => b.n - a.n || a.id.localeCompare(b.id));
  for (const g of gating) {
    out.push({
      kind: 'decision',
      id: g.id,
      message: `${g.id} is an unanswered decision gating ${g.n} card(s). Answering it is minutes; the work behind it cannot start.`,
    });
  }

  // 3. Leverage that priority is hiding.
  const leverage = open
    .map((s) => ({ id: s.id, n: unblockCount(s.id, byId), priority: s.priority }))
    .filter((l) => l.n >= 3)
    .sort((a, b) => b.n - a.n || a.id.localeCompare(b.id));
  for (const l of leverage.slice(0, 5)) {
    out.push({
      kind: 'leverage',
      id: l.id,
      message: `${l.id} (${l.priority ?? 'no priority'}) transitively unblocks ${l.n} card(s).`,
    });
  }

  // 4. Hygiene.
  const done = stories.filter((s) => s.status === 'done');
  if (done.length >= 8) {
    out.push({
      kind: 'hygiene',
      message: `${done.length} done stories are still on the board. The board says to prune when the list grows.`,
    });
  }
  for (const e of data.epics ?? []) {
    const inEpic = open.filter((s) => s.epic === e.key);
    // NOT "no card marked now" - focus is deliberate, and flagging every epic
    // outside the current focus fired eight times on the first run, which is
    // how a report teaches people to skim it. A STALLED epic is the real
    // signal: open work that cannot be started at all.
    if (inEpic.length > 0 && !inEpic.some((s) => isReady(s, byId))) {
      out.push({
        kind: 'hygiene',
        id: e.key,
        message: `Epic ${e.key} has ${inEpic.length} open card(s) and NOT ONE is ready - the whole epic is waiting on something outside it.`,
      });
    }
  }
  for (const s of open) {
    const chain = prerequisiteChain(s.id, byId);
    if (chain.length >= 5) {
      out.push({
        kind: 'hygiene',
        id: s.id,
        message: `${s.id} sits behind a chain of ${chain.length}. Long chains hide how far away a card really is.`,
      });
    }
  }

  return out;
}

/** The human-readable report. */
export function renderGroom(data, today) {
  const goals = goalPlan(data);
  const findings = groomingFindings(data);
  const L = [];
  L.push(`Backlog grooming - ${today}`);
  L.push('');

  const byKind = (k) => findings.filter((f) => f.kind === k);
  const sections = [
    ['DECISIONS IN THE WAY', 'decision'],
    ['PRIORITY DISAGREES WITH READINESS', 'contradiction'],
    ['LEVERAGE', 'leverage'],
    ['HYGIENE', 'hygiene'],
  ];
  for (const [heading, kind] of sections) {
    const items = byKind(kind);
    if (items.length === 0) continue;
    L.push(heading);
    for (const f of items) L.push(`  - ${f.message}`);
    L.push('');
  }

  for (const label of ['now', 'next', 'later']) {
    const inBand = goals.filter((g) => g.priority === label && g.status === 'backlog');
    const started = label === 'now' ? goals.filter((g) => g.status === 'in-progress') : [];
    if (inBand.length === 0 && started.length === 0) continue;
    L.push(`${label.toUpperCase()} (${inBand.length + started.length})`);
    for (const g of [...started, ...inBand]) {
      const flag = g.ready ? 'READY' : `blocked by ${g.prerequisites.length}`;
      const lev = g.unblocks > 0 ? `, unblocks ${g.unblocks}` : '';
      L.push(`  ${g.id}  ${g.title}`);
      L.push(`      ${flag}${lev}${g.status === 'in-progress' ? ', IN PROGRESS' : ''}`);
      for (const p of g.prerequisites) {
        const note = p.decision ? ' [decision]' : '';
        L.push(`        do first: ${p.id}  ${p.title}${note}`);
      }
    }
    L.push('');
  }
  return L.join('\n');
}

async function main() {
  const { readFile } = await import('node:fs/promises');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = dirname(fileURLToPath(import.meta.url));
  const docsDir = join(here, '..', '..', '..', 'docs');
  const data = JSON.parse(await readFile(join(docsDir, 'board.json'), 'utf8'));
  const today = new Date().toISOString().slice(0, 10);
  console.log(renderGroom(data, today));
}

if (process.argv[1] && (await import('node:url')).fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
