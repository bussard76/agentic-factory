# Debt register

Every known debt, with origin, risk, proposal and size. Reviews add debt candidates here by category; the hardening phase works them off by category. Roughly a fifth of capacity goes into paying debt down.

**Release condition:** the categories `security`, `load`, `tests` and `edge-case` must be `done` or carry `accepted by <human> (<date>): <reason>` in the Status column before a release is approved. Open items in these categories block the release gate.

| ID | Category | Origin | Risk | Proposal | Size | Status |
|---|---|---|---|---|---|---|
| D01 | tests | <task or review> | <what can go wrong> | <one line> | S/M/L | open |

Categories: `tests`, `edge-case`, `security`, `load`, `style`, `tooling`, `flake`.

`ponytail-debt` lists every `shortcut:` comment in the code as a second source; reconcile it into this table during the hardening phase.
