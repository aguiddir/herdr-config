// Pipeline: agents that take Jira tickets to their pull request alone. Opened by
// mod.open:pipeline (ctrl-shift-a). Two views. The first shows where each ticket's agents
// stand: launch.js keeps a launched ticket in shared("pipeline.tickets"), its coder starts its
// own reviewer through herdr-core and says its stage with a label, and this dialog joins the
// two every 5 s while it is open and opens the terminal of the agent chosen. The second (n)
// works like start-work's Jira tab: it asks where the tickets of the focused terminal's repo
// are (a Jira link, a project key, JQL such as a label; kept in config.json), lists them to
// tick, and launches a coder on each ticked one. The dialog opens on it when nothing runs.
// Once launched nothing here drives an agent. Only this machine's agents.
// Work a person does with an agent is start-work's, which knows nothing of this.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { run, props, closeOverlay, theme, exec, shared, setShared, focused, home } from "herdr";
import { rowsOf, squares, summary, gone, whyNot, ticketSource, sourceLabel, compose, boardLink } from "./lib.js";
import { TICKETS, sourcesOf, saveSources, ticketsOf, workOf, filtersOfBoard, start } from "./launch.js";

const EVERY = 5000;
const YOUNG = 120000; // a ticket just launched has no agent yet: not forgotten before this
const RESUME = "L'auteur a répondu sur le ticket : relis-le, repasse `hc label $HC_TERMINAL_ID pipeline.stage=code`, et reprends.";

const under = (cwd, dir) => cwd === dir || cwd.startsWith(`${dir}/`);

async function hc(args) {
  const r = await exec("hc", args);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout || "hc a échoué").trim().split("\n")[0].slice(0, 200));
  return r.stdout;
}

// The terminals in the tickets' worktrees, as lib.js wants them. `hc ls` has no labels:
// one `hc get` per terminal kept, which also gives what the agent says it is doing.
async function terminalsIn(paths) {
  const all = JSON.parse(await hc(["ls", "--json"])).terminals ?? [];
  const near = all.map((t) => ({ ...t, cwd: (t.cwd ?? "").replace(/\/\.$/, "") })).filter((t) => paths.some((p) => under(t.cwd, p)));
  return Promise.all(near.map(async (t) => {
    let got = {};
    try { got = JSON.parse(await hc(["get", t.address, "--json"])); } catch { /* gone since ls: no labels */ }
    return { address: t.address, cwd: t.cwd, status: t.status ?? null, labels: got.labels ?? {}, parent: t.parent ?? null, name: t.name ?? null, doing: got.status?.msg ?? "" };
  }));
}

export default class Pipeline extends View {
  init(_props, cx) {
    this.rows = [];
    this.starting = []; // keys launched whose coder doesn't report yet (or waits on a dialog of Claude's)
    this.sel = null; // the chosen ticket's key
    this.agent = "coder"; // or "reviewer"
    this.loaded = false;
    this.error = "";
    this.view = "rows"; // or "pick": choosing the tickets to launch
    // A source is typed in three fields, and kept as one line (lib.js: compose).
    this.sourceInput = InputState.new({ placeholder: "https://…/projects/POSO/boards/1802 · https://…/issues/?filter=10570 · POSO" });
    this.prefixInput = InputState.new({ placeholder: "MM" });
    this.labelInput = InputState.new({ placeholder: "DATADELTA" });
    this.themeInput = InputState.new({ placeholder: "DAEL" });
    for (const input of [this.sourceInput, this.prefixInput, this.labelInput, this.themeInput]) input.on("submit", (_e, cx) => cx.spawn(async (cx) => this.submitSource(cx)));
    this.adding = false; // the source field is shown
    this.editing = null; // the source being edited, by index; null: a new one
    this.sourceError = "";
    this.filters = []; // a personal board's link was typed: the filters that may be its own, to pick one
    this.cwd = focused()?.cwd || home(); // the terminal the dialog was opened from: its repo's tickets
    this.pick = null; // the choice once asked for: { loading } | { error } | { from, me, tickets, notes, branches, prs, known }
    this.checked = new Set(); // ticked tickets, by id: each gets a coder
    this.at = 0; // the chosen row of the choice
    this.report = []; // why a ticked ticket got no coder
    this.busy = false;
    this.scroll = VirtualListScrollHandle.new(); // keeps the row chosen with the arrows on screen
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.timer.after(600, () => !this.adding && this.handle.focus()); // not over the source field
    cx.timer.every(EVERY, (cx) => this.refresh(cx));
    this.refresh(cx);
    if (!Object.keys(shared(TICKETS) ?? {}).length) this.openPick(cx); // nothing runs: start by choosing
  }

