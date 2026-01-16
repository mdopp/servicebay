# Registry

## Goal
Manage container images and registries.

## Key Functions
- **Image List**: View downloaded images.
- **Pull**: Download new images from configured registries.
- **Prune**: Remove unused images to free up space.
- **Registry Config**: Add and manage multiple container registries.
- **Template Sync**: Point ServiceBay at Git repositories that ship stack templates, then reuse them across every managed node.
- **Credential Storage**: Store registry credentials in `config.json` so they automatically ride along with System Backups.

## Workflow Tips
- Keep production and lab registries separated with labels so you never deploy the wrong build.
- Prune images before triggering a backup to keep archives lean and to avoid redeploying stale layers.
