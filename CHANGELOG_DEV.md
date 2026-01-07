# Developer Changelog

This file tracks architectural changes, refactors, and developer-facing improvements.

## [Unreleased]

### Added
- 

### Changed
- 

### Fixed
- 

## [2026.1.68] - 2026-01-07
### Architecture
- Fixed strict type checking in `src/lib/executor.ts` (unknown error type).
- Dockerfile updated to run as root to comply with Quadlet UserNS=keep-id.

## [2026.1.65] - 2026-01-07
### Configuration
- Refactored `src/lib/config.ts` to export `SSH_DIR` pointing to persistent volume.
- Removed hardcoded `~/.ssh` paths in favor of persistent `/app/data/ssh`.
