// Guards the CLAIMS in the documentation the way check-release-drift guards the
// version claims - and for the same reason, which is that a hand-maintained
// claim decays and nothing tells anyone.
//
// WHAT THIS EXISTS TO CATCH (audit 2026-08-26). Nine documents were found
// asserting things the repo had already disproved. The pattern across all nine
// was not "docs go stale" - every doc goes stale - it was that a stale RECORD is
// harmless and a stale INSTRUCTION is dangerous, and nothing here distinguished
// them. The worst case was features/content-preserving-native-reroute.md: an
// UNBUILT plan, Status Proposed, zero code, still telling a future reader to
// build for two shells six weeks after ADR 0002 deleted the second one. Nobody
// had followed it yet, so nobody had discovered it was wrong. A plan nobody has
// started is precisely the one that gets followed literally.
//
// THE VOCABULARY IS THE MECHANISM. Every doc declares a status, and the status
// says whether its instructions are binding:
//
//   Living      - describes how things are NOW and is kept true. Instructions
//                 bind. Checked hardest.
//   Proposed    - a plan not yet built. Instructions bind IF executed, so it is
//                 checked, and it EXPIRES: an unreconfirmed plan is the failure
//                 mode above.
//   Record      - a dated account of what happened. Its instructions are
//                 historical and exempt, which is what makes the other rules
//                 affordable - a repo full of history does not have to be
//                 rewritten, only labelled.
//   Superseded  - replaced, and must name what replaced it.
//
// PROSE KEYS, NOT FRONTMATTER, for the reason check-release-drift already
// states about the version line: these are read by people far more often than by
// this script, so the script reads what a person would write. A machine field
// nobody reads is a machine field nobody updates.
//
// THE HIGHEST-VALUE RULE IS THE DULLEST. "A live doc must not name a deleted
// path" would, on its own, have caught six of the nine documents in that audit,
// automatically, on the commit that deleted the directory. It needs no judgement
// and it cannot be argued with.
//
// The pure half takes facts and returns findings; main() gathers the facts. That
// split is what lets the rules be pinned without a repo or a filesystem.

import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const appDir = join(__dirname, '..');
const toolkitDir = join(appDir, '..', '..');
const repoRoot = join(toolkitDir, '..');

/** How long a Proposed plan may sit unreconfirmed before it must be renewed or retired. */
export const PROPOSED_STALE_DAYS = 60;

/**
 * Line-level opt-out, for the one case the status vocabulary cannot express: a
 * LIVING document that legitimately quotes history. backlog.md is the example -
 * it states what is open now, so it is Living, and its resolved sections still
 * have to be able to say what they resolved.
 *
 * Invisible when rendered, greppable, and too deliberate to type by accident.
 * Every use is COUNTED and reported, because a suppression nobody can see is how
 * this check would quietly stop meaning anything - the same reason the release
 * check reports what it could not measure instead of printing a clean line.
 */
const SUPPRESS = '<!--drift-ok-->';

const STATUSES = ['Living', 'Proposed', 'Record', 'Superseded'];

// Only the first lines are scanned for the header keys. Without the bound, a
// status word occurring anywhere in a long document would satisfy the rule and
// the check would pass on a file that never declared anything.
const HEADER_LINES = 40;

/**
 * Things that no longer exist, and the decision that removed each. A live
 * document naming one of these is either an instruction that cannot be followed
 * or a description of something that is not there.
 *
 * Written as a token plus an exception rather than a clever regex: the point is
 * that the next person can add a line here the day they delete something, which
 * is the only moment anyone knows the whole list.
 */
const RETIRED = [
  {
    token: 'apps/local-app',
    since: 'ADR 0002 (2026-08-17)',
    fix: 'the local shell was dropped; apps/cribl-app is the only shell.',
  },
  {
    token: 'npm run local',
    since: 'ADR 0002 (2026-08-17)',
    fix: 'there is no local host to run.',
  },
  {
    token: 'Cribl-Microsoft_IntegrationSolution',
    since: 'the 2026-07-13 deprecation',
    // The tree still EXISTS, one directory down. Naming it without the prefix is
    // what sends a reader to a path that is not there.
    unless: /deprecated[/\\]Cribl-Microsoft_IntegrationSolution/,
    fix: 'it lives under deprecated/ now - write the full path.',
  },
  {
    token: 'both shells',
    since: 'ADR 0002 (2026-08-17)',
    fix: 'there is one shell. This phrase is almost always a build instruction.',
  },
  {
    token: 'dual-shell',
    since: 'ADR 0002 (2026-08-17)',
    fix: 'there is one shell.',
  },
  {
    token: 'Browse Samples',
    since: 'ADR 0003 (2026-08-18)',
    fix: 'the sample browser was removed; LogTypeRecommendation replaced it.',
  },
];

