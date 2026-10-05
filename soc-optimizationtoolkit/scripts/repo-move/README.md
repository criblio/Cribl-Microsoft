# Moving the app to its own repository

Status: Living - how to run the extraction; corrected whenever the scripts change.

The plan, the decisions and the full inventory are in
[docs/repo-migration-plan.md](../../docs/repo-migration-plan.md). This folder is
the tooling that carries them out.

## What it produces

`extract.sh` clones `criblio/Cribl-Microsoft` (it never touches your working
copy), rewrites the clone with `git filter-repo`, and leaves a new repository
with no remote:

- the full history of `soc-optimizationtoolkit/`, with every committed release
  tarball dropped from it (the current one is re-added);
- a root built by `postprocess.mjs`: README, `QUICK_START.md` (its links into
  the old repository made absolute), `CLAUDE.md` composed from this repository's
  binding sections plus `root/CLAUDE.parts.md`, `.gitignore`, `.gitattributes`,
  LICENSE, NOTICE, the CI workflow and the `.claude` hooks and skills;
- without the DCR-template schema extractor and its check: their source stays
  in the old repository and `dcr-template-schemas.json` ships frozen;
- with every backticked pointer to `deprecated/`, `Azure/` or
  `KnowledgeArticles/` turned into a link to that path in the old repository.

Every edit asserts the text it replaces, so if this repository has moved on
since the scripts were written, the extraction stops with the line it could not
find rather than producing a half-edited repository.

## Rehearse

```bash
pip install git-filter-repo
bash soc-optimizationtoolkit/scripts/repo-move/extract.sh "$(pwd)" /tmp/new-repo main
cd /tmp/new-repo/soc-optimizationtoolkit
npm ci && npm run lint && npm run typecheck && npm test && npm run build
npm run check-listings && npm run check-classnames && npm run check-release
npm run check-docs && npm run check-board
```

`check-board-freshness` needs an `origin/main` to diff against, so it reports
"could not diff" until the repository is pushed.

## Move (operator)

1. Create the repository in the criblio organization (empty: no README,
   license or .gitignore - the extraction brings its own).
2. Run `extract.sh` against the old repository's `main`, then the rehearsal
   gates above.
3. `git remote add origin <new-repo-url>` and `git push -u origin main`.
4. Turn on branch protection for `main` and require the CI workflow.
5. Back in the old repository: point its README at the new one, and keep it
   archived rather than deleted - SHA citations in the moved docs refer to its
   history.
