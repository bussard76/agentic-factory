# T00: <short title>

Status: draft | needs-info | ready | building | review | passed | integrated | paused
Decided by: <human>, <date>
Origin: <wish, live-test finding, audit, retro, debt item, a ticket brought over from an outside tracker>
Depends on: <tasks or shared interfaces that must exist first, or "nothing">
<!-- Documentation only: yes -- add this line (and `Level: 1` below) ONLY when the result is Markdown or images and nothing else. It is what lets a docs-only task skip its Tester (docsOnly.enabled); it must be there when the work starts and still when the check runs (read from the ticket on the main branch, never from the task branch), as shown, once, outside code blocks and comments: this comment itself does not count. Leave it out otherwise: absent means the full path. A ticket that asks for code, an export, a dependency or a route never carries it, whatever its level. -->
Assessed: <ready as written | ready after gaps closed from context | needs clarification>, <YYYY-MM-DD>

## Goal

<!-- One paragraph from the user's perspective: what works afterwards that does not work now. -->

## Outside-in evidence

- Surface: `design/<feature>/` (signed off <date>) or "not UI-relevant"
- Interfaces: the data in and out, with states (empty, ambiguous, error)
- Logic: the flow in words and the Mermaid diagram (link or inline)

## Architecture impact

Level: 1 | 2 | 3
Modules and boundaries touched. New exports, dependencies, routes, stores or data flows, each named. Level 3 names the ADR.

## Result

Numbered, observable statements of what the system does.

## Observable acceptance

<!-- Numbered checks a Tester can run and a human can try on the preview, each with the sentence to try. -->

## Out of scope

<!-- What this task deliberately does not do, and where that goes instead. -->

## Assessment

<!-- Written by the Front agent's "sharpen the ticket" step, together with the `Assessed:` line above, so that a later reader can see why the ticket was called ready. Keep these five parts:
Outcome: ready as written | ready after gaps closed from context | needs clarification, and the short reason. For the short step (Level 1 and no new interface, data or state) say that this is why it was short.
Sources read: every source consulted, one per line, with file and section (the overall specification, other documents named in `context.sources`, GLOSSARY.md, ADRs, code files).
Closed from context: what a source already answered, each with the source.
Assumptions: every `Assumption: ...` made (it stays until the human confirms it).
New terms and decisions: the GLOSSARY.md terms and ADRs that came out of it. -->

## Open questions

<!-- One list item per question, in exactly this form (the check reads nothing else):
- (blocking) <the question>
  Answer: <the answer, decided by the human, the date>
- (not blocking) <the question>
The marker `(blocking)` or `(not blocking)` comes first. A blocking question is closed by an `Answer:` line under it (indented, or on the next line), by `[x]` in front of it, by striking it through (`~~...~~`), or by moving it to a section "Answered questions". An item without a marker, a line that is no list item and a blocking question without an answer make the ticket not ready to code, and the message names the line. -->

## References

<!-- The sources used: the overall specification (section), the code (files), the glossary terms, ADRs, the original ticket if it came from an outside tracker. -->

## Notes for the Developer

Binding instructions from the Architect's spec review, shared decisions, known flakes to ignore, debt items to name instead of fixing.

## Ready check

Before this ticket becomes `ready`, the Front agent has sharpened it (docs/dev-workflow.md, "Sharpen the ticket") and recorded the outcome in the `Assessed:` line; the Controller takes only a ticket in `ready`. Its requirements and evidence do not conflict with the project's rules or with the Controller's hard rules, for example a required screenshot in git where binaries are forbidden. A conflict found here costs minutes; found at the wave, it can block everything behind it. A task that runs in parallel names each shared interface with exact fields. Demo data shows the normal case: most items look like real use, and special states stay on a few.

Code checks the form only: an assessment, a goal, acceptance criteria as a list, the limits, the level, no unanswered blocking question. It cannot tell a good criterion from a vague one; the Architect, the Tester and the review check against the spec.
