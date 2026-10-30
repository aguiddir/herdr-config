// Pure helpers: branch names and the work a ticket already has. Checked by lib.test.mjs.

// "Données : 🐛 Fix l'accès" -> "donnees-fix-l-acces", at most 50 chars, cut at a dash.
export function slug(text) {
  let s = text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (s.length > 50) s = s.slice(0, 50).replace(/-[^-]*$/, "");
  return s;
}

// Jira and GitHub link a branch to its ticket by the key or number in its name.
// format (Jira only, from config.json): {KEY} is "POSO-12", {key} "poso-12", {slug} the title's.
export function branchFor(item, format = "{KEY}-{slug}") {
  if (item.kind === "jira") return format.replace("{KEY}", item.key).replace("{key}", item.key.toLowerCase()).replace("{slug}", slug(item.title));
  if (item.kind === "issue") return `${item.number}-${slug(item.title)}`;
  return slug(item.title);
}

// The branch already holding this item's work: the open PR whose title starts with
// its key ("✨ POSO-97: …"; a release PR listing keys further on doesn't count),
// else one on its branch, else the most recent branch named after it.
// branches: newest first, local and origin's without the "origin/".
export function existingWork(item, branches, prs) {
  const id = item.kind === "jira" ? item.key : item.kind === "issue" ? String(item.number) : null;
  if (!id) return null;
  const head = item.kind === "jira" ? new RegExp(`(^|/)${id}(?![0-9])`, "i") : new RegExp(`(^|/)${id}-`);
  const title = new RegExp(`^[^A-Za-z0-9]*${id}(?![0-9])`, "i");
  const pr = (item.kind === "jira" && prs.find((p) => title.test(p.title))) || prs.find((p) => head.test(p.headRefName));
  const branch = pr?.headRefName ?? branches.find((b) => head.test(b) && !b.startsWith("backup/"));
  return branch ? { branch, pr: prs.find((p) => p.headRefName === branch) ?? null } : null;
}

// What config.json names for a repo's tickets: a Jira link to a filter or to a project's
// board, a project key, or JQL. Any other link is null: a board outside a project
// (/people/…/boards/96) shows its filter's tickets, and acli can't read which filter.
export function ticketSource(text) {
  const t = text.trim();
  const filter = t.match(/[?&]filter=(\d+)/);
  if (filter) return { kind: "filter", id: filter[1] };
  const project = t.match(/\/projects\/([A-Za-z][A-Za-z0-9_]*)(?:\/|$)/) ?? t.match(/^([A-Z][A-Z0-9_]*)$/);
  if (project) return { kind: "project", key: project[1].toUpperCase() };
  return t && !/^https?:/.test(t) ? { kind: "jql", jql: t } : null;
}

// The searches to run in turn, the first with results wins: a project's open sprint,
// else (a kanban has none) all its open tickets; a filter's or JQL's open tickets.
// A key is quoted: some are JQL words (CF).
export function ticketQueries(source, filterJql) {
  const open = "statusCategory != Done ORDER BY updated DESC";
  if (source.kind === "project") return [`project = "${source.key}" AND sprint in openSprints() AND ${open}`, `project = "${source.key}" AND ${open}`];
  const base = (source.kind === "filter" ? filterJql : source.jql).replace(/\s+ORDER\s+BY[\s\S]*$/i, "");
  return [`(${base}) AND ${open}`];
}

// How a source reads in the dialog, without asking Jira.
export function sourceLabel(source) {
  return source.kind === "project" ? source.key : source.kind === "filter" ? `filtre ${source.id}` : source.jql;
}
