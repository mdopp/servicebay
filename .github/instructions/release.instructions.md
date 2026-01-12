---
applyTo: "{scripts/release.sh,package.json,.github/workflows/**/*.yml}"
---

# ServiceBay Release Instructions

## Automated Release Workflow
This project uses **Release Please** to automate version management and releases based on **Conventional Commits**.

### Release Process
1.  **Develop**: Create features or fixes on branches.
2.  **Commit**: Use Conventional Commit messages:
    -   `feat: ...` → Minor release (1.1.0)
    -   `fix: ...` → Patch release (1.0.1)
    -   `feat!: ...` or `BREAKING CHANGE:` → Major release (2.0.0)
    -   `chore: ...`, `docs: ...` → No release trigger.
3.  **Merge**: When these commits are merged to `main`, the `release-please` workflow runs.
4.  **Release PR**: Release Please automatically maintains a **Release PR** (`chore: release x.y.z`) that accumulates these changes.
5.  **Publish**:
    -   Review the Release PR.
    -   **Merge the Release PR** to trigger the release.
    -   GitHub Action creates the Release and Tag.
    -   Docker workflow builds and attaches assets.

## Manual Actions
-   **Never** manually edit `package.json` version.
-   **Never** manually create git tags.
-   Just merge the "Release PR" created by the bot.

## Changelogs
-   `CHANGELOG.md` is automatically managed by Release Please.
-   Technical/Developer history is now tracked via **Git Commit History** (`git log`).
