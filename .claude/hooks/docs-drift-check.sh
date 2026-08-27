#!/usr/bin/env bash
# PostToolUse hook: run the docs-drift check the moment a document is edited.
#
# THIS IS THE FAST HALF, NOT THE GATE. .claude/ is gitignored in this repo, so
# nothing here travels with a clone - the real enforcement is the "Check docs
# drift" step in .github/workflows/soc-toolkit-ci.yml, which fails the build.
# What this adds is the seconds-later feedback that stops a stale claim being
# written in the first place, rather than found on a pull request.
#
# Fires only when the edited file is one the check actually reads, so ordinary
# source edits pay nothing.
set -uo pipefail

input=$(cat 2>/dev/null || true)

# The check reads docs/**.md plus CONTEXT.md. Anything else cannot change its
# verdict, so do not spend a run on it.
case "$input" in
  *soc-optimizationtoolkit/docs/*.md*) ;;
  *soc-optimizationtoolkit\\\\docs\\\\*) ;;
  *soc-optimizationtoolkit/CONTEXT.md*) ;;
  *soc-optimizationtoolkit\\\\CONTEXT.md*) ;;
  *) exit 0 ;;
esac

root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
app="$root/soc-optimizationtoolkit/apps/cribl-app"
[ -f "$app/scripts/check-docs-drift.mjs" ] || exit 0

output=$(cd "$app" && node scripts/check-docs-drift.mjs 2>&1)
status=$?

[ "$status" -eq 0 ] && exit 0

# Errors only - the suppression notice and the near-due warnings are useful in a
# full run and are noise in an edit loop.
errors=$(printf '%s\n' "$output" | grep '^error: ' | sed 's/^error: //')
[ -n "$errors" ] || exit 0

count=$(printf '%s\n' "$errors" | grep -c .)

# JSON-escape: backslashes first, then quotes, then fold newlines.
escaped=$(printf '%s' "$errors" \
  | sed 's/\\/\\\\/g; s/"/\\"/g' \
  | sed ':a;N;$!ba;s/\n/\\n/g')

reason="docs-drift found ${count} problem(s) in the documentation you just edited:\\n\\n${escaped}\\n\\nFix them now, while the change is in hand. The rules are in soc-optimizationtoolkit/docs/documenting-work.md; run 'npm run check-docs' from soc-optimizationtoolkit to re-check. If a line is a live document quoting history on purpose, mark that line with <!--drift-ok--> rather than rewording the history away."

printf '{"decision":"block","reason":"%s","systemMessage":"docs-drift: %s error(s)"}\n' \
  "$reason" "$count"
