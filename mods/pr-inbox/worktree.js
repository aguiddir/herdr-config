// The checkout of a pull request's branch, made when absent, and the local repo of a GitHub
// one. Copied from mods/start-work (main.js: git, repoOf, create, prHead, catchUp,
// checkoutsOf; lib.js: spaceIn): Herdr refuses an import from another mod's folder, so
// this is a copy, and start-work stays the original. The differences: no Jira, no space
// opened here (the caller does, with a first message for the agent), and `create` became
// checkoutFor, which returns the folder.

import { exec, home, notify } from "herdr";
import { branchOf, matchOrigin } from "./lib.js";

async function git(cwd, args) {
  const r = await exec("git", args, { cwd });
  return { ok: r.code === 0, out: (r.stdout ?? "").trim(), err: (r.stderr || r.stdout || "").trim() };
}

// The repo a folder belongs to: its main checkout and name (a linked worktree gives its repo's).
export async function repoOf(folder) {
  const top = await git(folder, ["rev-parse", "--show-toplevel"]);
  const common = await git(folder, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!top.ok || !common.ok) return null;
  const main = common.out.endsWith("/.git") ? common.out.slice(0, -5) : common.out;
  return { top: top.out, main, name: main.split("/").pop() };
}

// The first candidate folder whose repo's origin is that GitHub repo (owner/name).
// Repos are told apart by their main checkout, never by the candidate folder: a main checkout
// listed before its worktrees would otherwise be skipped as "seen", and its worktrees with it.
export async function localRepo(fullName, candidates) {
  const asked = new Set(); // main checkouts whose origin was read
  for (const folder of new Set(candidates)) {
    if (!folder) continue;
    const repo = await repoOf(folder).catch(() => null);
    if (!repo || asked.has(repo.main)) continue;
    asked.add(repo.main);
    const origin = await git(repo.main, ["remote", "get-url", "origin"]);
    if (origin.ok && matchOrigin(origin.out, fullName)) return { main: repo.main, name: repo.name };
  }
  return null;
}

// Every checked-out branch and its folder.
export async function checkoutsOf(main) {
  const list = (await git(main, ["worktree", "list", "--porcelain"])).out;
  const trees = list.split("\n\n").map((b) => b.split("\n"));
  return new Map(trees.flatMap((lines) => {
    const branch = lines.find((l) => l.startsWith("branch refs/heads/"));
    return branch ? [[branch.slice("branch refs/heads/".length), lines[0].replace(/^worktree /, "")]] : [];
  }));
}

// The PR's head commit as GitHub has it now: pull/N/head holds it for a fork's PR too.
async function prHead(main, row) {
  const r = await git(main, ["fetch", "--quiet", "origin", `pull/${row.number}/head`]);
  if (!r.ok) throw new Error(r.err || `Impossible de récupérer la PR #${row.number}.`);
  return (await git(main, ["rev-parse", "FETCH_HEAD"])).out;
}

// A PR is checked out as it is now: a local branch behind its head moves up to it. One
// ahead (commits not pushed yet) stays. One that diverged (the PR was rebased, or both
// moved) stays too, and is said: moving it would lose its commits.
async function catchUp(main, row, branch, head) {
  const contains = async (a, b) => (await git(main, ["merge-base", "--is-ancestor", a, b])).ok;
  if (await contains(head, branch)) return;
  if (await contains(branch, head)) return void (await git(main, ["branch", "--force", branch, head])); // a fast-forward: nothing lost
  notify({ title: `${branch} et la PR #${row.number} ont divergé`, body: "La PR a été réécrite (rebase, force-push) ou la branche a des commits à elle : elle est ouverte telle quelle.", level: "warning" });
}

// The folder where the PR's branch is checked out, made under ~/.herdr/worktrees when absent.
export async function checkoutFor(repo, row) {
  const main = repo.main;
  const branch = branchOf(row);
  if (!(await git(main, ["check-ref-format", "--branch", branch])).ok) throw new Error(`« ${branch} » n'est pas un nom de branche valide.`);
  await git(main, ["worktree", "prune"]); // forget worktrees whose folder was deleted by hand
  let path = (await checkoutsOf(main)).get(branch) ?? null;
  const head = await prHead(main, row);
  // Checked out already, maybe with work in progress: say it is behind, don't move it.
  const behind = path && (await git(main, ["rev-list", "--count", `${branch}..${head}`])).out;
  if (behind && behind !== "0") notify({ title: `${branch} n'a pas ${behind} commit(s) de la PR #${row.number}`, body: `Elle est sortie dans ${path.replace(home(), "~")} : mets-la à jour là-bas (git pull).`, level: "warning" });
  if (path) return path;
  const has = async (ref) => (await git(main, ["show-ref", "--verify", "--quiet", ref])).ok;
  const local = await has(`refs/heads/${branch}`);
  if (local) await catchUp(main, row, branch, head);
  path = `${home()}/.herdr/worktrees/${repo.name}/${branch.replace(/[^A-Za-z0-9._-]+/g, "-")}`;
  // A local branch is checked out as is. A new one starts from the PR's head, not from
  // origin/<branch>, which may be behind (only pull/N/head was fetched); it then tracks origin's.
  const add = local ? ["worktree", "add", path, branch] : ["worktree", "add", "--no-track", "-b", branch, path, head];
  const r = await git(main, add);
  if (!r.ok) throw new Error(r.err || "git worktree add a échoué.");
  if (!local && (await has(`refs/remotes/origin/${branch}`))) await git(main, ["branch", `--set-upstream-to=origin/${branch}`, branch]);
  return path;
}

// The space showing a terminal in this checkout, and that terminal's tab. A terminal
// under it counts, unless it is in another checkout nested in it (.claude/worktrees/…):
// checkouts are the repo's folders, any iterable. A space's folder is where its new
// terminals start, not where they are, so it only answers when no terminal is there
// (one cd'd away). panes and spaces: as Herdr's panes() and spaces() give them.
export function spaceIn(path, checkouts, panes, spaces) {
  const dirs = [path, ...checkouts]; // once: an iterator is spent after one pass
  const under = (cwd, dir) => cwd === dir || cwd.startsWith(`${dir}/`);
  const checkout = (cwd) => dirs.filter((dir) => under(cwd, dir)).sort((a, b) => b.length - a.length)[0];
  const inside = panes.find((p) => p.cwd && checkout(p.cwd) === path);
  const space = inside && spaces.find((sp) => sp.tabs.some((t) => t.id === inside.tab));
  if (space) return { space, tab: inside.tab };
  const started = spaces.find((sp) => sp.folder === path);
  return started ? { space: started, tab: null } : null;
}
