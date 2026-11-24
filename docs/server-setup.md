# Server setup

The Controller and all workers run on a Linux server. The scripts in `server/` take a fresh Ubuntu 24.04 (arm64 or amd64) to a working build host in about an hour. Only the logins are the human's job.

## Sizing

- **CPU is the bottleneck, not memory.** Full verify and browser suites are CPU-bound. 12 threads and 62 GB carried 8 suite workers plus 6 read-only workers with gates in 3+2 slots; the load still peaked above the thread count, which is what the measured-capacity rule now prevents.
- **Memory:** about 1 GB per agent with a gate run. 32 GB allows 8–10 parallel workers.
- **Disk:** 160 GB or more. Worktrees and Docker images fill 75 GB quickly.

## Steps

Steps marked **[human]** need the human's credentials.

1. **[human]** Order the server, install Ubuntu (a Hetzner `installimage` example is in `server/installimage.example.conf`), set up SSH as root.
2. **[human]** If you use Orca: download the Orca package for the server's architecture (same version as on your machine) and copy it with the `server/` folder to the server.
3. `sudo bash 1-root-setup.sh ./orca-ide_<version>_<arch>.deb` (or an AppImage, or `--no-orca`): base packages, Docker, gh, Tailscale, the `developer` user, Orca, a needrestart exception so updates never kill the workers.
4. **[human]** `sudo tailscale up` and confirm in the browser.
5. **[human]** as `developer`: `gh auth login && gh auth setup-git`, then `bash 2-user-setup.sh <owner> <repo>…` (Node via nvm, pnpm, the agent CLIs, uv, your repos, dependencies, Playwright browsers; it arms the git hooks in each clone with `core.hooksPath=.githooks`, which is per clone and not committed), then `codex login` and/or `claude` login. `agentic-factory doctor` reports a clone without armed hooks.
6. `sudo bash 3-root-finish.sh`: Playwright system packages; with Orca, `orca.service` bound to the Tailscale address, started and enabled.
7. **[human]** With Orca: take the pairing code from the service log and pair your machine (`orca environment add --name <env> --pairing-code '<code>'`). Pair without a mobile code; a mobile pairing cannot create repos or start workers. Register the repo on the server with `orca repo add --path ~/projects/<name>` and put the printed repo id into `factory.config.json`.
8. `bash 4-verify.sh --gates` as `developer`: checks every tool and login, then runs the full gates on `main`. The server is ready when they are green.
9. Copy the `controller/` bundle that `init` produced to `~/controller` on the server. **Install the user-level skills from it** (`mkdir -p ~/.claude/skills ~/.agents/skills && cp -R ~/controller/skills/* ~/.claude/skills/ && cp -R ~/controller/skills/* ~/.agents/skills/`): the Controller runs outside the repo and cannot steer workers without the `orchestration` and `orca-cli` skills. Then start the Controller in a terminal there (`claude --dangerously-skip-permissions "<start order from CONTROLLER.md>"` or the Codex equivalent) and confirm the directory trust once.

## Running the CLI on the Controller's own machine

`factory.config.json` is shared, so it describes the server as the human's laptop sees it: `kind: remote`, an ssh target. Run `update`, `doctor` or `start` on the server itself and that target usually does not resolve (a server has no ssh alias to itself). Say once, on the server, that it is that host:

```bash
agentic-factory this-machine <the host's ssh target, as written in hosts.workers[].ssh>
```

- **What it records:** `~/.config/agentic-factory/this-machine.json`, one entry per machine: its ssh targets, its machine id (`/etc/machine-id`, or `IOPlatformUUID` on macOS) and its host name. A host counts as this machine only when its ssh target is listed in this machine's entry (same id **and** same host name), and the user in the target is the user running the CLI. Nothing is ever concluded from a name, a path or an address alone. A machine without a machine id never matches and `this-machine` refuses to record there. A record copied to another machine (dotfiles, a copied home) carries another id or host name and counts for nothing; a home shared by several servers (NFS) holds one entry each. **A cloned VM** that keeps both the machine id and the host name cannot be told from the original: give the clone its own id (`systemd-machine-id-setup`) or host name, or run `agentic-factory this-machine --forget` on it. `this-machine` refuses a target that answers over ssh from here (another machine, or one already reachable: it says so and records nothing, exit 0), a user that is not this login, a target no host of the project has, and a host whose clone is not this repository here. `this-machine` alone shows what is recorded, `--forget [<ssh target>]` removes this machine's entry (or one target).
- **What changes:** for that host `update` installs the standard in the clone directly, `start` copies the bundles into the Controller directory, schedules the heartbeat in this user's crontab (launchd on macOS) and opens the Controller in the local Orca (in the host's own clone, not in a worktree that `start` happened to run in); `doctor` checks the gate, the skills and the status without ssh; `status`, the status watch and the bot watch on this machine read the Controller's files directly. The handbooks and everything else rendered from the config stay the same on every machine.
- **What stays impossible from the server:** a worker host the config calls `kind: local` is the human's own machine. Its clone, its standard and its Front side are set up by running `update` and `start` there; the CLI says so once ("Note: … is the human's own machine") and does nothing for it.
- **A host that is not this machine** keeps the old behaviour: `start` reports that it cannot be reached and exits 1, `update` says so too (and exits 1 where it installs the standard in that clone), `doctor` reports `MISSING ssh … reachable`. When this checkout is that host's clone, the message names the `this-machine` command.
- **The Front agent on the server:** `start` sets up the Front side on the machine it runs on: the bundle in `~/front-agent/<project>`, the status watch (terminal Front agent) or the bot watch, and nothing else. A Front agent on the server therefore gets its watch there, reading the Controller locally; run `start` on the laptop too only if a Front agent lives there, and set `hosts.frontAgent.statusWatch` to `false` in a project that has none on the machine where `start` runs.

