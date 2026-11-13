// Pipeline: agents that take Jira tickets to their pull request alone. Opened by
// mod.open:pipeline (ctrl-shift-a). Two views. The first shows where each ticket's agents
// stand: launch.js keeps a launched ticket in shared("pipeline.tickets"), its coder starts its
// own reviewer through herdr-core and says its stage with a label, and this dialog joins the
// two every 5 s while it is open and opens the terminal of the agent chosen. The second (n)
// lists the open tickets of the focused terminal's repo, to tick, and launches a coder on each
// ticked one. Once launched nothing here drives an agent. Only this machine's agents.
// Work a person does with an agent is start-work's, which knows nothing of this.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { run, props, closeOverlay, theme, exec, shared, setShared, focused, home } from "herdr";
import { rowsOf, squares, summary, gone, whyNot, ticketSource, sourceLabel } from "./lib.js";
import { TICKETS, sourcesOf, ticketsOf, workOf, start } from "./launch.js";

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
    this.cwd = focused()?.cwd || home(); // the terminal the dialog was opened from: its repo's tickets
    this.pick = null; // the choice once asked for: { loading } | { error } | { from, me, tickets, notes, branches, prs, known }
    this.checked = new Set(); // ticked tickets, by id: each gets a coder
    this.at = 0; // the chosen row of the choice
    this.report = []; // why a ticked ticket got no coder
    this.busy = false;
    this.scroll = VirtualListScrollHandle.new(); // keeps the row chosen with the arrows on screen
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.timer.after(600, () => this.handle.focus());
    cx.timer.every(EVERY, (cx) => this.refresh(cx));
    this.refresh(cx);
  }

  refresh(cx) {
    cx.spawn(async (cx) => {
      try {
        const tickets = shared(TICKETS) ?? {};
        const terms = await terminalsIn(Object.values(tickets).map((t) => t.path));
        this.rows = rowsOf(tickets, terms);
        const noCoder = gone(tickets, terms);
        const alive = (key) => terms.some((t) => under(t.cwd, tickets[key].path));
        this.starting = noCoder.filter(alive);
        // Forgotten: no terminal left in its worktree, and not launched a moment ago.
        const dead = noCoder.filter((key) => !alive(key) && Date.now() - Date.parse(tickets[key].at) > YOUNG);
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
        if (!from.named.length) throw new Error(`Aucune source de tickets pour ${from.repo.name} : ajoute-la dans start-work (ctrl-shift-j, onglet Jira).`);
        const [found, work] = await Promise.all([ticketsOf(from.named), workOf(from.repo.main)]);
        this.pick = { from, ...found, ...work };
      } catch (e) { this.pick = { error: String(e.message ?? e) }; }
      cx.notify();
    });
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
      if (!this.report.length) return this.close();
      cx.notify();
    });
  }

  pickKey(e, cx) {
    const rows = this.pick.tickets ?? [];
    if (e.key === "escape") this.view = "rows";
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
    const said = p.loading ? "Chargement…" : p.error ? p.error : !rows.length ? "Aucun ticket ouvert." : "";
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
      .child(div().pt(6).pb(14).text_size(13).text_color(t.muted).child(p.from ? `Tickets de : ${p.from.named.map((s) => sourceLabel(ticketSource(s) ?? { kind: "jql", jql: s })).join(", ")}. Un ticket déjà commencé ou pris par quelqu'un se fait à la main.` : " "))
      .when(Boolean(said), (el) => el.child(div().flex_1().text_color(p.error ? t.blocked : t.dim).child(said)))
      .when(!said, (el) => el.child(v_flex().flex_1().min_h(0).relative()
        .child(v_virtual_list("pipeline-pick", rows.length, 30, (i) => rows[i].id, (range) => rows.slice(range.start, range.end).map((r, i) => row(r, range.start + i))).track_scroll(this.scroll).on_item_click((id, cx) => { this.at = Math.max(0, rows.findIndex((r) => r.id === id)); this.tick(rows[this.at]); cx.notify(); }).size_full())
        .child(Scrollbar.vertical("pipeline-pick").absolute().inset_0())))
      .children((p.notes ?? []).map((line) => div().pt(4).text_size(11).text_color(t.dim).child(line)))
      .when(p.known === false, (el) => el.child(div().pt(8).text_size(12).text_color(t.blocked).child("Les branches ou les PR du dépôt n'ont pas pu être lues (git fetch, gh pr list) : impossible de savoir quels tickets sont déjà commencés, aucun agent ne peut être lancé.")))
      .children(this.report.map((line) => div().pt(4).text_size(12).text_color(t.blocked).child(line)))
      .child(h_flex().pt(14).gap(12).items_center()
        .child(div().flex_1().text_size(12).text_color(t.dim).child(this.busy ? "lancement des agents…" : n ? `${n} coché${n > 1 ? "s" : ""} : assigné${n > 1 ? "s" : ""} à toi, passé${n > 1 ? "s" : ""} « ${p.from.startStatus} », un Claude en mode auto chacun` : "↑↓ choisir · espace cocher"))
        .child(button("pipeline-back", "Retour", "esc", false, (cx) => { this.view = "rows"; cx.notify(); }))
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
    const empty = this.error || (this.loaded ? "Aucun ticket en cours. n pour en lancer." : "Chargement…");
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
