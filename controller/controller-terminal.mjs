// Finds the Controller's Orca terminal in a terminal list. Shared by heartbeat.mjs and `agentic-factory start`/`status`.
// Pure apart from a realpath on paths it can see: no config, no Orca call, so the CLI can import it without loading the
// Controller's lib.mjs.
//
// Who is the Controller is settled by how it was made, with where it runs and what runs in it only as a check:
//  1. The handle `start` recorded from the receipt of the `terminal create` it performed itself. It is never taken from a
//     lookup later, so no session that merely looks right can become the Controller.
//  2. Without a usable record (an installation from before): only a terminal that carries the factory's own name for the
//     Controller, "<project> · Controller", as its title or pane title (or pi's "π - <cwd>" title form), and passes the checks.
//  An unnamed agent session in the project's checkout (a person's own, the Front agent's) is never the Controller, however
//  alone it is. The checks: live (not orphaned), an agent session, running in this Controller's directory or the project's
//  worktree (Orca lists a Controller's worktreePath as the project), and not named for another role.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const strip = (p) => String(p ?? "").replace(/\/+$/, "");
const real = (p) => { try { return fs.realpathSync(p); } catch { return strip(p); } };
const samePath = (a, b) => Boolean(a && b) && (strip(a) === strip(b) || real(a) === real(b));
const piTitle = (controllerDir) => new RegExp(`^(\\S+ )?(Pi|π) - (.*/)?${escape(strip(controllerDir).split("/").pop())}/?$`);
// Terminals the factory itself names for another role in the same checkout: the Front agent, workers, the integration wave.
const OTHER_ROLE = /· (Front Agent|Worker|Integration)/;

// The directories a Controller may show up in, the same list for `start`, `status` and the heartbeat: the checkout `start` ran
// in (cwd) and the one `start` recorded next to the handle, the project's configured directory, and the Controller directory.
export function controllerPlaces({ cwd, projectDir, controllerDir, recordedWorktree, home = os.homedir() }) {
  const abs = (p) => { const x = String(p ?? "").replace(/^~(?=\/|$)/, home); return x.startsWith("/") ? path.posix.resolve(x) : ""; };
  return [...new Set([cwd, recordedWorktree, projectDir, controllerDir].map(abs).filter(Boolean))];
}

const runsHere = (t, dirs) => (dirs ?? []).some((d) => samePath(t.worktreePath, d));
// Live, an agent session, running here, and not named for another role. Without a worktree or an agent in the listing
// (older Orca versions) it is unconfirmed: no wake.
export const confirmController = (t, dirs) => Boolean(t) && !t.orphaned && Boolean(t.agentIdentity) && runsHere(t, dirs) && ![t.title, t.paneTitle].some((n) => OTHER_ROLE.test(n ?? ""));

// terminal     the Controller: the recorded handle if it is confirmed, else the one confirmed terminal that carries the
//              Controller's name; undefined otherwise
// ambiguous    several confirmed terminals carry the name and none is recorded: none is the answer
// unconfirmed  carries the name but Orca does not show it as an agent running here: no wake, and `start` does not open
//              another next to it
// unnamed      agent sessions running here that are neither recorded nor named (a person's, the Front agent's, or an old
//              Controller whose CLI rewrote its title): never the Controller, listed so the caller can say they exist
// record       "none", "confirmed", "unknown" (listed, but Orca does not yet show an agent or a worktree: keep it, no wake) or
//              "invalid" (gone, orphaned, another worktree, another role: drop it)
// exclude      handles that are never candidates: the session that runs `start` is the Front agent's own
export function locateController(terminals, { title, controllerDir, handle, dirs, exclude = [] }) {
  const all = (Array.isArray(terminals) ? terminals : []).filter((t) => t && !exclude.includes(t.handle));
  const live = all.filter((t) => !t.orphaned);
  const pi = piTitle(controllerDir);
  const named = (t) => t.title === title || t.paneTitle === title || pi.test(t.title ?? "") || pi.test(t.paneTitle ?? "");
  const confirmed = live.filter((t) => confirmController(t, dirs));
  const rec = handle ? all.find((t) => t.handle === handle) : undefined;
  const record = !handle ? "none" : !rec || rec.orphaned || (rec.worktreePath && !runsHere(rec, dirs)) || [rec.title, rec.paneTitle].some((n) => OTHER_ROLE.test(n ?? "")) ? "invalid" : confirmController(rec, dirs) ? "confirmed" : "unknown";
  let terminal; let ambiguous = [];
  if (record === "confirmed") terminal = rec;
  else {
    const byName = confirmed.filter(named);
    if (byName.length === 1) terminal = byName[0]; else ambiguous = byName;
  }
  const elsewhere = (t) => t.worktreePath && !runsHere(t, dirs);
  const unconfirmed = terminal || ambiguous.length ? [] : live.filter((t) => !confirmed.includes(t) && named(t) && !elsewhere(t) && !OTHER_ROLE.test(t.title ?? ""));
  const unnamed = confirmed.filter((t) => t !== terminal && !ambiguous.includes(t));
  return { terminal, ambiguous, unconfirmed, unnamed, confirmed, record };
}

