# ServiceBay — working notes for assistants

ServiceBay is the control plane that installs and manages self-hosted services
on a home box (templates → Podman kube pods, NPM reverse proxy, Authelia SSO).
The management app is `packages/{frontend,backend,api-client}`; services ship as
**templates** under `templates/` (not as code in `packages/`).

Orientation:
- `docs/ARCHITECTURE_INVARIANTS.md` — invariants; run `npm run check:arch && npm run lint` before architecture changes.
- `docs/TEMPLATE_AUTHORING.md` + `templates/CLAUDE.md` — the template contract (auto-loads under `templates/`).
- `docs/UX_DECISIONS.md` — locked UX decisions; don't re-litigate.

## Capturing reusable knowledge (assists)

When you work out something non-trivial — a recipe, a sequence of steps, a
sharp-edged gotcha, a config incantation — **stop and ask: will this be needed
again?** If yes, don't leave it buried in a session or a single PR. Abstract it
one level (strip the one-off specifics) and add it to the **assist catalog** so
the next agent/operator finds it via the `list_assists` / `get_assist` MCP tools.

- Assists live in `assists/<id>.md` (shipped in the image) or dropped at runtime
  under `DATA_DIR/local-assists/` (no release needed). Loader:
  `packages/backend/src/lib/assists/catalog.ts`.
- Each is markdown with frontmatter: `title`, `whenToUse` (one line — this drives
  self-selection), `kind` (`guide | recipe | template | checklist | footgun |
  snippet`), `tags`.
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