/**
 * Repo-relative paths named in backticks. Deliberately narrow: it must live
 * under a known root AND either carry a real extension or end in a slash. A
 * looser rule matches prose like `_raw` or `Status:` and drowns the real
 * findings, and a check people learn to ignore is worse than no check.
 */
const PATH_IN_BACKTICKS =
  /`((?:soc-optimizationtoolkit|packages|apps|docs|scripts|deprecated|Azure|KnowledgeArticles)\/[A-Za-z0-9._/-]*?(?:\.(?:ts|tsx|mjs|js|json|md|yml|yaml|ps1|html|css)|\/))`/g;

/**
 * @param {{
 *   docs: {path: string, text: string}[],
 *   adrs: {path: string, text: string}[],
 *   existingPaths: Set<string>,
 *   today: string,
 * }} facts
 * @returns {{errors: string[], warnings: string[], notes: string[], checked: number}}
 */
export function evaluateDocsDrift(facts) {
  const errors = [];
  const warnings = [];
  const notes = [];

  for (const doc of facts.docs) {
    const { raw, status } = readStatus(doc.text);

    if (raw === null) {
      errors.push(
        `${doc.path} declares no "Status:" in its first ${HEADER_LINES} lines. Start one with ${STATUSES.join(' | ')} - a doc that will not say whether its instructions bind cannot be checked, and every rule below is skipped for it.`,
      );
      continue;
    }

    if (status === null) {
      errors.push(
        `${doc.path} has "Status: ${truncate(raw)}", which does not START with ${STATUSES.join(' | ')}. Prose may follow the word - "Status: Record - IMPLEMENTED 2026-08-05" is fine, and keeping that sentence is the point.`,
      );
      continue;
    }

    if (status === 'Superseded' && !namesSuccessor(doc.text, raw)) {
      errors.push(
        `${doc.path} is Superseded but names no successor. Add "Superseded by: ..." - a reader who finds this file needs somewhere to go, or they will use it anyway.`,
      );
    }

    // Records and Superseded docs are EXEMPT from everything below. That is the
    // whole design: history is allowed to describe a world that no longer
    // exists, and labelling it is cheaper than rewriting it.
    if (status === 'Record' || status === 'Superseded') continue;

    for (const finding of retiredMentions(doc)) errors.push(finding);

    if (status === 'Living') {
      for (const finding of brokenPaths(doc, facts.existingPaths)) errors.push(finding);
    }

    if (status === 'Proposed') {
      const confirmed = readKey(doc.text, 'Last-confirmed');
      if (confirmed === null) {
        errors.push(
          `${doc.path} is Proposed but carries no "Last-confirmed: YYYY-MM-DD". An unbuilt plan is the one document nobody discovers is wrong, because nobody has followed it yet.`,
        );
      } else {
        const age = daysBetween(confirmed, facts.today);
        if (age === null) {
          errors.push(`${doc.path} has "Last-confirmed: ${confirmed}", which is not a YYYY-MM-DD date.`);
        } else if (age > PROPOSED_STALE_DAYS) {
          errors.push(
            `${doc.path} is Proposed and was last confirmed ${age} days ago (limit ${PROPOSED_STALE_DAYS}). Re-read it against today's code and either move Last-confirmed forward, or change Status to Record and say what overtook it.`,
          );
        } else if (age > PROPOSED_STALE_DAYS - 14) {
          warnings.push(
            `${doc.path} is Proposed and falls due for re-confirmation in ${PROPOSED_STALE_DAYS - age} day(s).`,
          );
        }
      }
    }
  }

  for (const adr of facts.adrs) {
    // ADRs keep their own vocabulary - Proposed / Accepted / Superseded is the
    // convention everywhere, and bending it to match the doc statuses would be
    // this check inventing a house style rather than enforcing one.
    const raw = readKey(adr.text, 'Status');
    if (raw === null) {
      errors.push(`${adr.path} declares no "Status:".`);
      continue;
    }
    if (leadingWord(raw)?.toLowerCase() !== 'accepted') continue;

    const invalidates = readKey(adr.text, 'Invalidates');
    if (invalidates === null) {
      errors.push(
        `${adr.path} is Accepted but has no "Invalidates:" line. Write "Invalidates: none" if it broke nothing. This is the field that would have carried ADR 0002 into the six documents it silently falsified.`,
      );
      continue;
    }

    if (invalidates.trim().toLowerCase() === 'none') continue;

    const adrNumber = /(\d{4})/.exec(adr.path)?.[1];
    for (const named of invalidates.split(',').map((s) => s.trim()).filter(Boolean)) {
      const target = facts.docs.find((d) => d.path.endsWith(named));
      if (target === undefined) {
        errors.push(`${adr.path} invalidates "${named}", which is not a document this check can find.`);
        continue;
      }
      // The loop is only closed when the invalidated document ACKNOWLEDGES the
      // decision. An ADR that lists its casualties and changes nothing is the
      // state this repo was already in.
      if (adrNumber !== undefined && !mentionsAdr(target.text, adrNumber)) {
        errors.push(
          `${adr.path} invalidates ${named}, but that file never mentions ADR ${adrNumber}. Add the banner there: the decision has to reach the document it broke, or it only reached the decision log.`,
        );
      }
    }
  }

  const board = facts.docs.find((d) => d.path.endsWith('docs/board.md'));
  if (board !== undefined) {
    for (const finding of boardFindings(board)) errors.push(finding);
  }

  // Counted and said out loud. A suppression nobody can see is how this check
  // would quietly stop meaning anything.
  const suppressed = facts.docs.reduce((n, d) => n + countOccurrences(d.text, SUPPRESS), 0);
  if (suppressed > 0) {
    notes.push(
      `${suppressed} line(s) carry ${SUPPRESS}. Each one is a live document quoting history on purpose - grep for the marker if that number looks high.`,
    );
  }

  return {
    errors,
    warnings,
    notes,
    checked: facts.docs.length + facts.adrs.length,
    suppressed,
  };
}

