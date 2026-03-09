# AdGuard Home

Network-wide ad and tracker blocking DNS server.

## Ports

| Port | Protocol | Purpose |
|------|----------|---------|
| 53 | TCP/UDP | DNS server |
| 3000 | TCP | Initial setup wizard |
| 8083 | TCP | Admin web interface (after setup) |

## Setup

After first start, open `http://<host>:3000` to run the setup wizard.
During setup, change the admin interface port from 80 to **8083** to avoid conflicts with other services.
Once setup is complete, the admin UI will be available at `http://<host>:8083`.

## Usage

Point your devices or router DNS to `<host>:53` to enable ad blocking for the entire network.
