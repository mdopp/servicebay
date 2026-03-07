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
