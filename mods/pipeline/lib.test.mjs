// node mods/pipeline/lib.test.mjs
import assert from "node:assert/strict";
import { rowsOf, squares, summary, gone } from "./lib.js";

const T = (address, cwd, status, labels = {}, parent = null) => ({ address, cwd, status, labels, parent, name: null });
const tickets = {
  "A-1": { key: "A-1", title: "Un", branch: "a-1", path: "/w/a-1", at: "2026-11-13T09:00:00Z" },
  "A-2": { key: "A-2", title: "Deux", branch: "a-2", path: "/w/a-2", at: "2026-11-13T09:01:00Z" },
  "A-3": { key: "A-3", title: "Trois", branch: "a-3", path: "/w/a-3", at: "2026-11-13T09:02:00Z" },
  "A-4": { key: "A-4", title: "Quatre", branch: "a-4", path: "/w/a-4", at: "2026-11-13T09:03:00Z" },
};
const terms = [
  T("t1", "/w/a-1", "working", { "pipeline.stage": "review" }),
  T("t2", "/w/a-1", "working", {}, "t1"),
  T("t3", "/w/a-2/src", "idle", { "pipeline.stage": "ready", "pipeline.questions": "2" }),
  T("t4", "/w/a-3", "idle"),
  T("t9", "/elsewhere", "working"),
];
const rows = rowsOf(tickets, terms);
// What waits for me first, what is finished last.
assert.deepEqual(rows.map((r) => [r.key, r.state, r.label]), [["A-3", "look", "à voir"], ["A-1", "running", "review"], ["A-2", "ready", "prête · 2 questions"]]);
assert.equal(rows[1].coder.address, "t1");
assert.equal(rows[1].reviewer.address, "t2");
assert.equal(rows[2].reviewer, null);
assert.deepEqual(squares(rows[1]), ["done", "active"]);
assert.deepEqual(squares(rows[0]), ["wait", "todo"]);
assert.deepEqual(squares(rows[2]), ["done", "done"]);
// A coder that is gone: no row, its key to drop, nothing thrown.
assert.deepEqual(gone(tickets, terms), ["A-4"]);
assert.equal(summary(rows), "1 à voir · 1 en cours · 1 prête à merger");
assert.equal(summary([]), "");
// A coder that never said its stage is coding while it works.
assert.equal(rowsOf(tickets, [T("t4", "/w/a-3", "working")])[0].label, "code");
assert.equal(rowsOf(tickets, [T("t4", "/w/a-3", "working", { "pipeline.stage": "n'importe quoi" })])[0].label, "code");
assert.equal(rowsOf(tickets, [T("t4", "/w/a-3", "working", { "pipeline.stage": "fix" })])[0].label, "code, 2ᵉ passe");
assert.equal(rowsOf(tickets, [T("t4", "/w/a-3", "idle", { "pipeline.stage": "ready" })])[0].label, "prête à merger");
assert.equal(rowsOf(tickets, [T("t4", "/w/a-3", "idle", { "pipeline.stage": "ready", "pipeline.questions": "1" })])[0].label, "prête · 1 question");
const q = rowsOf(tickets, [T("t4", "/w/a-3", "idle", { "pipeline.stage": "question" }), T("t1", "/w/a-1", "blocked", { "pipeline.stage": "code" })]);
assert.deepEqual(q.map((r) => [r.key, r.state, r.label]), [["A-3", "question", "question"], ["A-1", "look", "à voir"]]);
assert.equal(summary(q), "1 attend une réponse · 1 à voir");
// A shell opened by hand in the worktree is not the coder; the terminal that reports is.
assert.equal(rowsOf(tickets, [T("t7", "/w/a-3", null), T("t4", "/w/a-3", "working")])[0].coder.address, "t4");
assert.deepEqual(rowsOf(tickets, [T("t7", "/w/a-3", null)]), []);
// "/w/a-1" is not under "/w/a".
assert.deepEqual(rowsOf({ X: { key: "X", title: "x", branch: "x", path: "/w/a", at: "" } }, terms), []);
assert.deepEqual(rowsOf({}, terms), []);
assert.deepEqual(rowsOf(tickets, []), []);
assert.deepEqual(rowsOf(undefined, terms), []);
console.log("ok");
