// node mods/projects/lib.test.mjs
import assert from "node:assert/strict";
import { nameOf, parseRepos, parseCommits, parseIcons, repoOfFolder, stamp, markOpened, order, filter, spaceRepo, openSpaceFor } from "./lib.js";

const P = "/h/PycharmProjects", I = "/h/IdeaProjects";

assert.deepEqual(parseRepos(`${P}//b/.git\n${I}/a/.git\n${P}/a/.git\n`), [`${I}/a`, `${P}/a`, `${P}/b`]);
assert.equal(nameOf(`${P}/my repo`), "my repo");

assert.deepEqual(parseCommits(`${P}/a 1700000000\n${P}/empty \n`), { [`${P}/a`]: 1700000000000 });
assert.deepEqual(parseCommits(`${P}/my repo 1700000000\n`), { [`${P}/my repo`]: 1700000000000 });

assert.deepEqual(parseIcons(`${I}/arthur\tIdeaProjects/arthur.png\t\n${P}/h\tPycharmProjects/h.svg\tPycharmProjects/h.dark.svg\n\n`, "d"), {
  [`${I}/arthur`]: { light: "d/IdeaProjects/arthur.png", dark: "d/IdeaProjects/arthur.png" },
  [`${P}/h`]: { light: "d/PycharmProjects/h.svg", dark: "d/PycharmProjects/h.dark.svg" },
});

const repos = [`${I}/arthur`, `${I}/arthur-x`, `${P}/arthur`];
assert.equal(repoOfFolder(`${I}/arthur/core`, repos), `${I}/arthur`);
assert.equal(repoOfFolder(`${I}/arthur-x`, repos), `${I}/arthur-x`);
assert.equal(repoOfFolder(`${P}/arthur`, repos), `${P}/arthur`);
assert.equal(repoOfFolder(`${P}/other`, repos), null);
assert.equal(repoOfFolder("/h", repos), null);

// recent first, then last commit, then name (case-insensitive), then path
assert.deepEqual(order(["/a", "/b", "/c", "/d"], { "/c": 2, "/a": 1 }, { "/b": 5, "/d": 9 }), ["/c", "/a", "/d", "/b"]);
assert.deepEqual(order(["/r/b", "/r/QA_x", "/r/a"], {}, {}), ["/r/a", "/r/b", "/r/QA_x"]);
assert.deepEqual(order([`${P}/x`, `${I}/x`], {}, {}), [`${I}/x`, `${P}/x`]);

// filter matches the name only, exact then prefix then the rest
const l = ["/r/xarthur", "/r/arthur", "/arthur/blaise"];
assert.deepEqual(filter(l, "ART"), ["/r/arthur", "/r/xarthur"]);
assert.deepEqual(filter(l, ""), l);
assert.deepEqual(filter(["/r/arthur-jobs", "/r/arthur"], "Arthur"), ["/r/arthur", "/r/arthur-jobs"]);

const before = { a: 1, b: 2 };
assert.deepEqual(stamp(before, ["c"], 7), { a: 1, b: 2, c: 7 });
assert.deepEqual(markOpened(before, ["a"], ["a", "b", "c"], 9), { a: 1, b: 9, c: 9 });
assert.deepEqual(before, { a: 1, b: 2 });

const space = { id: "s", tabs: [{ id: "t1" }, { id: "t2" }] };
const panes = [{ tab: "t2", cwd: `${P}/b` }, { tab: "t1", cwd: `${I}/arthur/core` }, { tab: "t1", cwd: `${P}/b` }];
assert.equal(spaceRepo(space, panes, repos), `${I}/arthur`);
assert.equal(spaceRepo(space, [{ tab: "t1", cwd: "/h" }], repos), null);

const spaces = [{ id: "s1", tabs: [{ id: "t1" }] }, { id: "s2", tabs: [{ id: "t2" }] }];
const ps = [{ tab: "t2", cwd: `${I}/arthur/core` }];
assert.equal(openSpaceFor(`${I}/arthur`, ps, spaces), "s2");
assert.equal(openSpaceFor(`${P}/arthur`, ps, spaces), null); // same name, other root
assert.equal(openSpaceFor(`${I}/arthur`, ps, [spaces[0], { ...spaces[1], machine: "vps" }]), null);
assert.equal(openSpaceFor(`${I}/arthur`, [{ tab: "t2", cwd: `${I}/arthur-x` }], spaces), null);
console.log("ok");
