// The Jenkins build of each terminal's branch, in Herdr instead of Claude Code's ci-watch band,
// with the failed GitHub checks of its commit (the Sonar quality gate reports there, not in Jenkins).
// Two copies of this view:
// - the pane header (layouts/mine.json: "header": { "content": { "mod": "ci" } }), a clone of
//   Herdr's `pane` header plus a chip: one dot a stage, the stage running or the one that broke.
//   Each copy polls Jenkins for its own pane's branch. Props: { pane, terminal }.
// - the dialog (a click on the chip, or mod.open:ci for the focused pane): the stages, the end
//   of the log with its error lines, and Enter to hand the failure to the terminal's Claude.
// Jenkins is read without a token (VPN); which Jenkins is in config.json, out of git (see lib.js).
// The pure pieces are in lib.js.

import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex, ScrollHandle } from "gpui-base";
import { panes, props, run, theme, home, layout, exec, hc, focused, openOverlay, closeOverlay, notify, checking, settings, window, appHome, readTextFile } from "herdr";
import { configOf, repoOf, jobUrl, toBuild, live, failedStage, isFixable, isBroken, checksOf, checksSettled, isShown, chipText, minutes, ago, excerpt, errorIndexes, fixPrompt } from "./lib.js";

const POLL_MS = 10000; // while a build runs; six times slower otherwise
const PR_AGAIN_MS = 5 * 60000; // a branch without a PR is asked to gh again this often
const LATCH_MS = 30000; // a load older than this is given up
const CHECKS_MS = 2 * 60000; // a commit's GitHub checks are asked again this often while they may move
const CHECKS_REST_MS = 30 * 60000; // and this often once all are over, or the build is old
const RUN_TREE = "tree=number,building,result,timestamp,estimatedDuration,duration";

// "missing": Jenkins says the job is not there (404). "failed": anything else (VPN, 5xx).
async function getJson(url) {
  const r = await fetch(url).catch(() => null);
  if (r?.status === 404) return "missing";
  if (!r?.ok) return "failed";
  try { return { data: await r.json() }; } catch { return "failed"; }
}

async function tryJob(cfg, repo, job) {
  const url = jobUrl(cfg, repo, job);
  const got = await getJson(`${url}/lastBuild/api/json?${RUN_TREE}`);
  return typeof got === "string" ? got : { url, run: got.data, label: `${repo} · ${job}` };
}

// The last build of the branch checked out in `cwd`: its own job, else the PR job Jenkins
// builds instead.
// ponytail: the PR job is asked only when the branch has no job, which holds where branches
// with a PR are built as PRs only; compare both builds' start if a Jenkins keeps the two. null: no job; "failed": Jenkins did not answer, keep what was shown.
// "unset": no config.json. cache: { cfg, origin: { cwd: repo }, pr: { "cwd branch": { at, number } },
// build }, one a copy.
// ponytail: local folders only, a remote space's pane has no chip; exec's `on` when needed.
async function loadBuild(cache, cwd, branch) {
  cache.cfg ??= configOf(await readTextFile(`${appHome()}/mods/ci/config.json`).catch(() => null));
  if (!cache.cfg) return "unset";
  if (cache.origin[cwd] === undefined) {
    const r = await exec("git", ["remote", "get-url", "origin"], { cwd }).catch(() => null);
    if (r?.code === 0) cache.origin[cwd] = repoOf(cache.cfg, r.stdout) || null; // a failure is asked again
  }
  const repo = cache.origin[cwd];
  if (!repo) return null;
  let found = await tryJob(cache.cfg, repo, branch);
  if (found === "missing") {
    const key = `${cwd} ${branch}`;
    if (!cache.pr[key] || (!cache.pr[key].number && Date.now() - cache.pr[key].at > PR_AGAIN_MS)) {
      const r = await exec("gh", ["pr", "view", "--json", "number", "-q", ".number"], { cwd }).catch(() => null);
      cache.pr[key] = { at: Date.now(), number: r?.code === 0 ? r.stdout.trim() : "" };
    }
    if (!cache.pr[key].number) return null;
    found = await tryJob(cache.cfg, repo, `PR-${cache.pr[key].number}`);
  }
  if (found === "failed") return "failed";
  if (found === "missing") return null;
  const before = cache.build;
  let b = before;
  // A finished build's stages no longer move.
  if (!(before?.label === found.label && before.number === found.run.number && !before.isBuilding && !found.run.building)) {
    const wf = await getJson(`${found.url}/${found.run.number}/wfapi/describe`);
    if (wf === "failed") return "failed";
    b = toBuild(found.label, found.url, found.run, wf === "missing" ? {} : wf.data);
  }
  return { ...b, checks: b.isBuilding ? [] : await checksAt(cache, cwd, repo, branch, b) };
}

