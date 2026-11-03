// node mods/pr-inbox/lib.test.mjs
import assert from "node:assert/strict";
import { bare, prOf, ci, rowsOf, fresh, toastFor, ago, sub, dotOf } from "./lib.js";

assert.equal(bare("♻️ POSO-112: Build"), "POSO-112: Build");
assert.deepEqual(prOf({ subject: { type: "PullRequest", url: "https://api.github.com/repos/o/r/pulls/203" }, repository: { full_name: "o/r" } }), { repo: "o/r", number: 203 });
assert.equal(prOf({ subject: { type: "Issue", url: "https://api.github.com/repos/o/r/issues/5" }, repository: { full_name: "o/r" } }), null);

assert.equal(ci(null), null);
assert.equal(ci([]), null);
assert.equal(ci([{ __typename: "StatusContext", state: "SUCCESS" }]), "ok");
assert.equal(ci([{ __typename: "StatusContext", state: "PENDING" }, { __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }]), "run");
assert.equal(ci([{ __typename: "CheckRun", status: "IN_PROGRESS", conclusion: null }, { __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" }]), "ko");
assert.equal(ci([{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SKIPPED" }]), "ok");

const repo = { name: "renoshield", nameWithOwner: "softwarevidal/renoshield" };
const requested = [{ number: 203, title: "♻️ POSO-112: Builder", repository: repo, updatedAt: "2026-11-03T13:00:00Z", isDraft: false, author: { login: "yoannwicker" }, url: "u203" }];
const mine = [
  { number: 187, title: "✨ POSO-103: Checks", repository: repo, updatedAt: "2026-11-03T11:54:54Z", isDraft: false, author: { login: "aguiddir" }, url: "u187" },
  { number: 205, title: "✨ POSO-91: ATC", repository: repo, updatedAt: "2026-11-03T13:30:00Z", isDraft: true, author: { login: "aguiddir" }, url: "u205" },
];
const notif = (id, reason, n, type = "PullRequest") => ({ id, reason, unread: true, updated_at: "2026-11-03T13:33:00Z", repository: { full_name: "softwarevidal/renoshield" }, subject: { type, url: `https://api.github.com/repos/softwarevidal/renoshield/${type === "Issue" ? "issues" : "pulls"}/${n}`, title: "t" } });
const notifs = [notif("1", "review_requested", 203), notif("2", "author", 187), notif("3", "comment", 9, "Issue")];
const details = { "softwarevidal/renoshield#187": { headRefName: "feat/poso-103", headRefOid: "abc", isCrossRepository: false, reviewDecision: "", additions: 10, deletions: 2, changedFiles: 3, body: "desc", statusCheckRollup: [{ __typename: "StatusContext", state: "SUCCESS" }],
  reviews: [{ author: { login: "aguiddir" }, state: "COMMENTED", body: "", submittedAt: "2026-10-29T15:43:04Z" }, { author: { login: "brondon-ung" }, state: "COMMENTED", body: "Relu", submittedAt: "2026-11-03T09:01:58Z" }, { author: { login: "yoannwicker" }, state: "COMMENTED", body: "", submittedAt: "2026-11-03T11:54:54Z" }] } };
const rows = rowsOf({ requested, mine, notifs, details, me: "aguiddir" });
assert.deepEqual(rows.map((r) => [r.key, r.section]), [["softwarevidal/renoshield#203", "review"], ["softwarevidal/renoshield#187", "back"], ["softwarevidal/renoshield#205", "wait"]]);
const r187 = rows[1];
assert.equal(r187.title, "POSO-103: Checks");
assert.equal(r187.name, "renoshield");
assert.equal(r187.branch, "feat/poso-103");
assert.equal(r187.ci, "ok");
assert.equal(r187.remarks, 2);
assert.deepEqual(r187.notifs, ["2"]);
assert.equal(r187.mine, true);
assert.equal(r187.fork, false);
assert.equal(rows[0].branch, null);
assert.equal(rows[0].notifs[0], "1");
assert.equal(rows[2].draft, true);
assert.equal(dotOf(rows[0]), "blocked");
assert.equal(dotOf(rows[1]), "ansi5");
assert.equal(dotOf(rows[2]), "working");
assert.equal(dotOf({ ...rows[1], decision: "CHANGES_REQUESTED" }), "blocked");
assert.equal(dotOf({ ...rows[2], decision: "APPROVED" }), "done");

assert.deepEqual(fresh(notifs, null), { fresh: [], seen: ["1", "2", "3"] });
const f = fresh([...notifs, notif("4", "review_requested", 198)], ["1", "2", "3"]);
assert.deepEqual(f.fresh.map((n) => n.id), ["4"]);
assert.deepEqual(f.seen, ["1", "2", "3", "4"]);
assert.deepEqual(fresh([notif("5", "comment", 9, "Issue")], []).fresh, []);

assert.deepEqual(toastFor(notifs[0], rows[0]), { title: "yoannwicker te demande une review", body: "renoshield #203 · POSO-112: Builder" });
assert.deepEqual(toastFor(notifs[1], rows[1]), { title: "yoannwicker a relu #187", body: "renoshield #187 · POSO-103: Checks" });
assert.equal(toastFor(notifs[1], undefined).title, "Du nouveau sur #187");

const now = Date.parse("2026-11-03T14:00:00Z");
assert.equal(ago(30000), "à l'instant");
assert.equal(ago(12 * 60000), "il y a 12 min");
assert.equal(ago(3 * 3600000), "il y a 3 h");
assert.equal(ago(30 * 3600000), "hier");
assert.equal(ago(4 * 86400000), "il y a 4 j");
assert.equal(sub(rows[0], now), "renoshield · yoannwicker · il y a 1 h");
assert.equal(sub(rows[1], now), "renoshield · brondon-ung · yoannwicker · 2 remarques · il y a 2 h");
assert.equal(sub(rows[2], now), "renoshield · aucune review · il y a 30 min");
assert.equal(sub({ ...rows[2], decision: "APPROVED", reviews: [{ author: "mlefevre", state: "APPROVED", body: "", submittedAt: "" }] }, now), "renoshield · approuvée par mlefevre · il y a 30 min");
console.log("ok");
