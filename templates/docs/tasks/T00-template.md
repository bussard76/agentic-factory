# T00: <short title>

Status: draft | ready | building | review | passed | integrated | paused
Decided by: <human>, <date>
Origin: <wish, live-test finding, audit, retro, debt item>
Depends on: <tasks or shared interfaces that must exist first, or "nothing">

## Goal

One paragraph from the user's perspective: what works afterwards that does not work now.

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

Numbered checks a Tester can run and a human can try on the preview, each with the sentence to try.

## Out of scope

What this task deliberately does not do, and where that goes instead.

## Notes for the Developer

Binding instructions from the Architect's spec review, shared decisions, known flakes to ignore, debt items to name instead of fixing.

## Ready check

Before this ticket becomes `ready`: its requirements and evidence do not conflict with the project's rules or with the Controller's hard rules, for example a required screenshot in git where binaries are forbidden. A conflict found here costs minutes; found at the wave, it can block everything behind it. A task that runs in parallel names each shared interface with exact fields. Demo data shows the normal case: most items look like real use, and special states stay on a few.
