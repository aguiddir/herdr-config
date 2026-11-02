// Cockpit: every Claude agent on one screen, the ones that need me first, each with its last
// words, its branch and how long it has been in that state. Opened by mod.open:cockpit.
// ↑↓ picks a card, ↵ opens its terminal, 1-9 answers a question's choice, esc closes.
// The last words come from the agent's own transcript: herdr-core knows the terminal's foreground
// pid, Claude keeps ~/.claude/sessions/<pid>.json naming the session, and the session's .jsonl
// is read from its end (readTextFile stops at 1 MiB; transcripts don't).

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { run, props, closeOverlay, theme, agents, panes, terminals, hc, exec, readTextFile, home } from "herdr";
import { transcriptPath, lastWords, brief, ago } from "./lib.js";

const RANK = { blocked: 3, done: 3, working: 2, idle: 1 };
// Statuses and sections as Herdr's own sidebar names them.
const SECTION = { 3: "Needs you", 2: "Working", 1: "Idle" };

export default class Cockpit extends View {
  init(_props, cx) {
    this.words = {}; // address -> { seq, text, at, question }
    this.at = 0;
    this.error = "";
    this.reply = InputState.new({ placeholder: "Répondre…" });
    this.reply.on("submit", (_e, cx) => cx.spawn(async (cx) => this.send(cx)));
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.timer.after(600, () => this.handle.focus());
    cx.timer.every(15000, (cx) => this.refresh(cx, true));
  }

  // pid: Claude's own process; msg: what it reports doing right now (OSC 7501), while working.
  list() {
    const by = new Map(panes().map((p) => [p.pane, p]));
    const live = new Map(terminals().map((t) => [t.address, t]));
    return agents()
      .filter((a) => a.app === "claude-code")
      .map((a) => ({ ...a, branch: by.get(a.pane)?.branch ?? null, pid: live.get(a.address)?.foreground?.pid ?? null, msg: live.get(a.address)?.report?.msg ?? null }))
      .sort((x, y) => RANK[y.status] - RANK[x.status] || y.seq - x.seq);
  }

