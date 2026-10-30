# herdr-config

Ma configuration de [Herdr](https://herdr.dev). Le repo vit directement dans `~/.config/herdr-app`. Le `.gitignore` ne suit que mes fichiers, et laisse de côté tout ce que Herdr écrit lui-même : l'état de la fenêtre, les mods et layouts fournis par l'app, les types générés.

| Fichier | Rôle |
|---|---|
| `keys.json` | mes raccourcis (`ctrl-shift-j` ouvre start-work) |
| `settings.json` | mes réglages |
| `mods/start-work/` | la fenêtre « Commencer un travail » |
| `install.sh` | installe et vérifie ce dont les mods ont besoin |

## start-work

`ctrl-shift-j`, depuis un terminal ouvert dans un repo :

| Jira : POSO-90 a déjà sa branche et sa PR, Créer devient Reprendre | GitHub : les issues du repo |
|---|---|
| ![Onglet Jira](mods/start-work/preview.png) | ![Onglet GitHub](mods/start-work/preview-github.png) |

- l'onglet **Jira** liste les tickets du sprint ouvert du projet lié au repo : d'abord les miens, puis ceux sans personne, puis ceux des autres. Une clé tapée en entier (`POSO-110`) est cherchée dans tout Jira ;
- l'onglet **GitHub** liste les issues ouvertes du repo ;
- `tab` passe d'un onglet à l'autre. Taper `#12` ouvre GitHub, une clé ouvre Jira. Un texte libre donne un travail « sans ticket ».

**Créer** fait un worktree dans `~/.herdr/worktrees/<repo>/<branche>`, à partir de `origin/HEAD`. Il ouvre dessus un espace avec Claude, qui reçoit le ticket comme consigne, et un shell à droite. Pour un ticket Jira qui n'est pas à moi, la case « M'assigner » (cochée par défaut) me l'assigne, et le passe « En cours » s'il était encore à faire.

Si le ticket a déjà une branche ou une PR ouverte, le bouton devient **Reprendre** : il ouvre cette branche au lieu d'en créer une, ou affiche l'espace qui est déjà dessus.

`mods/start-work/config.json` donne le site Jira, le projet Jira de chaque repo et, pour certains repos, le format des branches :

```json
"jira_projects": { "renoshield": "POSO" },
"branch_formats": { "renoshield": "feat/{key}-{slug}" }
```

Dans un format, `{KEY}` vaut `POSO-12`, `{key}` vaut `poso-12` et `{slug}` est le titre du ticket. Sans format, une branche s'appelle `POSO-12-titre`.

## Prérequis

```bash
~/.config/herdr-app/install.sh
```

Le script :

- vérifie `git` ;
- vérifie `gh` et le connecte si besoin ;
- installe `acli`, le CLI officiel d'Atlassian, dans `~/.local/bin` (Linux, sans sudo) s'il manque, puis le connecte à Jira avec `acli jira auth login --web` (OAuth dans le navigateur, sans token) ;
- vérifie que le shell exécute bien les commandes que Herdr lui passe. Sinon, Claude démarre sans sa consigne : c'est le cas quand `~/.bashrc` lance zsh avec `exec zsh` sans condition. Il faut alors ne lancer zsh que si `[ -z "$BASH_EXECUTION_STRING" ]` ;
- lance `herdr-app check` sur chaque mod.

On peut le relancer sans risque.

## Sur une autre machine

`~/.config/herdr-app` existe déjà dès que Herdr a été lancé une fois. On y récupère donc le repo, sans cloner par-dessus :

```bash
cd ~/.config/herdr-app
git init -b main && git remote add origin <url-du-repo>
git fetch origin && git checkout -f main
./install.sh
```

## Pour un collègue

Il ne prend que le mod, pas mes raccourcis ni mes réglages :

1. copier `mods/start-work/` dans son `~/.config/herdr-app/mods/` ;
2. ajouter `"ctrl-shift-j": "mod.open:start-work"` dans la section `global` de son `keys.json` ;
3. lancer `install.sh` depuis un clone du repo. Il ne modifie aucun fichier de config, il installe seulement `acli` et vérifie les connexions.

Ou bien, dans Herdr, demander à son agent : « ajoute le mod Herdr `<url-du-repo>/tree/main/mods/start-work` ».
