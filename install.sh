#!/usr/bin/env bash
# What the mods here need on this machine: gh for start-work, clean-merged and pr-inbox,
# acli for start-work, herdr-core's reviewer role for the pipeline. Installs acli (no sudo),
# logs gh and acli in when they aren't, copies the roles, and checks each mod. Safe to re-run.
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

# herdr-core roles (hc run <name> "<task>"): the reviewer the pipeline's coder starts.
# A role edited by hand is left alone and said, never overwritten.
echo "herdr-core"
if command -v hc >/dev/null; then
  mkdir -p "$HOME/.config/herdr-core/templates"
  for role in "$home"/hc-templates/*.md; do
    name=$(basename "$role" .md)
    there="$HOME/.config/herdr-core/templates/$name.md"
    if [ ! -e "$there" ]; then
      cp "$role" "$there" && ok "rôle $name installé"
    elif cmp -s "$role" "$there"; then
      ok "rôle $name"
    else
      ko "rôle $name : $there diffère de $role (diff \"$there\" \"$role\", puis recopie-le si la différence n'est pas voulue)"
    fi
  done
else
  ko "hc manque (herdr-core) : https://herdr.dev"
fi

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