  refresh(cx) {
    cx.spawn(async (cx) => {
      try {
        const tickets = shared(TICKETS) ?? {};
        const terms = await terminalsIn(Object.values(tickets).map((t) => t.path));
        this.rows = rowsOf(tickets, terms);
        const noCoder = gone(tickets, terms);
        const alive = (key) => terms.some((t) => under(t.cwd, tickets[key].path));
        const young = (key) => Date.now() - Date.parse(tickets[key].at) <= YOUNG;
        this.starting = noCoder.filter((key) => alive(key) || young(key));
        // Forgotten: no terminal left in its worktree, and not launched a moment ago.
        const dead = noCoder.filter((key) => !alive(key) && !young(key));
        // Read again: a launch may have added a ticket while hc answered.
        if (dead.length) setShared(TICKETS, Object.fromEntries(Object.entries(shared(TICKETS) ?? {}).filter(([key]) => !dead.includes(key))));
        this.error = "";
      } catch (e) { this.error = String(e.message ?? e); } // hc unreachable: keep what is shown, forget nothing
      this.loaded = true;
      cx.notify();
    });
  }

  selected() {
    return this.rows.find((r) => r.key === this.sel) ?? this.rows[0] ?? null;
  }

  // The agent the arrows point at; a ticket without a reviewer yet has only its coder.
  chosen(row) {
    return this.agent === "reviewer" && row.reviewer ? row.reviewer : row.coder;
  }

  close() {
    closeOverlay(props().overlay);
  }

  // Show the agent's terminal: its tab if it has one, a peek over the tab for a reviewer without a pane.
  open(row) {
    const t = this.chosen(row);
    const { "herdr.space": space, "herdr.tab": tab } = t.labels;
    if (!space || !tab) return void run("terminal.peek", { terminal: t.address });
    run("space.select", { id: space });
    run("tab.select", { id: tab });
    run("pane.focus", { terminal: t.address });
    this.close();
  }

  // A ticket stopped on a question: tell its coder the author answered.
  resume(row, cx) {
    cx.spawn(async (cx) => {
      try { await hc(["send", row.coder.address, RESUME]); this.refresh(cx); }
      catch (e) { this.error = String(e.message ?? e); cx.notify(); }
    });
  }

  go(row, cx) {
    if (row.state === "question") this.resume(row, cx);
    else this.open(row);
  }

  // The second view: the open tickets of the repo, read once per opening of the dialog.
  openPick(cx) {
    this.view = "pick";
    if (this.pick) return;
    this.pick = { loading: true };
    cx.spawn(async (cx) => {
      try {
        const from = await sourcesOf(this.cwd);
        if (!from) throw new Error("Le terminal actif n'est pas dans un dépôt git : ouvre le pipeline depuis un terminal du dépôt.");
        const [work] = await Promise.all([workOf(from.repo.main), this.loadTickets(from)]);
        this.pick = { from, ...this.found, ...work };
        if (!from.named.length) this.openSourceInput(); // asks where the tickets are
      } catch (e) { this.pick = { error: String(e.message ?? e) }; }
      cx.notify();
    });
  }

  // The sources' tickets into this.found; a Jira that fails is a note, not the end of the dialog.
  async loadTickets(from) {
    this.found = { me: undefined, tickets: [], notes: [] };
    if (!from.named.length) return;
    try { this.found = await ticketsOf(from.named); }
    catch (e) { this.found.notes = [String(e.message ?? e)]; }
  }

