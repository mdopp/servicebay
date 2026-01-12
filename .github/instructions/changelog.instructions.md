---
applyTo: "**"
---

# Changelog Maintenance Instructions

The project uses **Conventional Commits** and **Release Please** to automate changelog generation and versioning. `CHANGELOG.md` is automatically generated and should NOT be edited manually.

## Rules
1.  **Commit Messages**: You MUST use Conventional Commits for all changes.
    -   `feat: ...` -> Triggers a MINOR release (new feature).
    -   `fix: ...` -> Triggers a PATCH release (bug fix).
    -   `feat!: ...` or `BREAKING CHANGE:` -> Triggers a MAJOR release.
    -   `chore:`, `docs:`, `refactor:`, `test:` -> No release trigger (unless configured otherwise), but keeps history clean.
    
2.  **No Manual Edits**: Do NOT manually edit `CHANGELOG.md`. `CHANGELOG_DEV.md` is obsolete and has been removed.

3.  **Architecture**: Significant architectural changes should be documented in `ARCHITECTURE.md` or `DESIGN_PRINCIPLES.md` if they affect the system design, rather than a changelog file.

## Workflow
- When committing changes, ensure the commit message follows the `<type>: <description>` format.
- If a change is user-facing, ensure the description is clear and suitable for release notes.

