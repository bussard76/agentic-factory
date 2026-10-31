# Factory review 1

This review is based on static inspection. The requested temporary-repository smoke test and hook trials could not be run: the active lean-ctx shell policy blocked `mktemp` and inline Node execution, and changing that policy would modify files outside the permitted review file. No SSH or network-dependent smoke tests were attempted.

## Prioritized improvement proposals

1. **Make review coverage fail closed.** `templates/tools/factory-guardrails.mjs:117` compares `tryGit("merge-base", "--is-ancestor", ...)` with an empty string, but `tryGit` returns the same empty string on success and failure. Any passing review whose referenced tree differs only in docs can therefore cover an unrelated commit; malformed Git operations also disappear. Check exit status explicitly, require the reviewed SHA to exist and be an ancestor of the pushed tip, and test unrelated histories and failing Git commands.

2. **Prevent cleanup from deleting untracked work.** `controller/cleanup.mjs:26-35` excludes untracked files from its dirty check, then force-removes worktrees, including those merely pushed but not merged. This can destroy a worker's untracked output; failed terminal lookups are also treated as an empty busy list. Include untracked files, fail closed when worker state cannot be verified, and remove only positively verified idle worktrees without `--force`.

3. **Fix capacity failure under pressure.** `controller/capacity.mjs:47-64` calls `reasonsText()` in the hot, near-cap branch before `const reasons` is initialized, causing a temporal-dead-zone exception. A pressured controller can therefore fail to decide capacity when it most needs to. Build the reasons before calibration and exercise hot/cold decisions with fixture measurements.

4. **Make a fresh local repository actually runnable.** `bin/agentic-factory.mjs:62,83`, `controller/start.mjs:53` and `controller/integ-wave.sh:11` assume an origin and `origin/main`, while `docs/getting-started.md:7` promises a fresh `git init` and all-local first wave. `init --yes` leaves a literal `github.com/<owner>/...` repo when no remote exists; workers and waves then fetch a nonexistent origin. Support a local bare remote or a local-branch workflow, or explicitly require and verify a working remote before promising the first wave; document setup in both languages.

5. **Make local Front-agent operation local.** `front-agent/statuswatch.mjs:13-22` and `front-agent/relay.mjs:10-22` always use SSH and `hosts.controller.ssh`, but `init` writes only `host` and `controllerDir` in that object, including for local operation. The handbook also tells the Front agent to SSH to the rendered `local` alias. Resolve the selected worker host's connection data and use direct filesystem operations for local mode; test local and remote configurations.

6. **Preserve user files on update and rerun.** `bin/agentic-factory.mjs:109-115,196-203` records an existing locally changed file as its baseline on `init`, allowing the next run to overwrite it; `update` also overwrites existing files absent from the manifest. Neither shows a diff before replacement despite `README.md` promising one. Treat unknown and locally modified files as user-owned, retain the last generated baseline, and show a real diff with explicit acceptance.

7. **Stop reporting successful waves when pushes fail.** `controller/integ-wave.sh:11,35` continues after a failed fetch/checkout and pipes `git push` through `strip | tail` without `pipefail`, masking a rejected push. The controller can report integration when main never moved. Fail immediately on setup failures and propagate the push's exit status through the wave result.

8. **Fail worker startup if worktree creation fails.** `controller/start.mjs:53-67` calls `onHost`, which suppresses errors, then spawns and records success without awaiting spawn errors or verifying remote launch. Remote `~` paths are quoted literally, preventing home expansion. Expand paths on the target, return and check setup and launch status, and persist a worker only after a verified start.

9. **Fix model calibration's default window.** `controller/calibrate-models.mjs:13` uses `process.argv[process.argv.indexOf("--days") + 1]`; with no flag this is the Node executable path, so `Number(...)` is `NaN` and every journal event is filtered out. Parse the optional flag explicitly, validate a positive number, and test default and explicit windows.

10. **Fix macOS gate support.** `controller/gate` requires `flock`, which is not provided by default on macOS, although the getting-started guide promises an all-local machine. Provide a portable lock or an explicit installation prerequisite, check for it during onboarding, and test the documented macOS path.

11. **Avoid silently approving empty gates.** `bin/agentic-factory.mjs:95-96` accepts undetected verify/e2e commands and retains unrelated example release commands; `controller/integ-wave.sh:28-33` can run an empty verify command successfully. A minimal project can pass a wave without tests. Require a deliberate configured verification command or an explicit, prominently recorded no-tests decision, and do not carry over example release commands.

12. **Correct the test-count guardrail.** `templates/tools/factory-guardrails.mjs:29-38` counts regex matches only in selected filenames, so replacing a meaningful test with a dummy call or deleting tests from unsupported frameworks passes; renamed tests, parameterized cases, and comments also distort counts. Treat this as a heuristic, support the project's actual test runner, and require review of test deletions instead of claiming it prevents weakening suites.

