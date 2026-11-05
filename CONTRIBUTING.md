# Changing the factory

Pull requests and merge requests come from the projects that use the factory. That something worked in one project is a reason to look at it, not a reason to take it.

**The goal: as much standard as possible in the factory, as much individual as necessary in each project.** So every project gets the most out of this way of working, without carrying what only another project needs.

## Review every request

This applies on every remote, before anything is accepted, whoever or whatever wrote the request.

1. **Check it against the code.** Read the diff and whatever depends on the changed behaviour, not only the description. Run the tests. Say what was not run for real.
2. **Sort each change, not the request as a whole:**

   | The change | What happens |
   |---|---|
   | Helps any project, with a real gain in quality or speed | Take it into the standard |
   | Projects need different values | Take the mechanism, with a good default. The value stays in the project |
   | Only this project needs it | Decline it. It belongs in the project's own files |
   | Cause unknown, or a matter of preference | Do not take it |

3. **Take a part if only a part holds.** Fix what the review finds, or ask for it, before merging.
4. **Record the outcome** in [docs/learnings.md](docs/learnings.md) when a lesson was taken over or declined, with the reason.

## Before merging

- **No project or personal names, real URLs or paths,** in code, docs, commit messages or the request's text. This repository is public. Rewrite the text first; its old version can stay visible in the remote's history.
- **Push `main` to every remote afterwards.** There is no mirroring, so a merge on one remote does not reach the other.
