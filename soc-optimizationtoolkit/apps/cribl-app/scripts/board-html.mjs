// The board as a KANBAN PAGE, rendered from the same docs/board.json that
// board.mjs turns into board.md.
//
// WHY A SECOND RENDERER RATHER THAN A SECOND SOURCE. board.md reads well in a
// diff and badly on a wall: columns are what tells you where the work is piling
// up, and markdown cannot show that. Both renderers take the same validated
// data and neither one is authored by hand, so the kanban and the markdown
// cannot drift the way two hand-kept lists would - which is the whole reason
// the board became data in the first place.
//
// Pure: takes data, returns a string. The server does the IO.

import { blockers, MENUS, MENU_LABELS, PLANNED_MENUS, PRIORITIES, STATUSES, menuOf } from './board.mjs';

/** Display names; the LIST of columns is not ours to decide. */
const COLUMN_TITLES = {
  backlog: 'Backlog',
  'in-progress': 'In progress',
  done: 'Done',
};

/**
 * Columns are PROGRESS, DERIVED from the declared vocabulary. Priority is a
 * lane inside the backlog, not a column.
 *
 * Derived rather than listed because the audit on 2026-08-27 caught this file
 * hardcoding its own copy of the three statuses. `STATUSES` is what
 * `validateBoard` accepts, so a fourth status would have passed validation and
 * then rendered into NO column - a card present in board.json, absent from the
 * page, and invisible to every count, because each column only counts what it
 * already renders. A status with no title here still gets a column, keyed by
 * its own name: an ugly heading beats a disappeared card.
 *
 * @param {readonly string[]} statuses
 */
export function columnsFrom(statuses) {
  return statuses.map((status) => ({ status, title: COLUMN_TITLES[status] ?? status }));
}

const COLUMNS = columnsFrom(STATUSES);

/**
 * What each piece of vocabulary MEANS, shown behind an information affordance.
 *
 * The keys on this board are three-letter epic codes and single words like
 * `chore` and `settled`. They are obvious to whoever wrote them and opaque to
 * everyone else - "I don't know what HON or REL means" was the first thing a
 * reader said about it. The explanations already existed in board.json's epic
 * `name` and `why`; nothing was showing them.
 */
const GLOSSARY = {
  status: {
    backlog: 'Not started. Priority orders the lanes inside this column.',
    'in-progress': 'Being worked on right now. A card moves here BEFORE the work starts, not after it finishes.',
    done: 'Finished. Its `verified` tag says how that was confirmed.',
  },
  priority: {
    now: 'Next to pick up. Nothing should block these.',
    next: 'Settled and unblocked, sequenced behind now.',
    later: 'Settled, but gated on something above.',
  },
  type: {
    story: 'Changes what an operator sees or does.',
    enabler: "SAFe Enabler: infrastructure, architecture, tooling, docs or release mechanics. No operator sees it, but the work above it needs it.",
    spike: 'SAFe exploration Enabler. Answered by INVESTIGATION, never by preference - timeboxed, and demonstrated like any story.',
    bug: 'A defect in code that was already committed. SAFe has no separate place for these; they sit in the backlog beside stories.',
    decision: 'A LOCAL extension, not SAFe: a question answered by a person rather than by investigation, attached to the feature it blocks.',
  },
  settled: {
    settled: 'Nothing is undecided - only the work remains.',
    undecided: 'A real question is still open. No amount of effort finishes this until it is answered.',
    unconfirmed: 'Reported but not yet reproduced or confirmed.',
  },
  verified: {
    pins: 'Confirmed by automated tests, and only those.',
    live: 'Confirmed by driving the real product or environment, and only that.',
    both: 'Confirmed by pins AND a live run.',
    none: 'Neither - legitimate for docs and process work, and the value to notice on anything else.',
  },
};

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Detail text is written for the markdown board, so it carries `code spans`,
 * **bold** and [[links]] to other cards. Rendering it as raw text would show
 * the punctuation; rendering it as markdown would mean a parser. Escape first,
 * then re-introduce only these three, so nothing in the data can inject markup.
 */
function richText(text) {
  return esc(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[\[([^\]]+)\]\]/g, '<a class="xref" href="#card-$1">$1</a>');
}

