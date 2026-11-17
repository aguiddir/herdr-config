#!/usr/bin/env bash
# Review Markdown in plannotator-tui beside an agent, then send it the notes on quit.
# Runs in the pane a key opened (see keys.json):
#   annotate.sh open [file|folder]   the pane's folder, or the given file
#   annotate.sh last                 the agent's last reply
# ANNOTATE_TO names the terminal the notes go to, instead of the tab's agent.
set -euo pipefail
mode=${1:-open}

stop() { echo "$1" >&2; read -rsn1 -p "Une touche pour fermer." || true; exit 1; }

tui=$(command -v plannotator-tui || true)
# The classic Herdr plugin ships one too.
[ -n "$tui" ] || tui=$(ls "$HOME"/.config/herdr/plugins/github/annotate-*/bin/plannotator-tui.exe 2>/dev/null | head -1)
[ -x "$tui" ] || stop "plannotator-tui manque : cargo install plannotator-tui"

to=${ANNOTATE_TO:-}
if [ -z "$to" ]; then
  # The agents sharing this pane's tab: the one the app focused last, else the first.
  last=$(herdr-app status | jq -r '.agent // empty')
  to=$(herdr-app ls | jq -r --arg me "$HC_TERMINAL_ID" --arg last "$last" \
    '[.spaces[].tabs[] | select(any(.terminals[]; .terminal == $me))
      | .terminals[] | select(.terminal != $me and .app != null) | .terminal]
     | if index($last) then $last else .[0] // empty end')
fi

case $mode in
  last)
    [ -n "$to" ] || stop "Aucun agent dans cet onglet."
    dir=$(mktemp -d); trap 'rm -rf "$dir"' EXIT; target=$dir/reply.md
    "$tui" last --pid "$(hc get "$to" --json | jq -r .foreground.pid)" --print >"$target" ||
      stop "Impossible de lire la dernière réponse de $to."
    ;;
  open) target=${2:-$PWD} ;;
  *) stop "usage : annotate.sh open [file|folder] | last" ;;
esac

before=$("$tui" --export "$target" 2>/dev/null || true)
"$tui" "$target" || true
after=$("$tui" --export "$target" 2>/dev/null || true)

# Nothing new, or nothing at all: say nothing to the agent.
# ponytail: the whole export is sent again when it changed, earlier notes included.
[ "$after" != "$before" ] && [ "$after" != "No annotations." ] || exit 0
[ -n "$to" ] || { echo "$after"; stop "Aucun agent dans cet onglet : les notes sont ci-dessus."; }
hc send "$to" "$after" >/dev/null || stop "Envoi à $to impossible."
