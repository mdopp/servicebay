# Release Process

This project uses a GitHub Actions workflow (`.github/workflows/release.yml`) to automate the release process.

**DO NOT manually create releases or tags.**

## How to Release

1.  **Update Version:**
    Bump the version in `package.json`.
    ```bash
    npm version patch  # or minor, major
    ```

2.  **Push Changes:**
    Push the commit and the tag to GitHub.
    ```bash
    git push && git push --tags
    ```

3.  **Wait for Action:**
    The GitHub Action will automatically:
    - Build the application.
    - Create a GitHub Release.
    - Upload the necessary artifacts (`servicebay-linux-x64.tar.gz`, `servicebay-update-linux-x64.tar.gz`, `servicebay-deps-linux-x64.tar.gz`).

## Artifacts Explained

-   `servicebay-linux-x64.tar.gz`: Full installation (Code + Node Modules).
-   `servicebay-update-linux-x64.tar.gz`: Application code only (smaller, for updates).
-   `servicebay-deps-linux-x64.tar.gz`: `node_modules` only (for dependency updates).

## Troubleshooting

If a release fails, check the "Actions" tab in the GitHub repository.
