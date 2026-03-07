# Nginx Reverse Proxy

Nginx web server and reverse proxy with SSL support.

## Variables

- `PORT`: HTTP port (default: 8080, use 80 if running as root)
- `SSL_PORT`: HTTPS port (default: 8443, use 443 if running as root)
- `DATA_DIR`: Base data directory (from template settings)

## Configuration

- Server configs: `${DATA_DIR}/nginx/conf.d/` (add .conf files here)
- SSL certificates: `${DATA_DIR}/nginx/ssl/`
- Static files: `${DATA_DIR}/nginx/html/`

ServiceBay can export and import nginx configurations via Settings > Reverse Proxy.
