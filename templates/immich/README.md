# Immich

Self-hosted photo and video backup solution directly from your mobile phone.

## Variables

- `PORT`: The port to expose the Immich web interface on (default: 2283)
- `DB_PASSWORD`: PostgreSQL database password (choose a secure password)
- `DATA_DIR`: Base data directory (from template settings)

## Notes

This template deploys a complete Immich stack in a single Pod:
- Immich Server (web UI + API)
- Immich Machine Learning
- Redis
- PostgreSQL (with pgvecto.rs for vector search)

Data is persisted at `${DATA_DIR}/immich/` with separate directories for uploads, model cache, and database.

## SSO (Authelia)

To enable OIDC login via Authelia, add this client to your Authelia `configuration.yml`:

```yaml
      - client_id: 'immich'
        client_name: 'Immich'
        client_secret: '$plaintext$<your-secret>'
        public: false
        authorization_policy: 'one_factor'
        redirect_uris:
          - 'https://photos.<your-domain>/auth/login'
          - 'https://photos.<your-domain>/user-settings'
          - 'app.immich:/'
        scopes: ['openid', 'profile', 'email']
        response_types: ['code']
        grant_types: ['authorization_code']
        token_endpoint_auth_method: 'client_secret_post'
```

Then configure Immich's OAuth settings (Administration > OAuth) to point at your Authelia issuer URL.
