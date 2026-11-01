// Clean merged: the focused space's repo's local branches whose pull request is merged, with
// their worktree and the space open on it. The safe ones come checked; ↵ deletes what is checked.
// Opened by mod.open:clean-merged.
// Safe means every commit of the branch is in the merged PR (repos squash-merge, so the PR's head
// decides, not main), its worktree has nothing uncommitted, and no agent is busy in its space.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { run, props, closeOverlay, theme, focused, exec, home, spaces, agents, notify } from "herdr";

async function git(cwd, args) {
  const r = await exec("git", args, { cwd });
  return { ok: r.code === 0, out: (r.stdout ?? "").trim(), err: (r.stderr || r.stdout || "").trim() };
}

// The main checkout of the repo a folder belongs to (a linked worktree gives its repo's).
async function repoOf(folder) {
  const common = await git(folder, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!common.ok) return null;
  const main = common.out.endsWith("/.git") ? common.out.slice(0, -5) : common.out;
  return { main, name: main.split("/").pop() };
}

const BRANCH = "branch refs/heads/";

export default class CleanMerged extends View {
  init(_props, cx) {
    this.repo = undefined; // undefined: looking, null: not in git
    this.rows = null; // null: loading
    this.checked = new Set();
    this.at = 0;
    this.busy = false;
    this.error = "";
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.timer.after(600, () => this.handle.focus());
    cx.spawn(async (cx) => {
      try { await this.load(); } catch (e) { this.error = String(e.message ?? e); }
      cx.notify();
    });
  }

