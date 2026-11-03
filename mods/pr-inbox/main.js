// PR inbox: the GitHub pull requests waiting on me, all repos, without leaving Herdr.
// Two copies of this view. The floating one (layouts/mine.json: right edge, peek 52) polls
// gh every 90 s, keeps the rows in shared("pr-inbox.state"), toasts what is new and draws
// the drawer. The dialog one (mod.open:pr-inbox, ctrl-shift-g, or a click in the drawer)
// reads that state: list, detail with the reviews' comments, and the buttons that launch
// Claude on the PR's branch. Claude prepares, the person posts: nothing here writes to
// GitHub but "mark read".

import { View, div } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { run, props, closeOverlay, theme, exec, shared, setShared, placement, notify, window, settings } from "herdr";
import { rowsOf, fresh, toastFor, sub, dotOf, ago, ci, SECTIONS, prOf, threads, verdict, step } from "./lib.js";

const POLL = 90000;
const STATE = "pr-inbox.state"; // { at, error, rows }
const SEEN = "pr-inbox.seen"; // notification ids already reported; null before the first poll ever
const FOCUS = "pr-inbox.focus"; // { key } the dialog opens on
const OPEN = "pr-inbox.open"; // the dialog is open
const SEARCH = "number,title,repository,updatedAt,isDraft,author,url";
const VIEW = "number,title,url,headRefName,headRefOid,isCrossRepository,author,isDraft,reviewDecision,reviews,statusCheckRollup,additions,deletions,changedFiles,body";
const CI = { ok: ["✓", "done"], run: ["◐", "working"], ko: ["✗", "blocked"] };
const VERDICT_COLOR = { APPROVED: "done", CHANGES_REQUESTED: "blocked" };

async function gh(args) {
  const r = await exec("gh", args);
  if (r.code !== 0) throw new Error(`GitHub : ${(r.stderr || r.stdout || "gh a échoué").trim().split("\n")[0].slice(0, 200)}`);
  return JSON.parse(r.stdout || "null");
}

const empty = () => ({ at: null, error: null, rows: [] });
const oneLine = (s, n) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };

export default class PrInbox extends View {
  init(_props, cx) {
    // placement() is null while a floating copy is being placed: the overlay id tells the copies apart.
    this.floating = !props()?.overlay;
    this.details = {}; // key -> { at: updatedAt, view } from gh pr view, refetched when the PR moved
    if (!this.floating) return this.initDialog(cx);
    setShared(OPEN, false); // a dialog can't have survived a restart, whatever was persisted
    this.poll(cx);
    cx.timer.every(POLL, (cx) => this.poll(cx));
    cx.timer.every(60000, (cx) => cx.notify()); // the « il y a … » texts
  }

  // One poll at a time. A failure keeps the rows and says so on the drawer's last line.
  poll(cx) {
    if (this.polling) return;
    this.polling = true;
    cx.spawn(async (cx) => {
      const prev = shared(STATE) ?? empty();
      try {
        // Every page of notifications: one is 50 threads. Who I am, once, and only if gh says so
        // (a failed call would count my own reviews as remarks).
        const [requested, mine, pages, user] = await Promise.all([
          gh(["search", "prs", "--review-requested=@me", "--state", "open", "--limit", "50", "--json", SEARCH]),
          gh(["search", "prs", "--author=@me", "--state", "open", "--limit", "50", "--json", SEARCH]),
          gh(["api", "--paginate", "--slurp", "notifications"]),
          this.me ? null : gh(["api", "user"]),
        ]);
        if (user) this.me = user.login;
        const notifs = pages.flat();
        const all = [...requested, ...mine];
        const keyOf = (p) => `${p.repository.nameWithOwner}#${p.number}`;
        // The detail of a PR is fetched again only when GitHub says it moved; one that fails keeps its last.
        await Promise.all(all.map(async (p) => {
          const key = keyOf(p);
          const have = this.details[key];
          if (have?.at === p.updatedAt && ci(have.view?.statusCheckRollup) !== "run") return; // a check's end doesn't move updatedAt
          try { this.details[key] = { at: p.updatedAt, view: await gh(["pr", "view", String(p.number), "--repo", p.repository.nameWithOwner, "--json", VIEW]) }; } catch {}
        }));
        const live = new Set(all.map(keyOf));
        for (const key of Object.keys(this.details)) if (!live.has(key)) delete this.details[key];
        const details = Object.fromEntries(Object.entries(this.details).map(([k, d]) => [k, d.view]));
        const rows = rowsOf({ requested, mine, notifs, details, me: this.me });
        const { fresh: news, seen } = fresh(notifs, shared(SEEN) ?? null);
        for (const n of news) {
          const pr = prOf(n);
          const row = rows.find((r) => r.repo === pr.repo && r.number === pr.number);
          if (!row) continue; // a mention on a PR that is neither mine nor to review: nothing to show for it
          if (!shared(OPEN)) setShared(FOCUS, { key: row.key }); // an open dialog keeps its row
          notify({ ...toastFor(n, row), level: "info", action: { name: "mod.open", args: { name: "pr-inbox" } } });
        }
        setShared(SEEN, seen);
        setShared(STATE, { at: Date.now(), error: null, rows });
      } catch (e) {
        setShared(STATE, { ...prev, error: String(e.message ?? e) });
      }
      this.polling = false;
      cx.notify();
    });
  }