/**
 * The information affordance. A small `i` carrying an explanation, because the
 * board's own vocabulary - three-letter epic keys, `enabler`, `settled` - is
 * obvious only to whoever wrote it.
 */
function info(text) {
  if (!text) return '';
  return `<span class="i" title="${esc(text)}" aria-label="${esc(text)}" role="img">i</span>`;
}

/** A tag that explains itself. */
function tag(cls, label, explain) {
  return `<span class="tag ${esc(cls)}" title="${esc(explain ?? '')}">${esc(label)}</span>`;
}

function pct(done, total) {
  return total === 0 ? 0 : Math.round((100 * done) / total);
}

function bar(done, total) {
  const p = pct(done, total);
  return (
    `<div class="bar" title="${done} of ${total} done"><span style="width:${p}%"></span></div>` +
    `<div class="bar-label">${p}% &middot; ${done}/${total}</div>`
  );
}

/** Counts by type, so a feature says what kind of work is under it. */
function typeCounts(kids) {
  const n = {};
  for (const k of kids) n[k.type] = (n[k.type] ?? 0) + 1;
  return Object.entries(n)
    .map(([t, c]) => `<span class="mini" title="${esc(GLOSSARY.type[t] ?? t)}">${c} ${esc(t)}</span>`)
    .join('');
}

/** One card per epic: the largest grouping, with its features rolled up. */
function epicCard(epic, data) {
  const feats = (data.features ?? []).filter((f) => f.epic === epic.key);
  const kids = (data.stories ?? []).filter((s) => s.epic === epic.key);
  const done = kids.filter((s) => s.status === 'done').length;
  const kind =
    epic.kind === 'enabler'
      ? tag('kind-enabler', 'enabler', 'An ENABLER epic: it exists to unblock other epics rather than to deliver value on its own.')
      : tag('kind-business', 'business', 'A BUSINESS epic: it delivers value directly.');
  return [
    `<article class="card epic-card" data-epic="${esc(epic.key)}"`,
    ` data-text="${esc(`${epic.key} ${epic.name} ${epic.why}`.toLowerCase())}">`,
    `<header><span class="id">${esc(epic.key)}</span>${info(epic.why)}</header>`,
    `<h3>${esc(epic.name)}</h3>`,
    `<div class="tags">${kind}<span class="mini">${feats.length} features</span>${typeCounts(kids)}</div>`,
    bar(done, kids.length),
    `</article>`,
  ].join('');
}

/** One card per feature: progress, and what kind of work sits under it. */
function featureCard(feature, data) {
  const kids = (data.stories ?? []).filter((s) => s.feature === feature.id);
  const done = kids.filter((s) => s.status === 'done').length;
  const openDecisions = kids.filter(
    (s) => s.type === 'decision' && (s.decision?.chosen ?? null) === null && s.status !== 'done',
  ).length;
  return [
    `<article class="card feature-card" data-epic="${esc(feature.epic)}"`,
    ` data-text="${esc(`${feature.id} ${feature.title} ${feature.epic}`.toLowerCase())}">`,
    `<header><span class="id">${esc(feature.id)}</span>`,
    `<span class="epic">${esc(feature.epic)}</span></header>`,
    `<h3>${esc(feature.title)}</h3>`,
    `<div class="tags">`,
    typeCounts(kids),
    openDecisions > 0
      ? tag('blocked', `${openDecisions} open decision${openDecisions > 1 ? 's' : ''}`, 'A question on this feature is unanswered, so the work behind it cannot start.')
      : '',
    `</div>`,
    bar(done, kids.length),
    feature.anchor ? `<p class="note">backlog.md#${esc(feature.anchor)}</p>` : '',
    `</article>`,
  ].join('');
}

/**
 * The menu chip. Marked `planned` when the menu names a screen nobody can open
 * yet, so the board cannot quietly imply a route exists; marked `own` when the
 * story overrode its feature's menu, so the difference is visible rather than
 * something you find by opening board.json.
 */
