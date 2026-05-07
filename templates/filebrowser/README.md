# FileBrowser

Family-facing web file manager for the shared `/data` volume. Same files Samba and Syncthing see — drop a file via the admin's Windows-mount, browse it from any family member's phone via this UI.

> 🧭 **Design split**: in the full-stack, **FileBrowser is for the family**, **Samba is for the admin only**. The shared volume is the same, but each family member gets their own SSO session here while Samba stays single-user. ServiceBay pre-promotes the LLDAP `admin` to FileBrowser admin during install (see `FILEBROWSER_ADMIN_USER`) so there's a working admin from the first login.

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
- The user named in `FILEBROWSER_ADMIN_USER` (default `admin`) is **pre-promoted** to FB admin by ServiceBay's post-install step, so on their first SSO login they immediately have the admin panel for managing other users + shares.

## Data Layout

```
{{DATA_DIR}}/file-share/data/   ← the shared volume — same Samba/Syncthing see
{{DATA_DIR}}/filebrowser/
  config/.filebrowser.json      ← pre-seeded by ServiceBay
  db/filebrowser.db             ← user accounts, share links
```

The shared volume is mounted **rw** by FileBrowser. Files created here show up in Samba/Syncthing instantly (and vice-versa).