  // Opens the dialog on a row, or moves the open one to it.
  openOn(key) {
    setShared(FOCUS, { key });
    if (!shared(OPEN)) run("mod.open", { name: "pr-inbox" });
  }

  render(cx) {
    return this.floating ? this.drawer(cx) : this.dialog(cx);
  }

  // The drawer: 52 px on the edge side (badges, dots) peek out; the rest slides out on hover.
  // One layout, never changed on hover: the edge cell is always first, mirrored on the right.
  drawer() {
    const t = theme();
    const st = shared(STATE) ?? empty();
    const right = placement()?.edge !== "left";
    const now = Date.now();
    let total = 0; // a floating block sizes to its content: max_h wouldn't cap it, so the height is set
    const line = (id, h, edge, body) => {
      total += h;
      const el = h_flex().id(id).h(h).w_full().flex_none().items_center();
      if (right) el.flex_row_reverse();
      return el.child(h_flex().w(52).flex_none().items_center().justify_center().child(edge)).child(v_flex().flex_1().min_w(0).justify_center().pr(right ? 0 : 12).pl(right ? 12 : 0).children(body));
    };
    const badge = (n, color) => h_flex().min_w(20).h(20).px(6).rounded(10).bg(color + "26").items_center().justify_center().text_size(11.5).font_semibold().text_color(color).child(String(n));
    const rows = [];
    for (const [sec, label, color] of SECTIONS) {
      const list = st.rows.filter((r) => r.section === sec);
      if (!list.length) continue;
      rows.push(line(`pi-sec-${sec}`, 26, badge(list.length, t[color]), [div().text_size(10.5).font_semibold().text_color(sec === "review" ? t.blocked : t.dim).child(label.toUpperCase())]));
      for (const r of list) {
        rows.push(
          line(`pi-${r.key}`, 40, div().size(8).rounded(4).bg(t[dotOf(r)]), [
            div().truncate().text_size(12.5).text_color(t.foreground).child(`#${r.number} ${r.title}`),
            div().truncate().text_size(11).text_color(t.dim).child(sub(r, now)),
          ]).cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => this.openOn(r.key)),
        );
      }
    }
    if (!rows.length) rows.push(line("pi-none", 40, div().size(8).rounded(4).border(1.5).border_color(t.dim), [div().text_color(t.muted).child(st.at ? "Rien en attente" : "Chargement…")]));
    const foot = st.error ? div().truncate().text_size(11).text_color(t.blocked).child(st.error) : div().text_size(11).text_color(t.dim).child(st.at ? `mis à jour ${ago(now - st.at)}` : "");
    rows.push(line("pi-foot", 24, div(), [foot]));
    return v_flex().id("pr-inbox").w(360).h(Math.min(640, total)).overflow_y_scrollbar().text_size(13).children(rows);
  }

  // ---- the dialog copy ----

  initDialog(cx) {
    setShared(OPEN, true);
    this.sel = null; // the selected row's key (not `key`: that is the key handler): the rows are rewritten by every poll
    this.threads = {}; // key -> { at: updatedAt, threads, loading?, error? }
    this.error = "";
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.timer.after(600, () => this.handle.focus());
    this.scroll = VirtualListScrollHandle.new(); // keeps the row chosen with the arrows on screen
    this.keys = []; // the list's items (headers and rows) by key, as last drawn: where a row sits in it
    this.follow(cx);
  }

  // Herdr's cleanup call when the overlay goes (esc, a click beside it, our own button).
  async close() {
    setShared(OPEN, false);
  }

  dismiss() {
    setShared(OPEN, false);
    closeOverlay(props().overlay);
  }

  rows() {
    return (shared(STATE) ?? empty()).rows;
  }

  selected() {
    const rows = this.rows();
    return rows.find((r) => r.key === this.sel) ?? rows[0];
  }

  // Moves to the row the drawer or a toast asked for, if any, and loads its comments.
  follow(cx) {
    const key = shared(FOCUS)?.key;
    if (key) {
      if (this.rows().some((r) => r.key === key)) this.sel = key;
      setShared(FOCUS, null);
    }
    this.loadThreads(cx);
  }

  // The reviews with their inline comments, for the selected row, once per update of the PR.
  loadThreads(cx) {
    const r = this.selected();
    if (!r || this.threads[r.key]?.at === r.updatedAt) return;
    this.threads[r.key] = { at: r.updatedAt, loading: true, threads: [] };
    cx.spawn(async (cx) => {
      try {
        // REST for both: the comments name their review by its database id, which GraphQL's `gh pr view` doesn't give.
        const pages = async (what) => (await gh(["api", "--paginate", "--slurp", `repos/${r.repo}/pulls/${r.number}/${what}`]) ?? []).flat();
        const [reviews, comments] = await Promise.all([pages("reviews"), pages("comments")]);
        this.threads[r.key] = { at: r.updatedAt, threads: threads(reviews, comments) };
      } catch (e) {
        this.threads[r.key] = { at: r.updatedAt, error: String(e.message ?? e), threads: [] };
      }
      cx.notify();
    });
  }

  // GitHub forgets the notifications of this PR; the row leaves « Retour » for « En attente »
  // right away (the next poll confirms).
  // "Marquer lu", from its button or `r`: the error shows under the buttons, the row stays.
  read(cx) {
    const r = this.selected();
    if (!r?.notifs.length) return;
    cx.spawn(async (cx) => { try { await this.markRead(r); } catch (e) { this.error = String(e.message ?? e); } cx.notify(); });
  }

  async markRead(r) {
    await Promise.all(r.notifs.map((id) => exec("gh", ["api", "-X", "PATCH", `notifications/threads/${id}`])));
    const st = shared(STATE) ?? empty();
    setShared(STATE, { ...st, rows: st.rows.map((x) => (x.key !== r.key ? x : { ...x, notifs: [], section: x.section === "back" ? "wait" : x.section })) });
  }

  openGitHub(r) {
    exec(window().platform === "macos" ? "open" : "xdg-open", [r.url]);
  }

  key(e, cx) {
    const rows = this.rows();
    const n = rows.length;
    if (e.key === "escape") return this.dismiss();
    if (e.key === "enter") return cx.spawn(async (cx) => this.launch(cx));
    if (e.key === "o" && n) return this.openGitHub(this.selected());
    if (e.key === "r") return this.read(cx);
    if ((e.key === "down" || e.key === "up") && n) this.scroll.scroll_to_item(this.keys.indexOf((this.sel = step(rows, this.sel, e.key === "down" ? 1 : -1))));
    else return;
    this.loadThreads(cx);
    cx.stop_propagation();
    cx.notify();
  }

  // Task 6 fills this in.
  async launch() {}

  primaryLabel(r) {
    return r.section === "review" ? "▶ Relire avec Claude" : r.section === "back" ? "▶ Traiter les remarques avec Claude" : null;
  }

  dialog(cx) {
    const t = theme();
    this.follow(cx);
    const rows = this.rows();
    const st = shared(STATE) ?? empty();
    const sel = this.selected();
    const now = Date.now();
    const todo = rows.filter((r) => r.section !== "wait").length;
    const repos = new Set(rows.map((r) => r.repo)).size;
    // Each button carries its key, so the hint line stays short whatever the primary label's length.
    const button = (id, label, key, primary, onClick, disabled = false) =>
      h_flex().id(id).h(28).px(12).gap(8).flex_none().items_center().rounded(6).text_size(12.5).cursor_pointer()
        .when(primary && !disabled, (el) => el.bg(t.solid).text_color(t.solid_foreground).font_semibold())
        .when(primary && disabled, (el) => el.bg(t.raised).text_color(t.dim).font_semibold())
        .when(!primary, (el) => el.border(1).border_color(t.input).text_color(t.foreground).hover((s) => s.bg(t.hover)))
        .on_click((_e, cx) => { cx.stop_propagation(); if (!disabled) onClick(cx); })
        .child(label)
        .child(div().text_size(10.5).font_normal().opacity(0.6).child(key));
    const chip = (text) => h_flex().h(20).px(8).rounded(5).bg(t.raised).items_center().text_size(11.5).text_color(t.muted).child(text);

    // Headers and rows for a virtual list: it places them by the heights given here, and
    // draws only the visible range, so each item is built when asked (an element built
    // ahead and handed over later draws nothing).
    const list = []; // { key, h, draw }
    for (const [sec, label, color] of SECTIONS) {
      const of = rows.filter((r) => r.section === sec);
      if (!of.length) continue;
      const first = !list.length;
      list.push({ key: `sec-${sec}`, h: first ? 26 : 32, draw: () => h_flex().h(first ? 26 : 32).px(10).pt(first ? 4 : 10).pb(4).gap(8).items_center().child(div().text_size(10.5).font_semibold().text_color(sec === "review" ? t.blocked : t.dim).child(label.toUpperCase())).child(div().text_size(10.5).font_semibold().text_color(t[color]).child(String(of.length))) });
      for (const r of of) {
        const on = r.key === sel?.key;
        const [glyph, ciColor] = CI[r.ci] ?? ["", "dim"];
        list.push({ key: r.key, h: 48, draw: () =>
          h_flex().id(`pid-${r.key}`).h(48).px(10).py(7).gap(10).items_start().rounded(7).cursor_pointer()
            .when(on, (el) => el.bg(t.selected)).when(!on, (el) => el.hover((s) => s.bg(t.hover)))
            .child(div().size(8).mt(6).flex_none().rounded(4).bg(t[dotOf(r)]))
            .child(v_flex().flex_1().min_w(0)
              .child(div().truncate().text_size(12.5).text_color(t.foreground).child(`#${r.number} ${r.title}`))
              .child(h_flex().gap(6).child(div().truncate().text_size(11).text_color(t.dim).child(sub(r, now))).when(Boolean(glyph), (el) => el.child(div().flex_none().text_size(11).text_color(t[ciColor]).child(`${glyph} CI`))))),
        });
      }
    }

    this.keys = list.map((i) => i.key);
    const detail = sel ? this.detail(sel, t, chip, now) : [div().text_color(t.dim).child(st.at ? "Rien en attente." : "Chargement…")];
    const th = sel && this.threads[sel.key];
    const primary = sel && this.primaryLabel(sel);
    return v_flex()
      .id("pr-inbox-dialog")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .size_full()
      .bg(t.popover)
      .text_size(13)
      .child(h_flex().px(16).py(14).gap(12).items_center().border_b(1).border_color(t.border)
        .child(div().text_size(15).font_semibold().text_color(t.foreground).child("Pull requests"))
        .when(todo > 0, (el) => el.child(h_flex().h(20).px(8).rounded(10).bg(t.blocked + "26").items_center().text_size(11.5).font_semibold().text_color(t.blocked).child(`${todo} à traiter`)))
        .child(div().text_size(12).text_color(t.dim).child(st.at ? `${repos} repo${repos > 1 ? "s" : ""} · mis à jour ${ago(now - st.at)}` : "chargement…"))
        .child(div().flex_1())
        .child(div().text_size(11).text_color(t.dim).child("esc")))
      .child(h_flex().flex_1().min_h(0).items_stretch() // h_flex centers its items: the columns must fill the height
        .child(v_flex().id("pid-list").w(380).flex_none().min_h(0).p(6).border_r(1).border_color(t.border)
          .when(list.length > 0, (el) => el.child(v_flex().flex_1().min_h(0).relative()
            .child(v_virtual_list("pid-rows", list.length, list.map((i) => i.h), (i) => list[i].key, (range) => list.slice(range.start, range.end).map((i) => i.draw())).track_scroll(this.scroll)
              .on_item_click((key, cx) => { if (rows.some((r) => r.key === key)) { this.sel = key; this.loadThreads(cx); cx.notify(); } }).size_full())
            .child(Scrollbar.vertical("pid-rows").absolute().inset_0())))
          .when(list.length === 0, (el) => el.child(div().p(8).text_color(t.dim).child(st.at ? "Rien en attente." : "Chargement…"))))
        .child(v_flex().flex_1().min_w(0)
          .child(v_flex().id("pid-detail").flex_1().min_h(0).px(20).py(16).gap(14).overflow_y_scrollbar().children(detail))
          .when(Boolean(sel), (el) => el.child(v_flex().px(20).py(12).gap(8).border_t(1).border_color(t.border)
            .child(h_flex().gap(8).items_center()
              .when(Boolean(primary), (x) => x.child(button("pid-go", primary, "↵", true, (cx) => cx.spawn(async (cx) => this.launch(cx)), th?.loading)))
              .child(button("pid-gh", "Ouvrir sur GitHub ↗", "o", false, () => this.openGitHub(sel)))
              .when(sel.notifs.length > 0, (x) => x.child(button("pid-read", "Marquer lu", "r", false, (cx) => this.read(cx))))
              .child(div().flex_1())
              .child(div().text_size(11).text_color(t.dim).child("↑↓ choisir · ↵ lancer · esc")))
            .when(Boolean(this.note), (x) => x.child(div().text_size(11.5).text_color(t.dim).child(this.note)))
            .when(Boolean(this.error), (x) => x.child(div().text_size(12).text_color(t.blocked).child(this.error)))))));
  }

  // The right column: the PR, then its reviews with their comments, read-only.
  detail(r, t, chip, now) {
    const [glyph, ciColor] = CI[r.ci] ?? ["", "dim"];
    const th = this.threads[r.key];
    const mono = settings().font_family ?? "JetBrains Mono"; // as the changes mod does
    const out = [
      div().text_size(15).font_semibold().text_color(t.foreground).child(`#${r.number} ${r.title}`),
      h_flex().gap(12).flex_wrap().items_center().text_size(12).text_color(t.muted)
        .child(div().child(r.name))
        .child(div().text_color(t.foreground).child(r.mine ? "toi" : r.author))
        .when(Boolean(r.branch), (el) => el.child(chip(`⎇ ${r.branch}`)))
        .when(Boolean(glyph), (el) => el.child(div().text_color(t[ciColor]).child(`${glyph} CI`)))
        .when(r.changedFiles !== null, (el) => el.child(h_flex().gap(4).child(div().child(`${r.changedFiles} fichiers`)).child(div().text_color(t.done).child(`+${r.additions}`)).child(div().text_color(t.blocked).child(`−${r.deletions}`))))
        .when(r.draft, (el) => el.child(chip("brouillon"))),
    ];
    if (r.body) out.push(div().text_color(t.muted).child(oneLine(r.body, 300)));
    const card = (x) => {
      const color = t[VERDICT_COLOR[x.state] ?? "ansi5"];
      const c = v_flex().px(12).py(10).gap(8).rounded(9).border(1).border_color(t.border)
        .child(h_flex().gap(8).items_center()
          .child(h_flex().size(20).rounded(10).bg(t.input).items_center().justify_center().text_size(10).font_bold().text_color(t.foreground).child(x.author[0]?.toUpperCase() ?? "?"))
          .child(div().font_semibold().text_color(t.foreground).child(x.author))
          .child(div().text_color(color).child(verdict(x.state)))
          .child(div().flex_1())
          .when(Boolean(x.submittedAt), (el) => el.child(div().text_size(11).text_color(t.dim).child(ago(now - Date.parse(x.submittedAt))))));
      if (x.body) c.child(div().text_color(t.muted).child(x.body));
      for (const k of x.comments) {
        c.child(k.reply
          ? div().pl(26).text_color(t.muted).child(`↳ ${k.author} : ${k.body}`)
          : h_flex().gap(10).pl(4).items_start().child(div().w(3).flex_none().self_stretch().rounded(2).bg(t.input)).child(v_flex().flex_1().min_w(0).child(div().text_size(11.5).font_family(mono).text_color(t.ansi6).child(k.line != null ? `${k.path}:${k.line}` : k.path)).child(div().text_color(t.foreground).child(k.body))));
      }
      return c;
    };
    if (th?.loading) out.push(div().text_color(t.dim).child("Chargement des commentaires…"));
    else if (th?.error) out.push(div().text_color(t.blocked).child(th.error));
    else if (th?.threads.length) out.push(...th.threads.map(card));
    else out.push(div().text_color(t.dim).child(r.section === "review" ? "Personne n'a encore commenté." : `Personne n'a encore relu.${r.ci ? ` CI ${r.ci === "ok" ? "passée" : r.ci === "run" ? "en cours" : "en échec"}.` : ""}`));
    return out;
  }
}