13. **Strengthen staged secret and environment checks.** `templates/tools/factory-guardrails.mjs:40-68` scans a small set of patterns, skips binary files, exempts all contents of the guardrail file, and exempts `.env.example` from the filename ban. Real credentials in other formats or excluded paths can pass; the error even rejects fabricated key-shaped examples. Use a maintained staged-secret scanner with scoped allowlisting and check all staged content, including examples; document that local hooks are not a security boundary.

14. **Enforce review independence and server-side protection.** `templates/tools/factory-guardrails.mjs:102-145` trusts any text file with `Verdict: pass`, does not identify the reviewer or verify the tested tree, and runs only in a local pre-push hook. A self-authored review or a different client can bypass the README's independence and main protection claims. Verify reviewer identity and exact reviewed tree in a protected CI/branch rule; describe local hooks as advisory.

15. **Correct dangerous preview cleanup.** `front-agent/preview-update.sh:21-23` runs `git clean -fdq` on the configured worktree and links the project's real `.env`; a mistaken path can delete untracked user files and expose real credentials to preview code. Verify that the directory is a dedicated managed clone, refuse a dirty worktree, and use a separate demo-only environment file.

16. **Make `--dry` genuinely dry.** `controller/cleanup.mjs:16,49` fetches/prunes remote-tracking refs and appends to the journal even with `--dry`. A newcomer cannot safely preview cleanup offline or without mutations. Skip fetch and journal writes in dry mode, and report that conclusions use existing local refs.

17. **Repair initialization for existing repositories and commands.** `bin/agentic-factory.mjs:57,63,95` only checks for a `.git` path, assumes `main` when no `origin/HEAD` exists, and asks for an empty command to skip while `askText` turns empty input back into the default. Verify the repository with `rev-parse`, derive the actual branch, and offer an explicit way to clear a command.

18. **Use meaningful calibration evidence.** `controller/calibrate-models.mjs:19-37` counts individual review events rather than finished tasks, does not join worker model/role to reviews, and can overwrite one role's recommendation when multiple tiers have enough events. `controller/capacity.mjs:52-55` raises the read-only cap on each invocation without a quiet period. Aggregate per completed task/current tier, record evidence and changes, and apply consistent bounded calibration rules.

19. **Correct onboarding instructions and prerequisites.** `docs/getting-started.md:13,48,59-61` and `docs/de/erste-schritte.md` contain a non-runnable `<owner>` clone URL, promise doctor is OK before user-level skills are installed, and install into `~/.local/bin` without creating it. Use the actual distribution URL, put skill installation before doctor, and create/check the destination; explain required Git identity and remote setup.

20. **Synchronize EN/DE workflow and generated links.** `docs/de/workflow.md:28,79` and `docs/workflow.md:32` both say preview acceptance uses real data, which needs reconciliation with the no-real-data/demo rules and the preview's use of the project's real `.env`; both getting-started guides link to source-repository documents that are not copied into the adopting project. Define the intended boundary for human preview versus automated testing in both languages and copy or link the required docs in generated handbooks.

21. **Remove origin-specific defaults and stale onboarding claims.** `factory.config.example.json` and `bin/agentic-factory.mjs:84-87` use `workhorse` and `Workhorse`; `server/installimage.example.conf:1-6` includes concrete machine names and disk devices. `docs/onboarding.md` describes a different question order and says every hard rule is confirmed separately. Replace machine-specific defaults with clearly labeled examples and align the documented prompts with the actual wizard.

22. **Make advertised guardrails observable and robust.** `controller/gate:9-23` measures lock holders rather than actual waiters, and `controller/capacity.mjs` does not log calibration changes as decision events as documented. `docs/capacity.md` promises a queue-based fair gate and journaled calibration. Measure the waiting queue explicitly, record every calibration change, and qualify FIFO fairness unless the lock implementation guarantees it.

23. **Add executable regression coverage.** `package.json` declares `node --test test/`, but no `test/` directory is present; `bin/agentic-factory.mjs:282-285` loses each walked root and may check the wrong same-named file. Add isolated end-to-end tests for init, hooks, local controller commands, update and wave errors, and retain each source root in selfcheck.

## Five changes to do first

1. Fix review ancestry and fail closed on Git errors.
2. Preserve untracked work and require positive idle evidence before cleanup.
3. Fix the capacity pressure exception and portable gate support.
4. Make the documented fresh local repository reach its first wave.
5. Make Front-agent local and remote status access use the selected host correctly.

Reviewed commit: 73a67d1757ff8c252d1ef5b66fc7fc03bce6d759