function menuChip(menu, isOverride) {
  if (menu === undefined) return '';
  const planned = PLANNED_MENUS.includes(menu);
  const title = planned
    ? `${MENU_LABELS[menu] ?? menu} - PLANNED. No route exists yet; an epic here builds it.`
    : `Menu item this card is about: ${MENU_LABELS[menu] ?? menu}.` +
      (isOverride ? ' Set on the story itself, overriding its feature.' : '');
  return (
    `<span class="menu${planned ? ' planned' : ''}${isOverride ? ' own' : ''}"` +
    ` title="${esc(title)}">${esc(MENU_LABELS[menu] ?? menu)}${isOverride ? '*' : ''}</span>`
  );
}

function card(story, byId, menu) {
  const blocked = blockers(story, byId);
  const tags = [
    tag(`type-${story.type}`, story.type, GLOSSARY.type[story.type]),
    tag(`settled-${story.settled}`, story.settled, GLOSSARY.settled[story.settled]),
  ];
  if (story.verified !== undefined) {
    // `none` is a legitimate answer and still the one to notice, so it is
    // styled like the other amber "look at this" tags rather than hidden.
    tags.push(
      tag(`verified-${story.verified}`, `verified: ${story.verified}`, GLOSSARY.verified[story.verified]),
    );
  }
  if (blocked.length > 0) {
    tags.push(
      `<span class="tag blocked">blocked by ${blocked.map(esc).join(', ')}</span>`,
    );
  }
  const detail = (story.detail ?? '').trim();
  const d = story.decision;
  const decisionBlock =
    d === undefined
      ? ''
      : [
          `<div class="decision${d.chosen ? ' answered' : ''}">`,
          `<p class="q">${richText(d.question)}</p>`,
          ...(d.options ?? []).map(
            (o) =>
              `<label class="opt${o.key === d.chosen ? ' picked' : ''}">` +
              `<input type="radio" name="dec-${esc(story.id)}" value="${esc(o.key)}"` +
              ` data-story="${esc(story.id)}"${o.key === d.chosen ? ' checked' : ''}>` +
              `<span class="opt-label">${esc(o.label)}</span>` +
              ((o.detail ?? '').trim() === ''
                ? ''
                : `<span class="opt-detail">${richText(o.detail)}</span>`) +
              `</label>`,
          ),
          // Says out loud what a click does, so nobody reads it as "decided".
          `<p class="note">${
            d.chosen
              ? 'Answer recorded. Still <strong>undecided</strong> until the reasoning lands in backlog.md.'
              : 'Picking an option records your answer only - it does not settle the card.'
          }</p>`,
          `</div>`,
        ].join('');
  return [
    `<article class="card${blocked.length ? ' is-blocked' : ''}" id="card-${esc(story.id)}"`,
    ` data-epic="${esc(story.epic)}" data-type="${esc(story.type)}"`,
    ` data-settled="${esc(story.settled)}" data-blocked="${blocked.length ? 'yes' : 'no'}"`,
    ` data-menu="${esc(menu ?? 'none')}"`,
    ` data-text="${esc(`${story.id} ${story.title} ${story.epic} ${detail}`.toLowerCase())}">`,
    `<header><span class="id">${esc(story.id)}</span>`,
    story.feature ? `<span class="feat" title="Feature this story sits under">${esc(story.feature)}</span>` : '',
    menuChip(menu, story.menu !== undefined),
    `<span class="epic">${esc(story.epic)}</span></header>`,
    `<h3>${esc(story.title)}</h3>`,
    `<div class="tags">${tags.join('')}</div>`,
    decisionBlock,
    detail === ''
      ? ''
      : `<details><summary>detail</summary><p>${richText(detail)}</p></details>`,
    `</article>`,
  ].join('');
}

function lane(label, items, byId, featureById) {
  if (items.length === 0) return '';
  return (
    `<div class="lane"><h4>${esc(label)} <span class="count">${items.length}</span></h4>` +
    items.map((s) => card(s, byId, menuOf(s, featureById))).join('') +
    `</div>`
  );
}

/**
 * The whole page: self-contained, no network, no dependencies. `findings` is
 * board.mjs's validation output - shown at the top rather than swallowed,
 * because a board that fails its own rules is exactly when you want to look at
 * it.
 *
 * @param {{epics: any[], stories: any[]}} data
 * @param {string} today
 * @param {string[]} findings
 */
