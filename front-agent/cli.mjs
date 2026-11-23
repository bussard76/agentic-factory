// Arguments for every script in this directory that a human or the Controller runs. A script imports it FIRST:
//   import "./cli.mjs";
// Imports run in order, so this check runs before lib.mjs reads the config and before the script does anything.
// The script's leading comment is its help, and the part from "Usage:" on is the grammar it accepts:
//   --flag, --flag <value> or --flag "<value>", and positional arguments when a `node <script> …` line names any
//   (on such a line, text after "→" or after three spaces is a description, not an argument).
//   --help or -h         prints the leading comment and exits 0; nothing else runs
//   an unknown -option   usage error on stderr, exit 2, before anything runs
//   a positional         the same, when the Usage line names no positional argument
// So the printed help and the comment are one text. front-agent/cli.mjs is a byte-identical copy (the bundles ship apart).
// Usage: none; a module, imported by the scripts
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HELP = ["--help", "-h"];
const OPTION = /(?<![\w<-])(--?[A-Za-z][\w-]*)( (?=[<"]))?/g;

/** The leading // comment block of a script's source, without the comment markers (a #! line is skipped). */
export function leadingComment(source) {
  const lines = source.split("\n");
  const out = [];
  for (let i = lines[0]?.startsWith("#!") ? 1 : 0; i < lines.length && /^\s*\/\//.test(lines[i]); i++) out.push(lines[i].replace(/^\s*\/\/ ?/, ""));
  return out.join("\n");
}

/** What the usage text from "Usage:" on accepts: options (name → takes a value) and whether positionals are allowed.
 *  `prog` is how a usage line names the command ("cleanup.mjs", "agentic-factory start"). null without a Usage line. */
export function grammar(help, prog) {
  const at = help.indexOf("Usage:");
  if (at < 0) return null;
  const usage = help.slice(at);
  const options = new Map();
  for (const m of usage.matchAll(OPTION)) options.set(m[1], Boolean(m[2]) || options.get(m[1]) === true);
  const positional = usage.split("\n").some((line) => {
    const i = line.indexOf(`${prog} `);
    if (i < 0) return false;
    const rest = line.slice(i + prog.length).split(/→|\s{3,}/)[0].replace(/(?<![\w<-])--?[A-Za-z][\w-]*( (<[^>]*>|"[^"]*"))?/g, "");
    return /[^\s[\]|.…]/.test(rest);
  });
  return { usage, options, positional };
}

/** Pure: "help", or the arguments the grammar does not accept (empty when all are fine). */
export function parse(argv, g) {
  const bad = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (HELP.includes(a)) return "help";
    if (g.options.has(a)) { if (g.options.get(a)) i++; continue; }
    // An option is one word (--name, -x, --name=value); free text such as "- fixes x" is a positional.
    if (/^--?[A-Za-z][\w-]*(=.*)?$/.test(a) || !g.positional) bad.push(a);
  }
  return bad;
}

/** Prints the help and exits 0, or prints a usage error and exits 2, or returns when the arguments are fine. */
export function check(argv, help, prog) {
  const g = grammar(help, prog);
  if (!g) throw new Error(`${prog}: its leading comment has no "Usage:" line`);
  const r = parse(argv, g);
  if (r === "help") { process.stdout.write(`${help.trim()}\n`); process.exit(0); }
  const eq = r.find((a) => g.options.get(a.split("=")[0]) === true);
  if (r.length) { process.stderr.write(`${prog}: unknown argument ${r.map((a) => JSON.stringify(a)).join(", ")}${eq ? ` (write ${eq.split("=")[0]} <value>, without =)` : ""}\n${g.usage.trim()}\nRun it with --help for more.\n`); process.exit(2); }
}

// Runs only when the script started by node lies in this directory (or below it), not when a test imports a script.
const here = fs.realpathSync(fileURLToPath(import.meta.url));
const entry = (() => { try { return fs.realpathSync(process.argv[1] ?? ""); } catch { return ""; } })();
if (entry && entry !== here && entry.startsWith(path.dirname(here) + path.sep)) check(process.argv.slice(2), leadingComment(fs.readFileSync(entry, "utf8")), path.basename(entry));
