#!/usr/bin/env bash
# Stop hook: ask for a board update once enough work has landed without one.
#
# Same cadence model as architecture-audit-check.sh, and for the same reason -
# commit COUNT tracks actual change, where wall-clock fires during a coffee
# break. Running on Stop means it never interrupts mid-task.
#
# No marker file here: the board's own last commit IS the marker, so there is
# nothing to keep in sync and nothing to seed. Commits that touch only the board
# do not count toward its own staleness.
#
# What this cannot do is tell whether a card is in the right column. It counts
# work that happened while the board sat still, which is the measurable half; the
# judgement stays with whoever moves the card.
set -uo pipefail

THRESHOLD=6
BOARD="soc-optimizationtoolkit/docs/board.md"

# Work that could change what the board should say. Excludes the board itself,
# and excludes release tarballs - packaging is not progress on a story.
WATCHED=(
  "soc-optimizationtoolkit/packages"
  "soc-optimizationtoolkit/apps/cribl-app/src"
  "soc-optimizationtoolkit/apps/cribl-app/scripts"
  "soc-optimizationtoolkit/scripts"
  "soc-optimizationtoolkit/docs/backlog.md"
  "soc-optimizationtoolkit/docs/adr"
)

input=$(cat 2>/dev/null || true)

# Never block twice in a row - without this, declining would loop.
case "$input" in
  *'"stop_hook_active":true'*) exit 0 ;;
  *'"stop_hook_active": true'*) exit 0 ;;
esac

root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
cd "$root" || exit 0

# No board on this branch (it arrives with its own PR) - nothing to be stale.
[ -f "$root/$BOARD" ] || exit 0

last=$(git log -1 --format=%H -- "$BOARD" 2>/dev/null)
[ -n "$last" ] || exit 0

count=$(git rev-list --count "${last}..HEAD" -- "${WATCHED[@]}" 2>/dev/null || echo 0)
[ "$count" -ge "$THRESHOLD" ] 2>/dev/null || exit 0

# Name the commits, so the ask is answerable without going to look for them.
subjects=$(git log --format='- %s' "${last}..HEAD" -- "${WATCHED[@]}" 2>/dev/null \
  | head -8 \
  | sed 's/\\/\\\\/g; s/"/\\"/g' \
  | sed ':a;N;$!ba;s/\n/\\n/g')

reason="${count} commits have landed since ${BOARD} was last updated (threshold ${THRESHOLD}).\\n\\n${subjects}\\n\\nUpdate the board now: move what shipped out of Now, promote what is unblocked, and add anything found along the way as a new story with an id, a type, an evidence line, and whether it is SETTLED or UNDECIDED. If a decision got answered, move it off Needs a decision and say what was decided.\\n\\nDetail still belongs in backlog.md - the board only carries what is a unit of work, what state it is in, and what it waits on. If the board is genuinely already current, say so and carry on; this will ask again next time."

printf '{"decision":"block","reason":"%s","systemMessage":"Board update due: %s commits since it last changed."}\n' \
  "$reason" "$count"
