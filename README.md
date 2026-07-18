# ServiceBay

> **A private cloud for your family. With an AI that runs it.**

ServiceBay turns a USB stick + a spare PC into a self-hosted personal cloud — twelve services pre-wired with single sign-on, automatic backups, and TLS — plus an MCP endpoint so Claude (or any LLM) can administer the box for you in plain English.

Underneath it's a web-first management plane for Podman Quadlet on Fedora CoreOS. But the point isn't that. The point is: your photos, passwords, calendar, files, audiobooks, music, smart home, and ad-blocker all live on one machine you own, and you don't need to become a sysadmin to keep it running.

## Highlights

The things worth bragging about — each true against the code, each with a detail doc in **[docs/FEATURES.md](docs/FEATURES.md)**:

- **It heals itself** — wipe the secrets on a clean install and passwords re-sync in place (no lockout); ServiceBay's own crash leaves a readable breadcrumb *outside* the container; GPU survives every redeploy with no silent CPU fallback.
- **Diagnostics that fix** — 26 probes, each with a one-click action instead of a stack trace; SSO/cert/DNS/proxy caught before the family notices.
- **A living network map** — Internet→Gateway→Service drawn from proxy routes, port-forwards, declared deps, observed TCP flows, *and* edges inferred from container env; no service floats disconnected; ego-focus drill-down (ELK + React Flow).
- **SSO with no hand-wiring** — deploy a service and its OIDC client self-registers; redeploy auth and existing clients survive (merge, not overwrite); family portal with self-service access requests.
- **Backup that survives a reinstall** — per-service manifest on the NAS; reinstall auto-restores config (no re-typing passwords); secrets stripped from archives.
- **Drivable by an agent** — 62 scoped MCP tools (deploy templates, create proxy routes, jailed `write_file`) + a time-limited token request/approve flow.
- **Extend without code** — templates are Git repos (YAML + Mustache + Python); migrations let them evolve on live installs.
- **Shipped like a product** — release-image smoke gate, lockfile CI gate, local typecheck gate, and box-verify on `:dev` — a broken build never becomes `:latest`.

## What you get out of the box

| Replaces | With |
|---|---|
| Google Photos / iCloud | **Immich** — photo & video library with face recognition |
| Audible | **Audiobookshelf** — audiobook server with phone & tablet apps |
| Spotify | **Navidrome** — music server (Subsonic-compatible) |
| Bitwarden cloud / 1Password | **Vaultwarden** — password manager |
| Dropbox / Google Drive | **Syncthing** + **Filebrowser** + **Samba** |
| Google Calendar / Contacts | **Radicale** (CalDAV / CardDAV) |
| Pi-hole / NextDNS | **AdGuard Home** — network-wide ad blocking + custom DNS |
| Home Assistant Cloud | **Home Assistant** + **Z-Wave-JS** + **Matter Server** + voice |
| One login per service | **Authelia + LLDAP** — SSO across everything |
| A wall of separate certs | **Nginx Proxy Manager** — TLS + Let's Encrypt per subdomain |
| **A part-time sysadmin job** | **An LLM that uses MCP to keep the lights on** |

## Why it's different

### An LLM-native admin surface

The control plane is exposed as 62 MCP tools. Hand Claude (or Claude Desktop, or any MCP client) a scoped API token and you can administer the box in plain English:

- *"Why is photos.dopp.cloud loading slow?"* → Claude pulls Immich logs, spots the OOM, restarts the container.
- *"Add a Jellyfin instance for the kids."* → Claude lists templates, deploys it, creates the Authelia OIDC client, configures the proxy subdomain.
- *"My mom should have access to Vaultwarden and Immich, nothing else."* → Claude creates the LLDAP user and assigns the right groups.
- *"Anything broken?"* → Claude runs the self-test, summarizes the warnings, fixes the easy ones, asks before the risky ones.
- *"Back everything up before I do something dumb."* → `run_backup`, then "go ahead."

You describe what you want; the LLM translates it into ServiceBay calls. No more "what's a Quadlet file?"

The tool list is **scoped to the token** — `tools/list` advertises only what a token could actually call, in a deterministic, prompt-cache-safe order. Beyond driving the box, an agent can pull curated build standards (`get_service_standards`) and **feed knowledge back**: `propose_learning` submits an assist into ServiceBay's catalog, which an admin approves (behind a hard secret scan) — a central knowledge base that the agents improve.

### A network map that shows what's actually happening

