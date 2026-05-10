# Nginx Proxy Manager

Full-featured reverse proxy with a web UI for managing proxy hosts, redirections, streams, and SSL certificates (Let's Encrypt).

## Variables

- `PORT`: HTTP port (default: 8080, use 80 if running as root)
- `SSL_PORT`: HTTPS port (default: 8443, use 443 if running as root)
- `ADMIN_PORT`: Admin UI port (default: 8081)
- `DATA_DIR`: Base data directory (from template settings)

## Default Login

After first start, access the admin UI at `http://<host>:8081` with:

- Email: `admin@example.com`
- Password: `changeme`

You will be prompted to change these on first login.

## Data

- NPM config/database: `${DATA_DIR}/nginx-proxy-manager/data/`
- SSL certificates: `${DATA_DIR}/nginx-proxy-manager/letsencrypt/`