  // Where this repo's tickets are: sources added, edited or removed here, kept in config.json.
  async setSources(named, cx) {
    const p = this.pick;
    await saveSources(p.from.repo.name, named);
    p.from.named = named;
    Object.assign(p, { tickets: [], notes: ["Chargement…"] });
    this.checked.clear();
    this.at = 0;
    cx.notify();
    await this.loadTickets(p.from);
    Object.assign(p, this.found);
    cx.notify();
  }

  async submitSource(cx) {
    // A personal board's link: acli can't say which filter it shows. Its name finds candidates.
    const board = boardLink(this.sourceInput.value());
    if (board) {
      this.sourceError = "Recherche du filtre de ce board…";
      cx.notify();
      try { this.filters = (await filtersOfBoard(board.id)).map((f) => ({ ...f, link: `${board.site}/issues/?filter=${f.id}` })); }
      catch { this.filters = []; }
      if (this.filters.length) { this.sourceError = ""; return cx.notify(); }
    }
    const text = compose(this.sourceInput.value(), this.labelInput.value(), this.themeInput.value(), this.prefixInput.value());
    if (!ticketSource(text)) {
      this.sourceError = "acli ne lit pas les tickets d'un board qui n'appartient pas à un projet. Colle le lien de son filtre : sur le board, ⋯ → Paramètres du tableau → Filtre → Modifier la requête de filtre, puis copie l'adresse (…/issues/?filter=…).";
      return cx.notify();
    }
    const named = [...this.pick.from.named];
    if (this.editing === null) named.push(text);
    else named[this.editing] = text;
    this.closeSourceInput();
    try { await this.setSources(named, cx); }
    catch (e) { this.report = [String(e.message ?? e)]; cx.notify(); }
  }

  openSourceInput(index) {
    this.editing = index ?? null;
    this.adding = true;
    this.sourceError = "";
    this.filters = [];
    this.sourceInput.set_value(index === undefined ? "" : this.pick.from.named[index]); // a kept one comes back whole, here
    for (const input of [this.prefixInput, this.labelInput, this.themeInput]) input.set_value("");
    this.sourceInput.focus();
  }

  // Back to the list: the arrows and space are the dialog's again.
  closeSourceInput() {
    this.adding = false;
    this.editing = null;
    this.sourceError = "";
    this.filters = [];
    this.sourceInput.set_value("");
    this.handle.focus();
  }

  // Leaving the choice: to the agents when some run, else out.
  back() {
    if (this.adding && this.pick?.from?.named.length) return this.closeSourceInput();
    if (!this.rows.length && !this.starting.length) return this.close();
    this.view = "rows";
    this.handle.focus();
  }

  // Why this ticket can't be ticked, or "".
  refused(r) {
    return whyNot(r, this.pick.branches, this.pick.prs);
  }

  tick(r) {
    if (!r || this.busy || !this.pick.known || this.refused(r)) return;
    if (!this.checked.delete(r.id)) this.checked.add(r.id);
    this.report = [];
  }

  // Every ticked ticket gets its own worktree, space and coder. One that fails doesn't stop
  // the others; the dialog stays open on what didn't start.
  launch(cx) {
    const p = this.pick;
    const todo = (p.tickets ?? []).filter((r) => this.checked.has(r.id));
    if (this.busy || !todo.length) return;
    this.busy = true;
    this.report = [];
    cx.spawn(async (cx) => {
      for (const r of todo) {
        try { p.branches.unshift(await start(p.from, p.me, r)); }
        catch (e) { this.report.push(`${r.key} : ${String(e.message ?? e)}`); }
        this.checked.delete(r.id);
        cx.notify();
      }
      this.busy = false;
      // To the agents: the ones just launched are named there until their terminal reports.
      if (!this.report.length) { this.view = "rows"; this.refresh(cx); }
      cx.notify();
    });
  }

