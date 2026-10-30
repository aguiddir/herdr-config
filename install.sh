#!/usr/bin/env bash
# What the mods here need on this machine. Installs acli (no sudo), logs gh and
# acli in when they aren't, and checks each mod. Safe to re-run.
set -euo pipefail
home=$(cd "$(dirname "$0")" && pwd)
ok() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
ko() { printf '  \033[31m✗\033[0m %s\n' "$1"; failed=1; }
failed=0

echo "Programmes"
command -v git >/dev/null && ok git || ko "git manque : sudo apt install git"

if ! command -v gh >/dev/null; then
  ko "gh manque (issues et PR GitHub) : https://github.com/cli/cli#installation"
elif gh auth status >/dev/null 2>&1; then
  ok "gh connecté"
else
  gh auth login && ok "gh connecté" || ko "gh n'est pas connecté : gh auth login"
fi

# Atlassian's CLI, for Jira: a single binary, put where the user's PATH already looks.
if ! command -v acli >/dev/null; then
  case $(uname -m) in x86_64) arch=amd64 ;; aarch64 | arm64) arch=arm64 ;; *) arch= ;; esac
  if [ "$(uname -s)" = Linux ] && [ -n "$arch" ]; then
    mkdir -p "$HOME/.local/bin"
    curl -fsSL -o "$HOME/.local/bin/acli" "https://acli.atlassian.com/linux/latest/acli_linux_$arch/acli"
    chmod +x "$HOME/.local/bin/acli"
    ok "acli installé dans ~/.local/bin"
    # Herdr finds acli through the PATH of the session it was started from.
    case ":$PATH:" in
      *":$HOME/.local/bin:"*) ;;
      *) ko "~/.local/bin n'est pas dans ton PATH : Herdr ne trouvera pas acli. Ferme la session et rouvre-la (~/.profile l'ajoute quand le dossier existe)" ;;
    esac
    export PATH="$HOME/.local/bin:$PATH"
  else
    ko "acli manque : https://developer.atlassian.com/cloud/acli/guides/install-acli/"
  fi
fi
if command -v acli >/dev/null; then
  if acli jira auth status >/dev/null 2>&1; then
    ok "acli connecté à Jira"
  else
    acli jira auth login --web && ok "acli connecté à Jira" || ko "acli n'est pas connecté : acli jira auth login --web"
  fi
fi

# Herdr starts an agent with its first message as `$SHELL -ic '"$@"' … claude <message>`.
# A shell rc that execs another shell unconditionally swallows the message.
echo "Shell"
case $(basename "${SHELL:-}") in
  bash | zsh)
    if timeout 10 "$SHELL" -ic '"$@"; exit' "$SHELL" echo herdr-ok </dev/null 2>/dev/null | grep -q herdr-ok; then
      ok "$SHELL lance les commandes que Herdr lui passe"
    else
      ko "$SHELL -ic n'exécute pas la commande : Claude démarrerait sans sa consigne. Dans ~/.bashrc, n'exécute zsh que si [ -z \"\$BASH_EXECUTION_STRING\" ]"
    fi ;;
esac

echo "Mods"
if command -v herdr-app >/dev/null; then
  # Only this repo's mods: the folder also holds the ones Herdr ships.
  for mod in $(git -C "$home" ls-files mods | cut -d/ -f2 | sort -u); do
    herdr-app check "$home/mods/$mod" >/dev/null 2>&1 && ok "$mod" || ko "$mod : herdr-app check $home/mods/$mod"
  done
else
  ko "herdr-app manque : https://herdr.dev"
fi

exit $failed
