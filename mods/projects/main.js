// projects: pick a repo at the root of ~/PycharmProjects or ~/IdeaProjects and open a space on it,
// or go to the one already open. Adapted from jcgay/dotfiles' mod of the same name.

import { View, div, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, ScrollHandle } from "gpui-base";
import { props, closeOverlay, theme, spaces, panes, exec, home, appHome, settings, run, checking } from "herdr";
import { nameOf, parseRepos, parseCommits, parseIcons, stamp, markOpened, order, filter, spaceRepo, openSpaceFor } from "./lib.js";

const ROOTS = ["PycharmProjects", "IdeaProjects"]; // under home(); a missing one is skipped
const ICONS = "mods/projects/.icons"; // hidden: Herdr reloads a mod when a visible file of its folder changes

// localStorage: "recent" is { "<repo path>": <ms it was opened> }, "open" the repos open at the last look.
function load(key, empty) {
  try { return JSON.parse(localStorage.getItem(key) ?? "null") ?? empty; } catch { return empty; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

export default class Projects extends View {
  init(_props, cx) {
    this.roots = ROOTS.map((r) => `${home()}/${r}`);
    this.repos = null; // null: loading
    this.error = "";
    this.recent = load("recent", {});
    this.commits = {};
    this.icons = {}; // path -> { light, dark }: the repo's JetBrains icon, copied under appHome for image()
    this.sel = null; // the chosen repo: the list reorders when the commit dates arrive, an index would point elsewhere
    this.input = InputState.new({ placeholder: "Projet de ~/PycharmProjects ou ~/IdeaProjects" });
    this.input.on("change", (_e, cx) => { this.sel = null; this.scroll.scroll_to_item(0); cx.notify(); });
    this.input.on("submit", () => { const rows = this.rows(); this.open(rows[this.at(rows)]); });
    this.handle = cx.focus_handle();
    this.scroll = ScrollHandle.new();
    this.handle.focus();
    cx.timer.after(100, () => this.input.focus());
    if (checking()) return;
    cx.spawn(async (cx) => this.load(cx));
  }

  async load(cx) {
    const found = await exec("find", [...this.roots.map((r) => `${r}/`), "-mindepth", "2", "-maxdepth", "2", "-name", ".git", "-type", "d"], { timeout: 10000 })
      .catch((e) => ({ code: -1, stderr: e?.message ?? String(e) }));
    // find exits non-zero on one missing root or unreadable folder too: only an empty answer is a failure.
    this.repos = parseRepos(found.stdout ?? "");
    if (!this.repos.length && found.code !== 0) this.error = `Impossible de lire les projets : ${(found.stderr ?? "").trim() || `code ${found.code}`}`;
    // A repo open now that was not open at the last look was opened since: it moves to the top.
    const open = [...new Set(spaces().filter((s) => !s.machine).map((s) => spaceRepo(s, panes(), this.repos)).filter(Boolean))];
    this.recent = markOpened(load("recent", {}), load("open", []), open, Date.now());
    save("recent", this.recent);
    save("open", open);
    cx.notify();
    this.copyIcons(cx);
    const script = 'for r; do for d in "$r"/*/.git; do [ -d "$d" ] || continue; n=${d%/.git}; printf "%s %s\\n" "$n" "$(git -C "$n" log -1 --format=%ct 2>/dev/null)"; done; done';
    const dates = await exec("sh", ["-c", script, "sh", ...this.roots], { timeout: 30000 }).catch(() => null);
    if (dates) { this.commits = parseCommits(dates.stdout); cx.notify(); }
  }

  // .idea/icon.svg (else icon.png) and icon_dark.svg of each repo, copied to <ICONS>/<root name>/ since
  // image() only reads under appHome. Only what changed is written.
  copyIcons(cx) {
    const script = 'o=$1; shift; for r; do [ -d "$r" ] || continue; s=${r##*/}; mkdir -p "$o/$s" || exit; for d in "$r"/*/.idea; do n=${d%/.idea}; n=${n##*/}; l=; for e in svg png; do [ -f "$d/icon.$e" ] && l=$e && break; done; [ -n "$l" ] || continue; cmp -s "$d/icon.$l" "$o/$s/$n.$l" || cp "$d/icon.$l" "$o/$s/$n.$l"; k=; if [ -f "$d/icon_dark.svg" ]; then cmp -s "$d/icon_dark.svg" "$o/$s/$n.dark.svg" || cp "$d/icon_dark.svg" "$o/$s/$n.dark.svg"; k="$s/$n.dark.svg"; fi; printf "%s\\t%s\\t%s\\n" "$r/$n" "$s/$n.$l" "$k"; done; done';
    cx.spawn(async (cx) => {
      const r = await exec("sh", ["-c", script, "sh", `${appHome()}/${ICONS}`, ...this.roots], { timeout: 30000 }).catch(() => null);
      if (r) { this.icons = parseIcons(r.stdout, ICONS); cx.notify(); } // cosmetic: no icons on failure
    });
  }

  rows() {
    return filter(order(this.repos ?? [], this.recent, this.commits), this.input.value());
  }

  at(rows) {
    return Math.max(0, rows.indexOf(this.sel));
  }

  open(repo) {
    if (!repo) return;
    const id = openSpaceFor(repo, panes(), spaces());
    save("recent", stamp(load("recent", {}), [repo], Date.now()));
    closeOverlay(props().overlay);
    if (id) run("space.select", { id });
    else run("space.new", { folder: repo, machine: "" });
  }

  key(e, cx) {
    if (e.key === "escape") return closeOverlay(props().overlay);
    const rows = this.rows(), n = rows.length;
    if ((e.key === "down" || e.key === "up") && n) {
      const i = (this.at(rows) + (e.key === "down" ? 1 : n - 1)) % n;
      this.sel = rows[i];
      this.scroll.scroll_to_item(i);
      cx.stop_propagation();
      cx.notify();
    }
  }

  render() {
    const t = theme(), rows = this.rows(), at = this.at(rows), sp = spaces(), ps = panes(), dark = Boolean(settings().dark);
    const row = (repo, i) => h_flex().id(`p-${repo}`).h(28).px(10).gap(8).items_center().rounded(6).cursor_pointer()
      .when(i === at, (el) => el.bg(t.selected))
      .when(i !== at, (el) => el.hover((s) => s.bg(t.hover)))
      .on_click(() => this.open(repo))
      .child(this.icons[repo] ? image(this.icons[repo][dark ? "dark" : "light"]).size(16).flex_none().rounded(4) : div().size(16).flex_none())
      .child(div().flex_1().truncate().child(nameOf(repo)))
      .when(Boolean(openSpaceFor(repo, ps, sp)), (el) => el.child(div().text_size(11).text_color(t.accent).child("ouvert")))
      .child(div().text_size(11).text_color(t.dim).child(nameOf(repo.slice(0, -nameOf(repo).length - 1)).replace("Projects", "")));
    return v_flex().id("projects").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .size_full().p(16).gap(10).bg(t.popover).text_size(13).text_color(t.foreground)
      .child(div().font_semibold().child("Ouvrir un projet"))
      .child(Input.new(this.input).h(32).px(10).items_center().rounded(6).border(1).border_color(t.input).bg(t.background).text_color(t.foreground))
      .child(div().relative().flex_1().min_h(0)
        .child(v_flex().id("projects-list").size_full().overflow_y_scroll().track_scroll(this.scroll).children(rows.map(row))
          .when(!rows.length, (el) => el.child(div().p(10).text_color(t.dim).child(this.error || (this.repos ? "Aucun projet" : "Chargement…")))))
        .child(Scrollbar.vertical("projects-list").absolute().inset_0()))
      .child(h_flex().justify_end().text_size(11).text_color(t.dim).child("↑↓ choisir · ↵ ouvrir · esc fermer"));
  }
}
