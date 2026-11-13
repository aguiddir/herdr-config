// The tickets a coder can be launched on, and the launch of one: assigned to me, a new
// worktree on a new branch, a space running Claude in auto mode with its task (lib.js: coderTask).
// git, repoOf, acli, ticket, the ticket search and the worktree are copied from
// mods/start-work/main.js: Herdr refuses imports across mods, and start-work stays as it is,
// for work a person does with an agent. The differences: Jira only, never an existing branch,
// never a ticket someone else has. Where a repo's tickets are is the pipeline's own answer,
// kept in its config.json: start-work's is not read.

import { exec, home, appHome, readTextFile, writeTextFile, notify, run, shared, setShared } from "herdr";
import { branchFor, ticketSource, ticketQueries, sourceLabel, coderArgv, coderTask } from "./lib.js";

export const TICKETS = "pipeline.tickets"; // { key, title, repo, branch, path, at } by key
const FIELDS = "key,summary,status,assignee";
// { jira: { <repo>: source | [sources] }, branch_formats: { <repo>: "feat/{key}-{slug}" }, jira_start_status, jira_waiting_status }
const CONFIG = () => `${appHome()}/mods/pipeline/config.json`;

async function git(cwd, args) {
  const r = await exec("git", args, { cwd });
  return { ok: r.code === 0, out: (r.stdout ?? "").trim(), err: (r.stderr || r.stdout || "").trim() };
}

async function acli(args) {
  const r = await exec("acli", ["jira", ...args]);
  if (r.code !== 0) throw new Error(`Jira : ${(r.stderr || r.stdout || "acli a échoué").trim().split("\n")[0].slice(0, 200)}`);
  return r.stdout;
}

const ticket = (i, me) => ({
  id: `jira-${i.key}`,
  key: i.key,
  title: i.fields.summary,
  status: i.fields.status?.name ?? "",
  todo: i.fields.status?.statusCategory?.key === "new",
  mine: Boolean(me && i.fields.assignee?.emailAddress?.toLowerCase() === me),
  who: i.fields.assignee?.displayName ?? null,
});

// The repo a folder belongs to (a linked worktree gives its repo's) and what config.json
// says of it: null outside git.
export async function sourcesOf(folder) {
  const common = await git(folder, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!common.ok) return null;
  const main = common.out.endsWith("/.git") ? common.out.slice(0, -5) : common.out;
  const repo = { main, name: main.split("/").pop() };
  const config = JSON.parse((await readTextFile(CONFIG())) ?? "{}");
  const named = config.jira?.[repo.name];
  return { repo, named: named == null ? [] : [].concat(named), format: config.branch_formats?.[repo.name], startStatus: config.jira_start_status ?? "En cours", waitingStatus: config.jira_waiting_status ?? "En attente" };
}

// Where a repo's tickets are, as the person gave them in the dialog: one string, or a list.
export async function saveSources(repo, named) {
  const before = await readTextFile(CONFIG());
  const config = JSON.parse(before ?? "{}");
  config.jira = { ...config.jira, [repo]: named.length === 1 ? named[0] : named };
  if (!named.length) delete config.jira[repo];
  await writeTextFile(CONFIG(), JSON.stringify(config, null, 2) + "\n", before);
}

// Every source's open tickets, once each: mine, then nobody's, then others'.
export async function ticketsOf(named) {
  const me = (await acli(["auth", "status"])).match(/Email:\s*(\S+)/)?.[1]?.toLowerCase();
  const found = new Map();
  const notes = [];
  for (const text of named) {
    const source = ticketSource(text);
    if (!source) { notes.push(`${text} : source illisible`); continue; }
    try {
      const filter = source.kind === "filter" && JSON.parse(await acli(["filter", "view", "--id", source.id, "--json"]));
      for (const jql of ticketQueries(source, filter?.jql)) {
        const r = JSON.parse(await acli(["workitem", "search", "--jql", jql, "--fields", FIELDS, "--limit", "50", "--json"]));
        for (const i of r) found.set(i.key, ticket(i, me));
        if (r.length) break;
      }
    } catch (e) { notes.push(`${sourceLabel(source)} : ${e.message ?? e}`); }
  }
  const order = (t) => (t.mine ? 0 : t.who ? 2 : 1);
  return { me, tickets: [...found.values()].sort((a, b) => order(a) - order(b)), notes };
}

// The repo's branches (newest first, local and origin's) and open PRs. known: both were read;
// without them nothing says a ticket has no work under way, and no coder is launched.
export async function workOf(main) {
  const fetched = await git(main, ["fetch", "--quiet", "origin"]);
  const refs = await git(main, ["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads", "refs/remotes/origin"]);
  const branches = [...new Set(refs.out.split("\n").filter((b) => b && b !== "origin" && b !== "origin/HEAD").map((b) => b.replace(/^origin\//, "")))];
  const r = await exec("gh", ["pr", "list", "--state", "open", "--limit", "100", "--json", "headRefName,title"], { cwd: main });
  return { branches, prs: r.code === 0 ? JSON.parse(r.stdout) : [], known: fetched.ok && r.code === 0 };
}

// Launch the coder of one ticket; returns its branch. from: sourcesOf's answer.
export async function start(from, me, s) {
  const main = from.repo.main;
  const branch = branchFor(s, from.format);
  if (!(await git(main, ["check-ref-format", "--branch", branch])).ok) throw new Error(`« ${branch} » n'est pas un nom de branche valide.`);
  // Asked now, not as the dialog saw it when it opened: a coder asks nothing, so it only ever
  // starts on a branch made for it here, on a ticket nobody else has taken.
  await git(main, ["worktree", "prune"]); // forget worktrees whose folder was deleted by hand
  const has = async (ref) => (await git(main, ["show-ref", "--verify", "--quiet", ref])).ok;
  if ((await has(`refs/heads/${branch}`)) || (await has(`refs/remotes/origin/${branch}`))) throw new Error(`la branche ${branch} existe déjà, pas d'agent lancé.`);
  const now = ticket(JSON.parse(await acli(["workitem", "view", s.key, "--fields", FIELDS, "--json"])), me);
  if (now.who && !now.mine) throw new Error(`déjà pris par ${now.who}, pas d'agent lancé.`);
  // The assignment is what keeps a colleague's agent off the ticket. Taken first: if Jira
  // refuses, nothing is half made.
  if (!now.mine) await acli(["workitem", "assign", "--key", s.key, "--assignee", "@me", "--yes"]);
  if (now.todo) {
    // A workflow without that status shouldn't block the work: say so and go on.
    try { await acli(["workitem", "transition", "--key", s.key, "--status", from.startStatus, "--yes"]); }
    catch (e) { notify({ title: `${s.key} t'est assigné, mais n'est pas passé « ${from.startStatus} »`, body: String(e.message ?? e), level: "warning" }); }
  }
  // Where start-work puts its worktrees, from the remote's default branch.
  const path = `${home()}/.herdr/worktrees/${from.repo.name}/${branch.replace(/[^A-Za-z0-9._-]+/g, "-")}`;
  const base = (await git(main, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])).out;
  const r = await git(main, ["worktree", "add", "--no-track", "-b", branch, path, base || "HEAD"]);
  if (!r.ok) throw new Error(r.err || "git worktree add a échoué.");
  setShared(TICKETS, { ...(shared(TICKETS) ?? {}), [s.key]: { key: s.key, title: s.title, repo: from.repo.name, branch, path, at: new Date().toISOString() } });
  run("space.new", { folder: path, tab: "claude", argv: coderArgv(), task: coderTask(s, { branch, waitingStatus: from.waitingStatus }) });
  return branch;
}
