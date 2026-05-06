# AdGuard Home

Network-wide ad and tracker blocking DNS server.

## Ports

| Port | Protocol | Purpose |
|------|----------|---------|
| 53 | TCP/UDP | DNS server |
| 8083 | TCP | Admin web interface (default; configurable via `ADGUARD_ADMIN_PORT`) |

## Variables

| Variable | Description | Default |
|---|---|---|
| `ADGUARD_ADMIN_PORT` | Admin web UI port | `8083` |
| `ADGUARD_ADMIN_USER` | Admin username | `admin` |
| `ADGUARD_ADMIN_PASSWORD` | Admin password | — (auto-generated, shown in install log) |

## Setup

ServiceBay pre-seeds `AdGuardHome.yaml` with the configured ports and admin user, so AdGuard's first-run setup wizard is **skipped entirely**. After deploy:

1. Open `http://<host>:<ADGUARD_ADMIN_PORT>` (default `:8083`)
2. Log in with the credentials shown in the install log

The auto-generated password is shown once during install — copy it into your password manager.

## Port 53 on the host

AdGuard binds DNS to `0.0.0.0:53`. On Fedora CoreOS the systemd-resolved stub listener occupies that port by default. The ServiceBay Butane config disables the stub (`DNSStubListener=no`) and repoints `/etc/resolv.conf` at `/run/systemd/resolve/resolv.conf` so name resolution keeps working on the host.

## Usage

Point your devices or router DNS to `<host>:53` to enable ad blocking for the entire network.
