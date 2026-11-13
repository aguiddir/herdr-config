// node mods/start-work/lib.test.mjs
import assert from "node:assert/strict";
import { slug, branchFor, existingWork, ticketSource, ticketQueries, sourceLabel, spaceIn, argvFor } from "./lib.js";

assert.equal(slug("🐛 Data comparison fails on a column présent"), "data-comparison-fails-on-a-column-present");
assert.equal(slug("x".repeat(30) + " " + "y".repeat(30)), "x".repeat(30));
assert.equal(branchFor({ kind: "jira", key: "CF-12", title: "Corriger l'export" }), "CF-12-corriger-l-export");
assert.equal(branchFor({ kind: "jira", key: "POSO-110", title: "Version actuelle" }, "feat/{key}-{slug}"), "feat/poso-110-version-actuelle");
assert.equal(branchFor({ kind: "issue", number: 277, title: "⚡️ Skip key ranges" }), "277-skip-key-ranges");
assert.equal(branchFor({ kind: "free", title: "refacto du cache" }), "refacto-du-cache");
assert.equal(branchFor({ kind: "pr", number: 164, branch: "feat/poso-98-current-version-pane", title: "t" }), "feat/poso-98-current-version-pane");
assert.equal(branchFor({ kind: "pr", number: 300, branch: "main", fork: true, title: "t" }), "pr/300-main");
const prs = [
  { number: 200, headRefName: "release/2.3", title: "Release 2.3: POSO-97, POSO-98", url: "u200" },
  { number: 164, headRefName: "feat/poso-98-current-version-pane", title: "✨ POSO-97: Show the current version", url: "u164" },
  { number: 152, headRefName: "feat/poso-98-dfg-timeline", title: "✨ POSO-98: Show DFG stages", url: "u152" },
];
const branches = ["backup/poso-20-pre-rebase", "feat/poso-20-profil-toxicite", "feat/poso-9-sources", "277-skip-key-ranges"];
const jira = (key) => ({ kind: "jira", key, title: "t" });
assert.equal(existingWork(jira("POSO-98"), branches, prs).pr.number, 152);
assert.equal(existingWork(jira("POSO-97"), branches, prs).branch, "feat/poso-98-current-version-pane");
assert.deepEqual(existingWork(jira("POSO-20"), branches, prs), { branch: "feat/poso-20-profil-toxicite", pr: null });
assert.equal(existingWork(jira("POSO-9"), branches, prs).branch, "feat/poso-9-sources");
assert.equal(existingWork(jira("POSO-2"), branches, prs), null);
assert.equal(existingWork({ kind: "issue", number: 277, title: "t" }, branches, prs).branch, "277-skip-key-ranges");
assert.equal(existingWork({ kind: "issue", number: 27, title: "t" }, branches, prs), null);
assert.deepEqual(ticketSource("https://vidalgroup.atlassian.net/jira/software/projects/POSO/boards/1802"), { kind: "project", key: "POSO" });
assert.deepEqual(ticketSource("https://vidalgroup.atlassian.net/issues/?filter=10782"), { kind: "filter", id: "10782" });
assert.deepEqual(ticketSource("CF"), { kind: "project", key: "CF" });
assert.deepEqual(ticketSource("labels = DATADELTA"), { kind: "jql", jql: "labels = DATADELTA" });
assert.equal(ticketSource("https://vidalgroup.atlassian.net/jira/people/637cbe039960988ef6bd9bc5/boards/96"), null);
assert.deepEqual(ticketQueries({ kind: "project", key: "CF" })[1], 'project = "CF" AND statusCategory != Done ORDER BY updated DESC');
assert.equal(ticketQueries({ kind: "filter", id: "1" }, "labels = X ORDER BY Rank ASC")[0], "(labels = X) AND statusCategory != Done ORDER BY updated DESC");
assert.deepEqual([ticketSource("POSO"), ticketSource("https://x/issues/?filter=7"), ticketSource("labels = A")].map(sourceLabel), ["POSO", "filtre 7", "labels = A"]);
const M = "/h/data-delta", N = "/h/data-delta/.claude/worktrees/foo";
const sp = (id, folder, ...tabs) => ({ id, folder, tabs: tabs.map((t) => ({ id: t })) });
// a nested worktree's terminal, after one elsewhere, is not in the checkout (checkouts as an iterator, as main.js passes them)
const nested = [[{ tab: "tX", cwd: "/h/other" }, { tab: "tN", cwd: N }], [sp("x", "/h", "tX"), sp("nested", "/h", "tN")]];
assert.equal(spaceIn(M, new Map([["dev", M], ["foo", N]]).values(), ...nested), null);
assert.equal(spaceIn(N, new Map([["dev", M], ["foo", N]]).values(), ...nested).space.id, "nested");
assert.equal(spaceIn(M, [M], [{ tab: "tM", cwd: `${M}/src` }], [sp("main", "/h", "tM")]).space.id, "main");
// its terminal cd'd away: the space whose terminals start there, no tab
assert.deepEqual(spaceIn("/h/wt", [], [{ tab: "tW", cwd: "/h" }], [sp("wt", "/h/wt", "tW")]), { space: sp("wt", "/h/wt", "tW"), tab: null });
// a space whose folder is the checkout loses to the one with a terminal in it (data-delta, PR 275)
assert.equal(spaceIn(M, [M], [{ tab: "t5", cwd: M }], [sp("cerner-flow", M, "t11"), sp("data-delta", "/h", "t5")]).space.id, "data-delta");
// A PR's branch is someone else's: Claude starts without the repo's .claude/ and .mcp.json.
assert.deepEqual(argvFor({ kind: "pr", number: 1 }), ["claude", "--setting-sources", "user", "--strict-mcp-config"]);
assert.deepEqual(argvFor({ kind: "jira", key: "POSO-1" }), ["claude"]);
console.log("ok");