/**
 * The status word, plus whatever the author wrote after it.
 *
 * THE PROSE IS KEPT ON PURPOSE. These headers already said useful things -
 * "BINDING (user directive 2026-08-10)", "IMPLEMENTED. Decision taken
 * 2026-08-05" - and a check that demanded four bare words would have deleted
 * every one of them to satisfy a parser. The word leads so the machine can read
 * it; the sentence follows so the person still can.
 */
function readStatus(text) {
  const raw = readKey(text, 'Status');
  if (raw === null) return { raw: null, status: null };
  const word = leadingWord(raw);
  const status = STATUSES.find((s) => s.toLowerCase() === word?.toLowerCase()) ?? null;
  return { raw, status };
}

function leadingWord(value) {
  return /^\s*([A-Za-z]+)/.exec(value)?.[1] ?? null;
}

/** Either a "Superseded by:" key, or the successor named inline on the Status line. */
function namesSuccessor(text, raw) {
  if (readKey(text, 'Superseded by') !== null) return true;
  return /superseded\s+(?:in\s+part\s+)?by\s+\S/i.test(raw);
}

/**
 * The board's own structural rules. Small on purpose: a board is a working
 * surface, and a checker that argued with its prose would just get the prose
 * removed. These three catch the ways it rots SILENTLY.
 *
 * Two IDs the same is the one that actually bites - the second card looks
 * tracked, gets referenced in a commit message, and points at the wrong story.
 */
export function boardFindings(board) {
  const out = [];
  // Epic keys are the backticked first cell of the epics table: | `REL` | ... |
  const declared = new Set(
    [...board.text.matchAll(/^\|\s*`([A-Z]{1,5})`\s*\|/gm)].map((m) => m[1]),
  );
  // Stories are bolded ids at the head of a bullet: - **REL-1** Do the thing
  const stories = [...board.text.matchAll(/^\s*-\s+\*\*([A-Z]{1,5}-[A-Z]?\d+)\*\*/gm)];

  const seen = new Map();
  const used = new Set();
  for (const [, id] of stories) {
    used.add(id.split('-')[0]);
    seen.set(id, (seen.get(id) ?? 0) + 1);
  }

  for (const [id, count] of seen) {
    if (count > 1) {
      out.push(
        `${board.path} lists ${id} ${count} times. A duplicated id looks tracked, gets named in a commit message, and points at whichever card the reader found first.`,
      );
    }
  }

  for (const epic of [...used].sort()) {
    if (!declared.has(epic)) {
      out.push(
        `${board.path} has ${epic}-* stories but no \`${epic}\` row in the epics table. Either add the epic or re-key the stories - an epic nobody declared is one nobody is tracking.`,
      );
    }
  }

  for (const epic of [...declared].sort()) {
    if (!used.has(epic)) {
      out.push(
        `${board.path} declares epic \`${epic}\` but no story carries it. An epic that emptied out has either shipped, in which case say so, or lost its work.`,
      );
    }
  }

  return out;
}

