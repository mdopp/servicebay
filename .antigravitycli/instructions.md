# Antigravity Operational Instructions — Workspace Policy

## 🚨 Source of Truth for Tasks: GitHub Issues
*   **GitHub Issues Only**: GitHub Issues is the absolute single source of truth for all task planning, tracking, enhancements, and bugs.
*   **No Isolated Task Files**: Do not create or track plans in disconnected local markdown files (such as `architectural_enhancements.md`) without mirroring them directly to the remote repository.
*   **Direct GitHub CLI Integration**: Always use the **GitHub CLI (`gh`)** tool to interact with the repository's tracker. Proactively query, list, create, edit, close, and transition real GitHub issues.
*   **Commit Reference**: Every commit and task checkbox must reference its corresponding real GitHub Issue ID (e.g. `feat(auth): ... (#841)` or `Closes #841`).
*   **Thoroughness**: When suggesting enhancements, automatically create them as actual GitHub issues in the repository so they are immediately visible to the team and integrated into the workflow.