export function renderBoardHtml(data, today, findings = []) {
  const stories = data.stories ?? [];
  const byId = new Map(stories.map((s) => [s.id, s]));
  const featureById = new Map((data.features ?? []).map((f) => [f.id, f]));
  const count = (f) => stories.filter(f).length;

  const columns = COLUMNS.map((col) => {
    const inCol = stories.filter((s) => s.status === col.status);
    let body;
    if (col.status === 'backlog') {
      // Priority only means something inside the backlog; elsewhere it is
      // absent by design, so lanes would be a column of one empty heading.
      body = PRIORITIES.map((p) =>
        lane(p, inCol.filter((s) => s.priority === p), byId, featureById),
      ).join('');
      const noPriority = inCol.filter((s) => !PRIORITIES.includes(s.priority));
      body += lane('unprioritised', noPriority, byId, featureById);
    } else {
      body = inCol.map((s) => card(s, byId, menuOf(s, featureById))).join('');
    }
    return (
      `<section class="col" data-status="${esc(col.status)}">` +
      `<h2>${esc(col.title)} <span class="count">${inCol.length}</span>` +
      `${info(GLOSSARY.status[col.status])}</h2>` +
      `${body}</section>`
    );
  }).join('');

  // The two rollup columns. They are NOT progress states - they are the levels
  // above a story - so they sit left of the flow rather than inside it.
  const epicCol =
    `<section class="col col-rollup" data-status="epics">` +
    `<h2>Epics <span class="count">${(data.epics ?? []).length}</span>` +
    `${info('The largest grouping. SAFe: Epic > Feature > Story. A business epic delivers value; an enabler epic exists to unblock other epics.')}</h2>` +
    (data.epics ?? []).map((e) => epicCard(e, data)).join('') +
    `</section>`;

  const featureCol =
    `<section class="col col-rollup" data-status="features">` +
    `<h2>Features <span class="count">${(data.features ?? []).length}</span>` +
    `${info('A feature sits under one epic and holds the stories, spikes and bugs that deliver it. Features are groupings, not a queue - stories carry the priority.')}</h2>` +
    (data.features ?? []).map((f) => featureCard(f, data)).join('') +
    `</section>`;

  const epicRows = (data.epics ?? [])
    .map((e) => {
      const open = count((s) => s.epic === e.key && s.status !== 'done');
      return (
        `<button class="chip" data-filter-epic="${esc(e.key)}">` +
        `${esc(e.key)} <span class="count">${open}</span></button>`
      );
    })
    .join('');

  const findingsBlock =
    findings.length === 0
      ? ''
      : `<div class="findings"><strong>board.json fails ${findings.length} of its own rules</strong><ul>` +
        findings.map((f) => `<li>${esc(f)}</li>`).join('') +
        `</ul></div>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Board - SOC Optimization Toolkit</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root{--bg:#0f1620;--panel:#16202c;--card:#1c2836;--line:#26364a;--ink:#dfe8f2;--dim:#8ba0b8;--accent:#4ea1ff}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 ui-sans-serif,system-ui,'Segoe UI',sans-serif}
header.top{display:flex;gap:16px;align-items:baseline;flex-wrap:wrap;padding:14px 20px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--bg);z-index:5}
h1{font-size:16px;margin:0}
.meta{color:var(--dim);font-size:12px}
.controls{margin-left:auto;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
input[type=search],select{background:var(--panel);border:1px solid var(--line);color:var(--ink);border-radius:6px;padding:5px 9px}
input[type=search]{min-width:200px}
.menu{font-size:11px;color:var(--muted);border:1px solid var(--line);border-radius:4px;padding:1px 6px;margin-left:6px;white-space:nowrap}
.menu.planned{border-style:dashed;font-style:italic}
.menu.own{border-color:var(--accent,#888)}
.chip{background:var(--panel);border:1px solid var(--line);color:var(--dim);border-radius:99px;padding:3px 9px;font-size:12px;cursor:pointer;font-family:inherit}
.chip.on{border-color:var(--accent);color:var(--accent)}
.epics{display:flex;gap:6px;flex-wrap:wrap;padding:10px 20px;border-bottom:1px solid var(--line)}
.board{display:grid;grid-template-columns:repeat(5,minmax(270px,1fr));gap:14px;padding:16px 20px;align-items:start}
.col-rollup{background:#131c26}
.col{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px;min-height:120px}
.col h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--dim);margin:0 0 10px}
.lane h4{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--dim);margin:12px 0 6px;border-top:1px dashed var(--line);padding-top:8px}
.lane:first-child h4{border-top:0;margin-top:0}
.count{background:var(--line);color:var(--ink);border-radius:99px;padding:0 7px;font-size:11px;margin-left:4px}
.card{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--line);border-radius:8px;padding:9px 11px;margin:0 0 8px}
.card.is-blocked{border-left-color:#c2871f}
.card header{display:flex;gap:8px;align-items:center;font-size:11px;color:var(--dim)}
.card .id{font-weight:700;color:var(--accent);font-family:ui-monospace,Menlo,Consolas,monospace}
.card .epic{margin-left:auto;background:var(--line);border-radius:99px;padding:0 7px}
.card h3{font-size:13px;margin:5px 0 7px;font-weight:600;line-height:1.35}
.tags{display:flex;gap:5px;flex-wrap:wrap}
.tag{font-size:10px;text-transform:uppercase;letter-spacing:.05em;border-radius:4px;padding:1px 6px;background:var(--line);color:var(--dim)}
.tag.type-bug{background:#3a1f24;color:#ff9aa6}
.tag.type-feature{background:#16303a;color:#7fd4f0}
.tag.type-decision{background:#2c2440;color:#c0a6ff}
.tag.type-spike{background:#2b2a17;color:#e0d27a}
.tag.verified-both{background:#14301f;color:#7ee0a8}
.tag.verified-live{background:#14301f;color:#7ee0a8}
.tag.verified-pins{background:#16303a;color:#7fd4f0}
.tag.verified-none{background:#3a2a12;color:#ffbe5c}
.tag.settled-undecided{background:#3a2a12;color:#ffbe5c}
.tag.settled-unconfirmed{background:#3a2a12;color:#ffbe5c}
.tag.blocked{background:#3a2a12;color:#ffbe5c}
.decision{margin-top:8px;border:1px solid #7a5a12;background:#241d0e;border-radius:6px;padding:8px 9px}
.decision.answered{border-color:#2f5e3f;background:#12210f}
.decision .q{margin:0 0 7px;font-size:12px;color:#ffd79a;line-height:1.4}
.decision.answered .q{color:#a9e6bd}
.opt{display:block;margin:0 0 5px;padding:5px 7px;border:1px solid var(--line);border-radius:5px;cursor:pointer;background:#0e1620}
.opt:hover{border-color:var(--accent)}
.opt.picked{border-color:#4fbf7a;background:#10241a}
.opt input{margin-right:6px;vertical-align:top}
.opt-label{font-size:12px;font-weight:600}
.opt-detail{display:block;margin:3px 0 0 20px;font-size:11.5px;color:var(--dim);line-height:1.4}
.decision .note{margin:6px 0 0;font-size:10.5px;color:var(--dim);line-height:1.4}
.decision.answered .note{color:#8fbf9f}
.i{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border:1px solid var(--dim);border-radius:50%;font-size:10px;font-style:italic;font-weight:700;color:var(--dim);cursor:help;margin-left:6px;flex:none;line-height:1}
.i:hover{border-color:var(--accent);color:var(--accent)}
.mini{font-size:10px;color:var(--dim);background:var(--line);border-radius:4px;padding:1px 6px}
.bar{height:5px;background:var(--line);border-radius:3px;overflow:hidden;margin-top:8px}
.bar span{display:block;height:100%;background:#4fbf7a}
.bar-label{font-size:10px;color:var(--dim);margin-top:3px}
.epic-card .id,.feature-card .id{font-size:12px}
.feat{background:#1d2a3a;color:#8fb6e0;border-radius:99px;padding:0 7px;margin-left:6px}
.tag.kind-enabler{background:#2c2440;color:#c0a6ff}
.tag.kind-business{background:#16303a;color:#7fd4f0}
details{margin-top:7px}
summary{cursor:pointer;color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:.05em}
details p{margin:6px 0 0;color:#c3d2e2;font-size:12.5px;white-space:pre-wrap}
code{background:#0c131b;border:1px solid var(--line);border-radius:3px;padding:0 4px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11.5px}
a.xref{color:var(--accent)}
.findings{margin:12px 20px;padding:10px 14px;border:1px solid #7a4b12;background:#2a1d0c;border-radius:8px;color:#ffcf8a}
.findings ul{margin:6px 0 0;padding-left:18px}
.hide{display:none}
@media(max-width:1600px){.board{grid-template-columns:repeat(3,minmax(270px,1fr))}}
@media(max-width:1000px){.board{grid-template-columns:1fr}}
</style></head><body>
<header class="top">
  <h1>Board</h1>
  <span class="meta">${esc(stories.length)} stories &middot; ${esc((data.epics ?? []).length)} epics &middot; rendered ${esc(today)} from docs/board.json &middot; <span id="live">live</span></span>
  <div class="controls">
    <input type="search" id="q" placeholder="filter cards..." autocomplete="off">
    <select id="menuSel" title="Show only cards about one menu item. The count is OPEN cards.">
      <option value="">all menus</option>
      ${MENUS.filter((m) => stories.some((s) => menuOf(s, featureById) === m))
        .map((m) => {
          const openN = stories.filter(
            (s) => menuOf(s, featureById) === m && s.status !== 'done',
          ).length;
          return `<option value="${esc(m)}">${esc(MENU_LABELS[m] ?? m)} (${openN})</option>`;
        })
        .join('')}
    </select>
    <button class="chip" id="blockedOnly">blocked only</button>
  </div>
</header>
<div class="epics">${epicRows}</div>
${findingsBlock}
<main class="board">${epicCol}${featureCol}${columns}</main>
<script>
const q=document.getElementById('q');
const menuSel=document.getElementById('menuSel');
const blockedBtn=document.getElementById('blockedOnly');
let epic=null,blockedOnly=false;
function apply(){
  const t=q.value.trim().toLowerCase();
  const m=menuSel.value;
  for(const c of document.querySelectorAll('.card')){
    const okText=!t||c.dataset.text.includes(t);
    const okEpic=!epic||c.dataset.epic===epic;
    const okBlocked=!blockedOnly||c.dataset.blocked==='yes';
    // Epic and feature cards carry no menu; a menu filter is about stories, so
    // they stay put rather than vanishing and making the board look empty.
    const okMenu=!m||c.dataset.menu===undefined||c.dataset.menu===m||!c.dataset.menu;
    c.classList.toggle('hide',!(okText&&okEpic&&okBlocked&&okMenu));
  }
  for(const l of document.querySelectorAll('.lane')){
    const any=[...l.querySelectorAll('.card')].some(c=>!c.classList.contains('hide'));
    l.classList.toggle('hide',!any);
  }
}
q.addEventListener('input',apply);
menuSel.addEventListener('change',apply);
blockedBtn.addEventListener('click',()=>{blockedOnly=!blockedOnly;blockedBtn.classList.toggle('on',blockedOnly);apply();});
for(const b of document.querySelectorAll('[data-filter-epic]')){
  b.addEventListener('click',()=>{
    const k=b.dataset.filterEpic;
    epic=epic===k?null:k;
    for(const o of document.querySelectorAll('[data-filter-epic]'))o.classList.toggle('on',o.dataset.filterEpic===epic);
    apply();
  });
}
// Answering a decision writes board.json; the resulting change event reloads
// the page, so the card re-renders from the file rather than from optimism.
for(const r of document.querySelectorAll('.decision input[type=radio]')){
  r.addEventListener('change',async()=>{
    const body=JSON.stringify({id:r.dataset.story,option:r.value});
    try{
      const res=await fetch('/decide',{method:'POST',headers:{'Content-Type':'application/json'},body});
      if(!res.ok){alert('Could not record that answer: '+(await res.text()));r.checked=false;}
    }catch(e){alert('Could not reach the board server: '+e);r.checked=false;}
  });
}
// Live reload: the server pushes on every board.json write.
try{
  const es=new EventSource('/events');
  es.onmessage=()=>location.reload();
  es.onerror=()=>{document.getElementById('live').textContent='disconnected';};
}catch{}
</script>
</body></html>`;
}
