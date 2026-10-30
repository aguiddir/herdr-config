// Start work: pick a Jira ticket of the repo's sprint, a GitHub issue, or type
// a description. Makes a worktree (where the worktree mod puts them) and a space
// on it running Claude. Opened by mod.open:start-work.
// Jira: config.json maps repo names to project keys; acli (Atlassian's CLI,
// logged in once with `acli jira auth login --web`) does the calls.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { run, props, closeOverlay, theme, focused, exec, home, appHome, readTextFile, spaces, notify } from "herdr";
import { branchFor, existingWork } from "./lib.js";

const JIRA_KEY = /^[A-Z][A-Z0-9]+-\d+$/;

async function git(cwd, args) {
  const r = await exec("git", args, { cwd });
  return { ok: r.code === 0, out: (r.stdout ?? "").trim(), err: (r.stderr || r.stdout || "").trim() };
}

// The repo a folder belongs to: its main checkout and name (a linked worktree gives its repo's).
async function repoOf(folder) {
  const top = await git(folder, ["rev-parse", "--show-toplevel"]);
  const common = await git(folder, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!top.ok || !common.ok) return null;
  const main = common.out.endsWith("/.git") ? common.out.slice(0, -5) : common.out;
  return { top: top.out, main, name: main.split("/").pop() };
}

async function acli(args) {
  const r = await exec("acli", ["jira", ...args]);
  if (r.code !== 0) throw new Error(`Jira : ${(r.stderr || r.stdout || "acli a échoué").trim().split("\n")[0].slice(0, 200)}`);
  return r.stdout;
}

const FIELDS = "key,summary,status,assignee";

const ticket = (i, me) => ({
  kind: "jira",
  id: `jira-${i.key}`,
  key: i.key,
  title: i.fields.summary,
  status: i.fields.status?.name ?? "",
  todo: i.fields.status?.statusCategory?.key === "new",
  mine: Boolean(me && i.fields.assignee?.emailAddress?.toLowerCase() === me),
  who: i.fields.assignee?.displayName ?? null,
});

export default class StartWork extends View {
  init(_props, cx) {
    this.text = "";
    this.at = 0;
    this.repo = undefined; // undefined: looking, null: not in git
    this.tickets = [];
    this.issues = [];
    this.notes = { jira: [], issue: [] }; // why a source is missing
    this.src = "jira"; // the tab shown: "jira" or "issue"
    this.assign = true;
    this.busy = false;
    this.error = "";
    this.branchOf = null; // the row the branch field was filled from
    this.input = InputState.new({ placeholder: "Clé Jira, #issue, ou décris le travail" });
    this.input.on("change", (_e, cx) => { this.text = this.input.value(); this.at = 0; this.follow(); this.error = ""; this.lookup(cx); this.sync(); cx.notify(); });
    this.input.on("submit", (_e, cx) => this.go(cx));
    this.branch = InputState.new({ placeholder: "branche" });
    this.branch.on("submit", (_e, cx) => this.go(cx));
    this.branch.on("change", (_e, cx) => cx.notify());
    this.branches = []; // newest first, local and origin's
    this.prs = []; // open ones
    this.found = {}; // tickets fetched by their exact key, outside the sprint
    this.ready = false; // branches and PRs loaded: before, Créer can't tell new work from work under way
    this.input.focus();
    cx.timer.after(600, () => this.input.focus());
    this.handle = cx.focus_handle();
    this.scroll = VirtualListScrollHandle.new(); // keeps the row chosen with the arrows on screen
    cx.spawn(async (cx) => this.load(cx));
  }

  async load(cx) {
    const cwd = focused()?.cwd || home();
    try { this.repo = await repoOf(cwd); } catch (e) { this.repo = null; this.error = String(e); }
    cx.notify();
    if (!this.repo) return;
    const config = JSON.parse((await readTextFile(`${appHome()}/mods/start-work/config.json`)) ?? "{}");
    this.startStatus = config.jira_start_status ?? "En cours";
    this.format = config.branch_formats?.[this.repo.name];
    const project = config.jira_projects?.[this.repo.name];
    if (!project) { this.src = "issue"; this.notes.jira.push(`Pas de projet Jira pour ${this.repo.name} dans config.json`); }
    const show = async (loading) => { await loading; this.sync(); cx.notify(); };
    await Promise.all([show(this.loadIssues()), project ? show(this.loadTickets(project)) : null, this.loadWork()]);
    this.ready = true;
    this.branchOf = null; // refill the field: the chosen row may have work under way
    this.sync();
    cx.notify();
  }