// The failed GitHub checks of the commit the branch has on origin (what was pushed, as git last
// saw it). cache.checks: { sha, at, rest, list }, one a copy.
// ponytail: one gh call a pane; share them through setShared if GitHub's rate limit is ever hit.
async function checksAt(cache, cwd, repo, branch, b) {
  const r = await exec("git", ["rev-parse", "--verify", "-q", `refs/remotes/origin/${branch}`], { cwd }).catch(() => null);
  const sha = r?.code === 0 ? r.stdout.trim() : "";
  if (!/^[0-9a-f]{40,64}$/.test(sha)) return [];
  const c = cache.checks?.sha === sha ? cache.checks : null;
  if (c && Date.now() - c.at < (c.rest ? CHECKS_REST_MS : CHECKS_MS)) return c.list;
  const got = await exec("gh", ["api", `repos/${cache.cfg.org}/${repo}/commits/${sha}/check-runs`], { cwd }).catch(() => null);
  if (got?.code !== 0) return c?.list ?? []; // gh did not answer: keep what was known
  cache.checks = { sha, at: Date.now(), rest: checksSettled(got.stdout) || Date.now() - b.endedAt > CHECKS_REST_MS, list: checksOf(got.stdout) };
  return cache.checks.list;
}

// The branch checked out in `cwd`, read from git: panes()' `branch` keeps the one the pane started
// on when a checkout happens in the same folder. null: no repo, or a detached HEAD.
async function branchAt(cwd) {
  const r = await exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd }).catch(() => null);
  const branch = r?.code === 0 ? r.stdout.trim() : "";
  return branch && branch !== "HEAD" ? branch : null;
}

// Match the first visible tab frame, including the active child of a stack.
function paneFrame(node) {
  if (!node || node.hidden) return null;
  if (node.content?.tab && node.content.pane) return node.content.pane;
  let children = node.children ?? [];
  if (node.type === "stack") {
    const visible = children.filter(child => !child.hidden);
    children = [visible.find(child => child.id === node.active) ?? visible[0]];
  }
  for (const child of children) {
    const frame = paneFrame(child);
    if (frame) return frame;
  }
  return null;
}

function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

function folder(cwd) {
  if (!cwd) return "";
  const h = home();
  return cwd === h ? "~" : cwd.startsWith(h + "/") ? "~" + cwd.slice(h.length) : cwd;
}

const stageColor = (t, status) => ({ SUCCESS: t.done, FAILED: t.ansi1, UNSTABLE: t.ansi3, IN_PROGRESS: t.working, PAUSED_PENDING_INPUT: t.blocked })[status] ?? t.border;
const stageMark = (status) => ({ SUCCESS: "✓", FAILED: "✗", UNSTABLE: "!", ABORTED: "■", IN_PROGRESS: "●", PAUSED_PENDING_INPUT: "?" })[status] ?? "○";
const buildColor = (t, b) => (b.isBuilding ? t.working : isFixable(b) ? t.ansi1 : b.result === "SUCCESS" ? t.done : b.result === "ABORTED" ? t.dim : t.ansi1);

