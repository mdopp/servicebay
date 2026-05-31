---
name: comment-responder
description: Draft honest, kind replies to real (human, non-AI) comments on GitHub issues/PRs, looking for how the contributor's input can create project value. Shows each draft for the user to confirm, then posts it with the AI marker. Use when the user wants to answer external comments, clear the autoloop `awaiting_user[]` list, or asks to "reply to the comment on #N".
---

# Comment responder

Real people comment on our issues and PRs. This skill answers them **honestly, kindly, and with genuine effort to find how their input creates value for the project** — then lets the user confirm before anything is posted. The autoloop parks tickets with an unaddressed external comment on `state.awaiting_user[]` and never replies itself; this skill is where those replies get written.

The user's recurring rules in `~/.claude/projects/-home-mdopp-servicebay/memory/MEMORY.md` override anything here. Relevant: `feedback_ai_comment_marker` (the marker), `feedback_concise_answers` (writing style), `reference_gh_pr_edit_broken` (commenting is fine; only `gh pr edit` is broken).

## Invocation

- `/comment-responder <N>` — handle issue or PR `#N`.
- `/comment-responder sweep` — walk every open issue/PR plus `state.awaiting_user[]` and handle each one with an unaddressed external comment.

## Step 1 — Find the comments that need a reply

For each target issue/PR:

```bash
gh api repos/mdopp/servicebay/issues/<N>/comments \
  --jq '.[] | {id, user: .user.login, type: .user.type, created: .created_at, body}'
```

A comment needs a reply when **all** hold:

1. `user.login != "mdopp"` (not the owner — the owner is the user, who doesn't get replies from us).
2. `user.type != "Bot"`.
3. The body does **not** contain `<!-- sb-ai-comment -->` (it isn't one of our AI comments).
4. **No owner comment exists chronologically after it** — i.e. the external person had the last word and is waiting on us. If an `mdopp`-authored comment (human or AI-marked) already follows it, the thread is addressed; skip.

If nothing matches, say so and stop. For `sweep`, collect all matches across issues/PRs.

## Step 2 — Understand before you draft

Don't reply to the surface. For each thread:

- Read the **full comment thread**, the **issue/PR body**, and any **files it references** (the issue's starting-point files, the PR diff). A good reply engages the actual technical substance.
- Decide what the comment really is: a correct technical point, a partial point, a misunderstanding, a feature ask, a question, promotional/spam — or some mix (the #1311 example below is advice + a self-promo link).
- Find the **value angle**: does it surface a real follow-up issue worth filing? A correction we should accept? A suggestion that fits (or clearly doesn't, and why)? Look for it honestly — don't manufacture it.

## Step 3 — Draft the reply

Style (reuse `feedback_concise_answers`):

- **Honest.** Acknowledge what's right. Be straight about disagreement or what we can't/won't do, and why. Never pretend a wrong point is right to be polite.
- **Kind.** Warm, respectful, genuinely glad they engaged — never condescending or curt, even to spam.
- **Value-seeking.** Where their input helps, say how, and take the next step (offer to file a follow-up, accept the correction, adopt the suggestion).
- **Short and sharp.** No fillwords, no generic AI boilerplate, no "thanks for your valuable feedback" padding. Lead with substance.
- **No false endorsement.** If a comment links a product/tool, stay neutral — don't promote it, don't be snarky about it.

End every draft with the marker (`feedback_ai_comment_marker`):

```
<!-- sb-ai-comment -->
🤖 _AI-generated, acting for @mdopp._
```

## Step 4 — Confirm, then post

Show each drafted reply to the user (with a link to the comment it answers). The user approves, edits, or skips it. **Never post without confirmation.** On approval:

```bash
gh issue comment <N> --body-file <draft>   # issues
gh pr comment <N> --body-file <draft>      # PRs
```

(`gh ... comment` works; only `gh pr edit` is broken on this repo — `reference_gh_pr_edit_broken`.) Use `--body-file` so the marker's HTML comment and newlines survive intact.

After posting, the last word is ours, so the autoloop's exclusion filter clears the ticket from `awaiting_user[]` on its next run — no manual state edit needed. If the user wants it worked immediately, mention that the loop will now pick it up.

## Worked example — #1311 (`wenghuiming1987`)

The comment gave a solid shared-group + setgid + `umask 0002` model (which **matches the fix the issue itself proposes**), a correct nitpick that "`0644` is the resulting file mode, not the umask," and a self-promo link to a browser umask calculator (`?ref=github`). A good reply:

> Agreed — and that's exactly the model this issue is moving toward: shared gid, `setgid` on the share dir, and `UMASK=002` on the writers so every consumer (including OSCAR's Hermes at uid 10000) can join the gid and read-write cleanly. You're right that `0644` is the resulting mode rather than the umask; the title's loose there. The real test is the cross-stack writer, which we can only confirm on a live multi-service box — that's why it's parked for a hands-on session rather than guessed in the dev env. Thanks for the careful read.
>
> `<!-- sb-ai-comment -->`
> `🤖 _AI-generated, acting for @mdopp._`

Note: honest (confirms the model, accepts the nitpick, states the real blocker), kind, value-seeking, and neutral on the linked tool — no endorsement, no snark.