  // Reloads the words of agents whose state moved (always: every agent, for the timer).
  refresh(cx, all = false) {
    const stale = this.list().filter((a) => all || this.words[a.address]?.seq !== a.seq);
    if (!stale.length || this.loading) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      await Promise.all(stale.map(async (a) => {
        try { this.words[a.address] = { seq: a.seq, ...(await this.read(a)) }; } catch (e) { this.error = String(e.message ?? e); }
      }));
      this.loading = false;
      cx.notify();
    });
  }

  async read(a) {
    const session = a.pid && (await readTextFile(`${home()}/.claude/sessions/${a.pid}.json`));
    if (!session) return { text: null, at: null, question: null };
    // Only the lines that carry a message, the newest 30, each cut short: a tool result holding a
    // screenshot is a quarter of a megabyte on its own, and a cut line is skipped by lastWords.
    const tail = await exec("sh", ["-c", `tail -c 6000000 "$1" | grep -aE '"type":"(assistant|user)"' | tail -n 30 | cut -c1-60000`, "sh", transcriptPath(home(), JSON.parse(session))]);
    return lastWords(tail.stdout ?? "");
  }

  close() {
    closeOverlay(props().overlay);
  }

  open(a) {
    run("pane.focus", { pane: a.pane });
    this.close();
  }

  // ponytail: the choice is picked with ↓ and ↵ in Claude's own dialog; if a version of Claude
  // wants a second ↵ to submit, add it here.
  async pick(a, i) {
    const r = await hc(["keys", a.address, ...Array(i).fill("down"), "enter"]);
    if (r.code !== 0) this.error = (r.stderr || r.stdout || "").trim();
  }

  async send(cx) {
    const a = this.list()[this.at];
    const text = this.reply.value().trim();
    if (!a || !text) return;
    const r = await hc(["send", a.address, text]);
    if (r.code !== 0) this.error = (r.stderr || r.stdout || "").trim();
    else this.reply.set_value("");
    cx.notify();
  }

  key(e, cx) {
    const list = this.list();
    const n = list.length;
    const cur = list[Math.min(this.at, n - 1)];
    if (e.key === "escape") return this.close();
    if (e.key === "enter" && cur && !this.reply.is_focused?.()) return this.open(cur);
    if ((e.key === "down" || e.key === "up") && n) this.at = (Math.min(this.at, n - 1) + (e.key === "down" ? 1 : n - 1)) % n;
    else if (/^[1-9]$/.test(e.key) && cur && this.words[cur.address]?.question?.options?.[Number(e.key) - 1]) cx.spawn(async () => this.pick(cur, Number(e.key) - 1));
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  render(cx) {
    const t = theme();
    const list = this.list();
    this.refresh(cx);
    const now = Date.now();
    const needs = list.filter((a) => RANK[a.status] === 3).length;
    const topics = new Set(list.map((a) => a.space)).size;
    const color = (a) => t[a.status] ?? t.dim;
    const button = (id, label, primary, onClick) =>
      h_flex().id(id).h(28).px(12).flex_none().items_center().rounded(6).text_size(12.5).cursor_pointer()
        .when(primary, (el) => el.bg(t.solid).text_color(t.solid_foreground).font_semibold())
        .when(!primary, (el) => el.border(1).border_color(t.input).text_color(t.foreground).hover((s) => s.bg(t.hover)))
        .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); })
        .child(label);

    const card = (a, i) => {
      const w = this.words[a.address] ?? {};
      const on = i === this.at;
      const urgent = RANK[a.status] === 3;
      const q = a.status === "blocked" ? w.question : null;
      const head = h_flex().gap(10).items_center()
        .child(div().size(9).flex_none().rounded(5).when(a.status !== "idle", (el) => el.bg(color(a))).when(a.status === "idle", (el) => el.border(1.5).border_color(t.dim)))
        .child(div().font_semibold().text_color(t.foreground).text_size(14).child(a.space_name))
        .when(a.tab_name !== a.space_name && !/^\d+$/.test(a.tab_name), (el) => el.child(div().text_color(t.muted).truncate().child(a.tab_name)))
        .child(div().flex_1())
        .when(Boolean(a.branch), (el) => el.child(div().flex_none().px(7).h(20).rounded(5).bg(t.background).text_size(11.5).text_color(t.muted).flex().items_center().child(a.branch)))
        .child(div().flex_none().text_size(12).text_color(color(a)).child(`${a.status}${w.at && a.status !== "working" ? ` for ${ago(now - w.at)}` : ""}`));
      const body = urgent || on;
      const shown = a.status === "working" ? a.msg : q ? q.question : w.text;
      return v_flex()
        .id(`ck-${a.address}`)
        .flex_none()
        .px(14).py(urgent ? 12 : 9).gap(8)
        .rounded(10)
        .bg(urgent ? t.raised : t.popover)
        .border(1).border_color(on ? t.accent : urgent ? color(a) + "66" : t.border)
        .cursor_pointer()
        .on_click((_e, cx) => { this.at = i; cx.notify(); })
        .child(head)
        .when(body && Boolean(shown), (el) => el.child(h_flex().gap(10).pl(19).items_start()
          .child(div().w(3).flex_none().self_stretch().rounded(2).bg(t.input))
          .child(div().flex_1().min_w(0).text_color(t.foreground).child(brief(shown)))))
        .when(Boolean(q), (el) => el.child(h_flex().gap(8).pl(19).flex_wrap().children(q.options.map((o, k) =>
          button(`ck-opt-${a.address}-${k}`, `${k + 1} · ${o.label}`, k === 0, (cx) => cx.spawn(async () => this.pick(a, k)))))))
        .when(body, (el) => el.child(h_flex().gap(8).pl(19).items_center()
          .child(button(`ck-open-${a.address}`, "Ouvrir le terminal ↵", !q, () => this.open(a)))
          .when(a.status === "blocked" && !q, (x) => x.child(div().text_size(12).text_color(t.dim).child("attend dans son terminal (permission ou autre dialogue)")))
          .when(on && a.status !== "blocked", (x) => x.child(Input.new(this.reply).flex_1().h(28).px(10).items_center().rounded(6).border(1).border_color(t.input).bg(t.background).text_color(t.foreground)))));
    };

    const rows = [];
    let section = null;
    list.forEach((a, i) => {
      const s = SECTION[RANK[a.status]];
      if (s !== section) { section = s; rows.push(div().pt(rows.length ? 10 : 0).px(4).text_size(11).font_semibold().text_color(RANK[a.status] === 3 ? t.blocked : t.dim).child(s.toUpperCase())); }
      rows.push(card(a, i));
    });

    return v_flex()
      .id("cockpit")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .size_full()
      .p(16)
      .gap(10)
      .bg(t.popover)
      .text_size(13)
      .child(h_flex().gap(12).items_center()
        .child(div().text_size(15).font_semibold().text_color(t.foreground).child("Cockpit"))
        .when(needs > 0, (el) => el.child(div().px(8).h(20).rounded(5).bg(t.blocked + "26").text_size(12).font_semibold().text_color(t.blocked).flex().items_center().child(`${needs} à traiter`)))
        .child(div().flex_1())
        .child(div().text_size(12).text_color(t.dim).child(`${topics} sujet${topics > 1 ? "s" : ""} ouvert${topics > 1 ? "s" : ""}`))
        .child(div().text_size(11).text_color(t.dim).child("esc")))
      .child(v_flex().id("ck-list").flex_1().min_h(0).gap(8).overflow_y_scrollbar().children(
        list.length ? rows : [div().p(8).text_color(t.dim).child("Aucun Claude ouvert.")]))
      .when(Boolean(this.error), (el) => el.child(div().text_color(t.blocked).child(this.error)))
      .child(div().text_size(11).text_color(t.dim).child("↑↓ choisir · ↵ ouvrir le terminal · 1-9 répondre à une question · esc fermer"));
  }
}
