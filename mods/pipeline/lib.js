// Pure helpers of the pipeline dialog: where each ticket's agents stand. Checked by lib.test.mjs.
// The dialog drives nothing. start-work keeps the tickets it gave a coder in
// shared("pipeline.tickets"): { key, title, repo, branch, path, at }, by key. herdr-core has
// the terminals: { address, cwd, status, labels, parent, name } here, status one of
// "working" | "blocked" | "done" | "idle", or null for a program that reports none (a shell).
// A coder says its stage itself: `hc label $HC_TERMINAL_ID pipeline.stage=…`.

const STAGES = ["code", "review", "fix", "question", "ready"];
const ORDER = ["question", "look", "running", "ready"]; // what waits for me first
const under = (cwd, dir) => cwd === dir || cwd.startsWith(`${dir}/`);

// The ticket's coder: the agent in its worktree that nobody started (a reviewer has a
// parent). The one that said a stage wins over a Claude opened there by hand.
function coderOf(ticket, terminals) {
  const there = terminals.filter((t) => !t.parent && t.status && t.cwd && under(t.cwd, ticket.path));
  return there.find((t) => t.labels?.["pipeline.stage"]) ?? there[0] ?? null;
}

function rowOf(ticket, coder, terminals) {
  const said = coder.labels?.["pipeline.stage"];
  // Not said yet, or said wrong: it is coding. So is a coder back at work after a question,
  // whatever its label still says: the answer came, nothing waits on the author any more.
  const stage = !STAGES.includes(said) || (said === "question" && coder.status === "working") ? "code" : said;
  const questions = Number(coder.labels?.["pipeline.questions"]) || 0;
  const reviewer = terminals.find((t) => t.parent === coder.address) ?? null;
  // Stopped anywhere but at a question or at the end: something to look at. So is a reviewer
  // that waits on someone: its coder would wait on it, "working", for as long as nobody looks.
  const state = stage === "question" ? "question" : stage === "ready" ? "ready" : coder.status === "working" && reviewer?.status !== "blocked" ? "running" : "look";
  const label = {
    question: "question",
    look: "à voir",
    ready: questions ? `prête · ${questions} question${questions > 1 ? "s" : ""}` : "prête à merger",
    running: { code: "code", review: "review", fix: "code, 2ᵉ passe" }[stage],
  }[state];
  return { ...ticket, coder, reviewer, stage, questions, state, label };
}

// One row per ticket whose coder is alive; a ticket without one is left out (see gone).
export function rowsOf(tickets, terminals) {
  return Object.values(tickets ?? {})
    .flatMap((ticket) => {
      const coder = coderOf(ticket, terminals);
      return coder ? [rowOf(ticket, coder, terminals)] : [];
    })
    .sort((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state) || String(a.at).localeCompare(String(b.at)));
}

// The keys start-work launched whose coder no longer exists: to forget.
export const gone = (tickets, terminals) => Object.values(tickets ?? {}).filter((t) => !coderOf(t, terminals)).map((t) => t.key);

// The two squares of a row, code then review: "done" | "active" | "wait" (stopped there) | "todo".
export function squares(row) {
  if (row.state === "ready") return ["done", "done"];
  const here = row.state === "running" ? "active" : "wait";
  return row.stage === "review" ? ["done", here] : [here, "todo"];
}

// "1 attend une réponse · 3 en cours · 1 prête à merger": the counts that are not zero.
export function summary(rows) {
  const n = (state) => rows.filter((r) => r.state === state).length;
  const parts = [
    [n("question"), (c) => `${c} ${c > 1 ? "attendent" : "attend"} une réponse`],
    [n("look"), (c) => `${c} à voir`],
    [n("running"), (c) => `${c} en cours`],
    [n("ready"), (c) => `${c} ${c > 1 ? "prêtes" : "prête"} à merger`],
  ];
  return parts.filter(([c]) => c).map(([c, say]) => say(c)).join(" · ");
}
