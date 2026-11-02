// node mods/cockpit/lib.test.mjs
import assert from "node:assert/strict";
import { projectFolder, transcriptPath, lastWords, brief, ago } from "./lib.js";

assert.equal(projectFolder("/home/a@b.c/IdeaProjects/renoshield"), "-home-a-b-c-IdeaProjects-renoshield");
assert.equal(transcriptPath("/home/me", { cwd: "/home/me/x", sessionId: "s1" }), "/home/me/.claude/projects/-home-me-x/s1.jsonl");

const line = (o) => JSON.stringify(o);
const assistant = (content, ts = "2026-11-02T10:00:00Z") => line({ type: "assistant", timestamp: ts, message: { role: "assistant", content } });
const result = line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "x" }] } });
const ask = { type: "tool_use", name: "AskUserQuestion", input: { questions: [{ question: "Je supprime ?", options: [{ label: "Oui", description: "d1" }, { label: "Non" }] }] } };

// A cut first line and side chains are skipped; the last text wins, with its time.
let w = lastWords(['{"type":"assis', assistant([{ type: "text", text: "Ancien" }], "2026-11-02T09:00:00Z"), line({ type: "assistant", isSidechain: true, message: { content: [{ type: "text", text: "sous-agent" }] } }), assistant([{ type: "text", text: "  Fini.  " }])].join("\n"));
assert.deepEqual(w, { text: "Fini.", at: Date.parse("2026-11-02T10:00:00Z"), question: null });

// A question in the newest turn, not yet answered: the text before it, the time of the question.
w = lastWords([assistant([{ type: "text", text: "Contexte" }], "2026-11-02T09:00:00Z"), assistant([ask], "2026-11-02T09:05:00Z")].join("\n"));
assert.equal(w.text, "Contexte");
assert.equal(w.at, Date.parse("2026-11-02T09:05:00Z"));
assert.deepEqual(w.question, { question: "Je supprime ?", options: [{ label: "Oui", description: "d1" }, { label: "Non", description: "" }] });

// Answered: a tool_result came after it.
w = lastWords([assistant([ask]), result].join("\n"));
assert.equal(w.question, null);

// Text and tool calls in one turn: the text shows, the (non-question) tool is ignored.
w = lastWords([assistant([{ type: "text", text: "Je lance les tests" }, { type: "tool_use", name: "Bash", input: {} }])].join("\n"));
assert.equal(w.text, "Je lance les tests");

assert.equal(lastWords("").text, null);

assert.equal(brief("## Titre\n\n- **gras** et `code`\n\n```js\nx\n```\n\n1. fin"), "Titre gras et code fin");
assert.equal(brief("a".repeat(10) + " " + "b".repeat(400), 20), "aaaaaaaaaa…");
assert.equal(ago(30000), "à l'instant");
assert.equal(ago(12 * 60000), "12 min");
assert.equal(ago(2 * 3600000), "2 h");
console.log("ok");
