# design/

Design exports, one folder per feature: `design/<feature>/`.

The design tool runs only on the human's machine. At the stage-1 sign-off of the outside-in process the Front agent exports from the design MCP:

- `tree.md` or `tree.json`: the layer tree with auto layout, components and variants
- `variables.json`: colours, spacing and type tokens
- `code/`: generated code for the frames (reference only, rewritten properly when built)
- `screens/`: screenshots, light and dark where applicable
- `README.md`: which frames were signed off, when, and what the fake demonstrates

Workers read the design from git and never need design-tool access. A changed design means a new export and a note in the task.