  pickKey(e, cx) {
    const rows = this.pick.tickets ?? [];
    if (e.key === "escape") this.back();
    else if (this.adding) return; // typing a source: space and ↵ are the field's
    else if ((e.key === "down" || e.key === "up") && rows.length) { this.at = (this.at + (e.key === "down" ? 1 : rows.length - 1)) % rows.length; this.scroll.scroll_to_item(this.at); }
    else if (e.key === "space") this.tick(rows[this.at]);
    else if (e.key === "enter") this.launch(cx);
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  key(e, cx) {
    if (this.view === "pick") return this.pickKey(e, cx);
    if (e.key === "escape") return this.close();
    if (e.key === "n") { this.openPick(cx); cx.stop_propagation(); return cx.notify(); }
    const row = this.selected();
    if (!row) return;
    const at = this.rows.indexOf(row);
    if (e.key === "down" || e.key === "up") { this.sel = this.rows[(at + (e.key === "down" ? 1 : this.rows.length - 1)) % this.rows.length].key; this.agent = "coder"; }
    else if (e.key === "left") this.agent = "coder";
    else if (e.key === "right") this.agent = "reviewer";
    else if (e.key === "enter") this.go(row, cx);
    else if (e.key === "o") this.open(row);
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  // The choice: one line per open ticket, a box on those a coder may take.
  renderPick(t, button) {
    const p = this.pick;
    const rows = p.tickets ?? [];
    const n = this.checked.size;
    const row = (r, i) => {
      const no = this.refused(r);
      const ticked = this.checked.has(r.id);
      return h_flex().id(`pp-${r.id}`).h(30).px(8).gap(10).items_center().rounded(6).cursor_pointer()
        .when(i === this.at, (el) => el.bg(t.selected))
        .child(h_flex().size(15).flex_none().rounded(4).border(1).border_color(ticked ? t.accent : no || !p.known ? t.border : t.input).when(ticked, (b) => b.bg(t.accent)).items_center().justify_center().text_size(10).text_color(t.accent_foreground).child(ticked ? "✓" : ""))
        .child(div().w(90).flex_none().truncate().text_color(no ? t.dim : t.done).child(r.key))
        .child(div().flex_1().min_w(0).truncate().text_color(no ? t.dim : t.foreground).child(r.title))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(no || `${r.mine ? "toi" : "non assigné"} · ${r.status}`));
    };
    const named = p.from?.named ?? [];
    const said = p.loading ? "Chargement…" : p.error ? p.error : !named.length ? " " : !rows.length ? (p.notes.length ? " " : "Aucun ticket ouvert.") : "";
    const field = (state) => Input.new(state).h(32).px(10).items_center().rounded(6).border(1).border_color(t.input).bg(t.background).text_color(t.foreground);
    const chip = (text, i) => h_flex().id(`pp-src-${i}`).flex_none().h(22).px(8).gap(6).items_center().rounded(11).bg(t.raised)
      .child(div().id(`pp-src-edit-${i}`).max_w(300).truncate().cursor_pointer().text_color(t.foreground).on_click((_e, cx) => { cx.stop_propagation(); this.openSourceInput(i); cx.notify(); }).child(sourceLabel(ticketSource(text) ?? { kind: "jql", jql: text })))
      .child(div().id(`pp-src-del-${i}`).cursor_pointer().text_color(t.dim).on_click((_e, cx) => { cx.stop_propagation(); cx.spawn(async (cx) => this.setSources(named.filter((_, j) => j !== i), cx)); }).child("×"));
    const sources = () => v_flex().gap(6).pb(10).text_size(12)
      .when(named.length > 0, (c) => c.child(h_flex().flex_wrap().gap(6).items_center()
        .child(div().text_color(t.dim).child("Tickets de :"))
        .children(named.map(chip))
        .when(!this.adding, (r) => r.child(div().id("pp-src-add").cursor_pointer().text_color(t.accent).on_click((_e, cx) => { cx.stop_propagation(); this.openSourceInput(); cx.notify(); }).child("+ ajouter")))))
      .when(this.adding, (c) => c
        .when(!named.length, (x) => x.child(div().text_size(13).text_color(t.muted).child(`Où sont les tickets de ${p.from.repo.name} à confier à des agents ? Le lien d'un board de projet ou d'un filtre Jira (ou une clé de projet, ou du JQL), et de quoi le restreindre : le préfixe des tickets (MM pour MM-1505), un label, une thématique. Un seul des quatre suffit. C'est gardé dans mods/pipeline/config.json.`)))
        .child(h_flex().gap(8).items_end()
          .child(v_flex().flex_1().gap(3).child(div().text_size(11).text_color(t.dim).child("Lien Jira")).child(field(this.sourceInput)))
          .child(v_flex().w(90).gap(3).child(div().text_size(11).text_color(t.dim).child("Préfixe")).child(field(this.prefixInput)))
          .child(v_flex().w(140).gap(3).child(div().text_size(11).text_color(t.dim).child("Label")).child(field(this.labelInput)))
          .child(v_flex().w(140).gap(3).child(div().text_size(11).text_color(t.dim).child("Thématique")).child(field(this.themeInput)))
          .when(named.length > 0, (x) => x.child(div().id("pp-src-cancel").cursor_pointer().text_color(t.dim).on_click((_e, cx) => { cx.stop_propagation(); this.closeSourceInput(); cx.notify(); }).child("annuler"))))
        .when(this.filters.length > 0, (x) => x
          .child(div().pt(4).text_color(t.muted).child("Ce board n'appartient pas à un projet, et Jira ne dit pas quel filtre il affiche. Lequel est-ce ? (le premier est le plus probable ; préfixe, label et thématique sont gardés)"))
          .children(this.filters.slice(0, 8).map((f) => h_flex().id(`pp-filter-${f.id}`).h(24).px(8).gap(10).items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => { cx.stop_propagation(); this.sourceInput.set_value(f.link); this.filters = []; cx.spawn(async (cx) => this.submitSource(cx)); })
            .child(div().w(60).flex_none().text_color(t.done).child(f.id)).child(div().truncate().text_color(t.foreground).child(f.name)))))
        .when(Boolean(this.sourceError), (x) => x.child(div().text_color(t.blocked).child(this.sourceError))));
    return v_flex()
      .id("pipeline-dialog")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .size_full()
      .bg(t.popover)
      .p(20)
      .text_size(14)
      .child(h_flex().justify_between().items_center()
        .child(div().text_size(16).font_semibold().text_color(t.foreground).child(p.from ? `Lancer des agents · ${p.from.repo.name}` : "Lancer des agents"))
        .child(div().text_size(12).text_color(t.dim).child("esc")))
      .child(div().pt(6).pb(10).text_size(13).text_color(t.muted).child("Chaque ticket coché reçoit un agent qui va seul jusqu'à la PR. Un ticket déjà commencé ou pris par quelqu'un se fait à la main."))
      .when(Boolean(p.from), (el) => el.child(sources()))
      .when(Boolean(said), (el) => el.child(div().flex_1().text_color(p.error ? t.blocked : t.dim).child(said)))
      .when(!said, (el) => el.child(v_flex().flex_1().min_h(0).relative()
        .child(v_virtual_list("pipeline-pick", rows.length, 30, (i) => rows[i].id, (range) => rows.slice(range.start, range.end).map((r, i) => row(r, range.start + i))).track_scroll(this.scroll).on_item_click((id, cx) => { this.at = Math.max(0, rows.findIndex((r) => r.id === id)); this.tick(rows[this.at]); cx.notify(); }).size_full())
        .child(Scrollbar.vertical("pipeline-pick").absolute().inset_0())))
      .children((p.notes ?? []).map((line) => div().pt(4).text_size(11).text_color(t.dim).child(line)))
      .when(p.known === false, (el) => el.child(div().pt(8).text_size(12).text_color(t.blocked).child("Les branches ou les PR du dépôt n'ont pas pu être lues (git fetch, gh pr list) : impossible de savoir quels tickets sont déjà commencés, aucun agent ne peut être lancé.")))
      .children(this.report.map((line) => div().pt(4).text_size(12).text_color(t.blocked).child(line)))
      .child(h_flex().pt(14).gap(12).items_center()
        .child(div().flex_1().text_size(12).text_color(t.dim).child(this.busy ? "lancement des agents…" : n ? `${n} coché${n > 1 ? "s" : ""} : assigné${n > 1 ? "s" : ""} à toi, passé${n > 1 ? "s" : ""} « ${p.from.startStatus} », un Claude en mode auto chacun` : "↑↓ choisir · espace cocher"))
        .child(button("pipeline-back", this.rows.length || this.starting.length ? "Voir les agents" : "Fermer", "esc", false, (cx) => { this.back(); cx.notify(); }))
        .when(n > 0 && !this.busy, (el) => el.child(button("pipeline-launch", `Lancer ${n} agent${n > 1 ? "s" : ""}`, "↵", true, (cx) => this.launch(cx)))));
  }

