# Changing the factory

Pull requests and merge requests come from the projects that use the factory. That something worked in one project is a reason to look at it, not a reason to take it.

**The goal: as much standard as possible in the factory, as much individual as necessary in each project.** So every project gets the most out of this way of working, without carrying what only another project needs.

## Review every request

This applies on every remote, before anything is accepted, whoever or whatever wrote the request.

1. **Check it against the code.** Read the diff and whatever depends on the changed behaviour, not only the description. Run the tests. Say what was not run for real. On GitHub, the [Tests workflow](.github/workflows/test.yml) runs `npm test` on every pull request, on Linux and macOS (Node 22); "green" means that check is green. Run a single test file (`node --test test/<file>`) for quick feedback while you work, and leave the full suite to the workflow when the machine you work on is shared with running factories.
2. **Sort each change, not the request as a whole:**

   | The change | What happens |
   |---|---|
   | Helps any project, with a real gain in quality or speed | Take it into the standard |
   | Projects need different values | Take the mechanism, with a good default. The value stays in the project |
   | Only this project needs it | Decline it. It belongs in the project's own files |
   | Cause unknown, or a matter of preference | Do not take it |

3. **Take a part if only a part holds.** Fix what the review finds, or ask for it, before merging.
4. **Record the outcome** in [docs/learnings.md](docs/learnings.md) when a lesson was taken over or declined, with the reason.

## Before merging

- **A script a human or the Controller runs takes `--help` and rejects unknown arguments.** Its first import is `import "./cli.mjs";`, and the comment at its top has a `Usage:` line naming every option and positional argument. That comment is the help text and the list of accepted arguments, so it cannot drift from what the script prints. Read options with `process.argv.includes/indexOf("--x")` and positionals from `process.argv.slice(2)`: `test/cli-args.test.mjs` fails on any other way of reading `process.argv`, on an option the script reads that its `Usage:` line does not name, and on an option literal that is neither in the `Usage:` line nor listed there as passed to another program.
- **A test leaves nothing behind.** `npm test` (`test/run.mjs`) gives the run a temp directory of its own, and every test file imports `test/support/safe-env.mjs`, which pulls in `test/support/cleanup.mjs`. Make a directory with `tempDir(prefix)`, not `fs.mkdtempSync`; start a background process with `spawnBackground`, or call `expectBackground(dir)` before running code that starts one (`agentic-factory start` launches a detached load logger); stop one with `stopBackground(dir)`, never with `pkill -f <name>`, which can hit another project's process on the same machine. What a file leaves in the temp folder without `tempDir`, or a process nobody expected, fails the file. A product script that needs a temp directory takes `scratchDir` from `controller/lib.mjs` (or the same few lines, as `scripts/skills-check.mjs` has them), which removes it on every way out.
- **No project or personal names, real URLs or paths,** in code, docs, commit messages or the request's text. This repository is public. Rewrite the text first; its old version can stay visible in the remote's history.

## After every change to `main`

Every new state of `main` is released, so a project can always stay on a tagged version that has all fixes.

1. **Set the version** in `package.json`, `factory.config.example.json` and `README.md`, and bring `site/index.html` up to date: the version it names, the link to the release notes (it carries the version tag, `releases/tag/v…`), the "Stand" and the block of changes on `main` that are not released yet (move what this release contains out of it).
   **Write the release notes** in `releases/v<version>.md`: what changed, how to update and what has not run for real. The file is part of the release commit, so every remote has it, and `npm test` fails while the version in `package.json` has no notes file.
2. **Tag it and push `main` and the tag to every remote.** There is no mirroring, so a merge on one remote does not reach the other.
3. **Publish the release on every remote,** always from that one notes file:
   - **GitHub:** `gh release create v<version> --verify-tag --title v<version> --notes-file releases/v<version>.md` (`--verify-tag` stops it from creating a tag that was not pushed).
   - **GitLab:** nothing to do by hand. The tag pipeline's `gitlab-release` job creates the release from the same file, with the job's own token. It leaves a release that already exists as it is, and fails when the notes file is missing. Check that the job is green. Tags pushed before the job existed get their release by starting `gitlab-release-backfill` by hand in a pipeline of the default branch; it creates only what is missing and can be run again.
   - **If `gitlab-release` failed** (no notes file in the tagged commit, no right to create the release): fix the cause, put the file on `main` through a pull request, and start `gitlab-release-backfill`. Re-running the failed job does not help when the file is missing, because it runs on the tagged commit. A failed backfill is an orange warning, not a red pipeline: its log ends with a `BACKFILL FAILED for:` line.
   - **Versions:** a release is a tag like `v1.2.3` and nothing else. Pre-release suffixes get no GitLab release, and `npm test` rejects them in `releases/` and in `package.json`.
   - **Link issues and pull requests in the notes by full URL,** not as `#12`: on GitLab `#12` points at that project's own issue 12.

## Correcting release notes after the release

The file in the repository is the source; the releases are copies. Change `releases/v<version>.md` on `main` through a pull request, then copy it to each remote, because nothing does it for you:

- **GitHub:** `gh release edit v<version> --notes-file releases/v<version>.md`
- **GitLab:** the job never updates an existing release. Run `glab release create v<version> --notes-file releases/v<version>.md` with a token that may create releases (without `--no-update` it updates the release that exists; there is no `glab release update`), or edit the release in the UI under **Deploy** > **Releases**.

The backfill reads the file on the default branch, the tag job reads it on the tagged commit: a fix after tagging reaches GitLab only through the commands above, or through the backfill when no release exists yet.
