---
applyTo: "**"
---

# Release & Git Workflow Instructions

## Automated Release Workflow
This project uses **Release Please** to automate version management and releases based on **Conventional Commits**.

## Rules

### 1. Commit Messages
You MUST use Conventional Commits for all changes.
-   `feat: ...` → Minor release (1.1.0)
-   `fix: ...` → Patch release (1.0.1)
-   `feat!: ...` or `BREAKING CHANGE:` → Major release (2.0.0)
-   `chore:`, `docs:`, `refactor:`, `test:` → No release trigger (unless configured) but keeps history clean.

### 2. No Manual Versioning
-   **Never** manually edit `package.json` version.
-   **Never** manually create git tags.
-   **Never** manually edit `CHANGELOG.md` (it is automated).

### 3. Architecture & Documentation
-   Significant architectural changes should be documented in `ARCHITECTURE.md` or `DESIGN_PRINCIPLES.md`.

## Release Process
1.  **Develop**: Create features or fixes on branches.
2.  **Merge**: When these commits are merged to `main`, the `release-please` workflow runs.
3.  **Release PR**: Release Please automatically maintains a **Release PR** (`chore: release x.y.z`) that accumulates these changes.
4.  **Publish**:
    -   Review the Release PR.
    -   **Merge the Release PR** to trigger the release.
    -   GitHub Action creates the Release and Tag.
    -   Docker workflow builds and attaches assets.