ServiceBay maintains a real-time **Digital Twin** of every container, service, proxy route, port, and DNS rewrite on your network — and renders it as an interactive [topology graph](docs/screenshots/network-map.png). At a glance:

- Every service, color-coded by live health.
- Every NPM proxy route drawn as an edge to its actual target.
- Every published port, every verified public domain.
- Internet → router → host → container chain shown end-to-end.
- Dangling routes (a `proxy_pass` that points at nothing managed) surfaced as ghost nodes so you find them before your users do.

Click any node → live logs, restart, view-config, or jump to the matching service page. When something breaks and you don't know which piece is at fault — DNS? proxy? service? container? — the map shows you exactly where the chain falls apart.

### A catalog you can extend

The twelve stacks that ship are just YAML + Mustache templates in a Git repo. Want to run something we don't ship?

1. Write a `template.yml` (Kubernetes Pod manifest) and `variables.json` (operator-tunable inputs).
2. Push them to a GitHub repo.
3. Add the repo as a registry under **Settings → Integrations → Template Registries**.

Your stack now shows up in the install wizard alongside the built-ins, with the same SSO + DNS + reverse-proxy + auto-backup wiring. No code changes to ServiceBay required.

When a template needs to evolve, the layout supports it without breaking running installs: bump `servicebay.schema-version` in `template.yml`, add a `## v{N}` section to `CHANGELOG.md` (the wizard surfaces it before deploy), and drop a `migrations/v{N-1}-to-v{N}.py` script alongside if data needs to move. The full contract lives in [docs/TEMPLATE_AUTHORING.md](docs/TEMPLATE_AUTHORING.md).

Or skip the manual step entirely: *"Claude, write a template for Paperless-ngx based on the Vaultwarden one and deploy it."* The LLM has full read access to the existing templates as references and can submit the new one through the same MCP path.

### Safety rails so the AI can't trash your data

Letting an LLM into your homelab is irresponsible without guardrails. ServiceBay has:

- **Scoped API tokens** — `read` / `lifecycle` / `mutate` / `destroy`, plus an off-ladder `propose` (submit-knowledge-only). Per-client, revocable, hashed-at-rest.
- **`exec_command` denylist** — `rm -rf /`, `mkfs`, `dd of=/dev/sd*`, partition editors, fork bombs — refused unless explicitly enabled.
- **Auto-snapshot before destructive ops** — every `delete_service` / `update_config` / `exec_command` triggers a labelled `pre-mutation:` system backup. One-click rewind.
- **Soft-delete trash** — `delete_service` moves files to a 7-day trash bucket; restore in one click.
- **Audit log** — every tool call recorded with timestamp, caller, args (sensitive fields redacted), outcome.
- **Email on destructive ops** — if a token is exfiltrated, you find out in minutes.

Combined: any stolen token has a bounded blast radius; everything is reversible; you'll always know what happened.

## Screenshots

| Dashboard | Network Map | Health |
|-----------|------------|--------|
| ![Dashboard](docs/screenshots/dashboard.png) | ![Network Map](docs/screenshots/network-map.png) | ![Health](docs/screenshots/monitoring.png) |

**`sb` — the lifecycle launcher (terminal):**

| Launcher (phase-aware menu) | Express setup (guided happy path) |
|---|---|
| ![sb menu](docs/screenshots/sb-menu.png) | ![sb express](docs/screenshots/sb-express.png) |

The menu tracks where the box is in its lifecycle (no ISO → booting → installing → up) and offers only the actions that apply; **Express** chains the whole happy path — build + flash the USB, boot, watch, then sign in, restore config from the NAS, and install your stacks.

## Quick Start

ServiceBay runs on **Fedora CoreOS** as an immutable, self-updating appliance. The whole lifecycle is driven by **`sb`** — a single static Go/Bubble Tea binary (no repo clone needed). See the [Installation Guide](docs/INSTALLATION.md) for the full build pipeline, first-boot sequence, and configuration options.

```bash
# Install the lifecycle TUI (auto-detects your OS/arch from GitHub releases):
curl -fsSL https://raw.githubusercontent.com/mdopp/servicebay/main/install-sb.sh | sh

sb          # launcher — Express setup, or pick an individual leg
sb build    # just the ISO build + USB-flash wizard
```

