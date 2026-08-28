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

import { blockers, PRIORITIES, STATUSES } from './board.mjs';

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

function card(story, byId) {
  const blocked = blockers(story, byId);
  const tags = [
    `<span class="tag type-${esc(story.type)}">${esc(story.type)}</span>`,
    `<span class="tag settled-${esc(story.settled)}">${esc(story.settled)}</span>`,
  ];
  if (story.verified !== undefined) {
    // `none` is a legitimate answer and still the one to notice, so it is
    // styled like the other amber "look at this" tags rather than hidden.
    tags.push(
      `<span class="tag verified-${esc(story.verified)}">verified: ${esc(story.verified)}</span>`,
    );
  }
  if (blocked.length > 0) {
    tags.push(
      `<span class="tag blocked">blocked by ${blocked.map(esc).join(', ')}</span>`,
    );
  }
  const detail = (story.detail ?? '').trim();
  return [
    `<article class="card${blocked.length ? ' is-blocked' : ''}" id="card-${esc(story.id)}"`,
    ` data-epic="${esc(story.epic)}" data-type="${esc(story.type)}"`,
    ` data-settled="${esc(story.settled)}" data-blocked="${blocked.length ? 'yes' : 'no'}"`,
    ` data-text="${esc(`${story.id} ${story.title} ${story.epic} ${detail}`.toLowerCase())}">`,
    `<header><span class="id">${esc(story.id)}</span>`,
    `<span class="epic">${esc(story.epic)}</span></header>`,
    `<h3>${esc(story.title)}</h3>`,
    `<div class="tags">${tags.join('')}</div>`,
    detail === ''
      ? ''
      : `<details><summary>detail</summary><p>${richText(detail)}</p></details>`,
    `</article>`,
  ].join('');
}

function lane(label, items, byId) {
  if (items.length === 0) return '';
  return (
    `<div class="lane"><h4>${esc(label)} <span class="count">${items.length}</span></h4>` +
    items.map((s) => card(s, byId)).join('') +
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
  const count = (f) => stories.filter(f).length;

  const columns = COLUMNS.map((col) => {
    const inCol = stories.filter((s) => s.status === col.status);
    let body;
    if (col.status === 'backlog') {
      // Priority only means something inside the backlog; elsewhere it is
      // absent by design, so lanes would be a column of one empty heading.
      body = PRIORITIES.map((p) =>
        lane(p, inCol.filter((s) => s.priority === p), byId),
      ).join('');
      const noPriority = inCol.filter((s) => !PRIORITIES.includes(s.priority));
      body += lane('unprioritised', noPriority, byId);
    } else {
      body = inCol.map((s) => card(s, byId)).join('');
    }
    return (
      `<section class="col" data-status="${esc(col.status)}">` +
      `<h2>${esc(col.title)} <span class="count">${inCol.length}</span></h2>` +
      `${body}</section>`
    );
  }).join('');

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
input[type=search]{background:var(--panel);border:1px solid var(--line);color:var(--ink);border-radius:6px;padding:5px 9px;min-width:200px}
.chip{background:var(--panel);border:1px solid var(--line);color:var(--dim);border-radius:99px;padding:3px 9px;font-size:12px;cursor:pointer;font-family:inherit}
.chip.on{border-color:var(--accent);color:var(--accent)}
.epics{display:flex;gap:6px;flex-wrap:wrap;padding:10px 20px;border-bottom:1px solid var(--line)}
.board{display:grid;grid-template-columns:repeat(3,minmax(320px,1fr));gap:14px;padding:16px 20px;align-items:start}
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
details{margin-top:7px}
summary{cursor:pointer;color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:.05em}
details p{margin:6px 0 0;color:#c3d2e2;font-size:12.5px;white-space:pre-wrap}
code{background:#0c131b;border:1px solid var(--line);border-radius:3px;padding:0 4px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11.5px}
a.xref{color:var(--accent)}
.findings{margin:12px 20px;padding:10px 14px;border:1px solid #7a4b12;background:#2a1d0c;border-radius:8px;color:#ffcf8a}
.findings ul{margin:6px 0 0;padding-left:18px}
.hide{display:none}
@media(max-width:1000px){.board{grid-template-columns:1fr}}
</style></head><body>
<header class="top">
  <h1>Board</h1>
  <span class="meta">${esc(stories.length)} stories &middot; ${esc((data.epics ?? []).length)} epics &middot; rendered ${esc(today)} from docs/board.json &middot; <span id="live">live</span></span>
  <div class="controls">
    <input type="search" id="q" placeholder="filter cards..." autocomplete="off">
    <button class="chip" id="blockedOnly">blocked only</button>
  </div>
</header>
<div class="epics">${epicRows}</div>
${findingsBlock}
<main class="board">${columns}</main>
<script>
const q=document.getElementById('q');
const blockedBtn=document.getElementById('blockedOnly');
let epic=null,blockedOnly=false;
function apply(){
  const t=q.value.trim().toLowerCase();
  for(const c of document.querySelectorAll('.card')){
    const okText=!t||c.dataset.text.includes(t);
    const okEpic=!epic||c.dataset.epic===epic;
    const okBlocked=!blockedOnly||c.dataset.blocked==='yes';
    c.classList.toggle('hide',!(okText&&okEpic&&okBlocked));
  }
  for(const l of document.querySelectorAll('.lane')){
    const any=[...l.querySelectorAll('.card')].some(c=>!c.classList.contains('hide'));
    l.classList.toggle('hide',!any);
  }
}
q.addEventListener('input',apply);
blockedBtn.addEventListener('click',()=>{blockedOnly=!blockedOnly;blockedBtn.classList.toggle('on',blockedOnly);apply();});
for(const b of document.querySelectorAll('[data-filter-epic]')){
  b.addEventListener('click',()=>{
    const k=b.dataset.filterEpic;
    epic=epic===k?null:k;
    for(const o of document.querySelectorAll('[data-filter-epic]'))o.classList.toggle('on',o.dataset.filterEpic===epic);
    apply();
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