  async load() {
    this.repo = await repoOf(focused()?.cwd || home());
    if (!this.repo) return;
    const main = this.repo.main;
    const [heads, trees, origin, prs] = await Promise.all([
      git(main, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]),
      git(main, ["worktree", "list", "--porcelain"]),
      git(main, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]),
      exec("gh", ["pr", "list", "--state", "merged", "--limit", "1000", "--json", "number,headRefName,headRefOid,title"], { cwd: main }),
    ]);
    if (prs.code !== 0) throw new Error(`GitHub : ${(prs.stderr || "gh a échoué").trim().split("\n")[0]}`);
    const local = new Set(heads.out.split("\n"));
    const blocks = trees.out.split("\n\n").map((b) => b.split("\n"));
    const branchOf = (lines) => lines.find((l) => l.startsWith(BRANCH))?.slice(BRANCH.length);
    const tree = {};
    for (const lines of blocks.slice(1)) {
      const b = branchOf(lines);
      // prunable: its folder is gone, only git's note of it is left
      if (b) tree[b] = lines.some((l) => l.startsWith("prunable")) ? null : lines[0].slice("worktree ".length);
    }
    const keep = new Set([origin.out.replace(/^origin\//, ""), branchOf(blocks[0])]);
    const seen = new Set();
    const rows = [];
    // Newest first: when a branch name was reused, its latest PR decides.
    for (const p of JSON.parse(prs.stdout)) {
      const b = p.headRefName;
      if (!local.has(b) || keep.has(b) || seen.has(b)) continue;
      seen.add(b);
      rows.push({ branch: b, pr: p.number, title: p.title, head: p.headRefOid, tree: tree[b] ?? null });
    }
    // Once merged, a PR's branch is often gone from origin: GitHub keeps its head under refs/pull.
    const have = await Promise.all(rows.map((r) => git(main, ["cat-file", "-e", `${r.head}^{commit}`])));
    const missing = rows.filter((_r, i) => !have[i].ok);
    if (missing.length) await git(main, ["fetch", "-q", "origin", ...missing.map((r) => `refs/pull/${r.pr}/head`)]);
    await Promise.all(rows.map(async (r) => {
      const extra = await git(main, ["rev-list", "--count", `${r.head}..${r.branch}`]);
      r.extra = extra.ok ? Number(extra.out) : null; // null: the PR's head couldn't be fetched
      r.dirty = Boolean(r.tree) && (await git(r.tree, ["status", "--porcelain"])).out !== "";
    }));
    this.rows = rows;
    this.checked = new Set(rows.filter((r) => !this.blocked(r) && r.extra === 0).map((r) => r.branch));
  }

  spaceOf(r) {
    return r.tree ? spaces().find((s) => !s.machine && s.folder === r.tree) : null;
  }

  // Why a row can't be deleted, or "" when it can.
  blocked(r) {
    if (r.extra === null) return `head de #${r.pr} introuvable`;
    if (r.dirty) return "changements non commités";
    const s = this.spaceOf(r);
    if (s && agents().some((a) => a.space === s.id && (a.status === "working" || a.status === "blocked"))) return `agent actif dans ${s.name}`;
    return "";
  }

  chosen() {
    return (this.rows ?? []).filter((r) => this.checked.has(r.branch) && !this.blocked(r));
  }

  flip(r) {
    if (this.blocked(r)) return;
    if (!this.checked.delete(r.branch)) this.checked.add(r.branch);
  }

  close() {
    closeOverlay(props().overlay);
  }

  async go(cx) {
    const chosen = this.chosen();
    if (!chosen.length || this.busy) return;
    this.busy = true;
    this.error = "";
    cx.notify();
    const main = this.repo.main;
    await git(main, ["worktree", "prune"]);
    const failed = [];
    for (const r of chosen) {
      if (r.tree) {
        // Checked again here: closing the space ends its terminals, so it must not be for nothing.
        if ((await git(r.tree, ["status", "--porcelain"])).out !== "") { failed.push(`${r.branch} : changements non commités`); continue; }
        const s = this.spaceOf(r);
        if (s) run("space.close", { id: s.id, confirmed: true });
        const w = await git(main, ["worktree", "remove", r.tree]);
        if (!w.ok) { failed.push(`${r.branch} : ${w.err}`); continue; }
      }
      const b = await git(main, ["branch", "-D", r.branch]);
      if (!b.ok) failed.push(`${r.branch} : ${b.err}`);
    }
    this.busy = false;
    const done = chosen.length - failed.length;
    if (!failed.length) {
      notify({ title: `${done} branche${done > 1 ? "s" : ""} supprimée${done > 1 ? "s" : ""}`, body: this.repo.name, level: "success" });
      return this.close();
    }
    this.error = failed.join("\n");
    this.rows = null;
    cx.notify();
    try { await this.load(); } catch (e) { this.error += `\n${e.message ?? e}`; }
    cx.notify();
  }

  key(e, cx) {
    const rows = this.rows ?? [];
    const n = rows.length;
    if (e.key === "escape") return this.close();
    if (e.key === "enter") return cx.spawn(async (cx) => this.go(cx));
    if ((e.key === "down" || e.key === "up") && n) this.at = (Math.min(this.at, n - 1) + (e.key === "down" ? 1 : n - 1)) % n;
    else if (e.key === "space" && n) this.flip(rows[Math.min(this.at, n - 1)]);
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  render() {
    const t = theme();
    const rows = this.rows ?? [];
    const count = this.chosen().length;
    const row = (r, i) => {
      const why = this.blocked(r);
      const on = !why && this.checked.has(r.branch);
      const note = why || (r.extra > 0 ? `${r.extra} commit${r.extra > 1 ? "s" : ""} absent${r.extra > 1 ? "s" : ""} de la PR` : r.tree ? "avec son worktree" : "");
      return h_flex()
        .id(`cm-${r.branch}`)
        .flex_none()
        .h(30)
        .px(8)
        .gap(10)
        .items_center()
        .rounded(6)
        .when(!why, (el) => el.cursor_pointer())
        .when(i === this.at, (el) => el.bg(t.selected))
        .on_click((_e, cx) => { this.at = i; this.flip(r); cx.notify(); })
        .child(h_flex().size(15).flex_none().rounded(4).border(1).border_color(on ? t.accent : t.input).when(on, (el) => el.bg(t.accent)).items_center().justify_center().text_size(10).text_color(t.accent_foreground).child(on ? "✓" : ""))
        .child(div().w(52).flex_none().text_color(t.ansi2).child(`#${r.pr}`))
        .child(div().flex_1().min_w(0).truncate().text_color(why ? t.dim : t.foreground).child(r.branch))
        .when(Boolean(note), (el) => el.child(div().flex_none().text_size(11).text_color(why ? t.blocked : r.extra > 0 ? t.ansi3 : t.dim).child(note)));
    };
    const disabled = !count || this.busy;
    return v_flex()
      .id("clean-merged")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .size_full()
      .p(16)
      .gap(10)
      .bg(t.popover)
      .text_size(13)
      .child(h_flex().child(div().flex_1().text_size(15).font_semibold().text_color(t.foreground).child(`Branches mergées${this.repo ? ` · ${this.repo.name}` : ""}`)).child(div().text_size(11).text_color(t.dim).child("esc")))
      .when(this.repo === null, (el) => el.child(div().text_color(t.muted).child("Le terminal actif n'est pas dans un repo git.")))
      .when(Boolean(this.repo), (el) =>
        el.child(
          v_flex().id("cm-list").flex_1().min_h(0).overflow_y_scrollbar().children(
            this.rows === null ? [div().p(8).text_color(t.dim).child("Chargement…")]
            : rows.length ? rows.map(row)
            : [div().p(8).text_color(t.dim).child("Aucune branche locale dont la PR est mergée.")],
          ),
        ),
      )
      .when(Boolean(this.error), (el) => el.child(div().text_color(t.blocked).child(this.error)))
      .child(
        h_flex()
          .gap(10)
          .items_center()
          .child(div().flex_1().text_size(11).text_color(t.dim).child(this.busy ? "suppression…" : "↑↓ choisir · espace cocher · ↵ supprimer · esc fermer"))
          .child(h_flex().id("cm-cancel").h(30).px(14).items_center().rounded(6).border(1).border_color(t.input).text_color(t.foreground).cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => this.close()).child("Annuler"))
          .child(h_flex().id("cm-go").h(30).px(14).items_center().rounded(6).bg(disabled ? t.raised : t.solid).text_color(disabled ? t.dim : t.solid_foreground).font_semibold().cursor_pointer().on_click((_e, cx) => cx.spawn(async (cx) => this.go(cx))).child(`Supprimer${count ? ` ${count}` : ""} ↵`)),
      );
  }
}
