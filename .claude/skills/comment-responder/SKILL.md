---
name: comment-responder
description: Draft honest, kind replies to real (human, non-AI) comments on GitHub issues/PRs, looking for how the contributor's input can create project value. Verifies technical claims against the live box/code before drafting, and writes in plain "what happens" language rather than jargon. Shows each draft for the user to confirm, then posts it with the AI marker. Use when the user wants to answer external comments, clear the autoloop `awaiting_user[]` list, or asks to "reply to the comment on #N".
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

## Step 2.5 — Verify against the real system before you answer (don't guess)

If the comment makes a technical claim, or your reply would assert how the system behaves, **check the actual state first** — don't reason it out from how things "should" work. The dev env and the running box diverge, and a confident wrong answer to a careful contributor costs more trust than taking ten minutes to look.

- Read the **code** that's actually in play, and — when the claim is about runtime/permissions/config/networking — inspect the **live box** (SSH via `build/fcos/servicebay-ssh/id_rsa`, or the `mcp__servicebay__*` tools: `exec_command`, `get_logs`, `diagnose`, `list_containers`). `reference_mcp_servicebay_access` has the connection paths and the reinstall gotchas.
- Let the findings **change the answer**, including your own earlier framing. The #1311 case below is the cautionary tale: the obvious "set `UMASK=002` on the writers" fix was *wrong* — inspecting the box showed those services run as root with no umask knob, which flipped the recommendation to a default ACL. We'd have shipped bad advice without looking.
- When the investigation overturns or sharpens what the **issue/PR body** says, fold the corrected facts back into the body (via `gh api -X PATCH repos/mdopp/servicebay/issues/<N> -F body=@file`) so the next reader starts from the truth — then reference it in the reply.

## Step 3 — Draft the reply

Style (reuse `feedback_concise_answers`):

- **Honest.** Acknowledge what's right. Be straight about disagreement or what we can't/won't do, and why. Never pretend a wrong point is right to be polite.
- **Kind.** Warm, respectful, genuinely glad they engaged — never condescending or curt, even to spam.
- **Value-seeking.** Where their input helps, say how, and take the next step (offer to file a follow-up, accept the correction, adopt the suggestion).
- **Plain-language — explain what *happens*, not a list of flags.** Tell the story: what the system actually does, why, and what it means, in terms a smart reader follows without decoding jargon. Reach for a term like `setgid` or `default ACL` only when the reader needs the exact word, and say what it does in plain words right next to it. A good test: it should read like how you'd explain it out loud to a colleague, not like a man-page excerpt. (This is the lesson from the #1311 thread — the dense flag-soup draft was rejected for the narrative version.)
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

The comment gave a shared-group + setgid + `umask 0002` model, a correct nitpick that "`0644` is the resulting file mode, not the umask," and a self-promo link to a browser umask calculator (`?ref=github`).

The first instinct was to agree wholesale — the umask plan looked right and matched the issue. **Step 2.5 caught it:** inspecting the live box showed the file-share services run as **container-root with umask `0022` and no `UMASK` knob**, so "set `UMASK=002` on the writers" was simply not available. That flipped the answer — a **default ACL** on the folder (not umask) becomes the mechanism — and the corrected facts were folded back into the issue body before replying.

The reply that landed — note it explains *what happens* in plain language, not a flag list:

> Thanks for pushing on this — it sent me to actually look at the box, which was worth doing. Your core instinct is right: put the writers in one shared group and let group permissions do the work. And your wording nitpick is right too — `0644` is the mode a new file ends up with, not the umask.
>
> But the real setup changed the picture. The apps sharing this folder don't run as a normal user with a umask we can set — they run as root inside their containers, with no umask knob to turn. What decides who "owns" a file on disk is how each container's user maps to the host, not the app. On this machine they all map to the same host user, so they get along today; the trouble only starts when a different stack (the Hermes gateway) maps to a different host identity and can't write the folder.
>
> So the group idea is the backbone, but two things carry it: we let the **folder** enforce sharing — a default ACL that says "every new file here is read/write for the shared group, no matter who created it" — and any outside stack that needs to write gets added to that group through its container setup. Net effect: the folder becomes genuinely co-editable, and we retire the current blunt "world-writable" workaround for a real access model.
>
> `<!-- sb-ai-comment -->`
> `🤖 _AI-generated, acting for @mdopp._`

Note: honest (credits the instinct, accepts the nitpick, openly corrects course), grounded (the reply only exists because the box was checked), plain-language (the story of what happens, jargon only where the reader needs it), and neutral on the linked tool — no endorsement, no snark.