export default class Ci extends View {
  init(_props, cx) {
    this.hovered = false;
    this.build = null;
    this.cache = { cfg: null, origin: {}, pr: {}, build: null, checks: null };
    this.dialog = Boolean(props()?.overlay);
    if (this.dialog) return this.initDialog(cx);
    if (checking()) return;
    this.ticks = 0;
    cx.timer.every(POLL_MS, (cx) => this.tick(cx));
    this.refresh(cx);
  }

  me() {
    const id = this.dialog ? this.paneId : props()?.pane;
    return panes().find((p) => p.pane === id);
  }

  // ---- The header copy ----

  tick(cx) {
    this.ticks++;
    const p = this.me();
    const moved = (p?.cwd ?? null) !== this.seen; // a cd; a checkout is seen at the next slow poll
    if (this.build?.isBuilding || moved || this.ticks % 6 === 0) this.refresh(cx);
    else if (this.build && !isShown(this.build, Date.now())) cx.notify(); // a passed build's 15 minutes are over
  }

  // One load at a time, but a request that never settles (a VPN dropping packets) must not hold
  // the copy for good: after LATCH_MS another goes, and the late answer is dropped.
  begin() {
    if (this.loadingAt && Date.now() - this.loadingAt < LATCH_MS) return 0;
    this.loadingAt = Date.now();
    return (this.run = (this.run ?? 0) + 1);
  }

  refresh(cx) {
    const run = this.begin();
    if (!run) return;
    const cwd = this.me()?.cwd ?? null;
    this.seen = cwd;
    cx.spawn(async (cx) => {
      const branch = cwd && (await branchAt(cwd));
      if (run !== this.run) return;
      const key = branch ? `${cwd} ${branch}` : null;
      // Another branch or folder: the build shown was the other one's, whatever Jenkins answers now.
      if (key !== this.buildKey) this.build = this.cache.build = null;
      this.buildKey = key;
      const b = key ? await loadBuild(this.cache, cwd, branch).catch(() => "failed") : null;
      if (run !== this.run) return;
      this.loadingAt = 0;
      if (b !== "failed") this.build = this.cache.build = b === "unset" ? null : b;
      cx.notify();
    });
  }

