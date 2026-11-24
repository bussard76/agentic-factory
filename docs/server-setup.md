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

- **What it records:** `~/.config/agentic-factory/this-machine.json`: the ssh target and the id of this machine (`/etc/machine-id`, or `IOPlatformUUID` on macOS). A host counts as this machine only when its ssh target is listed there, the id is this machine's (a home directory copied to another machine carries another id and counts for nothing), and the user in the target is the user running the CLI. Nothing is ever concluded from a host name, a path or an address. `this-machine` refuses a target that answers over ssh from here (that is another machine, or one already reachable), a user that is not this login, and a target no host of the project has. `this-machine` alone shows what is recorded, `--forget` removes it.
- **What changes:** for that host `update` installs the standard in the clone directly, `start` copies the bundles into the Controller directory, schedules the heartbeat in this user's crontab (launchd on macOS) and opens the Controller in the local Orca (in the host's own clone, not in a worktree that `start` happened to run in); `doctor` checks the gate, the skills and the status without ssh; `status`, the status watch and the bot watch on this machine read the Controller's files directly. The handbooks and everything else rendered from the config stay the same on every machine.
- **What stays impossible from the server:** a worker host the config calls `kind: local` is the human's own machine. Its clone, its standard and its Front side are set up by running `update` and `start` there; the CLI says so once ("Note: … is the human's own machine") and does nothing for it.
- **A host that is not this machine** keeps the old behaviour: `update` and `start` report that it cannot be reached and exit 1, `doctor` reports `MISSING ssh … reachable`. When this checkout is that host's clone, the message names the `this-machine` command.
- **The Front agent on the server:** `start` sets up the Front side on the machine it runs on: the bundle in `~/front-agent/<project>`, the status watch (terminal Front agent) or the bot watch, and nothing else. A Front agent on the server therefore gets its watch there, reading the Controller locally; run `start` on the laptop too only if a Front agent lives there, and set `hosts.frontAgent.statusWatch` to `false` in a project that has none on the machine where `start` runs.

## Files the project changed where the template put them

`update` and `start` never replace a file the project changed, in the project's `.factory/`, in the Controller directory, in `~/front-agent/<project>` or on another worker host (the gate, its config). A file counts as changed when it is neither the new file nor something the template installed before. What the template installed before is known from the destination's own record (`.factory-installed.json`, written by `start`: the hash of every file it placed) and, for a destination that has no record yet, from the manifest (`.factory/manifest.json`: the hash of each bundle file, and `previous`, the hashes `update` replaced). A changed file stays; the new version lies beside it as `<name>.new` and in `.factory/new/.factory/controller/<name>` (or `front-agent`); `update` and `start` print each one. Take the new version (or merge it), delete the `.new`, run `start` again. The warnings about an outdated handbook (cleanup without `--apply`, no `inbox.mjs --done`, no `restart.md`) are about the file in use: the kept `CONTROLLER.md` in the Controller directory.

**The Controller's own config.** The tracked `factory.config.json` is the project's declared config; the copy in the Controller directory is the one the Controller's scripts read, and a project may tune it (models, caps, calibration). `start` installs the tracked copy only where nobody changed the Controller's copy since the last install. Otherwise the Controller's copy stays whole (no merge: a config merged from two files is one nobody wrote), the keys in which the two differ are listed, the tracked copy lies beside it as `factory.config.json.new`, and `cp factory.config.json.new factory.config.json` (in the Controller directory) takes it. A kept config is not a failure. The Front agent's copy (`~/front-agent/<project>/factory.config.json`) follows the same rule. `update` writes the tracked `factory.config.json` back in the text it had: only changed values change, in the file's own indentation, with its inline arrays and its final newline, and nothing is written when nothing changes. It does not change `factoryVersion` there; `doctor` names the installed factory version and, when the config records another one, that too.

## Lessons

- Pair Orca over the Tailscale address only; never expose it on the public interface.
- `needrestart` restarting `orca.service` kills every worker. The exception in step 3 is not optional.
- **Several projects on one host:** each project runs its own Controller. Set `hosts.controller.controllerDir` to a directory of its own (for example `~/controller-<project>`), then `agentic-factory update`. `start` refuses a directory that belongs to another project. Wave scripts and step logs under `/tmp` carry the project's name. The load log (`~/load.log`, every line ends in `project=<name>`) is shared; the gate is not: each project calls `<controllerDir>/gate` by that path (nothing in `~/.local/bin`), and gate queue, slots and capacity state are per project, and `capacity.mjs` counts the other project as foreign load.
- **Codex sandbox:** on hosts where AppArmor restricts unprivileged user namespaces, Codex's sandbox fails with `bwrap: loopback: Failed RTM_NEWADDR`, and the agent cannot run a single command. Either change the host's policy, or decide to run without it and set `agents.controllerArgs` in `factory.config.json` (for example `--dangerously-bypass-approvals-and-sandbox`). That is a security decision for the human: such an agent reaches everything its user can.
- A second project on the same host that starts and stops Docker stacks disturbs browser tests with `ERR_NETWORK_CHANGED`. Count those as environment, rerun, and never touch the other project.
- Keep the SSH config for the server in a file next to the scripts (`server/ssh_config.example`) so every Front-agent script can use `ssh -F`.
- Work data never goes to the server. Demo data and invented secrets only.
