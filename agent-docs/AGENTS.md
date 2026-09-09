<!--
  Delivered by ServiceBay as part of the agent kit (ADR 0014, #2909).

  ONE file serves both agents. Pi reads `AGENTS.md` (or `CLAUDE.md`) from
  `~/.pi/agent/`, from the cwd and from every directory in between, and
  concatenates every match; Claude Code reads `CLAUDE.md`. So a container links
  this file into the places each agent looks — it does not copy it:

      ln -sfn "$SERVICEBAY_AGENT_KIT/agent-docs/AGENTS.md" ~/.pi/agent/AGENTS.md
      ln -sfn "$SERVICEBAY_AGENT_KIT/agent-docs/AGENTS.md" ~/.claude/CLAUDE.md

  A copy would age against the box the moment the kit refreshes, and a second
  hand-written file beside it is the exact failure ADR 0014 exists to prevent.
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

- **Your working tree** is the project checkout you were pointed at. That is the
  only place you write. Commit there; the project's own `CLAUDE.md` /
  `AGENTS.md` (if it has one) governs its conventions and wins over this file
  for anything project-specific.
- **The agent kit** is mounted **read-only** at the path in
  `$SERVICEBAY_AGENT_KIT` (a template picks the mount point; there is no fixed
  one to hard-code). It holds:
  - `assists/` — the assist catalog, the box's binding know-how.
  - `agent-cli/servicebay.mjs` — the CLI below.
  - `agent-docs/AGENTS.md` — this file.
  Do not edit anything under it. It is a git checkout that ServiceBay refreshes
  from `mdopp/servicebay` at boot and hourly, so your edit is gone within the
  hour and reached nobody. To change an assist, the CLI or this file, open a PR
  against that repo.
- **The box's API** answers at `$SERVICEBAY_API_URL`, defaulting to
  `http://host.containers.internal:5888` — the pod-crossing name from ADR 0007.
  Never a LAN IP: a reinstall or a new address breaks a hard-coded one.
- **Your token** is read from the file named by `$SERVICEBAY_MCP_TOKEN_FILE`
  (mode 0400) or, failing that, from `$SERVICEBAY_MCP_TOKEN`. Never put it in a
  command line — `/proc/<pid>/cmdline` is world-readable and this container has
  real user logins on it. The CLI has no `--token` flag on purpose, and passing
  one is a usage error.

## The CLI: reading the box from a shell

Your tools are read/write/edit/bash, so the shell is the access path. Run the
delivered file with plain `node` — it imports `node:` builtins only, so there is
no build step and no `npm install`:

```sh
node "$SERVICEBAY_AGENT_KIT/agent-cli/servicebay.mjs" services
```

Add `--json` to any verb for the raw payload instead of the rendered text.
In the table below, `servicebay` stands for that invocation — some containers
put a wrapper of the same name on `$PATH`; if `servicebay --help` is not found,
spell the `node …` form out.

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
| `servicebay request-install <template> --as <service> --reason <text> [--subdomain <label>] [--mount <host:container[:ro]>] [--port <host:container[/udp]>] [--var <NAME=value>] [--source <name>] [--node <name>]` | ASK the operator to install a template. It files a request and installs nothing; ServiceBay runs the approved plan. Prints a request id. |
| `servicebay request-status <id>` | Read what really happened to your request: waiting, approved, installed, rejected or failed. Exit 4 means still waiting. |

`servicebay --help` prints the same table from the CLI itself. That table is the
contract; a verb or an option that is not in it does not exist.

## What your token can and cannot do

The token is **read-scoped**, and that is the whole story:

- **It can** list and inspect services, read unit files and pod manifests, pull
  logs, read health checks, run the diagnosis (a POST that only inspects), and
  read the assist catalog.
- **It can also hand a narrower copy of itself onward.** `delegate` mints a
  CHILD of the token you are holding and `revoke` takes one back. This is not a
  hole in the read scope: a child is never wider than its parent, so a
  read-scoped token can only ever mint read-scoped children, and a parent may
  revoke only what it minted. These two are gated on lineage rather than on a
  scope — the token you present IS the credential being acted on — so a refusal
  there means your token was rejected as a *parent*, not under-scoped. The
  secret comes back once, on stdout; it is never accepted as an argument.
- **It cannot** install, deploy, update, start, stop or restart anything, edit a
  service's YAML, write files on the host, create or remove proxy routes, or
  read stored secrets. Those need a write-scoped session, which is the
  operator's, not yours.
- **It can ask.** `request-install` files an installation *request*: it names
  the template, the service name you want, the subdomain, the mounts and the
  ports, and it puts that in front of the operator as an approval. It installs
  nothing — not while it waits, and not after the operator approves. ServiceBay
  runs the plan the operator approved; a later edit of the request cannot change
  what runs. If your token is refused, this verb needs the `propose` scope, which
  is the ladder's separate "ask a human" capability, not a write scope. Read the
  outcome with `request-status <id>`, and read it honestly: **exit 4 means the
  operator has not decided and nothing is installed.** Do not report a filed
  request as a finished install.
- When a call is refused, the CLI names **the scope it needed**, not the bare
  status — ServiceBay's REST gate answers a refused Bearer with a flat `401
  Authentication required`, which is useless to act on. A `403` carries the
  server's own `'<scope>' scope required`, relayed verbatim.

So: use the CLI to *observe* (and, where a sub-agent or a project of its own
needs its own narrower credential, to delegate one). If a task needs a change on
the box, ask for it the way the CLI provides — `request-install` for a template
you have finished, and otherwise say what you need and why. Do not go looking for
a side door such as `podman` on a host socket or a second credential lying
around the container.

## How you test

Your change is proved by the project's own gate, not by the box:

- Run the project's declared gate before you commit — typically lint, typecheck
  and its test suite. If you cannot find it, read the repo's `CLAUDE.md` and its
  CI workflow; do not invent a substitute.
- `get_assist("testing-and-ci-gate")` is the standard those gates are written
  to, including what counts as a real test versus a test that cannot fail.
- The CLI's read verbs are how you check the box **after** something is
  deployed — `servicebay health`, `servicebay diagnose`, `servicebay logs <svc>`
  — not how you prove a change is correct. A green box says nothing about code
  that has not shipped yet.
- Nothing you can run in this container proves a change reached the box. That
  proof comes from reading the running box, and only after a rollout.

## How a change rolls out

1. **Commit and push in the project repo.** Conventional Commits.
2. **Releases go through release-please only** — never hand-bump a version, edit
   a changelog, or tag by hand (ADR 0003:
   `get_assist("adr-0003-releases-via-release-please-only")`).
3. **The new image reaches the running service through ServiceBay**, as an
   install/update the operator or a write-scoped session performs. The recipe is
   `get_assist("recipe-roll-new-image-to-running-service")`.
4. **Assists, the CLI and this file are the exception**: they are delivered from
   the repo checkout, not from an image, so a `docs(assists):` commit on `main`
   reaches a running box within the hour with **no release**
   (`get_assist("adr-0014-assist-catalog-delivered-at-runtime")`).

## The assist catalog — read it, do not re-derive it

The catalog is delivered beside this file, at
`$SERVICEBAY_AGENT_KIT/assists/*.md`. Two ways in, same source:

```sh
node "$SERVICEBAY_AGENT_KIT/agent-cli/servicebay.mjs" assists --query backup
node "$SERVICEBAY_AGENT_KIT/agent-cli/servicebay.mjs" assist adr-0007-container-network-isolation-and-carveouts
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
