// PR inbox: the GitHub pull requests waiting on me, all repos, without leaving Herdr.
// Two copies of this view. The floating one (layouts/mine.json: right edge, peek 52) polls
// gh every 90 s, keeps the rows in shared("pr-inbox.state"), toasts what is new and draws
// the drawer. The dialog one (mod.open:pr-inbox, ctrl-shift-g, or a click in the drawer)
// reads that state: list, detail with the reviews' comments, and the buttons that launch
// Claude on the PR's branch. Claude prepares, the person posts: nothing here writes to
// GitHub but "mark read".

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { run, props, closeOverlay, theme, exec, shared, setShared, placement, notify } from "herdr";
import { rowsOf, fresh, toastFor, sub, dotOf, ago, SECTIONS, prOf } from "./lib.js";

const POLL = 90000;
const STATE = "pr-inbox.state"; // { at, error, rows }
const SEEN = "pr-inbox.seen"; // notification ids already reported; null before the first poll ever
const FOCUS = "pr-inbox.focus"; // { key } the dialog opens on
const OPEN = "pr-inbox.open"; // the dialog is open
const SEARCH = "number,title,repository,updatedAt,isDraft,author,url";
const VIEW = "number,title,url,headRefName,headRefOid,isCrossRepository,author,isDraft,reviewDecision,reviews,statusCheckRollup,additions,deletions,changedFiles,body";

async function gh(args) {
  const r = await exec("gh", args);
  if (r.code !== 0) throw new Error(`GitHub : ${(r.stderr || r.stdout || "gh a échoué").trim().split("\n")[0].slice(0, 200)}`);
  return JSON.parse(r.stdout || "null");
}

const empty = () => ({ at: null, error: null, rows: [] });

export default class PrInbox extends View {
  init(_props, cx) {
    this.floating = placement() !== null;
    this.details = {}; // key -> { at: updatedAt, view } from gh pr view, refetched when the PR moved
    if (!this.floating) return;
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
          if (this.details[key]?.at === p.updatedAt) return;
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
          setShared(FOCUS, { key: row.key });
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

  dialog() {
    const t = theme();
    return v_flex().id("pr-inbox-dialog").size_full().p(16).bg(t.popover).text_size(13).child(div().text_color(t.foreground).child("Pull requests"));
  }
}
