#!/usr/bin/env bash
# Extract the SOC Optimization Toolkit into a new repository (DBT-130/DBT-132).
#
# Decisions it implements (docs/repo-migration-plan.md, "Decided 2026-10-05"):
#   - the app keeps its soc-optimizationtoolkit/ subdirectory;
#   - the new repository carries ONLY the app and what it strictly needs - no
#     DCR ARM templates, no deprecated tree, no KnowledgeArticles;
#   - history is preserved for everything under soc-optimizationtoolkit/,
#     minus every committed release tarball (most of the pack size); the
#     current tarball is re-added in the setup commit.
#
# It never touches the source repository: it clones it, rewrites the CLONE,
# and leaves the result in OUT_DIR with no remote. Pushing it to the new
# criblio repository is a separate, deliberate step (see README.md here).
#
# Usage: extract.sh <source-repo> <out-dir> [<source-ref>]
#   source-repo  path or URL of criblio/Cribl-Microsoft
#   out-dir      where the new repository is created (must not exist)
#   source-ref   branch to extract (default: main)
# Needs git-filter-repo on PATH or as `python -m git_filter_repo`.

set -euo pipefail

SRC="${1:?source repository path or URL}"
OUT="${2:?output directory (must not exist)}"
REF="${3:-main}"
APP="soc-optimizationtoolkit"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -e "$OUT" ]; then
  echo "refusing: $OUT already exists" >&2
  exit 1
fi

if git filter-repo --version >/dev/null 2>&1; then
  FILTER_REPO=(git filter-repo)
elif python -m git_filter_repo --version >/dev/null 2>&1; then
  FILTER_REPO=(python -m git_filter_repo)
else
  echo "git-filter-repo is not installed (pip install git-filter-repo)" >&2
  exit 1
fi

# 1. A fresh, single-branch clone - filter-repo refuses to rewrite a repository
#    that is not a fresh clone, which is the safety we want.
git clone --no-local --single-branch --branch "$REF" "$SRC" "$OUT"
cd "$OUT"
SOURCE_HEAD="$(git rev-parse HEAD)"

# The files the new root takes from the source, read BEFORE filtering removes
# them from this clone.
STAGE="$(mktemp -d)"
for f in .gitattributes LICENSE NOTICE CLAUDE.md QUICK_START.md .github/workflows/soc-toolkit-ci.yml; do
  mkdir -p "$STAGE/$(dirname "$f")"
  git show "HEAD:$f" > "$STAGE/$f"
done
mkdir -p "$STAGE/.claude"
git archive HEAD .claude | tar -x -C "$STAGE"
TARBALL="$(git ls-files "$APP/apps/cribl-app/release/*.tgz" | head -n 1)"
if [ -z "$TARBALL" ]; then
  echo "no release tarball under $APP/apps/cribl-app/release/" >&2
  exit 1
fi
mkdir -p "$STAGE/$(dirname "$TARBALL")"
git show "HEAD:$TARBALL" > "$STAGE/$TARBALL"

# 2. Keep only the app's history, then drop every release tarball from it.
"${FILTER_REPO[@]}" --force --path "$APP/"
"${FILTER_REPO[@]}" --force --invert-paths --path-glob "$APP/apps/cribl-app/release/*.tgz"

# 3. The setup commit: new root files, the current tarball, and the edits the
#    "only the app" decision requires.
# Dropping every tarball also removed release/, which held nothing else.
mkdir -p "$(dirname "$TARBALL")"
cp "$STAGE/$TARBALL" "$TARBALL"
node "$HERE/postprocess.mjs" "$OUT" "$STAGE" "$SOURCE_HEAD"
rm -rf "$STAGE"

git add -A
git -c core.autocrlf=false commit -q -m "Start the SOC Optimization Toolkit repository

Extracted from criblio/Cribl-Microsoft at $SOURCE_HEAD with git filter-repo:
the history of soc-optimizationtoolkit/ only, with committed release
tarballs dropped from it. This commit adds the repository root (README,
CLAUDE.md, .gitignore, .gitattributes, LICENSE, NOTICE, CI, .claude), the
current release tarball, and removes the DCR-template schema extractor and
its check, whose source stays in the old repository."

# The audit marker named a commit the rewrite replaced; restart it here.
git rev-parse HEAD > .claude/.last-architecture-audit
git add .claude/.last-architecture-audit
git commit -q -m "Seed the architecture audit point at the repository start"

echo
echo "Extracted to $OUT"
echo "  source: $SRC @ $SOURCE_HEAD"
echo "  commits: $(git rev-list --count HEAD)"
echo "  size: $(git count-objects -vH | awk '/size-pack/ {print $2, $3}')"
