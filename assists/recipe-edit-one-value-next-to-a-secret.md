---
title: Changing one value in a service definition that also holds a secret
whenToUse: A deployed service needs a different value in its rendered definition - a pinned image tag, a port, a flag - and the same file also carries a password or token. Also when a change has been sitting undone because "there is a secret in that file".
kind: recipe
tags: [secret, in-place-edit, sed, diff, image-tag, pinned-tag, rendered-definition, redaction, unblock]
---

# Editing one line next to a secret

## The trap

A service's rendered definition mixes plain configuration with injected
secrets. When one plain value has to change, the presence of a secret two lines
away reads as "do not touch this file" - so the change gets deferred to the
operator, and the service keeps running a known-stale build for days.

That instinct inverts the real risk. Editing one line in place is safe. What is
**not** safe is the move that feels safer: reading the whole file out, changing
it in your context, and writing it back.

## Why the round-trip is the actual hazard

Tool transports redact secrets on the way out. `get_service_files` and a chat
round-trip both hand you `<redacted>` where the password was. Write that content
back and you have replaced a live credential with the literal string
`<redacted>` - the service fails on its next start, and the only copy of the
secret is gone. This has a name: **never round-trip a file that holds a secret.**

An in-place `sed` never materialises the secret anywhere. It is the safe option,
not the daring one.

## Which file holds the value

Services are Quadlet units under the service user's
`~/.config/containers/systemd/` (`packages/backend/src/lib/dirs.ts`). Where the
value lives depends on the unit kind - `get_service_files` reports it as
`quadletKind`:

- **`kube`** - `<service>.kube` carries `Yaml=<service>.yml`; the image, ports
  and env live in that **`.yml`**, and that is the file you edit.
- **`container`** / **`pod`** - there is no separate yaml. The value is in the
  unit file itself.

Resolve this before you write a `sed`; the two layouts put the same line in
different files.

## The flow

1. **Verify the new value exists first.** For an image tag, confirm the tag is
   actually in the registry before editing anything:
   `skopeo list-tags docker://<image>` or `podman pull <image>:<tag>`. A git tag
   `v0.3.1` does **not** imply a registry tag `v0.3.1` - see the precedent below.

2. **Back up.** `cp -a <file> <file>.bak`

3. **Anchor the substitution on the full old value**, never a loose pattern:

   ```sh
   sed -i 's|image: ghcr.io/you/app:sha-OLD|image: ghcr.io/you/app:sha-NEW|' "$F"
   ```

   A pattern like `s|sha-.*|sha-NEW|` can match a second line you did not read.

4. **Prove it with `diff`.** This is the whole safety argument:

   ```sh
   diff "$F.bak" "$F"
   ```

   The only acceptable output is the single line you meant to change. Anything
   else: `cp -a "$F.bak" "$F"` and stop.

5. **Restart through the lifecycle tool**, not by hand:
   `manage_service(action="restart", name="<service>")`. For a `:latest` service
   that needs a re-pull instead of a tag change, this recipe is the wrong one -
   use `recipe-roll-new-image-to-running-service`.

6. **Confirm the running image**, don't assume:
   `list_containers` - or `podman ps --format "{{.Names}} {{.Image}}"`. The
   configured value and the running one are different questions, and only the
   running container answers the second.

## Verification pitfall

Do not try to prove the secret lines are untouched with

```sh
sudo cmp <(sudo grep -E 'TOKEN|PASSWORD' "$F.bak") <(sudo grep -E 'TOKEN|PASSWORD' "$F")
```

`sudo` cannot read the parent shell's `/dev/fd/*`, so this reports a difference
that does not exist and you will talk yourself out of a correct change. The
`diff` in step 4 already proves it - a one-line diff means every other line,
secrets included, is byte-identical.

## Caveat: the rendered file is downstream

This edits the **rendered** definition. If the value comes from a template
placeholder or a stored install variable, a later `install_template` re-renders
and reverts it. Check whether the value is a stored variable; if it is, follow
up by changing it there too, or the next repair silently rolls back.

## Precedent

`daggerheart-chronik` was pinned to `sha-1c0898f`. Its release `v0.3.1` existed
as a git tag, and the owning session reported "v0.3.1 is built in the registry"
- but `build-images.yml` carried a `paths:` filter on its `push: tags: ['v*']`
trigger, so no release tag ever produced an image. The registry only ever held
`sha-97f24cb`, the same commit. The session sat on the update for days because a
Discord token lived in the same file. The actual work was one `sed`, one `diff`,
one restart.

## Not this recipe

- Changing the secret itself -> `recipe-rotate-a-service-secret`
- Picking up a new `:latest` build -> `recipe-roll-new-image-to-running-service`
- Reading a value out of a definition -> `get_service_files` / `read_file`
  (`footgun-exec-last-resort`: reach for a read tool before an exec)
