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
