# comment-responder — usage

Draft and post honest, kind replies to real (human, non-AI) comments on GitHub issues/PRs.

- `/comment-responder <N>` — handle issue or PR `#N`.
- `/comment-responder sweep` — walk all open issues/PRs + the autoloop `awaiting_user[]` list.

Every reply is shown for your confirmation before posting and is tagged with the AI marker
(`<!-- sb-ai-comment -->`). The autoloop parks tickets with an unaddressed external comment on
`state.awaiting_user[]` and never replies itself — this skill is where those get answered.
