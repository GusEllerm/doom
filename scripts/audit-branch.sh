#!/usr/bin/env bash
# audit-branch.sh <branch> — flag harness-junk commits before merging.
# Junk = any commit touching node_modules/wads/*.wad or containing symlinks (mode 120000).
# Exit 0 = clean to merge; exit 1 = inspect/ cherry-pick real commits only.
set -euo pipefail
GIT=/Library/Developer/CommandLineTools/usr/bin/git
BRANCH="${1:?usage: audit-branch.sh <branch>}"
bad=0
for h in $($GIT log --format="%h" "main..$BRANCH"); do
  msg=$($GIT log -1 --format="%s" "$h")
  raw=$($GIT show --raw --format="" "$h")
  junk=""
  echo "$raw" | grep -qE '(^|	)(node_modules|wads)' && junk="path:node_modules/wads"
  echo "$raw" | grep -qE '(^|	).*\.wad( |$)' && junk="$junk path:wad"
  echo "$raw" | grep -q '^:120000' && junk="$junk symlink"
  if [ -n "$junk" ]; then echo "JUNK  $h  [$junk]  $msg"; bad=1; else echo "ok    $h  $msg"; fi
done
exit $bad
