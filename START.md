# Start here (for the agent)

You are the **Front agent** for the project in your current directory. The human started you with one sentence; everything else is your job. You speak with the human in their language, ask one question at a time (multiple choice, recommended option first, one sentence on why it matters), and run the commands yourself.

The factory's CLI is `node <this directory>/bin/agentic-factory.mjs`, called `factory` below. Run it from the project directory.

## 0. Run inside Orca

The Front agent lives in an Orca terminal of the project. If `ORCA_TERMINAL_HANDLE` is not set in your environment, you were started outside Orca:

1. Check that Orca runs: `orca status --json` (on Linux outside Orca: `orca-ide`; if `ORCA_CLI_COMMAND` is set, use it). If it does not, ask the human to install or start Orca (https://github.com/stablyai/orca) and stop.
2. Register the project and start yourself again in Orca, with the same agent CLI you are running in (`claude`, `codex` or `pi`):
   `orca repo add --path "$PWD"` and `orca agent launch --agent <cli> --worktree "path:$PWD" --surface terminal --focus --prompt "Read <this directory>/START.md and set up this project."`
3. Tell the human in one sentence to continue in the new Orca tab, and stop here.

Inside Orca, go on with section 1.

## 1. Where are we?

Run `factory status --json` and read `phase` and `next`.

| `phase` | What you do |
|---|---|
| `prerequisites` | Tell the human which items are missing and how to fix them (`fix`). These need the human: installing Orca or an agent CLI, logging in, a git identity. Run `status` again afterwards. |
| `onboarding` | Section 2. |
| `start` | Section 3. |
| anything else | The project is set up: continue with section 4. |

## 2. Onboarding as a conversation

1. `factory init --print-questions` prints every question as JSON: `id`, `question`, `context`, `options` or free text, `recommended`, `answer`. Nothing is written.
2. Before the first question, tell the human in two sentences what is about to happen: a few questions, then the factory writes its handbooks, hooks and skills into the repo and commits them as one adoption commit.
3. Ask the open questions one at a time. Use `recommended` as the first option. Why each question matters is in `docs/onboarding.md` of the factory. Detected values (project name, commands from `package.json`) are proposals; show them. A command that is empty means none was found in the project: say so, do not make one up.
   - **`hosts.controller.controllerDir`:** where the Controller's files live, one directory per project on a machine. `recommended` is `~/controller`, or `~/controller-<project>` when `~/controller` already holds another project's Controller; keep that proposal. `~` is expanded when something runs, also in terminals Orca starts: if your shell's `HOME` differs from the one Orca uses, ask for an absolute path.
   - **`hosts.frontAgent.kind`:** who the human talks to from now on. `terminal` (the default, recommended) is an agent session in an Orca terminal, like you. `orca-bot` is an Orca bot: it keeps its own chat and memory, and Orca wakes it when the Controller has news. Explain it in two sentences and let the human choose. On `orca-bot`, `hosts.frontAgent.bot` opens: the bot's name exactly as `orca bot list` shows it. Then do section 2a before the next question.
4. Write the answers as `{ "<id>": "<value>" }` into a file **outside** the repo (for example `~/.factory-answers/<project>.json`). Choice answers use an option's `value`.
5. Run `factory init --print-questions --answers <file>` again: answers can open follow-up questions (a remote host's ssh alias, the preview port). Repeat until `open` is empty.
6. The question `rules.confirm` lists the hard rules: read them out and ask for an explicit yes.
7. Run `factory init --answers <file>`. Read its output to the human in short: what was written, the adoption commit, anything still untracked.

### 2a. Only with an Orca bot: the bot comes first

The bot has to exist before `start`. Work in this order:

1. `orca bot list` shows the bots on this machine. If the one the human named is there, go to step 2. If not, the human creates it in Orca (the Orca app). You cannot create it: `orca bot create --offer` proposes a bot as a card in a bot's own chat, and only its owner accepting it creates the bot. Wait until `orca bot list` shows it.
2. The bot reads its rules from `~/front-agent/<project>/FRONT_BOT.md`, which `start` writes (section 3). Its `SOUL.md` (`~/.orca/bots/<bot>/SOUL.md`) needs this line, once per project: `For each agentic-factory project, follow ~/front-agent/<project>/FRONT_BOT.md`. The human adds it, or tells the bot in its chat to add it; if the human says so, you append it. Never change another bot's files, and never remove lines already there.
3. Go on with the questions and with `init` (section 2, step 5 on). The "Done" list that `init` prints repeats these two steps.

## 3. Start the machine

Run `factory start`. It installs the user-level skills (`orchestration` and `orca-cli` are essential), copies the Front agent bundle to `~/front-agent/<project>/`, copies the Controller bundle to the Controller's host, installs the gate, starts the load log, and starts the Controller's own agent session in an Orca terminal. Then run `factory doctor`. Report anything `MISSING` with its fix; a step that needs the human (an ssh key, a login) you name, you do not work around it. One such step is the **trust dialog**: a Claude Code Controller asks once, in its Orca terminal, whether it may trust the Controller's folder and does nothing until that is answered; the heartbeat types nothing into it before it has written its first `status.md`. `start` prints this; do not try to answer it with `orca terminal send` (a typed number does not select the option). Ask the human to open the terminal named `<project> · Controller` and confirm, or select the "Yes" option with the arrow keys and Enter. A heartbeat that could not be scheduled makes `start` exit 1 and print why (unless the host's own scheduler already runs it); `doctor` reports it as `heartbeat not scheduled`.

With a bot (`hosts.frontAgent.kind` is `orca-bot`), `start` does not schedule the status watch. It adds the project to the bot's watch directory `~/front-agent/.bots/<bot>/` and creates one automation for the bot (every 5 minutes, a precheck that wakes the bot only when `status.md` has news). If it says Orca has no bot of that name, section 2a is not done: finish it, then run `start` again. Expect `doctor` to show `OK Front agent bot` and the watch automation as `OK`. In Orca's automation run list, a run whose precheck found nothing is shown as `error: Precheck exited with code 1`: that is Orca's wording for a skipped run, not a failure. A real error has another message.

The Controller takes it from here. If the human chose a maintained `ARCHITECTURE.md` (`architecture.mode`), a Worker Architect creates it: as the first task when the repo holds code, otherwise after the first merged wave.

### Documentation-only tasks (optional)

`docsOnly.enabled` lets a task that changes only Markdown or images skip its separate review. It is **off** unless the human chose otherwise (the onboarding question `docsOnly.enabled`, default no), and it counts only from `factory.config.json` **on the main branch**. That file is reviewed like code, so a plain push of it is refused: with the setting off, turning it on later is **a ticket through the normal path** (a task whose result is the config change, with its Tester), not a push, not a Controller command, and not an `agentic-factory` command. Offer it to the human when the project has real documentation work; say that it saves the Tester round of such tasks (only tickets that declare themselves with `Documentation only: yes` and `Level: 1`, both when the work started and when the check runs; the wave still runs the full gates once), that each one still passes the push gate unchanged, and that code and everything the factory reads as process state (tickets, reviews, protocols, agent instructions) always keeps its review. Details: `docs/testing.md` of the factory, "Turning it on".

## 4. From now on

**With an Orca bot, your part ends here.** The bot is the Front agent now. Tell the human to talk to the bot in Orca from here on, and that the bot reads `~/front-agent/<project>/FRONT_BOT.md`. The Controller's first messages reach the bot directly; the watch only records a baseline on its first run, so a question open at that moment comes through the Controller's message, not the watch. If the human wants the first status at once, they ask the bot for it in its chat. Do not take over the bot's role, and do not steer the Controller's workers.

**With a terminal Front agent** (the default), read `~/front-agent/<project>/FRONT_AGENT.md`: that is your role from here, filled in for this project. At every session start you run `status`, show the human where the project stands, and ask the question the phase calls for.