**`sb` is the one tool for the whole journey.** Its **Express setup** chains the happy path end-to-end: build + flash the install USB → boot the box → watch the install → sign in → **restore your config from the NAS** → install your stacks. Each leg is also available standalone from the menu (build, watch, edit-config, install stacks, backups, channel switch). Developers working from a clone can run it with `go run ./tools/sb`.

The install USB provisions the entire system: OS, networking, ServiceBay container, SSH keys, and an admin account. First boot drops you into a wizard (web) — or `sb` Express (terminal) — that deploys the stacks you select, sets up SSO, configures DNS + proxy routes, restores any per-service config backups from the FritzBox NAS, and hands you the credentials manifest as a Bitwarden-importable CSV.

## Technical features

- **Service Dashboard** — manage Quadlet services in `~/.config/containers/systemd/` with real-time status, three-state health indicator (healthy / transitioning / failed)
- **Network Visualization** — interactive topology of services, containers, proxy routes, ports, and DNS rewrites; click any node for actions
- **Health Checks** — HTTP / ping / podman / systemd / agent checks with history graphs and email alerts; per-service checks auto-created on stack deploy
- **Template Registries** — deploy from one or more GitHub-hosted catalogs; built-ins are just templates themselves
- **YAML Editor** — Monaco-powered create/edit with validation, version history, and hot-reload
- **Web Terminal** — SSH into any managed node from the browser
- **Multi-Node** — manage containers across machines via SSH from a single UI
- **System Backups** — snapshot all configs across nodes (auto-snapshot before destructive ops); restore in seconds
- **Auto-Updates** — keep ServiceBay and containers current automatically; email notification on each new release
- **Self-Diagnose** — built-in probe battery with one-click fixes for every detected problem: restart crash-looping containers, retry stale NPM auth, delete dangling proxy routes, configure FritzBox DNS via TR-064, re-run failed seed scripts, free disk space, and more. Auto-runs at end of install.
- **Mobile-Responsive** — full UI with dedicated mobile navigation
- **MCP Server** — 62 MCP tools, scoped tokens, audit log, soft-delete, auto-snapshot, exec denylist, destructive-op email alerts

## Architecture

ServiceBay uses a **Reactive Digital Twin** model: a Python agent on each managed node pushes state changes over SSH to the backend, which maintains an in-memory replica. The UI reads from this store — no polling.

```
Browser → Next.js + Socket.IO → SSH Connection Pool → Python Agent → Podman CLI
```

For the full architecture, data flow diagrams, and API reference, see **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

## Installation

| Method | Use Case | Guide |
|--------|----------|-------|
| **Fedora CoreOS** | Production, immutable OS | [docs/INSTALLATION.md](docs/INSTALLATION.md) |

The installer creates a rootless Podman container managed by systemd on an immutable Fedora CoreOS base. See the [Installation Guide](docs/INSTALLATION.md) for details.

## Reverse Proxy

If running behind Nginx, you **must** enable WebSockets and disable buffering:

```nginx
location / {
    proxy_pass http://localhost:3000;
    proxy_buffering off;
    proxy_cache off;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

For Nginx Proxy Manager: enable **Websockets Support**, then add `proxy_buffering off; proxy_cache off; proxy_read_timeout 86400;` in the Advanced tab.

## Development

Two paths, depending on what you're working on:

```bash
git clone https://github.com/mdopp/servicebay.git && cd servicebay
npm install

# Fast iteration (hot-reload, no container)
npm run dev                              # http://localhost:3000

# Production-shape container (matches CI image, builds on host
# to avoid OOM in WSL/podman; expects sshd reachable on the host)
scripts/dev-container.sh up              # http://localhost:3000
scripts/dev-container.sh logs            # follow
scripts/dev-container.sh restart         # rebuild + restart
scripts/dev-container.sh reset           # nukes ~/.servicebay-dev/

