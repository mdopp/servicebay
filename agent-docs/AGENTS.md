<!--
  Delivered by ServiceBay as part of the agent kit (ADR 0014, #2909).

  ONE file serves both agents. Pi reads `AGENTS.md` (or `CLAUDE.md`) from
  `~/.pi/agent/`, from the cwd and from every directory in between, and
  concatenates every match; Claude Code reads `CLAUDE.md`. So a container links
  this file into the places each agent looks — it does not copy it:

      ln -sfn "$SERVICEBAY_AGENT_KIT/agent-docs/AGENTS.md" ~/.pi/agent/AGENTS.md
      ln -sfn "$SERVICEBAY_AGENT_KIT/agent-docs/AGENTS.md" ~/.claude/CLAUDE.md

  A container that instead GENERATES its copy at pod start (pi-web does) buys
  itself a prefix of its own and pays for it: the copy is a snapshot, so a fix
  landing here reaches that container only at its next restart, while the kit
  itself refreshes hourly. Either mechanism is fine; a hand-written second file
  beside it is not — that is the exact failure ADR 0014 exists to prevent.
  This file is maintained in `mdopp/servicebay` at `agent-docs/AGENTS.md` and
  nowhere else. It is the template for containers ON the box — it is NOT the
  instructions for the ServiceBay repo itself (that is the repo's `CLAUDE.md`).
-->

# Working on a ServiceBay box

You are an agent in a container that ServiceBay installed and runs. This file
says where you are, what you can reach, how you check your work, and how a
change actually gets onto the box. Everything it does not cover is in the
**assist catalog**, which is delivered next to this file — read that rather than
guessing, and rather than re-deriving what is already decided.

## Where you start

- **Your working tree** is the project checkout you were pointed at — the only
  place you write. Its own `CLAUDE.md` / `AGENTS.md` wins over this file for
  anything project-specific.
- **The agent kit** is mounted read-only at `$SERVICEBAY_AGENT_KIT` (the
  template picks the path; there is no fixed one to hard-code): `assists/` (the
  catalog, the box's binding know-how), `agent-cli/servicebay.mjs` (the CLI
  below), `agent-docs/AGENTS.md` (this file). ServiceBay refreshes it from
  `mdopp/servicebay` at boot and hourly, so an edit there is gone within the
  hour and reached nobody — change any of it by PR against that repo.
- **The box's API** answers at `$SERVICEBAY_API_URL`, default
  `http://host.containers.internal:5888` — the pod-crossing name from ADR 0007.
  Never a LAN IP: a reinstall or a new address breaks a hard-coded one.
- **Your token** comes from the file named by `$SERVICEBAY_MCP_TOKEN_FILE` (a
  file only your user may read, 0600 or tighter), else `$SERVICEBAY_MCP_TOKEN`.
  Never on a command line — `/proc/<pid>/cmdline` is world-readable and this
  container has real user logins. The CLI has no `--token` flag on purpose;
  passing one is a usage error.

## The CLI: reading the box from a shell

The shell is the access path. **Use `servicebay` from `$PATH`.** Most containers
put a wrapper there, and the wrapper is not cosmetic: it finds the token file
this container was given and points the CLI at it. The bare file is dependency-
free JS, so it also runs under plain `node` —

```sh
servicebay services                                        # the way that works
node "$SERVICEBAY_AGENT_KIT/agent-cli/servicebay.mjs" services   # no token, exits 3
```

— but invoked that way it has no credential and answers *"no ServiceBay API
token found"*, exit 3. If you must use the bare form, set
`SERVICEBAY_MCP_TOKEN_FILE` yourself first; your container's own `AGENTS.md`
names the file.

Add `--json` to any verb for the raw payload instead of the rendered text —
and pipe it through a filter (`jq`, `node -e`, `grep`) rather than reading it
whole: `services --json` and `service <name> --json` are tens of kilobytes, and
one unfiltered dump costs more of your context than the rest of this file.

<!-- verb-table: pinned against agent-cli/servicebay.mjs by tests/scripts/agents_md_template.test.ts — a new verb fails the suite until it is listed here -->

| Command | What it does |
| --- | --- |
| `servicebay services [--node <name>]` | List the services installed on the box, with their active state. |
| `servicebay service <name> [--node <name>]` | Show one service: its unit file, its pod manifest and its config. |
| `servicebay diagnose [--node <name>]` | Run the box diagnosis and print the probe results. |
| `servicebay logs <service> [--node <name>]` | Fetch a service's unit and podman logs. |
| `servicebay health` | Read the configured health checks and their last result. |
| `servicebay assists [--query <text>] [--kind <kind>]` | List the assist catalog — ADRs, recipes, guides, footguns. |
| `servicebay assist <id>` | Print one assist in full, frontmatter and body. |
| `servicebay delegate <name> [--scopes read,lifecycle] [--expires <iso8601>]` | Mint a child of YOUR token, never wider than it. Prints the child secret once. |
| `servicebay revoke <id>` | Revoke one child token you delegated. |
| `servicebay whoami` | Say what the token you hold is — name, scopes, parent, expiry — **and which credential answered** (the file or the env var). The answer to "what may I do", from the server, not from this file. |
| `servicebay progress` | Show the install job running right now: phase, current item, what it has deployed so far. |
| `servicebay images <service> [--node <name>]` | Is what this service pulls actually published, pulled and current? Names WHICH kind of "no": `not-published` means nothing was ever pushed under that tag. Exit 7 when something is wrong. |
| `servicebay update <service> [--mode fresh] [--node <name>]` | Move a service onto the image its registry publishes and force-recreate its containers, so it cannot come back up on the cached one. Prints before/after digests per image. **CHANGES the box**; needs `lifecycle`. `--mode fresh` deletes the local image first — the fallback for a stuck one. Exit 6 means the pull did not take. |
| `servicebay install <template> [--var <NAME=value>] [--source <name>] [--node <name>]` | Install a template the full wizard way (variables, secrets, subdomain, proxy, SSO wiring). The service is named after the template. **CHANGES the box**; needs `mutate`. Additive always — there is no wipe. |
| `servicebay request-remove <service> --reason <text> [--node <name>]` | ASK the operator to remove a service. It removes nothing; approving moves it to the trash (restorable for seven days), never a purge. Prints an approval id. |
| `servicebay approval <id>` | Read what the operator decided about a request you filed. Exit 4 still waiting, 5 rejected **or approved-but-the-action-failed**. |
| `servicebay request-install <template> --as <service> --reason <text> [--subdomain <label>] [--mount <host:container[:ro]>] [--port <host:container[/udp]>] [--var <NAME=value>] [--source <name>] [--node <name>]` | ASK the operator to install a template. It files a request and installs nothing; ServiceBay runs the approved plan. Prints a request id. |
| `servicebay request-status <id>` | Read what really happened to your request: waiting, approved, installed, rejected or failed. Exit 4 means still waiting. |

`servicebay --help` prints the same table from the CLI itself. That table is the
contract; a verb or an option that is not in it does not exist.

## What your token can and cannot do

Your token carries the scopes it was minted with, and this file cannot tell you
which — boxes differ, and an operator may widen a token at any time. Do not
assume; ask: `servicebay whoami` answers with name, scopes, parent and expiry,
from the server, the only thing that knows. A refused call names the scope it needed,
and the two refusals mean different things: **403** is "your token is fine, it
just lacks this tier" and carries the tier's name; **401** is "this credential
did not verify at all" — revoked, expired, or not a token. So **a refusal is an
answer, never a dead end**: on a 403, ask for the scope it named; on a 401, your
token is the problem, not your scope.

- **`read`** — list and inspect services, unit files, pod manifests, logs,
  health checks, the diagnosis (a POST that only inspects), the assist catalog.
- **`propose`** — `request-install` files an installation *request* (template,
  service name, subdomain, mounts, ports) as an approval in front of the
  operator (ADR 0013, `servicebay assist adr-0013-clients-request-their-own-access`).
  It installs nothing — not while it waits, not after approval; ServiceBay runs
  the plan the operator approved, and a later edit of the request cannot change
  it. Read the outcome with `request-status <id>`: **exit 4 means the operator
  has not decided and nothing is installed.** Never report a filed request as a
  finished install.
- **`lifecycle`** — `update` moves a service onto a new image and restarts it.
- **`mutate`** — `install` installs a template outright, no approval in front
  of it. A token that has these is not asking permission any more: it is the
  operator's reach, lent out. What you created is yours to move; what was
  already on the box is not, and goes through `request-install` even when the
  scope would let you skip that (ADR 0017,
  `servicebay assist adr-0017-the-agent-cli-may-change-the-box-when-the-token-may`).
- **Nothing here removes anything by itself.** There is no verb that deletes,
  wipes, resets or opens a shell, and no scope makes one appear: `destroy`,
  `reboot` and `exec` run only after an operator approves. If you were told an
  existing service "can go", **file it** — `request-remove <service> --reason
  "…"` — and carry on with what does not depend on it. Redeploying the service
  with a placeholder to free its port is not a workaround, it is a second
  outage: whatever it serves goes dark, and the port stays owned either way.
- **Lineage, not scope** — `delegate` mints a CHILD of the token you hold
  (never wider than its parent) and `revoke` takes one back; the secret comes
  back once, on stdout, never as an argument. A refusal there means your token
  was rejected as a *parent*, not under-scoped.
- **Never conclude from silence.** "I have no write access" is a claim about
  your token, and its only honest source is a refusal you actually received.
  Saying it without one has stalled work here for hours while the scope was
  there the whole time.
- **Check which credential answered before you trust a narrow one.** Pointing
  `SERVICEBAY_MCP_TOKEN_FILE` at a smaller token is how you deliberately put a
  change out of your own reach — but something between your shell and the CLI
  can rewrite that variable. `whoami` prints a `source` line saying which file
  or variable the token actually came from. If it is not the one you set, you
  are running wider than you think, and a call you expected to be refused will
  go through.

Observe and act through the CLI, within the scopes `whoami` shows you. **The
verb table is the whole of what you may do from a shell.** A job it has no verb
for is not an invitation to hand-roll an HTTP call — it is either a
`request-install`, or something to report and leave alone; if a verb is missing
that should exist, say which one and why, and it gets built (that is what #2990
was). What stays out of bounds is any credential used for a purpose it was not
handed to you for: `podman` on a host socket, a token found lying in a file, a
git credential pointed at anything but git.

**A token never reaches a command line — and this is about `exec`, not about
quoting style.** A shell expands every substitution *before* it hands the
arguments to the program, so all three of these put the secret into argv, where
`/proc/<pid>/cmdline` shows it to every login on this container:

```sh
curl -H "Authorization: Bearer $(cat /path/to/token)" ...    # obviously
TOKEN=$(cat /path/to/token); curl -H "Authorization: Bearer $TOKEN" ...   # identical after expansion
curl -H "Authorization: Bearer ${TOKEN}" ...                 # still identical
```

Assigning to a variable first hides it from you, not from the process table.
The safe shape is the one the CLI already is: **the process that makes the
request reads the token file itself**, which is why `servicebay` has no
`--token` flag. If you catch yourself writing `$TOKEN` inside a `curl`
argument, that is the moment to stop — a session on this box did it 35 times in
one evening and left a box credential in its transcript. And do not mint a
`delegate` child "to look around": it is a live credential the moment it is
printed, and a probe you forget to `revoke` stays valid until someone else
notices it.


## How you test

Your change is proved by the project's own gate, not by the box:

- Run the project's declared gate before you commit — typically lint, typecheck
  and its test suite. If you cannot find it, read the repo's `CLAUDE.md` and its
  CI workflow; do not invent a substitute.
- **When a step fails twice, read its log before you touch anything else** —
  `gh run view <id> --log-failed` for CI, `servicebay logs <svc>` on the box. A
  step rewritten without reading why it failed is a guess with a commit
  attached; four guesses in a row is how a session spent an afternoon on a
  missing `contents: read`.
- **Three failed attempts at the same goal is the limit. Then you stop and say
  so** — in your answer, to the operator, naming what you tried, what the logs
  said, and what you believe is missing
  (`servicebay assist guide-when-to-ask-and-how-to-put-a-decision-to-the-operator`).
  Stopping means stopping: not a fourth approach, not a workaround through
  another service, another tool or the host filesystem. An agent that keeps
  going is not being thorough — it is spending someone else's box on a guess,
  and every workaround it leaves behind is something a human has to find later.
  A reported blocker is a finished piece of work; forty attempts are not.
- `servicebay assist testing-and-ci-gate` is the standard those gates are written
  to, including what counts as a real test versus a test that cannot fail.
- The CLI's read verbs are how you check the box **after** something is
  deployed — `servicebay health`, `servicebay diagnose`, `servicebay logs <svc>`
  — not how you prove a change is correct. A green box says nothing about code
  that has not shipped yet.
- Nothing you can run in this container proves a change reached the box
  *before* a rollout. Afterwards you can and should check it from here: the
  read verbs answer about the running box, not about your checkout, and a
  container carrying a browser can load the deployed page and read its console.
  What you may not do is call a green gate a rollout.

## You cannot build an image here — and what to do instead

There is no `podman`, no `docker`, no `buildah` and no socket in this container,
and that is deliberate (ADR 0007). **The only path from code to a running
service is: push → CI builds and publishes an image → the box pulls it.** There
is no second path, and every attempt to invent one has ended badly: a tarball in
an environment variable, base64 through a 15 000-character command line, files
written flat onto a host mount the target container cannot read. If you catch
yourself designing one of those, the release path is broken and *that* is the
thing to fix.

Two commands tell you which half is broken, and they are the whole diagnosis:

```sh
node "$SERVICEBAY_AGENT_KIT/agent-cli/release-check.mjs"   # the repo half
servicebay images <service>                                 # the box half
```

- **`release-check`** asks GitHub: is there a workflow that builds an image,
  does it declare `contents: read` **and** `packages: write`, did its last run
  pass? The first of those is the one that bites silently — on a **private**
  repo a workflow without `contents: read` fails checkout with *"Repository not
  found"*, which reads like a typo in the repo name and is not.
- **`servicebay images <service>`** asks the box: does the registry actually
  serve the tag this service pulls? `not-published` means nothing was ever
  pushed under it — no amount of restarting, reinstalling or redeploying will
  change that. `unreachable` means retry; `unauthorized` means the package is
  private to this node.

A green build and an unpublished tag look identical from inside this container
until you ask both. Ask both, then report what they said.

## How a change rolls out

1. **Commit and push in the project repo.** Conventional Commits. The git
   credential is already configured (`credential.helper store`); a plain
   `git push` works. Never put a token into a remote URL — `git remote -v`
   prints it, and so does `.git/config` to anyone who reads the checkout. The
   same holds for any command line: see the `exec` note under **What your
   token can and cannot do**.
2. **Replacing what a domain serves means updating the service that owns it.**
   If `<name>.<domain>` already points at a service, that service gets the new
   image (`servicebay assist recipe-roll-new-image-to-running-service`) — you do
   not deploy a second service beside it, and you do not rewrite the old one's
   definition to free its port. A service that is to go away is removed by the
   operator (destroy tier): say so in your report and carry on with what you own.
3. **Releases go through release-please only** — never hand-bump a version, edit
   a changelog, or tag by hand (ADR 0003:
   `servicebay assist adr-0003-releases-via-release-please-only`).
4. **The new image reaches the running service through ServiceBay** — and not
   through the tool whose name suggests it. For a service that is **already
   installed**, `install_template` re-pulls the image and leaves the running
   container on the old layers, and a plain restart reuses the cached image.
   Installing again therefore reports success and changes nothing, however many
   times you do it. From a shell the call that moves it is **`servicebay update
   <service>`**: it re-pulls and force-recreates the containers, and prints
   `before` / `registry` / `after` digests per image, so you can see whether
   anything moved instead of assuming it. It exits non-zero when the pull did
   not take — retry that one with `--mode fresh`, which drops the local image
   first. Ask `servicebay images <service>` beforehand if you want to know
   whether there is anything new to move at all. (`manage_service` with
   `action: "force-update"` is the same route seen from MCP, for clients that
   speak it — the companion app, automation. From a shell you do not need it.)
   The full recipe, including rollback anchors, is
   `servicebay assist recipe-roll-new-image-to-running-service`.
5. **Assists, the CLI and this file are the exception**: they are delivered from
   the repo checkout, not from an image, so a `docs(assists):` commit on `main`
   reaches a running box within the hour with **no release**
   (`servicebay assist adr-0014-assist-catalog-delivered-at-runtime`).

## The assist catalog — read it, do not re-derive it

The catalog is delivered beside this file, at
`$SERVICEBAY_AGENT_KIT/assists/*.md`. Two ways in, same source:

```sh
servicebay assists --query backup
servicebay assist adr-0007-container-network-isolation-and-carveouts
ls "$SERVICEBAY_AGENT_KIT/assists"
```

Start with `servicebay-overview` for how the box is put together, and read the
`adr-*` entries before deciding anything about auth, networking, backups,
installs, tokens, releases or the runtime — the surprise you are about to "fix"
is usually one of those decisions. Each entry's `whenToUse` line is written for
the situation you are in, so skimming those is the cheapest way to find the
right one.

If the catalog refuses to answer, that is an **outage, not an empty catalog**:
delivery failed or the checkout went stale, and the message says which. Report
it; do not work around it from memory.

Where this file and the catalog disagree, **this file is the stale one**. Say so
and fix it in `mdopp/servicebay`.
