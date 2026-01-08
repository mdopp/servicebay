---
applyTo: "**"
---

# Changelog Maintenance Instructions

You are responsible for keeping the project's changelogs up-to-date.

## Files
- `CHANGELOG_DEV.md`: Tracks technical changes, architectural decisions, and development notes.
- `CHANGELOG.md`: User-facing release notes, features, and fixes.

## Rules
1.  **Update on Change**: Whenever you implement a feature, fix a bug, or change the architecture, you MUST update the relevant changelog file immediately.
2.  **Dev vs User**: 
    - Use `CHANGELOG_DEV.md` for internal details (e.g., refactoring, test suites, internal API changes).
    - Use `CHANGELOG.md` for user-visible changes (e.g., new UI features, fixed crashes, performance improvements).
3.  **Format**: Use the existing format in the files (usually Keep a Changelog format or chronological bullets).
4.  **Architecture**: If you make an architectural change (e.g. "Services now injected on Default node"), document the reasoning in `CHANGELOG_DEV.md`.

## Workflow
- After completing a task or a significant step in a task, read the current `CHANGELOG_DEV.md`.
- Append a new entry under the "Unreleased" or current date section.
- If the change affects the user experience, also add an entry to `CHANGELOG.md`.

