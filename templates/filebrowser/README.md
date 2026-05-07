# FileBrowser

A web file manager for the shared `/data` volume. Same files Samba and Syncthing see — drop a file via Windows-mount, browse it from the phone via this UI.

## Variables

| Variable | Description | Default |
|---|---|---|
| `FILEBROWSER_PORT` | HTTP port (bound to 127.0.0.1) | `8088` |

## How auth works

FileBrowser is intentionally bound to **localhost only**. The only way in is through the `files.<your-domain>` proxy host in NPM, and that proxy host has an `auth_request` block to Authelia's `/api/verify` endpoint pre-configured (see `proxyConfig.advanced_config` in `variables.json`).

Flow:

1. Browser opens `https://files.<your-domain>`
2. NPM hits Authelia's `/api/verify` first; unauthenticated users get redirected to `https://auth.<your-domain>` for SSO login
3. After SSO success, NPM forwards the request to FileBrowser with `Remote-User: <username>` set
4. FileBrowser is configured with `auth.method=proxy` + `auth.header=Remote-User`, so it trusts that header and creates / reuses an account by that name

This means **no separate FileBrowser login**. SSO once, browse everything. As long as you don't punch a hole through NPM that bypasses Authelia, the localhost binding makes any other path unreachable.

## What the user sees

- Everyone in the `family` group (Authelia rule) can reach the UI
- Each user gets their own FileBrowser account on first visit (auto-created from the SSO header)
- All accounts default to permission `create + rename + modify + delete + share + download` on `/srv`
- Admin promotion is manual: log into FileBrowser as the user → as admin user (the first one to log in) → User Settings → tick "Admin"

## Data Layout

```
{{DATA_DIR}}/file-share/data/   ← the shared volume — same Samba/Syncthing see
{{DATA_DIR}}/filebrowser/
  config/.filebrowser.json      ← pre-seeded by ServiceBay
  db/filebrowser.db             ← user accounts, share links
```

The shared volume is mounted **rw** by FileBrowser. Files created here show up in Samba/Syncthing instantly (and vice-versa).