function countOccurrences(text, needle) {
  return text.split(needle).length - 1;
}

function truncate(value) {
  return value.length > 60 ? `${value.slice(0, 60)}...` : value;
}

/** Reads a "Key: value" line from the header block. Case-insensitive on the key. */
function readKey(text, key) {
  const head = text.split('\n').slice(0, HEADER_LINES);
  const pattern = new RegExp(`^\\s*(?:>\\s*)?(?:\\*\\*)?${key}(?:\\*\\*)?\\s*:\\s*(.+?)\\s*$`, 'i');
  for (const line of head) {
    const hit = pattern.exec(line);
    if (hit) return hit[1].replace(/\*\*/g, '').trim();
  }
  return null;
}

/** "ADR 0002", "ADR-0002" and "adr/0002-..." all count as acknowledgement. */
function mentionsAdr(text, number) {
  return new RegExp(`ADR[\\s-]*${number}|adr/${number}`, 'i').test(text);
}

function* retiredMentions(doc) {
  const lines = doc.text.split('\n');
  for (const entry of RETIRED) {
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!line.toLowerCase().includes(entry.token.toLowerCase())) continue;
      if (entry.unless && entry.unless.test(line)) continue;
      if (line.includes(SUPPRESS)) continue;
      yield `${doc.path}:${i + 1} names "${entry.token}", retired by ${entry.since} - ${entry.fix} If this line is history rather than instruction, the file's Status should be Record.`;
    }
  }
}

function* brokenPaths(doc, existingPaths) {
  const lines = doc.text.split('\n');
  const seen = new Set();
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].includes(SUPPRESS)) continue;
    for (const hit of lines[i].matchAll(PATH_IN_BACKTICKS)) {
      const named = hit[1].replace(/\/$/, '');
      if (seen.has(named)) continue;
      seen.add(named);
      // Written from the repo root or from inside the toolkit - both are normal
      // in these docs, and rejecting one of them would be a rule about house
      // style wearing a correctness rule's clothes.
      if (existingPaths.has(named) || existingPaths.has(`soc-optimizationtoolkit/${named}`)) continue;
      yield `${doc.path}:${i + 1} points at \`${named}\`, which does not exist. A Living document naming a path nobody can open is an instruction that cannot be followed.`;
    }
  }
}

/** Whole days from an ISO date to another, or null if either will not parse. */
function daysBetween(from, to) {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.round((end - start) / 86_400_000);
}

async function listMarkdown(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listMarkdown(full)));
    else if (entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

/** Every tracked path, so a reference can be checked without a stat() per mention. */
async function listRepoPaths(dir, acc = new Set()) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
    const full = join(dir, entry.name);
    acc.add(relative(repoRoot, full).split(sep).join(posix.sep));
    if (entry.isDirectory()) await listRepoPaths(full, acc);
  }
  return acc;
}

async function gatherFacts(today) {
  const docsDir = join(toolkitDir, 'docs');
  const files = await listMarkdown(docsDir);
  const contextPath = join(toolkitDir, 'CONTEXT.md');
  if (await stat(contextPath).then(() => true, () => false)) files.push(contextPath);

  const read = async (path) => ({
    path: relative(repoRoot, path).split(sep).join(posix.sep),
    text: await readFile(path, 'utf8'),
  });

  const all = await Promise.all(files.map(read));
  const isAdr = (d) => d.path.includes('/adr/');

  return {
    docs: all.filter((d) => !isAdr(d)),
    adrs: all.filter(isAdr),
    existingPaths: await listRepoPaths(repoRoot),
    today,
  };
}

function annotate(level, message) {
  const prefix = process.env.GITHUB_ACTIONS === 'true' ? `::${level}::` : `${level}: `;
  console.log(`${prefix}${message}`);
}

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  const facts = await gatherFacts(today);
  const { errors, warnings, notes, checked } = evaluateDocsDrift(facts);

  for (const note of notes) annotate('notice', note);
  for (const warning of warnings) annotate('warning', warning);
  for (const error of errors) annotate('error', error);

  if (errors.length > 0) {
    console.log(`\nDocs drift: ${errors.length} error(s), ${warnings.length} warning(s) across ${checked} document(s).`);
    process.exitCode = 1;
    return;
  }

  console.log(
    `${checked} document(s) declare a status, and every Living and Proposed one is free of retired paths, broken references and expired plans (as of ${today}).`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
