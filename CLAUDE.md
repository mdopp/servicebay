# ServiceBay — working notes for assistants

ServiceBay is the control plane that installs and manages self-hosted services
on a home box (templates → Podman kube pods, NPM reverse proxy, Authelia SSO).
The management app is `packages/{frontend,backend,api-client}`, plus the two
sandboxed one-shot workers `packages/{backup-worker,disk-import-worker}`;
services ship as **templates** under `templates/` (not as code in `packages/`).

Orientation:
- **`assists/adr-*.md` — the architecture decisions (ADRs). They live in the assist
  catalog, not in `docs/`** (#2607), so read them with `list_assists` /
  `get_assist("adr-0007-…")` — or straight off disk. **Look there before deciding
  anything about auth, networking, backups, installs, tokens, releases or the
  runtime**; the weirdness you are about to "fix" is usually one of these.
  `docs/adr/` holds signposts only. Index: `docs/adr/README.md`.
- `docs/ARCHITECTURE_INVARIANTS.md` — invariants; run `npm run check:arch && npm run lint` before architecture changes.
- `docs/TEMPLATE_AUTHORING.md` + `templates/CLAUDE.md` — the template contract (auto-loads under `templates/`).
- `docs/UX_DECISIONS.md` — locked UX decisions; don't re-litigate.

## Deterministic execution → scripts; LLMs coordinate + evaluate

**Deterministic steps belong in a good script, not in prose an LLM re-interprets each run.** Prose invariants are advisory (an LLM skips them — that wedged the seal builders + stranded box-verify); in a script they're structural (a `finally` that flips back to `:latest`, a hard-capped poll that returns, a fixed `--no-verify`) — and cheaper, zero-variance. Reserve the LLM for **judgment**: what to verify, why a red happened + how to fix, triage/planning, writing the code. So: **scripts run the mechanics; LLMs coordinate + evaluate.** Prefer the least-privileged tool; `exec_command` / `container_exec` are a last resort — check read tools first (`list_containers`, `get_logs`, `get_system_info`, `read_file`, …), which don't trip a destructive-op alert + auto-snapshot. House pattern: `tsx scripts/*.ts`, `node:` only, no new dep (e.g. `scripts/check-diff-coverage.ts`, `autoloop-seal.ts`); shrink the playbook to "call the script, then judge X."

## Workflow: issues first, then the autoloop

Capture work as **GitHub issues first**, then let the **autoloop-issues** pipeline
work them — issues are the unit of work, not ad-hoc edits.

- File an issue before starting non-trivial work. Body = symptom + goal + repro +
  starting-point files; an acceptance/goal section is good. Leave out the
  fix-plan — the "how" evolves in the PR.
- Then burn the backlog down via `autoloop-issues` (Planner → Builder →
  Box-Verify through a shared work queue). Don't hand-edit the tree while an
  autoloop batch is active (use a worktree or file an issue).
- Releases go through **release-please only** — never bump versions by hand
  (ADR 0003).

## Capturing reusable knowledge (assists)

When you work out something non-trivial — a recipe, a sequence of steps, a
sharp-edged gotcha, a config incantation — **stop and ask: will this be needed
again?** If yes, don't leave it buried in a session or a single PR. Abstract it
one level (strip the one-off specifics) and add it to the **assist catalog** so
the next agent/operator finds it via the `list_assists` / `get_assist` MCP tools.

- Assists live in `assists/<id>.md`. **The catalog is delivered at runtime, not
  baked into the image** (ADR 0014, #2701): the box pulls this repo's `assists/`
  tree onto disk at boot and hourly, so `docs(assists):` is the right commit type
  and a contribution takes effect **without a release**. There is exactly one
  source — do not re-add a `COPY assists/` to the Dockerfile, and do not add a
  second read path. If delivery fails, `get_assist`/`list_assists` report the
  failure; they never fall back to an older copy. Loader:
  `packages/backend/src/lib/assists/catalog.ts`; delivery:
  `packages/backend/src/lib/assists/delivery.ts`.
- `DATA_DIR/local-assists/` is **not** a delivery path — it carries only
  admin-approved editor overrides and landed proposals, and an override that
  shadows a repo entry is flagged in `list_assists` and `list_assist_drift`.
- **Proof of a catalog change is on the box, never in-process.** `get_assist(<the
  new id>)` answering on a running box is the claim; a local loader test proves
  the loader only — that substitution is what #2701 was.
- Each is markdown with frontmatter: `title`, `whenToUse` (one line — this drives
  self-selection), `kind` (`guide | recipe | adr | template | checklist | footgun
  | snippet`), `tags`.
- Overviews of the platform itself are assists too — see `servicebay-overview`
  and `solaris-overview`, and the `new-service-architecture` ADR-style
  recommendations. A client should read those instead of re-deriving structure.
- **Architecture decisions are assists too, and this is where they live** (#2607):
  `assists/adr-NNNN-<slug>.md`, `kind: adr`, Status · Context · Decision ·
  Consequences. A new decision gets the next free number (see
  `docs/adr/README.md` for the index) and a `whenToUse` line written for the
  *situation* someone will be in when they need it — "you are about to add a
  reconciler…", not "this is the ADR about reconcilers". A vague `whenToUse` is
  how 13 decisions ended up unfindable in the first place.
- **Abstract, don't transcribe.** Turn "how I fixed tor.dopp.cloud today" into
  "how to add a public SSO subdomain, and the acme footgun to avoid." Reference
  files/functions by path, not by a specific deployment's values.
- Prefer the assist catalog for *task know-how*; keep architecture invariants in
  `docs/`, and the template contract in `docs/TEMPLATE_AUTHORING.md`.

The same instinct applies to **templates**: if a service you built for one box is
generally useful, generalize it (configurable variables, no hard-coded host
specifics) and offer it as a template others can install.

## Secret hygiene — never commit keys or passwords

Committed files (templates, assists, tests, fixtures, docs) must contain **no
real secrets**: no private keys, API tokens, passwords, or `sb_` box tokens.

- Templates express secrets as `type: "secret"` variables in `variables.json`.
  The wizard generates/injects the value at deploy time; the template never
  carries a literal. Placeholders (`{{VAR}}`) are fine — concrete values are not.
- Assists describe *how* to obtain/rotate a credential; they never embed one.
  When you abstract a session into an assist, scrub tokens, hostnames-with-auth,
  and any value you pulled from the live box.
- A build-time scan (`tests/backend/assist_consistency.test.ts`) fails the suite
  on known secret signatures in `assists/` and `templates/`. It is a backstop,
  not a licence to be careless — assume it won't catch every shape.


## Solaris System Architecture & Naming Directives
- See `docs/SOLARIS_SYSTEM_DIRECTIVES.md` for binding guidelines.
- Stack identity is **Solaris** (`mdopp/solaris`: `solaris-chat`,
  `solaris-gatekeeper`, `solaris-whisper`, `solaris-tts`). Legacy `hermes` path
  references are deprecated.
- **No hard-coded IPs in cross-service references** — so a reinstall or a new
  LAN address doesn't break the wiring. The *name* to use is set by ADR 0007,
  not by this section: containers inside one pod share a netns and use
  `127.0.0.1:<port>`; anything crossing a service boundary uses
  `host.containers.internal:<port>`. Never `{{LAN_IP}}`.