  button(t, id, icon, command, args) {
    return div()
      .id(id)
      .p(3)
      .rounded(4)
      .text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        run(command, args);
      })
      .child(svg(`mods/ci/${icon}.svg`).size(14));
  }

  chip(t, b, pane) {
    const color = buildColor(t, b);
    const red = isFixable(b);
    return h_flex()
      .id(`ci-chip-${pane}`)
      .min_w(0).items_center().gap(6).h(20).px(8).rounded(10)
      .border(1).border_color(red ? color : t.border).bg(red ? color + "1f" : t.raised)
      .text_size(11).cursor_pointer()
      .hover((s) => s.border_color(color))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        openOverlay({ mod: "ci", kind: "dialog", width: 680, height: 600, props: { pane } });
      })
      .child(div().flex_none().text_color(color).child(b.isBuilding ? "●" : b.result === "SUCCESS" && !red ? "✓" : "✗"))
      .when(b.stages.length > 0, (el) => el.child(h_flex().flex_none().gap(2).children(
        b.stages.map((s) => div().w(b.stages.length > 8 ? 6 : 12).h(4).rounded(2).bg(stageColor(t, s.status))))))
      .child(div().min_w(0).max_w(200).truncate().text_color(red ? color : t.foreground).child(chipText(b, Date.now())));
  }

  renderHeader() {
    const t = theme();
    const p = this.me();
    if (!p) return div();
    const name = ((p.program?.agent || p.program?.shell) && p.program.name) || p.title || p.program?.name || "shell";
    const pic = icon(p.program, 14, t.dim);
    const st = p.status;
    const pane = p.pane;
    const b = this.build && isShown(this.build, Date.now()) ? this.build : null;
    const bottom = paneFrame(layout())?.header?.position === "bottom";
    return h_flex()
      .id(`pane-head-${pane}`)
      .size_full()
      .px(10)
      .gap(8)
      .items_center()
      .bg(t.background)
      .when(bottom, el => el.border_t(1))
      .when(!bottom, el => el.border_b(1))
      .border_color(t.border)
      .text_size(12)
      .on_hover((hovered, cx) => { this.hovered = hovered; cx.notify(); })
      .on_click(() => run("pane.focus", { pane }))
      .when(Boolean(pic), (el) => el.child(pic))
      .child(div().flex_none().truncate().max_w(260).font_medium().text_color(t.foreground).child(name))
      .child(div().flex_1().truncate().text_color(t.dim).child(folder(p.cwd)))
      .when(Boolean(b), el => el.child(this.chip(t, b, pane)))
      .when(st === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
      .when(st === "blocked", el => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).child("Needs you")))
      .when(st === "done", el => el.child(div().size(7).flex_none().rounded(4).bg(t.done)))
      .when(this.hovered, el => el
        .child(this.button(t, `ph-r-${pane}`, "split-right", "pane.split", { direction: "right", pane }))
        .child(this.button(t, `ph-d-${pane}`, "split-down", "pane.split", { direction: "down", pane }))
        .child(this.button(t, `ph-z-${pane}`, p.zoomed ? "unzoom" : "zoom", "pane.zoom", { pane }))
        .child(this.button(t, `ph-x-${pane}`, "close", "pane.close", { pane })));
  }

  // ---- The dialog copy ----

  initDialog(cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.timer.after(600, () => this.handle.focus());
    this.scroll = ScrollHandle.new();
    this.paneId = props().pane ?? focused()?.pane; // mod.open:ci: the focused pane's build
    this.state = "loading"; // then "ready", "none" (no job), "down" (Jenkins unreachable) or "unset" (no config.json)
    this.lines = []; // the log around its errors, for a broken build
    this.errors = []; // indexes in lines
    this.at = 0; // the error the arrows are on, an index in errors
    if (checking()) return;
    cx.timer.every(POLL_MS, (cx) => { if (this.build?.isBuilding) this.reload(cx); });
    this.reload(cx);
  }

  reload(cx) {
    const run = this.begin();
    if (!run) return;
    cx.spawn(async (cx) => {
      const cwd = this.me()?.cwd;
      this.branch = cwd ? await branchAt(cwd) : null;
      const b = this.branch ? await loadBuild(this.cache, cwd, this.branch).catch(() => "failed") : null;
      if (run !== this.run) return;
      if (b === "failed" || b === "unset") {
        if (!this.build) this.state = b === "unset" ? "unset" : "down";
      } else {
        // The log first: shown without it, Enter would send a prompt with no excerpt.
        if (b && isBroken(b) && this.logOf !== b.url) {
          const r = await fetch(`${b.url}consoleText`).catch(() => null);
          if (run !== this.run) return;
          this.lines = r?.ok ? excerpt(await r.text()) : [];
          this.errors = errorIndexes(this.lines);
          this.at = 0;
          this.logOf = b.url;
          if (this.errors.length) this.scroll.scroll_to_item(this.errors[0]);
        }
        this.build = this.cache.build = b;
        this.state = b ? "ready" : "none";
      }
      this.loadingAt = 0;
      cx.notify();
    });
  }

  dismiss() {
    closeOverlay(props().overlay);
  }

  key(e, cx) {
    if (e.key === "escape") return this.dismiss();
    if (e.key === "enter") return this.fix(cx);
    if (e.key === "o" && this.build) return this.openJenkins();
    if (e.key === "s" && this.build?.checks[0]?.url) return this.open(this.build.checks[0].url);
    if ((e.key === "down" || e.key === "up") && this.errors.length) {
      this.at = (this.at + (e.key === "down" ? 1 : this.errors.length - 1)) % this.errors.length;
      this.scroll.scroll_to_item(this.errors[this.at]);
      cx.notify();
    }
  }

  open(url) {
    exec(window().platform === "macos" ? "open" : "xdg-open", [url]);
  }

  openJenkins() {
    this.open(this.build.url);
  }

  // A failed GitHub check: its name, what it says (Sonar: the failed conditions), its report.
  checkBlock(t, c, i) {
    return v_flex().id(`ci-check-${i}`).flex_none().gap(4).px(12).py(8).rounded(8).border(1).border_color(t.ansi1).bg(t.ansi1 + "14")
      .child(h_flex().items_center().gap(8)
        .child(div().flex_none().text_color(t.ansi1).child("✗"))
        .child(div().min_w(0).truncate().font_medium().text_color(t.ansi1).child(c.title ? `${c.name} · ${c.title}` : c.name))
        .child(div().flex_1())
        .when(Boolean(c.url), (el) => el.child(div().id(`ci-check-open-${i}`).flex_none().text_size(11.5).text_color(t.accent).cursor_pointer()
          .on_click(() => this.open(c.url)).child(i === 0 ? "ouvrir le rapport (s)" : "ouvrir le rapport"))))
      .children(c.lines.map((line, n) => div().id(`ci-check-${i}-${n}`).pl(22).text_size(12).text_color(t.foreground).child(line)));
  }

  // The failure goes to the pane's own Claude. A shell would run the prompt as commands: there,
  // a new claude tab in the same folder gets it instead.
  fix(cx) {
    const b = this.build, p = this.me();
    if (!b || !isFixable(b) || this.sending) return;
    this.sending = true;
    const text = fixPrompt(b, this.lines);
    cx.spawn(async () => {
      if (p?.terminal && p.program?.agent) {
        const r = await hc(["send", p.terminal, text]).catch((e) => ({ code: 1, stderr: String(e) }));
        if (r.code !== 0) notify({ title: "CI : prompt non envoyé", body: (r.stderr || "hc send a échoué").trim().split("\n")[0].slice(0, 200), level: "error" });
      } else run("tab.new", { ...(p?.cwd ? { folder: p.cwd } : {}), name: "claude", argv: ["claude"], task: text });
      this.dismiss();
    });
  }

  stageRow(t, s, total, i) {
    const off = s.status === "NOT_EXECUTED";
    const color = stageColor(t, s.status);
    return h_flex().id(`ci-stage-${i}`).flex_none().items_center().gap(10).h(24).when(off, (el) => el.opacity(0.55))
      .child(div().w(14).flex_none().text_color(off ? t.dim : color).child(stageMark(s.status)))
      .child(div().w(220).flex_none().truncate().text_color(s.status === "FAILED" ? color : t.foreground).child(s.name))
      .child(div().flex_1().h(4).rounded(2).bg(t.border).overflow_hidden().child(div().h(4).rounded(2).bg(color).w(off ? 0 : Math.max(3, Math.round((s.durationMs / total) * 300)))))
      .child(div().w(70).flex_none().text_right().text_size(11.5).text_color(t.dim).child(off ? "non lancé" : s.status === "IN_PROGRESS" && !s.durationMs ? "…" : minutes(s.durationMs)));
  }

  renderDialog() {
    const t = theme();
    const b = this.build;
    const root = v_flex().id("ci-dialog").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .size_full().bg(t.popover).p(20).gap(14).text_size(13).text_color(t.foreground);
    if (!b) {
      return root.child(div().text_color(t.dim).child(
        this.state === "loading" ? "Lecture de Jenkins…"
          : this.state === "down" ? "Jenkins injoignable (VPN ?)"
            : this.state === "unset" ? "mods/ci/config.json manque ou est incomplet : { \"jenkins\", \"folder\", \"org\" } (voir le README)."
            : `Pas de build Jenkins pour ${this.branch ?? "ce terminal"}.`));
    }
    const color = buildColor(t, b);
    const now = live(b, Date.now());
    const total = Math.max(1, b.stages.reduce((n, s) => n + s.durationMs, 0)); // a stage's bar is its share of the build
    const failed = failedStage(b);
    const p = this.me();
    const toAgent = Boolean(p?.terminal && p.program?.agent);
    const mono = settings().font_family;
    const cur = this.errors[this.at];
    return root
      .child(h_flex().flex_none().items_baseline().gap(10)
        .child(div().text_size(16).font_semibold().truncate().child(b.label))
        .child(div().flex_none().text_color(color).child(
          b.isBuilding ? `● build #${b.number} en cours` : b.result === "SUCCESS" ? `${b.checks.length ? "✗" : "✓"} build #${b.number} réussi${b.checks.length ? ", check en échec" : ""}` : `✗ build #${b.number} ${failed ? "en échec" : (b.result ?? "terminé").toLowerCase()}`))
        .child(div().flex_1())
        .child(div().flex_none().text_size(11.5).text_color(t.dim).child(
          b.isBuilding ? [b.estimatedMs ? `${now.percent} %` : "", `écoulé ${minutes(now.elapsedMs)}`, b.estimatedMs ? `reste ~${minutes(now.remainingMs)}` : ""].filter(Boolean).join(" · ") : `durée ${minutes(b.durationMs)} · ${ago(Date.now() - b.endedAt)}`)))
      // A scroll area takes all the height it may: it is given its rows' height, less what the
      // log and the failed checks need below it.
      .child(v_flex().id("ci-stages").flex_none().h(Math.min(b.stages.length * 24, Math.max(72, (this.lines.length ? 200 : 440) - b.checks.length * 90))).overflow_y_scrollbar()
        .children(b.stages.map((s, i) => this.stageRow(t, s, total, i))))
      .children(b.checks.map((c, i) => this.checkBlock(t, c, i)))
      .when(this.lines.length > 0, (el) => el
        .child(h_flex().flex_none().gap(8).text_size(11.5)
          .child(div().text_color(t.dim).child("Extrait du log : autour des erreurs, puis la fin"))
          .child(div().flex_1())
          .when(this.errors.length > 0, (e2) => e2.child(div().text_color(t.ansi1).child(`erreur ${this.at + 1} sur ${this.errors.length} · ↑ ↓`))))
        .child(v_flex().id("ci-log").track_scroll(this.scroll).flex_1().min_h(0).overflow_y_scrollbar()
          .rounded(8).border(1).border_color(t.border).bg(t.background).py(8)
          .font_family(mono).text_size(11.5)
          .children(this.lines.map((line, i) => {
            const isError = this.errors.includes(i), isCut = line.startsWith("⋯ ");
            return div().id(`ci-line-${i}`).flex_none().px(12).min_h(18)
              .text_color(isError ? t.ansi1 : isCut ? t.dim : t.muted)
              .when(i === cur, (l) => l.bg(t.ansi1 + "26"))
              .child(line || " ");
          }))))
      .when(!this.lines.length, (el) => el.child(div().flex_1()))
      .child(h_flex().flex_none().items_center().gap(10)
        .when(isFixable(b), (el) => el
          .child(div().id("ci-fix").px(14).h(32).flex().items_center().rounded(8).bg(t.solid).text_color(t.solid_foreground).font_semibold().cursor_pointer()
            .on_click((_e, cx) => this.fix(cx)).child("Corriger avec Claude  ↵"))
          .child(div().text_size(11.5).text_color(t.dim).child(`${toAgent ? "envoie" : "ouvre un onglet claude avec"} ${isBroken(b) ? "ce log" : "cet échec"}${toAgent ? " à ce terminal" : ""}`)))
        .child(div().flex_1())
        .child(div().id("ci-jenkins").text_size(11.5).text_color(t.accent).cursor_pointer().on_click(() => this.openJenkins()).child(`build #${b.number} dans Jenkins (o)`))
        .child(div().text_size(11.5).text_color(t.dim).child("esc")));
  }

  render() {
    return this.dialog ? this.renderDialog() : this.renderHeader();
  }
}
