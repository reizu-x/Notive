---
description: Promote Dev to main after asking for confirmation
agent: build
---

Promote the remote `Dev` branch to `main`, but only after the user explicitly confirms.

Follow these steps exactly:

1. Run `git fetch origin`.
2. Summarize what would change:
   - `git log --oneline origin/main..origin/Dev`
   - `git diff --stat origin/main origin/Dev`
   If `git log --oneline origin/main..origin/Dev` is empty, report that `main` is already up to date with `Dev` and stop.
3. Use the `question` tool to ask the user whether to promote `origin/Dev` to `origin/main`, with options "Yes, update main" and "No, cancel". Do not proceed without an explicit selection.
4. If and only if the user chooses "Yes, update main", run `git push origin origin/Dev:main`. If the push is rejected as non-fast-forward, stop and report that `main` has diverged and needs manual reconciliation.
5. Report the outcome concisely.
