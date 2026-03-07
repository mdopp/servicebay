# Vaultwarden

Lightweight Bitwarden-compatible password manager server.

## Variables

- `PORT`: Host port for the web interface (default: 8222)
- `DOMAIN`: Public URL for the vault (e.g., `https://vault.example.com`)
- `SIGNUPS_ALLOWED`: Allow new user registrations (`true` or `false`, default: `true`)
- `DATA_DIR`: Base data directory (from template settings)

## Notes

- Data is persisted at `${DATA_DIR}/vaultwarden/`
- For production use, place behind a reverse proxy with SSL
- Disable signups after creating your account by setting `SIGNUPS_ALLOWED=false`
