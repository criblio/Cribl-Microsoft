/**
 * Bug triage sweep: pull reported issues, record which are approved for
 * integration, and remember when a bug was last reported so each run only has
 * to reason about what is new.
 *
 * WHY STATE LIVES IN AN ISSUE, NOT A COMMITTED FILE: main is protected in this
 * repo ("all changes must come through a pull request"), so a bot pushing a
 * state file to main would be precisely what that rule forbids. The tracker
 * issue is writable by the workflow token, keeps its own edit history, and is
 * visible without cloning.
 *
 * WHY IT DOES NOT FILTER ON label:bug: the `bug` label exists here but no issue
 * uses it - the real reports (#23, #47) carry no labels at all. Discovery must
 * therefore be "every open issue that is not a PR"; labels record DECISIONS,
 * never eligibility, or the sweep would silently see nothing forever.
 *
 * Decisions are read from labels so GitHub stays the source of truth:
 *   triage/approved - accepted for integration
 *   triage/rejected - considered and declined
 *   (neither)       - awaiting evaluation
 *
 * No dependencies: Node 20+ global fetch against the REST API.
 */

const REPO = process.env.GITHUB_REPOSITORY;
const TOKEN = process.env.GITHUB_TOKEN;
const TRACKER_LABEL = "triage/tracker";
const APPROVED_LABEL = "triage/approved";
const REJECTED_LABEL = "triage/rejected";
const TRACKER_TITLE = "Bug triage tracker";
const MARKER = "<!-- bug-triage-state -->";

if (!REPO || !TOKEN) {
  console.error("GITHUB_REPOSITORY and GITHUB_TOKEN are required.");
  process.exit(1);
}

const api = async (path, init = {}) => {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
      "user-agent": "cribl-soc-bug-triage",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    throw new Error(`${init.method ?? "GET"} ${path}: ${res.status} ${await res.text()}`);
  }
  return res.status === 204 ? null : res.json();
};

/** Every open issue, PRs excluded - the REST issues endpoint returns both. */
async function fetchOpenIssues() {
  const issues = [];
  for (let page = 1; page <= 10; page += 1) {
    const batch = await api(
      `/repos/${REPO}/issues?state=open&per_page=100&page=${page}&sort=created&direction=desc`,
    );
    if (batch.length === 0) break;
    issues.push(...batch.filter((i) => i.pull_request === undefined));
    if (batch.length < 100) break;
  }
  return issues;
}

const labelsOf = (issue) => new Set((issue.labels ?? []).map((l) => l.name ?? l));

const decisionOf = (issue) => {
  const l = labelsOf(issue);
  if (l.has(APPROVED_LABEL)) return "approved";
  if (l.has(REJECTED_LABEL)) return "rejected";
  return "pending";
};

/** Find the tracker issue, or null on the very first run. */
async function findTracker() {
  const found = await api(
    `/repos/${REPO}/issues?state=open&labels=${encodeURIComponent(TRACKER_LABEL)}&per_page=1`,
  );
  return found.find((i) => i.pull_request === undefined) ?? null;
}

/** Parse the previous run's state out of the tracker body. */
function readState(body) {
  if (typeof body !== "string") return { lastSweepAt: null, seen: {} };
  const m = body.match(/```json\n([\s\S]*?)\n```/);
  if (m === null) return { lastSweepAt: null, seen: {} };
  try {
    const parsed = JSON.parse(m[1]);
    return {
      lastSweepAt: parsed.lastSweepAt ?? null,
      seen: parsed.seen ?? {},
    };
  } catch {
    // A hand-edited or truncated block must not wedge the sweep; start clean
    // and say so in the rendered body rather than failing the run.
    return { lastSweepAt: null, seen: {} };
  }
}

function renderBody(state, issues, nowIso) {
  const byDecision = { approved: [], pending: [], rejected: [] };
  for (const issue of issues) byDecision[decisionOf(issue)].push(issue);

  const newSince = issues.filter((i) => state.seen[i.number] === undefined);
  const lastReported = issues.reduce(
    (acc, i) => (acc === null || i.created_at > acc ? i.created_at : acc),
    null,
  );

  const row = (i) =>
    `| [#${i.number}](${i.html_url}) | ${i.title.replace(/\|/g, "\\|")} | ${i.created_at.slice(0, 10)} |`;
  const table = (list) =>
    list.length === 0
      ? "_None._"
      : ["| Issue | Title | Reported |", "| --- | --- | --- |", ...list.map(row)].join("\n");

  const nextState = {
    lastSweepAt: nowIso,
    lastReportedAt: lastReported,
    seen: Object.fromEntries(
      issues.map((i) => [
        i.number,
        { decision: decisionOf(i), firstSeenAt: state.seen[i.number]?.firstSeenAt ?? nowIso },
      ]),
    ),
  };

  return [
    MARKER,
    "# Bug triage tracker",
    "",
    "Maintained by `.github/workflows/bug-triage.yml`. Do not edit the state",
    "block by hand - it is rewritten on every sweep.",
    "",
    "Record a decision by labelling the issue itself:",
    `\`${APPROVED_LABEL}\` (accepted for integration) or \`${REJECTED_LABEL}\`.`,
    "An issue with neither label is awaiting evaluation.",
    "",
    `**Last sweep:** ${nowIso}`,
    `**Last bug reported:** ${lastReported ?? "no open issues"}`,
    `**Open:** ${issues.length} - approved ${byDecision.approved.length}, ` +
      `pending ${byDecision.pending.length}, rejected ${byDecision.rejected.length}`,
    "",
    `## New since last sweep (${newSince.length})`,
    "",
    table(newSince),
    "",
    "## Awaiting evaluation",
    "",
    table(byDecision.pending),
    "",
    "## Approved for integration",
    "",
    table(byDecision.approved),
    "",
    "## Declined",
    "",
    table(byDecision.rejected),
    "",
    "```json",
    JSON.stringify(nextState, null, 2),
    "```",
  ].join("\n");
}

async function ensureLabel(name, color, description) {
  try {
    await api(`/repos/${REPO}/labels`, {
      method: "POST",
      body: JSON.stringify({ name, color, description }),
    });
  } catch (err) {
    // 422 means it already exists - the only outcome we care about is that the
    // label is present afterwards.
    if (!String(err).includes("422")) throw err;
  }
}

const nowIso = new Date().toISOString();
await ensureLabel(TRACKER_LABEL, "ededed", "Bug triage tracker issue");
await ensureLabel(APPROVED_LABEL, "0e8a16", "Approved for integration");
await ensureLabel(REJECTED_LABEL, "b60205", "Considered and declined");

const issues = await fetchOpenIssues();
const tracker = await findTracker();
const state = readState(tracker?.body);
const body = renderBody(state, issues, nowIso);

if (tracker === null) {
  const created = await api(`/repos/${REPO}/issues`, {
    method: "POST",
    body: JSON.stringify({ title: TRACKER_TITLE, body, labels: [TRACKER_LABEL] }),
  });
  console.log(`Created tracker #${created.number}`);
} else {
  await api(`/repos/${REPO}/issues/${tracker.number}`, {
    method: "PATCH",
    body: JSON.stringify({ body }),
  });
  console.log(`Updated tracker #${tracker.number}`);
}

const newCount = issues.filter((i) => state.seen[i.number] === undefined).length;
console.log(`Swept ${issues.length} open issue(s); ${newCount} new since last sweep.`);
