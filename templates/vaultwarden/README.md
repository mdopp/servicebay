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

## SSO (Authelia)

To enable OIDC login via Authelia, add this client to your Authelia `configuration.yml`:

```yaml
      - client_id: 'vaultwarden'
        client_name: 'Vaultwarden'
        client_secret: '$plaintext$<your-secret>'
        public: false
        authorization_policy: 'one_factor'
        redirect_uris:
          - 'https://vault.<your-domain>/identity/connect/authorize'
        scopes: ['openid', 'profile', 'email', 'groups']
        response_types: ['code']
        grant_types: ['authorization_code']
        token_endpoint_auth_method: 'client_secret_post'
```

Then configure Vaultwarden's SSO settings to point at your Authelia issuer URL.