  // What already exists, so a ticket with work under way is resumed, not started over.
  async loadWork() {
    await git(this.repo.main, ["fetch", "--quiet", "origin"]);
    const refs = await git(this.repo.main, ["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads", "refs/remotes/origin"]);
    this.branches = [...new Set(refs.out.split("\n").filter((b) => b && b !== "origin" && b !== "origin/HEAD").map((b) => b.replace(/^origin\//, "")))];
    const r = await exec("gh", ["pr", "list", "--state", "open", "--limit", "100", "--json", "number,headRefName,title,url"], { cwd: this.repo.main });
    if (r.code === 0) this.prs = JSON.parse(r.stdout);
  }

  async loadIssues() {
    const r = await exec("gh", ["issue", "list", "--limit", "50", "--json", "number,title,url"], { cwd: this.repo.main });
    if (r.code !== 0) return this.notes.issue.push(`GitHub : ${(r.stderr || r.stdout).trim().split("\n")[0]}`);
    this.issues = JSON.parse(r.stdout).map((i) => ({ kind: "issue", id: `issue-${i.number}`, number: i.number, title: i.title.replace(/^[\p{Extended_Pictographic}️\s]+/u, ""), url: i.url })); // gitmoji: no glyph in the UI font
  }

  async loadTickets(project) {
    try {
      this.me = (await acli(["auth", "status"])).match(/Email:\s*(\S+)/)?.[1]?.toLowerCase();
      const jql = `project = ${project} AND sprint in openSprints() AND statusCategory != Done ORDER BY updated DESC`;
      const r = JSON.parse(await acli(["workitem", "search", "--jql", jql, "--fields", FIELDS, "--limit", "50", "--json"]));
      const order = (t) => (t.mine ? 0 : t.who ? 2 : 1); // mine, then nobody's, then others'
      this.tickets = r.map((i) => ticket(i, this.me)).sort((a, b) => order(a) - order(b));
    } catch (e) { this.notes.jira.push(String(e.message ?? e)); }
  }

  // A key typed exactly that isn't in the sprint: fetch it from all of Jira.
  lookup(cx) {
    const key = this.text.trim().toUpperCase();
    if (!JIRA_KEY.test(key) || this.tickets.some((t) => t.key === key) || this.found[key]) return;
    cx.spawn(async (cx) => {
      try {
        if (this.me === undefined) this.me = (await acli(["auth", "status"])).match(/Email:\s*(\S+)/)?.[1]?.toLowerCase();
        const i = JSON.parse(await acli(["workitem", "view", key, "--fields", FIELDS, "--json"]));
        if (i) this.found[i.key] = ticket(i, this.me);
      } catch {} // not a ticket (yet: the key is still being typed)
      this.sync();
      cx.notify();
    });
  }

  // "#12" means GitHub, an exact Jira key means Jira: show that tab.
  follow() {
    const t = this.text.trim();
    if (t.startsWith("#")) this.src = "issue";
    else if (JIRA_KEY.test(t.toUpperCase())) this.src = "jira";
  }

  switchTo(src) {
    this.src = src;
    this.at = 0;
    this.sync();
  }

  matches() {
    const f = this.text.trim().toLowerCase().replace(/^#/, "");
    const hit = (s) => !f || s.toLowerCase().includes(f);
    // An exact key means that ticket, not every key it starts (POSO-11 is not POSO-110).
    const key = f.toUpperCase();
    const exact = JIRA_KEY.test(key) && (this.tickets.find((t) => t.key === key) ?? this.found[key]);
    return {
      jira: JIRA_KEY.test(key) ? (exact ? [exact] : []) : this.tickets.filter((t) => hit(`${t.key} ${t.title}`)),
      issue: this.issues.filter((i) => hit(`${i.number} ${i.title}`)),
    };
  }

  rows() {
    const out = [...this.matches()[this.src]];
    if (this.text.trim() && !JIRA_KEY.test(this.text.trim().toUpperCase())) out.push({ kind: "free", id: "free", title: this.text.trim() });
    return out;
  }

  selected() {
    const rows = this.rows();
    return rows[Math.min(this.at, rows.length - 1)];
  }

  // Fill the branch field from the chosen row; a branch typed by hand stays until the row changes.
  sync() {
    const s = this.selected();
    if (s) this.scroll.scroll_to_item(this.rows().indexOf(s));
    if ((s?.id ?? null) === this.branchOf && s?.kind !== "free") return;
    this.branchOf = s?.id ?? null;
    this.branch.set_value(s ? existingWork(s, this.branches, this.prs)?.branch ?? branchFor(s, this.format) : "");
  }

  close() {
    closeOverlay(props().overlay);
  }

  go(cx) {
    const s = this.selected();
    if (this.busy || !this.ready || !s) return;
    this.busy = true;
    this.error = "";
    cx.notify();
    cx.spawn(async (cx) => {
      try { await this.create(s, this.branch.value().trim()); this.close(); }
      catch (e) { this.error = String(e.message ?? e); }
      this.busy = false;
      cx.notify();
    });
  }

  async create(s, branch) {
    if (!(await git(this.repo.main, ["check-ref-format", "--branch", branch])).ok) throw new Error(`« ${branch} » n'est pas un nom de branche valide.`);
    // Take the ticket first: if Jira refuses, nothing is half made.
    if (s.kind === "jira" && !s.mine && this.assign) await this.take(s);
    await git(this.repo.main, ["worktree", "prune"]); // forget worktrees whose folder was deleted by hand
    let path = await this.checkoutOf(branch);
    if (!path) {
      const has = async (ref) => (await git(this.repo.main, ["show-ref", "--verify", "--quiet", ref])).ok;
      const exists = (await has(`refs/heads/${branch}`)) || (await has(`refs/remotes/origin/${branch}`));
      path = `${home()}/.herdr/worktrees/${this.repo.name}/${branch.replace(/[^A-Za-z0-9._-]+/g, "-")}`;
      // An existing branch is checked out as is (one only on origin gets a local branch tracking it);
      // a new one starts from the remote's default branch, not from whatever is checked out here.
      let add = ["worktree", "add", path, branch];
      if (!exists) {
        const base = await git(this.repo.main, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
        add = ["worktree", "add", "--no-track", "-b", branch, path, base.ok ? base.out : "HEAD"];
      }
      const r = await git(this.repo.main, add);
      if (!r.ok) throw new Error(r.err || "git worktree add a échoué.");
    }
    const open = spaces().find((sp) => sp.folder === path);
    if (open) return run("space.select", { id: open.id });
    // Unnamed, so the space follows the checkout folder and nests under its repo.
    run("space.new", { folder: path, tab: "claude", argv: ["claude"] });
  }

  // The folder where the branch is already checked out, if any.
  async checkoutOf(branch) {
    const list = (await git(this.repo.main, ["worktree", "list", "--porcelain"])).out;
    const tree = list.split("\n\n").map((b) => b.split("\n")).find((lines) => lines.includes(`branch refs/heads/${branch}`));
    return tree?.[0].replace(/^worktree /, "") ?? null;
  }

  // Assign the ticket to me and, if it is still to do, move it to jira_start_status
  // (acli can't list a workflow's transitions, so the status is named in config.json).
  // The flags are updated as Jira takes each step, so a retry after a git failure doesn't redo them.
  async take(s) {
    await acli(["workitem", "assign", "--key", s.key, "--assignee", "@me", "--yes"]);
    s.mine = true;
    if (!s.todo) return;
    s.todo = false;
    // A workflow without that status shouldn't block the work: say so and go on.
    try { await acli(["workitem", "transition", "--key", s.key, "--status", this.startStatus, "--yes"]); }
    catch (e) { notify({ title: `${s.key} t'est assigné, mais n'est pas passé « ${this.startStatus} »`, body: String(e.message ?? e), level: "warning" }); }
  }

  key(e, cx) {
    if (e.key === "escape") return this.close();
    if (e.key === "tab") { this.switchTo(this.src === "jira" ? "issue" : "jira"); cx.stop_propagation(); return cx.notify(); }
    const n = this.rows().length;
    if ((e.key === "down" || e.key === "up") && n) this.at = (Math.min(this.at, n - 1) + (e.key === "down" ? 1 : n - 1)) % n;
    else return;
    this.sync();
    cx.stop_propagation();
    cx.notify();
  }

  toggle(t, id, on, label, flip) {
    return h_flex()
      .id(id)
      .gap(10)
      .items_center()
      .cursor_pointer()
      .on_click((_e, cx) => { flip(); cx.notify(); })
      .child(h_flex().size(15).rounded(4).border(1).border_color(on ? t.accent : t.input).when(on, (el) => el.bg(t.accent)).items_center().justify_center().text_size(10).text_color(t.accent_foreground).child(on ? "✓" : ""))
      .child(div().text_color(t.foreground).child(label));
  }

  render() {
    const t = theme();
    const rows = this.rows();
    const sel = this.selected();
    const row = (r) => {
      const on = r === sel;
      const [tag, tagColor, right, rightColor] =
        r.kind === "jira" ? [r.key, t.ansi4, `${r.mine ? "toi" : r.who ?? "non assigné"} · ${r.status}`, r.who ? t.dim : t.ansi3]
        : r.kind === "issue" ? [`#${r.number}`, t.ansi2, "", t.dim]
        : ["✎", t.muted, "sans ticket", t.dim];
      return h_flex()
        .id(r.id)
        .flex_none()
        .h(30)
        .px(8)
        .gap(10)
        .items_center()
        .rounded(6)
        .cursor_pointer()
        .when(on, (el) => el.bg(t.selected))
        .child(div().w(80).flex_none().truncate().text_color(tagColor).child(tag))
        .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(r.title))
        .when(Boolean(right), (el) => el.child(div().flex_none().text_size(11).text_color(rightColor).child(right)));
    };
    const counts = this.matches();
    const tab = (src, label) => {
      const on = this.src === src;
      return h_flex()
        .id(`sw-tab-${src}`)
        .h(28)
        .px(12)
        .gap(6)
        .items_center()
        .rounded(6)
        .cursor_pointer()
        .when(on, (el) => el.bg(t.selected))
        .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
        .on_click((_e, cx) => { this.switchTo(src); cx.notify(); })
        .child(div().text_color(on ? t.foreground : t.muted).font_semibold().child(label))
        .child(div().text_size(11).text_color(t.dim).child(String(counts[src].length)));
    };
    const takes = sel?.kind === "jira" && !sel.mine;
    const typed = this.branch.value().trim();
    const old = this.branches.includes(typed); // Créer then resumes that branch
    const pr = old && this.prs.find((p) => p.headRefName === typed);
    const field = (state) => Input.new(state).h(32).px(10).items_center().rounded(6).border(1).border_color(t.input).bg(t.background).text_color(t.foreground);
    return v_flex()
      .id("start-work")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .size_full()
      .p(16)
      .gap(10)
      .bg(t.popover)
      .text_size(13)
      .child(h_flex().child(div().flex_1().text_size(15).font_semibold().text_color(t.foreground).child(`Commencer un travail${this.repo ? ` · ${this.repo.name}` : ""}`)).child(div().text_size(11).text_color(t.dim).child("esc")))
      .when(this.repo === null, (el) => el.child(div().text_color(t.muted).child("Le terminal actif n'est pas dans un repo git.")))
      .when(Boolean(this.repo), (el) =>
        el
          .child(field(this.input).border_color(t.accent))
          .child(
            h_flex()
              .gap(4)
              .items_center()
              .child(tab("jira", "Jira · sprint"))
              .child(tab("issue", `GitHub · ${this.repo.name}`))
              .child(div().flex_1())
              .child(div().text_size(11).text_color(t.dim).child("tab pour changer")),
          )
          .child(
            v_flex()
              .flex_1()
              .min_h(0)
              .relative()
              .child(v_virtual_list("sw-list", rows.length, 30, (i) => rows[i].id, (range) => rows.slice(range.start, range.end).map(row)).track_scroll(this.scroll).on_item_click((id, cx) => { this.at = Math.max(0, rows.findIndex((r) => r.id === id)); this.sync(); cx.notify(); }).size_full())
              .child(Scrollbar.vertical("sw-list").absolute().inset_0()),
          )
          .when(rows.length === 0 && !this.notes[this.src].length, (l) => l.child(div().p(8).text_color(t.dim).child(this.text ? "Rien ne correspond." : "Chargement…")))
          .children(this.notes[this.src].map((n) => div().px(8).text_size(11).text_color(t.dim).child(n)))
          .child(h_flex().gap(8).items_center().child(div().w(64).text_size(12).text_color(t.muted).child("Branche")).child(field(this.branch).flex_1()))
          .when(old, (l) => l.child(div().pl(72).text_size(11).text_color(t.ansi3).child(`Branche existante${pr ? ` · PR #${pr.number} ouverte` : ""} : le travail sera repris, pas recommencé.`)))
          .when(takes, (l) => l.child(this.toggle(t, "sw-take", this.assign, `M'assigner ${sel.key}${sel.todo ? " et le passer en cours" : ""}`, () => (this.assign = !this.assign)))),
      )
      .when(Boolean(this.error), (el) => el.child(div().text_color(t.blocked).child(this.error)))
      .child(
        h_flex()
          .gap(10)
          .items_center()
          .child(div().flex_1().text_size(11).text_color(t.dim).child(this.busy ? "création…" : !this.ready && this.repo ? "chargement des branches…" : "↑↓ choisir · tab Jira/GitHub · ↵ créer · esc fermer"))
          .child(h_flex().id("sw-cancel").h(30).px(14).items_center().rounded(6).border(1).border_color(t.input).text_color(t.foreground).cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => this.close()).child("Annuler"))
          .child(h_flex().id("sw-go").h(30).px(14).items_center().rounded(6).bg(!sel || this.busy || !this.ready ? t.raised : t.solid).text_color(!sel || this.busy || !this.ready ? t.dim : t.solid_foreground).font_semibold().cursor_pointer().on_click((_e, cx) => this.go(cx)).child(old ? "Reprendre ↵" : "Créer ↵")),
      );
  }
}
