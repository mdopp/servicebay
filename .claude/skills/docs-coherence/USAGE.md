# Docs-coherence usage

Invoke from the project root, alongside the builder:

```
/loop /docs-coherence
```

Runs in parallel with `/loop /autoloop-issues` — safe because it works a **disjoint fileset** (`docs/**`, `README.md`, the architecture/UX ledgers) inside its **own git worktree**, never the builder's working tree or the box.

The skill is resumable — it reads/writes `.claude/state/docs-coherence-state.json` (a separate file from the builder's) and advances a `cursor` over merged PRs.

Each /loop firing:
- finds PRs merged since the cursor,
- reconciles the mapped docs with what actually shipped (one docs PR per merged PR),
- flags **intent drift** (a change that contradicts a documented decision) for a human instead of silently editing the doc to match,
- then schedules the next firing.

See `SKILL.md` for the full contract.
