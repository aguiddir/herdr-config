// Pipeline: where the agents of each ticket stand. Opened by mod.open:pipeline (ctrl-shift-a).
// It drives nothing: start-work launches a coder per ticked ticket and keeps the ticket in
// shared("pipeline.tickets"); the coder starts its own reviewer through herdr-core and says its
// stage with a label. This dialog joins the two, every 5 s while it is open, and opens the
// terminal of the agent chosen. Only this machine's agents.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { run, props, closeOverlay, theme, exec, shared, setShared } from "herdr";
import { rowsOf, squares, summary, gone } from "./lib.js";

const TICKETS = "pipeline.tickets";
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
        // Read again: start-work may have added a ticket while hc answered.
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

  key(e, cx) {
    if (e.key === "escape") return this.close();
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
    const empty = this.error || (this.loaded ? "Aucun ticket en cours. ctrl-shift-j pour en lancer." : "Chargement…");
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
        .child(div().text_size(12).text_color(t.dim).child(sel?.state === "question" ? "↑↓ ticket · o ouvrir le terminal" : "↑↓ ticket · ←→ agent"))
        .child(div().flex_1())
        .child(button("pipeline-close", "Fermer", "esc", false, () => this.close()))
        .when(Boolean(sel && sel.state === "question"), (el) => el.child(button("pipeline-go", "Reprendre avec la réponse Jira", "↵", true, (cx) => this.resume(sel, cx))))
        .when(Boolean(sel && sel.state !== "question"), (el) => el.child(button("pipeline-go", this.chosen(sel) === sel.coder ? "Ouvrir l'agent code" : "Ouvrir l'agent review", "↵", true, () => this.open(sel)))));
  }
}
