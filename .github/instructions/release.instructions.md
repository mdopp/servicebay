---
applyTo: "{scripts/release.sh,package.json,.github/workflows/**/*.yml}"
---

# ServiceBay Release Instructions

## Critical Rules
1.  **Explicit Release Only**: NEVER create a release or run `scripts/release.sh` unless **explicitly requested** by the user.
2.  **Pre-Release Verification**:
    -   You MUST ensure `npm run build` passes locally before releasing.
    -   If the build fails, fix it first.

## Changelogs
-   Update `CHANGELOG.md` (User facing).
-   Update `CHANGELOG_DEV.md` (Developer facing).
