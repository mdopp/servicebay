# Immich

Self-hosted photo and video backup solution directly from your mobile phone.

## Variables

- `PORT`: The port to expose the Immich web interface on (default: 2283).

## Notes

This template deploys a complete Immich stack in a single Pod, including:
- Immich Server
- Immich Microservices
- Immich Machine Learning
- Redis
- PostgreSQL (with pgvecto.rs)

**Important:**
- The default database password is set to `postgres`. For production use, you should change this in the template or environment variables.
- This setup uses local volumes. Ensure you have enough disk space for your photos and videos.
