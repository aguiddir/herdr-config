// PR inbox: the GitHub pull requests waiting on me, all repos, without leaving Herdr.
// Two copies of this view. The floating one (layouts/mine.json: right edge, peek 52) polls
// gh every 90 s, keeps the rows in shared("pr-inbox.state"), toasts what is new and draws
// the drawer. The dialog one (mod.open:pr-inbox, ctrl-shift-g, or a click in the drawer)
// reads that state: list, detail with the reviews' comments, and the buttons that launch
// Claude on the PR's branch. Claude prepares, the person posts: nothing here writes to
// GitHub but "mark read".

import { View, div } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { run, props, closeOverlay, theme, exec, shared, setShared, placement, notify, window, settings, panes, spaces, appHome, home, readTextFile, writeTextFile, pickFolder } from "herdr";
import { rowsOf, fresh, toastFor, sub, dotOf, ago, ci, SECTIONS, prOf, threads, verdict, reviewPrompt, fixPrompt, branchOf, argvFor, step } from "./lib.js";
import { localRepo, checkoutFor, checkoutsOf, spaceIn, safe } from "./worktree.js";

const POLL = 90000;
const STATE = "pr-inbox.state"; // { at, error, rows }
const SEEN = "pr-inbox.seen"; // notification ids already reported; null before the first poll ever
const FOCUS = "pr-inbox.focus"; // { key } the dialog opens on
const OPEN = "pr-inbox.open"; // the dialog is open
const SEARCH = "number,title,repository,updatedAt,isDraft,author,url";
const VIEW = "number,title,url,headRefName,headRefOid,isCrossRepository,author,isDraft,reviewDecision,reviews,statusCheckRollup,additions,deletions,changedFiles,body";
const CI = { ok: ["✓", "done"], run: ["◐", "working"], ko: ["✗", "blocked"] };
const CONFIG = () => `${appHome()}/mods/pr-inbox/config.json`; // { "repos": { "owner/name": "/folder" } }
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
    this.where = {}; // key -> { at: updatedAt, repo, path, open } : where ↵ would go, said before the click
    this.repos = {}; // owner/name -> the local repo (or null): found once per dialog, not per row
    this.error = "";
    this.busy = false;
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
    this.locate(cx);
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

  primaryLabel(r) {
    return r.section === "review" ? "▶ Relire avec Claude" : r.section === "back" ? "▶ Traiter les remarques avec Claude" : null;
  }

  // Folders that may be a checkout of the PR's repo: the spaces' and terminals' folders,
  // the repo's worktrees, and what config.json was told.
  async candidates(r) {
    const config = JSON.parse((await readTextFile(CONFIG())) ?? "{}");
    const trees = await exec("find", [`${home()}/.herdr/worktrees/${r.name}`, "-mindepth", "1", "-maxdepth", "1", "-type", "d"]).catch(() => null);
    return [...spaces().filter((s) => !s.machine).map((s) => s.folder), ...panes().map((p) => p.cwd), ...(trees?.stdout ?? "").split("\n"), config.repos?.[r.repo]].filter(Boolean);
  }

  // Finds the repo, the checkout and the space of the selected PR, for the note under the buttons.
  // Once per update of the PR, and not before its branch is known (gh pr view may still be out).
  locate(cx) {
    const r = this.selected();
    if (!r || !this.primaryLabel(r) || !r.branch || this.where[r.key]?.at === r.updatedAt) return;
    this.where[r.key] = { at: r.updatedAt, loading: true };
    cx.spawn(async (cx) => {
      try {
        if (!(r.repo in this.repos)) this.repos[r.repo] = await localRepo(r.repo, await this.candidates(r));
        const repo = this.repos[r.repo];
        const checkouts = repo ? await checkoutsOf(repo.main) : new Map();
        const path = (repo && checkouts.get(branchOf(r))) ?? null;
        const open = path ? spaceIn(path, checkouts.values(), panes(), spaces()) : null;
        this.where[r.key] = { at: r.updatedAt, repo, path, open };
      } catch (e) {
        this.where[r.key] = { at: r.updatedAt, error: String(e.message ?? e) };
      }
      cx.notify();
    });
  }

  noteFor(r) {
    const w = this.where[r.key];
    if (!w || w.loading) return "";
    if (w.error) return w.error;
    // A fork's code is someone else's: Claude starts in it, its .claude settings and hooks included.
    const then = (r.section === "review" ? `lance claude en review de la PR #${r.number}` : `lance claude avec les ${r.remarks} remarques`) + (r.fork ? " — PR d'un fork : Claude démarre dans le code de quelqu'un d'autre, ses hooks compris" : "");
    if (!w.repo) return `↵ demande où est le dépôt ${r.repo} sur cette machine, puis ${then}.`;
    const b = branchOf(r); // known: locate waits for the branch
    if (w.open) return `↵ ouvre l'espace « ${w.open.space.name} » (déjà ouvert sur ${b}), puis ${then}.`;
    if (w.path) return `↵ ouvre un espace sur ${w.path.replace(home(), "~")} (déjà sortie), puis ${then}.`;
    return `↵ crée le worktree ~/.herdr/worktrees/${w.repo.name}/${safe(b)} et un espace dessus, puis ${then}.`;
  }

  // The repo's main checkout on this machine; asked for, and kept in config.json, when none is found.
  async repoFor(r) {
    const repo = await localRepo(r.repo, await this.candidates(r));
    if (repo) return repo;
    const folder = await pickFolder({ prompt: "Ce dossier" });
    if (!folder) throw new Error(`Dépôt introuvable : indique son dossier (${r.repo}).`);
    const found = await localRepo(r.repo, [folder]);
    if (!found) throw new Error(`${folder.replace(home(), "~")} n'est pas un clone de ${r.repo}.`);
    const before = await readTextFile(CONFIG());
    const config = JSON.parse(before ?? "{}");
    config.repos = { ...config.repos, [r.repo]: folder };
    await writeTextFile(CONFIG(), JSON.stringify(config, null, 2) + "\n", before);
    return found;
  }

  // ↵: the PR's branch checked out (made if needed), a space on it (found if open), Claude
  // started there with the prompt as its first message. The notifications are read: the person
  // is on it. Claude prepares, the person posts.
  async launch(cx) {
    const r = this.selected();
    if (!r || this.busy || !this.primaryLabel(r)) return;
    this.busy = true;
    this.error = "";
    cx.notify();
    try {
      if (!r.branch) throw new Error("Branche inconnue : GitHub n'a pas encore répondu pour cette PR.");
      const th = this.threads[r.key];
      if (r.section === "back" && (!th || th.loading || th.error)) throw new Error(th?.error ?? "Les remarques ne sont pas encore chargées : réessaie dans un instant.");
      const repo = await this.repoFor(r);
      const path = await checkoutFor(repo, r);
      const open = spaceIn(path, (await checkoutsOf(repo.main)).values(), panes(), spaces());
      const task = r.section === "review" ? reviewPrompt(r) : fixPrompt(r, this.threads[r.key]?.threads ?? []);
      if (open) {
        run("space.select", { id: open.space.id });
        run("tab.new", { space: open.space.id, name: "claude", folder: path, argv: argvFor(r), task });
      } else run("space.new", { folder: path, tab: "claude", argv: argvFor(r), task }); // unnamed: the space follows the folder and nests under its repo
      if (r.notifs.length) await this.markRead(r);
      notify({ title: `Claude lancé sur ${repo.name} · ${branchOf(r)}`, body: r.section === "review" ? `Review de la PR #${r.number}${open ? "" : " dans un nouvel espace"}.` : `Il traite les ${r.remarks} remarques de la PR #${r.number}.`, level: "success" });
      this.dismiss();
    } catch (e) {
      this.error = String(e.message ?? e);
    }
    this.busy = false;
    cx.notify();
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
            .child(h_flex().gap(8).items_center().flex_wrap() // the hint drops to a second line when the primary label is long
              .when(Boolean(primary), (x) => x.child(button("pid-go", this.busy ? "lancement…" : primary, "↵", true, (cx) => cx.spawn(async (cx) => this.launch(cx)), Boolean(th?.loading) || this.busy)))
              .child(button("pid-gh", "Ouvrir sur GitHub ↗", "o", false, () => this.openGitHub(sel)))
              .when(sel.notifs.length > 0, (x) => x.child(button("pid-read", "Marquer lu", "r", false, (cx) => this.read(cx))))
              .child(div().flex_1())
              .child(div().flex_none().text_size(11).text_color(t.dim).child("↑↓ · esc")))
            .when(Boolean(this.noteFor(sel)), (x) => x.child(div().text_size(11.5).text_color(t.dim).child(this.noteFor(sel))))
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
