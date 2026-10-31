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