npm test           # vitest
npm run lint       # eslint
```

`dev-container.sh` generates and persists a bootstrap admin password
(written once to `~/.servicebay-dev/.bootstrap-password`) and an SSH
keypair that the in-container agent uses to manage the host.

## Programmatic API & MCP

Every UI action has an HTTP equivalent under `/api/`. For LLM-driven
automation, ServiceBay also exposes a [Model Context Protocol](https://modelcontextprotocol.io)
server at `/mcp` (session-cookie auth — same as the UI), publishing tools
across services, containers, proxy, backups, health checks, and config:
read paths like `list_nodes`, `list_services`, `get_logs`,
`get_network_graph`, `get_health_checks`, …, and write paths like
`manage_service` (start/stop/restart), `update_service_yaml`,
`add_proxy_route`/`remove_proxy_route`, `run_backup`/`restore_backup`,
`create_health_check`/`run_check_now`, `get_config`/`update_config`,
`exec_command`. Sensitive fields (`auth.passwordHash`, `oidc.clientSecret`,
SMTP/NPM passwords) are redacted in `get_config` and write-allowlisted in
`update_config`. Knowledge paths let an agent read curated build standards
(`get_service_standards`) and propose an assist back into the catalog
(`propose_learning`, off-ladder `propose` scope) for admin approval.
`tools/list` is scope-filtered — a token only sees the tools it can call.

**Setup walk-through with `claude mcp add` syntax, env-var refresh, and
troubleshooting:** [docs/MCP.md](docs/MCP.md). The same instructions are
also linked from **Settings → Integrations → MCP Server** in the running UI.

## Troubleshooting

<details>
<summary><b>Port 3000 is already in use</b></summary>

Edit `~/.config/containers/systemd/servicebay.container`, change the port mapping, then:
```bash
systemctl --user daemon-reload && systemctl --user restart servicebay
```
</details>

<details>
<summary><b>SSH connection refused / Cannot authenticate</b></summary>

- Verify credentials in Settings → Nodes
- Test manually: `ssh -i /mnt/data/servicebay/ssh/id_rsa user@host`
- Ensure the public key is in the remote `~/.ssh/authorized_keys`
</details>

<details>
<summary><b>Service won't start / keeps restarting</b></summary>

```bash
journalctl --user -u servicename.kube -f   # check logs
podman ps -a                                 # check container state
```
</details>

<details>
<summary><b>Live logs / terminal not working</b></summary>

Your reverse proxy must support WebSockets and have `proxy_buffering off`. See [Reverse Proxy](#reverse-proxy) above.
</details>

<details>
<summary><b>How do I manage a remote VPS?</b></summary>

Settings → Add Node → `ssh://username@your-vps-ip`. Copy your ServiceBay SSH public key to the VPS's `~/.ssh/authorized_keys`.
</details>

<details>
<summary><b>How do I update ServiceBay?</b></summary>

Settings → System → Check for Updates → Update. Your service containers are independent — they update based on their image tags.
</details>

## Documentation

| Document | Content |
|----------|---------|
| [docs/FEATURES.md](docs/FEATURES.md) | The feature index — what's worth bragging about, with a detail doc per area under [docs/features/](docs/features/) |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System design, data flow, API reference, testing strategy, frontend design |
| [docs/ARCHITECTURE_INVARIANTS.md](docs/ARCHITECTURE_INVARIANTS.md) | CI-enforced invariants — what the build refuses to merge |
| [docs/UX_PHILOSOPHY.md](docs/UX_PHILOSOPHY.md) | Self-heal first / diagnose with structured actions / hide expert knobs |
| [docs/UX_DECISIONS.md](docs/UX_DECISIONS.md) | Specific load-bearing decisions — read before "fixing" something weird |
| [docs/INSTALLATION.md](docs/INSTALLATION.md) | Build pipeline, startup procedure, first-boot sequence, system modifications |
| [docs/MCP.md](docs/MCP.md) | Connect Claude Code / Claude Desktop / any MCP client to your ServiceBay instance |
| [CHANGELOG.md](CHANGELOG.md) | Version history |

## Comparison

| Feature | ServiceBay | Portainer | Cockpit | Docker Desktop |
|---------|------------|-----------|---------|----------------|
| Podman Quadlet native | **Yes** | Via API | Systemd | No |
| Multi-Node (SSH) | **Yes** | Agent-based | Cockpit instances | Local only |
| Network Visualization | **Yes** | No | No | No |
| Health Checks | **Yes** | Basic | System metrics | Container logs |
| Template Registry | **Yes** | Built-in | Limited | Docker Compose |
| Open Source | **Yes** | Yes + paid | Yes | Free for personal |

## Contributing

- **Quickstart for the three first-PR extension points** (MCP tool, capability handler, diagnose probe): [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md).
- **Bug Reports**: [Open an issue](https://github.com/mdopp/servicebay/issues)
- **Discussions**: [GitHub Discussions](https://github.com/mdopp/servicebay/discussions)
- **Releases**: [Conventional Commits](https://www.conventionalcommits.org/) + Release Please. `feat:` → minor, `fix:` → patch, `feat!:` → major.

## License

[MIT License](LICENSE)
