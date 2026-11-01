#!/bin/sh
# Deletes the current repo's local branches whose pull request is merged, with their worktree
# and the Herdr space open on it. Shows what it would do; --yes does it.
# A branch goes only if every commit on it is in the merged PR (work added after the merge
# stays) and its worktree has no uncommitted or untracked files.
set -eu
yes=; [ "${1:-}" = --yes ] && yes=1
cd "$(git worktree list --porcelain | sed -n '1s/^worktree //p')"
here=$(git branch --show-current)
default=$(git symbolic-ref --short refs/remotes/origin/HEAD | sed 's|^origin/||')
[ -n "$yes" ] && git worktree prune

# Newest first: when a branch name was reused, its latest PR decides.
gh pr list --state merged --limit 1000 --json number,headRefName,headRefOid \
  --jq '.[] | "\(.number) \(.headRefName) \(.headRefOid)"' |
while read -r n branch head; do
  git show-ref -q --verify "refs/heads/$branch" || continue
  [ "$branch" = "$default" ] || [ "$branch" = "$here" ] && continue
  case " ${seen:-} " in *" $branch "*) continue ;; esac
  seen="${seen:-} $branch"
  # Once merged, the PR's branch is often gone from origin: GitHub keeps its head under refs/pull.
  git cat-file -e "$head^{commit}" 2>/dev/null || git fetch -q origin "refs/pull/$n/head" </dev/null || continue
  if ! git merge-base --is-ancestor "$branch" "$head"; then
    echo "kept    $branch: $(git rev-list --count "$head..$branch") commits not in #$n"; continue
  fi
  wt=$(git worktree list --porcelain | awk -v b="branch refs/heads/$branch" '/^worktree /{w=substr($0,10)} $0==b{print w}')
  if [ -n "$wt" ] && [ -d "$wt" ] && [ -n "$(git -C "$wt" status --porcelain)" ]; then
    echo "kept    $branch: uncommitted changes in $wt"; continue
  fi
  echo "delete  $branch (#$n)${wt:+ and $wt}"
  [ -n "$yes" ] || continue
  if [ -n "$wt" ]; then
    # Closing the space ends its terminals; without a running Herdr there's none to close.
    for s in $(herdr-app ls </dev/null 2>/dev/null | jq -r --arg f "$wt" '.spaces[] | select(.folder == $f) | .id'); do
      herdr-app do space.close "{\"id\":\"$s\",\"confirmed\":true}" </dev/null >/dev/null
    done
    git worktree remove "$wt"
  fi
  git branch -q -D "$branch"
done
