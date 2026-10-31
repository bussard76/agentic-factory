# Vendored skills

Every skill in this directory is copied unchanged from its source at a pinned commit and carries its upstream license. `init` copies the directory into a project as `.agents/skills/` (Codex and Pi discover it directly) and links `.claude/skills` to it for Claude Code.

| Skill | Source | Pin | License | Used by |
|---|---|---|---|---|
| `ponytail`, `ponytail-review`, `ponytail-audit`, `ponytail-debt`, `ponytail-gain` | https://github.com/DietrichGebert/ponytail | `09c434ab73ca43761c5d8b0c5d341926c2fba710` | MIT, `PONYTAIL-LICENSE` | Developer (`ponytail`), Tester (`ponytail-review`), Architect (`ponytail-audit`), hardening phase (`ponytail-debt`) |
| `grilling`, `grill-with-docs`, `domain-modeling`, `to-tickets`, `setup-matt-pocock-skills`, `tdd`, `diagnosing-bugs`, `retro`, `handoff`, `writing-for-agents`, `codebase-design`, `code-review` | https://github.com/mattpocock/skills | `59db609eb1e18aaf59b63284d0e52255aff0c63c` | MIT, `MATTPOCOCK-LICENSE` | Front agent (clarify, slice), Developer (`tdd`, `diagnosing-bugs`), Tester (`code-review`), Retro worker (`retro`), everyone writing orders (`writing-for-agents`) |
| `wayfinder`, `to-spec`, `prototype` | https://github.com/mattpocock/skills (`skills/engineering/`) | main as of 2026-10-31 | MIT, `MATTPOCOCK-LICENSE` | Front agent: plan large efforts, turn an agreed discussion into a spec, build front-end fakes and logic demos |
| `orca-cli`, `orchestration` | shipped with Orca (`orca skills get <name>` prints the version-matched guide) | discovery stubs | Orca's terms | Controller and Front agent when the runner is Orca |

## Omitted on purpose

- `ponytail-help`: its instructions describe global configuration, plugin remote updates and global CLI installation. Everything else in ponytail was read completely and instructs none of that.
- Upstream installers, plugins, hooks and auto-updates of any source. Nothing here installs globally or updates itself.

## Repository precedence

**ADR format:** the vendored `domain-modeling/ADR-FORMAT.md` allows a one-paragraph ADR with an optional Status. In a factory project the commit hook accepts only references to ADRs with `Status: accepted` and a `Decided by:` line, so ADRs follow `docs/adr/0000-template.md`; the skill file stays an unchanged copy, the project's `AGENTS.md` states the rule.

A project's `AGENTS.md`, architecture docs and data and safety rules win every conflict with a skill. In particular: one multiple-choice question at a time; tests through public entry points; red-green-refactor; never weaken existing tests; handoffs go to `docs/handoffs/`; retro findings change repo files only, never global agent configuration.

## Updating a skill

1. Fetch the upstream repository into a temporary directory and check out an explicit commit.
2. Read every candidate file as code, including supporting files and YAML.
3. Omit and report any skill that instructs global installation or updates, global agent configuration changes, fetching or running remote code, or data exfiltration. If a core skill fails this rule, stop and ask the human.
4. Copy the approved directories and the license unchanged. Update the pin and date here.
5. Verify byte equality against upstream, check discovery in Codex and Claude Code, run the project's gates, and get an independent review like any other change.