## Files the project changed where the template put them

The rule for what `update` and `start` install in the Controller directory, in `~/front-agent/<project>` and on other worker hosts (the gate, its config):

**(A) Code is never kept.** Scripts, the gate and everything else that runs are always installed as one set of the new version, so no installation runs two versions at once (a kept `lib.mjs` next to new scripts crashes at import). A copy that differs from what is installed and is not a version the template installed before is saved beside the new file first, as `<name>.backup-<date>` (a number is added when the day's name is taken), and every such file is listed in the output (`NOTE: … replaced by the new version … <name> → <name>.backup-<date>`). Nothing the project wrote is lost. A file the project deleted is installed again.

**(B) Only the files people edit follow a keep rule:** the handbooks (the top-level `*.md` of a bundle: `CONTROLLER.md`, `FRONT_AGENT.md`, `FRONT_BOT.md`, …) and the Controller's `factory.config.json`.
- Positively known to be changed by the project (the destination has a record of what `start` installed there, `.factory-installed.json`, and the file differs from it): kept. The new version lies beside it as `<name>.new` and in `.factory/new/.factory/<bundle>/<name>`, and every kept file is listed. The warnings about an outdated handbook (cleanup without `--apply`, no `inbox.mjs --done`, no `restart.md`) fire for the file in use.
- A version the template installed before (the record, the manifest's `files`, its `previous`, its last 20 committed versions): replaced, nobody changed it.
- The baseline cannot be established (no record, and the file matches no known version: an installation by an older version, a shallow clone, an uncommitted manifest): **not kept silently.** The new version is installed, the old file is saved as `<name>.backup-<date>`, and `WARNING: … replaced by the new version, because nothing says whether the project changed it … saved as …` names the files, so a project that edited its handbook carries its changes over from the copy and one that did not is simply up to date. Exit 0; never silent. From then on there is a record, and a later edit is kept.

**(C) The installation is one version.** `start` checks the directory again after the copy and fails when a script is not the new version (and writes the record only after that check); `doctor` compares every script of the bundle with the installed one (a lost executable bit counts) and fails with `not the version of this project's bundle` otherwise; it also fails when the handbook in use does not mention what the scripts need.

**The Controller's own config.** The tracked `factory.config.json` is the project's declared config; the copy in the Controller directory is the one the Controller's scripts read, and a project may tune it (models, caps, calibration). With a record that shows the project changed it, `start` keeps it whole (no merge: a config merged from two files is one nobody wrote), lists **every** differing key (an array of named objects such as `hosts.workers` by the object's name: `hosts.workers[server].capacity.suiteWorkersMax`), puts the project's copy beside it as `factory.config.json.new`, and `cp factory.config.json.new factory.config.json` (in the Controller directory) takes it. A kept config is not a failure; `doctor` lists the differing keys too. Keys that only the project's copy has are not in the Controller's copy until you copy them: the scripts' defaults apply meanwhile. `update` writes the tracked `factory.config.json` back in the text it had: only changed values change, in the file's own indentation, with its inline arrays and its final newline, and nothing is written when nothing changes. It does not change `factoryVersion` there; `doctor` names the installed factory version and, when the config records another one, that too.

## Lessons

- Pair Orca over the Tailscale address only; never expose it on the public interface.
- `needrestart` restarting `orca.service` kills every worker. The exception in step 3 is not optional.
- **Several projects on one host:** each project runs its own Controller. Set `hosts.controller.controllerDir` to a directory of its own (for example `~/controller-<project>`), then `agentic-factory update`. `start` refuses a directory that belongs to another project. Wave scripts and step logs under `/tmp` carry the project's name. The load log (`~/load.log`, every line ends in `project=<name>`) is shared; the gate is not: each project calls `<controllerDir>/gate` by that path (nothing in `~/.local/bin`), and gate queue, slots and capacity state are per project, and `capacity.mjs` counts the other project as foreign load.
- **Codex sandbox:** on hosts where AppArmor restricts unprivileged user namespaces, Codex's sandbox fails with `bwrap: loopback: Failed RTM_NEWADDR`, and the agent cannot run a single command. Either change the host's policy, or decide to run without it and set `agents.controllerArgs` in `factory.config.json` (for example `--dangerously-bypass-approvals-and-sandbox`). That is a security decision for the human: such an agent reaches everything its user can.
- A second project on the same host that starts and stops Docker stacks disturbs browser tests with `ERR_NETWORK_CHANGED`. Count those as environment, rerun, and never touch the other project.
- Keep the SSH config for the server in a file next to the scripts (`server/ssh_config.example`) so every Front-agent script can use `ssh -F`.
- Work data never goes to the server. Demo data and invented secrets only.
