#!/usr/bin/env bash
# verify-merge.sh <branch|sha> <probe-grep> <probe-path>...
# Asserts (a) the rev is an ancestor of HEAD, (b) each probe grep succeeds in the path on HEAD.
set -u
GIT=/Library/Developer/CommandLineTools/usr/bin/git
rev=${1:?usage: verify-merge.sh rev probe 'path'...}; shift
probe=$1; shift
$GIT merge-base --is-ancestor "$rev" HEAD 2>/dev/null || { echo "FAIL: $rev not an ancestor of HEAD"; exit 1; }
fail=0
for p in "$@"; do
  if ! grep -rqE "$probe" "$p" 2>/dev/null; then echo "FAIL: probe /$probe/ not found in $p"; fail=1; fi
done
[ $fail -eq 0 ] && echo "verify-merge OK: $rev merged; probes present"
exit $fail
