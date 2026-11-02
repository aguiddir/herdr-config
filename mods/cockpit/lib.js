// Pure helpers: where Claude keeps a session's transcript, and what its tail says. Checked by lib.test.mjs.

// ~/.claude/projects/<folder>: the session's cwd with every character outside [A-Za-z0-9] turned into "-".
export function projectFolder(cwd) {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

// session: ~/.claude/sessions/<pid>.json, which Claude writes for each live process.
export function transcriptPath(home, session) {
  return `${home}/.claude/projects/${projectFolder(session.cwd)}/${session.sessionId}.jsonl`;
}

// What the tail of a transcript says (its first line may be cut, and is skipped): the agent's
// last words, when its newest turn was, and the question it is still waiting on, if that turn
// asked one through AskUserQuestion and nothing answered it yet.
export function lastWords(tail) {
  const lines = tail.split("\n");
  let text = null, at = null, question = null, newest = true, answered = false;
  for (let i = lines.length - 1; i >= 0 && text === null; i--) {
    let d;
    try { d = JSON.parse(lines[i]); } catch { continue; }
    if (d.isSidechain) continue;
    const content = d.message?.content;
    if (!Array.isArray(content)) continue;
    if (d.type === "user") { if (content.some((b) => b.type === "tool_result")) answered = true; continue; }
    if (d.type !== "assistant") continue;
    if (newest) {
      at = d.timestamp ? Date.parse(d.timestamp) : null;
      const ask = answered ? null : content.find((b) => b.type === "tool_use" && b.name === "AskUserQuestion");
      const q = ask?.input?.questions?.[0];
      if (q) question = { question: q.question, options: (q.options ?? []).map((o) => ({ label: o.label, description: o.description ?? "" })) };
    }
    newest = false;
    const block = content.filter((b) => b.type === "text" && b.text.trim()).pop();
    if (block) text = block.text.trim();
  }
  return { text, at, question };
}

// A paragraph for a card: markdown noise out, one space between words, cut at `max`.
export function brief(text, max = 320) {
  const s = (text ?? "").replace(/```[\s\S]*?```/g, " ").replace(/^[#>\-*\d.]+\s+/gm, "").replace(/[*_`]/g, "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1).replace(/\s\S*$/, "")}…` : s;
}

export function ago(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "à l'instant";
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h} h` : `${Math.floor(h / 24)} j`;
}
