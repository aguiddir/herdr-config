// projects: the pure part (no herdr import), tested by lib.test.mjs (`node mods/projects/lib.test.mjs`).
// A repo is its full path (two roots can hold the same name); it shows as its last folder name.

const lines = (s) => s.split("\n").map((l) => l.trim()).filter(Boolean);

export const nameOf = (path) => path.slice(path.lastIndexOf("/") + 1);

// `find <root>/ -mindepth 2 -maxdepth 2 -name .git -type d`: a worktree's .git is a file, so it is not there.
export function parseRepos(stdout) {
  return lines(stdout).map((l) => l.replace(/\/+\.git$/, "").replace(/\/\/+/g, "/")).sort();
}

// "<path> <unix seconds>" per line.
export function parseCommits(stdout) {
  const out = {};
  for (const l of lines(stdout)) {
    const m = l.match(/^(.+) (\d+)$/); // the path may hold spaces, the date is the last word
    if (m) out[m[1]] = Number(m[2]) * 1000;
  }
  return out;
}

// "<path>\t<light file>\t<dark file or empty>" per line, files in dir (relative to appHome, for image()).
export function parseIcons(stdout, dir) {
  const out = {};
  for (const l of stdout.split("\n")) {
    const [path, light, dark] = l.split("\t");
    if (path && light) out[path] = { light: `${dir}/${light}`, dark: `${dir}/${dark || light}` };
  }
  return out;
}

export function repoOfFolder(folder, repos) {
  for (const r of repos) if (folder === r || folder.startsWith(r + "/")) return r;
  return null;
}

export function stamp(recent, repos, now) {
  const out = { ...recent };
  for (const r of repos) out[r] = now;
  return out;
}

// The repos open now that were not open the last time the picker looked: they were opened since.
export function markOpened(recent, wasOpen, nowOpen, now) {
  const was = new Set(wasOpen);
  return stamp(recent, nowOpen.filter((r) => !was.has(r)), now);
}

export function order(repos, recent, commits) {
  const by = (a, b) => (b ?? -1) - (a ?? -1);
  return [...repos].sort((a, b) => {
    const r = by(recent[a], recent[b]);
    if (r) return r;
    if (recent[a] == null) { const c = by(commits[a], commits[b]); if (c) return c; }
    // Not localeCompare: Herdr's QuickJS compares code points there, uppercase first.
    const x = nameOf(a).toLowerCase(), y = nameOf(b).toLowerCase();
    return x < y ? -1 : x > y ? 1 : a < b ? -1 : a > b ? 1 : 0;
  });
}

export function filter(repos, query) {
  const q = query.trim().toLowerCase();
  if (!q) return repos;
  const n = (r) => nameOf(r).toLowerCase();
  const hits = repos.filter((r) => n(r).includes(q));
  const rank = (r) => (n(r) === q ? 0 : n(r).startsWith(q) ? 1 : 2);
  return [0, 1, 2].flatMap((k) => hits.filter((r) => rank(r) === k));
}

// A space's repo is where its first terminal is, as Herdr names it: another pane cd'd elsewhere does not count.
export function spaceRepo(space, panes, repos) {
  const first = panes.find((p) => p.tab === space.tabs[0]?.id && p.cwd);
  return first ? repoOfFolder(first.cwd, repos) : null;
}

export function openSpaceFor(repo, panes, spaces) {
  // only this computer's repos
  return spaces.find((s) => !s.machine && spaceRepo(s, panes, [repo]))?.id ?? null;
}
