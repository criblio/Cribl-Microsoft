// Does this change move work that the board never heard about?
//
// The board is only a source of truth if it keeps up. `check-board` proves
// board.md matches board.json and that the data is coherent; neither says the
// board still DESCRIBES the repo. That gap was covered by a Claude Code stop
// hook, which fires for whoever has hooks enabled and for nobody else - not on
// a plain `git push`, and not in CI.
//
// This is the same rule where everyone meets it. It is deliberately a WARNING,
// not a failure: a change can legitimately touch source without moving a card
// (a typo fix, a rename), and a check that blocks on judgement gets routed
// around. What it cannot be is silent.
//
// The pure half takes the changed paths and returns a verdict; main() asks git.

/** Paths whose change could alter what the board should say. */
export const WATCHED = [
  'soc-optimizationtoolkit/packages',
  'soc-optimizationtoolkit/apps/cribl-app/src',
  'soc-optimizationtoolkit/apps/cribl-app/scripts',
  'soc-optimizationtoolkit/scripts',
  'soc-optimizationtoolkit/docs/backlog.md',
  'soc-optimizationtoolkit/docs/adr',
];

/** The board's own data. Touching it IS updating the board. */
export const BOARD = 'soc-optimizationtoolkit/docs/board.json';

/**
 * @param {readonly string[]} changedPaths
 * @returns {{stale: boolean, board: boolean, watched: string[]}}
 */
export function freshness(changedPaths) {
  const paths = [...(changedPaths ?? [])].filter((p) => p && p.trim() !== '');
  // The generated board.md does not count: it can only change because
  // board.json did, or because someone hand-edited it, and check-board already
  // fails on the second.
  const board = paths.includes(BOARD);
  const watched = paths.filter((p) => WATCHED.some((w) => p === w || p.startsWith(`${w}/`)));
  return { stale: watched.length > 0 && !board, board, watched };
}

/**
 * @param {{stale: boolean, board: boolean, watched: string[]}} verdict
 * @param {string} base
 */
export function report(verdict, base) {
  if (verdict.watched.length === 0) {
    return `Board freshness: nothing under the watched paths changed against ${base}.`;
  }
  if (!verdict.stale) {
    return `Board freshness: ${verdict.watched.length} watched file(s) changed and docs/board.json moved with them.`;
  }
  const shown = verdict.watched.slice(0, 10);
  const more = verdict.watched.length - shown.length;
  return [
    `Board freshness: ${verdict.watched.length} watched file(s) changed against ${base}, and docs/board.json did not.`,
    '',
    ...shown.map((p) => `  ${p}`),
    ...(more > 0 ? [`  ... and ${more} more`] : []),
    '',
    'If this work belongs to a card, move it. If a card is now done, say how it was',
    'verified. If neither applies - a rename, a typo, a doc tweak - this is fine and',
    'nothing needs doing: it is a note, not a gate.',
  ].join('\n');
}

async function main() {
  const { execFileSync } = await import('node:child_process');
  // On a PR, compare against the merge base; locally, against origin/main.
  const base = process.env.GITHUB_BASE_REF
    ? `origin/${process.env.GITHUB_BASE_REF}`
    : (process.argv.find((a) => a.startsWith('--base='))?.slice('--base='.length) ??
      'origin/main');

  let changed = [];
  try {
    const out = execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], {
      encoding: 'utf8',
    });
    changed = out.split('\n').map((s) => s.trim());
  } catch (e) {
    // No base to compare against is not a board problem; say so and pass.
    console.log(`Board freshness: could not diff against ${base} (${e}). Skipping.`);
    return;
  }

  const verdict = freshness(changed);
  const text = report(verdict, base);
  if (verdict.stale && process.env.GITHUB_ACTIONS === 'true') {
    // A GitHub warning annotation: visible on the PR, never blocking.
    console.log(`::warning title=Board may be stale::${text.split('\n')[0]}`);
  }
  console.log(text);
}

if (process.argv[1] && (await import('node:url')).fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
