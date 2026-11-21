// Finds the Controller's Orca terminal in a terminal list. Shared by heartbeat.mjs and `agentic-factory start`/`status`.
// Pure: no config, no Orca call, so the CLI can import it without loading the Controller's lib.mjs.
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The exact title "<project> · Controller" wins. Some agent CLIs overwrite it with their own: pi shows "π - <cwd>" or
// "Pi - <cwd>", optionally behind a spinner. The cwd is the Controller directory, so such a title ending in its folder
// name is the Controller too.
export function findControllerTerminal(terminals, title, controllerDir) {
  const list = Array.isArray(terminals) ? terminals : [];
  const folder = escape(String(controllerDir).replace(/\/+$/, "").split("/").pop());
  const agentTitle = new RegExp(`^(\\S+ )?(Pi|π) - (.*/)?${folder}/?$`);
  return list.find((t) => t.title === title) ?? list.find((t) => agentTitle.test(t.title ?? ""));
}