// The Controller terminal, or undefined.
export const findControllerTerminal = (terminals, title, controllerDir, handle, dirs, exclude) => locateController(terminals, { title, controllerDir, handle, dirs, exclude }).terminal;

// How a Controller session is made. `agentic-factory start` and the restart (controller/restart.mjs, also run by the heartbeat)
// build it here, so a restarted Controller gets exactly the command a first start gives it, with exactly the configured controllerArgs.
export const controllerPrompt = (dir, project) => `Read ${dir}/CONTROLLER.md and act as the Controller for the project ${project}.`;
export const agentCommand = (agent, prompt, args) => `${agent}${args ? ` ${args}` : ""} ${JSON.stringify(prompt)}`;
export const controllerSession = ({ dir, project, agent, args }) => `cd ${dir} && ${agentCommand(agent, controllerPrompt(dir, project), args)}`;
// The `orca terminal create` arguments for the Controller's terminal; `where` is ["--worktree", "path:…"] (and --environment from a client).
// keepOpen (the restart): a terminal made from a session Orca counts as a worker closes together with it unless it is asked to stay.
export const createArgs = ({ where, title, session, keepOpen = false }) => ["terminal", "create", ...where, "--title", title, "--command", session, ...(keepOpen ? ["--keep-open"] : []), "--json"];
/** The handle in Orca's answer to `terminal create`, or undefined. */
export const createdHandle = (stdout) => { try { const j = JSON.parse(stdout).result; return j?.terminal?.handle ?? j?.handle; } catch { return undefined; } };

// Which options the installed Orca's `terminal create` has. --keep-open is not on every Orca: 1.4.266 refuses it ("Unknown flag
// --keep-open for command: terminal create"), 1.4.272 has it; the versions between were not tried. `--help` is read-only and creates
// nothing, so it is asked first, and the option is passed only when the help names it. keepOpen: true, false, or null when the help
// could not be read (then nothing is assumed).
export const KEEP_OPEN_FROM = "1.4.272";
export const parseCreateHelp = (text) => (String(text ?? "").includes("terminal create") ? /--keep-open\b/.test(text) : null);
export function orcaCreateSupport(orca) {
  const help = spawnSync(orca, ["terminal", "create", "--help"], { encoding: "utf8", timeout: 20_000 });
  const ver = spawnSync(orca, ["--version"], { encoding: "utf8", timeout: 20_000 });
  return { keepOpen: help.status === 0 ? parseCreateHelp(help.stdout) : null, version: (String(ver.stdout ?? "").match(/\d+(?:\.\d+)+/) ?? [])[0] };
}
/** The refusal of the option by an Orca that does not know it. */
export const refusedKeepOpen = (text) => /unknown (flag|option)[^\n]*--keep-open/i.test(String(text ?? ""));
