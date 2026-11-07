# Outside-in: how a new feature starts

This rule came out of a day of live tests on the originating project: almost every defect was a misunderstanding about data or logic, not a coding error, and each would have surfaced before a line of code had been written.

New features are built **from the outside in**. Nothing is built until the human has signed off the surface, the data and the logic.

| Stage | What is produced | Tools | Human signs off |
|---|---|---|---|
| **1. Surface** | graphic drafts in a design tool (Figma via its MCP server, or Pencil), then a **front-end fake**: clickable, invented data, a few dummy actions, no real logic | design MCP, the `prototype` skill (UI branch: several structurally different variants on one route, switchable) | "this is how it looks and behaves" |
| **2. Interfaces** | the data in and out, made visible on the fake: sources, tools, fields, states (empty, ambiguous, error), what the system writes | the fake plus a short table in the spec | "this data flows here" |
| **3. Logic** | the flow in words and as a Mermaid diagram: how the system decides in every case | `grilling` / `grill-with-docs` for single questions; `prototype` (logic branch: a one-file state-machine demo) for behaviour that is hard to reason about on paper; `wayfinder` for efforts that span several sessions | "this is how it thinks and acts" |
| **4. Build** | a spec from stages 1–3 (`to-spec`), tickets (`to-tickets`), then the normal flow: Architect, Developer, Tester, wave | the Controller | acceptance on the preview against the fake |

## Who does what

- The **Front agent** runs stages 1–3 with the human during the day.
- The **Controller** builds only what has passed all three stages and is signed off.
- **Defects in behaviour that was already agreed** (for example from the human's live tests) go straight into the build as tickets.

## The design lane: shaping the real surface together

Some things can only be judged in the real product with real files: how a table feels, whether a drag or a zoom is right. Each round through the normal flow takes too long to react to. On one project a feature passed its full test suite and two independent reviews, and the human rejected its look on first sight. The same problems, plus new interactions, then took about an hour with the Front agent changing the code while the human watched.

The design lane turns the order around for one surface: **look first, hardening afterwards.** Only the human opens it, by asking for it, and only for a named scope.

1. **The Front agent builds directly,** on its own branch, one change at a time. This is the only case in which it writes product code, and it ends with the lane.
2. **Tests come later.** Test-first is suspended for the lane's branch, not dropped: writing the tests is the first job of the hardening step. Existing tests are not weakened. If the lane breaks one, the Front agent says so; adjusting a fixture to a new field is allowed and goes in the list of shortcuts.
3. **The human reviews on a separate port,** served from the branch with its own copy of the data, so it collides with neither the preview nor a running app. The Front agent signs the browser in if it can, without putting the sign-in link in the chat.
4. **Every round ends with a short report:** what changed, what the agent could not check itself, and whether a reload or a restart is needed.
5. **Shortcuts are listed as the lane goes,** in the branch's report, so that the hardening step starts from a list.
6. **Decisions stay the human's.** Security, data and new dependencies are asked in the lane, one at a time, and recorded with the quoted answer. Choosing a dependency here does not replace the Architect's check.
7. **The human ends the lane** by saying the surface is right. The branch then goes to the Controller as a hardening ticket: the branch, the list of shortcuts, the quoted decisions and screenshots as the new sign-off. The normal flow follows: tests, Tester, Architect for level 2 and 3, gate, wave.

Nothing changes at the door: **the lane's branch reaches `main` only through the normal review gate.** Hooks stay armed. The lane does not replace stages 2 and 3 where data or logic are still open; it replaces the fake when the real surface is the quicker way to find out.

## Design files reach the workers through the repo

The design tool runs only on the human's machine. At the stage-1 sign-off the Front agent exports from the design MCP into `design/<feature>/` in the repo:

- the layer tree (auto layout, components, variants)
- the design variables (colours, spacing, type)
- generated code for the frames
- screenshots

The spec points there. Workers on the server read the design from git, at night too, and never need design-tool access. A changed design means a new export.

## wayfinder, in short

`wayfinder` (aihero.dev) plans a large effort as a **map of decision tickets** on the project's issue tracker and resolves them one per session. Ticket types: grilling (talk), prototype (build something cheap to react to), research (agent-only reading), task (manual work that unblocks a decision). It plans and does not build. When the map is clear it hands off to `to-spec`, which collapses it into one spec, and `to-tickets`, which slices the spec into implementation tickets.

Without a configured tracker it falls back to local Markdown under `.scratch/`. `setup-matt-pocock-skills` configures the tracker per repo.
