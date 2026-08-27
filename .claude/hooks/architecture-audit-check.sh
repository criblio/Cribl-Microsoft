#!/usr/bin/env bash
# Stop hook: ask for an architecture audit once enough commits have accumulated.
#
# Cadence is COMMIT COUNT rather than wall-clock time, so the audit tracks actual
# change instead of firing during a coffee break. Running on Stop means it never
# interrupts mid-task - it fires when a response finishes.
#
# The marker file holds the commit the last audit ran at; the architecture-audit
# skill rewrites it when it completes, which is what resets the counter.
set -uo pipefail

THRESHOLD=5
MARKER_REL=".claude/.last-architecture-audit"

# Only commits that touch code an audit could have a finding about. Mirrors
# check-release-drift.mjs's SOURCE_PATHS and the board-freshness hook's WATCHED.
#
# WHY (2026-08-27): this counted EVERY commit, so a batch of feature-branch
# merges tripped the threshold immediately and a release commit - a version
# bump, a tarball and two doc lines - tripped it again. Two audits in a row
# opened on nothing having changed, and an audit that always fires is one people
# learn to wave through. --no-merges for the same reason: a merge carries
# commits that are counted here on their own account, so counting the merge too
# counts the same work twice.
WATCHED=(
  "soc-optimizationtoolkit/packages"
  "soc-optimizationtoolkit/apps/cribl-app/src"
  "soc-optimizationtoolkit/apps/cribl-app/scripts"
  "soc-optimizationtoolkit/scripts"
)

input=$(cat 2>/dev/null || true)

# Never block twice in a row - without this, ignoring the request would loop.
case "$input" in
  *'"stop_hook_active":true'*) exit 0 ;;
  *'"stop_hook_active": true'*) exit 0 ;;
esac

root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
[ -n "$root" ] || exit 0
cd "$root" || exit 0

marker_file="$root/$MARKER_REL"
if [ -f "$marker_file" ]; then
  marker=$(tr -d '[:space:]' < "$marker_file")
else
  marker=""
fi

if [ -n "$marker" ] && git cat-file -e "${marker}^{commit}" 2>/dev/null; then
  count=$(git rev-list --count --no-merges "${marker}..HEAD" -- "${WATCHED[@]}" 2>/dev/null || echo 0)
else
  # No usable marker: seed at HEAD rather than counting the repo's whole history,
  # which would fire immediately and every time thereafter.
  git rev-parse HEAD > "$marker_file" 2>/dev/null || true
  exit 0
fi

[ "$count" -ge "$THRESHOLD" ] 2>/dev/null || exit 0

reason="${count} commits since the last architecture audit (threshold ${THRESHOLD}). Run the architecture-audit skill now - layering and coupling, duplicated decisions, test-pin integrity, dead code and stale docs. It rewrites ${MARKER_REL} when it finishes, which resets this counter. If now is genuinely a bad moment, say so and carry on; this will ask again next time."

printf '{"decision":"block","reason":"%s","systemMessage":"Architecture audit due: %s commits since the last one."}\n' \
  "$reason" "$count"