  render() {
    const t = theme();
    const sel = this.selected();
    const tone = { question: t.blocked, look: t.blocked, running: t.working, ready: t.done };
    const fill = { done: t.done, active: t.working, wait: t.blocked };
    const square = (s) => div().size(10).rounded(3).when(s === "todo", (el) => el.border(1).border_color(t.muted)).when(s !== "todo", (el) => el.bg(fill[s]));
    const pair = (row) => {
      const [a, b] = squares(row);
      return h_flex().items_center().flex_none().child(square(a)).child(div().w(8).h(2).bg(a === "done" ? t.done : t.border)).child(square(b));
    };
    const button = (id, label, key, primary, onClick) =>
      h_flex().id(id).h(32).px(14).gap(8).flex_none().items_center().rounded(6).text_size(13).cursor_pointer()
        .when(primary, (el) => el.bg(t.solid).text_color(t.solid_foreground).font_semibold())
        .when(!primary, (el) => el.border(1).border_color(t.input).text_color(t.foreground).hover((s) => s.bg(t.hover)))
        .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); })
        .child(label)
        .child(div().text_size(10.5).font_normal().opacity(0.6).child(key));
    if (this.view === "pick") return this.renderPick(t, button);

    const line = (row) => v_flex().id(`pl-${row.key}`).px(12).py(8).gap(3).rounded(6).cursor_pointer()
      .when(row === sel, (el) => el.bg(t.selected))
      .when(row !== sel, (el) => el.hover((s) => s.bg(t.hover)))
      .on_click((_e, cx) => { this.sel = row.key; this.agent = "coder"; cx.notify(); })
      .child(h_flex().justify_between().items_center().gap(8)
        .child(div().text_color(t.done).child(row.key))
        .child(h_flex().gap(8).items_center().text_size(12).text_color(tone[row.state]).child(row.label).child(pair(row))))
      .child(div().text_size(12.5).text_color(row === sel ? t.foreground : t.muted).truncate().child(row.title));

    // One box of the chain: an agent (a terminal, maybe not started) or the pull request.
    const box = (name, role, said, color, on, width = 190) => v_flex().w(width).h(104).p(12).gap(6).rounded(8).border(on ? 2 : 1).border_color(on ? t.accent : t.border)
      .child(div().text_size(12).text_color(t.muted).child(name))
      .child(div().font_semibold().text_color(t.foreground).child(role))
      .child(div().flex_1())
      .child(div().text_size(12.5).text_color(color).child(said));
    const arrow = () => div().px(8).text_color(t.dim).child("→");
    const saidOf = (term, row, mine) => {
      if (!term) return ["pas encore lancé", t.dim];
      if (term.status === "working") return ["en cours", t.working];
      if (term.status === "blocked") return ["attend une réponse de ta part", t.blocked];
      if (mine && row.state === "question") return ["attend la réponse de l'auteur", t.blocked];
      if (row.state === "ready" || (mine && row.stage === "review")) return ["terminé", t.done];
      return ["arrêté", mine ? t.blocked : t.muted];
    };
    const detail = (row) => {
      const active = this.chosen(row);
      const doing = row.state === "question"
        ? ["Question posée à l'auteur du ticket, en commentaire Jira", "Le ticket est en attente. Si tu connais la réponse, écris-la dans le terminal de l'agent ; sinon « Reprendre » lui dit de relire le ticket quand l'auteur a répondu."]
        : row.state === "ready"
          ? ["Terminé", row.questions ? `La PR est ouverte, avec ${row.questions} question${row.questions > 1 ? "s" : ""} dans sa section « Hypothèses et questions ».` : "La PR est ouverte, sans question en attente."]
          : [active === row.coder ? "Agent code, en ce moment" : "Agent review, en ce moment", active.doing || (row.state === "look" ? "Il s'est arrêté sans avoir fini : ouvre son terminal pour voir pourquoi." : "…")];
      return [
        div().text_size(15).font_semibold().text_color(t.foreground).child(`${row.key} · ${row.title}`),
        div().text_size(12).text_color(t.muted).child(row.branch),
        h_flex().items_center().pt(10)
          .child(box("Agent 1", "Code", ...saidOf(row.coder, row, true), active === row.coder))
          .child(arrow())
          .child(box(row.reviewer ? "Agent 2 · lancé par l'agent 1" : "Agent 2", "Review", ...saidOf(row.reviewer, row, false), active === row.reviewer))
          .child(arrow())
          .child(box("Sortie", "PR", row.state === "ready" ? "ouverte" : "à ouvrir", row.state === "ready" ? t.done : t.dim, false, 96)),
        div().text_size(12).text_color(t.dim).child("↺ si la review laisse des remarques, retour au code · 2 passes au plus"),
        div().flex_1(),
        v_flex().p(12).gap(4).rounded(8).bg(t.raised)
          .child(div().text_size(12).text_color(tone[row.state]).child(doing[0]))
          .child(div().text_size(13.5).text_color(t.foreground).child(doing[1])),
      ];
    };

    const count = this.rows.length;
    const empty = this.error || (!this.loaded ? "Chargement…" : this.starting.length ? "Démarrage des agents…" : "Aucun ticket en cours. n pour en lancer.");
    return v_flex()
      .id("pipeline-dialog")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .size_full()
      .bg(t.popover)
      .p(20)
      .text_size(14)
      .child(h_flex().justify_between().items_center()
        .child(div().text_size(16).font_semibold().text_color(t.foreground).child(count ? `Pipeline · ${count} ticket${count > 1 ? "s" : ""}` : "Pipeline"))
        .child(div().text_size(12).text_color(t.dim).child("esc")))
      .child(div().pt(6).pb(14).text_size(13).text_color(t.muted).child(summary(this.rows) || " "))
      .when(!sel, (el) => el.child(div().flex_1().text_color(this.error ? t.blocked : t.dim).child(empty)))
      .when(Boolean(sel), (el) => el.child(h_flex().flex_1().min_h(0).gap(24).items_start()
        .child(v_flex().id("pipeline-rows").w(290).flex_none().h_full().gap(2).overflow_y_scrollbar().children(this.rows.map(line)))
        .child(v_flex().flex_1().min_w(0).h_full().gap(6).pl(24).border_l(1).border_color(t.border).children(detail(sel)))))
      .when(this.starting.length > 0, (el) => el.child(div().pt(8).text_size(12).text_color(t.blocked).child(`Lancé${this.starting.length > 1 ? "s" : ""} sans agent visible : ${this.starting.join(", ")}. Claude attend peut-être une réponse dans son terminal.`)))
      .when(Boolean(sel && this.error), (el) => el.child(div().pt(8).text_size(12).text_color(t.blocked).child(this.error)))
      .child(h_flex().pt(14).gap(12).items_center()
        .child(div().text_size(12).text_color(t.dim).child(!sel ? "" : sel.state === "question" ? "↑↓ ticket · o ouvrir le terminal" : "↑↓ ticket · ←→ agent"))
        .child(div().flex_1())
        .child(button("pipeline-new", "Lancer des tickets", "n", !sel, (cx) => { this.openPick(cx); cx.notify(); }))
        .child(button("pipeline-close", "Fermer", "esc", false, () => this.close()))
        .when(Boolean(sel && sel.state === "question"), (el) => el.child(button("pipeline-go", "Reprendre avec la réponse Jira", "↵", true, (cx) => this.resume(sel, cx))))
        .when(Boolean(sel && sel.state !== "question"), (el) => el.child(button("pipeline-go", this.chosen(sel) === sel.coder ? "Ouvrir l'agent code" : "Ouvrir l'agent review", "↵", true, () => this.open(sel)))));
  }
}
