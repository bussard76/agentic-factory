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
5. **[human]** as `developer`: `gh auth login && gh auth setup-git`, then `bash 2-user-setup.sh` (Node via nvm, pnpm, the agent CLIs, uv, your repos from `factory.config.json`, dependencies, Playwright browsers), then `codex login` and/or `claude` login.
6. `sudo bash 3-root-finish.sh`: Playwright system packages; with Orca, `orca.service` bound to the Tailscale address, started and enabled.
7. **[human]** With Orca: take the pairing code from the service log and pair your machine (`orca environment add --name <env> --pairing-code '<code>'`). Pair without a mobile code; a mobile pairing cannot create repos or start workers. Register the repo on the server with `orca repo add --path ~/projects/<name>` and put the printed repo id into `factory.config.json`.
8. `bash 4-verify.sh --gates` as `developer`: checks every tool and login, then runs the full gates on `main`. The server is ready when they are green.
9. Copy the `controller/` bundle that `init` produced to `~/controller` on the server, start the Controller in a terminal there (`claude --dangerously-skip-permissions "<start order from CONTROLLER.md>"` or the Codex equivalent) and confirm the directory trust once.

## Lessons

- Pair Orca over the Tailscale address only; never expose it on the public interface.
- `needrestart` restarting `orca.service` kills every worker. The exception in step 3 is not optional.
- A second project on the same host that starts and stops Docker stacks disturbs browser tests with `ERR_NETWORK_CHANGED`. Count those as environment, rerun, and never touch the other project.
- Keep the SSH config for the server in a file next to the scripts (`server/ssh_config.example`) so every Front-agent script can use `ssh -F`.
- Work data never goes to the server. Demo data and invented secrets only.
